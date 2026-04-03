"""
Kudagu Kaapi — Inventory Manager  (inventory/app.py)
FastAPI + uvicorn — runs on port 8001.

Data stored in inventory/data.json.
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
from pathlib import Path
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

BASE_DIR   = Path(__file__).parent
DATA_FILE  = BASE_DIR / "data.json"
STATIC_DIR = BASE_DIR / "static"

# ── Default seed data ────────────────────────────────────────────────────────
DEFAULT_DATA: dict = {
    "products": [],   # { id, name, unit:"g", lowStockThreshold:500, stock:0, movements:[] }
    "pid": 1,
    # movements shape: { id, productId, type:"in"|"out"|"adjustment", grams, note, at }
    "mid": 1,
}

# ── Data helpers ─────────────────────────────────────────────────────────────
def read_data() -> dict:
    if not DATA_FILE.exists():
        write_data(copy.deepcopy(DEFAULT_DATA))
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def write_data(data: dict) -> None:
    tmp = DATA_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(DATA_FILE)

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
app = FastAPI(title="Kudagu Inventory", docs_url=None, redoc_url=None)

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
    data = migrate(read_data())
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
    data = migrate(read_data())
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
    data = migrate(read_data())
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
    data = migrate(read_data())
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
    data = migrate(read_data())
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
    data = migrate(read_data())
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
    data = migrate(read_data())
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

    data = migrate(read_data())
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
    if not DATA_FILE.exists():
        write_data(copy.deepcopy(DEFAULT_DATA))
        print(f"[Inventory] Created fresh data.json at {DATA_FILE}")
    else:
        print(f"[Inventory] Using existing data.json at {DATA_FILE}")
    print("[Inventory] Starting at http://0.0.0.0:8001")
    uvicorn.run("app:app", host="0.0.0.0", port=8001, reload=False)
