"""
Gunicorn config for Inventory (production).
Run: gunicorn -c inventory/gunicorn.inventory.conf.py inventory.app:app
"""

bind = "0.0.0.0:8001"
workers = 4
worker_class = "uvicorn.workers.UvicornWorker"
timeout = 60
graceful_timeout = 30
keepalive = 5

# Avoid per-worker stale in-memory cache when running multiple workers.
raw_env = [
    "DISABLE_IN_MEMORY_CACHE=1",
]
