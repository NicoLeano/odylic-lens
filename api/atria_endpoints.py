"""Server-side proxy for the Atria Open API.

Why this exists
---------------
The Atria API key is workspace-scoped and rate-limited; we never want it
to ship in the frontend bundle. These thin endpoints forward queries from
the dashboard (Creative Analysis "AI Search" toggle) to
``https://api.tryatria.com/open/v1/*`` while keeping the key on the server.

Design notes
------------
* No caching here. Atria's catalog updates daily and the dashboard
  re-queries on every filter change anyway. A future iteration could
  short-TTL cache the `query=`/`brand_id=` paths but the API is fast
  enough today that it isn't worth the staleness debt.
* We **never** synthesise an envelope. If Atria returns 200 with the
  ``{code, message, data}`` shape we pass it straight through, including
  any non-zero `code` for the frontend to surface. Gateway-level errors
  (401/429/5xx) bubble up as the same status with the upstream JSON body
  so the frontend can show a meaningful toast.
* `cursor` is opaque. we treat it as an unparsed string and never decode
  it. Same for `board_id` / `brand_id` / `ad_id`. we forward verbatim.
* Repeatable query params (``platform``, ``display_format``, ``language``,
  ``industry``, ``status``, ``video_length``) come through FastAPI as
  ``list[str]`` and we serialise back to ``requests`` as the same key
  repeated. Atria parses both ``?platform=facebook&platform=tiktok`` and
  the rare comma form, but the repeated form is what the docs show.
"""

from __future__ import annotations

import os
from typing import Any, Optional

import requests
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse


ATRIA_BASE = "https://api.tryatria.com/open/v1"
ATRIA_TIMEOUT = 30  # seconds. Atria's p95 is well under 2s


router = APIRouter(prefix="/api/atria", tags=["atria"])


def _api_key() -> str:
    """Resolve the Atria API key at call time.

    Lens stores integration keys encrypted in SQLite (see ``store.py``).
    We fall back to ``ATRIA_API_KEY`` from the environment so the
    upstream Atelier-style ``.env`` workflow still works for headless
    deploys that don't use the Settings UI.
    """
    try:
        from store import get_integration_key  # local import to avoid cycles
        key = get_integration_key("atria")
    except Exception:
        key = None
    if not key:
        key = os.environ.get("ATRIA_API_KEY")
    if not key:
        # 503 = config problem (not a code crash) so the UI can show a
        # "no key saved" hint instead of generic "server error".
        raise HTTPException(
            status_code=503,
            detail="No Atria API key saved. Add one in Settings → Atria.",
        )
    return key


def _forward(
    path: str,
    params: Optional[list[tuple[str, Any]]] = None,
) -> JSONResponse:
    """Proxy `GET ATRIA_BASE/<path>` and stream the response back.

    Uses a list-of-tuples for params so repeatable keys (e.g. multiple
    ``platform=`` values) survive serialisation. passing a dict would
    silently collapse them into the last value.
    """
    url = f"{ATRIA_BASE}{path}"
    try:
        resp = requests.get(
            url,
            headers={"X-API-Key": _api_key(), "Accept": "application/json"},
            params=params,
            timeout=ATRIA_TIMEOUT,
        )
    except requests.RequestException as e:
        # Network-level failure. treat as upstream unavailability so the
        # frontend retries instead of permanently failing the toggle.
        return JSONResponse(
            status_code=502,
            content={
                "error": "upstream_unreachable",
                "message": f"Atria API unreachable: {e}",
            },
        )

    # Pass-through: status + body. Atria's content-type is always JSON
    # for both success and error envelopes, so json() is safe; fall back
    # to raw text if upstream sent something exotic (e.g. a CDN-side
    # HTML error page during incidents).
    try:
        body = resp.json()
    except ValueError:
        body = {"error": "upstream_non_json", "message": resp.text[:500]}

    return JSONResponse(status_code=resp.status_code, content=body)


def _multi(values: Optional[list[str]], key: str) -> list[tuple[str, str]]:
    """Expand a repeatable filter into a list of (key, value) tuples.

    FastAPI's `Query(... default=None)` gives us `None` when the caller
    omits the parameter; if we forwarded `None` Atria would treat the
    literal string ``"None"`` as a filter and return zero results, which
    is a particularly hard bug to spot in a UI that's just showing an
    empty grid.
    """
    if not values:
        return []
    return [(key, v) for v in values if v]


# ---------------------------------------------------------------------------
# Ads
# ---------------------------------------------------------------------------

