"""
Kudagu Kaapi CRM — app.py
FastAPI + uvicorn backend.

All data is stored in data.json (same directory as this file).
The frontend (index.html, app.js) is served as static files from ./static/.

Run:
    python app.py
    # or directly:
    uvicorn app:app --host 0.0.0.0 --port 8000

Reverse proxy (nginx example):
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
"""

import json
import os
import copy
import time
import threading
import textwrap
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

# ── Paths ──────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent
DATA_FILE  = BASE_DIR / "data.json"
STATIC_DIR = BASE_DIR / "static"
INVENTORY_URL = os.environ.get("INVENTORY_URL", "http://localhost:8001")
SIZE_TO_GRAMS = {"100g": 100.0, "250g": 250.0, "500g": 500.0, "1kg": 1000.0}
SYNC_LOCK = threading.Lock()

# ── Default initial data (used only when data.json doesn't exist yet) ──────
DEFAULT_DATA: dict = {
    "customers": [],
    "orders": [],
    "distributorBatches": [],
    "closedFollowUps": [],
    "cid": 1,
    "oid": 1,
    "dbid": 1,
    "pid": 6,
    "waDefaultTpl": (
        "Hi {{customer_name}}, your last order was on {{last_order_date}}. "
        "Would you like to order {{product_name}} ({{variant}}) again? "
        "We'd love to offer you a great deal!"
    ),
    "shippingProfile": {
        "companyName": "",
        "address": "",
        "phone": "",
        "email": "",
        "gstin": "",
        "shippedWaTemplate": (
            "Hi {{customer_name}}, your order #{{order_id}} for {{product_name}} "
            "has been shipped on {{ship_date}}.\n"
            "AWB: {{awb}}\n"
            "Courier: {{courier}}{{tracking_line}}"
        ),
        "paymentGatewayCommissionPct": 3.0,
        "couriers": [],
        "trackingTemplates": {},
    },
    "products": [
        {"id": "p1", "name": "Coorg Filter Coffee Powder", "sizes": ["100g","250g","500g","1kg"], "waTpl": "", "pricing": {}},
        {"id": "p2", "name": "Coorg Pure Arabica",          "sizes": ["100g","250g","500g","1kg"], "waTpl": "", "pricing": {}},
        {"id": "p3", "name": "Coorg Dark Roast Blend",      "sizes": ["100g","250g","500g","1kg"], "waTpl": "", "pricing": {}},
        {"id": "p4", "name": "Chicory Blend",               "sizes": ["100g","250g","500g","1kg"], "waTpl": "", "pricing": {}},
        {"id": "p5", "name": "Instant Coffee Mix",          "sizes": ["100g","250g","500g","1kg"], "waTpl": "", "pricing": {}},
    ],
}

# ── Data helpers ────────────────────────────────────────────────────────────
def read_data() -> dict:
    """Read data.json; create it from defaults if it doesn't exist."""
    if not DATA_FILE.exists():
        write_data(copy.deepcopy(DEFAULT_DATA))
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def write_data(data: dict) -> None:
    """Atomically write data.json (write to .tmp then rename)."""
    tmp = DATA_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(DATA_FILE)


