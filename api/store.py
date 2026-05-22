"""SQLite-backed store for Odylic Lens.

Single-tenant self-hosted: one user per deployment (the person who set up
the Meta App). We still persist a `users` row keyed by Facebook user ID
because the OAuth flow returns one and it lets us key tokens & account
metadata properly without leaking app-state across re-logins.

Tokens are encrypted at rest with a key derived from `LENS_SECRET_KEY`
in the environment. Without the key the DB is useless if exfiltrated.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from cryptography.fernet import Fernet, InvalidToken

def _db_path() -> Path:
    """Resolved each call so test fixtures monkey-patching LENS_DB_PATH
    take effect without reloading the module."""
    p = Path(os.environ.get("LENS_DB_PATH", str(Path.home() / ".odylic-lens" / "lens.db")))
    p.parent.mkdir(parents=True, exist_ok=True)
    return p

_LOCK = threading.RLock()


def _fernet() -> Fernet:
    """Derive a Fernet key from LENS_SECRET_KEY.

    Resolution order:
      1. ``LENS_SECRET_KEY`` env var (preferred. set in .env or shell).
      2. ``LENS_SECRET_KEY`` field in ``~/.odylic-lens/config.json`` -
         auto-loaded so the user doesn't have to keep re-exporting it.
      3. Auto-generate a fresh 32-byte random key, write it to
         ``config.json`` for next time. Existing encrypted tokens become
         unrecoverable in this case, but the app stays functional -
         user can just re-save their keys via Settings.

    All three modes hash the resolved string with SHA-256 so the Fernet
    key derivation is deterministic across restarts as long as the
    source value is the same.
    """
    secret = os.environ.get("LENS_SECRET_KEY")
    if not secret:
        # Look in ~/.odylic-lens/config.json (already used by auth.py for
        # the Meta app secret), then fall back to auto-generating.
        try:
            import json as _json
            import secrets as _secrets
            cfg_path = Path.home() / ".odylic-lens" / "config.json"
            cfg: dict = {}
            if cfg_path.exists():
                with open(cfg_path) as f:
                    cfg = _json.load(f) or {}
            secret = cfg.get("LENS_SECRET_KEY")
            if not secret:
                secret = _secrets.token_hex(32)
                cfg["LENS_SECRET_KEY"] = secret
                cfg_path.parent.mkdir(parents=True, exist_ok=True)
                with open(cfg_path, "w") as f:
                    _json.dump(cfg, f, indent=2)
            # Mirror into the process env so callers that read the env
            # directly (none today, but defensive) see the same value.
            os.environ["LENS_SECRET_KEY"] = secret
        except Exception as exc:
            raise RuntimeError(
                f"LENS_SECRET_KEY not in env and config.json fallback failed: {exc}"
            )
    digest = hashlib.sha256(secret.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        raise RuntimeError(
            "Failed to decrypt token. LENS_SECRET_KEY may have changed since this "
            "token was stored. Reconnect Meta to re-issue the token."
        )


def _config_path() -> Path:
    """Local config file for Meta App credentials pasted via the UI.
    Kept separate from `.env` so the file the user creates by hand is
    never silently overwritten."""
    return _db_path().parent / "config.json"


def save_app_credentials(app_id: str, app_secret: str, redirect_uri: Optional[str] = None) -> None:
    """Persist Meta App credentials. `app_secret` is encrypted at rest
    with the same key as access tokens. Empty values are ignored so a
    partial update (just rotating the secret, say) works.
    """
    path = _config_path()
    existing: dict = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text("utf-8"))
        except Exception:
            existing = {}
    if app_id:
        existing["META_APP_ID"] = app_id.strip()
    if app_secret:
        existing["META_APP_SECRET_ENC"] = encrypt(app_secret.strip())
    if redirect_uri:
        existing["OAUTH_REDIRECT_URI"] = redirect_uri.strip()
    path.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    # Chmod 0600 so no other user on the box can read the secret.
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def load_app_credentials() -> dict:
    """Return whatever's in the config file. Decrypts the secret on read.
    Empty dict if no config file exists.
    """
    path = _config_path()
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text("utf-8"))
    except Exception:
        return {}
    out: dict = {}
    if raw.get("META_APP_ID"):
        out["META_APP_ID"] = raw["META_APP_ID"]
    if raw.get("META_APP_SECRET_ENC"):
        try:
            out["META_APP_SECRET"] = decrypt(raw["META_APP_SECRET_ENC"])
        except Exception:
            pass
    if raw.get("OAUTH_REDIRECT_URI"):
        out["OAUTH_REDIRECT_URI"] = raw["OAUTH_REDIRECT_URI"]
    return out


def clear_app_credentials() -> None:
    path = _config_path()
    if path.exists():
        path.unlink()


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path(), isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _LOCK, _connect() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                fb_user_id   TEXT PRIMARY KEY,
                name         TEXT,
                email        TEXT,
                created_at   INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS connections (
                fb_user_id        TEXT NOT NULL,
                access_token_enc  TEXT NOT NULL,
                expires_at        INTEGER,
                granted_scopes    TEXT,
                updated_at        INTEGER NOT NULL,
                PRIMARY KEY (fb_user_id)
            );
            CREATE TABLE IF NOT EXISTS ad_accounts (
                fb_user_id   TEXT NOT NULL,
                account_id   TEXT NOT NULL,
                name         TEXT,
                currency     TEXT,
                timezone     TEXT,
                business_id  TEXT,
                business_name TEXT,
                status       INTEGER,
                friendly_name TEXT,
                hidden       INTEGER DEFAULT 0,
                updated_at   INTEGER NOT NULL,
                PRIMARY KEY (fb_user_id, account_id)
            );
            CREATE TABLE IF NOT EXISTS sessions (
                sid          TEXT PRIMARY KEY,
                fb_user_id   TEXT NOT NULL,
                created_at   INTEGER NOT NULL,
                expires_at   INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (fb_user_id);
            CREATE TABLE IF NOT EXISTS integrations (
                provider     TEXT PRIMARY KEY,
                api_key_enc  TEXT NOT NULL,
                updated_at   INTEGER NOT NULL,
                metadata     TEXT
            );
            -- Generic JSON-blob storage keyed by (brand, section).
            -- Used by AdAnalysisView's dashboard auto-save (widgets +
            -- layout + velocity thresholds) and any future section that
            -- wants to persist user customizations server-side instead
            -- of in localStorage. Single-tenant so we don't key by user.
            CREATE TABLE IF NOT EXISTS brand_section_data (
                brand        TEXT NOT NULL,
                section      TEXT NOT NULL,
                data         TEXT NOT NULL,
                updated_at   INTEGER NOT NULL,
                PRIMARY KEY (brand, section)
            );
        """)


