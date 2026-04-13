"""
Kudagu Kaapi CRM — app.py
FastAPI + uvicorn backend.

All data is stored in SQLite (data.sqlite3), with one-time import from data.json.
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
import re
import base64
import csv
import socket
import ipaddress
import sqlite3
import secrets
import hashlib
import hmac
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib import parse as urlparse

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import app_config

# ── Paths ──────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent
DB_FILE = BASE_DIR / "data.sqlite3"
LEGACY_DATA_FILE = BASE_DIR / "data.json"
STATE_KEY = "root"
STATIC_DIR = BASE_DIR / "static"
UI_PREFS_FILE = BASE_DIR / "ui_prefs.json"
INVENTORY_URL = os.environ.get("INVENTORY_URL", "http://localhost:8001")
SIZE_TO_GRAMS = {"100g": 100.0, "250g": 250.0, "500g": 500.0, "1kg": 1000.0}
SYNC_LOCK = threading.Lock()
MAX_IMPORT_BYTES = int(os.environ.get("MAX_IMPORT_BYTES", str(5 * 1024 * 1024)))
ALLOW_PRIVATE_AI_BASE_URL = os.environ.get("ALLOW_PRIVATE_AI_BASE_URL", "").strip().lower() in ("1", "true", "yes", "on")
DATA_LOCK = threading.RLock()
UI_PREFS_LOCK = threading.RLock()
DATA_CACHE: dict | None = None
DASHBOARD_CACHE_LOCK = threading.RLock()
DASHBOARD_METRICS_CACHE: dict[str, Any] = {"expires_at": 0.0, "payload": None}
DEFAULT_UI_PREFERENCES: dict[str, str] = {"theme": "light"}
ALLOWED_THEMES = {"light", "dark", "nord", "solarized", "dracula"}
SCHEMA_VERSION = 3
AUTH_COOKIE_NAME = "kudagu_crm_session"
PASSWORD_HASH_ITERATIONS = 310_000
AUTH_SESSION_TTL_SECONDS = max(1, int(getattr(app_config, "SESSION_TTL_HOURS", 12) or 12)) * 60 * 60

PAGE_KEYS = ("dashboard", "sales", "orders", "alerts", "marketing", "distribution", "expenses", "customers", "settings")
DASHBOARD_CARD_KEYS = (
    "revenue",
    "profit",
    "momChange",
    "analytics",
    "avgOrderValue",
    "inventoryMoved",
    "customers",
    "alerts",
)
ACTION_KEYS: dict[str, tuple[str, ...]] = {
    "customers": ("create", "edit", "delete"),
    "orders": ("create", "edit", "delete"),
    "distribution": ("create", "edit", "delete", "complete"),
    "expenses": ("create",),
    "products": ("create", "edit", "delete"),
    "settings": ("view", "manage"),
    "marketing": ("view", "generate"),
    "shipping": ("labels",),
    "inventory": ("sync",),
    "users": ("manage",),
}

# ── Default initial data (used only when neither SQLite nor legacy JSON exist) ──────
DEFAULT_DATA: dict = {
    "customers": [],
    "orders": [],
    "distributorBatches": [],
    "distributionChannels": [],
    "operationalExpenses": [],
    "closedFollowUps": [],
    "users": [],
    "authSessions": [],
    "cid": 1,
    "oid": 1,
    "dbid": 1,
    "exid": 1,
    "pid": 6,
    "uid": 1,
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
    "marketingSettings": {
        "aiBaseUrl": "https://api.openai.com/v1",
        "aiModel": "",
        "aiApiKey": "",
        "brandName": "",
        "systemPrompt": (
            "You are a concise marketing assistant for a premium coffee brand in India. "
            "Write a warm, personalized WhatsApp message in plain text. Keep it short, "
            "specific to the customer context, and include a clear but soft call to action. "
            "Avoid markdown, hashtags, and overhyped claims."
        ),
    },
    "products": [
        {"id": "p1", "name": "Coorg Filter Coffee Powder", "sizes": ["100g","250g","500g","1kg"], "waTpl": "", "pricing": {}},
        {"id": "p2", "name": "Coorg Pure Arabica",          "sizes": ["100g","250g","500g","1kg"], "waTpl": "", "pricing": {}},
        {"id": "p3", "name": "Coorg Dark Roast Blend",      "sizes": ["100g","250g","500g","1kg"], "waTpl": "", "pricing": {}},
        {"id": "p4", "name": "Chicory Blend",               "sizes": ["100g","250g","500g","1kg"], "waTpl": "", "pricing": {}},
        {"id": "p5", "name": "Instant Coffee Mix",          "sizes": ["100g","250g","500g","1kg"], "waTpl": "", "pricing": {}},
    ],
}


def _auth_enabled() -> bool:
    return bool(getattr(app_config, "USERNAME_PASSWORD_AUTH_ENABLED", False))


def _rbac_enabled() -> bool:
    return _auth_enabled() and bool(getattr(app_config, "ROLE_BASED_ACCESS_ENABLED", False))


def _default_permissions_for_role(role: str) -> dict:
    if role == "employee":
        pages = {key: key in {"dashboard", "sales", "orders", "alerts", "customers"} for key in PAGE_KEYS}
        cards = {
            "revenue": False,
            "profit": False,
            "momChange": True,
            "analytics": True,
            "avgOrderValue": False,
            "inventoryMoved": True,
            "customers": True,
            "alerts": True,
        }
        actions = {
            "customers": {"create": True, "edit": True, "delete": False},
            "orders": {"create": True, "edit": True, "delete": False},
            "distribution": {"create": False, "edit": False, "delete": False, "complete": False},
            "expenses": {"create": False},
            "products": {"create": False, "edit": False, "delete": False},
            "settings": {"view": False, "manage": False},
            "marketing": {"view": False, "generate": False},
            "shipping": {"labels": True},
            "inventory": {"sync": False},
            "users": {"manage": False},
        }
    elif role == "partner":
        pages = {key: key in {"dashboard", "sales", "orders", "alerts", "marketing", "distribution", "customers"} for key in PAGE_KEYS}
        cards = {key: True for key in DASHBOARD_CARD_KEYS}
        actions = {
            "customers": {"create": True, "edit": True, "delete": False},
            "orders": {"create": True, "edit": True, "delete": False},
            "distribution": {"create": True, "edit": True, "delete": False, "complete": True},
            "expenses": {"create": False},
            "products": {"create": False, "edit": False, "delete": False},
            "settings": {"view": False, "manage": False},
            "marketing": {"view": True, "generate": True},
            "shipping": {"labels": True},
            "inventory": {"sync": False},
            "users": {"manage": False},
        }
    else:
        pages = {key: True for key in PAGE_KEYS}
        cards = {key: True for key in DASHBOARD_CARD_KEYS}
        actions = {section: {action: True for action in keys} for section, keys in ACTION_KEYS.items()}
    return {"pages": pages, "dashboardCards": cards, "actions": actions}


def _normalize_permissions(role: str, raw: Any = None) -> dict:
    base = _default_permissions_for_role(role)
    if role == "admin":
        return base
    incoming = raw if isinstance(raw, dict) else {}
    pages = incoming.get("pages") if isinstance(incoming.get("pages"), dict) else {}
    cards = incoming.get("dashboardCards") if isinstance(incoming.get("dashboardCards"), dict) else {}
    actions_in = incoming.get("actions") if isinstance(incoming.get("actions"), dict) else {}
    for key in PAGE_KEYS:
        if key in pages:
            base["pages"][key] = bool(pages[key])
    for key in DASHBOARD_CARD_KEYS:
        if key in cards:
            base["dashboardCards"][key] = bool(cards[key])
    for section, keys in ACTION_KEYS.items():
        section_in = actions_in.get(section) if isinstance(actions_in.get(section), dict) else {}
        for key in keys:
            if key in section_in:
                base["actions"][section][key] = bool(section_in[key])
    return base


def _normalize_product_access(values: Any, known_products: list[dict]) -> list[str]:
    allowed_ids = {str(p.get("id")) for p in known_products if isinstance(p, dict) and p.get("id")}
    if not isinstance(values, list):
        values = []
    out: list[str] = []
    seen: set[str] = set()
    for raw in values:
        pid = str(raw or "").strip()
        if not pid or pid not in allowed_ids or pid in seen:
            continue
        seen.add(pid)
        out.append(pid)
    return out


def _default_variant_cycle_days(variant: Any) -> int:
    raw = str(variant or "").strip().lower()
    if not raw:
        return 10
    match = re.match(r"^([0-9]*\.?[0-9]+)\s*(kg|g|l|ml|pcs)\s*$", raw)
    if not match:
        return 10
    try:
        qty = float(match.group(1) or 0)
    except (TypeError, ValueError):
        return 10
    unit = str(match.group(2) or "").lower()
    if qty <= 0:
        return 10
    if unit in {"kg", "g"}:
        grams = qty * 1000 if unit == "kg" else qty
        if grams <= 120:
            return 7
        if grams <= 300:
            return 10
        if grams <= 600:
            return 14
        if grams <= 1200:
            return 30
        return 45
    if unit in {"l", "ml"}:
        ml = qty * 1000 if unit == "l" else qty
        if ml <= 120:
            return 7
        if ml <= 300:
            return 10
        if ml <= 600:
            return 14
        if ml <= 1200:
            return 30
        return 45
    if unit == "pcs":
        if qty <= 1:
            return 7
        if qty <= 3:
            return 14
        if qty <= 6:
            return 21
        return 30
    return 10


def _normalize_product_pricing(pricing: Any, sizes: list[str] | None = None) -> dict:
    if not isinstance(pricing, dict):
        pricing = {}
    normalized: dict[str, dict] = {}
    size_values = [str(s or "").strip() for s in (sizes or []) if str(s or "").strip()]
    for size, raw_row in pricing.items():
        key = str(size or "").strip()
        if not key:
            continue
        row = raw_row if isinstance(raw_row, dict) else {}
        sale_prices = row.get("salePrices") or {}
        if "salePrice" in row and "salePrices" not in row:
            old = row.get("salePrice")
            sale_prices = {"retail": old, "website": old, "whatsapp": old}
        normalized_row = {
            "salePrices": {
                "retail": _safe_float((sale_prices or {}).get("retail")),
                "website": _safe_float((sale_prices or {}).get("website")),
                "whatsapp": _safe_float((sale_prices or {}).get("whatsapp")),
            },
            "expenses": [],
            "reorderCycleDays": _default_variant_cycle_days(key),
        }
        expenses = row.get("expenses") or []
        if isinstance(expenses, list):
            normalized_row["expenses"] = [
                {
                    "name": str(e.get("name") or "").strip(),
                    "cost": _safe_float(e.get("cost")),
                }
                for e in expenses
                if isinstance(e, dict) and (str(e.get("name") or "").strip() or _safe_float(e.get("cost")) > 0)
            ]
        reorder_cycle_days = row.get("reorderCycleDays")
        try:
            reorder_cycle_days = int(float(reorder_cycle_days))
        except (TypeError, ValueError):
            reorder_cycle_days = normalized_row["reorderCycleDays"]
        normalized_row["reorderCycleDays"] = reorder_cycle_days if reorder_cycle_days > 0 else normalized_row["reorderCycleDays"]
        normalized[key] = normalized_row
    for size in size_values:
        normalized.setdefault(
            size,
            {
                "salePrices": {"retail": 0.0, "website": 0.0, "whatsapp": 0.0},
                "expenses": [],
                "reorderCycleDays": _default_variant_cycle_days(size),
            },
        )
    return normalized


def _expense_creator_payload(user: dict | None) -> dict:
    if not user:
        return {"id": 0, "username": "local", "displayName": "Local User"}
    return {
        "id": int(user.get("id") or 0),
        "username": str(user.get("username") or "").strip() or "unknown",
        "displayName": str(user.get("displayName") or user.get("username") or "Unknown User").strip() or "Unknown User",
    }


def _normalize_operational_expense(raw: dict, fallback_id: int = 0) -> dict:
    title = str(raw.get("title") or raw.get("name") or "").strip()
    if not title:
        title = "Operational Expense"
    category = str(raw.get("category") or "").strip()
    notes = str(raw.get("notes") or raw.get("note") or "").strip()
    try:
        amount = round(float(raw.get("amount") or 0), 2)
    except (TypeError, ValueError):
        amount = 0.0
    if amount < 0:
        amount = 0.0
    expense_at = int(raw.get("expenseAt") or raw.get("at") or raw.get("createdAt") or int(time.time() * 1000))
    created_at = int(raw.get("createdAt") or expense_at or int(time.time() * 1000))
    creator = raw.get("createdBy") if isinstance(raw.get("createdBy"), dict) else {}
    created_by = {
        "id": int(creator.get("id") or raw.get("createdById") or 0),
        "username": str(creator.get("username") or raw.get("createdByUsername") or "").strip() or "local",
        "displayName": str(creator.get("displayName") or raw.get("createdByName") or "").strip() or "Local User",
    }
    return {
        "id": int(raw.get("id") or fallback_id or 0),
        "title": title,
        "category": category,
        "amount": amount,
        "expenseAt": expense_at,
        "createdAt": created_at,
        "notes": notes,
        "createdBy": created_by,
    }


def _normalize_username(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().lower())


def _password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_HASH_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PASSWORD_HASH_ITERATIONS,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(derived).decode("ascii"),
    )


def _verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations_raw, salt_b64, digest_b64 = str(encoded or "").split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        iterations = int(iterations_raw)
        salt = base64.b64decode(salt_b64.encode("ascii"))
        expected = base64.b64decode(digest_b64.encode("ascii"))
    except Exception:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


def _hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _prune_expired_sessions(data: dict) -> None:
    now = int(time.time())
    data["authSessions"] = [
        s for s in (data.get("authSessions", []) or [])
        if isinstance(s, dict) and int(s.get("expiresAt") or 0) > now
    ]


def _create_session(data: dict, user_id: int) -> str:
    _prune_expired_sessions(data)
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    data.setdefault("authSessions", []).append(
        {
            "tokenHash": _hash_session_token(token),
            "userId": int(user_id),
            "createdAt": now,
            "expiresAt": now + AUTH_SESSION_TTL_SECONDS,
            "lastSeenAt": now,
        }
    )
    return token


def _delete_session(data: dict, token: str) -> None:
    hashed = _hash_session_token(token)
    data["authSessions"] = [s for s in (data.get("authSessions", []) or []) if s.get("tokenHash") != hashed]


def _set_auth_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        AUTH_COOKIE_NAME,
        token,
        max_age=AUTH_SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=False,
        path="/",
    )


def _clear_auth_cookie(response: Response) -> None:
    response.delete_cookie(AUTH_COOKIE_NAME, path="/")


def _find_user_by_id(data: dict, user_id: Any) -> dict | None:
    try:
        numeric_id = int(user_id)
    except (TypeError, ValueError):
        return None
    return next((u for u in data.get("users", []) if int(u.get("id", 0)) == numeric_id), None)


def _find_user_by_username(data: dict, username: Any) -> dict | None:
    key = _normalize_username(username)
    return next((u for u in data.get("users", []) if _normalize_username(u.get("username")) == key), None)


def _auth_user_payload(user: dict | None) -> dict | None:
    if not user:
        return None
    return {
        "id": int(user.get("id", 0)),
        "username": str(user.get("username") or ""),
        "displayName": str(user.get("displayName") or user.get("username") or ""),
        "role": str(user.get("role") or "admin"),
        "allowedProductIds": list(user.get("allowedProductIds", []) or []),
        "permissions": _normalize_permissions(str(user.get("role") or "admin"), user.get("permissions")),
    }


def _has_financial_access(user: dict | None) -> bool:
    if not user or not _rbac_enabled() or str(user.get("role") or "") == "admin":
        return True
    cards = _normalize_permissions(str(user.get("role") or "admin"), user.get("permissions")).get("dashboardCards", {})
    return bool(cards.get("revenue") or cards.get("profit") or cards.get("avgOrderValue"))


def _allowed_product_ids_for_user(user: dict | None, data: dict) -> set[str] | None:
    if not user or not _rbac_enabled() or str(user.get("role") or "") == "admin":
        return None
    allowed = _normalize_product_access(user.get("allowedProductIds"), data.get("products", []) or [])
    return set(allowed)


def _user_can_view_page(user: dict | None, page: str) -> bool:
    if not user or not _rbac_enabled() or str(user.get("role") or "") == "admin":
        return True
    return bool(_normalize_permissions(str(user.get("role") or "admin"), user.get("permissions")).get("pages", {}).get(page, False))


def _user_can_do(user: dict | None, section: str, action: str) -> bool:
    if not user or not _rbac_enabled() or str(user.get("role") or "") == "admin":
        return True
    perms = _normalize_permissions(str(user.get("role") or "admin"), user.get("permissions"))
    return bool(perms.get("actions", {}).get(section, {}).get(action, False))


def _build_auth_context(data: dict, request: Request) -> dict:
    if not _auth_enabled():
        return {"enabled": False, "authenticated": True, "setupRequired": False, "user": None}
    _prune_expired_sessions(data)
    setup_required = not any(str(u.get("role") or "admin") == "admin" for u in data.get("users", []))
    token = request.cookies.get(AUTH_COOKIE_NAME) or ""
    if not token:
        return {"enabled": True, "authenticated": False, "setupRequired": setup_required, "user": None}
    hashed = _hash_session_token(token)
    now = int(time.time())
    session = next((s for s in data.get("authSessions", []) if s.get("tokenHash") == hashed and int(s.get("expiresAt") or 0) > now), None)
    if not session:
        return {"enabled": True, "authenticated": False, "setupRequired": setup_required, "user": None}
    user = _find_user_by_id(data, session.get("userId"))
    if not user:
        return {"enabled": True, "authenticated": False, "setupRequired": setup_required, "user": None}
    session["lastSeenAt"] = now
    return {"enabled": True, "authenticated": True, "setupRequired": setup_required, "user": user}


def _require_signed_in(request: Request, data: dict) -> dict:
    ctx = _build_auth_context(data, request)
    if not ctx["enabled"]:
        return ctx
    if ctx["setupRequired"]:
        raise HTTPException(status_code=403, detail="Setup is required before sign in.")
    if not ctx["authenticated"] or not ctx["user"]:
        raise HTTPException(status_code=401, detail="Authentication required.")
    return ctx


def _require_admin(request: Request, data: dict) -> dict:
    ctx = _require_signed_in(request, data)
    user = ctx.get("user")
    if _rbac_enabled() and str(user.get("role") or "") != "admin":
        raise HTTPException(status_code=403, detail="Admin access is required.")
    return ctx


def _ensure_page_access(user: dict | None, page: str) -> None:
    if not _user_can_view_page(user, page):
        raise HTTPException(status_code=403, detail=f"Access denied for page '{page}'.")


def _ensure_action_access(user: dict | None, section: str, action: str) -> None:
    if not _user_can_do(user, section, action):
        raise HTTPException(status_code=403, detail=f"Access denied for {section}:{action}.")


def _ensure_product_scope(user: dict | None, data: dict, product_id: Any) -> None:
    allowed = _allowed_product_ids_for_user(user, data)
    if allowed is None:
        return
    if str(product_id or "") not in allowed:
        raise HTTPException(status_code=403, detail="Access denied for this product.")


def _ensure_customer_scope(user: dict | None, data: dict, customer_id: Any) -> None:
    allowed = _allowed_product_ids_for_user(user, data)
    if allowed is None:
        return
    visible_customer_ids = {
        int(o.get("cid") or 0)
        for o in data.get("orders", [])
        if int(o.get("cid") or 0) > 0 and str(o.get("prodId") or "") in allowed
    }
    try:
        cid = int(customer_id or 0)
    except (TypeError, ValueError):
        cid = 0
    if cid not in visible_customer_ids:
        raise HTTPException(status_code=403, detail="Access denied for this customer.")


def _filtered_data_for_user(data: dict, user: dict | None) -> dict:
    safe = copy.deepcopy(data)
    allowed_product_ids = _allowed_product_ids_for_user(user, data)
    if allowed_product_ids is not None:
        safe["products"] = [p for p in safe.get("products", []) if str(p.get("id")) in allowed_product_ids]
        safe["orders"] = [o for o in safe.get("orders", []) if str(o.get("prodId")) in allowed_product_ids]
        safe["distributorBatches"] = [b for b in safe.get("distributorBatches", []) if str(b.get("prodId")) in allowed_product_ids]
        allowed_customer_ids = {int(o.get("cid") or 0) for o in safe.get("orders", []) if int(o.get("cid") or 0) > 0}
        safe["customers"] = [c for c in safe.get("customers", []) if int(c.get("id") or 0) in allowed_customer_ids]
        safe["closedFollowUps"] = [
            r for r in safe.get("closedFollowUps", [])
            if int(r.get("cid") or 0) in allowed_customer_ids and int(r.get("orderId") or 0) in {int(o.get("id") or 0) for o in safe.get("orders", [])}
        ]
    if not _has_financial_access(user):
        for product in safe.get("products", []):
            pricing = product.get("pricing") or {}
            product["pricing"] = {
                str(size): {"reorderCycleDays": _safe_float((row or {}).get("reorderCycleDays"))}
                for size, row in pricing.items()
                if isinstance(row, dict)
            }
        for order in safe.get("orders", []):
            order["discount"] = None
            order["commission"] = None
            order["realizedRevenue"] = None
        if isinstance(safe.get("shippingProfile"), dict):
            safe["shippingProfile"]["paymentGatewayCommissionPct"] = 0.0
        safe["operationalExpenses"] = []
    elif not _user_can_view_page(user, "expenses"):
        safe["operationalExpenses"] = []
    safe.pop("users", None)
    safe.pop("authSessions", None)
    return safe


def _filtered_order_response(data: dict, user: dict | None, order_id: int) -> dict:
    filtered = _filtered_data_for_user(data, user)
    order = next((o for o in filtered.get("orders", []) if int(o.get("id", 0)) == int(order_id)), None)
    if order is None:
        raise HTTPException(status_code=403, detail="Access denied for this order.")
    return order


def _auth_context_payload(data: dict, request: Request) -> dict:
    ctx = _build_auth_context(data, request)
    user_payload = _auth_user_payload(ctx.get("user"))
    return {
        "enabled": _auth_enabled(),
        "roleModelEnabled": _rbac_enabled(),
        "setupRequired": bool(ctx.get("setupRequired")),
        "authenticated": bool(ctx.get("authenticated")),
        "user": user_payload,
    }


def _sanitize_dashboard_metrics_for_user(metrics: dict, user: dict | None) -> dict:
    safe = copy.deepcopy(metrics)
    if _has_financial_access(user):
        return safe
    for key in ("revAll", "profAll", "revM", "profM", "mom", "yoy", "completedOrders", "ordersPerCustomer", "retentionPct"):
        if key in safe:
            safe[key] = None
    return safe


def _allowed_inventory_product_ids_for_user(user: dict | None, data: dict) -> set[str] | None:
    allowed_product_ids = _allowed_product_ids_for_user(user, data)
    if allowed_product_ids is None:
        return None
    allowed_inventory_ids: set[str] = set()
    for product in data.get("products", []) or []:
        if str(product.get("id") or "") not in allowed_product_ids:
            continue
        for row in product.get("composition", []) or []:
            inv_id = str(row.get("inventoryProductId") or "").strip()
            if inv_id:
                allowed_inventory_ids.add(inv_id)
    return allowed_inventory_ids


def _normalize_user_record(raw: dict, data: dict, *, preserve_password_hash: str = "") -> dict:
    username = _normalize_username(raw.get("username"))
    if not username:
        raise HTTPException(status_code=400, detail="Username is required.")
    role = str(raw.get("role") or "admin").strip().lower()
    if role not in {"admin", "partner", "employee"}:
        role = "admin"
    if not _rbac_enabled():
        role = "admin"
    record = {
        "id": int(raw.get("id") or 0),
        "username": username,
        "displayName": str(raw.get("displayName") or username).strip() or username,
        "role": role,
        "allowedProductIds": _normalize_product_access(raw.get("allowedProductIds"), data.get("products", []) or []),
        "permissions": _normalize_permissions(role, raw.get("permissions")),
        "passwordHash": preserve_password_hash,
        "createdAt": int(raw.get("createdAt") or int(time.time() * 1000)),
        "updatedAt": int(time.time() * 1000),
    }
    if role == "admin":
        record["allowedProductIds"] = []
        record["permissions"] = _normalize_permissions("admin")
    return record

# ── Data helpers ────────────────────────────────────────────────────────────
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
    """Read app data from SQLite with an in-memory read cache."""
    global DATA_CACHE
    _init_storage()
    with DATA_LOCK:
        if DATA_CACHE is None:
            with _connect_db() as conn:
                DATA_CACHE = _load_state_from_db(conn)
        return copy.deepcopy(DATA_CACHE)


def write_data(data: dict) -> None:
    """Persist app data, writing only changed top-level sections."""
    global DATA_CACHE
    _init_storage()
    migrated = migrate(copy.deepcopy(data))
    with DATA_LOCK:
        current = copy.deepcopy(DATA_CACHE) if DATA_CACHE is not None else {}
        with _connect_db() as conn:
            _save_state_to_db(conn, current, migrated)
            _set_schema_version(conn, SCHEMA_VERSION)
        DATA_CACHE = migrated
    with DASHBOARD_CACHE_LOCK:
        DASHBOARD_METRICS_CACHE["expires_at"] = 0.0
        DASHBOARD_METRICS_CACHE["payload"] = None


def migrate(data: dict) -> dict:
    """Apply any schema migrations in-place and return the data."""
    # Ensure top-level lists exist
    for key in ("customers", "orders", "products", "distributorBatches", "operationalExpenses", "closedFollowUps", "users", "authSessions"):
        if key not in data:
            data[key] = []
    for key in ("cid", "oid", "dbid", "uid", "exid"):
        if key not in data:
            data[key] = 1
    if "pid" not in data:
        data["pid"] = len(data["products"]) + 1
    if "waDefaultTpl" not in data:
        data["waDefaultTpl"] = DEFAULT_DATA["waDefaultTpl"]
    if "shippingProfile" not in data or not isinstance(data.get("shippingProfile"), dict):
        data["shippingProfile"] = copy.deepcopy(DEFAULT_DATA["shippingProfile"])
    if "marketingSettings" not in data or not isinstance(data.get("marketingSettings"), dict):
        data["marketingSettings"] = copy.deepcopy(DEFAULT_DATA["marketingSettings"])
    ms = data["marketingSettings"]
    if "aiBaseUrl" not in ms or not isinstance(ms.get("aiBaseUrl"), str):
        ms["aiBaseUrl"] = DEFAULT_DATA["marketingSettings"]["aiBaseUrl"]
    if "aiModel" not in ms or not isinstance(ms.get("aiModel"), str):
        ms["aiModel"] = DEFAULT_DATA["marketingSettings"]["aiModel"]
    if "aiApiKey" not in ms or not isinstance(ms.get("aiApiKey"), str):
        ms["aiApiKey"] = DEFAULT_DATA["marketingSettings"]["aiApiKey"]
    if "brandName" not in ms or not isinstance(ms.get("brandName"), str):
        ms["brandName"] = DEFAULT_DATA["marketingSettings"]["brandName"]
    if "systemPrompt" not in ms or not isinstance(ms.get("systemPrompt"), str):
        ms["systemPrompt"] = DEFAULT_DATA["marketingSettings"]["systemPrompt"]
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
    normalized_expenses: list[dict] = []
    for idx, raw_expense in enumerate(data.get("operationalExpenses", []) or [], start=1):
        if not isinstance(raw_expense, dict):
            continue
        normalized_expenses.append(_normalize_operational_expense(raw_expense, idx))
    data["operationalExpenses"] = sorted(
        normalized_expenses,
        key=lambda row: int(row.get("createdAt") or row.get("expenseAt") or 0),
        reverse=True,
    )
    next_expense_id = max([int(e.get("id") or 0) for e in data["operationalExpenses"]] + [0]) + 1
    data["exid"] = max(int(data.get("exid") or 1), next_expense_id)

    # Migrate old salePrice → salePrices
    for p in data["products"]:
        if "waTpl" not in p:
            p["waTpl"] = ""
        if "pricing" not in p:
            p["pricing"] = {}
        p["composition"] = _normalize_composition(p.get("composition", []))
        p["pricing"] = _normalize_product_pricing(p.get("pricing", {}), p.get("sizes", []))

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

    if "distributionChannels" not in data or not isinstance(data.get("distributionChannels"), list):
        data["distributionChannels"] = []
    seeded_channels = list(data.get("distributionChannels", []))
    seeded_channels.extend([b.get("distributorName", "") for b in data["distributorBatches"]])
    data["distributionChannels"] = _normalize_distribution_channels(seeded_channels)

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

    for c in data["customers"]:
        c["source"] = _normalize_customer_source(c.get("source"))
        if "importBatchId" not in c:
            c["importBatchId"] = ""
        if "notes" not in c:
            c["notes"] = ""
        c["phone"] = _normalize_customer_phone(c.get("phone"))

    normalized_users: list[dict] = []
    highest_uid = int(data.get("uid", 1) or 1)
    for idx, raw_user in enumerate(data.get("users", []) or [], start=1):
        if not isinstance(raw_user, dict):
            continue
        password_hash = str(raw_user.get("passwordHash") or "").strip()
        if not password_hash:
            continue
        merged = _normalize_user_record(
            {
                **raw_user,
                "id": int(raw_user.get("id") or idx),
                "createdAt": int(raw_user.get("createdAt") or int(time.time() * 1000)),
            },
            data,
            preserve_password_hash=password_hash,
        )
        highest_uid = max(highest_uid, int(merged["id"]) + 1)
        normalized_users.append(merged)
    data["users"] = normalized_users
    data["uid"] = max(highest_uid, int(data.get("uid", 1) or 1))
    _prune_expired_sessions(data)

    return data


def _normalize_commission_mode(raw: Any) -> str:
    return "batch" if str(raw or "").strip().lower() == "batch" else "per_pcs"


def _normalize_distribution_channels(values: Any) -> list[str]:
    if not isinstance(values, list):
        values = [values]
    out: list[str] = []
    seen: set[str] = set()
    for raw in values:
        name = re.sub(r"\s+", " ", str(raw or "")).strip()
        if not name:
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(name)
    return out


def _add_distribution_channel(data: dict, channel_name: Any) -> None:
    existing = list(data.get("distributionChannels", []))
    existing.append(channel_name)
    data["distributionChannels"] = _normalize_distribution_channels(existing)


def _normalize_customer_source(value: Any) -> str:
    raw = str(value or "").strip().lower()
    return "bulk_import" if raw in ("bulk_import", "bulk", "import") else "manual"


def _normalize_customer_phone(phone: Any) -> str:
    digits = re.sub(r"\D+", "", str(phone or ""))
    if digits.startswith("91") and len(digits) == 12:
        digits = digits[2:]
    return digits


def _build_customer(
    cid: int,
    name: str,
    phone: str,
    area: str,
    email: str = "",
    address: str = "",
    notes: str = "",
    at: Any = None,
    source: str = "manual",
    import_batch_id: str = "",
) -> dict:
    return {
        "id": cid,
        "name": str(name or "").strip(),
        "phone": _normalize_customer_phone(phone),
        "area": str(area or "").strip(),
        "email": str(email or "").strip(),
        "address": str(address or "").strip(),
        "notes": str(notes or "").strip(),
        "at": at,
        "source": _normalize_customer_source(source),
        "importBatchId": str(import_batch_id or "").strip(),
    }


def _extract_vcf_value(line: str) -> str:
    if ":" not in line:
        return ""
    return line.split(":", 1)[1].strip()


def _parse_vcf_contacts(vcf_text: str) -> list[dict]:
    contacts: list[dict] = []
    blocks = re.findall(r"BEGIN:VCARD(.*?)END:VCARD", vcf_text, flags=re.IGNORECASE | re.DOTALL)
    for block in blocks:
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        name = ""
        phone = ""
        email = ""
        address = ""
        area = ""
        for ln in lines:
            up = ln.upper()
            if up.startswith("FN"):
                name = _extract_vcf_value(ln)
            elif up.startswith("N:") and not name:
                raw = _extract_vcf_value(ln)
                parts = [p for p in raw.split(";") if p]
                if parts:
                    name = " ".join(parts[::-1]).strip()
            elif up.startswith("TEL") and not phone:
                phone = _extract_vcf_value(ln)
            elif up.startswith("EMAIL") and not email:
                email = _extract_vcf_value(ln)
            elif up.startswith("ADR") and not address:
                adr = _extract_vcf_value(ln)
                adr_parts = [p.strip() for p in adr.split(";") if p.strip()]
                address = ", ".join(adr_parts)
                if adr_parts:
                    area = adr_parts[1] if len(adr_parts) >= 2 else adr_parts[-1]
        if name and phone:
            contacts.append(
                {
                    "name": name.strip(),
                    "phone": _normalize_customer_phone(phone),
                    "area": area.strip(),
                    "email": email.strip(),
                    "address": address.strip(),
                }
            )
    return contacts


def _guess_row_value(row: dict, keys: list[str]) -> str:
    for k in keys:
        for rk, rv in row.items():
            norm = str(rk or "").strip().lower().replace("_", "").replace(" ", "")
            if norm == k:
                return str(rv or "").strip()
    return ""


def _parse_excel_contacts(file_bytes: bytes) -> list[dict]:
    try:
        import openpyxl  # type: ignore
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Excel import requires openpyxl: {exc}") from exc
    wb = openpyxl.load_workbook(BytesIO(file_bytes), data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return []
    headers = [str(h or "").strip() for h in rows[0]]
    contacts: list[dict] = []
    for vals in rows[1:]:
        row = {headers[i]: (vals[i] if i < len(vals) else "") for i in range(len(headers))}
        name = _guess_row_value(row, ["name", "customername", "fullname", "clientname"])
        phone = _guess_row_value(row, ["phone", "mobile", "phonenumber", "contact", "whatsapp", "whatsappnumber"])
        if not name or not phone:
            continue
        area = _guess_row_value(row, ["area", "locality", "city", "location", "place"])
        email = _guess_row_value(row, ["email", "mail", "emailid"])
        address = _guess_row_value(row, ["address", "fulladdress", "street"])
        contacts.append(
            {
                "name": name.strip(),
                "phone": _normalize_customer_phone(phone),
                "area": area.strip(),
                "email": email.strip(),
                "address": address.strip(),
            }
        )
    return contacts


def _parse_csv_contacts(file_bytes: bytes) -> list[dict]:
    text = file_bytes.decode("utf-8-sig", errors="ignore")
    rdr = csv.DictReader(text.splitlines())
    contacts: list[dict] = []
    for row in rdr:
        name = _guess_row_value(row, ["name", "customername", "fullname", "clientname"])
        phone = _guess_row_value(row, ["phone", "mobile", "phonenumber", "contact", "whatsapp", "whatsappnumber"])
        if not name or not phone:
            continue
        area = _guess_row_value(row, ["area", "locality", "city", "location", "place"])
        email = _guess_row_value(row, ["email", "mail", "emailid"])
        address = _guess_row_value(row, ["address", "fulladdress", "street"])
        contacts.append(
            {
                "name": name.strip(),
                "phone": _normalize_customer_phone(phone),
                "area": area.strip(),
                "email": email.strip(),
                "address": address.strip(),
            }
        )
    return contacts


def _client_safe_data(data: dict, request: Request | None = None, auth_source_data: dict | None = None) -> dict:
    """Return payload safe for frontend (avoid returning raw API key)."""
    safe = copy.deepcopy(data)
    ms = safe.get("marketingSettings")
    if isinstance(ms, dict):
        raw_key = str(ms.get("aiApiKey") or "").strip()
        ms["hasApiKey"] = bool(raw_key)
        ms["apiKeyPreview"] = ("*" * max(0, len(raw_key) - 4)) + raw_key[-4:] if raw_key else ""
        ms["aiApiKey"] = ""
    safe["uiPreferences"] = read_ui_preferences()
    if request is not None:
        safe["authContext"] = _auth_context_payload(auth_source_data or data, request)
    return safe


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


def _safe_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _order_is_completed(order: dict) -> bool:
    return str(order.get("status") or "").strip().lower() == "completed"


def _payment_gateway_commission_pct(data: dict) -> float:
    pct = _safe_float((data.get("shippingProfile") or {}).get("paymentGatewayCommissionPct"))
    return pct if pct >= 0 else 3.0


def _sale_price_for_order(products_by_id: dict, order: dict) -> float:
    product = products_by_id.get(order.get("prodId")) or {}
    pricing = product.get("pricing") or {}
    row = pricing.get(order.get("variant")) or {}
    sale_prices = row.get("salePrices") or {}
    channel = str(order.get("channel") or "retail")
    val = _safe_float(sale_prices.get(channel))
    if val > 0:
        return val
    return _safe_float(sale_prices.get("retail"))


def _total_cost_for_order(products_by_id: dict, order: dict) -> float:
    product = products_by_id.get(order.get("prodId")) or {}
    pricing = product.get("pricing") or {}
    row = pricing.get(order.get("variant")) or {}
    expenses = row.get("expenses") or []
    return sum(_safe_float(e.get("cost")) for e in expenses if isinstance(e, dict))


def _order_revenue(products_by_id: dict, order: dict) -> float:
    realized = _safe_float(order.get("realizedRevenue"))
    if realized >= 0:
        return realized
    unit = _sale_price_for_order(products_by_id, order)
    qty = _safe_float(order.get("qty")) or 1.0
    return unit * qty


def _order_profit(products_by_id: dict, order: dict, gateway_pct: float) -> float | None:
    unit = _sale_price_for_order(products_by_id, order)
    if unit <= 0:
        return None
    qty = _safe_float(order.get("qty")) or 1.0
    revenue = unit * qty
    gross = (unit - _total_cost_for_order(products_by_id, order)) * qty
    discount = _safe_float(order.get("discount"))
    manual_comm = _safe_float(order.get("commission"))
    gateway_comm = 0.0
    if str(order.get("channel") or "").strip().lower() == "website":
        gateway_comm = revenue * (gateway_pct / 100.0)
    return gross - discount - manual_comm - gateway_comm


def _month_range(now_ts: float, month_offset: int = 0) -> tuple[float, float]:
    now = time.localtime(now_ts)
    year = now.tm_year
    month = now.tm_mon + month_offset
    while month <= 0:
        year -= 1
        month += 12
    while month > 12:
        year += 1
        month -= 12
    start = time.mktime((year, month, 1, 0, 0, 0, 0, 0, -1))
    if month == 12:
        next_start = time.mktime((year + 1, 1, 1, 0, 0, 0, 0, 0, -1))
    else:
        next_start = time.mktime((year, month + 1, 1, 0, 0, 0, 0, 0, -1))
    return start * 1000.0, next_start * 1000.0


def _compute_dashboard_metrics(data: dict) -> dict:
    orders = data.get("orders", []) or []
    customers = data.get("customers", []) or []
    products_by_id = {p.get("id"): p for p in (data.get("products", []) or []) if isinstance(p, dict)}
    gateway_pct = _payment_gateway_commission_pct(data)
    now_ms = time.time() * 1000.0
    day_start = time.mktime(time.localtime()[:3] + (0, 0, 0, 0, 0, -1)) * 1000.0
    cm_s, cm_e = _month_range(time.time(), 0)
    pm_s, pm_e = _month_range(time.time(), -1)

    def rev_sum(seq: list[dict]) -> float:
        return sum(_order_revenue(products_by_id, o) for o in seq if _order_is_completed(o))

    def profit_sum(seq: list[dict]) -> float:
        total = 0.0
        for o in seq:
            if not _order_is_completed(o):
                continue
            p = _order_profit(products_by_id, o, gateway_pct)
            total += p if p is not None else 0.0
        return total

    cur_month = [o for o in orders if cm_s <= _safe_float(o.get("at")) < cm_e]
    prev_month = [o for o in orders if pm_s <= _safe_float(o.get("at")) < pm_e]
    completed_orders = [o for o in orders if _order_is_completed(o)]

    rev_all = rev_sum(orders)
    rev_m = rev_sum(cur_month)
    rev_pm = rev_sum(prev_month)
    prof_all = profit_sum(orders)
    prof_m = profit_sum(cur_month)
    mom = ((rev_m - rev_pm) / rev_pm * 100.0) if rev_pm > 0 else None

    active_count = sum(
        1
        for o in orders
        if (not _order_is_completed(o)) and str(o.get("status") or "") not in ("cancelled", "returned")
    )
    completed_today = sum(1 for o in completed_orders if _safe_float(o.get("at")) >= day_start)
    total_customers = len(customers)
    total_orders = len(orders)
    completed_count = len(completed_orders)
    orders_per_customer = (total_orders / total_customers) if total_customers > 0 else 0.0
    counts_by_customer: dict[int, int] = {}
    for o in orders:
        cid = int(_safe_float(o.get("cid")))
        if cid > 0:
            counts_by_customer[cid] = counts_by_customer.get(cid, 0) + 1
    ordered_customers = len(counts_by_customer)
    repeat_customers = sum(1 for n in counts_by_customer.values() if n >= 2)
    retention_pct = (repeat_customers / ordered_customers * 100.0) if ordered_customers > 0 else None

    return {
        "revAll": rev_all,
        "profAll": prof_all,
        "revM": rev_m,
        "profM": prof_m,
        "activeCount": active_count,
        "completedToday": completed_today,
        "mom": mom,
        "yoy": None,
        "totalCustomers": total_customers,
        "totalOrders": total_orders,
        "completedOrders": completed_count,
        "ordersPerCustomer": orders_per_customer,
        "retentionPct": retention_pct,
        "generatedAt": int(now_ms),
    }


def _get_cached_dashboard_metrics(data: dict, ttl_seconds: int = 60) -> dict:
    now = time.time()
    with DASHBOARD_CACHE_LOCK:
        if DASHBOARD_METRICS_CACHE["payload"] is not None and now < float(DASHBOARD_METRICS_CACHE["expires_at"]):
            return copy.deepcopy(DASHBOARD_METRICS_CACHE["payload"])
    metrics = _compute_dashboard_metrics(data)
    with DASHBOARD_CACHE_LOCK:
        DASHBOARD_METRICS_CACHE["payload"] = metrics
        DASHBOARD_METRICS_CACHE["expires_at"] = now + max(1, ttl_seconds)
    return copy.deepcopy(metrics)


def _digits_only(value: str) -> str:
    return re.sub(r"\D+", "", str(value or ""))


def _to_whatsapp_phone(phone: str) -> str:
    digits = _digits_only(phone)
    if digits.startswith("91") and len(digits) >= 12:
        return digits
    if len(digits) == 10:
        return "91" + digits
    return digits


def _order_summary_line(order: dict) -> str:
    when = time.strftime("%d %b %Y", time.localtime((int(order.get("at") or 0)) / 1000)) if order.get("at") else "-"
    prod = str(order.get("prod") or "").strip() or "-"
    var = str(order.get("variant") or "").strip() or "-"
    qty = int(order.get("qty") or 0)
    status = str(order.get("status") or "").strip() or "-"
    return f"{when}: {prod} ({var}) x{qty}, status={status}"


def _build_customer_context(data: dict, customer: dict) -> str:
    cid = customer.get("id")
    orders = [o for o in data.get("orders", []) if o.get("cid") == cid]
    orders_sorted = sorted(orders, key=lambda x: int(x.get("at") or 0), reverse=True)
    last = orders_sorted[0] if orders_sorted else {}
    recent_lines = [_order_summary_line(o) for o in orders_sorted[:5]]
    lines = [
        f"Customer Name: {str(customer.get('name') or '').strip() or '-'}",
        f"Phone: {str(customer.get('phone') or '').strip() or '-'}",
        f"Area: {str(customer.get('area') or '').strip() or '-'}",
        f"Email: {str(customer.get('email') or '').strip() or '-'}",
        f"Address: {str(customer.get('address') or '').strip() or '-'}",
        f"Total Orders: {len(orders_sorted)}",
        f"Last Ordered Product: {str(last.get('prod') or '-').strip() or '-'}",
        f"Last Ordered Variant: {str(last.get('variant') or '-').strip() or '-'}",
        f"Last Order Date: {time.strftime('%d %b %Y', time.localtime((int(last.get('at') or 0)) / 1000)) if last else '-'}",
        "Recent Orders:",
    ]
    if recent_lines:
        lines.extend([f"- {ln}" for ln in recent_lines])
    else:
        lines.append("- No orders yet")
    return "\n".join(lines)


def _extract_message_text(payload: dict) -> str:
    """Extract assistant text from OpenAI-compatible responses."""
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        msg = choices[0].get("message") if isinstance(choices[0], dict) else None
        if isinstance(msg, dict):
            content = msg.get("content")
            if isinstance(content, str):
                return content.strip()
            if isinstance(content, list):
                parts: list[str] = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        parts.append(str(block.get("text") or ""))
                return "\n".join([p for p in parts if p]).strip()
    return ""


def _is_private_or_local_host(hostname: str) -> bool:
    host = str(hostname or "").strip().lower()
    if not host:
        return True
    if host in ("localhost",):
        return True

    def _ip_is_private(raw_ip: str) -> bool:
        try:
            ip = ipaddress.ip_address(raw_ip)
            return (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_multicast
                or ip.is_reserved
                or ip.is_unspecified
            )
        except ValueError:
            return False

    if _ip_is_private(host):
        return True

    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        # If hostname cannot be resolved now, do not block by default.
        return False
    for info in infos:
        ip = info[4][0] if info and len(info) >= 5 and info[4] else ""
        if ip and _ip_is_private(ip):
            return True
    return False


def _sanitize_ai_base_url(raw_value: Any) -> str:
    raw = str(raw_value or "").strip() or DEFAULT_DATA["marketingSettings"]["aiBaseUrl"]
    parsed = urlparse.urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="AI Base URL must be a valid http(s) URL.")
    if not ALLOW_PRIVATE_AI_BASE_URL and _is_private_or_local_host(parsed.hostname or ""):
        raise HTTPException(
            status_code=400,
            detail="AI Base URL cannot target localhost/private network hosts.",
        )
    clean = f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/")
    if not clean.endswith("/v1"):
        clean = clean + "/v1"
    return clean


def _ai_chat_draft(base_url: str, api_key: str, model: str, system_prompt: str, user_prompt: str) -> str:
    endpoint = _sanitize_ai_base_url(base_url).rstrip("/") + "/chat/completions"
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.7,
    }
    req = urlrequest.Request(
        endpoint,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=45) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urlerror.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        print(f"[CRM] AI provider HTTP error {exc.code}: {detail[:400]}")
        raise HTTPException(
            status_code=502,
            detail=f"AI provider request failed with HTTP {exc.code}. Verify model, API key, and prompt.",
        ) from exc
    except urlerror.URLError as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach AI provider: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"AI draft failed: {exc}") from exc
    text = _extract_message_text(payload)
    if not text:
        raise HTTPException(status_code=502, detail="AI provider returned an empty response.")
    return text


def _template_token_issues(template: str) -> list[str]:
    txt = str(template or "")
    issues: list[str] = []
    # order_count is count of orders, never weight/pack quantity.
    if re.search(r"\{\{\s*order_count\s*\}\}\s*(kg|g|grams?|packs?)", txt, flags=re.IGNORECASE):
        issues.append("{{order_count}} used with weight/pack unit")
    if re.search(r"(kg|g|grams?|packs?)\s*\{\{\s*order_count\s*\}\}", txt, flags=re.IGNORECASE):
        issues.append("weight/pack unit used with {{order_count}}")
    # last_order_date is historical date, never validity date.
    if re.search(r"(valid|validity|expires?|expiry|until)\b[^\n]*\{\{\s*last_order_date\s*\}\}", txt, flags=re.IGNORECASE):
        issues.append("{{last_order_date}} used as validity/expiry")
    return issues


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
    # Support generic variant units, not just hard-coded pack sizes.
    # For volume (ml/l), we use a 1:1 approximation to grams for inventory deduction.
    m = re.match(r"^\s*([0-9]*\.?[0-9]+)\s*(kg|g|l|ml)\s*$", v)
    if m:
        try:
            qty = float(m.group(1))
        except ValueError:
            return 0.0
        unit = m.group(2)
        if qty <= 0:
            return 0.0
        if unit == "kg":
            return qty * 1000.0
        if unit == "g":
            return qty
        if unit == "l":
            return qty * 1000.0
        if unit == "ml":
            return qty
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
@asynccontextmanager
async def lifespan(_: FastAPI):
    _init_storage()
    yield


app = FastAPI(title="Kudagu Kaapi CRM", docs_url=None, redoc_url=None, lifespan=lifespan)

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


@app.get("/api/auth/status")
async def auth_status(request: Request):
    data = read_data()
    return {
        "auth": _auth_context_payload(data, request),
        "featureConfig": {
            "usernamePasswordAuthEnabled": _auth_enabled(),
            "roleBasedAccessEnabled": _rbac_enabled(),
        },
    }


@app.post("/api/auth/setup")
async def auth_setup(request: Request):
    if not _auth_enabled():
        raise HTTPException(status_code=400, detail="Authentication is disabled in app_config.py.")
    body = await request.json()
    username = _normalize_username(body.get("username"))
    password = str(body.get("password") or "")
    display_name = str(body.get("displayName") or username).strip() or username
    if len(username) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters.")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    data = read_data()
    if any(str(u.get("role") or "admin") == "admin" for u in data.get("users", [])):
        raise HTTPException(status_code=400, detail="Initial setup is already complete.")
    user = _normalize_user_record(
        {"id": data.get("uid", 1), "username": username, "displayName": display_name, "role": "admin"},
        data,
        preserve_password_hash=_password_hash(password),
    )
    data["users"].append(user)
    data["uid"] = int(data.get("uid", 1) or 1) + 1
    token = _create_session(data, user["id"])
    write_data(data)
    response = JSONResponse(
        {
            "ok": True,
            "auth": {
                "enabled": True,
                "roleModelEnabled": _rbac_enabled(),
                "setupRequired": False,
                "authenticated": True,
                "user": _auth_user_payload(user),
            },
        }
    )
    _set_auth_cookie(response, token)
    return response


@app.post("/api/auth/login")
async def auth_login(request: Request):
    if not _auth_enabled():
        raise HTTPException(status_code=400, detail="Authentication is disabled in app_config.py.")
    body = await request.json()
    username = _normalize_username(body.get("username"))
    password = str(body.get("password") or "")
    data = read_data()
    if not data.get("users"):
        raise HTTPException(status_code=403, detail="Initial setup is required before sign in.")
    user = _find_user_by_username(data, username)
    if not user or not _verify_password(password, str(user.get("passwordHash") or "")):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    token = _create_session(data, int(user["id"]))
    write_data(data)
    response = JSONResponse(
        {
            "ok": True,
            "auth": {
                "enabled": True,
                "roleModelEnabled": _rbac_enabled(),
                "setupRequired": False,
                "authenticated": True,
                "user": _auth_user_payload(user),
            },
        }
    )
    _set_auth_cookie(response, token)
    return response


@app.post("/api/auth/logout")
async def auth_logout(request: Request):
    data = read_data()
    token = request.cookies.get(AUTH_COOKIE_NAME) or ""
    if token:
        _delete_session(data, token)
        write_data(data)
    response = JSONResponse({"ok": True})
    _clear_auth_cookie(response)
    return response


@app.get("/api/users")
async def list_users(request: Request):
    data = read_data()
    _require_admin(request, data)
    users = []
    for user in data.get("users", []):
        payload = _auth_user_payload(user) or {}
        payload["createdAt"] = int(user.get("createdAt") or 0)
        payload["updatedAt"] = int(user.get("updatedAt") or 0)
        users.append(payload)
    return {"users": users}


@app.post("/api/users")
async def create_user(request: Request):
    data = read_data()
    _require_admin(request, data)
    body = await request.json()
    password = str(body.get("password") or "")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    if _find_user_by_username(data, body.get("username")):
        raise HTTPException(status_code=400, detail="Username already exists.")
    record = _normalize_user_record(
        {"id": data.get("uid", 1), **body},
        data,
        preserve_password_hash=_password_hash(password),
    )
    data["users"].append(record)
    data["uid"] = int(data.get("uid", 1) or 1) + 1
    write_data(data)
    return _auth_user_payload(record)


@app.put("/api/users/{user_id}")
async def update_user(user_id: int, request: Request):
    data = read_data()
    _require_admin(request, data)
    user = _find_user_by_id(data, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    body = await request.json()
    if "username" in body:
        existing = _find_user_by_username(data, body.get("username"))
        if existing and int(existing.get("id", 0)) != user_id:
            raise HTTPException(status_code=400, detail="Username already exists.")
    replacement = _normalize_user_record(
        {**user, **body, "id": user_id, "createdAt": user.get("createdAt")},
        data,
        preserve_password_hash=str(user.get("passwordHash") or ""),
    )
    if int(user_id) == int(((_build_auth_context(data, request).get("user") or {}).get("id") or 0)) and replacement["role"] != "admin":
        raise HTTPException(status_code=400, detail="You cannot remove your own admin role.")
    idx = next(i for i, row in enumerate(data["users"]) if int(row.get("id", 0)) == user_id)
    data["users"][idx] = replacement
    write_data(data)
    return _auth_user_payload(replacement)


@app.post("/api/users/{user_id}/password")
async def change_user_password(user_id: int, request: Request):
    data = read_data()
    _require_admin(request, data)
    user = _find_user_by_id(data, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    body = await request.json()
    password = str(body.get("password") or "")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    user["passwordHash"] = _password_hash(password)
    user["updatedAt"] = int(time.time() * 1000)
    write_data(data)
    return {"ok": True}


@app.delete("/api/users/{user_id}")
async def delete_user(user_id: int, request: Request):
    data = read_data()
    ctx = _require_admin(request, data)
    current_user = ctx.get("user") or {}
    if int(current_user.get("id", 0)) == user_id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")
    before = len(data.get("users", []))
    data["users"] = [u for u in data.get("users", []) if int(u.get("id", 0)) != user_id]
    if len(data["users"]) == before:
        raise HTTPException(status_code=404, detail="User not found.")
    data["authSessions"] = [s for s in data.get("authSessions", []) if int(s.get("userId", 0)) != user_id]
    write_data(data)
    return {"ok": True}


# ── Data — full read/write ─────────────────────────────────────────────────
@app.get("/api/data")
async def get_data(request: Request):
    """Return the full persisted app data."""
    data = read_data()
    ctx = _require_signed_in(request, data)
    filtered = _filtered_data_for_user(data, ctx.get("user"))
    return JSONResponse(content=_client_safe_data(filtered, request, auth_source_data=data))


@app.get("/api/bootstrap")
async def get_bootstrap(request: Request):
    """
    Return a lightweight bootstrap payload for faster first paint.
    Full data should be loaded by calling /api/data after initial render.
    """
    data = read_data()
    ctx = _require_signed_in(request, data)
    filtered = _filtered_data_for_user(data, ctx.get("user"))
    bootstrap_state = {
        "customers": [],
        "orders": [],
        "distributorBatches": [],
        "closedFollowUps": [],
        "operationalExpenses": filtered.get("operationalExpenses", []),
        "products": filtered.get("products", []),
        "distributionChannels": filtered.get("distributionChannels", []),
        "cid": filtered.get("cid", 1),
        "oid": filtered.get("oid", 1),
        "dbid": filtered.get("dbid", 1),
        "exid": filtered.get("exid", 1),
        "pid": filtered.get("pid", 1),
        "waDefaultTpl": filtered.get("waDefaultTpl", DEFAULT_DATA["waDefaultTpl"]),
        "shippingProfile": filtered.get("shippingProfile", copy.deepcopy(DEFAULT_DATA["shippingProfile"])),
        "marketingSettings": filtered.get("marketingSettings", copy.deepcopy(DEFAULT_DATA["marketingSettings"])),
        "uiPreferences": read_ui_preferences(),
    }
    metrics_source = _filtered_data_for_user(data, ctx.get("user"))
    return JSONResponse(
        {
            "state": _client_safe_data(bootstrap_state, request, auth_source_data=data),
            "dashboardMetrics": _sanitize_dashboard_metrics_for_user(
                _compute_dashboard_metrics(metrics_source),
                ctx.get("user"),
            ),
            "featureConfig": {
                "usernamePasswordAuthEnabled": _auth_enabled(),
                "roleBasedAccessEnabled": _rbac_enabled(),
            },
        }
    )


@app.put("/api/data")
async def put_data(request: Request):
    """Replace the entire persisted app data with the request body.
    Used by the frontend for bulk save (e.g. after settings changes)."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    data = read_data()
    _require_admin(request, data)
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
    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "customers")
    _ensure_action_access(ctx.get("user"), "customers", "create")
    customer = _build_customer(
        cid=data["cid"],
        name=body["name"],
        phone=body["phone"],
        area=body["area"],
        email=body.get("email", ""),
        address=body.get("address", ""),
        notes=body.get("notes", ""),
        at=body.get("at"),
        source=body.get("source", "manual"),
        import_batch_id=body.get("importBatchId", ""),
    )
    data["customers"].append(customer)
    data["cid"] += 1
    write_data(data)
    return customer


