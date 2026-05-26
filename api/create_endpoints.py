"""Create-stage routes for Lens drafts.

Analyze writes `proposed` draft rows. These endpoints move a draft
through ready -> draft -> launched, attach manual ChatGPT uploads, and
run fal.ai video generation without holding the global SQLite lock.
"""
from __future__ import annotations

import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Cookie, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from auth import require_user
import fal_generation
import store

router = APIRouter(tags=["create"])

MAX_UPLOAD_BYTES = 80 * 1024 * 1024
_SAFE_PART = re.compile(r"[^a-zA-Z0-9_.-]+")
_UPLOAD_EXT_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
}
_GENERIC_UPLOAD_MIMES = {"", "application/octet-stream", "binary/octet-stream"}
_KNOWN_FAL_VIDEO_MODELS = {
    "default": fal_generation.DEFAULT_VIDEO_MODEL,
    "kling": fal_generation.DEFAULT_VIDEO_MODEL,
    "kling-video": fal_generation.DEFAULT_VIDEO_MODEL,
    "kling-standard": fal_generation.DEFAULT_VIDEO_MODEL,
    "kling-video/v1.6/standard": fal_generation.DEFAULT_VIDEO_MODEL,
    "kling-video/v1.6/standard/text-to-video": fal_generation.DEFAULT_VIDEO_MODEL,
    "fal-ai/kling-video/v1.6/standard": fal_generation.DEFAULT_VIDEO_MODEL,
    fal_generation.DEFAULT_VIDEO_MODEL: fal_generation.DEFAULT_VIDEO_MODEL,
}


class GenerateVideoRequest(BaseModel):
    model_override: Optional[str] = None
    variant_count: int = Field(default=1, ge=1, le=4)
    arguments: dict[str, Any] = Field(default_factory=dict)


class UpdateDraftRequest(BaseModel):
    status: Optional[str] = None
    meta_ad_id: Optional[str] = None


def _require_authenticated_user(lens_session: Optional[str] = Cookie(None)) -> str:
    return require_user(lens_session)


def _drafts_root() -> Path:
    root = Path.home() / ".odylic-lens" / "drafts"
    env_root = Path(os.environ["LENS_DRAFTS_DIR"]) if os.environ.get("LENS_DRAFTS_DIR") else root
    env_root.mkdir(parents=True, exist_ok=True)
    return env_root


def _safe_part(value: str) -> str:
    clean = _SAFE_PART.sub("-", (value or "").strip()).strip(".-")
    return clean[:80] or "unknown"


def _draft_dir(draft: dict) -> Path:
    return _drafts_root() / _safe_part(draft.get("brand", "")) / _safe_part(draft.get("draft_id", ""))


def _public_asset(asset: dict) -> dict:
    return {
        "asset_id": asset["asset_id"],
        "draft_id": asset["draft_id"],
        "variant_idx": asset["variant_idx"],
        "mime_type": asset["mime_type"],
        "fal_model_used": asset.get("fal_model_used"),
        "cost_usd": asset.get("cost_usd"),
        "created_at": asset["created_at"],
        "filename": Path(asset.get("path") or "").name,
        "url": f"/api/draft-assets/{asset['asset_id']}/file",
    }


def _public_draft(draft: dict) -> dict:
    return {
        **draft,
        "assets": [_public_asset(asset) for asset in draft.get("assets", [])],
    }


def _recipe(draft: dict) -> dict:
    recipe = draft.get("recipe")
    return recipe if isinstance(recipe, dict) else {}


def _chatgpt_prompt(draft: dict) -> str:
    recipe = _recipe(draft)
    return "\n".join(
        [
            f"Create a Meta ad image for {draft.get('brand', 'the brand')}.",
            f"Product: {recipe.get('product') or 'primary product'}",
            f"Audience: {recipe.get('persona') or 'target customer'}",
            f"Angle: {recipe.get('angle') or 'benefit-led'}",
            f"Hook: {recipe.get('hook') or 'clear thumb-stopping hook'}",
            f"Copy outline: {recipe.get('copy_outline') or 'short direct-response copy'}",
            f"Visual direction: {recipe.get('visual_direction') or 'native Meta ad creative'}",
            "Format: vertical 4:5 or 9:16 paid social creative, clean product visibility, no tiny unreadable text.",
        ]
    )


