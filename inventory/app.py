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
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib import request as urlrequest
from urllib import error as urlerror
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
UI_PREFS_FILE = BASE_DIR.parent / "ui_prefs.json"
CRM_URL = os.environ.get("CRM_URL", "http://localhost:8000")
DATA_LOCK = threading.RLock()
UI_PREFS_LOCK = threading.RLock()
DATA_CACHE: dict | None = None
SCHEMA_VERSION = 2
DEFAULT_UI_PREFERENCES: dict[str, str] = {"theme": "light"}
ALLOWED_THEMES = {"light", "dark", "nord", "solarized", "dracula"}

# ── Default seed data ────────────────────────────────────────────────────────
DEFAULT_DATA: dict = {
    "products": [],   # { id, name, unit:"g", lowStockThreshold:500, stock:0, movements:[] }
    "finishedProducts": [],  # { crmProductId, name, sizes, composition, description, usageInstructions, ... }
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

def read_ui_preferences() -> dict:
    with UI_PREFS_LOCK:
        if UI_PREFS_FILE.exists():
            try:
                prefs = json.loads(UI_PREFS_FILE.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                prefs = {}
        else:
            prefs = {}
        theme = str(prefs.get("theme") or DEFAULT_UI_PREFERENCES["theme"]).strip().lower()
        if theme not in ALLOWED_THEMES:
            theme = DEFAULT_UI_PREFERENCES["theme"]
        return {"theme": theme}

def write_ui_preferences(incoming: dict) -> dict:
    current = read_ui_preferences()
    theme = str((incoming or {}).get("theme") or current["theme"]).strip().lower()
    if theme not in ALLOWED_THEMES:
        theme = current["theme"]
    updated = {"theme": theme}
    with UI_PREFS_LOCK:
        UI_PREFS_FILE.write_text(json.dumps(updated, ensure_ascii=False, indent=2), encoding="utf-8")
    return updated

def migrate(data: dict) -> dict:
    if "products" not in data: data["products"] = []
    if "finishedProducts" not in data: data["finishedProducts"] = []
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
    normalized_finished: list[dict] = []
    for row in data["finishedProducts"]:
        if not isinstance(row, dict):
            continue
        normalized_finished.append(_normalize_finished_product(row))
    data["finishedProducts"] = normalized_finished
    return data


def _normalize_finished_product(row: dict) -> dict:
    sizes = [str(size or "").strip() for size in (row.get("sizes") or []) if str(size or "").strip()]
    advertised_raw = row.get("advertisedVariants")
    if isinstance(advertised_raw, list):
        advertised_variants = []
        for size in advertised_raw:
            normalized = str(size or "").strip()
            if normalized and normalized in sizes and normalized not in advertised_variants:
                advertised_variants.append(normalized)
    else:
        advertised_variants = list(sizes)
    composition = []
    pricing_raw = row.get("pricing") if isinstance(row.get("pricing"), dict) else {}
    normalized_pricing: dict[str, dict] = {}
    for size in sizes:
        pricing_row = pricing_raw.get(size) if isinstance(pricing_raw.get(size), dict) else {}
        sale_prices = pricing_row.get("salePrices") if isinstance(pricing_row.get("salePrices"), dict) else {}
        normalized_pricing[size] = {
            "salePrices": {
                "retail": float(sale_prices.get("retail") or 0),
                "website": float(sale_prices.get("website") or 0),
                "whatsapp": float(sale_prices.get("whatsapp") or 0),
            }
        }
    for item in row.get("composition", []) or []:
        if not isinstance(item, dict):
            continue
        inv_id = str(item.get("inventoryProductId") or "").strip()
        inv_name = str(item.get("inventoryProductName") or "").strip()
        try:
            pct = float(item.get("percentage") or 0)
        except (TypeError, ValueError):
            pct = 0.0
        if not inv_id or pct <= 0:
            continue
        composition.append(
            {
                "inventoryProductId": inv_id,
                "inventoryProductName": inv_name,
                "percentage": pct,
            }
        )
    return {
        "crmProductId": str(row.get("crmProductId") or row.get("id") or "").strip(),
        "name": str(row.get("name") or "").strip(),
        "sizes": sizes,
        "advertisedVariants": advertised_variants,
        "pricing": normalized_pricing,
        "composition": composition,
        "description": str(row.get("description") or "").strip(),
        "usageInstructions": str(row.get("usageInstructions") or "").strip(),
        "preparationNotes": str(row.get("preparationNotes") or "").strip(),
        "imageDataUrl": str(row.get("imageDataUrl") or "").strip(),
        "imageAltText": str(row.get("imageAltText") or "").strip(),
        "isPublished": bool(row.get("isPublished", True)),
        "crmUpdatedAt": row.get("crmUpdatedAt"),
        "syncedAt": row.get("syncedAt"),
    }


def _variant_to_grams(variant: str) -> float:
    raw = str(variant or "").strip().lower()
    if not raw:
        return 0.0
    if raw.endswith("kg"):
        try:
            return float(raw[:-2].strip()) * 1000.0
        except ValueError:
            return 0.0
    if raw.endswith("g"):
        try:
            return float(raw[:-1].strip())
        except ValueError:
            return 0.0
    if raw.endswith("l"):
        try:
            return float(raw[:-1].strip()) * 1000.0
        except ValueError:
            return 0.0
    if raw.endswith("ml"):
        try:
            return float(raw[:-2].strip())
        except ValueError:
            return 0.0
    return 0.0


def _fetch_crm_products() -> list[dict]:
    req = urlrequest.Request(f"{CRM_URL.rstrip('/')}/api/inventory/products", method="GET")
    try:
        with urlrequest.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            parsed = json.loads(raw) if raw else {}
            products = parsed.get("products", []) if isinstance(parsed, dict) else []
            return products if isinstance(products, list) else []
    except (urlerror.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return []


def _sync_finished_products_from_crm(data: dict) -> tuple[dict, bool]:
    crm_products = _fetch_crm_products()
    if not crm_products:
        return data, False

    existing_by_id = {
        str(row.get("crmProductId") or ""): _normalize_finished_product(row)
        for row in data.get("finishedProducts", []) or []
        if isinstance(row, dict) and str(row.get("crmProductId") or "").strip()
    }
    synced_rows: list[dict] = []
    changed = False
    now_ms = int(time.time() * 1000)

    for raw in crm_products:
        if not isinstance(raw, dict):
            continue
        crm_id = str(raw.get("id") or "").strip()
        if not crm_id:
            continue
        previous = existing_by_id.get(crm_id, {})
        merged = _normalize_finished_product(
            {
                "crmProductId": crm_id,
                "name": raw.get("name", ""),
                "sizes": raw.get("sizes", []),
                "pricing": raw.get("pricing", {}),
                "composition": raw.get("composition", []),
                "advertisedVariants": previous.get("advertisedVariants", raw.get("sizes", [])),
                "description": previous.get("description", ""),
                "usageInstructions": previous.get("usageInstructions", ""),
                "preparationNotes": previous.get("preparationNotes", ""),
                "imageDataUrl": previous.get("imageDataUrl", ""),
                "imageAltText": previous.get("imageAltText", ""),
                "isPublished": previous.get("isPublished", True),
                "crmUpdatedAt": now_ms,
                "syncedAt": now_ms,
            }
        )
        if previous != merged:
            changed = True
        synced_rows.append(merged)

    old_ids = {str(row.get("crmProductId") or "") for row in data.get("finishedProducts", []) or [] if isinstance(row, dict)}
    new_ids = {row["crmProductId"] for row in synced_rows}
    if old_ids != new_ids:
        changed = True
    data["finishedProducts"] = synced_rows
    return data, changed


def _finished_product_availability(data: dict, row: dict) -> dict:
    by_inventory_id = {
        str(product.get("id") or ""): product
        for product in data.get("products", []) or []
        if isinstance(product, dict)
    }
    sizes = [str(size or "").strip() for size in (row.get("sizes") or []) if str(size or "").strip()]
    composition = row.get("composition", []) or []
    variant_rows: list[dict] = []
    total_units = 0

    for size in sizes:
        variant_grams = _variant_to_grams(size)
        limiting_units: float | None = None
        ingredient_rows: list[dict] = []
        for item in composition:
            inv_id = str(item.get("inventoryProductId") or "").strip()
            source = by_inventory_id.get(inv_id) or {}
            stock_grams = float(source.get("stock") or 0)
            usable_stock_grams = stock_grams * 0.5
            required_grams = variant_grams * (float(item.get("percentage") or 0) / 100.0)
            possible_units = int(usable_stock_grams // required_grams) if required_grams > 0 else 0
            if limiting_units is None:
                limiting_units = possible_units
            else:
                limiting_units = min(limiting_units, possible_units)
            ingredient_rows.append(
                {
                    "inventoryProductId": inv_id,
                    "inventoryProductName": str(item.get("inventoryProductName") or source.get("name") or "").strip(),
                    "stockGrams": round(stock_grams, 2),
                    "usableStockGrams": round(usable_stock_grams, 2),
                    "requiredPerUnitGrams": round(required_grams, 2),
                    "percentage": float(item.get("percentage") or 0),
                    "possibleUnits": max(0, possible_units),
                }
            )
        units = max(0, int(limiting_units or 0)) if composition and variant_grams > 0 else 0
        total_units += units
        variant_rows.append(
            {
                "variant": size,
                "variantGrams": round(variant_grams, 2),
                "availableUnits": units,
                "pricing": (row.get("pricing") or {}).get(size, {"salePrices": {"retail": 0.0, "website": 0.0, "whatsapp": 0.0}}),
                "ingredients": ingredient_rows,
            }
        )

    return {
        **row,
        "availableUnitsTotal": total_units,
        "availabilityBasis": "50_percent_of_raw_inventory",
        "variants": variant_rows,
        "websiteVariants": [variant for variant in variant_rows if variant.get("variant") in set(row.get("advertisedVariants", []))],
    }


def _hydrated_finished_products(data: dict) -> list[dict]:
    return [
        _finished_product_availability(data, row)
        for row in data.get("finishedProducts", []) or []
        if isinstance(row, dict) and str(row.get("crmProductId") or "").strip()
    ]

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


@app.api_route("/healthz", methods=["GET", "HEAD"], include_in_schema=False)
async def healthcheck():
    return JSONResponse(
        {"ok": True, "service": "inventory"},
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
            "X-Robots-Tag": "noindex, nofollow",
        },
    )


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
    data, changed = _sync_finished_products_from_crm(data)
    if changed:
        write_data(data)
    # Attach analytics to each product
    for p in data["products"]:
        p["analytics"] = compute_analytics(p)
    data["finishedProducts"] = _hydrated_finished_products(data)
    data["uiPreferences"] = read_ui_preferences()
    return JSONResponse(data)

@app.get("/api/settings")
async def get_settings():
    return {"uiPreferences": read_ui_preferences()}

@app.put("/api/settings")
async def put_settings(request: Request):
    body = await request.json()
    prefs = read_ui_preferences()
    if "uiPreferences" in body and isinstance(body["uiPreferences"], dict):
        prefs = write_ui_preferences(body["uiPreferences"])
    return {"ok": True, "uiPreferences": prefs}

@app.put("/api/data")
async def put_data(request: Request):
    body = await request.json()
    write_data(body)
    return {"ok": True}


@app.post("/api/finished-products/sync")
async def sync_finished_products():
    data = read_data()
    data, changed = _sync_finished_products_from_crm(data)
    if not changed and data.get("finishedProducts"):
        return {"ok": True, "changed": False, "count": len(data.get("finishedProducts", []))}
    if changed:
        write_data(data)
    return {"ok": True, "changed": changed, "count": len(data.get("finishedProducts", []))}


@app.get("/api/finished-products")
async def get_finished_products():
    data = read_data()
    data, changed = _sync_finished_products_from_crm(data)
    if changed:
        write_data(data)
    return JSONResponse(_hydrated_finished_products(data))


@app.put("/api/finished-products/{crm_product_id}")
async def update_finished_product(crm_product_id: str, request: Request):
    body = await request.json()
    data = read_data()
    data, changed = _sync_finished_products_from_crm(data)
    idx = next((i for i, row in enumerate(data.get("finishedProducts", [])) if row.get("crmProductId") == crm_product_id), None)
    if idx is None:
        raise HTTPException(404, "Finished product not found")
    row = _normalize_finished_product(
        {
            **data["finishedProducts"][idx],
            "advertisedVariants": body.get("advertisedVariants", data["finishedProducts"][idx].get("advertisedVariants", [])),
            "description": body.get("description", data["finishedProducts"][idx].get("description", "")),
            "usageInstructions": body.get("usageInstructions", data["finishedProducts"][idx].get("usageInstructions", "")),
            "preparationNotes": body.get("preparationNotes", data["finishedProducts"][idx].get("preparationNotes", "")),
            "imageDataUrl": body.get("imageDataUrl", data["finishedProducts"][idx].get("imageDataUrl", "")),
            "imageAltText": body.get("imageAltText", data["finishedProducts"][idx].get("imageAltText", "")),
            "isPublished": body.get("isPublished", data["finishedProducts"][idx].get("isPublished", True)),
            "syncedAt": int(time.time() * 1000),
        }
    )
    data["finishedProducts"][idx] = row
    write_data(data)
    if changed:
        data = read_data()
    return JSONResponse(_finished_product_availability(data, row))


@app.get("/api/website/finished-products")
async def website_finished_products():
    """
    Public website-ready feed for ecommerce integrations.
    Only published finished products are exposed, with computed availability.
    """
    data = read_data()
    data, changed = _sync_finished_products_from_crm(data)
    if changed:
        write_data(data)
    rows = [
        row
        for row in _hydrated_finished_products(data)
        if row.get("isPublished") and row.get("websiteVariants")
    ]
    website_rows = []
    for row in rows:
        website_rows.append(
            {
                "crmProductId": row.get("crmProductId"),
                "name": row.get("name"),
                "description": row.get("description"),
                "usageInstructions": row.get("usageInstructions"),
                "preparationNotes": row.get("preparationNotes"),
                "imageDataUrl": row.get("imageDataUrl"),
                "imageAltText": row.get("imageAltText"),
                "availabilityBasis": row.get("availabilityBasis"),
                "advertisedVariants": row.get("advertisedVariants", []),
                "variants": row.get("websiteVariants", []),
            }
        )
    return JSONResponse(website_rows)


@app.get("/api/website/finished-products/{crm_product_id}")
async def website_finished_product_detail(crm_product_id: str):
    data = read_data()
    data, changed = _sync_finished_products_from_crm(data)
    if changed:
        write_data(data)
    row = next(
        (
            item for item in _hydrated_finished_products(data)
            if item.get("crmProductId") == crm_product_id and item.get("isPublished") and item.get("websiteVariants")
        ),
        None,
    )
    if row is None:
        raise HTTPException(404, "Finished product not found")
    return JSONResponse(
        {
            "crmProductId": row.get("crmProductId"),
            "name": row.get("name"),
            "description": row.get("description"),
            "usageInstructions": row.get("usageInstructions"),
            "preparationNotes": row.get("preparationNotes"),
            "imageDataUrl": row.get("imageDataUrl"),
            "imageAltText": row.get("imageAltText"),
            "availabilityBasis": row.get("availabilityBasis"),
            "advertisedVariants": row.get("advertisedVariants", []),
            "variants": row.get("websiteVariants", []),
        }
    )

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