@app.put("/api/customers/{customer_id}")
async def update_customer(customer_id: int, request: Request):
    """Update an existing customer's details."""
    body = await request.json()
    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "customers")
    _ensure_action_access(ctx.get("user"), "customers", "edit")
    idx = next((i for i, c in enumerate(data["customers"]) if c["id"] == customer_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    _ensure_customer_scope(ctx.get("user"), data, customer_id)
    for key in ("name", "phone", "area", "email", "address", "notes"):
        if key in body:
            if key == "phone":
                data["customers"][idx][key] = _normalize_customer_phone(body[key])
            else:
                data["customers"][idx][key] = body[key]
    # Also update denormalised customer fields on all their orders
    if "name" in body or "phone" in body or "area" in body:
        for o in data["orders"]:
            if o["cid"] == customer_id:
                if "name"  in body: o["cname"]  = body["name"]
                if "phone" in body: o["cphone"] = _normalize_customer_phone(body["phone"])
                if "area"  in body: o["carea"]  = body["area"]
    write_data(data)
    return data["customers"][idx]


@app.post("/api/customers/import")
async def import_customers(request: Request):
    body = await request.json()
    fmt = str(body.get("format") or "").strip().lower()
    b64 = str(body.get("contentBase64") or "").strip()
    filename = str(body.get("filename") or "").strip()
    if not fmt or not b64:
        raise HTTPException(status_code=400, detail="format and contentBase64 are required")

    try:
        file_bytes = base64.b64decode(b64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 file content")
    if len(file_bytes) > MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Import file too large. Max allowed is {MAX_IMPORT_BYTES // (1024 * 1024)} MB.",
        )

    if fmt == "vcf":
        contacts = _parse_vcf_contacts(file_bytes.decode("utf-8", errors="ignore"))
    elif fmt in ("xlsx", "xlsm"):
        contacts = _parse_excel_contacts(file_bytes)
    elif fmt == "csv":
        contacts = _parse_csv_contacts(file_bytes)
    else:
        raise HTTPException(status_code=400, detail="Unsupported import format. Use .vcf, .xlsx, .xlsm, or .csv")

    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "customers")
    _ensure_action_access(ctx.get("user"), "customers", "create")
    existing_phone_set = {_normalize_customer_phone(c.get("phone")) for c in data.get("customers", [])}
    import_batch_id = f"imp-{int(time.time() * 1000)}"
    created: list[dict] = []
    skipped = 0
    for row in contacts:
        name = str(row.get("name") or "").strip()
        phone = _normalize_customer_phone(row.get("phone"))
        area = str(row.get("area") or "").strip() or "Unknown"
        if not name or not phone:
            skipped += 1
            continue
        if phone in existing_phone_set:
            skipped += 1
            continue
        customer = _build_customer(
            cid=data["cid"],
            name=name,
            phone=phone,
            area=area,
            email=row.get("email", ""),
            address=row.get("address", ""),
            at=int(time.time() * 1000),
            source="bulk_import",
            import_batch_id=import_batch_id,
        )
        data["customers"].append(customer)
        created.append(customer)
        existing_phone_set.add(phone)
        data["cid"] += 1

    write_data(data)
    return {
        "ok": True,
        "filename": filename,
        "importBatchId": import_batch_id,
        "totalParsed": len(contacts),
        "imported": len(created),
        "skipped": skipped,
        "customers": created,
    }


@app.delete("/api/customers/{customer_id}")
async def delete_customer(customer_id: int, request: Request):
    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "customers")
    _ensure_action_access(ctx.get("user"), "customers", "delete")
    _ensure_customer_scope(ctx.get("user"), data, customer_id)
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
    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "sales")
    _ensure_action_access(ctx.get("user"), "orders", "create")
    _ensure_product_scope(ctx.get("user"), data, body.get("prodId"))
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
    return _filtered_order_response(data, ctx.get("user"), order["id"])


