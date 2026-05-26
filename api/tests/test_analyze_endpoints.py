"""Tests for POST /api/recipes/analyze — Lens recipe generator.

Covers Task 2.8 of the fork plan, with decisions:
- 1A: claude_client.call(strategy="subprocess", ...) for the LLM call
- 3C: writes `proposed` drafts rows via _save_proposed_drafts stub
- 4A: cache key includes brand-profile content hash
- 6A: ClaudeAuthExpired surfaces as HTTP 401 with structured payload
- 9A: _build_prompt content-correctness check + frame integration
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _clear_cache():
    """Reset the module-level recipe cache between tests."""
    import analyze_endpoints

    analyze_endpoints._CACHE.clear()
    yield
    analyze_endpoints._CACHE.clear()


@pytest.fixture
def client():
    """FastAPI test client with analyze_endpoints router mounted."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from analyze_endpoints import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


# ---------------------------------------------------------------------------
# Test fixtures — keep payload shapes close to production
# ---------------------------------------------------------------------------

_FAKE_WINNER_IMAGE = {
    "ad_id": "120211111111111111",
    "name": "Calm Cacao — sleep angle",
    "spend": 1834.50,
    "roas": 3.4,
    "purchases": 42,
    "cpa": 43.7,
    "creative_type": "image",
}

_FAKE_WINNER_VIDEO = {
    "ad_id": "120222222222222222",
    "name": "Mushroom Coffee — focus angle",
    "spend": 2103.00,
    "roas": 2.9,
    "purchases": 51,
    "cpa": 41.2,
    "creative_type": "video",
    "video_url": "https://scontent.cdn/ad.mp4",
}

_FAKE_BRAND_PROFILE = {
    "products": ["Calm Cacao", "Mushroom Coffee"],
    "voice": "warm, Spanish MX",
    "target_audience": "45+ women",
}

_FAKE_RECIPE_RESPONSE = {
    "recipes": [
        {
            "recipe_id": "r1",
            "angle": "Benefits",
            "persona": "45+ MX women anxious sleepers",
            "funnel_position": "mid",
            "hook": "¿Dormir mejor sin pastillas?",
            "copy_outline": "...",
            "visual_direction": "...",
            "product": "Calm Cacao",
            "format": "image",
            "fal_model_hint": "flux/dev",
            "rationale": "Sleep angle proven by winner 120211...",
            "source_winner_ids": ["120211111111111111"],
        }
    ]
}


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_analyze_returns_recipe_list(client):
    """POST /api/recipes/analyze returns list of recipe dicts."""
    with patch(
        "analyze_endpoints._fetch_top_winners", return_value=[_FAKE_WINNER_IMAGE]
    ), patch(
        "analyze_endpoints.brand_profile_store.get_profile",
        return_value=_FAKE_BRAND_PROFILE,
    ), patch(
        "analyze_endpoints.claude_client.call", return_value=_FAKE_RECIPE_RESPONSE
    ), patch(
        "analyze_endpoints._save_proposed_drafts"
    ):
        response = client.post(
            "/api/recipes/analyze",
            json={"brand": "DOSE OF", "top_n_winners": 1, "n_recipes": 1},
        )

    assert response.status_code == 200
    body = response.json()
    assert len(body["recipes"]) == 1
    assert body["recipes"][0]["angle"] == "Benefits"
    assert body["recipes"][0]["product"] == "Calm Cacao"


def test_analyze_uses_subprocess_strategy_for_claude(client):
    """1A: Analyze calls claude_client.call with strategy='subprocess'."""
    with patch(
        "analyze_endpoints._fetch_top_winners", return_value=[_FAKE_WINNER_IMAGE]
    ), patch(
        "analyze_endpoints.brand_profile_store.get_profile",
        return_value=_FAKE_BRAND_PROFILE,
    ), patch(
        "analyze_endpoints.claude_client.call", return_value=_FAKE_RECIPE_RESPONSE
    ) as mock_call, patch(
        "analyze_endpoints._save_proposed_drafts"
    ):
        client.post(
            "/api/recipes/analyze",
            json={"brand": "DOSE OF", "top_n_winners": 1, "n_recipes": 1},
        )

    assert mock_call.called
    kwargs = mock_call.call_args.kwargs
    assert kwargs.get("strategy") == "subprocess"
    assert isinstance(kwargs.get("prompt"), str)


