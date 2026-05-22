# Lens Transcription Options (May 2026)

> **Status: implemented in v0.1.** The recommendation below shipped as
> the default local engine. Module: `api/transcription.py`. Install:
> `pip install -e '.[transcribe]'` from `api/`. Endpoints:
> `GET /api/transcribe/status`, `POST /api/transcribe`. UI: API Settings
> page in the web app. faster-whisper is the auto-fallback on
> Intel/Linux; silero-vad pre-pass skips music-only clips.

## Recommendation

**Bundle `mlx-whisper` with the `whisper-large-v3-turbo` model (8-bit quant) as the default free local backend in Lens v0.2.** Keep the OpenAI Whisper API as a one-line fallback for users on Intel Macs or under heavy concurrent load.

Why: it is the only option that hits all four constraints (Apple Silicon native, ≤16 GB RAM, ~95%+ of large-v3 quality on English, `pip install` simple) without compromise. CoreML/Metal acceleration is automatic via MLX. No CUDA, no separate build step, no Rosetta. Active maintenance (mlx-whisper 0.4.3 shipped Aug 2025; MLX core has weekly commits). Word-level timestamps are a single kwarg.

The "Whisper-equivalent or better" landscape has moved past the original `whisper.cpp` on M-series. MLX wins on speed (~30-40% over whisper.cpp on M-series, 3x on M1 Max), and `large-v3-turbo` closes the quality gap to within ~0.4 WER points of full `large-v3` for English while using half the memory.

---

## The Field, Ranked

| # | Option | Backend | Best Model | RAM (loaded) | Speed (M2 Pro, RTFx) | Quality vs large-v3 EN | Install |
|---|---|---|---|---|---|---|---|
| 1 | **mlx-whisper** | Apple MLX (Metal + ANE) | `large-v3-turbo` q8 | ~1.5 GB | ~30-50x realtime | ~99% (within 0.4 WER) | `pip install mlx-whisper` |
| 2 | **whisper.cpp** | C++ / GGML + CoreML | `large-v3-turbo` ggml-q5 | ~1.2 GB | ~20-30x realtime | ~99% | `brew install whisper-cpp` (CLI), Python wrappers exist but are messier |
| 3 | **faster-whisper** | CTranslate2 (CPU only on Mac) | `large-v3-turbo` int8 | ~2 GB | ~5-10x realtime | ~99% | `pip install faster-whisper` |
| 4 | **WhisperX** | faster-whisper + pyannote | `large-v3` + diarization | ~3-4 GB | ~5x realtime | ~99% + speaker labels | `pip install whisperx` (heavy deps, pyannote needs HF token) |

Other notable mentions:
- **Parakeet V3 (NVIDIA NeMo via parakeet-mlx)** — 10x faster than turbo, slightly better English WER (12.0% vs 12.6% on the multilingual avg, English-only is closer). But: English-only, no word timestamps out of the box, and the MLX port is still a single-maintainer project. Not stable enough to bundle yet.
- **distil-whisper (large-v3)** — fine, but `large-v3-turbo` is the same idea from OpenAI and is now the standard. Pick turbo.
- **WhisperKit** (Argmax) — Swift framework, fast on Apple Silicon, but Swift-first. Wrong language for a Python FastAPI backend.
- **lightning-whisper-mlx** — claims 4x over mlx-whisper, but last meaningful commit was 2024. Skip.
- **insanely-fast-whisper** — HF Transformers + Flash Attention 2. Great on CUDA, mediocre on Mac (no Flash Attn on Metal). Skip for Lens.

All four ranked options are MIT-licensed.

---

## Integration Plan: mlx-whisper

### Install (one line, add to `install.sh`)

```bash
pip install mlx-whisper && brew install ffmpeg
```

`ffmpeg` is required for non-WAV inputs. Lens already shells out to it for video frame extraction so this is a no-op on most user machines.

### Python: transcribe a file with word-level timestamps

```python
import mlx_whisper

MODEL = "mlx-community/whisper-large-v3-turbo"  # ~800MB, q4 variant available at -q4

def transcribe(audio_path: str) -> dict:
    """Returns {'text': str, 'segments': [...], 'words': [...]}."""
    result = mlx_whisper.transcribe(
        audio_path,
        path_or_hf_repo=MODEL,
        word_timestamps=True,
        language="en",          # set None for auto-detect; English is faster + better
        condition_on_previous_text=False,  # reduces hallucination loops on short ad clips
        temperature=0.0,
    )
    words = [
        {"word": w["word"], "start": w["start"], "end": w["end"]}
        for seg in result["segments"]
        for w in seg.get("words", [])
    ]
    return {"text": result["text"].strip(), "segments": result["segments"], "words": words}
```