@app.put("/api/orders/{order_id}")
async def update_order(order_id: int, request: Request):
    """Update mutable fields on an order: status, discount, commission."""
    body = await request.json()
    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "orders")
    _ensure_action_access(ctx.get("user"), "orders", "edit")
    idx = next((i for i, o in enumerate(data["orders"]) if o["id"] == order_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Order not found")
    _ensure_product_scope(ctx.get("user"), data, data["orders"][idx].get("prodId"))
    if "prodId" in body:
        _ensure_product_scope(ctx.get("user"), data, body.get("prodId"))
    prev = copy.deepcopy(data["orders"][idx])
    for key in ("status", "discount", "commission", "paymentMethod", "qty", "variant", "prodId", "prod", "channel", "at", "cid", "cname", "cphone", "carea", "shipping", "realizedRevenue", "distribution"):
        if key in body:
            data["orders"][idx][key] = body[key]
    _reconcile_order_inventory(data, idx, prev_order=prev)
    write_data(data)
    return _filtered_order_response(data, ctx.get("user"), order_id)


@app.post("/api/distribution/batches")
async def add_distribution_batch(request: Request):
    body = await request.json()
    required = ("distributorName", "prodId", "variant", "qty")
    if not all(k in body for k in required):
        raise HTTPException(status_code=400, detail=f"Required fields: {required}")

    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "distribution")
    _ensure_action_access(ctx.get("user"), "distribution", "create")
    _ensure_product_scope(ctx.get("user"), data, body.get("prodId"))
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

    _add_distribution_channel(data, batch["distributorName"])
    data["distributorBatches"].insert(0, batch)
    data["dbid"] += 1
    write_data(data)
    return batch


@app.put("/api/distribution/batches/{batch_id}")
async def update_distribution_batch(batch_id: int, request: Request):
    body = await request.json()
    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "distribution")
    _ensure_action_access(ctx.get("user"), "distribution", "edit")
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

    _add_distribution_channel(data, batch.get("distributorName", ""))
    write_data(data)
    return batch


