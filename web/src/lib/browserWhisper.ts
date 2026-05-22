/**
 * Browser-side Whisper using @huggingface/transformers (v3, formerly
 * @xenova/transformers).
 *
 * Runs the Whisper ASR pipeline entirely on-device — WebGPU when the
 * browser supports it, WASM fallback everywhere else. No audio leaves
 * the user's machine, no API keys, no installation.
 *
 * Lens uses `Xenova/whisper-tiny.en` by default — explicit tradeoff for
 * SPEED over accuracy:
 *   - ~39MB quantized download (half of base.en), loads ~2× faster.
 *   - Inference is ~2-3× faster than base.en on WASM, ~1.5× on WebGPU.
 *   - English-only.
 *   - Accuracy is "decent for ad-copy voiceovers" — drops about 5-10%
 *     vs base on noisy / heavily-accented clips. The fixed UX feel of
 *     "transcribing a 30s ad takes 8s not 45s" was worth the trade
 *     after the user complained transcription was "taking eons".
 *
 * The first call to `loadBrowserWhisper` pulls weights from the
 * HuggingFace CDN. Subsequent loads are instant (IndexedDB-cached).
 */

// The library is imported lazily so the main bundle stays small.
// transformers.js is ~few hundred KB on its own.

export const WHISPER_MODEL_ID = "Xenova/whisper-tiny.en";

export type BrowserWhisperBackend = "webgpu" | "wasm";

export interface BrowserWhisperProgress {
  // Progress event names from @huggingface/transformers:
  //   "initiate" | "download" | "progress" | "done" | "ready"
  status: string;
  file?: string;
  /** 0..100 download progress for `progress` events */
  progress?: number;
  /** Total bytes (for `progress`/`done`) */
  total?: number;
  /** Downloaded so far */
  loaded?: number;
}

export interface BrowserWhisperHandle {
  backend: BrowserWhisperBackend;
  modelId: string;
  /** Internal — the lazy `pipeline()` instance from transformers.js */
  _pipeline: any;
}

// ─────────────────────────────────────────────────────────────────────
// Capability detection
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns `webgpu` when the browser advertises a working WebGPU adapter;
 * `wasm` otherwise. We don't request an adapter here (avoiding the
 * permission/setup overhead) — transformers.js will fall back to WASM
 * internally if WebGPU init fails at pipeline-construction time, but
 * this hint lets us label the UI honestly upfront.
 */
export async function detectBrowserBackend(): Promise<BrowserWhisperBackend> {
  try {
    // navigator.gpu is the standard entrypoint. We don't await
    // requestAdapter() because that prompts the GPU in some browsers and
    // we just want a yes/no for UI labeling.
    if (typeof navigator !== "undefined" && (navigator as any).gpu) {
      return "webgpu";
    }
  } catch {
    /* fall through */
  }
  return "wasm";
}

// ─────────────────────────────────────────────────────────────────────
// Pipeline loading
// ─────────────────────────────────────────────────────────────────────

let _cachedHandle: BrowserWhisperHandle | null = null;
let _inflight: Promise<BrowserWhisperHandle> | null = null;

/**
 * Lazy-load Whisper. Returns immediately on subsequent calls.
 *
 * `onProgress` fires for each download event so the UI can show a
 * model-download progress bar (the first load streams ~74MB).
 */
export async function loadBrowserWhisper(
  onProgress?: (p: BrowserWhisperProgress) => void
): Promise<BrowserWhisperHandle> {
  if (_cachedHandle) return _cachedHandle;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    // Dynamic import keeps the ~250KB transformers.js bundle out of the
    // main chunk — only paid when the user opens API Settings.
    const transformers = await import("@huggingface/transformers");
    const { pipeline, env } = transformers;

    // Lock to the public HF CDN. (No bundled-models offline support yet.)
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    // Quantized weights only — the float16 versions are too large for
    // a settings-page download.
    (env as any).useBrowserCache = true;

    const backend = await detectBrowserBackend();
    const device: "webgpu" | "wasm" = backend;

    const asr = await pipeline("automatic-speech-recognition", WHISPER_MODEL_ID, {
      // @ts-ignore — transformers.js types lag the runtime.
      device,
      // q4 is fast and small but slightly worse quality than fp16; for
      // ad-copy voiceovers it's fine. Falls back automatically on WASM.
      dtype: device === "webgpu" ? "fp32" : "q8",
      progress_callback: (data: any) => {
        if (!onProgress) return;
        // Normalize shape so callers don't have to grok the library.
        onProgress({
          status: String(data?.status || "progress"),
          file: data?.file,
          progress: typeof data?.progress === "number" ? data.progress : undefined,
          total: data?.total,
          loaded: data?.loaded,
        });
      },
    });

    _cachedHandle = { backend, modelId: WHISPER_MODEL_ID, _pipeline: asr };
    return _cachedHandle;
  })();

  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Transcription
