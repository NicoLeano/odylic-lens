"""POST /api/recipes/analyze — recipe generator for the Analyze tab.

Pipeline:
1. Fetch top N winners for the brand (Task 2.10 wires real source).
2. Load brand profile via brand_profile_store.get_profile (5A).
3. Cache key = (brand, winner ids, n_recipes, profile-content-hash) (4A).
4. Optional: extract video frames for video winners (2D).
5. Call claude_client.call(strategy='subprocess', ...) — uses Max-plan
   subscription, $0 marginal (1A).
6. Persist recipes as `proposed` drafts (3C; stub until table lands).
7. Return `{ "recipes": [...] }`.

Auth-expired path surfaces as HTTP 401 with structured detail so the
frontend can render the Re-authenticate button (6A).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import tempfile
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ad_analysis_endpoints import _list_creatives_impl
import brand_profile_store
import claude_client
import store
from frame_extractor import extract_frames_concurrent

router = APIRouter()

CACHE_TTL_SECONDS = 24 * 3600
_CACHE: dict[str, tuple[float, dict]] = {}

_SYSTEM_PROMPT = (
    "You are a creative strategist who studies winning ads and proposes "
    "new ad concepts that build on what already worked, exploring fresh "
    "angles without abandoning the brand. Return valid JSON only."
)


class AnalyzeRequest(BaseModel):
    brand: str
    top_n_winners: int = Field(default=10, ge=1, le=50)
    focus_product: Optional[str] = None
    n_recipes: int = Field(default=5, ge=1, le=20)
    include_video_frames: bool = True
    regenerate: bool = False


def _fetch_top_winners(
    brand: str, top_n: int, focus_product: Optional[str]
) -> list[dict]:
    """Pull top Analyze inputs from the existing Creative Analysis data.

    The underlying endpoint is already batched at Meta's `level=ad`, so
    this avoids the per-ad insights call pattern that makes audits slow.
    """
    end = date.today()
    start = end - timedelta(days=30)
    payload = _list_creatives_impl(
        brand=brand,
        start=start.isoformat(),
        end=end.isoformat(),
        limit=max(top_n * 4, 50),
    )
    ads = payload.get("ads", []) if isinstance(payload, dict) else []
    candidates = [
        ad
        for ad in ads
        if _is_active_ad(ad)
        and _is_sales_or_conversion_ad(ad)
        and _matches_focus_product(ad, focus_product)
    ]
    candidates.sort(
        key=lambda ad: (_winner_score(ad), _num(ad.get("purchases")), _num(ad.get("spend"))),
        reverse=True,
    )
    return [_winner_prompt_row(ad) for ad in candidates[:top_n]]


def _save_proposed_drafts(brand: str, recipes: list[dict]) -> None:
    """Persist recipes as `proposed` drafts (3C + 14A)."""
    store.insert_proposed_drafts(brand, recipes)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _profile_content_hash(profile: dict) -> str:
    payload = json.dumps(profile or {}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _cache_key(
    brand: str, winners: list[dict], n_recipes: int, profile: dict
) -> str:
    """Stable hash for (brand, winner ids, n_recipes, profile content)."""
    ids = sorted(str(w.get("ad_id", "")) for w in winners)
    payload = json.dumps(
        {
            "brand": brand,
            "ids": ids,
            "n": n_recipes,
            "profile_hash": _profile_content_hash(profile),
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


def _build_prompt(
    brand_ctx: dict, winners: list[dict], n_recipes: int
) -> str:
    """Compose the user prompt for Claude. Tested via 9A snapshot."""
    return "\n".join(
        [
            "Brand context:",
            json.dumps(brand_ctx or {}, ensure_ascii=False, indent=2),
            "",
            "Top winning ads (most recent 30-day audit):",
            json.dumps(winners, ensure_ascii=False, indent=2),
            "",
            f"Recommend {n_recipes} new ad concepts that build on the patterns",
            "in the winners but explore fresh angles. Match the brand voice.",
            "",
            "Return JSON with shape:",
            (
                '{ "recipes": [ { "recipe_id": "uuid", "angle": "...", '
                '"persona": "...", "funnel_position": "top|mid|bottom", '
                '"hook": "...", "copy_outline": "...", "visual_direction": "...", '
                '"product": "...", "format": "image|video|carousel", '
                '"fal_model_hint": "flux/dev or similar", '
                '"rationale": "why this concept", '
                '"source_winner_ids": ["..."] } ] }'
            ),
        ]
    )


def _num(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _is_active_ad(ad: dict) -> bool:
    effective = str(ad.get("effective_status") or "").upper()
    configured = str(ad.get("configured_status") or ad.get("status") or "").upper()
    if effective:
        return effective == "ACTIVE"
    if configured:
        return configured == "ACTIVE"
    return True


def _is_sales_or_conversion_ad(ad: dict) -> bool:
    campaign = ad.get("campaign") if isinstance(ad.get("campaign"), dict) else {}
    objective = str(
        ad.get("objective") or ad.get("campaign_objective") or campaign.get("objective", "")
    ).upper()
    if objective:
        return objective in {"OUTCOME_SALES", "CONVERSIONS"}

    # Creative Analysis rows do not currently include campaign objective.
    # Exclude obvious non-revenue campaigns by naming convention until the
    # source endpoint grows objective fields.
    campaign_name = str(ad.get("campaign_name") or "").lower()
    adset_name = str(ad.get("adset_name") or "").lower()
    names = f"{campaign_name} {adset_name}"
    non_sales_markers = (
        "traffic",
        "awareness",
        "engagement",
        "followers",
        "follower",
        "reach",
        "views",
        "likes",
    )
    return not any(marker in names for marker in non_sales_markers)


def _matches_focus_product(ad: dict, focus_product: Optional[str]) -> bool:
    if not focus_product:
        return True
    needle = focus_product.lower()
    fields: list[Any] = [
        ad.get("product"),
        ad.get("products"),
        ad.get("ad_name"),
        ad.get("creative_name"),
        ad.get("title"),
        ad.get("body"),
    ]
    convention = ad.get("name_convention") or {}
    if isinstance(convention, dict):
        fields.append(convention.get("ad"))
        fields.append(convention.get("adset"))
    return needle in json.dumps(fields, ensure_ascii=False).lower()


def _winner_score(ad: dict) -> float:
    spend = _num(ad.get("spend"))
    roas = _num(ad.get("roas"))
    purchases = _num(ad.get("purchases"))
    cpa = _num(ad.get("cost_per_purchase") or ad.get("cpa"))
    if not cpa and purchases > 0:
        cpa = spend / purchases
    return (spend * max(roas, 0.0)) / max(cpa, 1.0)


def _creative_type(ad: dict) -> str:
    if ad.get("is_video") or ad.get("video_id") or ad.get("video_source_url"):
        return "video"
    if ad.get("carousel_cards"):
        return "carousel"
    return "image"


def _winner_prompt_row(ad: dict) -> dict:
    return {
        "ad_id": str(ad.get("ad_id") or ""),
        "name": ad.get("ad_name") or ad.get("name") or "",
        "campaign_name": ad.get("campaign_name") or "",
        "adset_name": ad.get("adset_name") or "",
        "spend": round(_num(ad.get("spend")), 2),
        "roas": round(_num(ad.get("roas")), 2),
        "purchases": int(_num(ad.get("purchases"))),
        "cpa": round(_num(ad.get("cost_per_purchase") or ad.get("cpa")), 2),
        "creative_type": _creative_type(ad),
        "hook": ad.get("title") or "",
        "body": ad.get("body") or "",
        "product": ad.get("product") or ad.get("products") or "",
        "video_url": ad.get("video_source_url") or ad.get("video_url"),
        "source_status": ad.get("effective_status") or ad.get("configured_status"),
    }


def _frames_for_winners(
    winners: list[dict], include_video_frames: bool
) -> list[str]:
    if not include_video_frames:
        return []
    video_urls = [w.get("video_url") for w in winners if w.get("video_url")]
    video_urls = [str(u) for u in video_urls[:3]]
    if not video_urls:
        return []
    tmp = Path(tempfile.mkdtemp(prefix="lens-frames-"))
    frame_groups = asyncio.run(
        extract_frames_concurrent(video_urls, n_frames=4, output_dir=tmp)
    )
    return [frame for group in frame_groups for frame in group]


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------


@router.post("/api/recipes/analyze")
def analyze_recipes(req: AnalyzeRequest) -> dict:
    winners = _fetch_top_winners(req.brand, req.top_n_winners, req.focus_product)
    profile = brand_profile_store.get_profile(req.brand) or {}

    key = _cache_key(req.brand, winners, req.n_recipes, profile)
    now = time.time()
    if not req.regenerate:
        cached = _CACHE.get(key)
        if cached and (now - cached[0] < CACHE_TTL_SECONDS):
            return cached[1]

    frames = _frames_for_winners(winners, req.include_video_frames)
    prompt = _build_prompt(profile, winners, req.n_recipes)

    try:
        result = claude_client.call(
            strategy="subprocess",
            prompt=prompt,
            system=_SYSTEM_PROMPT,
            frames=frames or None,
            timeout=180,
        )
    except claude_client.ClaudeAuthExpired as e:
        raise HTTPException(
            status_code=401,
            detail={"error": "claude_auth_expired", "message": str(e)},
        )

    recipes = result.get("recipes", []) if isinstance(result, dict) else []
    _save_proposed_drafts(req.brand, recipes)

    payload = {"recipes": recipes}
    _CACHE[key] = (now, payload)
    return payload