def _delete_distribution_batch_from_data(data: dict, batch_id: int) -> dict:
    idx = next((i for i, b in enumerate(data["distributorBatches"]) if int(b.get("id", 0)) == batch_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Batch not found")

    batch = data["distributorBatches"][idx]
    _ensure_product_scope(ctx.get("user"), data, batch.get("prodId"))
    if "prodId" in body:
        _ensure_product_scope(ctx.get("user"), data, body.get("prodId"))
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
async def delete_distribution_batch(batch_id: int, request: Request):
    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "distribution")
    _ensure_action_access(ctx.get("user"), "distribution", "delete")
    batch = next((b for b in data["distributorBatches"] if int(b.get("id", 0)) == batch_id), None)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    _ensure_product_scope(ctx.get("user"), data, batch.get("prodId"))
    res = _delete_distribution_batch_from_data(data, batch_id)
    write_data(data)
    return res


@app.post("/api/distribution/batches/{batch_id}/delete")
async def delete_distribution_batch_via_post(batch_id: int, request: Request):
    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "distribution")
    _ensure_action_access(ctx.get("user"), "distribution", "delete")
    batch = next((b for b in data["distributorBatches"] if int(b.get("id", 0)) == batch_id), None)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    _ensure_product_scope(ctx.get("user"), data, batch.get("prodId"))
    res = _delete_distribution_batch_from_data(data, batch_id)
    write_data(data)
    return res