def _video_prompt(draft: dict) -> str:
    recipe = _recipe(draft)
    return "\n".join(
        [
            f"Create a short vertical Meta ad video for {draft.get('brand', 'the brand')}.",
            f"Product: {recipe.get('product') or 'primary product'}",
            f"Audience: {recipe.get('persona') or 'target customer'}",
            f"Opening hook: {recipe.get('hook') or 'clear thumb-stopping hook'}",
            f"Scene direction: {recipe.get('visual_direction') or 'native paid social video'}",
            f"Copy beats: {recipe.get('copy_outline') or 'problem, product, proof, CTA'}",
            "Style: 9:16, fast first second, polished ecommerce UGC, product visible, natural lighting.",
        ]
    )


def _video_model_for(recipe: dict, override: Optional[str]) -> str:
    model = _known_video_model(override)
    if model:
        return model
    model = _known_video_model(recipe.get("fal_model_hint"))
    if model:
        return model
    return fal_generation.DEFAULT_VIDEO_MODEL


def _known_video_model(value: Any) -> Optional[str]:
    raw = str(value or "").strip()
    if not raw:
        return None
    token = raw.split(maxsplit=1)[0].strip("'\"`.,;:()[]{}<>").lower()
    return _KNOWN_FAL_VIDEO_MODELS.get(token)


def _load_draft_or_404(draft_id: str) -> dict:
    draft = store.get_draft(draft_id)
    if not draft:
        raise HTTPException(404, "Draft not found.")
    return draft


def _ensure_mutable(draft: dict) -> None:
    if draft.get("status") == "discarded":
        raise HTTPException(400, "Discarded drafts cannot be modified.")


def _declared_upload_mime(file: UploadFile) -> str:
    return (file.content_type or "").split(";", 1)[0].strip().lower()


