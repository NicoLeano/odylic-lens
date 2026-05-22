"""Saved Reports for the Ad Analysis tab. FastAPI router.

Persists a user's named "report" snapshots (filters, picked metrics, sort,
group-by, view mode, zoom, and date ranges) to ``ads_reports.json`` at the
repo root so the Creative Analysis view can save and re-load them à la
Atria's Reports submenu.

Mount from ``api_server.py`` via:
    from ads_reports_endpoints import router as ads_reports_router
    app.include_router(ads_reports_router)

Routes (all under ``/api/ads/reports``):
    GET    ?brand=X                         -> list all reports for brand
    POST   ?brand=X   body={name,config}    -> create or update by name
    DELETE ?brand=X&name=Y                  -> remove a saved report
    PATCH  ?brand=X&name=Y body={new_name}  -> rename a saved report
    POST   /export  body={brand,name}       -> render single-file HTML report
    POST   /refresh-rolling                 -> re-export every rolling report

Storage shape (per report row):
    {
        "name":       str,
        "brand":      str,
        "created_at": iso timestamp,
        "updated_at": iso timestamp,
        "config": {
            "filters":      {...},     # dim + metric filter state
            "pickedMetrics":[...],
            "sort":         {field, dir},
            "groupBy":      str,
            "view":         'cards'|'table'|'bar'|'line',
            "zoom":         int,
            "compareStart": str|'',
            "compareEnd":   str|'',
            "start":        str,
            "end":          str,
            # Added for exportable / live-updating client reports:
            "folder":       str|'',    # client folder name on disk
            "date_mode":    'static'|'rolling_7d'|'rolling_30d'|'weekly_mon_sun'|'dynamic'|'custom',
            "title":        str|'',    # optional display title (defaults to name)
            "client":       str|'',    # optional client label
            "last_export": {"path": str, "at": iso}|None,
        }
    }

All writes use an atomic temp-rename to avoid partial JSON on crash.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel, Field

_HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS_PATH = os.path.join(_HERE, "ads_reports.json")

# Single-process guard so concurrent POST/DELETE don't clobber each other.
_lock = threading.Lock()


router = APIRouter(prefix="/api/ads/reports", tags=["ads-reports"])


# ---------------------------------------------------------------------------
# Disk I/O
# ---------------------------------------------------------------------------

def _load() -> list[dict]:
    if not os.path.exists(REPORTS_PATH):
        return []
    try:
        with open(REPORTS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
        # Legacy / accidental dict wrap. normalize to list
        if isinstance(data, dict) and isinstance(data.get("reports"), list):
            return data["reports"]
        return []
    except Exception as e:
        print(f"[warn] ads_reports load failed: {e}")
        return []


def _save(rows: list[dict]) -> None:
    tmp = REPORTS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2, ensure_ascii=False)
    os.replace(tmp, REPORTS_PATH)


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class ReportSaveBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    config: dict[str, Any] = Field(default_factory=dict)


class ReportRenameBody(BaseModel):
    new_name: str = Field(..., min_length=1, max_length=120)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
def list_reports(brand: str = Query(..., min_length=1)) -> dict:
    """Return all saved reports for the given brand, sorted by most-recently
    updated first."""
    rows = _load()
    out = [r for r in rows if r.get("brand") == brand]
    out.sort(key=lambda r: r.get("updated_at", ""), reverse=True)
    return {"reports": out}


@router.post("")
def save_report(
    brand: str = Query(..., min_length=1),
    body: ReportSaveBody = Body(...),
) -> dict:
    """Upsert a report by (brand, name). Creates if missing, updates otherwise."""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Report name cannot be empty")
    with _lock:
        rows = _load()
        now = _now()
        for r in rows:
            if r.get("brand") == brand and r.get("name") == name:
                r["config"] = body.config or {}
                r["updated_at"] = now
                _save(rows)
                return {"report": r, "created": False}
        new_row = {
            "name": name,
            "brand": brand,
            "created_at": now,
            "updated_at": now,
            "config": body.config or {},
        }
        rows.append(new_row)
        _save(rows)
        return {"report": new_row, "created": True}


@router.delete("")
def delete_report(
    brand: str = Query(..., min_length=1),
    name: str = Query(..., min_length=1),
) -> dict:
    with _lock:
        rows = _load()
        before = len(rows)
        rows = [r for r in rows if not (r.get("brand") == brand and r.get("name") == name)]
        if len(rows) == before:
            raise HTTPException(404, f"Report {name!r} not found for brand {brand!r}")
        _save(rows)
        return {"ok": True, "removed": name}


@router.patch("")
def rename_report(
    brand: str = Query(..., min_length=1),
    name: str = Query(..., min_length=1),
    body: ReportRenameBody = Body(...),
) -> dict:
    new_name = body.new_name.strip()
    if not new_name:
        raise HTTPException(400, "New name cannot be empty")
    with _lock:
        rows = _load()
        # Disallow collisions with an existing report under the same brand.
        for r in rows:
            if r.get("brand") == brand and r.get("name") == new_name and r.get("name") != name:
                raise HTTPException(409, f"A report named {new_name!r} already exists")
        target: Optional[dict] = None
        for r in rows:
            if r.get("brand") == brand and r.get("name") == name:
                r["name"] = new_name
                r["updated_at"] = _now()
                target = r
                break
        if not target:
            raise HTTPException(404, f"Report {name!r} not found for brand {brand!r}")
        _save(rows)
        return {"report": target}


# ---------------------------------------------------------------------------
# Export. render a saved report as a standalone single-file HTML
# ---------------------------------------------------------------------------
#
# A report is a frozen snapshot of the Ad Analysis view that a client opens
# locally in a browser. No login, no backend. the JS bundle, CSS, and data
# are all inlined into one `.html` file. Meta's CDN serves creative
# thumbnails/videos directly so the page is fully interactive offline.
#
# The HTML template comes from a dedicated Vite build
# (`dashboard/vite.report.config.ts`) that outputs
# `dashboard/dist-report/report.html`. The template contains a placeholder
# string `"__REPORT_DATA_PLACEHOLDER__"` which we substitute with the JSON
# payload here.


REPORT_TEMPLATE_PATH = os.path.join(
    _HERE, "dashboard", "dist-report", "report.html"
)
REPORTS_ROOT = os.path.join(_HERE, "reports")
PLACEHOLDER = '"__REPORT_DATA_PLACEHOLDER__"'


def _effective_date_range(config: dict, today: Optional[date] = None) -> tuple[str, str]:
    """Resolve the report's date window based on its `date_mode`.

    For rolling modes we anchor on "yesterday" so we never serve partial
    current-day data (Meta insights lag by hours). Weekly mode returns the
    most recent completed Mon–Sun week.
    """
    mode = str(config.get("date_mode") or "static")
    today = today or date.today()
    y = today - timedelta(days=1)
    if mode == "rolling_7d":
        return (y - timedelta(days=6)).isoformat(), y.isoformat()
    if mode == "rolling_30d":
        return (y - timedelta(days=29)).isoformat(), y.isoformat()
    if mode == "weekly_mon_sun":
        # weekday(): Mon=0 ... Sun=6. Last completed Sunday = today - (weekday+1)
        offset = today.weekday() + 1
        last_sun = today - timedelta(days=offset)
        last_mon = last_sun - timedelta(days=6)
        return last_mon.isoformat(), last_sun.isoformat()
    if mode == "dynamic":
        # Roll the saved range *length* forward. Window length is taken
        # from `dynamic_window_days` if present, else derived from the
        # original (start, end) span. Anchor on yesterday so we never
        # serve partial current-day data.
        days = config.get("dynamic_window_days")
        if not days:
            try:
                s = date.fromisoformat(str(config.get("start") or ""))
                e = date.fromisoformat(str(config.get("end") or ""))
                days = (e - s).days + 1
            except Exception:
                days = 7
        days = max(1, int(days))
        return (y - timedelta(days=days - 1)).isoformat(), y.isoformat()
    # static / custom (legacy) / anything unknown: trust the config dates
    return (
        str(config.get("start") or y.isoformat()),
        str(config.get("end") or y.isoformat()),
    )


def _slugify(name: str) -> str:
    """Turn a report name into a filesystem-safe slug.

    Spaces → hyphens, lowercase, strip anything outside [a-z0-9-_.].
    Preserves readability so `~/ad-connector/reports/Kinn/q1-review.html`
    is scannable by a human pulling the file out of Dropbox.
    """
    s = name.strip().lower()
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"[^a-z0-9\-_.]+", "", s)
    return s or "report"


# ---------------------------------------------------------------------------
# Thumbnail inlining. turn cached Meta CDN images into data: URIs so the
# standalone report HTML keeps rendering after the scontent URLs expire.
# ---------------------------------------------------------------------------

_IMAGE_CACHE_DIR = os.path.join(_HERE, "image_cache")
_MIME_BY_EXT = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "png": "image/png", "webp": "image/webp",
    "gif": "image/gif", "avif": "image/avif",
}


def _ext_from_content_type(ct: str) -> str:
    ct = (ct or "").lower().split(";")[0].strip()
    if ct == "image/jpeg": return "jpg"
    if ct == "image/png": return "png"
    if ct == "image/webp": return "webp"
    if ct == "image/gif": return "gif"
    if ct == "image/avif": return "avif"
    return "jpg"


def _cache_path(url: str, ext: str) -> str:
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    return os.path.join(_IMAGE_CACHE_DIR, f"{digest}.{ext}")


def _lookup_cached_bytes(url: str) -> Optional[tuple[bytes, str]]:
    """Read the disk-cached image for ``url`` if present. Returns (bytes, ext)."""
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    for ext in ("jpg", "png", "webp", "gif", "avif"):
        p = os.path.join(_IMAGE_CACHE_DIR, f"{digest}.{ext}")
        if os.path.exists(p):
            try:
                with open(p, "rb") as f:
                    return f.read(), ext
            except Exception:
                return None
    return None


def _fetch_and_cache(url: str) -> Optional[tuple[bytes, str]]:
    """Download an image from Meta's CDN and persist to the shared image
    cache. scontent.fbcdn.net is not Marketing-API rate limited, so this
    is safe to call freely during an export."""
    if not url or not url.startswith("http"):
        return None
    cached = _lookup_cached_bytes(url)
    if cached:
        return cached
    try:
        import requests as req  # late import. keeps module import cheap
        r = req.get(url, timeout=10, headers={"User-Agent": "AtelierReporter/1.0"})
        if r.status_code != 200 or not r.content:
            return None
        ext = _ext_from_content_type(r.headers.get("content-type", ""))
        os.makedirs(_IMAGE_CACHE_DIR, exist_ok=True)
        try:
            with open(_cache_path(url, ext), "wb") as f:
                f.write(r.content)
        except Exception:
            pass  # cache write is best-effort
        return r.content, ext
    except Exception:
        return None


def _to_data_uri(data: bytes, ext: str) -> str:
    mime = _MIME_BY_EXT.get(ext, "image/jpeg")
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


# Per-ad: pick the first URL that resolves, return a data-URI for it plus the
# keys that URL came from. Thread-safe (no shared state).
_THUMB_KEYS = ("image_url", "thumbnail_url", "image_url_hd", "thumbnail_url_low")


def _inline_one_ad(ad: dict) -> bool:
    """Mutate ``ad`` so its thumbnail fields carry a data: URI if any of
    them resolved from Meta's CDN. Returns True on success."""
    for key in _THUMB_KEYS:
        url = ad.get(key)
        if not url or not isinstance(url, str) or not url.startswith("http"):
            continue
        got = _fetch_and_cache(url)
        if not got:
            continue
        data_uri = _to_data_uri(*got)
        # Overwrite every thumbnail key with the data URI so whichever
        # fallback the client picks (image_url || thumbnail_url) works.
        for k in _THUMB_KEYS:
            if ad.get(k):
                ad[k] = data_uri
        return True
    return False


