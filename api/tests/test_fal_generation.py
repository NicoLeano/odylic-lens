"""Tests for the fal.ai wrapper used by the Create stage."""
from __future__ import annotations

from unittest.mock import patch
import time

import pytest


def test_extract_asset_urls_handles_common_fal_shapes():
    import fal_generation

    payload = {
        "video": {"url": "https://fal.ai/video.mp4"},
        "images": [{"url": "https://fal.ai/image.png"}],
        "nested": {"outputs": [{"url": "https://fal.ai/other.webp"}]},
    }

    assert fal_generation._extract_asset_urls(payload) == [
        "https://fal.ai/video.mp4",
        "https://fal.ai/image.png",
    ]


def test_generate_video_runs_fal_and_downloads_file(tmp_path, monkeypatch):
    import fal_generation

    class FakeResponse:
        headers = {"content-type": "video/mp4"}

        def raise_for_status(self):
            return None

        def iter_content(self, chunk_size):
            yield b"video-bytes"

    monkeypatch.setenv("FAL_KEY", "fal-key")
    with patch(
        "fal_generation.fal_client.run",
        return_value={"video": {"url": "https://fal.ai/result.mp4"}, "cost_usd": 0.42},
    ) as run, patch("fal_generation.requests.get", return_value=FakeResponse()) as get:
        assets = fal_generation.generate_video(
            prompt="Make a vertical product video",
            output_dir=tmp_path,
            model_id=fal_generation.DEFAULT_VIDEO_MODEL,
        )

    assert run.call_args.args[0] == fal_generation.DEFAULT_VIDEO_MODEL
    assert run.call_args.kwargs["arguments"]["prompt"] == "Make a vertical product video"
    assert get.call_args.args[0] == "https://fal.ai/result.mp4"
    assert assets[0]["mime_type"] == "video/mp4"
    assert assets[0]["cost_usd"] == 0.42
    assert (tmp_path / "variant-1.mp4").read_bytes() == b"video-bytes"


def test_generate_video_fails_loud_when_fal_returns_no_media(tmp_path, monkeypatch):
    import fal_generation

    monkeypatch.setenv("FAL_KEY", "fal-key")
    with patch("fal_generation.fal_client.run", return_value={"status": "ok"}):
        with pytest.raises(RuntimeError, match="returned no media URL"):
            fal_generation.generate_video(
                prompt="Make a vertical product video",
                output_dir=tmp_path,
            )


def test_generate_video_cleans_downloaded_files_on_later_variant_failure(
    tmp_path, monkeypatch
):
    import fal_generation

    monkeypatch.setenv("FAL_KEY", "fal-key")
    existing = tmp_path / "variant-existing.mp4"
    existing.write_bytes(b"keep-me")

    def fake_run(model, arguments, timeout):
        return {"video": {"url": "https://fal.ai/result.mp4"}}

    def fake_download(url, output_dir, variant_idx):
        path = output_dir / f"variant-{variant_idx + 1}.mp4"
        output_dir.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"video")
        if variant_idx == 1:
            raise RuntimeError("download failed")
        return {"path": str(path), "mime_type": "video/mp4", "variant_idx": variant_idx}

    with patch("fal_generation.fal_client.run", side_effect=fake_run), patch(
        "fal_generation._download_asset", side_effect=fake_download
    ):
        with pytest.raises(RuntimeError, match="download failed"):
            fal_generation.generate_video(
                prompt="Make four variants",
                output_dir=tmp_path,
                variant_count=3,
            )

    assert existing.read_bytes() == b"keep-me"
    assert sorted(path.name for path in tmp_path.glob("*.mp4")) == ["variant-existing.mp4"]


def test_generate_video_runs_multi_variant_requests_concurrently(tmp_path, monkeypatch):
    import fal_generation

    monkeypatch.setenv("FAL_KEY", "fal-key")

    def fake_run(model, arguments, timeout):
        time.sleep(0.2)
        return {"video": {"url": "https://fal.ai/result.mp4"}}

    def fake_download(url, output_dir, variant_idx):
        path = output_dir / f"variant-{variant_idx + 1}.mp4"
        output_dir.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"video")
        return {"path": str(path), "mime_type": "video/mp4", "variant_idx": variant_idx}

    start = time.perf_counter()
    with patch("fal_generation.fal_client.run", side_effect=fake_run) as run, patch(
        "fal_generation._download_asset", side_effect=fake_download
    ):
        assets = fal_generation.generate_video(
            prompt="Make four variants",
            output_dir=tmp_path,
            variant_count=4,
        )
    elapsed = time.perf_counter() - start

    assert run.call_count == 4
    assert [asset["variant_idx"] for asset in assets] == [0, 1, 2, 3]
    assert elapsed < 0.6
