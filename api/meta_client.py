"""Meta Marketing API client for Odylic Lens.

Adapted from the Atelier `generic_pulls.py` but per-user-token instead of
a single shared service account token. Same retry/rate-limit/token-expiry
hardening, same `leads_all` rollup, same default 7d_click attribution.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

import requests

META_API_VERSION = os.environ.get("META_API_VERSION", "v23.0")
GRAPH_BASE = f"https://graph.facebook.com/{META_API_VERSION}"

# Module-level requests.Session: keeps the underlying TCP+TLS connection
# pool warm across calls, saving ~150ms per request after the first.
_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": "OdylicLens/0.1"})

# Tiny in-process TTL cache for idempotent GETs. Keyed on the SHA-1 of the
# URL + (token-truncated) param dict so calls with the same parameters
# within `_CACHE_TTL_SEC` skip the network. Memory-bounded by `_CACHE_MAX`.
_CACHE_TTL_SEC = float(os.environ.get("LENS_META_CACHE_TTL", "60"))
_CACHE_MAX = int(os.environ.get("LENS_META_CACHE_MAX", "256"))
_CACHE: dict[str, tuple[float, dict]] = {}
_CACHE_LOCK = threading.Lock()

# Shared executor for parallel Graph calls (qc_sanity_check / ads endpoint
# fetch insights + ads metadata concurrently).
_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="meta-")


_LEAD_ACTION_TYPES = {
    "lead",
    "onsite_conversion.lead_grouped",
    "offsite_conversion.fb_pixel_lead",
    "offsite_conversion.custom.lead",
    "complete_registration",
    "onsite_conversion.complete_registration",
    "offsite_conversion.fb_pixel_complete_registration",
    "leadgen.other",
    "leadgen_grouped",
}

_PURCHASE_ACTION_TYPES = {
    "purchase",
    "omni_purchase",
    "offsite_conversion.fb_pixel_purchase",
    "onsite_web_purchase",
    "onsite_web_app_purchase",
    "onsite_conversion.purchase",
}


def _is_token_expired(err: dict) -> bool:
    if not isinstance(err, dict):
        return False
    code = err.get("code")
    etype = err.get("type") or ""
    return code in (190, 463, 102) or etype == "OAuthException"


def _is_rate_limited(err: dict) -> bool:
    if not isinstance(err, dict):
        return False
    return err.get("code") in (4, 17, 32, 613, 80004, 80014)


def _cache_key(url: str, params: Optional[dict]) -> str:
    """SHA-1 of (url, sorted params minus access_token). We intentionally
    DON'T include the token in the key. a deployment with one user (the
    self-hosted case) reuses the same token, and keeping it out of the key
    means we never hash a secret into a cache entry we might log."""
    p = dict(params or {})
    p.pop("access_token", None)
    blob = url + "?" + json.dumps(p, sort_keys=True, default=str)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()


def _cache_get(key: str) -> Optional[dict]:
    now = time.time()
    with _CACHE_LOCK:
        entry = _CACHE.get(key)
        if not entry:
            return None
        ts, value = entry
        if now - ts > _CACHE_TTL_SEC:
            _CACHE.pop(key, None)
            return None
        return value


def _cache_put(key: str, value: dict) -> None:
    with _CACHE_LOCK:
        if len(_CACHE) >= _CACHE_MAX:
            # Evict oldest entries until we have headroom. Simple FIFO is
            # fine. this isn't a hot path optimization.
            for k, _ in sorted(_CACHE.items(), key=lambda x: x[1][0])[: max(1, _CACHE_MAX // 4)]:
                _CACHE.pop(k, None)
        _CACHE[key] = (time.time(), value)


def _get_with_retry(url: str, params: Optional[dict], max_attempts: int = 3, use_cache: bool = True) -> dict:
    """GET via the shared session with retry-on-transient + optional TTL cache.

    Cache scope: same `(url, params)` returns the cached body for up to
    `_CACHE_TTL_SEC`. The cache is process-local; a restart clears it. We
    only cache successful responses (no error key) to avoid serving stale
    rate-limit-fail bodies after the limit clears."""
    ck = _cache_key(url, params) if use_cache else None
    if ck:
        cached = _cache_get(ck)
        if cached is not None:
            return cached

    delay = 1.0
    last_exc: Optional[Exception] = None
    for attempt in range(max_attempts):
        try:
            r = _SESSION.get(url, params=params, timeout=60)
            try:
                j = r.json()
            except Exception:
                j = {"_status": r.status_code, "_text": r.text[:500]}
            err = j.get("error") if isinstance(j, dict) else None
            if r.status_code >= 500 or _is_rate_limited(err or {}):
                if attempt + 1 < max_attempts:
                    time.sleep(delay)
                    delay *= 4
                    continue
            if ck and isinstance(j, dict) and "error" not in j and "_transport_error" not in j:
                _cache_put(ck, j)
            return j
        except (requests.ConnectionError, requests.Timeout) as e:
            last_exc = e
            if attempt + 1 < max_attempts:
                time.sleep(delay)
                delay *= 4
                continue
    return {"_transport_error": f"{type(last_exc).__name__}: {last_exc}"}


def clear_cache() -> int:
    """Drop every cached Meta response. Returns count cleared."""
    with _CACHE_LOCK:
        n = len(_CACHE)
        _CACHE.clear()
    return n


def _enrich_actions_rollup(row: dict) -> None:
    """Add leads_all, purchases_all, and their cost-per derivatives based
    on the `actions` array. Idempotent."""
    actions = row.get("actions")
    if not isinstance(actions, list):
        return
    leads = purchases = 0.0
    for a in actions:
        try:
            at = a.get("action_type")
            v = float(a.get("value", 0) or 0)
            if at in _LEAD_ACTION_TYPES:
                leads += v
            if at in _PURCHASE_ACTION_TYPES:
                purchases += v
        except (TypeError, ValueError):
            continue
    spend = 0.0
    try:
        spend = float(row.get("spend") or 0)
    except (TypeError, ValueError):
        pass
    if leads > 0:
        row["leads_all"] = round(leads, 2)
        if spend > 0:
            row["cost_per_lead_all"] = round(spend / leads, 2)
    if purchases > 0:
        row["purchases_all"] = round(purchases, 2)
        if spend > 0:
            row["cost_per_purchase_all"] = round(spend / purchases, 2)
    av = row.get("action_values")
    if isinstance(av, list):
        rev = 0.0
        for a in av:
            try:
                if a.get("action_type") in _PURCHASE_ACTION_TYPES:
                    rev += float(a.get("value", 0) or 0)
            except (TypeError, ValueError):
                continue
        if rev > 0:
            row["purchase_value_all"] = round(rev, 2)
            if spend > 0:
                row["roas_all"] = round(rev / spend, 3)


class MetaError(Exception):
    """Wraps a Meta API error so the FastAPI handler can pick out 401
    (token expired) vs 4xx (bad request) vs transport errors."""

    def __init__(self, message: str, *, code: Optional[int] = None,
                 etype: Optional[str] = None, expired: bool = False,
                 transport: bool = False, payload: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.etype = etype
        self.expired = expired
        self.transport = transport
        self.payload = payload or {}


def _maybe_raise(j: dict) -> None:
    if "_transport_error" in j:
        raise MetaError(j["_transport_error"], transport=True)
    err = j.get("error")
    if err:
        raise MetaError(
            err.get("message", "Meta API error"),
            code=err.get("code"),
            etype=err.get("type"),
            expired=_is_token_expired(err),
            payload=err,
        )


class MetaClient:
    """Per-user Meta Graph API client. One instance per HTTP request."""

    def __init__(self, access_token: str):
        if not access_token:
            raise RuntimeError("MetaClient requires an access_token")
        self.token = access_token

    # ---------- Identity ----------

    def me(self, fields: str = "id,name,email") -> dict:
        j = _get_with_retry(f"{GRAPH_BASE}/me", {"access_token": self.token, "fields": fields})
        _maybe_raise(j)
        return j

    # ---------- Ad accounts ----------

    def list_ad_accounts(self) -> list[dict]:
        """Return the list of ad accounts the connected user can read.
        Normalized to a flat dict per account."""
        all_rows: list[dict] = []
        next_url = f"{GRAPH_BASE}/me/adaccounts"
        params: Optional[dict] = {
            "access_token": self.token,
            "fields": (
                "id,account_id,name,currency,timezone_name,account_status,"
                "disable_reason,business{id,name},amount_spent"
            ),
            "limit": 200,
        }
        for _ in range(50):  # hard cap on page count
            j = _get_with_retry(next_url, params)
            _maybe_raise(j)
            for row in (j.get("data") or []):
                biz = row.get("business") or {}
                all_rows.append({
                    "account_id": row.get("id") or f"act_{row.get('account_id')}",
                    "name": row.get("name"),
                    "currency": row.get("currency"),
                    "timezone": row.get("timezone_name"),
                    "status": row.get("account_status"),
                    "business_id": biz.get("id"),
                    "business_name": biz.get("name"),
                    "amount_spent": row.get("amount_spent"),
                })
            next_url = ((j.get("paging") or {}).get("next")) or ""
            params = None
            if not next_url:
                break
        return all_rows

    # ---------- Generic GET ----------

    def get(self, path: str, params: Optional[dict] = None, max_rows: int = 2000) -> dict:
        qp = {"access_token": self.token}
        if params:
            for k, v in params.items():
                qp[k] = json.dumps(v) if isinstance(v, (list, dict)) else v
        next_url: Optional[str] = f"{GRAPH_BASE}/{path}"
        next_params: Optional[dict] = qp
        rows: list[dict] = []
        single: Optional[dict] = None
        while next_url and len(rows) < max_rows:
            j = _get_with_retry(next_url, next_params)
            _maybe_raise(j)
            if "data" in j:
                rows.extend(j["data"])
                next_url = (j.get("paging") or {}).get("next")
                next_params = None
            else:
                single = j
                break
        if single is not None:
            return {"object": single}
        return {
            "row_count": len(rows),
            "rows": rows[:max_rows],
            "truncated": len(rows) >= max_rows,
        }

    # ---------- Insights ----------

    def insights(
        self,
        account_id: str,
        since: Optional[str] = None,
        until: Optional[str] = None,
        date_preset: Optional[str] = None,
        level: str = "ad",
        breakdowns: Optional[str] = None,
        fields: Optional[str] = None,
        action_attribution_windows: Optional[str] = None,
        time_increment: Optional[str] = None,
        filtering: Optional[list] = None,
        limit: int = 500,
        max_rows: int = 5000,
        active_only: bool = False,
    ) -> dict:
        params: dict[str, Any] = {
            "access_token": self.token,
            "level": level,
            "limit": max(1, min(int(limit), 1000)),
        }
        params["fields"] = fields or (
            "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,"
            "spend,impressions,clicks,reach,frequency,cpm,cpc,ctr,cpp,"
            "actions,action_values,purchase_roas"
        )
        if breakdowns:
            params["breakdowns"] = breakdowns
        if action_attribution_windows:
            wins = (
                action_attribution_windows
                if action_attribution_windows.strip().startswith("[")
                else json.dumps([w.strip() for w in action_attribution_windows.split(",") if w.strip()])
            )
            params["action_attribution_windows"] = wins
            applied = action_attribution_windows
        else:
            params["action_attribution_windows"] = json.dumps(["7d_click"])
            applied = "7d_click (default)"
        if time_increment is not None:
            params["time_increment"] = str(time_increment)
        merged_filtering = list(filtering or [])
        if active_only:
            merged_filtering.append({"field": "ad.effective_status", "operator": "IN", "value": ["ACTIVE"]})
        if merged_filtering:
            params["filtering"] = json.dumps(merged_filtering)
        if date_preset:
            params["date_preset"] = date_preset
        else:
            if not (since and until):
                raise MetaError("Pass either date_preset OR since+until (YYYY-MM-DD)")
            params["time_range"] = json.dumps({"since": since, "until": until})

        next_url: Optional[str] = f"{GRAPH_BASE}/{account_id}/insights"
        next_params: Optional[dict] = params
        rows: list[dict] = []
        while next_url and len(rows) < max_rows:
            j = _get_with_retry(next_url, next_params)
            _maybe_raise(j)
            for row in (j.get("data") or []):
                _enrich_actions_rollup(row)
                rows.extend([row])
            next_url = (j.get("paging") or {}).get("next")
            next_params = None
        return {
            "account_id": account_id,
            "applied_windows": applied,
            "row_count": len(rows),
            "rows": rows[:max_rows],
            "truncated": len(rows) >= max_rows,
        }

    # ---------- Creative metadata ----------

    def ads_with_creatives(
        self,
        account_id: str,
        active_only: bool = False,
        limit_per_page: int = 200,
        max_rows: int = 2000,
    ) -> list[dict]:
        params: dict[str, Any] = {
            "access_token": self.token,
            "fields": (
                "id,name,effective_status,configured_status,adset_id,campaign_id,"
                "updated_time,created_time,"
                "creative{id,name,object_story_spec,asset_feed_spec,"
                "thumbnail_url,image_url,video_id,call_to_action_type,"
                "body,title,link_url}"
            ),
            "limit": max(1, min(limit_per_page, 500)),
        }
        if active_only:
            params["effective_status"] = json.dumps(["ACTIVE"])
        next_url: Optional[str] = f"{GRAPH_BASE}/{account_id}/ads"
        next_params: Optional[dict] = params
        rows: list[dict] = []
        while next_url and len(rows) < max_rows:
            j = _get_with_retry(next_url, next_params)
            _maybe_raise(j)
            rows.extend(j.get("data") or [])
            next_url = (j.get("paging") or {}).get("next")
            next_params = None
        return rows[:max_rows]