def _inline_ad_thumbnails(ads: list[dict], max_workers: int = 10) -> int:
    """Parallel-fetch every ad's thumbnail and replace the URL with a
    data: URI so the exported HTML renders offline and outlives Meta CDN
    URL expiration."""
    if not ads:
        return 0
    inlined = 0
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_inline_one_ad, a): a for a in ads}
        for fut in as_completed(futures):
            try:
                if fut.result():
                    inlined += 1
            except Exception:
                pass
    return inlined


def _build_snapshot(brand: str, start: str, end: str,
                    compare_start: Optional[str] = None,
                    compare_end: Optional[str] = None,
                    include_timeseries: bool = False) -> dict:
    """Pull every piece of data the report HTML needs so it can render
    offline with no backend.

    The returned dict mirrors the `ReportSnapshot` TypeScript type in
    `dashboard/src/components/AdAnalysisView.tsx`. keys are `ads`,
    `analyses`, `statuses`, `adIdToHash`, and optionally `timeseries`.
    """
    from ad_analysis_endpoints import ads_dashboard, creative_timeseries  # late import. avoids circular

    dash = ads_dashboard(
        brand=brand, start=start, end=end,
        compare_start=compare_start, compare_end=compare_end,
        limit=500,
    )
    snapshot = {
        "ads": dash.get("ads") or [],
        "analyses": dash.get("analyses") or {},
        "statuses": dash.get("statuses") or {},
        "adIdToHash": dash.get("ad_id_to_hash") or {},
    }

    # Swap any cached thumbnails into inline data-URIs so the standalone
    # report HTML renders offline and survives Meta CDN URL expiration.
    # Non-cached images fall through as original URLs (best-effort).
    n_inlined = _inline_ad_thumbnails(snapshot["ads"])
    print(f"[reports] inlined {n_inlined}/{len(snapshot['ads'])} thumbnails", flush=True)

    # Line view needs per-ad daily timeseries. We only fetch it when the
    # saved report's view is Line (otherwise the extra Meta calls double
    # the export time for no gain). Batch in chunks of 25 to respect the
    # endpoint's own 50-ad safety cap.
    if include_timeseries and snapshot["ads"]:
        try:
            ts: dict = {}
            ids = [str(a.get("ad_id")) for a in snapshot["ads"] if a.get("ad_id")]
            for i in range(0, len(ids), 25):
                chunk = ids[i:i + 25]
                r = creative_timeseries(
                    brand=brand, ad_ids=",".join(chunk),
                    start=start, end=end,
                )
                ts.update(r.get("series") or {})
            snapshot["timeseries"] = ts
        except Exception as e:
            # Non-fatal. Line view will just show empty series.
            print(f"[reports] timeseries fetch failed: {e}", flush=True)

    return snapshot