def _sniff_upload_mime(data: bytes) -> Optional[str]:
    """Return an allowlisted media type based on magic bytes."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"\x1aE\xdf\xa3"):
        return "video/webm"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        brand = data[8:12].lower()
        if brand == b"qt  ":
            return "video/quicktime"
        return "video/mp4"
    return None


def _validated_upload_mime(file: UploadFile, first_chunk: bytes) -> tuple[str, str]:
    sniffed = _sniff_upload_mime(first_chunk)
    if not sniffed:
        raise HTTPException(400, "Unsupported upload type. Use image or video files.")
    declared = _declared_upload_mime(file)
    if declared not in _GENERIC_UPLOAD_MIMES and declared != sniffed:
        raise HTTPException(
            400,
            f"Upload content type {declared} does not match detected {sniffed}.",
        )
    return sniffed, _UPLOAD_EXT_BY_MIME[sniffed]


def _remove_file(path: str) -> None:
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        pass


def _remove_draft_files(draft: dict) -> None:
    for asset in draft.get("assets", []):
        _remove_file(asset.get("path") or "")
    try:
        shutil.rmtree(_draft_dir(draft), ignore_errors=True)
    except OSError:
        pass


@router.get("/api/drafts")
def list_drafts(
    brand: str,
    status: Optional[list[str]] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    after: Optional[int] = Query(default=None),
    _fb_user_id: str = Depends(_require_authenticated_user),
) -> dict:
    try:
        drafts = store.list_drafts(brand, status, limit=limit, after=after)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"drafts": [_public_draft(draft) for draft in drafts]}


@router.post("/api/drafts/{draft_id}/prepare")
def prepare_draft(
    draft_id: str,
    _fb_user_id: str = Depends(_require_authenticated_user),
) -> dict:
    draft = _load_draft_or_404(draft_id)
    _ensure_mutable(draft)
    if draft["status"] == "proposed":
        draft = store.set_draft_status(draft_id, "ready") or draft
    return {"prompt": _chatgpt_prompt(draft), "draft": _public_draft(draft)}


@router.post("/api/drafts/{draft_id}/generate-video")
def generate_video(
    draft_id: str,
    req: GenerateVideoRequest,
    _fb_user_id: str = Depends(_require_authenticated_user),
) -> dict:
    draft = _load_draft_or_404(draft_id)
    _ensure_mutable(draft)
    if draft["status"] == "proposed":
        draft = store.set_draft_status(draft_id, "ready") or draft

    recipe = _recipe(draft)
    prompt = _video_prompt(draft)
    model_id = _video_model_for(recipe, req.model_override)

    try:
        assets = fal_generation.generate_video(
            prompt=prompt,
            output_dir=_draft_dir(draft),
            model_id=model_id,
            arguments=req.arguments,
            variant_count=req.variant_count,
        )
        store.insert_draft_assets(draft_id, assets, status="draft")
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    updated = store.get_draft(draft_id)
    return {"draft": _public_draft(updated or draft)}


@router.post("/api/drafts/{draft_id}/upload")
async def upload_draft_asset(
    draft_id: str,
    file: UploadFile = File(...),
    _fb_user_id: str = Depends(_require_authenticated_user),
) -> dict:
    draft = _load_draft_or_404(draft_id)
    _ensure_mutable(draft)
    first_chunk = await file.read(1024 * 1024)
    if not first_chunk:
        raise HTTPException(400, "Upload is empty.")
    mime_type, ext = _validated_upload_mime(file, first_chunk)
    dest_dir = _draft_dir(draft)
    dest_dir.mkdir(parents=True, exist_ok=True)
    path = dest_dir / f"manual-{int(time.time())}-{uuid.uuid4().hex[:8]}{ext}"

    written = len(first_chunk)
    try:
        with open(path, "wb") as out:
            if written > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "Upload is too large.")
            out.write(first_chunk)
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "Upload is too large.")
                out.write(chunk)
        store.insert_draft_assets(
            draft_id,
            [
                {
                    "path": str(path),
                    "mime_type": mime_type,
                    "fal_model_used": "manual_upload",
                    "cost_usd": 0,
                }
            ],
            status="draft",
        )
    except Exception:
        _remove_file(str(path))
        raise

    updated = store.get_draft(draft_id)
    return {"draft": _public_draft(updated or draft)}


@router.patch("/api/drafts/{draft_id}")
def update_draft(
    draft_id: str,
    req: UpdateDraftRequest,
    _fb_user_id: str = Depends(_require_authenticated_user),
) -> dict:
    draft = _load_draft_or_404(draft_id)
    status = req.status or draft["status"]
    try:
        updated = store.set_draft_status(draft_id, status, meta_ad_id=req.meta_ad_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"draft": _public_draft(updated or draft)}


@router.delete("/api/drafts/{draft_id}")
def delete_draft(
    draft_id: str,
    _fb_user_id: str = Depends(_require_authenticated_user),
) -> dict:
    draft = store.delete_draft(draft_id)
    if not draft:
        raise HTTPException(404, "Draft not found.")
    _remove_draft_files(draft)
    return {"ok": True, "draft_id": draft_id}


@router.get("/api/draft-assets/{asset_id}/file")
def get_draft_asset_file(
    asset_id: str,
    _fb_user_id: str = Depends(_require_authenticated_user),
):
    asset = store.get_draft_asset(asset_id)
    if not asset:
        raise HTTPException(404, "Asset not found.")
    path = Path(asset["path"])
    if not path.exists() or not path.is_file():
        raise HTTPException(404, "Asset file not found.")
    return FileResponse(path, media_type=asset["mime_type"], filename=path.name)


@router.delete("/api/draft-assets/{asset_id}")
def delete_draft_asset(
    asset_id: str,
    _fb_user_id: str = Depends(_require_authenticated_user),
) -> dict:
    asset = store.delete_draft_asset(asset_id)
    if not asset:
        raise HTTPException(404, "Asset not found.")
    _remove_file(asset.get("path") or "")
    draft = store.get_draft(asset["draft_id"])
    return {"ok": True, "draft": _public_draft(draft) if draft else None}