def upsert_user(fb_user_id: str, name: Optional[str], email: Optional[str]) -> None:
    now = int(time.time())
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT INTO users (fb_user_id, name, email, created_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(fb_user_id) DO UPDATE SET name=excluded.name, email=excluded.email",
            (fb_user_id, name, email, now),
        )


def save_connection(fb_user_id: str, access_token: str, expires_at: Optional[int], scopes: Optional[str]) -> None:
    now = int(time.time())
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT INTO connections (fb_user_id, access_token_enc, expires_at, granted_scopes, updated_at) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(fb_user_id) DO UPDATE SET "
            "access_token_enc=excluded.access_token_enc, expires_at=excluded.expires_at, "
            "granted_scopes=excluded.granted_scopes, updated_at=excluded.updated_at",
            (fb_user_id, encrypt(access_token), expires_at, scopes, now),
        )


def get_access_token(fb_user_id: str) -> Optional[str]:
    with _LOCK, _connect() as conn:
        row = conn.execute(
            "SELECT access_token_enc, expires_at FROM connections WHERE fb_user_id = ?",
            (fb_user_id,),
        ).fetchone()
        if not row:
            return None
        return decrypt(row["access_token_enc"])


def get_connection_meta(fb_user_id: str) -> Optional[dict]:
    with _LOCK, _connect() as conn:
        row = conn.execute(
            "SELECT expires_at, granted_scopes, updated_at FROM connections WHERE fb_user_id = ?",
            (fb_user_id,),
        ).fetchone()
        if not row:
            return None
        return {
            "expires_at": row["expires_at"],
            "granted_scopes": row["granted_scopes"],
            "updated_at": row["updated_at"],
        }


def save_ad_account(fb_user_id: str, acct: dict) -> None:
    now = int(time.time())
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT INTO ad_accounts "
            "(fb_user_id, account_id, name, currency, timezone, business_id, business_name, status, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(fb_user_id, account_id) DO UPDATE SET "
            "name=excluded.name, currency=excluded.currency, timezone=excluded.timezone, "
            "business_id=excluded.business_id, business_name=excluded.business_name, "
            "status=excluded.status, updated_at=excluded.updated_at",
            (
                fb_user_id,
                acct["account_id"],
                acct.get("name"),
                acct.get("currency"),
                acct.get("timezone"),
                acct.get("business_id"),
                acct.get("business_name"),
                acct.get("status"),
                now,
            ),
        )