def _render_report_html(payload: dict) -> str:
    """Inject the payload into the singlefile template."""
    if not os.path.exists(REPORT_TEMPLATE_PATH):
        raise HTTPException(
            500,
            "Report template not built. Run: "
            "cd dashboard && npx vite build -c vite.report.config.ts",
        )
    with open(REPORT_TEMPLATE_PATH, "r", encoding="utf-8") as f:
        html = f.read()
    if PLACEHOLDER not in html:
        raise HTTPException(
            500,
            "Placeholder not found in report template. rebuild the "
            "report bundle (the Vite build may have minified it away).",
        )
    # json.dumps escapes </ as well to avoid premature </script> breakouts.
    payload_json = json.dumps(payload, default=str).replace("</", "<\\/")
    return html.replace(PLACEHOLDER, payload_json, 1)


def _export_report(brand: str, name: str) -> dict:
    """Do the actual snapshot-build + HTML write for a saved report.

    Shared between the HTTP export endpoint and `daily.py`'s rolling
    refresh loop. both end up producing `reports/<folder>/<slug>.html`.
    """
    with _lock:
        rows = _load()
        report = next(
            (r for r in rows
             if r.get("brand") == brand and r.get("name") == name),
            None,
        )
        if not report:
            raise HTTPException(404, f"Report {name!r} not found for brand {brand!r}")

    config = report.get("config") or {}
    start, end = _effective_date_range(config)
    compare_start = config.get("compareStart") or None
    compare_end = config.get("compareEnd") or None
    view = str(config.get("view") or "cards")

    snapshot = _build_snapshot(
        brand=brand, start=start, end=end,
        compare_start=compare_start, compare_end=compare_end,
        include_timeseries=(view == "line"),
    )

    payload = {
        "title": config.get("title") or name,
        "brand": brand,
        "client": config.get("client") or "",
        "folder": config.get("folder") or "",
        "date_mode": config.get("date_mode") or "static",
        "date_range": {"start": start, "end": end},
        "compare_range": (
            {"start": compare_start, "end": compare_end}
            if compare_start and compare_end else None
        ),
        "generated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "config": config,
        "snapshot": snapshot,
    }
    html = _render_report_html(payload)

    folder = _slugify(str(config.get("folder") or brand))
    out_dir = Path(REPORTS_ROOT) / folder
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{_slugify(name)}.html"
    # Atomic write so a partial file never goes live if we crash mid-write.
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_text(html, encoding="utf-8")
    os.replace(tmp, out_path)

    # Record the latest export location on the report row so the UI can
    # surface a "Reveal in Finder" affordance without re-deriving the path.
    with _lock:
        rows = _load()
        for r in rows:
            if r.get("brand") == brand and r.get("name") == name:
                r.setdefault("config", {})["last_export"] = {
                    "path": str(out_path),
                    "at": _now(),
                    "date_range": {"start": start, "end": end},
                }
                r["updated_at"] = _now()
                break
        _save(rows)

    return {
        "path": str(out_path),
        "bytes": out_path.stat().st_size,
        "ads": len(snapshot["ads"]),
        "date_range": {"start": start, "end": end},
    }


