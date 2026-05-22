"""Local audio transcription for Odylic Lens.

Free, open-source, self-hosted Whisper. Replaces the OpenAI Whisper API
dependency for users who want their ad-audio analysis to stay on-device.

Backends (auto-selected at module import. lazy model load):
* ``mlx-whisper`` on Apple Silicon (Darwin + arm64). Default. Uses
  Metal + ANE via Apple's MLX, ~30x realtime on M2 Pro.
* ``faster-whisper`` on Intel Mac / Linux / Windows. CPU int8.

If neither package is installed, the endpoints respond with a structured
503 that includes the exact ``pip install`` hint. the API itself still
imports and serves all other routes.

A 200-KB ``silero-vad`` pre-pass detects whether a clip contains any
speech before we burn a Whisper call on what might be music-only ads.

Notes:
* Model loads lazily on the first transcribe request (~800MB download
  on first run, then HF cache). Keeps API cold start fast.
* ``language="en"`` and ``condition_on_previous_text=False`` are locked
  in per the research doc. short ad clips with heavy music
  hallucinate badly under autodetect + previous-text conditioning.
* Per-request hard timeout of 5 minutes wall-clock.
* All downloaded files / temp audio live under ``~/.odylic-lens/cache``.
"""
from __future__ import annotations

import asyncio
import os
import platform
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Body
from fastapi.responses import JSONResponse
from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Cache directory. all transcription state stays under ~/.odylic-lens/
# ---------------------------------------------------------------------------

_CACHE_ROOT = Path(os.environ.get("ODYLIC_LENS_HOME", str(Path.home() / ".odylic-lens"))) / "cache" / "transcription"
_CACHE_ROOT.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Engine detection. done at import time, but only the *capability*, not
# the model. Importing mlx_whisper is cheap (~50ms); loading the model
# weights is what's expensive and we defer that to the first call.
# ---------------------------------------------------------------------------

_IS_APPLE_SILICON = platform.system() == "Darwin" and platform.machine() == "arm64"
_PLATFORM_TAG = f"{platform.system().lower()}-{platform.machine()}"

# One of: "mlx-whisper" | "faster-whisper" | None
_ENGINE: Optional[str] = None
_DEVICE: str = "cpu"
_MISSING_PACKAGES: list[str] = []

# Cached lazy state (populated on first transcribe call).
_model: Any = None
_vad_model: Any = None
_vad_get_speech_timestamps: Any = None


def _detect_engine() -> None:
    """Pick the best engine available on this machine. Cheap. import only."""
    global _ENGINE, _DEVICE, _MISSING_PACKAGES

    if _IS_APPLE_SILICON:
        try:
            import mlx_whisper  # noqa: F401
            _ENGINE = "mlx-whisper"
            _DEVICE = "mps"
            return
        except Exception:
            _MISSING_PACKAGES.append("mlx-whisper")

    # Fallback (or non-Apple-Silicon): faster-whisper
    try:
        from faster_whisper import WhisperModel  # noqa: F401
        _ENGINE = "faster-whisper"
        # CTranslate2 picks CPU by default; CUDA if available.
        try:
            import torch  # type: ignore
            if torch.cuda.is_available():
                _DEVICE = "cuda"
            else:
                _DEVICE = "cpu"
        except Exception:
            _DEVICE = "cpu"
        return
    except Exception:
        _MISSING_PACKAGES.append("faster-whisper")

    _ENGINE = None


_detect_engine()


