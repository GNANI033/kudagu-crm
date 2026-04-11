"""
Kudagu Kaapi — Inventory Manager  (inventory/app.py)
FastAPI + uvicorn — runs on port 8001.

Data stored in inventory/data.sqlite3 (with one-time import from data.json).
Frontend served from inventory/static/.

The /api/stock endpoint is intentionally unauthenticated so the CRM
(port 8000) can poll it for low-stock alerts. If you expose this via
a reverse proxy, add basic-auth at the nginx layer for both services.

Run:
    cd inventory
    python app.py

Reverse proxy (nginx):
    location /inventory/ {
        proxy_pass http://127.0.0.1:8001/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
"""

import json
import copy
import sqlite3
import time
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

BASE_DIR   = Path(__file__).parent
DB_FILE = BASE_DIR / "data.sqlite3"
LEGACY_DATA_FILE = BASE_DIR / "data.json"
STATE_KEY = "root"
STATIC_DIR = BASE_DIR / "static"
DATA_LOCK = threading.RLock()
DATA_CACHE: dict | None = None
SCHEMA_VERSION = 1

# ── Default seed data ────────────────────────────────────────────────────────
DEFAULT_DATA: dict = {
    "products": [],   # { id, name, unit:"g", lowStockThreshold:500, stock:0, movements:[] }
    "pid": 1,
    # movements shape: { id, productId, type:"in"|"out"|"adjustment", grams, note, at }
    "mid": 1,
}

