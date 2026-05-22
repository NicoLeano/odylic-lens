"""Lens-native top-level API endpoints.

These mirror Atelier's ``api_server.py`` routes but adapted for a
per-user data model. Specifically:

* ``GET /api/brands``. list the logged-in user's ad accounts (treating
  each ad account as a "brand"). Returns a payload shape compatible with
  the Atelier ``BrandSelector`` component.
* ``GET /api/metrics``. static metric catalog (Meta only; no Google).
* ``GET /api/profile``. brand-profile lookup (favicon, domain,
  description). Stored per-user in ``~/.odylic-lens/brand_profile.json``.
* ``POST /api/profile/generate-deep``. currently a 501 stub (used by
  BrandSettingsView's "deep research" button).

Plus small stubs for endpoints the ported BrandSettingsView /
AdAnalysisView reach for that don't have a real backend in Lens yet:
* ``GET/POST /api/brand-profiles/...``
* ``GET /api/planner/taxonomy*`` (returns an empty taxonomy)
* ``GET /api/trends/keywords`` (returns empty list)
* ``GET /api/planner/statuses-for-ads``, ``/api/planner/ucid-for-ad/...``
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Cookie, HTTPException, Query, Request
from pydantic import BaseModel

from auth import current_user_id
from store import (
    list_ad_accounts,
    get_brand_section,
    save_brand_section,
    list_brand_sections,
)

router = APIRouter()

# ---------------------------------------------------------------------------
# Profile store. small JSON-on-disk keyed by (user, brand).
# ---------------------------------------------------------------------------

def _profile_path() -> Path:
    base = Path(os.environ.get("LENS_DATA_DIR", str(Path.home() / ".odylic-lens")))
    base.mkdir(parents=True, exist_ok=True)
    return base / "brand_profile.json"


def _load_profiles() -> dict:
    p = _profile_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def _save_profiles(d: dict) -> None:
    p = _profile_path()
    p.write_text(json.dumps(d, indent=2))


# ---------------------------------------------------------------------------
# Brand list
# ---------------------------------------------------------------------------

@router.get("/api/brands")
def list_brands(lens_session: Optional[str] = Cookie(None)) -> list[dict]:
    """List the logged-in user's connected Meta ad accounts as 'brands'.

    The Atelier frontend uses ``brand.name`` as the canonical identifier;
    here we use the account's friendly_name (or Meta name). Google is
    always false in Lens. we only do Meta. The Meta account_id is
    returned without the ``act_`` prefix to match Atelier's format.
    """
    uid = current_user_id(lens_session)
    if not uid:
        return []
    rows = list_ad_accounts(uid)
    result: list[dict] = []
    seen: set[str] = set()
    for r in rows:
        if r.get("hidden"):
            continue
        name = (r.get("friendly_name") or r.get("name") or str(r.get("account_id") or "")).strip()
        if not name or name in seen:
            continue
        seen.add(name)
        aid = str(r.get("account_id") or "").strip()
        if aid.startswith("act_"):
            aid = aid[4:]
        result.append({
            "name": name,
            "meta": True,
            "google": False,
            "meta_account_id": aid,
            "google_account_ids": [],
        })
    result.sort(key=lambda x: x["name"].lower())
    return result


# ---------------------------------------------------------------------------
# Metrics catalog. copied verbatim from Atelier api_server.py (Meta only).
# Google catalog is dropped (Lens is Meta-only). meta_breakdowns is kept.
# ---------------------------------------------------------------------------

@router.get("/api/metrics")
def list_metrics() -> dict:
    return {
        "meta": _META_METRICS,
        "google": [],  # Lens is Meta-only; kept for shape compatibility.
        "meta_breakdowns": _META_BREAKDOWNS,
    }


_META_METRICS = [
    {"key": "spend", "label": "Spend", "format": "dollar"},
    {"key": "impressions", "label": "Impressions", "format": "number"},
    {"key": "reach", "label": "Accounts Reached", "format": "number"},
    {"key": "frequency", "label": "Frequency", "format": "decimal"},
    {"key": "clicks", "label": "Clicks (All)", "format": "number"},
    {"key": "unique_clicks", "label": "Unique Clicks", "format": "number"},
    {"key": "link_clicks", "label": "Link Clicks", "format": "number"},
    {"key": "inline_link_clicks", "label": "Inline Link Clicks", "format": "number"},
    {"key": "outbound_clicks", "label": "Outbound Clicks", "format": "number"},
    {"key": "unique_outbound_clicks", "label": "Unique Outbound Clicks", "format": "number"},
    {"key": "ctr", "label": "CTR (All)", "format": "percent"},
    {"key": "unique_ctr", "label": "Unique CTR", "format": "percent"},
    {"key": "outbound_ctr", "label": "Outbound CTR", "format": "percent"},
    {"key": "unique_outbound_ctr", "label": "Unique Outbound CTR", "format": "percent"},
    {"key": "website_ctr", "label": "Website CTR", "format": "percent"},
    {"key": "inline_link_click_ctr", "label": "Inline Link CTR", "format": "percent"},
    {"key": "unique_link_clicks_ctr", "label": "Unique Link CTR", "format": "percent"},
    {"key": "cpc", "label": "CPC (All)", "format": "dollar"},
    {"key": "cost_per_unique_click", "label": "Unique CPC", "format": "dollar"},
    {"key": "cost_per_inline_link_click", "label": "Cost per Inline Link", "format": "dollar"},
    {"key": "cpm", "label": "CPM", "format": "dollar"},
    {"key": "cpp", "label": "Cost/1K Reached", "format": "dollar"},
    {"key": "purchases", "label": "Purchases", "format": "number"},
    {"key": "revenue", "label": "Purchase Conv Value", "format": "dollar"},
    {"key": "roas", "label": "ROAS", "format": "decimal"},
    {"key": "cost_per_purchase", "label": "Cost per Purchase", "format": "dollar"},
    {"key": "add_to_cart", "label": "Add to Cart", "format": "number"},
    {"key": "atc_value", "label": "ATC Value", "format": "dollar"},
    {"key": "cost_per_atc", "label": "Cost per ATC", "format": "dollar"},
    {"key": "initiate_checkout", "label": "Initiate Checkout", "format": "number"},
    {"key": "ic_value", "label": "IC Value", "format": "dollar"},
    {"key": "cost_per_ic", "label": "Cost per IC", "format": "dollar"},
    {"key": "view_content", "label": "View Content", "format": "number"},
    {"key": "vc_value", "label": "View Content Value", "format": "dollar"},
    {"key": "cost_per_vc", "label": "Cost per View Content", "format": "dollar"},
    {"key": "leads", "label": "Leads", "format": "number"},
    {"key": "lead_value", "label": "Lead Value", "format": "dollar"},
    {"key": "cost_per_lead", "label": "Cost per Lead", "format": "dollar"},
    {"key": "landing_page_views", "label": "Landing Page Views", "format": "number"},
    {"key": "cost_per_lpv", "label": "Cost per LPV", "format": "dollar"},
    {"key": "purchase_cvr", "label": "Purchase CVR", "format": "percent"},
    {"key": "atc_cvr", "label": "ATC CVR", "format": "percent"},
    {"key": "ic_cvr", "label": "IC CVR", "format": "percent"},
    {"key": "post_engagement", "label": "Post Engagement", "format": "number"},
    {"key": "post_reactions", "label": "Post Reactions", "format": "number"},
    {"key": "post_comments", "label": "Comments", "format": "number"},
    {"key": "post_shares", "label": "Shares", "format": "number"},
    {"key": "post_saves", "label": "Saves", "format": "number"},
    {"key": "video_views", "label": "Video Views", "format": "number"},
    {"key": "thruplays", "label": "ThruPlays", "format": "number"},
    {"key": "video_p25", "label": "Video Plays 25%", "format": "number"},
    {"key": "video_p50", "label": "Video Plays 50%", "format": "number"},
    {"key": "video_p75", "label": "Video Plays 75%", "format": "number"},
    {"key": "video_p95", "label": "Video Plays 95%", "format": "number"},
    {"key": "video_p100", "label": "Video Plays 100%", "format": "number"},
    {"key": "quality_ranking", "label": "Quality Ranking", "format": "text"},
    {"key": "engagement_rate_ranking", "label": "Engagement Ranking", "format": "text"},
    {"key": "conversion_rate_ranking", "label": "Conversion Ranking", "format": "text"},
]


_META_BREAKDOWNS = [
    {"key": "none", "label": "No Breakdown"},
    {"key": "age", "label": "Age"},
    {"key": "gender", "label": "Gender"},
    {"key": "age,gender", "label": "Age & Gender"},
    {"key": "publisher_platform", "label": "Platform (FB/IG/AN)"},
    {"key": "platform_position", "label": "Platform Position"},
    {"key": "publisher_platform,platform_position", "label": "Platform & Placement"},
    {"key": "impression_device", "label": "Device"},
    {"key": "country", "label": "Country"},
    {"key": "region", "label": "Region"},
    {"key": "dma", "label": "DMA"},
    {"key": "product_id", "label": "Product ID"},
]


# ---------------------------------------------------------------------------
# Profile endpoints
# ---------------------------------------------------------------------------

@router.get("/api/profile")
def get_profile(brand: str, lens_session: Optional[str] = Cookie(None)) -> dict:
    """Lookup brand profile (favicon, domain, description, etc.).

    Reads from the per-user bucket first, then falls back to the global
    bucket (``__lens_global__``) used by Atelier-ported endpoints like
    ``/api/ads/naming-convention``. The global bucket is per-deploy shared
    state. naming conventions are deploy-wide, not per-operator.
    """
    uid = current_user_id(lens_session)
    if not uid:
        return {}
    all_profiles = _load_profiles()
    per_user = all_profiles.get(uid, {}).get(brand, {}) or {}
    glob = all_profiles.get("__lens_global__", {}).get(brand, {}) or {}
    # Merge: per-user wins for keys it sets, global fills the rest.
    return {**glob, **per_user}


class ProfileSave(BaseModel):
    brand: str
    profile: dict


@router.post("/api/profile")
def save_profile(body: ProfileSave, lens_session: Optional[str] = Cookie(None)) -> dict:
    uid = current_user_id(lens_session)
    if not uid:
        raise HTTPException(401, "Not authenticated")
    all_profiles = _load_profiles()
    user_profiles = all_profiles.setdefault(uid, {})
    user_profiles[body.brand] = body.profile
    # Mirror naming_convention into the global bucket so Atelier-ported
    # endpoints (which don't carry a user_id) can read it back. Other
    # per-user fields like deep_research don't get mirrored. only the
    # deploy-wide ones the parser layer needs.
    nc = (body.profile or {}).get("naming_convention")
    if nc:
        glob = all_profiles.setdefault("__lens_global__", {})
        brand_glob = glob.setdefault(body.brand, {})
        brand_glob["naming_convention"] = nc
        # Also write ad_name_convention for the heuristic-override path
        # used by ad_analysis_endpoints.get_naming_convention.
        brand_glob["ad_name_convention"] = nc
    _save_profiles(all_profiles)
    return {"ok": True}


@router.post("/api/profile/generate-deep")
def generate_deep_profile(brand: str, lens_session: Optional[str] = Cookie(None)) -> dict:
    """Generate a rich brand profile via Claude Sonnet, merged into any
    existing saved profile (so naming convention / manual edits the
    user already made aren't clobbered).

    Tolerates a profile that contains nothing but a domain. Claude
    fills in the rest from training-knowledge. Errors during JSON
    parsing return {"error": "..."} (not HTTP 500) so the frontend
    can surface a clean toast rather than a blank panel.
    """
    import json as _json
    import re as _re

    if not brand:
        raise HTTPException(400, "brand is required")

    uid = current_user_id(lens_session)
    if not uid:
        raise HTTPException(401, "Not authenticated")

    # Load the user's existing brand profile so we can preserve any
    # manual fields (naming_convention, custom positioning notes, etc).
    all_profiles = _load_profiles()
    existing = all_profiles.get(uid, {}).get(brand, {}) or {}
    seed_domain = (existing.get("domain") or "").strip()

    # Resolve the Anthropic key (env or encrypted SQLite). Same path
    # the ad-analysis code uses. keeps us off the SDK's confusing
    # "Could not resolve authentication method" error.
    try:
        from ad_analysis_endpoints import _resolve_anthropic_key
        api_key = _resolve_anthropic_key()
    except Exception:
        api_key = None
    if not api_key:
        raise HTTPException(
            503,
            "No Anthropic API key configured. Add one in Settings → Anthropic.",
        )

    # Build the prompt. If the user supplied a domain, pin Claude to it
    # so it doesn't wander off into a same-name brand in another market.
    domain_clause = (
        f"\nThe brand's website is `{seed_domain}`. use this as the source of truth "
        "for domain, products, colors, fonts."
        if seed_domain
        else ""
    )
    prompt = (
        f'You are a Senior Brand Strategist building a brand identity dossier '
        f'for the DTC brand "{brand}".{domain_clause}\n\n'
        'Return ONLY a single JSON object with this exact shape (no prose, no code fences):\n'
        '{\n'
        '  "domain": "brand.com",\n'
        '  "description": "2-3 sentence brand/product description, plain language",\n'
        '  "hero_products": ["product 1", "product 2", "product 3"],\n'
        '  "categories": ["specific category 1", "specific category 2"],\n'
        '  "target_personas": [\n'
        '    {"name": "First name", "description": "1-2 sentences"}\n'
        '  ],\n'
        '  "logo_url": "https://full-url-to-brand-logo.png or null if unknown",\n'
        '  "brand_colors": [\n'
        '    {"hex": "#1A1A1A", "name": "Near Black", "usage": "primary"}\n'
        '  ],\n'
        '  "brand_fonts": {"primary": "Font family", "secondary": "Font family"},\n'
        '  "products": [\n'
        '    {"name": "Product name", "description": "One-sentence summary", '
        '"hero_image": null, "price_range": "$29-$49", "sku": null}\n'
        '  ],\n'
        '  "voice_tone": "Short paragraph",\n'
        '  "competitors": ["c1", "c2", "c3"],\n'
        '  "unique_value_props": ["uvp 1", "uvp 2", "uvp 3"],\n'
        '  "social_links": {"instagram": null, "tiktok": null, "website": null}\n'
        '}\n\n'
        'Requirements: 3-5 hero_products, 2-4 categories, 2-3 target_personas, '
        '2-4 brand_colors, 3-6 products, 3-5 unique_value_props, 2-4 competitors. '
        'Plain language. No em dashes. Short sentences. If a field is unknown, '
        'use null (or [] for lists) rather than guessing. domain should be '
        '`brand.com` format (no https://). Return ONLY valid JSON.'
    )

    try:
        from anthropic import Anthropic
        client = Anthropic(api_key=api_key, timeout=120.0)
        msg = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=4000,
            messages=[{"role": "user", "content": prompt}],
        )
        parts = [getattr(b, "text", "") for b in msg.content if getattr(b, "text", None)]
        raw = "\n".join(parts).strip()
    except Exception as e:
        # Mirror Atelier's error envelope so the frontend can surface a
        # message instead of a 500-page.
        return {"error": f"Claude call failed: {e}"}

    # Strip code fences and pluck the outermost JSON object.
    cleaned = _re.sub(r"^```(?:json)?\s*|\s*```$", "", raw).strip()
    m = _re.search(r"\{[\s\S]*\}", cleaned)
    json_body = m.group(0) if m else cleaned
    try:
        deep = _json.loads(json_body)
    except _json.JSONDecodeError as e:
        return {"error": f"JSON parse failed: {e}", "raw": raw[:500]}

    # Normalize the domain (strip schema + trailing slash) and synthesize
    # the favicon URL Lens uses everywhere.
    domain = (deep.get("domain") or seed_domain or "").replace("https://", "").replace("http://", "").strip("/")
    if domain:
        deep["domain"] = domain
        deep["favicon"] = f"https://www.google.com/s2/favicons?domain={domain}&sz=64"

    # Merge: user's existing manual fields win. We do NOT overwrite
    # naming_convention, ad_name_convention, taxonomy, or any field the
    # user typed by hand. only fill in blanks.
    merged: dict = {**deep, **existing}
    # …except for the AI-generated dossier fields the user explicitly
    # asked to regenerate. Those overwrite the existing values.
    for k in (
        "description", "hero_products", "categories", "target_personas",
        "logo_url", "brand_colors", "brand_fonts", "products",
        "voice_tone", "competitors", "unique_value_props", "social_links",
        "favicon",
    ):
        if k in deep and deep[k] is not None:
            merged[k] = deep[k]

    # Persist back to per-user store.
    user_profiles = all_profiles.setdefault(uid, {})
    user_profiles[brand] = merged
    # Also mirror naming_convention into global bucket (same as save_profile).
    nc = merged.get("naming_convention")
    if nc:
        glob = all_profiles.setdefault("__lens_global__", {})
        brand_glob = glob.setdefault(brand, {})
        brand_glob["naming_convention"] = nc
        brand_glob["ad_name_convention"] = nc
    _save_profiles(all_profiles)
    return merged


# ---------------------------------------------------------------------------
# Brand-profile (multi-section). generic per-(brand, section) JSON-blob
# storage backed by SQLite. Used by the AdAnalysisView dashboard to
# auto-save its widget list, layout, and velocity-threshold config so
# the user's customizations survive across devices and incognito
# windows. Falls back to localStorage on the frontend if a fetch fails.
# ---------------------------------------------------------------------------

@router.get("/api/brand-profiles/{brand}")
def get_brand_profile(brand: str) -> dict:
    return {"brand": brand, "sections": list_brand_sections(brand)}


@router.post("/api/brand-profiles/{brand}")
def save_brand_profile(brand: str, body: dict) -> dict:
    # Bulk save: body may be either {"sections": {section: data, ...}}
    # or a bare {section: data, ...} dict. We accept both forms so the
    # frontend can save several at once without an extra envelope.
    sections = body.get("sections") if isinstance(body, dict) and "sections" in body else body
    if not isinstance(sections, dict):
        sections = {}
    for section, data in sections.items():
        if isinstance(data, dict):
            save_brand_section(brand, section, data)
    return {"ok": True, "brand": brand, "sections_saved": list(sections.keys())}


@router.get("/api/brand-profiles/{brand}/section/{section}")
def get_brand_profile_section(brand: str, section: str) -> dict:
    data = get_brand_section(brand, section)
    return {"brand": brand, "section": section, "data": data or {}}


@router.post("/api/brand-profiles/{brand}/section/{section}")
async def save_brand_profile_section(brand: str, section: str, request: Request) -> dict:
    # Accept either a raw JSON dict or {"data": {...}} envelope so that
    # navigator.sendBeacon clients (which can only POST text/plain
    # blobs) and regular fetch clients both work without front-end
    # special cases.
    body_bytes = await request.body()
    try:
        body = json.loads(body_bytes.decode("utf-8") or "{}")
    except Exception:
        body = {}
    if isinstance(body, dict) and "data" in body and isinstance(body["data"], dict):
        data = body["data"]
    elif isinstance(body, dict):
        data = body
    else:
        data = {}
    save_brand_section(brand, section, data)
    return {"ok": True, "brand": brand, "section": section}


# ---------------------------------------------------------------------------
# Planner taxonomy + trends + planner status. Lens stubs.
# These endpoints exist in Atelier; the BrandSettingsView calls them but
# Lens doesn't ship the planner. We return empty payloads so the UI
# renders without errors.
# ---------------------------------------------------------------------------

@router.get("/api/planner/taxonomy")
def planner_taxonomy(brand: str = "") -> dict:
    return {"brand": brand, "taxonomy": {}, "lists": {}}


@router.post("/api/planner/taxonomy")
def save_planner_taxonomy(body: dict) -> dict:
    return {"ok": True}


@router.get("/api/planner/taxonomy/template")
def planner_taxonomy_template() -> dict:
    return {"template": {}}


@router.post("/api/planner/taxonomy/import")
def planner_taxonomy_import(body: dict) -> dict:
    return {"ok": True, "imported": 0}


@router.get("/api/planner/statuses-for-ads")
def planner_statuses_for_ads(brand: str = "", ad_ids: str = "") -> dict:
    return {"brand": brand, "statuses": {}}


@router.get("/api/planner/ucid-for-ad/{ad_id}")
def planner_ucid_for_ad(ad_id: str) -> dict:
    return {"ad_id": ad_id, "ucid": None}


@router.get("/api/planner/ucid-for-hash/{img_hash}")
def planner_ucid_for_hash(img_hash: str) -> dict:
    return {"img_hash": img_hash, "ucid": None}


@router.get("/api/trends/keywords")
def trends_keywords(brand: str = "") -> dict:
    return {"brand": brand, "keywords": []}


@router.post("/api/trends/keywords")
def save_trends_keywords(body: dict) -> dict:
    return {"ok": True}


# Boards, Reports, and Atria are all served by their own routers
# (boards_endpoints.py / ads_reports_endpoints.py / atria_endpoints.py),
# mounted ahead of this one in main.py. Nothing else to stub here.