First call downloads the model from HuggingFace Hub to `~/.cache/huggingface/hub/` (~800 MB for turbo, ~1.5 GB for full large-v3). Subsequent calls are instant.

### Model default

Ship `mlx-community/whisper-large-v3-turbo` as the default. Reasons:
- Same encoder as large-v3, only the decoder is pruned (32 → 4 layers).
- ~0.4 WER point gap vs large-v3 on English benchmarks. Real-world ad audio with music behind it will be dominated by the audio quality, not the model.
- Fits in 1.5 GB loaded. Ad clips of 5-60s transcribe in well under a second on M2 Pro.
- 99-language support if you ever flip `language=None`.

Expose `LENS_WHISPER_MODEL` env var so power users can swap to `mlx-community/whisper-large-v3` (full) or `-tiny` (for a CI smoke test).

### Long files / streaming

mlx-whisper chunks internally — anything up to a few hours works without OOM. No streaming API (it returns when done), which is fine for Lens (batch creative analysis, not live captioning). If you ever need streaming, switch to `whisper.cpp` server mode.

---

## Caveats

1. **Cold start.** First transcribe of a process loads the model into unified memory. Expect 2-4s on M2 Pro for turbo, 6-10s for full large-v3. Mitigate by keeping a long-lived worker process (already the case if Lens uses the FastAPI app — model loads on first request, stays resident).

2. **Model download on first run.** ~800 MB over the network. Add a `lens warmup` CLI subcommand that pre-pulls the model so the user's first real transcription isn't blocked on a download. Or trigger it in `install.sh` after install (faster perceived UX).

3. **Hallucination on silence / music-only clips.** Whisper family famously hallucinates on long silences and pure-music segments. Two defenses: (a) `condition_on_previous_text=False` (set above), (b) run a VAD pass first (`silero-vad` is 200 KB and trivial) and skip transcription if no speech is detected. Worth doing for Lens because plenty of ad creatives are music + visuals only.

4. **English vs other languages.** Lock `language="en"` for the default Lens workflow — it's faster and avoids language-detection mistakes on short clips. If a brand runs ads in ES/FR/etc., expose a per-brand setting. Quality on non-English is still good (turbo supports all 99 languages) but WER is materially higher for low-resource languages.

5. **No built-in speaker diarization.** Ad creatives rarely need it (usually 1 voice or VO + on-screen actor). If a user demands it, WhisperX is the upgrade path — but you pay in install complexity (pyannote, HF token, larger deps). Don't bundle by default.

6. **Apple Silicon only.** mlx-whisper does not run on Intel Macs or Linux. Lens should detect platform and fall back to `faster-whisper` (CPU, int8) on Intel/Linux, or surface the OpenAI API option. About 8 extra lines of code:

   ```python
   import platform
   IS_APPLE_SILICON = platform.system() == "Darwin" and platform.machine() == "arm64"
   ```

7. **License clarity.** mlx-whisper itself is MIT. The Whisper model weights are MIT (OpenAI released them that way). You can ship and redistribute freely.

---

## Sources

- [faster-whisper repo](https://github.com/SYSTRAN/faster-whisper)
- [mlx-whisper on PyPI](https://pypi.org/project/mlx-whisper/)
- [whisper.cpp repo](https://github.com/ggml-org/whisper.cpp)
- [whisper-large-v3-turbo model card](https://huggingface.co/openai/whisper-large-v3-turbo)
- [Whisper variants comparison (Modal)](https://modal.com/blog/choosing-whisper-variants)
- [Apple Silicon Whisper benchmarks](https://www.voicci.com/blog/apple-silicon-whisper-performance.html)
- [whisper.cpp vs faster-whisper 2026 benchmarks](https://www.promptquorum.com/power-local-llm/local-whisper-stt-comparison-2026)
- [Local Audio Transcription with MLX Whisper, Feb 2026](https://www.hylkerozema.nl/2026/02/24/local-audio-transcription-with-mlx-whisper-and-claude-on-apple-silicon/)
- [Parakeet V3 vs Whisper](https://whispernotes.app/blog/parakeet-v3-default-mac-model)
- [Whisper Large V3 Turbo benchmark](https://whispernotes.app/blog/introducing-whisper-large-v3-turbo)