@app.post("/api/distribution/batches/{batch_id}/complete")
async def complete_distribution_batch(batch_id: int, request: Request):
    body = await request.json()
    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "distribution")
    _ensure_action_access(ctx.get("user"), "distribution", "complete")
    idx = next((i for i, b in enumerate(data["distributorBatches"]) if int(b.get("id", 0)) == batch_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    batch = data["distributorBatches"][idx]
    _ensure_product_scope(ctx.get("user"), data, batch.get("prodId"))
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
    return {"batch": batch, "order": _filtered_order_response(data, ctx.get("user"), order["id"])}


@app.post("/api/operational-expenses")
async def add_operational_expense(request: Request):
    body = await request.json()
    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "expenses")
    _ensure_action_access(ctx.get("user"), "expenses", "create")
    title = str(body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Expense title is required")
    try:
        amount = round(float(body.get("amount") or 0), 2)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Valid expense amount is required")
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Expense amount must be greater than zero")
    try:
        expense_at = int(body.get("expenseAt") or body.get("at") or int(time.time() * 1000))
    except (TypeError, ValueError):
        expense_at = int(time.time() * 1000)
    record = _normalize_operational_expense(
        {
            "id": data.get("exid", 1),
            "title": title,
            "category": body.get("category", ""),
            "amount": amount,
            "expenseAt": expense_at,
            "notes": body.get("notes", ""),
            "createdAt": int(time.time() * 1000),
            "createdBy": _expense_creator_payload(ctx.get("user")),
        },
        int(data.get("exid") or 1),
    )
    data.setdefault("operationalExpenses", []).insert(0, record)
    data["exid"] = int(data.get("exid") or 1) + 1
    write_data(data)
    return record


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

    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "alerts")
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
async def shipping_label_pdf(order_id: int, request: Request):
    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_action_access(ctx.get("user"), "shipping", "labels")
    order = next((o for o in data["orders"] if o.get("id") == order_id), None)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    _ensure_product_scope(ctx.get("user"), data, order.get("prodId"))

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
async def sync_completed_orders(request: Request):
    """
    Reconcile inventory usage from completed CRM orders.
    Safe to run repeatedly; removes prior CRM-linked movements per order
    and re-applies from current order values (date/qty/variant/product).
    """
    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_action_access(ctx.get("user"), "inventory", "sync")
    if not SYNC_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Inventory sync already in progress")
    try:
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
async def inventory_stock(request: Request):
    data = read_data()
    ctx = _require_signed_in(request, data)
    stock = _get_inventory_stock()
    if stock is None:
        raise HTTPException(status_code=502, detail="Inventory service unavailable")
    allowed_inventory_ids = _allowed_inventory_product_ids_for_user(ctx.get("user"), data)
    if allowed_inventory_ids is not None:
        stock = [item for item in stock if str(item.get("id") or "") in allowed_inventory_ids]
    return stock


@app.delete("/api/orders/{order_id}")
async def delete_order(order_id: int, request: Request):
    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "orders")
    _ensure_action_access(ctx.get("user"), "orders", "delete")
    order = next((o for o in data["orders"] if o["id"] == order_id), None)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    _ensure_product_scope(ctx.get("user"), data, order.get("prodId"))
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
        raise HTTPException(status_code=400, detail="At least one variant required")
    data = read_data()
    ctx = _require_admin(request, data)
    _ensure_page_access(ctx.get("user"), "settings")
    _ensure_action_access(ctx.get("user"), "products", "create")
    product = {
        "id":      "p" + str(data["pid"]),
        "name":    body["name"],
        "sizes":   body["sizes"],
        "waTpl":   body.get("waTpl", ""),
        "pricing": _normalize_product_pricing(body.get("pricing", {}), body.get("sizes", [])),
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
    data = read_data()
    ctx = _require_admin(request, data)
    _ensure_page_access(ctx.get("user"), "settings")
    _ensure_action_access(ctx.get("user"), "products", "edit")
    idx = next((i for i, p in enumerate(data["products"]) if p["id"] == product_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Product not found")
    # Merge — only update provided keys
    for key in ("name", "sizes", "waTpl"):
        if key in body:
            data["products"][idx][key] = body[key]
    if "pricing" in body or "sizes" in body:
        data["products"][idx]["pricing"] = _normalize_product_pricing(
            body.get("pricing", data["products"][idx].get("pricing", {})),
            data["products"][idx].get("sizes", []),
        )
    if "composition" in body:
        data["products"][idx]["composition"] = _normalize_composition(body.get("composition", []))
    write_data(data)
    return data["products"][idx]


@app.delete("/api/products/{product_id}")
async def delete_product(product_id: str, request: Request):
    data = read_data()
    ctx = _require_admin(request, data)
    _ensure_page_access(ctx.get("user"), "settings")
    _ensure_action_access(ctx.get("user"), "products", "delete")
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
    data = read_data()
    ctx = _require_admin(request, data)
    _ensure_page_access(ctx.get("user"), "settings")
    _ensure_action_access(ctx.get("user"), "settings", "manage")
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
    if "marketingSettings" in body and isinstance(body["marketingSettings"], dict):
        curr = copy.deepcopy(data.get("marketingSettings", {}))
        incoming = body["marketingSettings"]
        if "aiBaseUrl" in incoming:
            curr["aiBaseUrl"] = _sanitize_ai_base_url(incoming.get("aiBaseUrl"))
        if "aiModel" in incoming:
            curr["aiModel"] = str(incoming.get("aiModel") or "").strip()
        if "brandName" in incoming:
            curr["brandName"] = str(incoming.get("brandName") or "").strip()
        if "systemPrompt" in incoming:
            curr["systemPrompt"] = str(incoming.get("systemPrompt") or "").strip()
        if incoming.get("clearApiKey") is True:
            curr["aiApiKey"] = ""
        elif "aiApiKey" in incoming:
            new_key = str(incoming.get("aiApiKey") or "").strip()
            if new_key:
                curr["aiApiKey"] = new_key
        data["marketingSettings"] = curr
    write_data(data)
    prefs = None
    if "uiPreferences" in body and isinstance(body["uiPreferences"], dict):
        prefs = write_ui_preferences(body["uiPreferences"])
    return {"ok": True, "uiPreferences": prefs or read_ui_preferences()}


@app.post("/api/marketing/draft")
async def generate_marketing_draft(request: Request):
    body = await request.json()
    try:
        customer_id = int(body.get("customerId") or 0)
    except (TypeError, ValueError):
        customer_id = 0
    if customer_id <= 0:
        raise HTTPException(status_code=400, detail="customerId is required")

    campaign_brief = str(body.get("campaignBrief") or "").strip()
    extra_instruction = str(body.get("extraInstruction") or "").strip()

    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "marketing")
    _ensure_action_access(ctx.get("user"), "marketing", "generate")
    _ensure_customer_scope(ctx.get("user"), data, customer_id)
    customer = next((c for c in data.get("customers", []) if int(c.get("id") or 0) == customer_id), None)
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")

    ms = data.get("marketingSettings", {})
    base_url = _sanitize_ai_base_url(ms.get("aiBaseUrl"))
    model = str(ms.get("aiModel") or "").strip()
    api_key = str(ms.get("aiApiKey") or "").strip()
    system_prompt = str(ms.get("systemPrompt") or "").strip() or DEFAULT_DATA["marketingSettings"]["systemPrompt"]
    if not model:
        raise HTTPException(status_code=400, detail="Set AI model in Settings → Marketing AI first.")
    if not api_key:
        raise HTTPException(status_code=400, detail="Set AI API key in Settings → Marketing AI first.")

    customer_context = _build_customer_context(data, customer)
    prompt_lines = [
        "Draft one personalized WhatsApp marketing message for this customer.",
        "Keep it under 90 words, plain text, and friendly.",
        "Do not use markdown.",
        "",
        "Campaign Brief:",
        campaign_brief or "General re-engagement campaign for coffee reorder.",
        "",
    ]
    if extra_instruction:
        prompt_lines.extend(["Extra Instruction:", extra_instruction, ""])
    prompt_lines.extend(["Customer Context:", customer_context])
    user_prompt = "\n".join(prompt_lines)

    draft = _ai_chat_draft(
        base_url=base_url,
        api_key=api_key,
        model=model,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
    )
    phone = _to_whatsapp_phone(str(customer.get("phone") or ""))
    if not phone:
        raise HTTPException(status_code=400, detail="Customer phone is missing/invalid.")
    wa_url = f"https://wa.me/{phone}?text={urlparse.quote(draft)}"
    return {
        "draft": draft,
        "waUrl": wa_url,
        "customerId": customer_id,
        "customerName": customer.get("name", ""),
    }


@app.post("/api/marketing/template")
async def generate_marketing_template(request: Request):
    body = await request.json()
    campaign_brief = str(body.get("campaignBrief") or "").strip()
    extra_instruction = str(body.get("extraInstruction") or "").strip()
    group_summary = str(body.get("groupSummary") or "").strip()
    allowed_tokens = body.get("allowedTokens") or []
    if not isinstance(allowed_tokens, list):
        allowed_tokens = []
    allowed_tokens = [str(t).strip() for t in allowed_tokens if str(t).strip()]
    if not allowed_tokens:
        allowed_tokens = [
            "{{brand_name}}",
            "{{customer_name}}",
            "{{area}}",
            "{{order_count}}",
            "{{avg_order_value}}",
            "{{last_order_date}}",
            "{{last_product_name}}",
            "{{last_variant}}",
            "{{preferred_channel}}",
        ]

    data = read_data()
    ctx = _require_signed_in(request, data)
    _ensure_page_access(ctx.get("user"), "marketing")
    _ensure_action_access(ctx.get("user"), "marketing", "generate")
    ms = data.get("marketingSettings", {})
    base_url = _sanitize_ai_base_url(ms.get("aiBaseUrl"))
    model = str(ms.get("aiModel") or "").strip()
    api_key = str(ms.get("aiApiKey") or "").strip()
    system_prompt = str(ms.get("systemPrompt") or "").strip() or DEFAULT_DATA["marketingSettings"]["systemPrompt"]
    if not model:
        raise HTTPException(status_code=400, detail="Set AI model in Settings → Marketing AI first.")
    if not api_key:
        raise HTTPException(status_code=400, detail="Set AI API key in Settings → Marketing AI first.")

    token_line = " ".join(allowed_tokens)
    token_meanings = {
        "{{brand_name}}": "Your brand/business name from settings. Use when message signs off or references brand.",
        "{{customer_name}}": "Customer full name. Use for greeting/personal tone.",
        "{{area}}": "Customer locality/area.",
        "{{order_count}}": "Total number of past orders (integer).",
        "{{avg_order_value}}": "Average order value already formatted currency text (example: ₹420).",
        "{{last_order_date}}": "Date of customer's last order. This is historical data, not campaign validity date.",
        "{{last_product_name}}": "Name of last product ordered.",
        "{{last_variant}}": "Variant/size of last order (example: 250g).",
        "{{preferred_channel}}": "Most frequent purchase channel (retail/whatsapp/website).",
    }
    token_help_lines = []
    for tok in allowed_tokens:
        token_help_lines.append(f"- {tok}: {token_meanings.get(tok, 'Token placeholder from CRM data.')}")

    prompt_lines = [
        "Create exactly one reusable WhatsApp marketing template for a customer group.",
        "Return template text only.",
        "Do not personalize with real names. Use placeholders/tokens.",
        "Keep under 90 words and plain text.",
        "Use the minimum number of tokens needed. Default target: 1 to 3 tokens, not all.",
        "Do not include token-heavy data-dump style lines.",
        "Do not invent facts not present in tokens.",
        "Do not convert historical fields into future promises unless campaign explicitly asks.",
        "Specifically: never use {{last_order_date}} as offer expiry/valid-until date.",
        "Do not claim guaranteed discounts/freebies unless campaign brief explicitly says so.",
        "If brand name is needed in message/signoff, use {{brand_name}} token instead of generic placeholders.",
        "Prefer simple structure: greeting + offer + short call-to-action.",
        "Only use stats tokens ({{order_count}}, {{avg_order_value}}) when brief explicitly needs analytics-style personalization.",
        "For most campaigns, prefer {{customer_name}} and optionally one contextual token like {{last_product_name}} or {{area}}.",
        "",
        "Campaign Brief:",
        campaign_brief or "Re-engagement campaign for filtered customer group.",
        "",
        "Group Summary:",
        group_summary or "-",
        "",
        "Allowed Tokens (use only if needed for campaign goal; do not force all):",
        token_line,
        "",
        "Token Meanings:",
        *token_help_lines,
    ]
    if extra_instruction:
        prompt_lines.extend(["", "Extra Instruction:", extra_instruction])
    user_prompt = "\n".join(prompt_lines)

    template = _ai_chat_draft(
        base_url=base_url,
        api_key=api_key,
        model=model,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
    )
    issues = _template_token_issues(template)
    if issues:
        fix_prompt = "\n".join(
            [
                "Your previous template had token misuse.",
                "Fix and return only corrected template text.",
                "Do not change campaign intent.",
                "Hard rules:",
                "- {{order_count}} is number of orders; do not attach kg/g/pack units.",
                "- {{last_order_date}} is historical date; do not use as expiry/valid-until.",
                "- Keep token count minimal (1-3 unless absolutely needed).",
                "",
                "Previous template:",
                template,
            ]
        )
        template = _ai_chat_draft(
            base_url=base_url,
            api_key=api_key,
            model=model,
            system_prompt=system_prompt,
            user_prompt=fix_prompt,
        )
        issues = _template_token_issues(template)
    used = [tok for tok in allowed_tokens if tok in template]
    return {
        "template": template,
        "allowedTokens": allowed_tokens,
        "usedTokens": used,
        "issues": issues,
    }


# ── Entry point ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    _init_storage()
    print(f"[CRM] Using SQLite storage at {DB_FILE}")
    if LEGACY_DATA_FILE.exists():
        print(f"[CRM] Legacy JSON available for fallback/backup at {LEGACY_DATA_FILE}")

    host = os.environ.get("HOST", "0.0.0.0").strip() or "0.0.0.0"
    print(f"[CRM] Starting server at http://{host}:8000")
    uvicorn.run("app:app", host=host, port=8000, reload=False)

