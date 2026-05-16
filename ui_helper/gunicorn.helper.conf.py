"""
Gunicorn config for UI helper proxy.
Run:
  HELPER_UPSTREAM_URL=http://127.0.0.1:8000 HELPER_API_KEY=... HELPER_LISTEN_PORT=8100 \
  gunicorn -c ui_helper/gunicorn.helper.conf.py ui_helper.app:app
"""

import os

host = str(os.environ.get("HELPER_LISTEN_HOST", "0.0.0.0")).strip() or "0.0.0.0"
port = str(os.environ.get("HELPER_LISTEN_PORT", "9000")).strip() or "9000"
bind = f"{host}:{port}"
workers = 4
worker_class = "uvicorn.workers.UvicornWorker"
timeout = 60
graceful_timeout = 30
keepalive = 5
