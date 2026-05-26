"""Tests for Create-stage drafts, uploads, and fal.ai generation."""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from unittest.mock import patch

import pytest


PNG_BYTES = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"

RECIPE = {
    "recipe_id": "recipe-1",
    "draft_id": "draft-1",
    "angle": "Benefits",
    "persona": "45+ MX women",
    "funnel_position": "mid",
    "hook": "Dormir mejor sin pastillas",
    "copy_outline": "Problem, product ritual, proof, CTA",
    "visual_direction": "Warm kitchen counter with cacao pouch visible",
    "product": "Calm Cacao",
    "format": "image",
    "fal_model_hint": "flux/dev",
    "rationale": "Sleep angle has winner proof.",
    "source_winner_ids": ["120211"],
}


@pytest.fixture
def isolated_store(tmp_path, monkeypatch):
    monkeypatch.setenv("LENS_DB_PATH", str(tmp_path / "lens.db"))
    monkeypatch.setenv("LENS_DRAFTS_DIR", str(tmp_path / "drafts"))

    import store

    store.init_db()
    return store


@pytest.fixture
def client(isolated_store):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from create_endpoints import _require_authenticated_user, router

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[_require_authenticated_user] = lambda: "test-user"
    return TestClient(app)


@pytest.fixture
def unauthenticated_client(isolated_store):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from create_endpoints import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _insert_recipe(store_module, brand: str = "DOSE OF", recipe: dict | None = None) -> str:
    return store_module.insert_proposed_drafts(brand, [recipe or RECIPE])[0]


def test_video_model_resolver_rejects_sentence_hint():
    import fal_generation
    from create_endpoints import _video_model_for

    recipe = {"fal_model_hint": "veo-3 o kling-pro para movimiento natural"}

    assert _video_model_for(recipe, override=None) == fal_generation.DEFAULT_VIDEO_MODEL


def test_video_model_resolver_allows_only_known_tokens():
    import fal_generation
    from create_endpoints import _video_model_for

    assert (
        _video_model_for({"fal_model_hint": "kling"}, None)
        == fal_generation.DEFAULT_VIDEO_MODEL
    )
    assert (
        _video_model_for({"fal_model_hint": "fal-ai/kling-video/v1.6/standard"}, None)
        == fal_generation.DEFAULT_VIDEO_MODEL
    )
    assert (
        _video_model_for({"fal_model_hint": "hunyuan cinematic motion"}, None)
        == fal_generation.DEFAULT_VIDEO_MODEL
    )


def test_create_routes_require_authenticated_session(unauthenticated_client):
    response = unauthenticated_client.get("/api/drafts?brand=DOSE+OF")
    assert response.status_code == 401


def test_list_drafts_filters_by_brand_and_status(client, isolated_store):
    _insert_recipe(isolated_store)
    _insert_recipe(
        isolated_store,
        brand="Vital Botanics",
        recipe={**RECIPE, "recipe_id": "recipe-2", "draft_id": "draft-2"},
    )
    isolated_store.set_draft_status("draft-1", "ready")

    response = client.get("/api/drafts?brand=DOSE+OF&status=ready")

    assert response.status_code == 200
    body = response.json()
    assert [draft["draft_id"] for draft in body["drafts"]] == ["draft-1"]
    assert body["drafts"][0]["recipe"]["hook"] == "Dormir mejor sin pastillas"


def test_prepare_draft_marks_proposed_ready_and_returns_prompt(client, isolated_store):
    _insert_recipe(isolated_store)

    response = client.post("/api/drafts/draft-1/prepare")

    assert response.status_code == 200
    body = response.json()
    assert "Calm Cacao" in body["prompt"]
    assert "Dormir mejor sin pastillas" in body["prompt"]
    assert body["draft"]["status"] == "ready"

    with isolated_store._connect() as conn:
        status = conn.execute(
            "SELECT status FROM drafts WHERE draft_id = ?",
            ("draft-1",),
        ).fetchone()["status"]
    assert status == "ready"


def test_upload_manual_asset_saves_file_and_promotes_to_draft(client, isolated_store, tmp_path):
    _insert_recipe(isolated_store)

    response = client.post(
        "/api/drafts/draft-1/upload",
        files={"file": ("creative.png", PNG_BYTES, "image/png")},
    )

    assert response.status_code == 200
    draft = response.json()["draft"]
    assert draft["status"] == "draft"
    assert draft["assets"][0]["fal_model_used"] == "manual_upload"
    assert draft["assets"][0]["url"].startswith("/api/draft-assets/")

    with isolated_store._connect() as conn:
        row = conn.execute(
            "SELECT path, mime_type FROM draft_assets WHERE draft_id = ?",
            ("draft-1",),
        ).fetchone()
    assert row["mime_type"] == "image/png"
    assert Path(row["path"]).read_bytes() == PNG_BYTES


def test_upload_rejects_spoofed_content_type(client, isolated_store, tmp_path):
    _insert_recipe(isolated_store)

    response = client.post(
        "/api/drafts/draft-1/upload",
        files={"file": ("creative.png", b"<script>alert(1)</script>", "image/png")},
    )

    assert response.status_code == 400
    assert "Unsupported upload type" in response.json()["detail"]
    assert list((tmp_path / "drafts").rglob("*")) == []


def test_upload_rejects_mismatched_content_type(client, isolated_store, tmp_path):
    _insert_recipe(isolated_store)

    response = client.post(
        "/api/drafts/draft-1/upload",
        files={"file": ("creative.jpg", PNG_BYTES, "image/jpeg")},
    )

    assert response.status_code == 400
    assert "does not match" in response.json()["detail"]
    with isolated_store._connect() as conn:
        count = conn.execute("SELECT COUNT(*) FROM draft_assets").fetchone()[0]
    assert count == 0


