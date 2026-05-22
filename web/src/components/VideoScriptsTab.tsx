/**
 * VideoScriptsTab. shared Whisper transcript UI (Lens v0.2. fully
 * browser-side)
 * ----------------------------------------------
 * Drops into either the Meta AdDetailPanel (`videoId` mode) or the Atria
 * detail panel (`videoUrl` mode). Identical UX in both:
 *
 *   1. On mount: derive a stable cache key from videoId/videoUrl, then
 *      look up `localStorage` for a previously-saved transcript.
 *   2. Cache hit → render the timed segment list immediately, no
 *      network or compute cost.
 *   3. Miss → render a "Generate script" button. Clicking fetches the
 *      video bytes through `/api/ads/video-bytes?u=…` (same-origin
 *      proxy that side-steps Meta-CDN CORS) and runs the embedded
 *      `@huggingface/transformers` Whisper pipeline locally.
 *      Transcripts are stored in `localStorage` keyed by the cache key,
 *      so subsequent loads of the same ad on the same browser are
 *      instant.
 *
 * Why browser-side? The user explicitly removed OpenAI Whisper and the
 * Python-side server transcription requires `mlx-whisper` / `faster-
 * whisper` install which doesn't run on every device. Browser Whisper
 * (WebGPU when available, WASM fallback) runs anywhere a modern browser
 * runs. no install, no API key, no audio upload.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Sparkles, Copy, RefreshCw, AlertCircle } from 'lucide-react'

type Segment = { start: number; end: number; text: string }

type ScriptPayload = {
  segments: Segment[]
  text: string
  duration?: number
  backend?: string
  modelId?: string
  cachedAt?: number
}

interface Props {
  /** Meta-tracked ads. Resolves to the locally-cached mp4 the API
   *  warmed during preview, served via /api/ads/video/{id}.mp4. */
  videoId?: string | null
  /** External ads (Atria, scrape). Fetched through /api/ads/video-bytes
   *  proxy so the browser can read the bytes without tripping CORS. */
  videoUrl?: string | null
}

// 18.5 → "00:18". Browser-side Whisper returns float seconds per chunk.
function fmtTs(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const mm = Math.floor(s / 60).toString().padStart(2, '0')
  const ss = (s % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

// Compute a stable string key for the (videoId|videoUrl) input. Strip
// query strings on URLs so signed-CDN rotation doesn't bust the cache.
function cacheKeyFor(videoId?: string | null, videoUrl?: string | null): string | null {
  if (videoId) return `meta:${videoId}`
  if (videoUrl) {
    try {
      const u = new URL(videoUrl)
      return `url:${u.origin}${u.pathname}`
    } catch {
      return `url:${videoUrl}`
    }
  }
  return null
}

const LS_PREFIX = 'lens.script.v1.'

function readCache(key: string): ScriptPayload | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key)
    if (!raw) return null
    return JSON.parse(raw) as ScriptPayload
  } catch {
    return null
  }
}

function writeCache(key: string, payload: ScriptPayload): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(payload))
  } catch {
    // Quota / private-mode. silently ignore. Re-transcribe next visit.
  }
}

