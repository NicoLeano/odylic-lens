"""Compatibility shim for Lens.

Atelier's ad_analysis_endpoints (and other ported modules) import
``brand_profile_store`` to read/write per-brand profile blobs. In Atelier
this is a dedicated JSON file at the repo root, scoped by brand only.

Lens uses a different store: ``~/.odylic-lens/brand_profile.json``, keyed
by (user_id, brand). This shim makes the Atelier imports succeed while
routing reads/writes to Lens's store, so naming conventions (and any
other per-brand settings) actually persist and round-trip through the
``/api/profile`` endpoint that the frontend reads.

Since the Atelier-style API doesn't carry a user-id, we fall back to a
single special bucket ``__lens_global__``. That's fine for single-tenant
Lens deploys: every authenticated user shares the same naming-convention
table (which matches Atelier's behavior. one JSON file for the whole
deploy).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional


_GLOBAL_KEY = "__lens_global__"


def _profile_path() -> Path:
    """Mirror lens_routes._profile_path so both modules read/write the
    same file. Don't import lens_routes here. that pulls in FastAPI,
    middleware, and a stack of dependencies just to grab one path.
    """
    base = Path(os.environ.get("LENS_DATA_DIR", str(Path.home() / ".odylic-lens")))
    base.mkdir(parents=True, exist_ok=True)
    return base / "brand_profile.json"


def _load_all() -> dict:
    p = _profile_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def _save_all(data: dict) -> None:
    p = _profile_path()
    # Write-then-rename for atomicity. matches the pattern lens_routes
    # uses for ad_analysis_cache.json.
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(p)


def get_profile(brand: str) -> Optional[dict]:
    """Return the brand's profile dict, or None.

    In Lens, profiles live under (user_id, brand). Atelier callers don't
    carry a user_id, so we look up the global bucket. If the brand is
    only stored under a specific user, fall back to *any* user's entry -
    naming conventions are deploy-wide, not per-operator, so this avoids
    surprising the user when they log in fresh.
    """
    data = _load_all()
    # Try the global bucket first
    glob = data.get(_GLOBAL_KEY, {})
    if isinstance(glob, dict) and brand in glob:
        return glob[brand] or {}
    # Fall back to the first user that has a row for this brand
    for uid, by_brand in data.items():
        if uid == _GLOBAL_KEY:
            continue
        if isinstance(by_brand, dict) and brand in by_brand:
            return by_brand[brand] or {}
    return {}


def save_profile(brand: str, profile: dict) -> None:
    """Persist the brand's profile dict.

    Writes to the global bucket so all Lens users see the same naming
    convention. Also mirrors into every existing per-user bucket that
    already has a row for this brand, so the frontend's per-user
    ``/api/profile`` lookup returns the same data without a sign-out /
    sign-in round-trip.
    """
    data = _load_all()
    # Always update the global bucket.
    glob = data.setdefault(_GLOBAL_KEY, {})
    glob[brand] = dict(profile or {})
    # Mirror into existing per-user buckets that already have this brand,
    # so the very next /api/profile read returns the new value.
    for uid, by_brand in data.items():
        if uid == _GLOBAL_KEY or not isinstance(by_brand, dict):
            continue
        if brand in by_brand:
            # Preserve any per-user keys the global doesn't carry by
            # merging on top of (not replacing) the existing row.
            existing = by_brand[brand] if isinstance(by_brand[brand], dict) else {}
            merged = {**existing, **(profile or {})}
            by_brand[brand] = merged
    _save_all(data)
