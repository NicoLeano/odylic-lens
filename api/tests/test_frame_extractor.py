"""Tests for ffmpeg-based frame extraction from ad video URLs.

Covers Task 2.6/2.7 of the Lens fork plan, plus decision 2D (concurrent
helper via asyncio.to_thread) and 9A (ffmpeg-failure path).
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import patch

import pytest


def test_extract_frames_returns_paths(tmp_path):
    """Extracts N frames to temp dir, returns list of file paths."""
    from frame_extractor import extract_frames

    with patch("frame_extractor._probe_duration", return_value=20.0):
        with patch("frame_extractor._run_ffmpeg") as mock_ff:
            for i in range(8):
                (tmp_path / f"frame_{i:03d}.jpg").write_bytes(b"fake")

            paths = extract_frames(
                video_url="https://example.com/ad.mp4",
                n_frames=8,
                output_dir=tmp_path,
            )

    assert len(paths) == 8
    assert all(Path(p).exists() for p in paths)
    mock_ff.assert_called_once()


def test_extract_frames_skips_videos_over_60_seconds(tmp_path):
    """Cost-cap: skip videos longer than 60s."""
    from frame_extractor import extract_frames

    with patch("frame_extractor._probe_duration", return_value=120.5):
        paths = extract_frames(
            video_url="https://example.com/long.mp4",
            n_frames=8,
            output_dir=tmp_path,
            max_duration=60,
        )

    assert paths == []


def test_extract_frames_caps_n_at_12(tmp_path):
    """n_frames > 12 clamped to 12 (token-cost guard)."""
    from frame_extractor import extract_frames

    with patch("frame_extractor._probe_duration", return_value=30.0):
        with patch("frame_extractor._run_ffmpeg") as mock_ff:
            for i in range(12):
                (tmp_path / f"frame_{i:03d}.jpg").write_bytes(b"fake")

            paths = extract_frames(
                video_url="https://example.com/ad.mp4",
                n_frames=50,
                output_dir=tmp_path,
            )

    assert len(paths) == 12
    mock_ff.assert_called_once()


def test_extract_frames_returns_empty_when_ffmpeg_fails(tmp_path):
    """9A: ffmpeg crash / empty output yields [] (no partial leak)."""
    from frame_extractor import extract_frames

    with patch("frame_extractor._probe_duration", return_value=20.0):
        # _run_ffmpeg called but writes no files (simulating ffmpeg failure)
        with patch("frame_extractor._run_ffmpeg") as mock_ff:
            paths = extract_frames(
                video_url="https://example.com/broken.mp4",
                n_frames=8,
                output_dir=tmp_path,
            )

    assert paths == []
    mock_ff.assert_called_once()


def test_extract_frames_returns_empty_when_probe_fails(tmp_path):
    """9A: ffprobe failure (duration=0) yields [] without ffmpeg call."""
    from frame_extractor import extract_frames

    with patch("frame_extractor._probe_duration", return_value=0.0):
        with patch("frame_extractor._run_ffmpeg") as mock_ff:
            paths = extract_frames(
                video_url="https://example.com/unreadable.mp4",
                n_frames=8,
                output_dir=tmp_path,
            )

    assert paths == []
    mock_ff.assert_not_called()


def test_extract_frames_concurrent_runs_in_parallel(tmp_path):
    """2D: extract_frames_concurrent processes N videos concurrently."""
    from frame_extractor import extract_frames_concurrent

    urls = [f"https://example.com/ad{i}.mp4" for i in range(3)]

    def fake_extract(video_url, n_frames=8, output_dir=None, max_duration=60):
        # Per-video subdir so concurrent calls don't collide
        sub = Path(output_dir) / Path(video_url).stem
        sub.mkdir(parents=True, exist_ok=True)
        for i in range(n_frames):
            (sub / f"frame_{i:03d}.jpg").write_bytes(b"x")
        return [str(p) for p in sorted(sub.glob("frame_*.jpg"))]

    with patch("frame_extractor.extract_frames", side_effect=fake_extract):
        results = asyncio.run(
            extract_frames_concurrent(urls, n_frames=4, output_dir=tmp_path)
        )

    assert len(results) == 3
    assert all(len(frames) == 4 for frames in results)
    assert all(Path(p).exists() for frames in results for p in frames)