def migrate(data: dict) -> dict:
    """Apply any schema migrations in-place and return the data."""
    # Ensure top-level lists exist
    for key in ("customers", "orders", "products", "distributorBatches", "closedFollowUps"):
        if key not in data:
            data[key] = []
    for key in ("cid", "oid", "dbid"):
        if key not in data:
            data[key] = 1
    if "pid" not in data:
        data["pid"] = len(data["products"]) + 1
    if "waDefaultTpl" not in data:
        data["waDefaultTpl"] = DEFAULT_DATA["waDefaultTpl"]
    if "shippingProfile" not in data or not isinstance(data.get("shippingProfile"), dict):
        data["shippingProfile"] = copy.deepcopy(DEFAULT_DATA["shippingProfile"])
    if "trackingTemplates" not in data["shippingProfile"] or not isinstance(data["shippingProfile"].get("trackingTemplates"), dict):
        data["shippingProfile"]["trackingTemplates"] = {}
    if "shippedWaTemplate" not in data["shippingProfile"] or not isinstance(data["shippingProfile"].get("shippedWaTemplate"), str):
        data["shippingProfile"]["shippedWaTemplate"] = DEFAULT_DATA["shippingProfile"]["shippedWaTemplate"]
    try:
        data["shippingProfile"]["paymentGatewayCommissionPct"] = float(
            data["shippingProfile"].get(
                "paymentGatewayCommissionPct",
                DEFAULT_DATA["shippingProfile"]["paymentGatewayCommissionPct"],
            )
            or 0
        )
    except (TypeError, ValueError):
        data["shippingProfile"]["paymentGatewayCommissionPct"] = DEFAULT_DATA["shippingProfile"]["paymentGatewayCommissionPct"]
    if data["shippingProfile"]["paymentGatewayCommissionPct"] < 0:
        data["shippingProfile"]["paymentGatewayCommissionPct"] = 0.0
    if "couriers" not in data["shippingProfile"] or not isinstance(data["shippingProfile"].get("couriers"), list):
        data["shippingProfile"]["couriers"] = _couriers_from_templates(data["shippingProfile"]["trackingTemplates"])
    data["shippingProfile"]["couriers"] = _normalize_couriers(data["shippingProfile"]["couriers"])
    if not data["shippingProfile"]["trackingTemplates"] and data["shippingProfile"]["couriers"]:
        data["shippingProfile"]["trackingTemplates"] = {
            c["name"]: c.get("trackingTemplate", "") for c in data["shippingProfile"]["couriers"]
        }

    # Migrate old salePrice → salePrices
    for p in data["products"]:
        if "waTpl" not in p:
            p["waTpl"] = ""
        if "pricing" not in p:
            p["pricing"] = {}
        p["composition"] = _normalize_composition(p.get("composition", []))
        for sz, pr in p["pricing"].items():
            if isinstance(pr, dict):
                if "salePrice" in pr and "salePrices" not in pr:
                    old = pr.pop("salePrice")
                    pr["salePrices"] = {"retail": old, "website": old, "whatsapp": old}
                if "salePrices" not in pr:
                    pr["salePrices"] = {"retail": 0, "website": 0, "whatsapp": 0}
                if "expenses" not in pr:
                    pr["expenses"] = []

    # Ensure all orders have required fields
    for o in data["orders"]:
        if "channel" not in o:
            o["channel"] = "retail"
        if "status" not in o:
            o["status"] = "pending" if o.get("channel") in ("website", "whatsapp") else "confirmed"
        if "discount" not in o:
            o["discount"] = 0
        if "commission" not in o:
            o["commission"] = 0
        if "paymentMethod" not in o:
            o["paymentMethod"] = ""
        if "inventorySynced" not in o:
            o["inventorySynced"] = False
        if "inventorySyncedAt" not in o:
            o["inventorySyncedAt"] = None
        if "shipping" not in o or not isinstance(o.get("shipping"), dict):
            o["shipping"] = {}
        if "realizedRevenue" not in o:
            o["realizedRevenue"] = None
        if "distribution" not in o or not isinstance(o.get("distribution"), dict):
            o["distribution"] = {}
        # Migrate old delivered/payment_received → completed
        if o["status"] in ("delivered", "payment_received"):
            o["status"] = "completed"

    for b in data["distributorBatches"]:
        if "status" not in b:
            b["status"] = "active"
        if "commissionMode" not in b:
            b["commissionMode"] = "per_pcs"
        if b["commissionMode"] not in ("per_pcs", "batch"):
            b["commissionMode"] = "per_pcs"
        try:
            b["commission"] = float(b.get("commission", 0) or 0)
        except (TypeError, ValueError):
            b["commission"] = 0.0
        if b["commission"] < 0:
            b["commission"] = 0.0
        try:
            b["qty"] = max(1, int(b.get("qty", 1) or 1))
        except (TypeError, ValueError):
            b["qty"] = 1
        if "amountCollected" not in b:
            b["amountCollected"] = None
        if "paymentMethod" not in b:
            b["paymentMethod"] = ""
        if "completedAt" not in b:
            b["completedAt"] = None
        if "orderId" not in b:
            b["orderId"] = None

    cleaned_closed: list[dict] = []
    for row in data.get("closedFollowUps", []):
        if not isinstance(row, dict):
            continue
        try:
            cid = int(row.get("cid", 0) or 0)
            order_id = int(row.get("orderId", 0) or 0)
        except (TypeError, ValueError):
            continue
        if cid <= 0 or order_id <= 0:
            continue
        cleaned_closed.append(
            {
                "cid": cid,
                "orderId": order_id,
                "note": str(row.get("note", "") or "").strip(),
                "closedAt": int(row.get("closedAt") or int(time.time() * 1000)),
            }
        )
    data["closedFollowUps"] = cleaned_closed

    return data


def _normalize_commission_mode(raw: Any) -> str:
    return "batch" if str(raw or "").strip().lower() == "batch" else "per_pcs"


def _normalize_composition(composition: Any) -> list[dict]:
    """Normalize product composition rows to a safe internal shape."""
    if not isinstance(composition, list):
        return []
    rows: list[dict] = []
    for row in composition:
        if not isinstance(row, dict):
            continue
        inv_id = str(row.get("inventoryProductId", "")).strip()
        inv_name = str(row.get("inventoryProductName", "")).strip()
        try:
            pct = float(row.get("percentage", 0) or 0)
        except (TypeError, ValueError):
            pct = 0.0
        if not inv_id or pct <= 0:
            continue
        rows.append(
            {
                "inventoryProductId": inv_id,
                "inventoryProductName": inv_name,
                "percentage": pct,
            }
        )
    return rows


def _variant_to_grams(variant: str) -> float:
    if variant in SIZE_TO_GRAMS:
        return SIZE_TO_GRAMS[variant]
    v = str(variant or "").strip().lower()
    if v.endswith("kg"):
        try:
            return float(v.replace("kg", "").strip()) * 1000.0
        except ValueError:
            return 0.0
    if v.endswith("g"):
        try:
            return float(v.replace("g", "").strip())
        except ValueError:
            return 0.0
    return 0.0


def _draw_wrapped_text(c, text: str, x: float, y: float, max_chars: int, line_height: float = 13.0) -> float:
    """Draw wrapped text and return next y-coordinate below drawn content."""
    raw = str(text or "").strip()
    if not raw:
        return y
    lines: list[str] = []
    for part in raw.splitlines() or [raw]:
        wrapped = textwrap.wrap(part, width=max_chars) or [""]
        lines.extend(wrapped)
    for line in lines:
        c.drawString(x, y, line)
        y -= line_height
    return y


