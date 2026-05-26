"""Extract evenly-spaced frames from a video URL using ffmpeg.

Used by the Analyze stage to feed video ads to Claude vision (which
accepts images, not video). Frame count capped at MAX_FRAMES to control
token cost; videos longer than max_duration are skipped.

Decision 2D: `extract_frames_concurrent` runs N videos in parallel via
`asyncio.to_thread`, so a 10-ad batch finishes in ~one-video latency
instead of N × per-video latency.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path
from typing import Optional, Sequence

MAX_FRAMES = 12
PROBE_TIMEOUT_S = 30
FFMPEG_TIMEOUT_S = 120


def _probe_duration(video_url: str) -> float:
    """Return video duration in seconds via ffprobe. 0.0 on any failure."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                video_url,
            ],
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT_S,
            check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return 0.0
    if result.returncode != 0:
        return 0.0
    try:
        return float(json.loads(result.stdout)["format"]["duration"])
    except (json.JSONDecodeError, KeyError, ValueError, TypeError):
        return 0.0


def _run_ffmpeg(
    video_url: str, output_pattern: str, fps: float, n_frames: int
) -> None:
    """Run ffmpeg to extract n_frames evenly spaced. Swallows ffmpeg errors —
    caller treats missing files as failure (see extract_frames)."""
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                video_url,
                "-vf",
                f"fps={fps}",
                "-frames:v",
                str(n_frames),
                "-q:v",
                "2",
                output_pattern,
            ],
            capture_output=True,
            timeout=FFMPEG_TIMEOUT_S,
            check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return


def extract_frames(
    video_url: str,
    n_frames: int = 8,
    output_dir: Optional[Path] = None,
    max_duration: int = 60,
) -> list[str]:
    """Extract n_frames evenly-spaced frames from video_url.

    Returns list of frame file paths. Returns empty list when:
    - Probe fails (duration <= 0)
    - Duration exceeds max_duration (cost cap)
    - ffmpeg writes no files
    n_frames clamped to MAX_FRAMES.
    """
    n_frames = min(max(n_frames, 1), MAX_FRAMES)

    duration = _probe_duration(video_url)
    if duration <= 0 or duration > max_duration:
        return []

    out_dir = Path(output_dir) if output_dir else Path("/tmp")
    out_dir.mkdir(parents=True, exist_ok=True)
    pattern = str(out_dir / "frame_%03d.jpg")

    fps = n_frames / duration
    _run_ffmpeg(video_url, pattern, fps, n_frames)

    frames = sorted(out_dir.glob("frame_*.jpg"))
    return [str(p) for p in frames[:n_frames]]


async def extract_frames_concurrent(
    video_urls: Sequence[str],
    n_frames: int = 8,
    output_dir: Optional[Path] = None,
    max_duration: int = 60,
) -> list[list[str]]:
    """Extract frames from N videos concurrently (decision 2D).

    Each video gets its own subdirectory `<output_dir>/<video-stem>/` to
    keep frame files from colliding. Returns one frames-list per input
    URL, in input order.
    """
    base = Path(output_dir) if output_dir else Path("/tmp")
    base.mkdir(parents=True, exist_ok=True)

    async def _one(url: str) -> list[str]:
        sub = base / Path(url).stem
        return await asyncio.to_thread(
            extract_frames,
            url,
            n_frames=n_frames,
            output_dir=sub,
            max_duration=max_duration,
        )

    return await asyncio.gather(*(_one(u) for u in video_urls))
