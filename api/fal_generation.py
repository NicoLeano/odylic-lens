"""Small fal.ai wrapper for the Create stage.

The public fal SDK returns provider-shaped JSON with media URLs. Lens
normalizes that into downloaded local assets before touching SQLite, so
the drafts gallery stays useful after short-lived CDN URLs expire.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import mimetypes
import os
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse
import uuid

import fal_client
import requests

DEFAULT_VIDEO_MODEL = "fal-ai/kling-video/v1.6/standard/text-to-video"
DEFAULT_IMAGE_MODEL = "fal-ai/flux/dev"
DEFAULT_IMAGE_ARGUMENTS = {
    "image_size": "portrait_4_3",
    "num_images": 1,
    "output_format": "png",
}
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
        raise RuntimeError("FAL_KEY is not configured. Add it to .env before generating media.")


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
    if path.exists():
        path = output_dir / f"variant-{variant_idx + 1}-{uuid.uuid4().hex[:8]}{ext}"
    with open(path, "wb") as f:
        for chunk in response.iter_content(chunk_size=1024 * 512):
            if chunk:
                f.write(chunk)
    return {"path": str(path), "mime_type": mime_type, "variant_idx": variant_idx}


def _remove_files(paths: list[str]) -> None:
    for path in paths:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass


def _run_variant(
    *,
    prompt: str,
    output_dir: Path,
    model: str,
    arguments: dict[str, Any],
    variant_idx: int,
    timeout: int,
) -> dict:
    try:
        result = fal_client.run(
            model,
            arguments={"prompt": prompt, **arguments},
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
    return asset


def _generate_assets(
    *,
    prompt: str,
    output_dir: Path,
    model_id: str,
    arguments: Optional[dict[str, Any]] = None,
    variant_count: int = 1,
    timeout: int = 360,
) -> list[dict]:
    """Run fal.ai media generation and persist returned assets locally."""
    _require_fal_key()
    clean_prompt = (prompt or "").strip()
    if not clean_prompt:
        raise RuntimeError("prompt is required for fal.ai generation")

    count = min(max(int(variant_count or 1), 1), 4)
    model = (model_id or DEFAULT_VIDEO_MODEL).strip()
    normalized_arguments = dict(arguments or {})
    downloaded: list[dict] = []
    preexisting_paths = {
        path.resolve()
        for path in output_dir.glob("variant-*")
        if path.is_file()
    }
    try:
        if count == 1:
            return [
                _run_variant(
                    prompt=clean_prompt,
                    output_dir=output_dir,
                    model=model,
                    arguments=normalized_arguments,
                    variant_idx=0,
                    timeout=timeout,
                )
            ]

        by_idx: dict[int, dict] = {}
        with ThreadPoolExecutor(max_workers=count) as pool:
            futures = {
                pool.submit(
                    _run_variant,
                    prompt=clean_prompt,
                    output_dir=output_dir,
                    model=model,
                    arguments=normalized_arguments,
                    variant_idx=variant_idx,
                    timeout=timeout,
                ): variant_idx
                for variant_idx in range(count)
            }
            for future in as_completed(futures):
                asset = future.result()
                by_idx[asset["variant_idx"]] = asset
                downloaded.append(asset)
        return [by_idx[i] for i in range(count)]
    except Exception:
        _remove_files(
            [
                str(path)
                for path in output_dir.glob("*")
                if path.is_file()
                and path.name.startswith("variant-")
                and path.resolve() not in preexisting_paths
            ]
        )
        _remove_files([str(asset.get("path")) for asset in downloaded if asset.get("path")])
        raise


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
    return _generate_assets(
        prompt=prompt,
        output_dir=output_dir,
        model_id=model_id or DEFAULT_VIDEO_MODEL,
        arguments=arguments,
        variant_count=variant_count,
        timeout=timeout,
    )


def generate_image(
    *,
    prompt: str,
    output_dir: Path,
    model_id: str = DEFAULT_IMAGE_MODEL,
    arguments: Optional[dict[str, Any]] = None,
    variant_count: int = 1,
    timeout: int = 180,
) -> list[dict]:
    """Run fal.ai static image generation and persist returned media locally."""
    return _generate_assets(
        prompt=prompt,
        output_dir=output_dir,
        model_id=model_id or DEFAULT_IMAGE_MODEL,
        arguments={**DEFAULT_IMAGE_ARGUMENTS, **dict(arguments or {})},
        variant_count=variant_count,
        timeout=timeout,
    )
