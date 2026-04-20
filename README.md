# Kudagu CRM

A lightweight, self-hostable CRM for businesses of all types, with built-in order management, customer follow-ups, distributor tracking, shipping labels, WhatsApp workflows, and mandatory inventory sync.

This repository contains:
- A main CRM app (`app.py`) on port `8000`
- A required inventory service (`inventory/app.py`) on port `8001`

## Why This Project Exists

Kudagu CRM is designed for small teams across industries that need:
- Fast daily operations (orders, customers, status updates)
- Repeat-order follow-up workflows
- WhatsApp-first communication
- Basic distribution and inventory visibility
- Zero heavy dependencies (single FastAPI service + SQLite)

## Core Features

- Dashboard with revenue/profit snapshots and recent activity
- Customer management (create, edit, import from CSV/Excel/VCF)
- Order lifecycle tracking (`pending` -> `confirmed` -> `shipped` -> `completed`)
- Shipping workflow with courier templates, tracking links, and PDF labels
- Follow-up alerts for repeat orders
- Distribution batch tracking and settlement flow
- Product and pricing configuration per sales channel
- Marketing workspace with customer segmentation and campaign execution
- AI-assisted WhatsApp template generation (OpenAI-compatible API)
- Inventory-linked operations with low-stock alerts and completed-order sync

## Tech Stack

- Backend: FastAPI, Uvicorn
- Storage: SQLite (WAL mode)
- PDF generation: ReportLab
- Spreadsheet parsing: openpyxl
- Frontend: Vanilla HTML/CSS/JavaScript (served as static assets)

## Repository Structure

```text
.
|- app.py                     # Main CRM backend + static hosting
|- static/
|  |- index.html              # CRM UI
|  |- app.js                  # CRM frontend logic
|- inventory/
|  |- app.py                  # Required inventory service
|  |- static/
|  |  |- index.html
|  |  |- app.js
|- requirements.txt
|- .gitignore
```

## Quick Start

### 1) Prerequisites

- Python `3.10+`
- `pip`

### 2) Clone and install

```bash
git clone <your-fork-or-repo-url>
cd kudagu-crm
python -m venv .venv
```

Windows (PowerShell):

```powershell
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

macOS/Linux:

```bash
source .venv/bin/activate
pip install -r requirements.txt
```

### 3) Run the CRM

```bash
python app.py
```

Open: `http://localhost:8000`

### 4) Run inventory service (required)

In a second terminal:

```bash
cd inventory
python app.py
```

Inventory runs at `http://localhost:8001`.

Important: The CRM depends on the inventory service for stock visibility, low-stock alerts, and order-to-inventory movement sync. Run both services together in production.

## Configuration

The CRM supports these environment variables:

- `HOST` (default: `0.0.0.0`)
- `INVENTORY_URL` (default: `http://localhost:8001`)
- `MAX_IMPORT_BYTES` (default: `5242880`, i.e. 5 MB)
- `ALLOW_PRIVATE_AI_BASE_URL` (default: disabled)
- `SERVICE_API_KEYS` (**required**) comma-separated API keys accepted on all `/api/*` routes
- `SERVICE_OUTBOUND_API_KEY` (optional) key used by CRM when calling Inventory; defaults to the first `SERVICE_API_KEYS` value
- `CORS_ALLOWED_ORIGINS` (optional) comma-separated browser origin allowlist for cross-origin API access
- `CRM_UI_TRUSTED_ORIGINS` (optional) comma-separated first-party CRM UI origins that can access `/api/*` without API key
- `UI_TRUSTED_ORIGINS` (optional fallback) shared first-party origin allowlist if per-service keys above are not set
- `UI_PROXY_SHARED_SECRET` (recommended in production) requires proxy-set `X-UI-Proxy-Key` header for first-party browser free-pass

Example:

```bash
HOST=0.0.0.0 INVENTORY_URL=http://localhost:8001 SERVICE_API_KEYS=replace_with_very_long_random_key python app.py
```

The Inventory service supports:

- `CRM_URL` (default: `http://localhost:8000`)
- `SERVICE_API_KEYS` (**required**) must match keys trusted by CRM/website callers
- `SERVICE_OUTBOUND_API_KEY` (optional) key used by Inventory when calling CRM; defaults to the first `SERVICE_API_KEYS` value
- `CORS_ALLOWED_ORIGINS` (optional) comma-separated browser origin allowlist for cross-origin API access
- `INVENTORY_UI_TRUSTED_ORIGINS` (optional) comma-separated first-party Inventory UI origins that can access `/api/*` without API key
- `UI_TRUSTED_ORIGINS` (optional fallback) shared first-party origin allowlist if per-service keys above are not set
- `UI_PROXY_SHARED_SECRET` (recommended in production) requires proxy-set `X-UI-Proxy-Key` header for first-party browser free-pass

## Marketing AI + WhatsApp Workflow

The Marketing module supports semi-automated WhatsApp campaigns without requiring a paid WhatsApp Business API integration.

- AI helps generate campaign-ready WhatsApp message templates using your configured model/API key.
- Campaign execution opens prefilled WhatsApp chats for each selected customer in sequence.
- This uses the standard WhatsApp client flow (`wa.me` deep links), so teams can run campaigns without per-message WhatsApp API costs.

