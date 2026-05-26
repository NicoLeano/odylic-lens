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

import hashlib
import json
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import brand_profile_store
import claude_client
from frame_extractor import extract_frames

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


# ---------------------------------------------------------------------------
# Stubs — replaced with real wiring in Task 2.10
# ---------------------------------------------------------------------------


def _fetch_top_winners(
    brand: str, top_n: int, focus_product: Optional[str]
) -> list[dict]:
    """Pull top N winners. Real wiring at Task 2.10 calls
    ad_analysis_endpoints._list_creatives_impl over the last 30 days."""
    return []


def _save_proposed_drafts(brand: str, recipes: list[dict]) -> None:
    """Persist recipes as `proposed` drafts (3C). Real wiring at Task
    2.10 inserts into the drafts table that lands with that task."""
    return None


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


def _frames_for_winners(
    winners: list[dict], include_video_frames: bool
) -> list[str]:
    """Pull frames from the first video winner. Multi-video concurrent
    extraction lands at Task 2.10 when real winner data flows."""
    if not include_video_frames:
        return []
    for w in winners:
        url = w.get("video_url")
        if url:
            tmp = Path(tempfile.mkdtemp(prefix="lens-frames-"))
            return extract_frames(video_url=url, n_frames=8, output_dir=tmp)
    return []


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
