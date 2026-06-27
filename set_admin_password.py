#!/usr/bin/env python3
"""
Reset a CRM admin password without importing the FastAPI app.

Usage:
  python3 set_admin_password.py --list-admins
  python3 set_admin_password.py <username>
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import json
import secrets
import sqlite3
import sys
import time
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DB_FILE = BASE_DIR / "data.sqlite3"
PASSWORD_HASH_ITERATIONS = 310_000


def normalize_username(value: str) -> str:
    return "".join(str(value or "").strip().lower().split())


def password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_HASH_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PASSWORD_HASH_ITERATIONS,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(derived).decode("ascii"),
    )


def connect_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def load_section(conn: sqlite3.Connection, section: str, default):
    row = conn.execute("SELECT value FROM app_state_sections WHERE section = ?", (section,)).fetchone()
    if not row:
        return default
    return json.loads(row[0])


def save_section(conn: sqlite3.Connection, section: str, value) -> None:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    now = int(time.time())
    conn.execute(
        """
        INSERT INTO app_state_sections(section, value, updated_at)
        VALUES(?, ?, ?)
        ON CONFLICT(section) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
        """,
        (section, payload, now),
    )


def list_admin_usernames(conn: sqlite3.Connection) -> list[str]:
    users = load_section(conn, "users", [])
    admins: list[str] = []
    for user in users:
        if not isinstance(user, dict):
            continue
        if str(user.get("role") or "").strip().lower() != "admin":
            continue
        username = normalize_username(user.get("username", ""))
        if username:
            admins.append(username)
    return sorted(dict.fromkeys(admins))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("Usage: python3 set_admin_password.py --list-admins")
        print("   or: python3 set_admin_password.py <username>")
        return 1
    command = str(argv[1] or "").strip()
    if command == "--list-admins":
        if not DB_FILE.exists():
            print(f"Database not found: {DB_FILE}")
            return 1
        with connect_db() as conn:
            admins = list_admin_usernames(conn)
        if not admins:
            print("No admin users found.")
            return 1
        print("Admin usernames:")
        for username in admins:
            print(f"- {username}")
        return 0

    username = normalize_username(command)
    if not username:
        print("Username is required.")
        return 1
    if not DB_FILE.exists():
        print(f"Database not found: {DB_FILE}")
        return 1

    password = getpass.getpass("New password: ")
    confirm_password = getpass.getpass("Confirm password: ")
    if password != confirm_password:
        print("Passwords do not match.")
        return 1
    if len(password) < 8:
        print("Password must be at least 8 characters.")
        return 1

    with connect_db() as conn:
        users = load_section(conn, "users", [])
        auth_sessions = load_section(conn, "authSessions", [])
        target_user = None
        for user in users:
            if not isinstance(user, dict):
                continue
            if normalize_username(user.get("username", "")) != username:
                continue
            if str(user.get("role") or "").strip().lower() != "admin":
                print(f"User '{username}' is not an admin.")
                return 1
            target_user = user
            break
        if target_user is None:
            print(f"Admin user '{username}' not found.")
            return 1

        target_user["passwordHash"] = password_hash(password)
        target_user["updatedAt"] = int(time.time() * 1000)
        target_user_id = int(target_user.get("id") or 0)
        auth_sessions = [
            session
            for session in auth_sessions
            if not isinstance(session, dict) or int(session.get("userId") or 0) != target_user_id
        ]

        save_section(conn, "users", users)
        save_section(conn, "authSessions", auth_sessions)
        conn.commit()

    print(f"Password updated for admin user '{username}'. Existing sessions were signed out.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