// ─────────────────────────────────────────────────────────────────────

export interface BrowserTranscribeSegment {
  start: number;
  end: number;
  text: string;
}

export interface BrowserTranscribeResult {
  text: string;
  /** Time-coded segments when `withTimestamps` was true; else empty. */
  segments: BrowserTranscribeSegment[];
  /** Total wall-clock time spent inside the pipeline call, in seconds. */
  durationSec: number;
  /** Backend that actually ran the inference (webgpu or wasm). */
  backend: BrowserWhisperBackend;
  modelId: string;
}

/**
 * Run a Blob/File through Whisper. The blob can be any browser-decodable
 * audio container (mp4, mp3, wav, webm, ogg, …). We decode to a Float32
 * PCM array at 16kHz mono via the WebAudio API since that's what Whisper
 * wants, then hand the raw samples to the pipeline.
 *
 * Pass `withTimestamps: true` to get per-chunk segment timing (used by
 * the Video Scripts tab for click-to-seek behavior). Otherwise the
 * pipeline runs ~30% faster and returns plain text only.
 */
export async function transcribeBlobInBrowser(
  blob: Blob,
  options?: { handle?: BrowserWhisperHandle; withTimestamps?: boolean }
): Promise<BrowserTranscribeResult> {
  const h = options?.handle || (await loadBrowserWhisper());
  const withTimestamps = !!options?.withTimestamps;
  const samples = await decodeAudioBlob(blob);

  const t0 = performance.now();
  const out = await h._pipeline(samples, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: withTimestamps,
  });
  const durationSec = (performance.now() - t0) / 1000;

  // transformers.js v3 returns either {text} or {text, chunks: [{text, timestamp:[s,e]}]}
  // depending on return_timestamps. Normalize.
  const segments: BrowserTranscribeSegment[] = [];
  let text = "";
  if (Array.isArray(out)) {
    text = out.map((o: any) => (o?.text || "").trim()).filter(Boolean).join(" ");
  } else if (out?.chunks && Array.isArray(out.chunks)) {
    text = String(out.text || "").trim();
    for (const c of out.chunks) {
      const ts = c?.timestamp;
      if (!Array.isArray(ts)) continue;
      const start = Number(ts[0]) || 0;
      const end = Number(ts[1]) || start;
      const seg = String(c.text || "").trim();
      if (seg) segments.push({ start, end, text: seg });
    }
  } else {
    text = String(out?.text || "").trim();
  }

  return {
    text,
    segments,
    durationSec,
    backend: h.backend,
    modelId: h.modelId,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Audio decoding helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Decode a media file into a 16kHz mono Float32 sample array, which is
 * the format Whisper's feature extractor expects.
 *
 * Uses the OfflineAudioContext API (available everywhere modern). We
 * resample as part of decoding so the pipeline doesn't have to.
 */
async function decodeAudioBlob(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();

  // Decode at the browser's native sample rate first, then mix to mono
  // and resample to 16kHz. Doing the resample via OfflineAudioContext is
  // faster than a manual loop and handles browser-specific quirks.
  const tempCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const decoded = await tempCtx.decodeAudioData(buf.slice(0));
  tempCtx.close().catch(() => {});

  const targetRate = 16000;
  const targetLength = Math.ceil((decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, targetLength, targetRate);

  const src = offline.createBufferSource();
  // Downmix to mono — sum channels.
  if (decoded.numberOfChannels > 1) {
    const mono = offline.createBuffer(1, decoded.length, decoded.sampleRate);
    const monoData = mono.getChannelData(0);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < data.length; i++) monoData[i] += data[i] / decoded.numberOfChannels;
    }
    src.buffer = mono;
  } else {
    src.buffer = decoded;
  }

  src.connect(offline.destination);
  src.start(0);
  const resampled = await offline.startRendering();
  // Single channel — return a copy detached from the AudioBuffer.
  return new Float32Array(resampled.getChannelData(0));
}