def test_analyze_writes_proposed_drafts(client):
    """3C: Analyze persists recipes as `proposed` drafts."""
    with patch(
        "analyze_endpoints._fetch_top_winners", return_value=[_FAKE_WINNER_IMAGE]
    ), patch(
        "analyze_endpoints.brand_profile_store.get_profile",
        return_value=_FAKE_BRAND_PROFILE,
    ), patch(
        "analyze_endpoints.claude_client.call", return_value=_FAKE_RECIPE_RESPONSE
    ), patch(
        "analyze_endpoints._save_proposed_drafts"
    ) as mock_save:
        client.post(
            "/api/recipes/analyze",
            json={"brand": "DOSE OF", "top_n_winners": 1, "n_recipes": 1},
        )

    assert mock_save.call_count == 1
    args, kwargs = mock_save.call_args
    saved_brand = args[0] if args else kwargs.get("brand")
    saved_recipes = args[1] if len(args) > 1 else kwargs.get("recipes")
    assert saved_brand == "DOSE OF"
    assert len(saved_recipes) == 1


# ---------------------------------------------------------------------------
# Cache behavior (decision 4A)
# ---------------------------------------------------------------------------


def test_analyze_caches_within_24h(client):
    """Second call with same brand/winners/profile returns cached result."""
    with patch(
        "analyze_endpoints._fetch_top_winners", return_value=[_FAKE_WINNER_IMAGE]
    ), patch(
        "analyze_endpoints.brand_profile_store.get_profile",
        return_value=_FAKE_BRAND_PROFILE,
    ), patch(
        "analyze_endpoints.claude_client.call", return_value=_FAKE_RECIPE_RESPONSE
    ) as mock_call, patch(
        "analyze_endpoints._save_proposed_drafts"
    ):
        body = {"brand": "DOSE OF", "top_n_winners": 1, "n_recipes": 1}
        client.post("/api/recipes/analyze", json=body)
        client.post("/api/recipes/analyze", json=body)

    assert mock_call.call_count == 1


def test_analyze_regenerate_bypasses_cache(client):
    """regenerate=true forces a fresh claude call."""
    with patch(
        "analyze_endpoints._fetch_top_winners", return_value=[_FAKE_WINNER_IMAGE]
    ), patch(
        "analyze_endpoints.brand_profile_store.get_profile",
        return_value=_FAKE_BRAND_PROFILE,
    ), patch(
        "analyze_endpoints.claude_client.call", return_value=_FAKE_RECIPE_RESPONSE
    ) as mock_call, patch(
        "analyze_endpoints._save_proposed_drafts"
    ):
        body = {"brand": "DOSE OF", "top_n_winners": 1, "n_recipes": 1}
        client.post("/api/recipes/analyze", json=body)
        client.post(
            "/api/recipes/analyze", json={**body, "regenerate": True}
        )

    assert mock_call.call_count == 2


def test_analyze_cache_invalidates_on_profile_change(client):
    """4A: editing Voice & Tone (profile content) busts cache automatically."""
    body = {"brand": "DOSE OF", "top_n_winners": 1, "n_recipes": 1}
    profile_v1 = {**_FAKE_BRAND_PROFILE, "voice": "warm, Spanish MX"}
    profile_v2 = {**_FAKE_BRAND_PROFILE, "voice": "energetic, Spanish MX"}

    with patch(
        "analyze_endpoints._fetch_top_winners", return_value=[_FAKE_WINNER_IMAGE]
    ), patch(
        "analyze_endpoints.brand_profile_store.get_profile"
    ) as mock_prof, patch(
        "analyze_endpoints.claude_client.call", return_value=_FAKE_RECIPE_RESPONSE
    ) as mock_call, patch(
        "analyze_endpoints._save_proposed_drafts"
    ):
        mock_prof.return_value = profile_v1
        client.post("/api/recipes/analyze", json=body)

        # Voice edit → next call must NOT hit cache
        mock_prof.return_value = profile_v2
        client.post("/api/recipes/analyze", json=body)

    assert mock_call.call_count == 2