Note: internet data charges and any third-party AI provider/API usage costs still apply.

## Data & Persistence

- Primary data is stored in SQLite (`data.sqlite3` for CRM, `inventory/data.sqlite3` for inventory).
- Legacy `data.json` files are used for one-time seed/fallback if SQLite is empty.
- SQLite files are gitignored by default.

## API Overview (CRM)

Main routes:

- `GET /` -> CRM web app
- `GET /healthz` -> minimal health check for uptime monitoring
- `GET /api/data` -> full application state
- `PUT /api/data` -> replace full state
- `GET /api/bootstrap` -> initial dashboard bootstrap
- `POST /api/customers`, `PUT /api/customers/{id}`, `DELETE /api/customers/{id}`
- `POST /api/customers/import`
- `POST /api/orders`, `PUT /api/orders/{id}`, `DELETE /api/orders/{id}`
- `POST /api/products`, `PUT /api/products/{id}`, `DELETE /api/products/{id}`
- `PUT /api/settings`
- `GET /api/orders/{id}/shipping-label.pdf`
- `POST /api/alerts/followups/close`
- `POST /api/distribution/batches` and related batch update/complete/delete routes
- `GET /api/inventory/stock`
- `POST /api/inventory/sync-completed-orders`
- `POST /api/marketing/draft`
- `POST /api/marketing/template`
- `POST /api/website/auth/signup` (create website customer account + sync CRM customer)
- `POST /api/website/auth/login` (verify website credentials via CRM)
- `GET /api/website/users/{id}`, `PUT /api/website/users/{id}` (profile sync)
- `POST /api/website/orders/sync` (upsert website order into CRM orders)
- `GET /api/website/orders?websiteUserId={id}` (website-safe customer order history)

## API Overview (Inventory Service)

- `GET /` -> Inventory web app
- `GET /healthz` -> minimal health check for uptime monitoring
- `GET /api/stock` -> stock snapshot (used by CRM alerts)
- `GET /api/data`, `PUT /api/data`
- `POST /api/products`, `PUT /api/products/{id}`, `DELETE /api/products/{id}`
- `POST /api/products/{id}/movements`
- `DELETE /api/products/{id}/movements/{movement_id}`
- `POST /api/crm/replace-movements` (atomic CRM movement sync)

## Security Notes

- API key authentication is enforced for all `/api/*` routes in both CRM and Inventory.
- Accepted headers: `X-API-Key: <key>` or `Authorization: Bearer <key>`.
- `SERVICE_API_KEYS` is mandatory and each key should be 32+ characters.
- First-party browser UI origins listed in `UI_TRUSTED_ORIGINS` are allowed without API key so internal CRM/Inventory dashboards continue to work.
- For hardened deployments, set `UI_PROXY_SHARED_SECRET` and configure reverse proxy to inject `X-UI-Proxy-Key` only for trusted UI traffic.
- Cross-origin callers (for example website on `:5000`) and server-to-server callers must send API key.
- Website customer credentials stored in CRM are hashed using PBKDF2-HMAC-SHA256 (never returned in API responses).
- Keep services behind TLS/reverse proxy; API keys must never be sent over plain HTTP.

Example nginx snippet (CRM):

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-UI-Proxy-Key "replace_with_same_UI_PROXY_SHARED_SECRET";
}
```
- Marketing AI API keys are stored in app state; deploy with trusted access controls.
- If using `ALLOW_PRIVATE_AI_BASE_URL=1`, ensure only trusted users can modify AI settings.

## Production Deployment Notes

- Use a reverse proxy (Nginx/Caddy) in front of the app(s).
- Terminate TLS at the proxy.
- Restrict access with Basic Auth, SSO, VPN, or IP allowlists.
- Exempt only the health endpoints from proxy auth if your uptime monitor cannot send credentials:
  CRM -> `https://your-domain/healthz`
  Inventory behind `/inventory/` -> `https://your-domain/inventory/healthz`
- Back up SQLite files regularly.
- Run each app under a process manager (systemd, supervisord, container runtime).

## Development Workflow

- Keep changes small and focused per pull request.
- Add clear commit messages (`feat:`, `fix:`, `docs:`, etc.).
- Validate manual flows after API/UI changes (customer/order CRUD, shipping label, follow-ups, marketing flow, inventory sync).

## Contributing

Contributions are welcome.

1. Fork the repository
2. Create a branch: `git checkout -b feat/your-change`
3. Make and test changes
4. Commit: `git commit -m "feat: describe change"`
5. Push and open a pull request

Please include:
- What changed
- Why it changed
- Any screenshots/GIFs for UI updates
- Migration notes if data shape/API behavior changed

## Roadmap Ideas

- Authentication and user roles
- Audit log for critical actions
- Automated tests (API + frontend integration)
- Docker Compose setup
- CI pipeline (lint/test/release checks)
- Data export/import tooling with versioned schema docs

## License

No license file is currently included.

If you plan to open source this project, add a `LICENSE` file (for example, MIT/Apache-2.0) before publishing so usage rights are explicit.