# ── Data helpers ─────────────────────────────────────────────────────────────
def _connect_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _json_serialize(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _load_state_from_db(conn: sqlite3.Connection) -> dict:
    rows = conn.execute("SELECT section, value FROM app_state_sections").fetchall()
    data: dict = {}
    for section, payload in rows:
        data[section] = json.loads(payload)
    return data


def _save_state_to_db(conn: sqlite3.Connection, old_data: dict, new_data: dict) -> None:
    now = int(time.time())
    old_keys = set(old_data.keys())
    new_keys = set(new_data.keys())

    for section in old_keys - new_keys:
        conn.execute("DELETE FROM app_state_sections WHERE section = ?", (section,))

    for section in new_keys:
        new_payload = _json_serialize(new_data[section])
        if section in old_data and _json_serialize(old_data[section]) == new_payload:
            continue
        conn.execute(
            """
            INSERT INTO app_state_sections (section, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(section) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            """,
            (section, new_payload, now),
        )


def _set_schema_version(conn: sqlite3.Connection, version: int) -> None:
    conn.execute(
        """
        INSERT INTO app_meta (key, value)
        VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (str(version),),
    )


def _get_schema_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM app_meta WHERE key = 'schema_version'").fetchone()
    if not row:
        return 0
    try:
        return int(row[0])
    except (TypeError, ValueError):
        return 0


def _init_storage() -> None:
    global DATA_CACHE
    with DATA_LOCK:
        with _connect_db() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS app_state_sections (
                    section TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS app_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_app_state_sections_updated_at ON app_state_sections(updated_at)"
            )

            section_count = conn.execute("SELECT COUNT(1) FROM app_state_sections").fetchone()[0]
            if section_count == 0:
                seed_data: dict | None = None
                legacy_row = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='app_state'"
                ).fetchone()
                if legacy_row:
                    row = conn.execute(
                        "SELECT value FROM app_state WHERE key = ?",
                        (STATE_KEY,),
                    ).fetchone()
                    if row:
                        seed_data = json.loads(row[0])
                if seed_data is None and LEGACY_DATA_FILE.exists():
                    with open(LEGACY_DATA_FILE, "r", encoding="utf-8") as f:
                        seed_data = json.load(f)
                if seed_data is None:
                    seed_data = copy.deepcopy(DEFAULT_DATA)
                seed_data = migrate(seed_data)
                _save_state_to_db(conn, {}, seed_data)
                _set_schema_version(conn, SCHEMA_VERSION)
                DATA_CACHE = copy.deepcopy(seed_data)
                return

            db_state = _load_state_from_db(conn)
            schema_version = _get_schema_version(conn)
            if schema_version < SCHEMA_VERSION:
                migrated = migrate(copy.deepcopy(db_state))
                _save_state_to_db(conn, db_state, migrated)
                _set_schema_version(conn, SCHEMA_VERSION)
                DATA_CACHE = copy.deepcopy(migrated)
            elif DATA_CACHE is None:
                DATA_CACHE = copy.deepcopy(db_state)


def read_data() -> dict:
    global DATA_CACHE
    _init_storage()
    with DATA_LOCK:
        if DATA_CACHE is None:
            with _connect_db() as conn:
                DATA_CACHE = _load_state_from_db(conn)
        return copy.deepcopy(DATA_CACHE)

def write_data(data: dict) -> None:
    global DATA_CACHE
    _init_storage()
    migrated = migrate(copy.deepcopy(data))
    with DATA_LOCK:
        current = copy.deepcopy(DATA_CACHE) if DATA_CACHE is not None else {}
        with _connect_db() as conn:
            _save_state_to_db(conn, current, migrated)
            _set_schema_version(conn, SCHEMA_VERSION)
        DATA_CACHE = migrated

def migrate(data: dict) -> dict:
    if "products" not in data: data["products"] = []
    if "pid" not in data: data["pid"] = len(data["products"]) + 1
    if "mid" not in data: data["mid"] = 1
    for p in data["products"]:
        if "stock"             not in p: p["stock"]             = 0
        if "lowStockThreshold" not in p: p["lowStockThreshold"] = 500
        if "unit"              not in p: p["unit"]              = "g"
        if "movements"         not in p: p["movements"]         = []
        # Ensure stock is always derived from movements (source of truth)
        total = sum(
            m["grams"] if m["type"] in ("in", "adjustment") else -m["grams"]
            for m in p["movements"]
        )
        p["stock"] = max(0, total)
    return data

def compute_analytics(p: dict) -> dict:
    """Compute dashboard metrics for a single product."""
    movements = p.get("movements", [])
    out_movs = [m for m in movements if m["type"] == "out"]
    in_movs  = [m for m in movements if m["type"] == "in"]
    total_out   = sum(m["grams"] for m in out_movs)
    total_in    = sum(m["grams"] for m in in_movs)
    avg_out     = (total_out / len(out_movs)) if out_movs else 0
    return {
        "totalIn":   total_in,
        "totalOut":  total_out,
        "avgOutSize": round(avg_out, 1),
        "outCount":  len(out_movs),
        "inCount":   len(in_movs),
    }


def recompute_stock(p: dict) -> float:
    total = sum(
        m["grams"] if m["type"] in ("in", "adjustment") else -m["grams"]
        for m in p.get("movements", [])
    )
    p["stock"] = max(0, total)
    return p["stock"]

# ── App ───────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(_: FastAPI):
    _init_storage()
    yield


app = FastAPI(title="Kudagu Inventory", docs_url=None, redoc_url=None, lifespan=lifespan)

# Allow CRM (port 8000) to call /api/stock from browser
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

if not STATIC_DIR.exists():
    STATIC_DIR.mkdir(parents=True)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/", include_in_schema=False)
async def index():
    idx = STATIC_DIR / "index.html"
    if not idx.exists():
        raise HTTPException(404, "index.html not found in inventory/static/")
    return FileResponse(str(idx))

# ── Public stock summary (consumed by CRM) ────────────────────────────────────
@app.get("/api/stock")
async def get_stock():
    """
    Returns all products with current stock and low-stock flag.
    Called by the CRM frontend to show low-stock alerts.
    """
    data = read_data()
    return JSONResponse([
        {
            "id":                p["id"],
            "name":              p["name"],
            "stockGrams":        p["stock"],
            "lowStockThreshold": p["lowStockThreshold"],
            "isLow":             p["stock"] <= p["lowStockThreshold"],
            "unit":              p.get("unit", "g"),
        }
        for p in data["products"]
    ])

# ── Full data ─────────────────────────────────────────────────────────────────
@app.get("/api/data")
async def get_data():
    data = read_data()
    # Attach analytics to each product
    for p in data["products"]:
        p["analytics"] = compute_analytics(p)
    return JSONResponse(data)

@app.put("/api/data")
async def put_data(request: Request):
    body = await request.json()
    write_data(body)
    return {"ok": True}

# ── Products ──────────────────────────────────────────────────────────────────
@app.post("/api/products")
async def add_product(request: Request):
    body = await request.json()
    if not body.get("name"):
        raise HTTPException(400, "Product name required")
    data = read_data()
    product = {
        "id":                "ip" + str(data["pid"]),
        "name":              body["name"],
        "unit":              body.get("unit", "g"),
        "lowStockThreshold": int(body.get("lowStockThreshold", 500)),
        "stock":             0,
        "movements":         [],
    }
    data["products"].append(product)
    data["pid"] += 1
    write_data(data)
    return product

@app.put("/api/products/{product_id}")
async def update_product(product_id: str, request: Request):
    body = await request.json()
    data = read_data()
    idx = next((i for i, p in enumerate(data["products"]) if p["id"] == product_id), None)
    if idx is None:
        raise HTTPException(404, "Product not found")
    for key in ("name", "lowStockThreshold", "unit"):
        if key in body:
            data["products"][idx][key] = body[key]
    write_data(data)
    return data["products"][idx]

@app.delete("/api/products/{product_id}")
async def delete_product(product_id: str):
    data = read_data()
    before = len(data["products"])
    data["products"] = [p for p in data["products"] if p["id"] != product_id]
    if len(data["products"]) == before:
        raise HTTPException(404, "Product not found")
    write_data(data)
    return {"ok": True}

# ── Stock movements ────────────────────────────────────────────────────────────
@app.post("/api/products/{product_id}/movements")
async def add_movement(product_id: str, request: Request):
    """
    Add a stock movement.
    body: { type: "in"|"out"|"adjustment", grams: number, note: string, at: timestamp }
    """
    body = await request.json()
    if body.get("type") not in ("in", "out", "adjustment"):
        raise HTTPException(400, "type must be 'in', 'out', or 'adjustment'")
    grams = float(body.get("grams", 0))
    if grams <= 0:
        raise HTTPException(400, "grams must be > 0")
    data = read_data()
    idx = next((i for i, p in enumerate(data["products"]) if p["id"] == product_id), None)
    if idx is None:
        raise HTTPException(404, "Product not found")
    movement = {
        "id":        data["mid"],
        "productId": product_id,
        "type":      body["type"],
        "grams":     grams,
        "note":      body.get("note", ""),
        "at":        body.get("at", None),
    }
    data["products"][idx]["movements"].append(movement)
    data["mid"] += 1
    # Recompute stock
    total = sum(
        m["grams"] if m["type"] in ("in", "adjustment") else -m["grams"]
        for m in data["products"][idx]["movements"]
    )
    data["products"][idx]["stock"] = max(0, total)
    write_data(data)
    return {**movement, "newStock": data["products"][idx]["stock"]}

@app.delete("/api/products/{product_id}/movements/{movement_id}")
async def delete_movement(product_id: str, movement_id: int):
    data = read_data()
    idx = next((i for i, p in enumerate(data["products"]) if p["id"] == product_id), None)
    if idx is None:
        raise HTTPException(404, "Product not found")
    before = len(data["products"][idx]["movements"])
    data["products"][idx]["movements"] = [
        m for m in data["products"][idx]["movements"] if m["id"] != movement_id
    ]
    if len(data["products"][idx]["movements"]) == before:
        raise HTTPException(404, "Movement not found")
    # Recompute stock
    recompute_stock(data["products"][idx])
    write_data(data)
    return {"ok": True, "newStock": data["products"][idx]["stock"]}

@app.put("/api/products/{product_id}/movements/{movement_id}")
async def update_movement(product_id: str, movement_id: int, request: Request):
    """
    Update a stock movement.
    body may include: { grams: number, note: string, at: timestamp }
    """
    body = await request.json()
    data = read_data()
    pidx = next((i for i, p in enumerate(data["products"]) if p["id"] == product_id), None)
    if pidx is None:
        raise HTTPException(404, "Product not found")

    midx = next(
        (i for i, m in enumerate(data["products"][pidx]["movements"]) if m["id"] == movement_id),
        None,
    )
    if midx is None:
        raise HTTPException(404, "Movement not found")

    mov = data["products"][pidx]["movements"][midx]

    if "grams" in body:
        grams = float(body.get("grams", 0))
        if grams <= 0:
            raise HTTPException(400, "grams must be > 0")
        mov["grams"] = grams
    if "note" in body:
        mov["note"] = str(body.get("note", ""))
    if "at" in body:
        mov["at"] = body.get("at")

    recompute_stock(data["products"][pidx])
    write_data(data)
    return {**mov, "newStock": data["products"][pidx]["stock"]}


@app.post("/api/crm/replace-movements")
async def crm_replace_movements(request: Request):
    """
    Atomically replace all CRM-generated inventory movements.
    body: {
      notePrefix: "CRM Order #",  # optional
      movements: [{productId, type:"out", grams, note, at}]
    }
    """
    body = await request.json()
    note_prefix = str(body.get("notePrefix", "CRM Order #"))
    movements = body.get("movements", [])
    if not isinstance(movements, list):
        raise HTTPException(400, "movements must be an array")

    data = read_data()
    by_id = {p["id"]: p for p in data["products"]}

    # 1) Remove old CRM-linked movements in one pass.
    removed = 0
    for p in data["products"]:
        keep = []
        for m in p.get("movements", []):
            if str(m.get("note", "")).startswith(note_prefix):
                removed += 1
            else:
                keep.append(m)
        p["movements"] = keep

    # 2) Append new CRM movements.
    added = 0
    for row in movements:
        if not isinstance(row, dict):
            continue
        pid = str(row.get("productId", ""))
        if pid not in by_id:
            continue
        mtype = row.get("type", "out")
        if mtype not in ("in", "out", "adjustment"):
            continue
        grams = float(row.get("grams", 0) or 0)
        if grams <= 0:
            continue
        movement = {
            "id":        data["mid"],
            "productId": pid,
            "type":      mtype,
            "grams":     grams,
            "note":      str(row.get("note", "")),
            "at":        row.get("at", None),
        }
        by_id[pid]["movements"].append(movement)
        data["mid"] += 1
        added += 1

    # 3) Recompute stock once per product.
    for p in data["products"]:
        recompute_stock(p)

    write_data(data)
    return {"ok": True, "removed": removed, "added": added}

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    _init_storage()
    print(f"[Inventory] Using SQLite storage at {DB_FILE}")
    if LEGACY_DATA_FILE.exists():
        print(f"[Inventory] Legacy JSON available for fallback/backup at {LEGACY_DATA_FILE}")
    print("[Inventory] Starting at http://0.0.0.0:8001")
    uvicorn.run("app:app", host="0.0.0.0", port=8001, reload=False)

