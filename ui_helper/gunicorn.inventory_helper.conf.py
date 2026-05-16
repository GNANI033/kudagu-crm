"""
Gunicorn config for Inventory UI helper instance.
Loads helper settings from ui_helper/.env.inventory.
Run: gunicorn -c ui_helper/gunicorn.inventory_helper.conf.py ui_helper.app:app
"""

bind = "0.0.0.0:8101"
workers = 4
worker_class = "uvicorn.workers.UvicornWorker"
timeout = 60
graceful_timeout = 30
keepalive = 5
raw_env = [
    "HELPER_ENV_FILE=ui_helper/.env.inventory",
]