@router.get("/ads")
def list_ads(
    query: Optional[str] = None,
    platform: Optional[list[str]] = Query(None),
    display_format: Optional[list[str]] = Query(None),
    language: Optional[list[str]] = Query(None),
    industry: Optional[list[str]] = Query(None),
    status: Optional[list[str]] = Query(None),
    video_length: Optional[list[str]] = Query(None),
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    order: str = "newest",
    page_size: int = 20,
    cursor: Optional[str] = None,
):
    """Global ad-library search. Forwards the full filter surface from
    Atria's `GET /open/v1/ads` so we don't have to redeploy when a new
    filter ships upstream."""
    params: list[tuple[str, Any]] = []
    if query:
        params.append(("query", query))
    params.extend(_multi(platform, "platform"))
    params.extend(_multi(display_format, "display_format"))
    params.extend(_multi(language, "language"))
    params.extend(_multi(industry, "industry"))
    params.extend(_multi(status, "status"))
    params.extend(_multi(video_length, "video_length"))
    if start_date:
        params.append(("start_date", start_date))
    if end_date:
        params.append(("end_date", end_date))
    params.append(("order", order))
    params.append(("page_size", str(page_size)))
    if cursor:
        params.append(("cursor", cursor))
    return _forward("/ads", params=params)


@router.get("/ads/{ad_id}")
def get_ad(ad_id: str):
    """Full ad detail. same shape as one element of `list_ads.items`."""
    return _forward(f"/ads/{ad_id}")


# ---------------------------------------------------------------------------
# Boards (read-only. the API has no save/unsave POST as of 2026-05)
# ---------------------------------------------------------------------------

@router.get("/boards")
def list_boards(page: int = 1, page_size: int = 50):
    """List workspace boards. Atria caps `page_size` at 100; we default
    to 50 so the dashboard can render the picker without scrolling.
    Returns the full tree under each top-level board regardless of
    pagination. only top-level boards are paginated."""
    return _forward(
        "/boards",
        params=[("page", str(page)), ("page_size", str(page_size))],
    )


@router.get("/boards/{board_id}/ads")
def list_board_ads(
    board_id: str,
    query: Optional[str] = None,
    platform: Optional[list[str]] = Query(None),
    display_format: Optional[list[str]] = Query(None),
    language: Optional[list[str]] = Query(None),
    status: Optional[list[str]] = Query(None),
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    order: str = "newest",
    page_size: int = 20,
    cursor: Optional[str] = None,
):
    """Ads pinned to a specific board. Note: `order=best_match` is NOT
    accepted upstream for board scopes (ES storage incompat). frontend
    filters that option out when board mode is active."""
    params: list[tuple[str, Any]] = []
    if query:
        params.append(("query", query))
    params.extend(_multi(platform, "platform"))
    params.extend(_multi(display_format, "display_format"))
    params.extend(_multi(language, "language"))
    params.extend(_multi(status, "status"))
    if start_date:
        params.append(("start_date", start_date))
    if end_date:
        params.append(("end_date", end_date))
    params.append(("order", order))
    params.append(("page_size", str(page_size)))
    if cursor:
        params.append(("cursor", cursor))
    return _forward(f"/boards/{board_id}/ads", params=params)


# ---------------------------------------------------------------------------
# Brands
# ---------------------------------------------------------------------------

@router.get("/brands/search")
def search_brands(
    keyword: str,
    platform: Optional[list[str]] = Query(None),
    industry: Optional[list[str]] = Query(None),
    page: int = 1,
    page_size: int = 20,
):
    """Search the global brand catalog by name. Case-insensitive substring
    match. useful for the dashboard's brand picker when the user wants
    to scope the explore feed to a specific brand."""
    params: list[tuple[str, Any]] = [("keyword", keyword)]
    params.extend(_multi(platform, "platform"))
    params.extend(_multi(industry, "industry"))
    params.append(("page", str(page)))
    params.append(("page_size", str(page_size)))
    return _forward("/brands/search", params=params)


@router.get("/brands/{brand_id}/ads")
def list_brand_ads(
    brand_id: str,
    query: Optional[str] = None,
    platform: Optional[list[str]] = Query(None),
    display_format: Optional[list[str]] = Query(None),
    language: Optional[list[str]] = Query(None),
    status: Optional[list[str]] = Query(None),
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    order: str = "newest",
    page_size: int = 20,
    cursor: Optional[str] = None,
):
    """All ads from a single brand. Same filters as `list_ads` minus
    `industry` (the brand already implies an industry)."""
    params: list[tuple[str, Any]] = []
    if query:
        params.append(("query", query))
    params.extend(_multi(platform, "platform"))
    params.extend(_multi(display_format, "display_format"))
    params.extend(_multi(language, "language"))
    params.extend(_multi(status, "status"))
    if start_date:
        params.append(("start_date", start_date))
    if end_date:
        params.append(("end_date", end_date))
    params.append(("order", order))
    params.append(("page_size", str(page_size)))
    if cursor:
        params.append(("cursor", cursor))
    return _forward(f"/brands/{brand_id}/ads", params=params)
