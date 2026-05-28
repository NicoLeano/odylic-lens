"""POST /api/recipes/analyze — recipe generator for the Analyze tab.

Pipeline:
1. Fetch top N winners for the brand (Task 2.10 wires real source).
2. Load brand profile via brand_profile_store.get_profile (5A).
3. Cache key = brand, winner signal, rejection feedback, recipe count, profile hash (4A).
4. Optional: extract video frames for video winners (2D).
5. Call claude_client.call(strategy='subprocess', ...) — uses Max-plan
   subscription, $0 marginal (1A).
6. Persist recipes as `proposed` drafts (3C).
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

from fastapi import APIRouter, Cookie, Depends, HTTPException
from pydantic import BaseModel, Field

from ad_analysis_endpoints import _analyses_for_hashes, _list_creatives_impl
from auth import require_user
import brand_profile_store
import claude_client
import store
from frame_extractor import extract_frames_concurrent

router = APIRouter()

CACHE_TTL_SECONDS = 24 * 3600
_CACHE: dict[str, tuple[float, dict]] = {}
PROFILE_PROMPT_MAX_KEYS = 6
PROFILE_TEXT_MAX_CHARS = 120
WINNER_TEXT_MAX_CHARS = 80
WINNER_ANALYSIS_TEXT_MAX_CHARS = 140
WINNER_TRANSCRIPT_TEXT_MAX_CHARS = 400
REJECTION_TEXT_MAX_CHARS = 160

_PROFILE_REQUIRED_PROMPT_KEYS = (
    "products",
    "hero_products",
    "proof_points",
    "objections",
    "claims_allowed",
    "claims_avoided",
    "dont_say",
)

_SYSTEM_PROMPT = (
    "You are a creative strategist who studies winning ads and proposes "
    "new ad concepts that build on what already worked, exploring fresh "
    "angles without abandoning the brand. Return valid JSON only."
)

_PROFILE_PROMPT_KEYS = (
    "positioning_statement",
    "primary_persona",
    "target_audience",
    "target_personas",
    "products",
    "hero_products",
    "unique_value_props",
    "functional_benefits",
    "emotional_benefits",
    "proof_points",
    "voice",
    "voice_tone",
    "voice_attributes",
    "claims_allowed",
    "claims_avoided",
    "differentiator",
    "description",
    "tagline",
    "mission_statement",
    "secondary_personas",
    "objections",
    "do_say",
    "dont_say",
    "competitive_frame",
)


class AnalyzeRequest(BaseModel):
    brand: str
    top_n_winners: int = Field(default=10, ge=1, le=50)
    focus_product: Optional[str] = None
    n_recipes: int = Field(default=5, ge=1, le=20)
    include_video_frames: bool = False
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
    winners = candidates[:top_n]
    _attach_cached_analysis(winners)
    return [_winner_prompt_row(ad) for ad in winners]


def _save_proposed_drafts(brand: str, recipes: list[dict]) -> list[str]:
    """Persist recipes as `proposed` drafts (3C + 14A)."""
    return store.insert_proposed_drafts(brand, recipes)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _profile_content_hash(profile: dict) -> str:
    # Cache invalidation intentionally hashes the full profile. The prompt
    # below sends a compact subset to Claude to stay under CLI limits, but a
    # hidden brand-field edit must still bust cached recipes (decision 4A).
    payload = json.dumps(profile or {}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _cache_key(
    brand: str,
    winners: list[dict],
    rejected_patterns: list[dict],
    top_n_winners: int,
    n_recipes: int,
    profile: dict,
    focus_product: Optional[str] = None,
    include_video_frames: bool = False,
) -> str:
    """Stable hash for request inputs that can change recipe content."""
    ids = sorted(str(w.get("ad_id", "")) for w in winners)
    analysis_payload = [
        {
            "ad_id": str(w.get("ad_id", "")),
            "analysis": _compact_analysis_for_prompt(w.get("analysis")),
            "transcript": _clip_text(
                w.get("transcript") or w.get("video_transcript"),
                max_chars=WINNER_TRANSCRIPT_TEXT_MAX_CHARS,
            ),
        }
        for w in sorted(winners, key=lambda item: str(item.get("ad_id", "")))
    ]
    rejection_payload = [
        item for item in (
            _compact_rejection_for_prompt(draft)
            for draft in sorted(
                rejected_patterns,
                key=lambda draft: str(draft.get("draft_id", "")),
            )
        )
        if item
    ]
    payload = json.dumps(
        {
            "brand": brand,
            "ids": ids,
            "analysis": analysis_payload,
            "rejected": rejection_payload,
            "top_n_winners": top_n_winners,
            "n": n_recipes,
            "focus_product": focus_product or "",
            "profile_hash": _profile_content_hash(profile),
            "include_video_frames": include_video_frames,
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


def _build_prompt(
    brand_ctx: dict,
    winners: list[dict],
    n_recipes: int,
    rejected_patterns: Optional[list[dict]] = None,
) -> str:
    """Compose the user prompt for Claude. Tested via 9A snapshot."""
    prompt_brand_ctx = _compact_profile_for_prompt(brand_ctx)
    prompt_winners = [_compact_winner_for_prompt(w) for w in winners]
    prompt_rejections = [
        item for item in (
            _compact_rejection_for_prompt(draft)
            for draft in (rejected_patterns or [])
        )
        if item
    ]
    return "\n".join(
        [
            "Brand context:",
            json.dumps(prompt_brand_ctx, ensure_ascii=False, separators=(",", ":")),
            "",
            "Top winning ads (most recent 30-day audit):",
            json.dumps(prompt_winners, ensure_ascii=False, separators=(",", ":")),
            "",
            "Recent rejected recipe patterns (avoid repeating these):",
            json.dumps(prompt_rejections, ensure_ascii=False, separators=(",", ":")),
            "",
            f"Recommend {n_recipes} new ad concepts that build on the patterns",
            "in the winners but explore fresh angles. Match the brand voice.",
            'For "fal_model_hint", return one short token only: "default" or "kling".',
            "Do not include model explanations, alternatives, or prose in that field.",
            "",
            "Return JSON with shape:",
            (
                '{ "recipes": [ { "recipe_id": "uuid", "angle": "...", '
                '"persona": "...", "funnel_position": "top|mid|bottom", '
                '"hook": "...", "copy_outline": "...", "visual_direction": "...", '
                '"product": "...", "format": "image|video|carousel", '
                '"fal_model_hint": "default|kling", '
                '"rationale": "why this concept", '
                '"source_winner_ids": ["..."] } ] }'
            ),
        ]
    )


def _clip_text(value: Any, max_chars: int = PROFILE_TEXT_MAX_CHARS) -> str:
    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    return f"{text[: max_chars - 3].rstrip()}..."


def _prompt_safe_value(value: Any, depth: int = 2) -> Any:
    if value in (None, "", [], {}):
        return None
    if isinstance(value, str):
        return _clip_text(value)
    if isinstance(value, (int, float, bool)):
        return value
    if depth <= 0:
        return _clip_text(json.dumps(value, ensure_ascii=False), max_chars=100)
    if isinstance(value, list):
        compacted = [_prompt_safe_value(v, depth - 1) for v in value[:3]]
        return [v for v in compacted if v not in (None, "", [], {})]
    if isinstance(value, dict):
        compacted: dict[str, Any] = {}
        for key, child in list(value.items())[:4]:
            safe = _prompt_safe_value(child, depth - 1)
            if safe not in (None, "", [], {}):
                compacted[str(key)] = safe
        return compacted or None
    return _clip_text(value)


def _compact_profile_for_prompt(profile: dict) -> dict:
    compacted: dict[str, Any] = {}
    # Required keys are the brand-safety and offer-accuracy signal that
    # should not be crowded out by broad positioning fields when the compact
    # prompt hits PROFILE_PROMPT_MAX_KEYS.
    ordered_keys = (
        *[key for key in _PROFILE_REQUIRED_PROMPT_KEYS if key in (profile or {})],
        *[key for key in _PROFILE_PROMPT_KEYS if key not in _PROFILE_REQUIRED_PROMPT_KEYS],
    )
    for key in ordered_keys:
        if len(compacted) >= PROFILE_PROMPT_MAX_KEYS:
            break
        if key not in (profile or {}):
            continue
        safe = _prompt_safe_value(profile.get(key))
        if safe not in (None, "", [], {}):
            compacted[key] = safe
    return compacted


def _compact_winner_for_prompt(winner: dict) -> dict:
    fields = (
        "ad_id",
        "name",
        "spend",
        "roas",
        "purchases",
        "cpa",
        "creative_type",
        "hook",
        "body",
        "product",
    )
    compacted: dict[str, Any] = {}
    for key in fields:
        value = winner.get(key)
        if value in (None, "", [], {}):
            continue
        if key == "body":
            compacted[key] = _clip_text(value, WINNER_TEXT_MAX_CHARS)
        elif key in {"hook", "product", "name"}:
            compacted[key] = _clip_text(value, max_chars=70)
        else:
            compacted[key] = value
    analysis = _compact_analysis_for_prompt(winner.get("analysis"))
    if analysis:
        compacted["analysis"] = analysis
    transcript = _clip_text(
        winner.get("transcript") or winner.get("video_transcript"),
        max_chars=WINNER_TRANSCRIPT_TEXT_MAX_CHARS,
    )
    if transcript:
        compacted["transcript"] = transcript
    return compacted


def _compact_analysis_for_prompt(analysis: Any) -> dict[str, Any]:
    if not isinstance(analysis, dict) or analysis.get("error"):
        return {}
    fields = (
        "angle",
        "hook",
        "concept",
        "persona",
        "template",
        "marketAwareness",
        "marketSophistication",
        "funnelPosition",
        "sentiment",
        "emotion",
        "style",
        "offer",
        "messagingDifferentiationScore",
        "messagingDifferentiationSummary",
        "visualDifferentiationScore",
        "visualDifferentiationSummary",
    )
    compacted: dict[str, Any] = {}
    for key in fields:
        value = analysis.get(key)
        if value in (None, "", [], {}):
            continue
        if isinstance(value, str):
            compacted[key] = _clip_text(value, max_chars=WINNER_ANALYSIS_TEXT_MAX_CHARS)
        elif isinstance(value, (int, float, bool)):
            compacted[key] = value
    return compacted


def _compact_rejection_for_prompt(draft: dict) -> dict[str, Any]:
    recipe = draft.get("recipe") if isinstance(draft.get("recipe"), dict) else {}
    reason = _clip_text(draft.get("rejection_reason"), max_chars=REJECTION_TEXT_MAX_CHARS)
    if not reason:
        return {}
    compacted: dict[str, Any] = {
        "reason": reason,
    }
    for key in ("angle", "hook", "persona", "product", "format"):
        value = recipe.get(key)
        if value not in (None, "", [], {}):
            compacted[key] = _clip_text(value, max_chars=REJECTION_TEXT_MAX_CHARS)
    source_ids = draft.get("source_winner_ids") or recipe.get("source_winner_ids")
    if isinstance(source_ids, list) and source_ids:
        compacted["source_winner_ids"] = [str(value) for value in source_ids[:3]]
    return compacted


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


def _attach_cached_analysis(ads: list[dict]) -> None:
    hashes = {str(ad.get("creative_hash")) for ad in ads if ad.get("creative_hash")}
    ids = {str(ad.get("ad_id")) for ad in ads if ad.get("ad_id")}
    if not hashes and not ids:
        return
    try:
        analyses, ad_id_to_hash = _analyses_for_hashes(hashes, ids)
    except Exception:
        return
    for ad in ads:
        chash = str(ad.get("creative_hash") or "")
        if not chash:
            chash = ad_id_to_hash.get(str(ad.get("ad_id") or ""), "")
        entry = analyses.get(chash) if chash else None
        analysis = entry.get("analysis") if isinstance(entry, dict) else None
        if isinstance(analysis, dict):
            ad["analysis"] = analysis


def _first_nonempty(ad: dict, keys: tuple[str, ...]) -> Any:
    for key in keys:
        value = ad.get(key)
        if value not in (None, "", [], {}):
            return value
    return None


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
        "analysis": _first_nonempty(ad, ("analysis", "creative_analysis", "ai_analysis")),
        "transcript": _first_nonempty(
            ad,
            (
                "transcript",
                "video_transcript",
                "whisper_transcript",
                "script",
                "video_script",
            ),
        ),
        "video_url": ad.get("video_source_url") or ad.get("video_url"),
        "source_status": ad.get("effective_status") or ad.get("configured_status"),
    }


def _frames_for_winners(
    winners: list[dict], include_video_frames: bool, output_dir: Path
) -> list[str]:
    if not include_video_frames:
        return []
    video_urls = [w.get("video_url") for w in winners if w.get("video_url")]
    video_urls = [str(u) for u in video_urls[:3]]
    if not video_urls:
        return []
    frame_groups = asyncio.run(
        extract_frames_concurrent(video_urls, n_frames=4, output_dir=output_dir)
    )
    return [frame for group in frame_groups for frame in group]


def _fetch_rejected_patterns(brand: str) -> list[dict]:
    try:
        return store.list_rejected_recipe_feedback(brand, limit=20)
    except Exception:
        # Feedback is advisory; Analyze should still run if local draft lookup fails.
        return []


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------


def _require_authenticated_user(lens_session: Optional[str] = Cookie(None)) -> str:
    return require_user(lens_session)


@router.post("/api/recipes/analyze")
def analyze_recipes(
    req: AnalyzeRequest, _fb_user_id: str = Depends(_require_authenticated_user)
) -> dict:
    winners = _fetch_top_winners(req.brand, req.top_n_winners, req.focus_product)
    profile = brand_profile_store.get_profile(req.brand) or {}
    rejected_patterns = _fetch_rejected_patterns(req.brand)

    key = _cache_key(
        req.brand,
        winners,
        rejected_patterns,
        req.top_n_winners,
        req.n_recipes,
        profile,
        focus_product=req.focus_product,
        include_video_frames=req.include_video_frames,
    )
    now = time.time()
    if not req.regenerate:
        cached = _CACHE.get(key)
        if cached and (now - cached[0] < CACHE_TTL_SECONDS):
            return cached[1]

    with tempfile.TemporaryDirectory(prefix="lens-frames-") as frame_dir:
        frames = _frames_for_winners(
            winners, req.include_video_frames, output_dir=Path(frame_dir)
        )
        if frames:
            raise HTTPException(
                status_code=501,
                detail=(
                    "Video frame attachment is not supported by the Claude CLI "
                    "path yet. Retry with include_video_frames=false."
                ),
            )
    prompt = _build_prompt(profile, winners, req.n_recipes, rejected_patterns)

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
    draft_ids = _save_proposed_drafts(req.brand, recipes)
    recipes = [
        {**recipe, "draft_id": draft_ids[i]}
        if i < len(draft_ids) and isinstance(recipe, dict)
        else recipe
        for i, recipe in enumerate(recipes)
    ]

    payload = {"recipes": recipes}
    _CACHE[key] = (now, payload)
    return payload