class ExportBody(BaseModel):
    brand: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)


@router.post("/export")
def export_report(_body: ExportBody = Body(...)) -> dict:
    """HTML export removed in Lens v0.2.

    Reports are local-only now; users export from the DownloadMenu in
    the toolbar (CSV via the existing csv path, PDF via the browser's
    Print → Save as PDF). The Atelier-style static-HTML render flow
    needed a separate Vite build target (``vite.report.config.ts``)
    that Lens never carried.
    """
    raise HTTPException(
        status_code=410,
        detail=(
            "HTML report export was removed in Lens v0.2. "
            "Use the Download menu in the toolbar (CSV or Save as PDF) instead."
        ),
    )


@router.post("/refresh-rolling")
def refresh_rolling_reports() -> dict:
    """Rolling-refresh re-exported the standalone HTML each day for
    every dynamic-window report. With HTML export removed, this just
    confirms the rolling date math resolves cleanly. useful as a
    health check, but does no file I/O. The frontend re-resolves
    dates on every load anyway via ``_effective_date_range``.
    """
    rows = _load()
    today = date.today()
    summary: list[dict] = []
    for r in rows:
        cfg = r.get("config") or {}
        mode = str(cfg.get("date_mode") or "static")
        if mode in ("static", "custom"):
            continue
        try:
            since, until = _effective_date_range(cfg, today=today)
            summary.append({
                "brand": r.get("brand"), "name": r.get("name"),
                "mode": mode, "since": since, "until": until,
            })
        except Exception as e:
            summary.append({
                "brand": r.get("brand"), "name": r.get("name"),
                "mode": mode, "error": str(e),
            })
    return {"resolved": summary}
