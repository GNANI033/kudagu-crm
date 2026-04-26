"""
UI helper proxy for CRM/Inventory browser access.

Run one instance per upstream service:
- CRM helper   -> HELPER_UPSTREAM_URL=http://internal-crm:8000
- Inventory    -> HELPER_UPSTREAM_URL=http://internal-inventory:8001
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[key] = value


BASE_DIR = Path(__file__).parent
_load_env_file(BASE_DIR.parent / ".env")
_load_env_file(BASE_DIR / ".env")
_helper_env_file = str(os.environ.get("HELPER_ENV_FILE", "")).strip()
if _helper_env_file:
    helper_env_path = Path(_helper_env_file)
    if not helper_env_path.is_absolute():
        helper_env_path = (BASE_DIR.parent / helper_env_path).resolve()
    _load_env_file(helper_env_path)

HELPER_UPSTREAM_URL = str(os.environ.get("HELPER_UPSTREAM_URL", "")).strip().rstrip("/")
HELPER_API_KEY = str(os.environ.get("HELPER_API_KEY", "")).strip()
HELPER_LISTEN_HOST = str(os.environ.get("HELPER_LISTEN_HOST", "0.0.0.0")).strip() or "0.0.0.0"
HELPER_LISTEN_PORT = int(str(os.environ.get("HELPER_LISTEN_PORT", "9000")).strip() or "9000")
HELPER_TIMEOUT_SECONDS = float(str(os.environ.get("HELPER_TIMEOUT_SECONDS", "30")).strip() or "30")

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}


def _validate_config() -> None:
    if not HELPER_UPSTREAM_URL:
        raise RuntimeError("HELPER_UPSTREAM_URL is required.")
    if not HELPER_API_KEY:
        raise RuntimeError("HELPER_API_KEY is required.")
    if len(HELPER_API_KEY) < 32:
        raise RuntimeError("HELPER_API_KEY must be at least 32 characters.")
    if not (HELPER_UPSTREAM_URL.startswith("http://") or HELPER_UPSTREAM_URL.startswith("https://")):
        raise RuntimeError("HELPER_UPSTREAM_URL must be http(s).")


def _clean_request_headers(request: Request) -> dict[str, str]:
    headers: dict[str, str] = {}
    for key, value in request.headers.items():
        lower = key.lower()
        if lower in HOP_BY_HOP_HEADERS:
            continue
        if lower in {"host", "content-length", "x-api-key", "authorization"}:
            continue
        headers[key] = value
    return headers


def _clean_response_headers(headers: httpx.Headers) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in headers.items():
        lower = key.lower()
        if lower in HOP_BY_HOP_HEADERS:
            continue
        if lower == "content-length":
            continue
        out[key] = value
    return out


def _is_html_payload(content_type: str, content: bytes) -> bool:
    ctype = str(content_type or "").lower()
    if "text/html" in ctype:
        return True
    prefix = content[:128].decode("utf-8", errors="ignore").lower()
    return "<!doctype html" in prefix or "<html" in prefix


app = FastAPI(title="Kudagu UI Helper", docs_url=None, redoc_url=None)
_validate_config()
_CLIENT = httpx.AsyncClient(timeout=HELPER_TIMEOUT_SECONDS, follow_redirects=False)


@app.on_event("shutdown")
async def _shutdown_client() -> None:
    await _CLIENT.aclose()


@app.api_route("/healthz", methods=["GET", "HEAD"], include_in_schema=False)
async def healthcheck() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "service": "ui-helper",
            "upstream": HELPER_UPSTREAM_URL,
        },
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
            "X-Robots-Tag": "noindex, nofollow",
        },
    )


@app.api_route("/", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
@app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
async def proxy(full_path: str, request: Request) -> Response:
    started = time.time()
    path = "/" + str(full_path or "").lstrip("/")
    query = request.url.query
    upstream_url = f"{HELPER_UPSTREAM_URL}{path}"
    if query:
        upstream_url = f"{upstream_url}?{query}"

    headers = _clean_request_headers(request)
    if path.startswith("/api/"):
        headers["X-API-Key"] = HELPER_API_KEY

    body = await request.body()
    try:
        upstream_resp = await _CLIENT.request(
            request.method.upper(),
            upstream_url,
            content=body,
            headers=headers,
        )
    except httpx.RequestError as exc:
        took_ms = int((time.time() - started) * 1000)
        print(
            f'{{"svc":"ui-helper","upstream":"{HELPER_UPSTREAM_URL}","method":"{request.method.upper()}",'
            f'"path":"{path}","status":502,"latencyMs":{took_ms},"error":"{type(exc).__name__}"}}'
        )
        return JSONResponse(
            status_code=502,
            content={"detail": "Upstream service unavailable. Please try again."},
        )

    status = int(upstream_resp.status_code)
    content = upstream_resp.content or b""
    content_type = str(upstream_resp.headers.get("content-type") or "")
    if path.startswith("/api/") and status >= 400 and _is_html_payload(content_type, content):
        content = b'{"detail":"Upstream service error. Please try again."}'
        content_type = "application/json"

    out_headers = _clean_response_headers(upstream_resp.headers)
    if content_type:
        out_headers["Content-Type"] = content_type
    took_ms = int((time.time() - started) * 1000)
    print(
        f'{{"svc":"ui-helper","upstream":"{HELPER_UPSTREAM_URL}","method":"{request.method.upper()}",'
        f'"path":"{path}","status":{status},"latencyMs":{took_ms}}}'
    )
    return Response(content=content, status_code=status, headers=out_headers)


if __name__ == "__main__":
    print(f"[UI-Helper] Upstream: {HELPER_UPSTREAM_URL}")
    print(f"[UI-Helper] Listening on http://{HELPER_LISTEN_HOST}:{HELPER_LISTEN_PORT}")
    uvicorn.run("ui_helper.app:app", host=HELPER_LISTEN_HOST, port=HELPER_LISTEN_PORT, reload=False)