# ---------------------------------------------------------------------------
# Video frames (decision 2D integration)
# ---------------------------------------------------------------------------


def test_analyze_passes_video_frames_to_claude(client):
    """Video winners → extract_frames → frames param on claude call."""
    fake_frames = ["/tmp/f1.jpg", "/tmp/f2.jpg", "/tmp/f3.jpg"]

    with patch(
        "analyze_endpoints._fetch_top_winners", return_value=[_FAKE_WINNER_VIDEO]
    ), patch(
        "analyze_endpoints.brand_profile_store.get_profile",
        return_value=_FAKE_BRAND_PROFILE,
    ), patch(
        "analyze_endpoints.extract_frames", return_value=fake_frames
    ) as mock_ex, patch(
        "analyze_endpoints.claude_client.call", return_value={"recipes": []}
    ) as mock_call, patch(
        "analyze_endpoints._save_proposed_drafts"
    ):
        client.post(
            "/api/recipes/analyze",
            json={
                "brand": "DOSE OF",
                "top_n_winners": 1,
                "n_recipes": 1,
                "include_video_frames": True,
            },
        )

    mock_ex.assert_called_once()
    assert mock_call.call_args.kwargs.get("frames") == fake_frames


def test_analyze_skips_frames_when_flag_disabled(client):
    """include_video_frames=False keeps extract_frames silent."""
    with patch(
        "analyze_endpoints._fetch_top_winners", return_value=[_FAKE_WINNER_VIDEO]
    ), patch(
        "analyze_endpoints.brand_profile_store.get_profile",
        return_value=_FAKE_BRAND_PROFILE,
    ), patch(
        "analyze_endpoints.extract_frames"
    ) as mock_ex, patch(
        "analyze_endpoints.claude_client.call", return_value={"recipes": []}
    ), patch(
        "analyze_endpoints._save_proposed_drafts"
    ):
        client.post(
            "/api/recipes/analyze",
            json={
                "brand": "DOSE OF",
                "top_n_winners": 1,
                "n_recipes": 1,
                "include_video_frames": False,
            },
        )

    mock_ex.assert_not_called()


# ---------------------------------------------------------------------------
# Auth failure (decision 6A)
# ---------------------------------------------------------------------------


def test_analyze_returns_401_when_claude_auth_expired(client):
    """6A: ClaudeAuthExpired → HTTP 401 with structured payload."""
    from claude_client import ClaudeAuthExpired

    with patch(
        "analyze_endpoints._fetch_top_winners", return_value=[_FAKE_WINNER_IMAGE]
    ), patch(
        "analyze_endpoints.brand_profile_store.get_profile",
        return_value=_FAKE_BRAND_PROFILE,
    ), patch(
        "analyze_endpoints.claude_client.call",
        side_effect=ClaudeAuthExpired("session expired"),
    ), patch(
        "analyze_endpoints._save_proposed_drafts"
    ):
        response = client.post(
            "/api/recipes/analyze",
            json={"brand": "DOSE OF", "top_n_winners": 1, "n_recipes": 1},
        )

    assert response.status_code == 401
    body = response.json()
    assert body.get("detail", {}).get("error") == "claude_auth_expired"


# ---------------------------------------------------------------------------
# Prompt content (9A — content-correctness snapshot)
# ---------------------------------------------------------------------------


def test_build_prompt_includes_brand_winners_and_count():
    """9A: prompt must surface brand context + winner ids + recipe count."""
    from analyze_endpoints import _build_prompt

    prompt = _build_prompt(
        brand_ctx=_FAKE_BRAND_PROFILE,
        winners=[_FAKE_WINNER_IMAGE, _FAKE_WINNER_VIDEO],
        n_recipes=3,
    )

    # Brand context surfaces
    assert "Calm Cacao" in prompt
    assert "45+ women" in prompt
    # Winner ids surface
    assert _FAKE_WINNER_IMAGE["ad_id"] in prompt
    assert _FAKE_WINNER_VIDEO["ad_id"] in prompt
    # Recipe count surfaces
    assert "3" in prompt
    # JSON shape hint surfaces (so model returns parseable structure)
    assert "recipes" in prompt
    assert "angle" in prompt
