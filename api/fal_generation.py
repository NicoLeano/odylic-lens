"""Small fal.ai wrapper for the Create stage.

The public fal SDK returns provider-shaped JSON with media URLs. Lens
normalizes that into downloaded local assets before touching SQLite, so
the drafts gallery stays useful after short-lived CDN URLs expire.
"""
from __future__ import annotations

import mimetypes
import os
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import fal_client
import requests

DEFAULT_VIDEO_MODEL = "fal-ai/kling-video/v1.6/standard"
_ALLOWED_MIME_PREFIXES = ("image/", "video/")
_EXT_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
}


def _require_fal_key() -> None:
    if not (os.environ.get("FAL_KEY") or os.environ.get("FAL_KEY_ID")):
        raise RuntimeError("FAL_KEY is not configured. Add it to .env before generating video.")


def _extract_asset_urls(value: Any) -> list[str]:
    """Walk common fal response shapes and collect media URLs."""
    urls: list[str] = []

    def visit(node: Any) -> None:
        if isinstance(node, str):
            if node.startswith(("http://", "https://")):
                urls.append(node)
            return
        if isinstance(node, list):
            for child in node:
                visit(child)
            return
        if isinstance(node, dict):
            url = node.get("url")
            if isinstance(url, str) and url.startswith(("http://", "https://")):
                urls.append(url)
            for key in ("video", "videos", "image", "images", "output", "outputs"):
                if key in node:
                    visit(node[key])

    visit(value)
    seen: set[str] = set()
    unique: list[str] = []
    for url in urls:
        if url in seen:
            continue
        seen.add(url)
        unique.append(url)
    return unique


def _cost_from_result(result: Any) -> Optional[float]:
    if not isinstance(result, dict):
        return None
    for key in ("cost_usd", "cost", "total_cost"):
        value = result.get(key)
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    metrics = result.get("metrics")
    if isinstance(metrics, dict):
        for key in ("cost_usd", "cost"):
            value = metrics.get(key)
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return None


def _mime_from_url(url: str) -> Optional[str]:
    suffix = Path(urlparse(url).path).suffix.lower()
    if not suffix:
        return None
    return mimetypes.types_map.get(suffix)


def _normalize_mime(content_type: str, url: str) -> str:
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    if not mime or mime == "application/octet-stream":
        mime = _mime_from_url(url) or ""
    if not mime.startswith(_ALLOWED_MIME_PREFIXES):
        raise RuntimeError(f"fal.ai returned unsupported media type: {mime or 'unknown'}")
    return mime


def _extension_for(mime_type: str, url: str) -> str:
    if mime_type in _EXT_BY_MIME:
        return _EXT_BY_MIME[mime_type]
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix:
        return suffix
    guessed = mimetypes.guess_extension(mime_type)
    if guessed:
        return guessed
    raise RuntimeError(f"cannot infer file extension for fal.ai media type: {mime_type}")


def _download_asset(url: str, output_dir: Path, variant_idx: int, timeout: int = 90) -> dict:
    response = requests.get(url, timeout=timeout, stream=True)
    response.raise_for_status()
    mime_type = _normalize_mime(response.headers.get("content-type", ""), url)
    ext = _extension_for(mime_type, url)
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"variant-{variant_idx + 1}{ext}"
    with open(path, "wb") as f:
        for chunk in response.iter_content(chunk_size=1024 * 512):
            if chunk:
                f.write(chunk)
    return {"path": str(path), "mime_type": mime_type, "variant_idx": variant_idx}


def generate_video(
    *,
    prompt: str,
    output_dir: Path,
    model_id: str = DEFAULT_VIDEO_MODEL,
    arguments: Optional[dict[str, Any]] = None,
    variant_count: int = 1,
    timeout: int = 360,
) -> list[dict]:
    """Run fal.ai video generation and persist returned media locally."""
    _require_fal_key()
    clean_prompt = (prompt or "").strip()
    if not clean_prompt:
        raise RuntimeError("prompt is required for fal.ai generation")

    count = min(max(int(variant_count or 1), 1), 4)
    model = (model_id or DEFAULT_VIDEO_MODEL).strip()
    downloaded: list[dict] = []
    for variant_idx in range(count):
        try:
            result = fal_client.run(
                model,
                arguments={"prompt": clean_prompt, **(arguments or {})},
                timeout=timeout,
            )
        except Exception as exc:
            raise RuntimeError(f"fal.ai generation failed: {exc}") from exc
        urls = _extract_asset_urls(result)
        if not urls:
            raise RuntimeError(f"fal.ai returned no media URL: {result}")
        asset = _download_asset(urls[0], output_dir, variant_idx)
        asset["fal_model_used"] = model
        asset["cost_usd"] = _cost_from_result(result)
        downloaded.append(asset)
    return downloaded
