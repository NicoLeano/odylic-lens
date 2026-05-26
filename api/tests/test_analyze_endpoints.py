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
import sqlite3
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


def test_save_proposed_drafts_inserts_proposed_rows(tmp_path, monkeypatch):
    """Task 2.10: Analyze recipes persist to the real drafts table."""
    db_path = tmp_path / "lens.db"
    monkeypatch.setenv("LENS_DB_PATH", str(db_path))

    import store
    from analyze_endpoints import _save_proposed_drafts

    store.init_db()
    _save_proposed_drafts("DOSE OF", [_FAKE_RECIPE_RESPONSE["recipes"][0]])

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT brand, status, recipe_json, source_winner_ids FROM drafts WHERE recipe_id = ?",
        ("r1",),
    ).fetchone()
    assets_table = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'draft_assets'"
    ).fetchone()
    conn.close()

    assert row is not None
    assert row["brand"] == "DOSE OF"
    assert row["status"] == "proposed"
    assert json.loads(row["recipe_json"])["angle"] == "Benefits"
    assert json.loads(row["source_winner_ids"]) == ["120211111111111111"]
    assert assets_table is not None


def test_insert_proposed_drafts_rolls_back_on_bad_recipe(tmp_path, monkeypatch):
    """14A: malformed recipe batch leaves no partially inserted rows."""
    db_path = tmp_path / "lens.db"
    monkeypatch.setenv("LENS_DB_PATH", str(db_path))

    import store

    store.init_db()
    with pytest.raises(ValueError):
        store.insert_proposed_drafts(
            "DOSE OF", [_FAKE_RECIPE_RESPONSE["recipes"][0], "not-a-recipe"]
        )

    conn = sqlite3.connect(db_path)
    count = conn.execute("SELECT COUNT(*) FROM drafts").fetchone()[0]
    conn.close()
    assert count == 0


def test_fetch_top_winners_uses_real_creatives_filters_scope_and_product():
    """Task 2.10: winners come from Creative Analysis, active sales ads only."""
    from analyze_endpoints import _fetch_top_winners

    ads = [
        {
            "ad_id": "winner",
            "ad_name": "Calm cacao main",
            "campaign_name": "Sales | Prospecting",
            "objective": "OUTCOME_SALES",
            "effective_status": "ACTIVE",
            "spend": 1000,
            "roas": 4,
            "purchases": 20,
            "cost_per_purchase": 50,
            "body": "Calm Cacao ritual",
        },
        {
            "ad_id": "traffic",
            "ad_name": "Calm traffic",
            "campaign_name": "Traffic | followers | TOF",
            "objective": "OUTCOME_TRAFFIC",
            "effective_status": "ACTIVE",
            "spend": 9000,
            "roas": 9,
            "purchases": 90,
            "cost_per_purchase": 10,
            "body": "Calm Cacao",
        },
        {
            "ad_id": "paused",
            "ad_name": "Calm paused",
            "campaign_name": "Sales | Prospecting",
            "objective": "OUTCOME_SALES",
            "effective_status": "PAUSED",
            "spend": 8000,
            "roas": 8,
            "purchases": 80,
            "cost_per_purchase": 10,
            "body": "Calm Cacao",
        },
        {
            "ad_id": "other-product",
            "ad_name": "Coffee main",
            "campaign_name": "Sales | Prospecting",
            "objective": "OUTCOME_SALES",
            "effective_status": "ACTIVE",
            "spend": 7000,
            "roas": 7,
            "purchases": 70,
            "cost_per_purchase": 10,
            "body": "Mushroom Coffee",
        },
        {
            "ad_id": "second",
            "ad_name": "Calm cacao backup",
            "campaign_name": "Sales | Prospecting",
            "objective": "CONVERSIONS",
            "effective_status": "ACTIVE",
            "spend": 500,
            "roas": 2,
            "purchases": 10,
            "cost_per_purchase": 50,
            "body": "Calm Cacao",
            "video_source_url": "https://cdn.example/ad.mp4",
        },
    ]

    with patch(
        "analyze_endpoints._list_creatives_impl", return_value={"ads": ads}
    ) as mock_list:
        winners = _fetch_top_winners("DOSE OF", top_n=2, focus_product="Calm")

    assert [w["ad_id"] for w in winners] == ["winner", "second"]
    assert winners[1]["creative_type"] == "video"
    assert winners[1]["video_url"] == "https://cdn.example/ad.mp4"
    assert mock_list.call_args.kwargs["brand"] == "DOSE OF"


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


def test_analyze_cache_distinguishes_video_frame_requests(client):
    """Frame-enabled prompts must not reuse no-frame cached recipes."""
    with patch(
        "analyze_endpoints._fetch_top_winners", return_value=[_FAKE_WINNER_VIDEO]
    ), patch(
        "analyze_endpoints.brand_profile_store.get_profile",
        return_value=_FAKE_BRAND_PROFILE,
    ), patch(
        "analyze_endpoints._frames_for_winners", return_value=[]
    ), patch(
        "analyze_endpoints.claude_client.call", return_value=_FAKE_RECIPE_RESPONSE
    ) as mock_call, patch(
        "analyze_endpoints._save_proposed_drafts"
    ):
        body = {"brand": "DOSE OF", "top_n_winners": 1, "n_recipes": 1}
        client.post(
            "/api/recipes/analyze", json={**body, "include_video_frames": False}
        )
        client.post(
            "/api/recipes/analyze", json={**body, "include_video_frames": True}
        )

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
        "analyze_endpoints.extract_frames_concurrent", return_value=[fake_frames]
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
        "analyze_endpoints.extract_frames_concurrent"
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


def test_build_prompt_compacts_large_profile_and_omits_media_urls():
    from analyze_endpoints import _build_prompt

    profile = {
        **_FAKE_BRAND_PROFILE,
        "logo_url": "https://cdn.example.com/logo.png",
        "products": [{"name": "Calm Cacao", "notes": "x" * 1000}],
        "unused_blob": "y" * 5000,
    }
    winner = {
        **_FAKE_WINNER_VIDEO,
        "body": "z" * 1000,
        "video_url": "https://scontent.cdn/very-long-video-url.mp4",
    }

    prompt = _build_prompt(brand_ctx=profile, winners=[winner], n_recipes=1)

    assert "Calm Cacao" in prompt
    assert _FAKE_WINNER_VIDEO["ad_id"] in prompt
    assert "very-long-video-url" not in prompt
    assert "unused_blob" not in prompt
    assert len(prompt) < 5000