# Model selection per engine. Env override lets power users swap to
# full large-v3 or smaller variants for CI.
_MLX_MODEL = os.environ.get("LENS_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
_FW_MODEL = os.environ.get("LENS_WHISPER_MODEL_FW", "large-v3")

# Display name for /status
_MODEL_NAME = _MLX_MODEL if _ENGINE == "mlx-whisper" else (_FW_MODEL if _ENGINE == "faster-whisper" else "")


# ---------------------------------------------------------------------------
# Helpers. download URL → local file; ffmpeg → wav for VAD
# ---------------------------------------------------------------------------

def _download_to_temp(url: str) -> Path:
    """Stream a remote URL to a temp file under the lens cache dir.

    Returns the local path. Caller is responsible for cleanup (we put it
    under a per-request subdir so an unlink-all on exit is safe).
    """
    if not url or not isinstance(url, str):
        raise HTTPException(status_code=400, detail="url is empty")
    if not url.lower().startswith(("http://", "https://")):
        # Allow already-local cache hits served by the API itself.
        # Anything else (file://, ftp://, etc) is rejected.
        if url.startswith("/api/ads/video/"):
            # Resolve to the on-disk path that ad_analysis_endpoints serves.
            from ad_analysis_endpoints import VIDEO_FILE_CACHE_DIR
            fname = url.rsplit("/", 1)[-1]
            local = Path(VIDEO_FILE_CACHE_DIR) / fname
            if not local.exists():
                raise HTTPException(status_code=404, detail=f"cached video not found: {fname}")
            return local
        raise HTTPException(status_code=400, detail="url must be http(s) or /api/ads/video/<id>.mp4")

    # Each request gets a fresh subdir so we can wipe on cleanup.
    workdir = Path(tempfile.mkdtemp(prefix="lens-trx-", dir=str(_CACHE_ROOT)))
    # Don't trust the URL filename. Meta CDN URLs have huge query strings.
    out = workdir / "input.media"
    try:
        with httpx.Client(timeout=120.0, follow_redirects=True) as cx:
            with cx.stream("GET", url) as r:
                r.raise_for_status()
                with open(out, "wb") as fh:
                    for chunk in r.iter_bytes(chunk_size=256 * 1024):
                        fh.write(chunk)
    except httpx.HTTPError as e:
        shutil.rmtree(workdir, ignore_errors=True)
        raise HTTPException(status_code=502, detail=f"failed to fetch media: {e}") from e
    return out


def _ffmpeg_to_wav_16k(src: Path) -> Path:
    """Convert any media file to 16kHz mono WAV (silero-vad's required input).

    Whisper engines accept arbitrary inputs (they call ffmpeg internally),
    but silero-vad needs 16kHz mono PCM. We do this once and feed the
    same WAV to both stages.
    """
    if shutil.which("ffmpeg") is None:
        # No ffmpeg. skip VAD and let the whisper engine handle decode.
        return src
    out = src.with_suffix(".wav")
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", str(src),
                "-ac", "1", "-ar", "16000",
                "-vn", "-f", "wav",
                str(out),
            ],
            check=True,
            capture_output=True,
            timeout=120,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        # Best effort. fall back to the original file.
        return src
    return out


# ---------------------------------------------------------------------------
# VAD pre-pass. skip Whisper entirely if there's no speech
# ---------------------------------------------------------------------------

def _load_vad() -> bool:
    """Lazy-load silero-vad. Returns True iff loaded, False otherwise."""
    global _vad_model, _vad_get_speech_timestamps
    if _vad_model is not None:
        return True
    try:
        # silero-vad >=5.0 ships a tiny python API; no torch.hub download.
        from silero_vad import load_silero_vad, get_speech_timestamps  # type: ignore
        _vad_model = load_silero_vad()
        _vad_get_speech_timestamps = get_speech_timestamps
        return True
    except Exception as e:
        print(f"[transcription] silero-vad unavailable, skipping VAD: {e}", flush=True)
        return False


def _has_speech(wav_path: Path) -> bool:
    """Return True if the clip contains any human speech.

    If VAD can't load (package missing), assume True so we don't drop
    valid clips on the floor.
    """
    if not _load_vad():
        return True
    try:
        import torch  # type: ignore
        import torchaudio  # type: ignore
        wav, sr = torchaudio.load(str(wav_path))
        if sr != 16000:
            # silero-vad needs 16kHz; resample if ffmpeg didn't.
            wav = torchaudio.functional.resample(wav, sr, 16000)
        if wav.shape[0] > 1:
            wav = wav.mean(dim=0, keepdim=True)
        wav = wav.squeeze(0)
        ts = _vad_get_speech_timestamps(wav, _vad_model, sampling_rate=16000)
        return bool(ts)
    except Exception as e:
        print(f"[transcription] VAD pass failed, assuming speech: {e}", flush=True)
        return True


# ---------------------------------------------------------------------------
# Model loaders. lazy, cached
# ---------------------------------------------------------------------------