export function VideoScriptsTab({ videoId, videoUrl }: Props) {
  const [data, setData] = useState<ScriptPayload | null>(null)
  const [state, setState] = useState<'unknown' | 'cached' | 'missing' | 'generating' | 'error'>('unknown')
  const [progressNote, setProgressNote] = useState<string>('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const key = useMemo(() => cacheKeyFor(videoId, videoUrl), [videoId, videoUrl])

  // Cache check on mount / key change.
  useEffect(() => {
    if (!key) {
      setState('error')
      setErrorMsg('No video source available for this ad.')
      return
    }
    const cached = readCache(key)
    if (cached) {
      setData(cached)
      setState('cached')
    } else {
      setState('missing')
    }
  }, [key])

  const sourceUrl = useMemo<string | null>(() => {
    // Prefer the local-cached Meta video file (no CORS, no proxy needed)
    // when we have a videoId. Otherwise route through the same-origin
    // proxy so we can fetch() Atria / external CDN bytes.
    if (videoId) return `/api/ads/video/${encodeURIComponent(videoId)}.mp4`
    if (videoUrl) return `/api/ads/video-bytes?u=${encodeURIComponent(videoUrl)}`
    return null
  }, [videoId, videoUrl])

  const generate = useCallback(async (force = false) => {
    if (!key || !sourceUrl) return
    if (!force) {
      const cached = readCache(key)
      if (cached) { setData(cached); setState('cached'); return }
    }
    setState('generating')
    setErrorMsg(null)
    setProgressNote('Fetching video…')
    try {
      const r = await fetch(sourceUrl, { credentials: 'include' })
      if (!r.ok) throw new Error(`Video fetch failed: HTTP ${r.status}`)
      const blob = await r.blob()
      setProgressNote('Loading Whisper model…')
      const { loadBrowserWhisper, transcribeBlobInBrowser } = await import('../lib/browserWhisper')
      // Warm the model first so we can surface download progress
      // (no-op after first call this session).
      await loadBrowserWhisper((p) => {
        if (p?.progress != null && p.file) {
          setProgressNote(`Downloading ${p.file} · ${Math.round(p.progress)}%`)
        }
      })
      setProgressNote('Transcribing…')
      const result = await transcribeBlobInBrowser(blob, { withTimestamps: true })
      const payload: ScriptPayload = {
        segments: result.segments,
        text: result.text,
        duration: result.durationSec,
        backend: result.backend,
        modelId: result.modelId,
        cachedAt: Date.now(),
      }
      writeCache(key, payload)
      setData(payload)
      setState('cached')
    } catch (e: any) {
      setState('error')
      setErrorMsg(e?.message || 'Transcription failed.')
    } finally {
      setProgressNote('')
    }
  }, [key, sourceUrl])

  const copyAll = useCallback(() => {
    if (!data?.segments?.length) {
      if (data?.text) navigator.clipboard?.writeText(data.text).catch(() => {})
      return
    }
    const txt = data.segments
      .map(s => `${fmtTs(s.start)}  ${s.text}`)
      .join('\n')
    navigator.clipboard?.writeText(txt).catch(() => {})
  }, [data])

  const clearCache = useCallback(() => {
    if (!key) return
    try { localStorage.removeItem(LS_PREFIX + key) } catch {}
  }, [key])

  // --- Render ---------------------------------------------------------

  if (state === 'unknown') {
    return (
      <div className="flex items-center gap-2 text-[12px] text-text-muted p-3">
        <Loader2 size={12} className="animate-spin" />
        Checking transcript cache…
      </div>
    )
  }

  if (state === 'missing' || state === 'generating') {
    const generating = state === 'generating'
    return (
      <div className="p-4 text-center">
        <div className="mx-auto mb-2 w-9 h-9 rounded-full bg-[#B7410E]/10 flex items-center justify-center">
          <Sparkles size={16} className="text-[#B7410E]" />
        </div>
        <div className="font-display text-[14px] mb-1">No script yet</div>
        <div className="text-[11px] text-text-muted mb-3 max-w-[300px] mx-auto leading-relaxed">
          Whisper runs entirely in your browser. no upload, no API key.
          Cached locally so subsequent opens are instant.
        </div>
        {/* Quiet glass pill. matches the rest of Lens's small-action
            buttons (Re-analyze / Transcribe in the panel header). The
            solid-orange CTA was visually loud + duplicated its label
            below; both fixed here. */}
        <button
          disabled={generating || !sourceUrl}
          onClick={() => generate(false)}
          className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-[11px] glass glass-hover text-text-primary disabled:opacity-60"
        >
          {generating ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
          {generating ? (progressNote || 'Transcribing…') : 'Generate script'}
        </button>
        {/* Progress note removed below the button. the button label
            already shows the current step. No duplicate "Transcribing…"
            stacking. */}
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="p-4">
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-900 flex items-start gap-2">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-medium mb-0.5">Transcription failed</div>
            <div>{errorMsg}</div>
          </div>
        </div>
        <button
          onClick={() => generate(true)}
          className="mt-2 text-[11px] text-[#B7410E] hover:underline inline-flex items-center gap-1"
        >
          <RefreshCw size={10} />
          Try again
        </button>
      </div>
    )
  }

  // state === 'cached'. render the transcript
  const segs = data?.segments || []
  const hasText = !!data?.text
  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 flex items-center gap-2 border-b border-black/[0.06]">
        <div className="font-display text-[13px]">Video Scripts</div>
        <div className="text-[10px] text-text-muted">
          {segs.length > 0
            ? `${segs.length} segment${segs.length === 1 ? '' : 's'}`
            : hasText ? 'text only' : 'empty'}
          {data?.backend ? ` · ${data.backend}` : ''}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={copyAll}
            className="inline-flex items-center gap-1 h-6 px-2 rounded-md hover:bg-black/[0.04] text-[10px] text-text-secondary"
            title="Copy transcript"
          >
            <Copy size={10} />
            Copy
          </button>
          <button
            onClick={() => { clearCache(); generate(true) }}
            className="inline-flex items-center gap-1 h-6 px-2 rounded-md hover:bg-black/[0.04] text-[10px] text-text-muted"
            title="Re-transcribe (bypasses cache)"
          >
            <RefreshCw size={10} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {segs.length === 0 ? (
          hasText ? (
            <div className="text-[12px] leading-relaxed whitespace-pre-wrap text-text-primary">
              {data!.text}
            </div>
          ) : (
            <div className="text-[12px] text-text-muted text-center py-6">
              Empty transcript. the video may be music-only or silent.
            </div>
          )
        ) : (
          segs.map((s, i) => (
            <div key={i} className="flex gap-3 text-[12px] leading-relaxed">
              <span className="font-mono text-[10px] text-[#B7410E] shrink-0 pt-0.5 w-12 tabular-nums">
                {fmtTs(s.start)}
              </span>
              <span className="text-text-primary">{s.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default VideoScriptsTab
