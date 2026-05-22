"""Lens stub for Atelier's DuckDB creative cache.

Atelier persists a per-ad creative-metadata cache in DuckDB so the
dashboard doesn't burn its way through Meta's call_count budget. Lens
doesn't ship a warehouse. every CA call goes live to Graph. The ported
``ad_analysis_endpoints.py`` calls into this module from a handful of
hot paths, all of which are wrapped in ``try/except`` and degrade
gracefully if these helpers return ``None`` / no-op.

This file keeps the public surface identical so the port doesn't need
edits. All operations are in-process only. ``upsert`` populates a
dict, ``get_cached`` reads from it. Process restart wipes the cache.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Optional

# In-process cache: ad_id -> (timestamp, record).
_CACHE: dict[str, tuple[float, dict]] = {}
_LOCK = threading.Lock()
DEFAULT_TTL_SEC = 7 * 24 * 3600


def ensure_table() -> None:
    """No-op (DuckDB schema setup); kept for API compatibility."""
    return


def get_cached(
    ad_id: str,
    *,
    ttl_sec: int = DEFAULT_TTL_SEC,
    stale_ok: bool = False,
) -> Optional[dict]:
    """Return a previously-upserted record if present and within TTL.

    Atelier returns ``None`` for cache miss; we do the same. ``stale_ok``
    bypasses TTL. used when Meta is rate-limited and we'd rather show
    stale-but-known than nothing.
    """
    with _LOCK:
        entry = _CACHE.get(str(ad_id))
    if not entry:
        return None
    ts, rec = entry
    if stale_ok or (time.time() - ts) <= ttl_sec:
        return dict(rec)
    return None


def upsert(rec: dict[str, Any]) -> None:
    """Idempotent insert. keyed by ad_id."""
    ad_id = str(rec.get("ad_id") or "").strip()
    if not ad_id:
        return
    with _LOCK:
        _CACHE[ad_id] = (time.time(), dict(rec))


def stats() -> dict[str, Any]:
    """Return cache statistics; shape mirrors Atelier's response."""
    with _LOCK:
        return {
            "backend": "in-process (Lens stub)",
            "rows": len(_CACHE),
            "oldest_ts": min((t for t, _ in _CACHE.values()), default=None),
            "newest_ts": max((t for t, _ in _CACHE.values()), default=None),
        }