def _load_model() -> Any:
    """Load the Whisper model on first use. Cached module-level.

    Returns the engine-specific object. For mlx-whisper there isn't a
    persistent model object. the module is the loader and we cache a
    sentinel; for faster-whisper we cache the WhisperModel instance.
    """
    global _model
    if _model is not None:
        return _model

    t0 = time.time()
    if _ENGINE == "mlx-whisper":
        import mlx_whisper  # type: ignore
        _model = {"engine": "mlx-whisper", "module": mlx_whisper, "repo": _MLX_MODEL}
        print(
            f"[transcription] mlx-whisper ready, model={_MLX_MODEL} "
            f"(weights download on first call, cached after) ({time.time()-t0:.2f}s)",
            flush=True,
        )
    elif _ENGINE == "faster-whisper":
        from faster_whisper import WhisperModel  # type: ignore
        # int8 on CPU; float16 on CUDA.
        compute_type = "float16" if _DEVICE == "cuda" else "int8"
        _model = WhisperModel(
            _FW_MODEL,
            device=_DEVICE,
            compute_type=compute_type,
            download_root=str(_CACHE_ROOT / "faster-whisper"),
        )
        print(
            f"[transcription] faster-whisper ready, model={_FW_MODEL}, "
            f"device={_DEVICE}, compute={compute_type} ({time.time()-t0:.2f}s)",
            flush=True,
        )
    else:
        raise RuntimeError("no transcription engine available")
    return _model


# ---------------------------------------------------------------------------
# Actual transcribe. engine-specific, runs in a thread (sync ML call)
# ---------------------------------------------------------------------------

def _transcribe_sync(audio_path: Path) -> dict:
    """Blocking transcription call. Returns the response dict.

    Locks language="en" and condition_on_previous_text=False per the
    research doc. Word timestamps included.
    """
    model = _load_model()
    if _ENGINE == "mlx-whisper":
        mod = model["module"]
        repo = model["repo"]
        result = mod.transcribe(
            str(audio_path),
            path_or_hf_repo=repo,
            word_timestamps=True,
            language="en",
            condition_on_previous_text=False,
            temperature=0.0,
        )
        segments = []
        for seg in result.get("segments") or []:
            segments.append({
                "start": float(seg.get("start") or 0.0),
                "end": float(seg.get("end") or 0.0),
                "text": (seg.get("text") or "").strip(),
                "words": [
                    {
                        "word": w.get("word", ""),
                        "start": float(w.get("start") or 0.0),
                        "end": float(w.get("end") or 0.0),
                    }
                    for w in (seg.get("words") or [])
                ],
            })
        text = (result.get("text") or "").strip()
        # mlx-whisper doesn't surface clip duration directly; sum segment ends.
        duration = max((s["end"] for s in segments), default=0.0)
        return {
            "text": text,
            "segments": segments,
            "language": (result.get("language") or "en"),
            "duration_sec": duration,
            "engine": "mlx-whisper",
            "model": "large-v3-turbo-q8" if "turbo" in _MLX_MODEL else _MLX_MODEL.rsplit("/", 1)[-1],
        }

    # faster-whisper path
    fw_segs, info = model.transcribe(  # type: ignore[union-attr]
        str(audio_path),
        language="en",
        condition_on_previous_text=False,
        word_timestamps=True,
        temperature=0.0,
        vad_filter=False,  # we ran silero-vad upstream
    )
    segments = []
    full_text_parts: list[str] = []
    for seg in fw_segs:
        words = []
        if seg.words:
            for w in seg.words:
                words.append({
                    "word": w.word,
                    "start": float(w.start or 0.0),
                    "end": float(w.end or 0.0),
                })
        seg_text = (seg.text or "").strip()
        if seg_text:
            full_text_parts.append(seg_text)
        segments.append({
            "start": float(seg.start or 0.0),
            "end": float(seg.end or 0.0),
            "text": seg_text,
            "words": words,
        })
    return {
        "text": " ".join(full_text_parts).strip(),
        "segments": segments,
        "language": (info.language or "en"),
        "duration_sec": float(info.duration or 0.0),
        "engine": "faster-whisper",
        "model": _FW_MODEL,
    }


# ---------------------------------------------------------------------------
# Resolve ad_id → playable video URL (uses existing ad_analysis helpers)
# ---------------------------------------------------------------------------