def _build_shipping_label_pdf(order: dict, customer: dict, profile: dict, ship: dict) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    from reportlab.graphics.barcode import code128, qr
    from reportlab.graphics.shapes import Drawing
    from reportlab.graphics import renderPDF

    awb = str(ship.get("awb", "")).strip()
    courier = str(ship.get("courier", "")).strip()
    ship_date = str(ship.get("shipDate", "")).strip()
    code_type = _normalize_code_type(ship.get("codeType"))

    w, h = A4
    left = 40
    right = w - 40
    top = h - 40
    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)

    # Header
    c.setFillColor(colors.HexColor("#111111"))
    c.setFont("Helvetica-Bold", 17)
    c.drawString(left, top, f"Shipping Label  -  Order #{order.get('id')}")
    c.setFont("Helvetica", 10)
    c.setFillColor(colors.HexColor("#666666"))
    c.drawRightString(right, top + 1, f"Generated: {time.strftime('%d %b %Y %H:%M')}")

    # Meta pills (plain text line)
    y = top - 26
    c.setFillColor(colors.HexColor("#111111"))
    c.setFont("Helvetica", 10.5)
    meta = [
        f"Courier: {courier or '-'}",
        f"AWB: {awb or '-'}",
        f"Ship Date: {ship_date or '-'}",
        f"Channel: {order.get('channel') or '-'}",
    ]
    c.drawString(left, y, "   |   ".join(meta))

    # From / To boxes
    box_y_top = y - 18
    box_h = 165
    gap = 14
    box_w = (right - left - gap) / 2.0
    c.setStrokeColor(colors.HexColor("#D9D9D9"))
    c.roundRect(left, box_y_top - box_h, box_w, box_h, 8, stroke=1, fill=0)
    c.roundRect(left + box_w + gap, box_y_top - box_h, box_w, box_h, 8, stroke=1, fill=0)

    # From
    c.setFont("Helvetica-Bold", 10)
    c.setFillColor(colors.HexColor("#444444"))
    c.drawString(left + 10, box_y_top - 16, "FROM")
    c.setFillColor(colors.HexColor("#111111"))
    c.setFont("Helvetica-Bold", 12)
    c.drawString(left + 10, box_y_top - 34, str(profile.get("companyName", "")).strip() or "-")
    c.setFont("Helvetica", 10.5)
    fy = box_y_top - 50
    fy = _draw_wrapped_text(c, str(profile.get("address", "")).strip() or "-", left + 10, fy, max_chars=42, line_height=12)
    _draw_wrapped_text(c, str(profile.get("phone", "")).strip(), left + 10, fy - 4, max_chars=42, line_height=12)

    # To
    c.setFont("Helvetica-Bold", 10)
    c.setFillColor(colors.HexColor("#444444"))
    c.drawString(left + box_w + gap + 10, box_y_top - 16, "TO")
    c.setFillColor(colors.HexColor("#111111"))
    c.setFont("Helvetica-Bold", 12)
    c.drawString(left + box_w + gap + 10, box_y_top - 34, str(customer.get("name") or order.get("cname") or "-").strip())
    c.setFont("Helvetica", 10.5)
    ty = box_y_top - 50
    to_addr = str(customer.get("address", "")).strip()
    to_area = str(customer.get("area") or order.get("carea") or "").strip()
    to_phone = str(customer.get("phone") or order.get("cphone") or "").strip()
    ty = _draw_wrapped_text(c, to_addr or "-", left + box_w + gap + 10, ty, max_chars=42, line_height=12)
    if to_area:
        ty = _draw_wrapped_text(c, to_area, left + box_w + gap + 10, ty - 2, max_chars=42, line_height=12)
    _draw_wrapped_text(c, to_phone, left + box_w + gap + 10, ty - 4, max_chars=42, line_height=12)

    # Shipment details
    details_top = box_y_top - box_h - 14
    c.roundRect(left, details_top - 75, right - left, 75, 8, stroke=1, fill=0)
    c.setFont("Helvetica-Bold", 10)
    c.setFillColor(colors.HexColor("#444444"))
    c.drawString(left + 10, details_top - 16, "SHIPMENT DETAILS")
    c.setFont("Helvetica", 10.5)
    c.setFillColor(colors.HexColor("#111111"))
    product_line = f"{order.get('prod', '')} - {order.get('variant', '')} x {order.get('qty', 1)}"
    c.drawString(left + 10, details_top - 34, f"Product: {product_line}")
    payment_method = str(order.get("paymentMethod", "")).strip()
    c.drawString(left + 10, details_top - 50, f"Payment: {payment_method or '-'}")

    # Code area (QR / Barcode)
    code_top = details_top - 95
    c.roundRect(left, code_top - 145, right - left, 145, 8, stroke=1, fill=0)
    c.setFont("Helvetica-Bold", 10)
    c.setFillColor(colors.HexColor("#444444"))
    c.drawString(left + 10, code_top - 16, f"{'QR CODE' if code_type == 'qr' else 'BARCODE'}")
    c.setFillColor(colors.HexColor("#111111"))

    if code_type == "qr":
        qr_widget = qr.QrCodeWidget(awb or "NA")
        bounds = qr_widget.getBounds()
        bw = bounds[2] - bounds[0]
        bh = bounds[3] - bounds[1]
        size = 98
        d = Drawing(size, size, transform=[size / bw, 0, 0, size / bh, 0, 0])
        d.add(qr_widget)
        renderPDF.draw(d, c, left + 18, code_top - 122)
        c.setFont("Helvetica", 10)
        c.drawString(left + 130, code_top - 70, f"AWB: {awb or '-'}")
    else:
        barcode = code128.Code128(awb or "NA", barHeight=52, barWidth=1.0, humanReadable=True)
        barcode.drawOn(c, left + 18, code_top - 108)

    c.showPage()
    c.save()
    buf.seek(0)
    return buf.read()


def _normalize_code_type(value: Any) -> str:
    return "qr" if str(value or "").strip().lower() == "qr" else "barcode"


def _normalize_couriers(rows: Any) -> list[dict]:
    if not isinstance(rows, list):
        return []
    cleaned: list[dict] = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name", "")).strip()
        if not name:
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(
            {
                "name": name,
                "trackingTemplate": str(row.get("trackingTemplate", "")).strip(),
                "codeType": _normalize_code_type(row.get("codeType")),
            }
        )
    return cleaned


