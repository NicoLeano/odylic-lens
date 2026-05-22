"""Per-request Meta credentials context for Lens.

The ad_analysis_endpoints.py module (ported verbatim from Atelier) calls:
  - ``os.environ.get("META_ACCESS_TOKEN")`` for the Graph token
  - ``_get_meta_accounts()`` for the ``brand -> account_id`` mapping
  - ``from api_server import META_ACCOUNTS`` in one or two places

In Atelier these are global. In Lens they're per-user, derived from the
logged-in session. This module provides a thin shim:

1. ``LensContextMiddleware`` reads the ``lens_session`` cookie on every
   request and (if logged in) loads the user's access token + ad accounts
   into a :class:`contextvars.ContextVar`.

2. ``current_token()`` and ``current_accounts()`` are used inside
   ad_analysis_endpoints (via a small monkey-patch) so the existing
   reference to ``os.environ.get("META_ACCESS_TOKEN")`` keeps working.

3. The monkey-patch is applied in ``main.py`` *after* importing the
   ad_analysis_endpoints module.

This keeps the ported file untouched at the source-code level for most
endpoints, while still threading per-user credentials through.
"""
from __future__ import annotations

import contextvars
import os
from typing import Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

# fb_user_id of the currently-handled request, or None when no session.
_user_var: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "lens_user", default=None
)
# Per-request override of the Meta access token.
_token_var: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "lens_token", default=None
)
# Per-request `brand_label -> account_id` map (no `act_` prefix).
_accounts_var: contextvars.ContextVar[dict] = contextvars.ContextVar(
    "lens_accounts", default={}
)


def current_user() -> Optional[str]:
    return _user_var.get()


def current_token() -> Optional[str]:
    # Fall back to env so non-request contexts (background prewarm) still
    # have a chance. but in Lens proper that's a no-op.
    return _token_var.get() or os.environ.get("META_ACCESS_TOKEN") or None


def current_accounts() -> dict:
    return dict(_accounts_var.get() or {})


def _account_label(acct: dict) -> str:
    """Pick a stable, user-friendly label for an ad account.

    The Atelier dashboard expects ``brand`` to be a label that's safe to
    pass back and forth via URL. We prefer the user's friendly_name (set
    in the API Settings page), fall back to the Meta account name, then
    the raw account_id.
    """
    label = (
        acct.get("friendly_name")
        or acct.get("name")
        or str(acct.get("account_id") or "")
    )
    return label.strip()


def _build_account_map(rows: list[dict]) -> dict:
    """Build ``{label: account_id}`` for the per-user account list.

    Returns the account_id in ``act_<digits>`` form so Atelier's Graph URLs
    (``/{account_id}/insights``, ``/{account_id}/ads``, …) work without
    further normalization. Skips hidden accounts.
    """
    out: dict[str, str] = {}
    for r in rows:
        if r.get("hidden"):
            continue
        label = _account_label(r)
        if not label:
            continue
        aid = str(r.get("account_id") or "").strip()
        if not aid:
            continue
        if not aid.startswith("act_"):
            aid = f"act_{aid}"
        # On collision, keep the first (sorted by name in store.list_ad_accounts).
        out.setdefault(label, aid)
    return out


class LensContextMiddleware(BaseHTTPMiddleware):
    """Populate the per-request token + brand map from the session cookie."""

    async def dispatch(self, request: Request, call_next):
        sid = request.cookies.get("lens_session")
        if sid:
            # Import lazily to avoid a hard circular at startup.
            try:
                from store import get_session, get_access_token, list_ad_accounts
                uid = get_session(sid)
                if uid:
                    token = get_access_token(uid)
                    accts = list_ad_accounts(uid)
                    user_tok = _user_var.set(uid)
                    tok_tok = _token_var.set(token)
                    acc_tok = _accounts_var.set(_build_account_map(accts))
                    try:
                        return await call_next(request)
                    finally:
                        _user_var.reset(user_tok)
                        _token_var.reset(tok_tok)
                        _accounts_var.reset(acc_tok)
            except Exception:
                pass
        return await call_next(request)


def patch_ad_analysis_endpoints() -> None:
    """Rewire the Atelier-ported module to read from Lens context.

    Replaces ``_get_meta_accounts`` so ad endpoints see the *current
    user's* accounts. We don't patch ``os.environ.get`` itself; instead,
    each endpoint pulls token via ``os.environ.get("META_ACCESS_TOKEN")``
   . we route that to ``current_token()`` by stuffing a magic key into
    a custom ``os.environ`` adapter. That's brittle. Cleaner: replace the
    sentinel get with a wrapper.

    Implementation chose simplicity: monkey-patch a thin ``_token()``
    helper on the module, then sed the source at import time? No. we
    instead override ``os.environ`` lookups via a *module-local* shim
    by injecting ``os`` with a proxy that intercepts the one key.
    """
    import ad_analysis_endpoints as mod

    mod._get_meta_accounts = lambda: current_accounts()  # type: ignore[attr-defined]

    # Replace `os` inside the module with a proxy that intercepts the
    # one env-var lookup we care about. Anything else passes through.
    _real_os = mod.os

    class _OsProxy:
        # Pass-through for everything except `environ`.
        def __getattr__(self, name):
            return getattr(_real_os, name)

        @property
        def environ(self) -> dict:
            return _EnvProxy(_real_os.environ)

    class _EnvProxy:
        def __init__(self, real):
            self._real = real

        def get(self, key, default=None):
            if key == "META_ACCESS_TOKEN":
                tok = current_token()
                if tok:
                    return tok
                return self._real.get(key, default)
            if key == "ANTHROPIC_API_KEY":
                # Lens-stored Anthropic key (set via /api/integrations/anthropic)
                # overrides any process-level env var. Falls back to env when
                # nothing is stored. useful for single-operator deploys that
                # don't want to use the UI.
                try:
                    from store import get_integration_key
                    stored = get_integration_key("anthropic")
                    if stored:
                        return stored
                except Exception:
                    pass
                return self._real.get(key, default)
            return self._real.get(key, default)

        def __getitem__(self, key):
            v = self.get(key)
            if v is None:
                raise KeyError(key)
            return v

        def __contains__(self, key):
            return self.get(key) is not None

        def __getattr__(self, name):
            return getattr(self._real, name)

    mod.os = _OsProxy()  # type: ignore[attr-defined]