def list_ad_accounts(fb_user_id: str, include_hidden: bool = False) -> list[dict]:
    sql = "SELECT * FROM ad_accounts WHERE fb_user_id = ?"
    if not include_hidden:
        sql += " AND COALESCE(hidden, 0) = 0"
    sql += " ORDER BY COALESCE(friendly_name, name) COLLATE NOCASE"
    with _LOCK, _connect() as conn:
        return [dict(r) for r in conn.execute(sql, (fb_user_id,)).fetchall()]


def update_account_label(fb_user_id: str, account_id: str, friendly_name: Optional[str], hidden: Optional[bool]) -> None:
    with _LOCK, _connect() as conn:
        if friendly_name is not None:
            conn.execute(
                "UPDATE ad_accounts SET friendly_name = ? WHERE fb_user_id = ? AND account_id = ?",
                (friendly_name, fb_user_id, account_id),
            )
        if hidden is not None:
            conn.execute(
                "UPDATE ad_accounts SET hidden = ? WHERE fb_user_id = ? AND account_id = ?",
                (1 if hidden else 0, fb_user_id, account_id),
            )


def create_session(fb_user_id: str, ttl_sec: int = 60 * 60 * 24 * 30) -> str:
    import secrets
    sid = secrets.token_urlsafe(32)
    now = int(time.time())
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT INTO sessions (sid, fb_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (sid, fb_user_id, now, now + ttl_sec),
        )
    return sid


def get_session(sid: str) -> Optional[str]:
    """Return fb_user_id for a session id, or None if expired/missing."""
    with _LOCK, _connect() as conn:
        row = conn.execute(
            "SELECT fb_user_id, expires_at FROM sessions WHERE sid = ?",
            (sid,),
        ).fetchone()
    if not row:
        return None
    if row["expires_at"] < int(time.time()):
        return None
    return row["fb_user_id"]


def delete_session(sid: str) -> None:
    with _LOCK, _connect() as conn:
        conn.execute("DELETE FROM sessions WHERE sid = ?", (sid,))


def disconnect_user(fb_user_id: str) -> None:
    """Wipe all data for a user (tokens, accounts, sessions). Used when
    the user clicks 'disconnect' or revokes Meta access."""
    with _LOCK, _connect() as conn:
        conn.execute("DELETE FROM connections WHERE fb_user_id = ?", (fb_user_id,))
        conn.execute("DELETE FROM ad_accounts WHERE fb_user_id = ?", (fb_user_id,))
        conn.execute("DELETE FROM sessions WHERE fb_user_id = ?", (fb_user_id,))


# ─────────────────────────────────────────────────────────────────────
# Third-party integration API keys (Atria, OpenAI, …)
#
# These are global to the deployment (single-tenant), not per-user, so we
# key them by provider name only. Keys are Fernet-encrypted at rest with
# the same LENS_SECRET_KEY used for OAuth tokens.
# ─────────────────────────────────────────────────────────────────────


def _mask_last_4(plaintext: str) -> str:
    """Return a `...xxxx` preview of the last 4 chars (or fewer)."""
    if not plaintext:
        return ""
    tail = plaintext.strip()[-4:]
    return f"...{tail}"


# Hooks fired whenever an integration key is saved or deleted, so
# downstream modules (e.g. the Anthropic SDK client cache in
# ad_analysis_endpoints) can invalidate themselves and pick up the
# new key without an API restart. Each hook receives (provider, key|None).
_INTEGRATION_KEY_HOOKS: list[Callable[[str, Optional[str]], None]] = []


def register_integration_key_hook(fn: Callable[[str, Optional[str]], None]) -> None:
    """Register a callback fired on every save/delete of an integration
    key. Used to invalidate per-provider client caches (Anthropic SDK,
    etc) so a key rotation in Settings takes effect immediately."""
    _INTEGRATION_KEY_HOOKS.append(fn)


def _fire_integration_key_hooks(provider: str, key: Optional[str]) -> None:
    for fn in _INTEGRATION_KEY_HOOKS:
        try:
            fn(provider, key)
        except Exception as e:
            # Hooks must not break the save path. log + continue.
            print(f"[store] integration-key hook for {provider} raised: {e}", flush=True)