def _couriers_from_templates(templates: Any) -> list[dict]:
    if not isinstance(templates, dict):
        return []
    rows: list[dict] = []
    for k, v in templates.items():
        name = str(k).strip()
        if not name:
            continue
        rows.append(
            {
                "name": name,
                "trackingTemplate": str(v or "").strip(),
                "codeType": "barcode",
            }
        )
    return _normalize_couriers(rows)


def _post_inventory_movement(product_id: str, grams: float, note: str, at: int) -> None:
    payload = json.dumps(
        {"type": "out", "grams": grams, "note": note, "at": at}
    ).encode("utf-8")
    req = urlrequest.Request(
        f"{INVENTORY_URL}/api/products/{product_id}/movements",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=2.5):
        return


def _post_inventory_replace_movements(movements: list[dict]) -> dict:
    payload = json.dumps(
        {"notePrefix": "CRM Order #", "movements": movements}
    ).encode("utf-8")
    req = urlrequest.Request(
        f"{INVENTORY_URL}/api/crm/replace-movements",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=20.0) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {"ok": True}


def _get_inventory_data() -> dict | None:
    req = urlrequest.Request(f"{INVENTORY_URL}/api/data", method="GET")
    try:
        with urlrequest.urlopen(req, timeout=3.0) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw)
    except (urlerror.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        print(f"[CRM] Inventory data fetch failed: {exc}")
        return None


def _get_inventory_stock() -> list[dict] | None:
    req = urlrequest.Request(f"{INVENTORY_URL}/api/stock", method="GET")
    try:
        with urlrequest.urlopen(req, timeout=3.0) as resp:
            raw = resp.read().decode("utf-8")
            parsed = json.loads(raw) if raw else []
            return parsed if isinstance(parsed, list) else []
    except (urlerror.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        print(f"[CRM] Inventory stock fetch failed: {exc}")
        return None


def _delete_inventory_movement(product_id: str, movement_id: int) -> bool:
    req = urlrequest.Request(
        f"{INVENTORY_URL}/api/products/{product_id}/movements/{movement_id}",
        method="DELETE",
    )
    try:
        with urlrequest.urlopen(req, timeout=2.5):
            return True
    except (urlerror.URLError, TimeoutError, OSError) as exc:
        print(f"[CRM] Inventory movement delete failed: {exc}")
        return False


def _remove_inventory_movements_for_order(order_id: int) -> bool:
    """
    Remove all inventory movements previously generated for a CRM order.
    Matches by note prefix: "CRM Order #<id>".
    """
    data = _get_inventory_data()
    if not data or "products" not in data:
        return False
    # Match exactly this order's movement note prefix.
    marker = f"CRM Order #{order_id} ·"
    ok = True
    for p in data.get("products", []):
        pid = p.get("id")
        for m in p.get("movements", []):
            note = str(m.get("note", ""))
            if note.startswith(marker):
                if not _delete_inventory_movement(pid, int(m.get("id"))):
                    ok = False
    return ok


def _remove_all_crm_inventory_movements() -> tuple[bool, int]:
    """
    Remove all inventory movements generated by CRM orders.
    Matches note prefix: 'CRM Order #'.
    """
    data = _get_inventory_data()
    if not data or "products" not in data:
        return False, 0
    ok = True
    deleted = 0
    for p in data.get("products", []):
        pid = p.get("id")
        for m in p.get("movements", []):
            note = str(m.get("note", ""))
            if note.startswith("CRM Order #"):
                if _delete_inventory_movement(pid, int(m.get("id"))):
                    deleted += 1
                else:
                    ok = False
    return ok, deleted


def _build_crm_movements_from_completed_orders(data: dict) -> list[dict]:
    movements: list[dict] = []
    products_by_id = {p.get("id"): p for p in data.get("products", [])}
    for o in data.get("orders", []):
        if o.get("status") != "completed":
            continue
        product = products_by_id.get(o.get("prodId"))
        if not product:
            continue
        composition = _normalize_composition(product.get("composition", []))
        if not composition:
            continue
        pack_grams = _variant_to_grams(o.get("variant", ""))
        qty = float(o.get("qty", 0) or 0)
        if pack_grams <= 0 or qty <= 0:
            continue
        total_grams = pack_grams * qty
        note = f"CRM Order #{o.get('id')} · {o.get('prod')} {o.get('variant')} x{o.get('qty')}"
        for row in composition:
            grams = round(total_grams * (float(row["percentage"]) / 100.0), 3)
            if grams <= 0:
                continue
            movements.append(
                {
                    "productId": row["inventoryProductId"],
                    "type": "out",
                    "grams": grams,
                    "note": note,
                    "at": int(o.get("at") or 0),
                }
            )
    return movements


def _sync_inventory_for_order(product: dict, order: dict) -> bool:
    """
    Deduct inventory by CRM product composition.
    If inventory service is unavailable, fail gracefully without blocking order creation.
    """
    composition = _normalize_composition(product.get("composition", []))
    if not composition:
        return True
    pack_grams = _variant_to_grams(order.get("variant", ""))
    qty = float(order.get("qty", 0) or 0)
    if pack_grams <= 0 or qty <= 0:
        return True
    total_grams = pack_grams * qty
    note = (
        f"CRM Order #{order.get('id')} · {order.get('prod')} "
        f"{order.get('variant')} x{order.get('qty')}"
    )
    all_ok = True
    for row in composition:
        grams = round(total_grams * (float(row["percentage"]) / 100.0), 3)
        if grams <= 0:
            continue
        try:
            _post_inventory_movement(row["inventoryProductId"], grams, note, int(order.get("at") or 0))
        except (urlerror.URLError, TimeoutError, OSError) as exc:
            all_ok = False
            print(f"[CRM] Inventory sync skipped for order #{order.get('id')}: {exc}")
    return all_ok


def _inventory_fields_changed(prev: dict, curr: dict) -> bool:
    keys = ("status", "prodId", "variant", "qty", "at")
    return any(prev.get(k) != curr.get(k) for k in keys)


def _reconcile_order_inventory(data: dict, order_idx: int, prev_order: dict | None = None, force: bool = False) -> bool:
    """
    Keep inventory movements in sync with the current order state.
    - If previously synced/complete and inventory-relevant fields changed, remove old movements.
    - If currently completed, create fresh movements.
    """
    order = data["orders"][order_idx]

    if prev_order is not None and not force and not _inventory_fields_changed(prev_order, order):
        return bool(order.get("inventorySynced"))

    removed_ok = True
    if prev_order is not None and (prev_order.get("inventorySynced") or prev_order.get("status") == "completed"):
        removed_ok = _remove_inventory_movements_for_order(int(prev_order.get("id")))
    order["inventorySynced"] = False
    order["inventorySyncedAt"] = None

    if order.get("status") != "completed":
        return removed_ok

    product = next((p for p in data["products"] if p.get("id") == order.get("prodId")), None)
    if not product:
        return False
    synced_ok = _sync_inventory_for_order(product, order)
    if synced_ok:
        order["inventorySynced"] = True
        order["inventorySyncedAt"] = int(time.time() * 1000)
    return removed_ok and synced_ok


# ── FastAPI app ─────────────────────────────────────────────────────────────
app = FastAPI(title="Kudagu Kaapi CRM", docs_url=None, redoc_url=None)

# Serve static files (index.html, app.js) from ./static/
if not STATIC_DIR.exists():
    STATIC_DIR.mkdir(parents=True)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ── Index route — serves the SPA ──────────────────────────────────────────
@app.get("/", include_in_schema=False)
async def serve_index():
    index = STATIC_DIR / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail="index.html not found in static/")
    return FileResponse(str(index))


# ── Data — full read/write ─────────────────────────────────────────────────
@app.get("/api/data")
async def get_data():
    """Return the full data.json contents."""
    data = read_data()
    data = migrate(data)
    return JSONResponse(content=data)


@app.put("/api/data")
async def put_data(request: Request):
    """Replace the entire data.json with the request body.
    Used by the frontend for bulk save (e.g. after settings changes)."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    if "products" not in body:
        raise HTTPException(status_code=400, detail="Missing 'products' key")
    write_data(body)
    return {"ok": True}


# ── Customers ──────────────────────────────────────────────────────────────
@app.post("/api/customers")
async def add_customer(request: Request):
    body = await request.json()
    required = ("name", "phone", "area")
    if not all(k in body for k in required):
        raise HTTPException(status_code=400, detail=f"Required fields: {required}")
    data = migrate(read_data())
    customer = {
        "id":      data["cid"],
        "name":    body["name"],
        "phone":   body["phone"],
        "area":    body["area"],
        "email":   body.get("email", ""),
        "address": body.get("address", ""),
        "at":      body.get("at"),
    }
    data["customers"].append(customer)
    data["cid"] += 1
    write_data(data)
    return customer


@app.put("/api/customers/{customer_id}")
async def update_customer(customer_id: int, request: Request):
    """Update an existing customer's details."""
    body = await request.json()
    data = migrate(read_data())
    idx = next((i for i, c in enumerate(data["customers"]) if c["id"] == customer_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    for key in ("name", "phone", "area", "email", "address"):
        if key in body:
            data["customers"][idx][key] = body[key]
    # Also update denormalised customer fields on all their orders
    if "name" in body or "phone" in body or "area" in body:
        for o in data["orders"]:
            if o["cid"] == customer_id:
                if "name"  in body: o["cname"]  = body["name"]
                if "phone" in body: o["cphone"] = body["phone"]
                if "area"  in body: o["carea"]  = body["area"]
    write_data(data)
    return data["customers"][idx]


@app.delete("/api/customers/{customer_id}")
async def delete_customer(customer_id: int):
    data = migrate(read_data())
    before = len(data["customers"])
    data["customers"] = [c for c in data["customers"] if c["id"] != customer_id]
    if len(data["customers"]) == before:
        raise HTTPException(status_code=404, detail="Customer not found")
    write_data(data)
    return {"ok": True}


# ── Orders ─────────────────────────────────────────────────────────────────
@app.post("/api/orders")
async def add_order(request: Request):
    body = await request.json()
    required = ("cid", "cname", "cphone", "carea", "prod", "prodId", "variant", "qty", "channel", "at")
    if not all(k in body for k in required):
        raise HTTPException(status_code=400, detail=f"Required fields: {required}")
    data = migrate(read_data())
    channel = body["channel"]
    default_status = "pending" if channel in ("website", "whatsapp") else "confirmed"
    order = {
        "id":         data["oid"],
        "cid":        body["cid"],
        "cname":      body["cname"],
        "cphone":     body["cphone"],
        "carea":      body["carea"],
        "prod":       body["prod"],
        "prodId":     body["prodId"],
        "variant":    body["variant"],
        "qty":        body["qty"],
        "channel":    channel,
        "status":        body.get("status", default_status),
        "discount":      float(body.get("discount", 0) or 0),
        "commission":    float(body.get("commission", 0) or 0),
        "paymentMethod": body.get("paymentMethod", ""),
        "at":            body["at"],
        "realizedRevenue": body.get("realizedRevenue"),
        "distribution": body.get("distribution", {}),
        "inventorySynced": False,
        "inventorySyncedAt": None,
        "shipping": body.get("shipping", {}),
    }
    data["orders"].insert(0, order)
    data["oid"] += 1
    _reconcile_order_inventory(data, 0, prev_order=None, force=True)
    write_data(data)
    return order


@app.put("/api/orders/{order_id}")
async def update_order(order_id: int, request: Request):
    """Update mutable fields on an order: status, discount, commission."""
    body = await request.json()
    data = migrate(read_data())
    idx = next((i for i, o in enumerate(data["orders"]) if o["id"] == order_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Order not found")
    prev = copy.deepcopy(data["orders"][idx])
    for key in ("status", "discount", "commission", "paymentMethod", "qty", "variant", "prodId", "prod", "channel", "at", "cid", "cname", "cphone", "carea", "shipping", "realizedRevenue", "distribution"):
        if key in body:
            data["orders"][idx][key] = body[key]
    _reconcile_order_inventory(data, idx, prev_order=prev)
    write_data(data)
    return data["orders"][idx]


@app.post("/api/distribution/batches")
async def add_distribution_batch(request: Request):
    body = await request.json()
    required = ("distributorName", "prodId", "variant", "qty")
    if not all(k in body for k in required):
        raise HTTPException(status_code=400, detail=f"Required fields: {required}")

    data = migrate(read_data())
    product = next((p for p in data["products"] if p.get("id") == body["prodId"]), None)
    if product is None:
        raise HTTPException(status_code=400, detail="Product not found")

    commission_mode = _normalize_commission_mode(body.get("commissionMode"))
    try:
        commission = float(body.get("commission", 0) or 0)
    except (TypeError, ValueError):
        commission = 0.0
    if commission < 0:
        raise HTTPException(status_code=400, detail="Commission cannot be negative")
    try:
        qty = int(body.get("qty", 0) or 0)
    except (TypeError, ValueError):
        qty = 0
    if qty <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be greater than 0")

    batch = {
        "id": data["dbid"],
        "distributorName": str(body.get("distributorName", "")).strip(),
        "prodId": body["prodId"],
        "prod": product.get("name", body["prodId"]),
        "variant": body["variant"],
        "qty": qty,
        "commission": commission,
        "commissionMode": commission_mode,
        "status": "active",
        "notes": str(body.get("notes", "")).strip(),
        "at": int(body.get("at") or int(time.time() * 1000)),
        "completedAt": None,
        "amountCollected": None,
        "paymentMethod": "",
        "orderId": None,
    }
    if not batch["distributorName"]:
        raise HTTPException(status_code=400, detail="Distributor name is required")

    data["distributorBatches"].insert(0, batch)
    data["dbid"] += 1
    write_data(data)
    return batch


@app.put("/api/distribution/batches/{batch_id}")
async def update_distribution_batch(batch_id: int, request: Request):
    body = await request.json()
    data = migrate(read_data())
    idx = next((i for i, b in enumerate(data["distributorBatches"]) if int(b.get("id", 0)) == batch_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    batch = data["distributorBatches"][idx]
    if batch.get("status") == "completed":
        raise HTTPException(status_code=400, detail="Completed batch cannot be edited")

    if "distributorName" in body:
        batch["distributorName"] = str(body.get("distributorName", "")).strip()
    if "prodId" in body:
        product = next((p for p in data["products"] if p.get("id") == body["prodId"]), None)
        if product is None:
            raise HTTPException(status_code=400, detail="Product not found")
        batch["prodId"] = body["prodId"]
        batch["prod"] = product.get("name", body["prodId"])
    if "variant" in body:
        batch["variant"] = body["variant"]
    if "qty" in body:
        try:
            qty = int(body.get("qty", 0) or 0)
        except (TypeError, ValueError):
            qty = 0
        if qty <= 0:
            raise HTTPException(status_code=400, detail="Quantity must be greater than 0")
        batch["qty"] = qty
    if "commission" in body:
        try:
            comm = float(body.get("commission", 0) or 0)
        except (TypeError, ValueError):
            comm = 0.0
        if comm < 0:
            raise HTTPException(status_code=400, detail="Commission cannot be negative")
        batch["commission"] = comm
    if "commissionMode" in body:
        batch["commissionMode"] = _normalize_commission_mode(body.get("commissionMode"))
    if "notes" in body:
        batch["notes"] = str(body.get("notes", "")).strip()
    if not str(batch.get("distributorName", "")).strip():
        raise HTTPException(status_code=400, detail="Distributor name is required")

    write_data(data)
    return batch


def _delete_distribution_batch_from_data(data: dict, batch_id: int) -> dict:
    idx = next((i for i, b in enumerate(data["distributorBatches"]) if int(b.get("id", 0)) == batch_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Batch not found")

    batch = data["distributorBatches"][idx]
    removed_order_id = None
    try:
        linked_order_id = int(batch.get("orderId") or 0)
    except (TypeError, ValueError):
        linked_order_id = 0

    if linked_order_id > 0:
        order = next((o for o in data["orders"] if int(o.get("id", 0)) == linked_order_id), None)
        if order is not None:
            if order.get("inventorySynced") or order.get("status") == "completed":
                _remove_inventory_movements_for_order(linked_order_id)
            data["orders"] = [o for o in data["orders"] if int(o.get("id", 0)) != linked_order_id]
            removed_order_id = linked_order_id

    del data["distributorBatches"][idx]
    return {"ok": True, "removedOrderId": removed_order_id}


@app.delete("/api/distribution/batches/{batch_id}")
async def delete_distribution_batch(batch_id: int):
    data = migrate(read_data())
    res = _delete_distribution_batch_from_data(data, batch_id)
    write_data(data)
    return res


@app.post("/api/distribution/batches/{batch_id}/delete")
async def delete_distribution_batch_via_post(batch_id: int):
    data = migrate(read_data())
    res = _delete_distribution_batch_from_data(data, batch_id)
    write_data(data)
    return res


@app.post("/api/distribution/batches/{batch_id}/complete")
async def complete_distribution_batch(batch_id: int, request: Request):
    body = await request.json()
    data = migrate(read_data())
    idx = next((i for i, b in enumerate(data["distributorBatches"]) if int(b.get("id", 0)) == batch_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    batch = data["distributorBatches"][idx]
    if batch.get("status") == "completed":
        raise HTTPException(status_code=400, detail="Batch already completed")

    try:
        amount_collected = float(body.get("amountCollected", 0) or 0)
    except (TypeError, ValueError):
        amount_collected = 0.0
    if amount_collected < 0:
        raise HTTPException(status_code=400, detail="Amount collected cannot be negative")

    qty = int(batch.get("qty") or 0)
    commission_mode = _normalize_commission_mode(batch.get("commissionMode"))
    commission_rate = float(batch.get("commission", 0) or 0)
    total_commission = commission_rate if commission_mode == "batch" else commission_rate * qty
    now_ms = int(body.get("at") or int(time.time() * 1000))
    product = next((p for p in data["products"] if p.get("id") == batch.get("prodId")), None)
    prod_name = product.get("name") if product else batch.get("prod", batch.get("prodId"))

    order = {
        "id": data["oid"],
        "cid": 0,
        "cname": str(batch.get("distributorName", "")).strip() or "Distributor",
        "cphone": "",
        "carea": "Distribution Channel",
        "prod": prod_name,
        "prodId": batch.get("prodId"),
        "variant": batch.get("variant"),
        "qty": qty,
        "channel": "retail",
        "status": "completed",
        "discount": 0.0,
        "commission": float(total_commission or 0),
        "paymentMethod": str(body.get("paymentMethod", "")).strip(),
        "at": now_ms,
        "realizedRevenue": amount_collected,
        "distribution": {
            "batchId": int(batch.get("id")),
            "distributorName": str(batch.get("distributorName", "")).strip(),
            "commissionMode": commission_mode,
            "commissionRate": float(commission_rate or 0),
            "totalCommission": float(total_commission or 0),
            "amountCollected": float(amount_collected or 0),
        },
        "inventorySynced": False,
        "inventorySyncedAt": None,
        "shipping": {},
    }
    data["orders"].insert(0, order)
    data["oid"] += 1

    batch["status"] = "completed"
    batch["completedAt"] = now_ms
    batch["amountCollected"] = float(amount_collected or 0)
    batch["paymentMethod"] = str(body.get("paymentMethod", "")).strip()
    batch["orderId"] = order["id"]

    _reconcile_order_inventory(data, 0, prev_order=None, force=True)
    write_data(data)
    return {"batch": batch, "order": order}


@app.post("/api/alerts/followups/close")
async def close_followup_alert(request: Request):
    body = await request.json()
    try:
        cid = int(body.get("cid", 0) or 0)
        order_id = int(body.get("orderId", 0) or 0)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid cid/orderId")
    if cid <= 0 or order_id <= 0:
        raise HTTPException(status_code=400, detail="cid and orderId are required")

    note = str(body.get("note", "") or "").strip()
    closed_at = int(body.get("at") or int(time.time() * 1000))

    data = migrate(read_data())
    data["closedFollowUps"] = [
        r
        for r in data.get("closedFollowUps", [])
        if not (int(r.get("cid", 0)) == cid and int(r.get("orderId", 0)) == order_id)
    ]
    data["closedFollowUps"].append(
        {
            "cid": cid,
            "orderId": order_id,
            "note": note,
            "closedAt": closed_at,
        }
    )
    write_data(data)
    return {"ok": True, "cid": cid, "orderId": order_id, "note": note, "closedAt": closed_at}


@app.get("/api/orders/{order_id}/shipping-label.pdf")
async def shipping_label_pdf(order_id: int):
    data = migrate(read_data())
    order = next((o for o in data["orders"] if o.get("id") == order_id), None)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")

    ship = order.get("shipping") or {}
    awb = str(ship.get("awb", "")).strip()
    courier = str(ship.get("courier", "")).strip()
    ship_date = str(ship.get("shipDate", "")).strip()
    if not (awb and courier and ship_date):
        raise HTTPException(status_code=400, detail="Shipping details incomplete for PDF label")

    customer = next((c for c in data.get("customers", []) if c.get("id") == order.get("cid")), {})
    profile = data.get("shippingProfile", {}) or {}
    try:
        pdf_bytes = _build_shipping_label_pdf(order, customer, profile, ship)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=f"Could not generate PDF label: {exc}")

    headers = {"Content-Disposition": f'attachment; filename="shipping-label-order-{order_id}.pdf"'}
    return StreamingResponse(BytesIO(pdf_bytes), media_type="application/pdf", headers=headers)


@app.post("/api/inventory/sync-completed-orders")
async def sync_completed_orders():
    """
    Reconcile inventory usage from completed CRM orders.
    Safe to run repeatedly; removes prior CRM-linked movements per order
    and re-applies from current order values (date/qty/variant/product).
    """
    if not SYNC_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Inventory sync already in progress")
    try:
        data = migrate(read_data())
        completed_total = sum(1 for o in data["orders"] if o.get("status") == "completed")
        movements = _build_crm_movements_from_completed_orders(data)
        try:
            replace_res = _post_inventory_replace_movements(movements)
        except (urlerror.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=502, detail=f"Inventory replace failed: {exc}")

        now_ms = int(time.time() * 1000)
        synced = 0
        for o in data["orders"]:
            if o.get("status") == "completed":
                o["inventorySynced"] = True
                o["inventorySyncedAt"] = now_ms
                synced += 1
            else:
                o["inventorySynced"] = False
                o["inventorySyncedAt"] = None

        write_data(data)
        return {
            "ok": True,
            "completedOrders": completed_total,
            "reconciledNow": synced,
            "syncedNow": synced,
            "completedOrdersPendingAfter": 0,
            "removedOldMovements": int(replace_res.get("removed", 0)),
            "addedNewMovements": int(replace_res.get("added", 0)),
            "bulkReplace": True,
        }
    finally:
        SYNC_LOCK.release()


@app.get("/api/inventory/stock")
async def inventory_stock():
    stock = _get_inventory_stock()
    if stock is None:
        raise HTTPException(status_code=502, detail="Inventory service unavailable")
    return stock


@app.delete("/api/orders/{order_id}")
async def delete_order(order_id: int):
    data = migrate(read_data())
    order = next((o for o in data["orders"] if o["id"] == order_id), None)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    # Remove previously synced inventory movements for this order.
    if order.get("inventorySynced") or order.get("status") == "completed":
        _remove_inventory_movements_for_order(order_id)
    data["orders"] = [o for o in data["orders"] if o["id"] != order_id]
    write_data(data)
    return {"ok": True}


# ── Products ───────────────────────────────────────────────────────────────
@app.post("/api/products")
async def add_product(request: Request):
    body = await request.json()
    if not body.get("name"):
        raise HTTPException(status_code=400, detail="Product name required")
    if not body.get("sizes"):
        raise HTTPException(status_code=400, detail="At least one size required")
    data = migrate(read_data())
    product = {
        "id":      "p" + str(data["pid"]),
        "name":    body["name"],
        "sizes":   body["sizes"],
        "waTpl":   body.get("waTpl", ""),
        "pricing": body.get("pricing", {}),
        "composition": _normalize_composition(body.get("composition", [])),
    }
    data["products"].append(product)
    data["pid"] += 1
    write_data(data)
    return product


@app.put("/api/products/{product_id}")
async def update_product(product_id: str, request: Request):
    """Update a product (pricing, waTpl, sizes, name)."""
    body = await request.json()
    data = migrate(read_data())
    idx = next((i for i, p in enumerate(data["products"]) if p["id"] == product_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Product not found")
    # Merge — only update provided keys
    for key in ("name", "sizes", "waTpl", "pricing"):
        if key in body:
            data["products"][idx][key] = body[key]
    if "composition" in body:
        data["products"][idx]["composition"] = _normalize_composition(body.get("composition", []))
    write_data(data)
    return data["products"][idx]


@app.delete("/api/products/{product_id}")
async def delete_product(product_id: str):
    data = migrate(read_data())
    before = len(data["products"])
    data["products"] = [p for p in data["products"] if p["id"] != product_id]
    if len(data["products"]) == before:
        raise HTTPException(status_code=404, detail="Product not found")
    write_data(data)
    return {"ok": True}


# ── Settings (waDefaultTpl + shippingProfile) ──────────────────────────────
@app.put("/api/settings")
async def update_settings(request: Request):
    body = await request.json()
    data = migrate(read_data())
    if "waDefaultTpl" in body:
        data["waDefaultTpl"] = body["waDefaultTpl"]
    if "shippingProfile" in body and isinstance(body["shippingProfile"], dict):
        profile = copy.deepcopy(data.get("shippingProfile", {}))
        for key in ("companyName", "address", "phone", "email", "gstin"):
            if key in body["shippingProfile"]:
                profile[key] = body["shippingProfile"][key]
        if "shippedWaTemplate" in body["shippingProfile"]:
            profile["shippedWaTemplate"] = str(body["shippingProfile"].get("shippedWaTemplate") or "").strip()
        if "paymentGatewayCommissionPct" in body["shippingProfile"]:
            try:
                profile["paymentGatewayCommissionPct"] = float(body["shippingProfile"]["paymentGatewayCommissionPct"] or 0)
            except (TypeError, ValueError):
                profile["paymentGatewayCommissionPct"] = data.get("shippingProfile", {}).get("paymentGatewayCommissionPct", 3.0)
            if profile["paymentGatewayCommissionPct"] < 0:
                profile["paymentGatewayCommissionPct"] = 0.0
        if "couriers" in body["shippingProfile"] and isinstance(body["shippingProfile"]["couriers"], list):
            profile["couriers"] = _normalize_couriers(body["shippingProfile"]["couriers"])
        if "trackingTemplates" in body["shippingProfile"] and isinstance(body["shippingProfile"]["trackingTemplates"], dict):
            clean = {}
            for k, v in body["shippingProfile"]["trackingTemplates"].items():
                ks = str(k).strip()
                if not ks:
                    continue
                clean[ks] = str(v or "").strip()
            profile["trackingTemplates"] = clean
        if not isinstance(profile.get("trackingTemplates"), dict):
            profile["trackingTemplates"] = {}
        if isinstance(profile.get("couriers"), list) and profile["couriers"]:
            profile["trackingTemplates"] = {
                c["name"]: str(c.get("trackingTemplate", "")).strip()
                for c in profile["couriers"]
            }
        elif profile["trackingTemplates"]:
            profile["couriers"] = _couriers_from_templates(profile["trackingTemplates"])
        data["shippingProfile"] = profile
    write_data(data)
    return {"ok": True}


# ── Entry point ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    # Ensure data.json exists on startup
    if not DATA_FILE.exists():
        write_data(copy.deepcopy(DEFAULT_DATA))
        print(f"[CRM] Created fresh data.json at {DATA_FILE}")
    else:
        print(f"[CRM] Using existing data.json at {DATA_FILE}")

    print("[CRM] Starting server at http://0.0.0.0:8000")
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False)