def test_generate_video_records_assets_without_holding_store_lock(
    client, isolated_store, monkeypatch
):
    _insert_recipe(isolated_store)

    class TrackingLock:
        def __init__(self):
            self.depth = 0

        def __enter__(self):
            self.depth += 1
            return self

        def __exit__(self, exc_type, exc, tb):
            self.depth -= 1

    tracking = TrackingLock()
    monkeypatch.setattr(isolated_store, "_LOCK", tracking)

    def fake_generate_video(*, prompt, output_dir, model_id, arguments, variant_count):
        assert tracking.depth == 0
        output_dir.mkdir(parents=True, exist_ok=True)
        path = output_dir / "result.mp4"
        path.write_bytes(b"video")
        assert "Dormir mejor sin pastillas" in prompt
        return [
            {
                "path": str(path),
                "mime_type": "video/mp4",
                "fal_model_used": model_id,
                "cost_usd": 0.31,
            }
        ]

    with patch("create_endpoints.fal_generation.generate_video", side_effect=fake_generate_video):
        response = client.post("/api/drafts/draft-1/generate-video", json={})

    assert response.status_code == 200
    draft = response.json()["draft"]
    assert draft["status"] == "draft"
    assert draft["assets"][0]["mime_type"] == "video/mp4"
    assert draft["assets"][0]["cost_usd"] == 0.31
    assert draft["assets"][0]["fal_model_used"] == "fal-ai/kling-video/v1.6/standard"


def test_generate_video_sentence_hint_uses_default_model(client, isolated_store):
    import fal_generation

    _insert_recipe(
        isolated_store,
        recipe={
            **RECIPE,
            "recipe_id": "recipe-sentence-hint",
            "draft_id": "draft-sentence-hint",
            "fal_model_hint": "veo-3 o kling-pro para movimiento natural",
        },
    )
    seen: dict[str, str] = {}

    def fake_generate_video(*, prompt, output_dir, model_id, arguments, variant_count):
        seen["model_id"] = model_id
        output_dir.mkdir(parents=True, exist_ok=True)
        path = output_dir / "result.mp4"
        path.write_bytes(b"video")
        return [
            {
                "path": str(path),
                "mime_type": "video/mp4",
                "fal_model_used": model_id,
                "cost_usd": 0.31,
            }
        ]

    with patch(
        "create_endpoints.fal_generation.generate_video", side_effect=fake_generate_video
    ):
        response = client.post("/api/drafts/draft-sentence-hint/generate-video", json={})

    assert response.status_code == 200
    assert seen["model_id"] == fal_generation.DEFAULT_VIDEO_MODEL
    assert (
        response.json()["draft"]["assets"][0]["fal_model_used"]
        == fal_generation.DEFAULT_VIDEO_MODEL
    )


def test_patch_discarded_hides_draft_from_default_list(client, isolated_store):
    _insert_recipe(isolated_store)

    response = client.patch("/api/drafts/draft-1", json={"status": "discarded"})
    assert response.status_code == 200
    assert response.json()["draft"]["status"] == "discarded"

    list_response = client.get("/api/drafts?brand=DOSE+OF")
    assert list_response.status_code == 200
    assert list_response.json()["drafts"] == []


def test_delete_draft_asset_removes_file_and_row(client, isolated_store, tmp_path):
    _insert_recipe(isolated_store)
    asset_path = tmp_path / "drafts" / "asset.mp4"
    asset_path.parent.mkdir(parents=True, exist_ok=True)
    asset_path.write_bytes(b"video")
    asset_id = isolated_store.insert_draft_assets(
        "draft-1",
        [
            {
                "path": str(asset_path),
                "mime_type": "video/mp4",
                "fal_model_used": "manual_upload",
            }
        ],
    )[0]

    response = client.delete(f"/api/draft-assets/{asset_id}")

    assert response.status_code == 200
    assert not asset_path.exists()
    with isolated_store._connect() as conn:
        count = conn.execute("SELECT COUNT(*) FROM draft_assets").fetchone()[0]
    assert count == 0


def test_hard_delete_draft_removes_row_and_asset_file(client, isolated_store, tmp_path):
    _insert_recipe(isolated_store)
    asset_path = tmp_path / "drafts" / "asset.mp4"
    asset_path.parent.mkdir(parents=True, exist_ok=True)
    asset_path.write_bytes(b"video")
    isolated_store.insert_draft_assets(
        "draft-1",
        [{"path": str(asset_path), "mime_type": "video/mp4"}],
    )

    response = client.delete("/api/drafts/draft-1")

    assert response.status_code == 200
    assert not asset_path.exists()
    with isolated_store._connect() as conn:
        draft_count = conn.execute("SELECT COUNT(*) FROM drafts").fetchone()[0]
        asset_count = conn.execute("SELECT COUNT(*) FROM draft_assets").fetchone()[0]
    assert draft_count == 0
    assert asset_count == 0


def test_main_app_mounts_create_router(tmp_path, monkeypatch):
    monkeypatch.setenv("LENS_DB_PATH", str(tmp_path / "lens.db"))
    monkeypatch.setenv("LENS_DRAFTS_DIR", str(tmp_path / "drafts"))
    sys.modules.pop("main", None)

    import main

    assert any(
        route.path == "/api/drafts/{draft_id}/prepare" and "POST" in (route.methods or set())
        for route in main.app.routes
    )