def save_integration_key(provider: str, key: str, metadata: Optional[dict] = None) -> None:
    """Store (or replace) an API key for a named provider, encrypted."""
    if not provider or not key:
        raise ValueError("provider and key are both required")
    now = int(time.time())
    meta_json = json.dumps(metadata) if metadata else None
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT INTO integrations (provider, api_key_enc, updated_at, metadata) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(provider) DO UPDATE SET "
            "api_key_enc=excluded.api_key_enc, updated_at=excluded.updated_at, metadata=excluded.metadata",
            (provider, encrypt(key), now, meta_json),
        )
    _fire_integration_key_hooks(provider, key)


def get_integration_key(provider: str) -> Optional[str]:
    """Decrypt and return the plaintext key for a provider, or None."""
    with _LOCK, _connect() as conn:
        row = conn.execute(
            "SELECT api_key_enc FROM integrations WHERE provider = ?",
            (provider,),
        ).fetchone()
        if not row:
            return None
        try:
            return decrypt(row["api_key_enc"])
        except Exception:
            return None


def get_integration_meta(provider: str) -> Optional[dict]:
    """Return safe metadata about a stored key (no plaintext): masked
    last 4 chars, updated_at, free-form metadata blob. None if not set."""
    with _LOCK, _connect() as conn:
        row = conn.execute(
            "SELECT api_key_enc, updated_at, metadata FROM integrations WHERE provider = ?",
            (provider,),
        ).fetchone()
        if not row:
            return None
    try:
        plaintext = decrypt(row["api_key_enc"])
        last_4 = _mask_last_4(plaintext)
    except Exception:
        last_4 = None
    meta = None
    if row["metadata"]:
        try:
            meta = json.loads(row["metadata"])
        except Exception:
            meta = None
    return {
        "provider": provider,
        "configured": True,
        "last_4": last_4,
        "updated_at": row["updated_at"],
        "metadata": meta,
    }


def delete_integration_key(provider: str) -> None:
    with _LOCK, _connect() as conn:
        conn.execute("DELETE FROM integrations WHERE provider = ?", (provider,))
    _fire_integration_key_hooks(provider, None)


def list_integrations() -> list[dict]:
    """Return the safe-metadata view of every configured integration.
    Never returns plaintext keys."""
    with _LOCK, _connect() as conn:
        rows = conn.execute(
            "SELECT provider, api_key_enc, updated_at, metadata FROM integrations ORDER BY provider"
        ).fetchall()
    out: list[dict] = []
    for row in rows:
        try:
            last_4 = _mask_last_4(decrypt(row["api_key_enc"]))
        except Exception:
            last_4 = None
        meta = None
        if row["metadata"]:
            try:
                meta = json.loads(row["metadata"])
            except Exception:
                meta = None
        out.append({
            "provider": row["provider"],
            "configured": True,
            "last_4": last_4,
            "updated_at": row["updated_at"],
            "metadata": meta,
        })
    return out


# ─────────────────────────────────────────────────────────────────────
# Generic per-(brand, section) JSON-blob storage. Used by the dashboard
# auto-save (widgets + layout + velocity thresholds) so the UI persists
# state server-side instead of leaning entirely on localStorage.
# ─────────────────────────────────────────────────────────────────────


def get_brand_section(brand: str, section: str) -> Optional[dict]:
    """Return the saved JSON blob for (brand, section), or None if unset.
    Returns the parsed dict; if the row exists but is corrupt JSON we
    return None rather than raising so the UI keeps working."""
    with _LOCK, _connect() as conn:
        row = conn.execute(
            "SELECT data FROM brand_section_data WHERE brand = ? AND section = ?",
            (brand, section),
        ).fetchone()
    if not row:
        return None
    try:
        return json.loads(row["data"])
    except Exception:
        return None


def save_brand_section(brand: str, section: str, data: dict) -> None:
    """Upsert the JSON blob for (brand, section). Caller is responsible
    for validating the shape. we just round-trip the dict so future
    fields don't require a schema change."""
    payload = json.dumps(data or {})
    now = int(time.time())
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT INTO brand_section_data (brand, section, data, updated_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(brand, section) DO UPDATE SET "
            "data=excluded.data, updated_at=excluded.updated_at",
            (brand, section, payload, now),
        )


def list_brand_sections(brand: str) -> dict[str, dict]:
    """Return every saved section for a brand as a {section: data} map.
    Used by the brand-profiles fetch-all endpoint."""
    with _LOCK, _connect() as conn:
        rows = conn.execute(
            "SELECT section, data FROM brand_section_data WHERE brand = ?",
            (brand,),
        ).fetchall()
    out: dict[str, dict] = {}
    for row in rows:
        try:
            out[row["section"]] = json.loads(row["data"])
        except Exception:
            out[row["section"]] = {}
    return out
