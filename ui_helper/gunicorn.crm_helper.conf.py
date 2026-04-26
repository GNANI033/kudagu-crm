"""
Gunicorn config for CRM UI helper instance.
Loads helper settings from ui_helper/.env.crm.
Run: gunicorn -c ui_helper/gunicorn.crm_helper.conf.py ui_helper.app:app
"""

bind = "0.0.0.0:8100"
workers = 4
worker_class = "uvicorn.workers.UvicornWorker"
timeout = 60
graceful_timeout = 30
keepalive = 5
raw_env = [
    "HELPER_ENV_FILE=ui_helper/.env.crm",
]