def _resolve_ad_id_to_url(ad_id: str) -> str:
    """Look up the cached/Meta-resolved video URL for an ad.

    Hits the existing creative cache → video-metadata pipeline in
    ad_analysis_endpoints. Raises HTTPException with a clear message if
    the ad has no video or the token isn't available.
    """
    try:
        from lens_context import current_token, current_accounts
        from ad_analysis_endpoints import (
            _fetch_ad_creative,
            _get_video_metadata,
            _video_file_cache_lookup,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ad helpers unavailable: {e}")

    token = current_token() or os.environ.get("META_ACCESS_TOKEN")
    if not token:
        raise HTTPException(status_code=401, detail="not logged in. no Meta access token")

    # The first available brand+account gets used; the creative fetch
    # only really needs the token + ad_id, brand is for cache hygiene.
    accounts = current_accounts() or {}
    brand = next(iter(accounts.keys()), None) if accounts else None
    account_id = accounts.get(brand) if brand else None

    try:
        creative = _fetch_ad_creative(ad_id, token, brand=brand, account_id=account_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ad creative fetch failed: {e}")

    if not creative:
        raise HTTPException(status_code=404, detail=f"ad {ad_id} not found")

    video_id = (creative.get("video_id") or "").strip()
    if not video_id:
        raise HTTPException(status_code=404, detail=f"ad {ad_id} has no video. only video ads can be transcribed")

    # Prefer the locally cached mp4 (no expiration, no extra round trip).
    local = _video_file_cache_lookup(video_id)
    if local:
        return f"file://{local}"

    vd = _get_video_metadata(video_id, token)
    src = (vd or {}).get("source")
    if not src:
        raise HTTPException(status_code=502, detail=f"no playable URL for video_id={video_id}")
    return src


# ---------------------------------------------------------------------------
# FastAPI router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/transcribe", tags=["transcription"])


class TranscribeRequest(BaseModel):
    url: Optional[str] = None
    ad_id: Optional[str] = None


def _not_installed_response() -> JSONResponse:
    install_target = "mlx-whisper" if _IS_APPLE_SILICON else "faster-whisper"
    missing = sorted(set(_MISSING_PACKAGES or [install_target, "silero-vad"]))
    return JSONResponse(
        status_code=503,
        content={
            "error": "Transcription engine not installed.",
            "install_hint": "pip install -e '.[transcribe]'",
            "missing": missing,
            "platform": _PLATFORM_TAG,
        },
    )


@router.get("/status")
def transcribe_status() -> dict:
    """Lightweight status probe for the API Settings UI."""
    return {
        "engine": _ENGINE or "unavailable",
        "device": _DEVICE,
        "model_loaded": _model is not None,
        "model": _MODEL_NAME or None,
        "platform": _PLATFORM_TAG,
        "is_apple_silicon": _IS_APPLE_SILICON,
        "install_hint": None if _ENGINE else "pip install -e '.[transcribe]'",
    }


@router.post("")
async def transcribe(body: TranscribeRequest = Body(...)) -> Any:
    """Transcribe audio from a URL or an ad_id.

    Body:
      ``{"url": "https://..."}``. direct URL (Meta CDN mp4, http(s), or a
      ``/api/ads/video/<id>.mp4`` rehosted path).
      ``{"ad_id": "120..."}``. looks up the playable URL via the existing
      ad-analysis creative pipeline.
    """
    if _ENGINE is None:
        return _not_installed_response()

    if not body.url and not body.ad_id:
        raise HTTPException(status_code=400, detail="provide url or ad_id")

    url = body.url
    if body.ad_id and not url:
        url = _resolve_ad_id_to_url(body.ad_id)

    # `file://` shortcut for already-cached mp4s
    workdir: Optional[Path] = None
    if url and url.startswith("file://"):
        media_path = Path(url[len("file://"):])
        if not media_path.exists():
            raise HTTPException(status_code=404, detail="cached video missing on disk")
    else:
        media_path = _download_to_temp(url)
        workdir = media_path.parent if str(media_path).startswith(str(_CACHE_ROOT)) else None

    try:
        # ffmpeg → 16k mono wav (used by VAD; whisper engines handle this
        # internally so for them we pass the original).
        wav_path = _ffmpeg_to_wav_16k(media_path)

        # VAD pre-pass
        if not _has_speech(wav_path):
            duration = 0.0
            try:
                import torchaudio  # type: ignore
                _wav, _sr = torchaudio.load(str(wav_path))
                duration = float(_wav.shape[-1]) / float(_sr or 1)
            except Exception:
                pass
            return {
                "text": "",
                "segments": [],
                "no_speech": True,
                "duration_sec": duration,
                "language": "en",
                "engine": _ENGINE,
                "model": _MODEL_NAME,
            }

        # Hard 5-minute timeout on the actual transcribe call
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(_transcribe_sync, media_path),
                timeout=300.0,
            )
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="transcription timed out after 5 minutes")
        result["no_speech"] = False
        return result
    finally:
        # Clean up temp downloads (leave the persistent video cache alone).
        if workdir and workdir.exists() and str(workdir).startswith(str(_CACHE_ROOT)):
            shutil.rmtree(workdir, ignore_errors=True)
