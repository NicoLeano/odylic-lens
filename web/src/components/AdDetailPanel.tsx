import { useEffect, useMemo, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, Sparkles, RefreshCw, ExternalLink, Tag, ArrowUp, ArrowDown, MessageSquare, Download, Copy, Eye, ChevronLeft, ChevronRight } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from 'recharts'
import type { AdCreative, NameConvention } from './AdAnalysisView'
import { toProxyImg } from './AdAnalysisView'
import { withCustomMetrics } from './ads/customMetrics'
import { CommentsView } from './ads/CommentsView'
// SaveToBoardButton was removed from AdDetailPanel. boards now only
// apply to Atria search results (competitor / inspo), not our own ads.
import { PlacementBreakdownChart, VideoRetentionChart } from './ads/PerformanceCharts'

// True when this is the standalone report HTML (no backend). Every fetch
// site below early-returns on this so the offline file never tries to
// reach /api/* and never surfaces "Failed to fetch" to the viewer.
const IN_REPORT = typeof window !== 'undefined' && !!(window as any).__REPORT__

// Fetch with silent retries on transient errors. Brief API blips (eg.
// an `uvicorn` restart underneath an open panel) resolve invisibly
// instead of leaving "Failed to fetch" stuck on the chart. 3 attempts
// with 700ms / 1500ms backoff.
async function fetchJSONWithRetry(url: string, attempts = 3): Promise<any> {
  let lastErr: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url)
      const text = await r.text()
      let body: any = {}
      try { body = text ? JSON.parse(text) : {} } catch { body = { detail: text.slice(0, 200) } }
      if (!r.ok) {
        if (r.status >= 500 || r.status === 0 || r.status === 502 || r.status === 503 || r.status === 504) {
          lastErr = new Error(body?.detail || `HTTP ${r.status}`)
        } else {
          throw new Error(body?.detail || `HTTP ${r.status}`)
        }
      } else {
        return body
      }
    } catch (e) {
      lastErr = e
    }
    if (i < attempts - 1) {
      await new Promise(res => setTimeout(res, 700 + 800 * i))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

// Session-scoped analysis cache. Keyed by creative_hash when available
// (so the same creative across two different ad_ids reuses the analysis)
// and by ad_id otherwise. Skips the /api/ads/analyze round-trip. even
// the cached server path costs ~150ms and a spinner flash. when the
// user reopens an ad they've already viewed this session.
const ANALYSIS_MEM_CACHE = new Map<string, FileAnalysis>()
const analysisCacheKey = (ad: { ad_id: string; creative_hash?: string | null }) =>
  ad.creative_hash || ad.ad_id

interface Props {
  ad: AdCreative
  brand: string
  start: string
  end: string
  // Optional explicit compare window. When supplied, the detail panel uses
  // these dates for the "vs. prior period" fetch instead of deriving a
  // trailing window from (start, end).
  compareStart?: string
  compareEnd?: string
  // Preloaded analysis from the dashboard payload, keyed by creative_hash
  // upstream. When supplied we skip the /analyze round-trip entirely so
  // opening the panel doesn't flash a fresh "analyzing…" spinner for an
  // ad whose analysis is already cached on disk and already in memory.
  preloadedAnalysis?: FileAnalysis | null
  onClose: () => void
  // Step through the filtered ad list without closing the panel.
  // Parent wires these to advance the selected ad in the same order
  // the user sees in the grid/table; undefined hides the affordances
  // (e.g. when there's only one ad in the current view).
  onPrev?: () => void
  onNext?: () => void
  position?: { current: number; total: number }
}

// Full FileAnalysis schema (mirrors bulk-ad-analyzer types.ts)
type CompositionAnalysis = {
  subjectBoundingBox?: { x: number; y: number; width: number; height: number }
  textPlacements?: {
    text: string
    type: string
    placementDescription: string
    scaleDescription: string
    fontStyleDescription: string
  }[]
  negativeSpaceDescription?: string
  overallComposition?: string
}

export type FileAnalysis = {
  // Core Strategy
  angle?: string
  hook?: string
  concept?: string
  persona?: string
  brand?: string
  // Audience & Market
  marketAwareness?: string
  demographics?: string
  marketSophistication?: string
  // Funnel & Offer
  funnelPosition?: string
  offer?: string
  // Copy
  headline?: string
  bodyCopy?: string
  cta?: string
  sentiment?: string
  // Visual & Production
  style?: string
  template?: string
  productionQuality?: string
  layoutDescription?: string
  textOverlay?: string
  colors?: string[]
  products?: string[]
  compositionAnalysis?: CompositionAnalysis
  // Technical
  format?: string
  aspectRatio?: string
  intendedPlacement?: string
  // Thematic
  emotion?: string
  marketingMoment?: string
  category?: string
  collection?: string
  tags?: string[]
  // Performance & Differentiation scores
  creativeClarityScore?: number
  creativeClarityFeedback?: string
  visualDifferentiationScore?: number
  visualDifferentiationSummary?: string
  messagingDifferentiationScore?: number
  messagingDifferentiationSummary?: string
  // Legacy shape
  composition?: string
  visual_elements?: string[]
  people?: string
  product_shown?: string
  copy_on_image?: string
  tone_mood?: string
  likely_persona?: string
  strengths?: string[]
  improvements?: string[]
  raw?: string
  error?: string
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function fmtDate(s: any) {
  const str = String(s ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return str
  const d = new Date(str + 'T00:00:00')
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

function fmt$(n: number): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '-'
  if (Math.abs(n) >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return `$${n.toFixed(2)}`
}
function fmtPct(n: number) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-'
  return `${n.toFixed(2)}%`
}
function fmtNum(n: number) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-'
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}
function fmtDec(n: number) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-'
  return n.toFixed(2)
}

// ---------------------------------------------------------------------------
// Metric grouping. Motion-style. Mirrors the AdAnalysisView picker so the
// detail panel and the table agree on what lives in which section.
// ---------------------------------------------------------------------------

type DetailFormat = 'dollar' | 'number' | 'percent' | 'decimal' | 'seconds'
type DetailMetric = { key: string; label: string; format: DetailFormat }

const DETAIL_GROUPS: { name: string; metrics: DetailMetric[] }[] = [
  {
    name: 'Performance',
    metrics: [
      { key: 'spend', label: 'Spend', format: 'dollar' },
      { key: 'aov', label: 'AOV', format: 'dollar' },
      { key: 'roas', label: 'ROAS', format: 'decimal' },
      { key: 'impressions', label: 'Impressions', format: 'number' },
      { key: 'reach', label: 'Reach', format: 'number' },
      { key: 'frequency', label: 'Frequency', format: 'decimal' },
      { key: 'cpm', label: 'CPM', format: 'dollar' },
      { key: 'cost_per_1k_ac_reached', label: 'Cost per 1K AC reached', format: 'dollar' },
    ],
  },
  {
    name: 'Clicks',
    metrics: [
      { key: 'link_clicks', label: 'Link clicks', format: 'number' },
      { key: 'outbound_clicks', label: 'Clicks (outbound)', format: 'number' },
      { key: 'ctr_link', label: 'CTR (link click)', format: 'percent' },
      { key: 'ctr_outbound', label: 'CTR (outbound)', format: 'percent' },
      { key: 'cpc_link', label: 'CPC (link click)', format: 'dollar' },
      { key: 'cpc_outbound', label: 'CPC (outbound)', format: 'dollar' },
    ],
  },
  {
    name: 'Engagement',
    metrics: [
      { key: 'page_follows', label: 'Follows or likes', format: 'number' },
      { key: 'follow_like_rate', label: '% follows or likes', format: 'percent' },
      { key: 'post_comments', label: 'Comments', format: 'number' },
      { key: 'comment_rate', label: '% comments', format: 'percent' },
      { key: 'post_engagement', label: 'Post engagements', format: 'number' },
      { key: 'engagement_rate', label: '% engagements', format: 'percent' },
      { key: 'post_reactions', label: 'Post reactions', format: 'number' },
      { key: 'post_shares', label: 'Post shares', format: 'number' },
      { key: 'psr', label: 'PSR', format: 'decimal' },
      { key: 'see_more_rate', label: 'See more rate', format: 'percent' },
    ],
  },
  {
    name: 'Media',
    metrics: [
      { key: 'video_avg_time_watched', label: 'Video avg. play time', format: 'seconds' },
      { key: 'video_views', label: 'Video plays', format: 'number' },
      { key: 'video_3s_views', label: '3s video plays', format: 'number' },
      { key: 'thruplays', label: 'ThruPlays', format: 'number' },
      { key: 'first_frame_retention', label: '1st frame retention', format: 'percent' },
      { key: 'hook_rate', label: 'Thumbstop (Hook rate)', format: 'percent' },
      { key: 'hold_rate', label: 'Hold rate', format: 'percent' },
      { key: 'sustain_rate', label: 'Sustain rate', format: 'percent' },
      { key: 'v15_to_3s', label: '15s/3s video rate', format: 'percent' },
    ],
  },
  {
    name: 'Conversion funnel',
    metrics: [
      { key: 'click_quality', label: 'Click quality', format: 'percent' },
      { key: 'click_to_atc', label: 'Click to ATC', format: 'percent' },
      { key: 'click_to_leads', label: 'Click to leads', format: 'percent' },
      { key: 'click_to_purchase', label: 'Click to purchase', format: 'percent' },
      { key: 'atc_to_purchase', label: 'ATC to purchase', format: 'percent' },
    ],
  },
  {
    name: 'Conversions',
    metrics: [
      { key: 'purchases', label: 'Purchases', format: 'number' },
      { key: 'revenue', label: 'Purchase value', format: 'dollar' },
      { key: 'cpa', label: 'CPA', format: 'dollar' },
      { key: 'add_to_cart', label: 'ATC', format: 'number' },
      { key: 'add_to_cart_value', label: 'ATC Value', format: 'dollar' },
      { key: 'landing_page_views', label: 'Landing page views', format: 'number' },
    ],
  },
]

function formatDetailValue(val: any, format: DetailFormat): string {
  if (val === undefined || val === null || Number.isNaN(Number(val))) return '-'
  const n = Number(val)
  switch (format) {
    case 'dollar': return fmt$(n)
    case 'percent': return fmtPct(n)
    case 'decimal': return fmtDec(n)
    case 'seconds': return `${n.toFixed(1)}s`
    default: return fmtNum(n)
  }
}

// Metrics where "lower is better". deltas invert color.
const LOWER_IS_BETTER = new Set<string>([
  'cpm', 'cpc', 'cpc_link', 'cpc_outbound', 'cpa', 'cost_per_purchase',
  'cost_per_atc', 'cost_per_1k_ac_reached', 'cost_per_unique_outbound_click',
  'stop_rate',
])

// Build a human-friendly caption for the compare window, based on how the
// user selected it. Handles four buckets:
//   1. trailing same-length window -> "vs. prior period"
//   2. same calendar range a year ago -> "vs. same period last year"
//   3. immediately-preceding calendar month -> "vs. prior month"
//   4. anything else -> explicit "vs. Mmm D – Mmm D, YYYY"
function compareLabel(
  curStart: string, curEnd: string,
  cmpStart: string, cmpEnd: string,
): string {
  const toD = (s: string) => {
    const d = new Date(s + 'T00:00:00')
    return Number.isNaN(d.getTime()) ? null : d
  }
  const s = toD(curStart), e = toD(curEnd), cs = toD(cmpStart), ce = toD(cmpEnd)
  if (!s || !e || !cs || !ce) return 'vs. prior period'
  const day = 24 * 3600 * 1000
  const curLen = Math.round((e.getTime() - s.getTime()) / day)
  const cmpLen = Math.round((ce.getTime() - cs.getTime()) / day)

  // 1. Trailing prior-period: compareEnd = start - 1 day AND same length.
  const expectedPriorEnd = new Date(s.getTime() - day)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  if (sameDay(ce, expectedPriorEnd) && curLen === cmpLen) {
    return 'vs. prior period'
  }

  // 2. Same period last year: compareStart has year < start year but same
  //    month + day (within a couple days of drift).
  if (
    cs.getFullYear() < s.getFullYear() &&
    Math.abs(cs.getMonth() - s.getMonth()) === 0 &&
    Math.abs(cs.getDate() - s.getDate()) <= 2
  ) {
    return 'vs. same period last year'
  }

  // 3. Prior month: compareStart month = start.month - 1 (or wraps to Dec of
  //    prior year) AND start day of month is 1.
  const priorMonth = (s.getMonth() - 1 + 12) % 12
  const priorMonthYear = s.getMonth() === 0 ? s.getFullYear() - 1 : s.getFullYear()
  if (
    cs.getMonth() === priorMonth &&
    cs.getFullYear() === priorMonthYear &&
    cs.getDate() <= 3
  ) {
    return 'vs. prior month'
  }

  // 4. Explicit range caption.
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const fmt = (d: Date, withYear: boolean) =>
    `${MON[d.getMonth()]} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ''}`
  return `vs. ${fmt(cs, false)} – ${fmt(ce, true)}`
}

export function AdDetailPanel({ ad, brand, start, end, compareStart, compareEnd, preloadedAnalysis, onClose, onPrev, onNext, position }: Props) {
  // Resolve the best available cached analysis at mount time. Order of
  // preference: in-memory session cache → caller-supplied preload → null.
  const cachedAnalysis = ANALYSIS_MEM_CACHE.get(analysisCacheKey(ad)) || preloadedAnalysis || null
  const [analysis, setAnalysis] = useState<FileAnalysis | null>(cachedAnalysis)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisErr, setAnalysisErr] = useState<string | null>(null)

  // Browser-side Whisper transcription. Triggered from a small button in
  // the header on video ads. the model auto-downloads on first use (the
  // Settings page kicks it off in the background; this is the fallback
  // if the user opened a video ad before visiting Settings).
  const [transcript, setTranscript] = useState<string>("")
  const [transcribing, setTranscribing] = useState(false)
  const [transcribeErr, setTranscribeErr] = useState<string | null>(null)
  const [transcribeOpen, setTranscribeOpen] = useState(false)

  async function runTranscribe() {
    setTranscribeErr(null)
    if (transcript) {
      // Already have it. just toggle the panel.
      setTranscribeOpen(v => !v)
      return
    }
    const videoUrl = (ad as any).video_source_url as string | undefined
    if (!videoUrl) {
      setTranscribeErr("No video source URL available for this ad.")
      setTranscribeOpen(true)
      return
    }
    setTranscribing(true)
    setTranscribeOpen(true)
    try {
      const { transcribeBlobInBrowser } = await import("../lib/browserWhisper")
      // Same-origin proxy so the Meta CDN URL clears CORS.
      const r = await fetch(`/api/ads/video-bytes?u=${encodeURIComponent(videoUrl)}`, {
        credentials: "include",
      })
      if (!r.ok) throw new Error(`Fetch failed: ${r.status}`)
      const blob = await r.blob()
      const result = await transcribeBlobInBrowser(blob)
      setTranscript(result.text || "(no speech detected)")
    } catch (e: any) {
      setTranscribeErr(e?.message || "Transcription failed.")
    } finally {
      setTranscribing(false)
    }
  }

  // Daily perf chart was removed (Meta omits per-day breakdowns for most
  // ads. the empty-state message was noisier than no section). The
  // fetch + state are also removed so we don't waste a Meta call on
  // every drawer open. If re-introduced later: GET /api/ads/creative/{ad_id}.

  // Previous-period totals for each metric. used for delta comparisons.
  const [compareTotals, setCompareTotals] = useState<Record<string, number> | null>(null)

  // Naming convention overrides. saved back to the brand profile via
  // /api/ads/naming-convention so the user can tweak the parser for their
  // account without a code change.
  const [ncOverride, setNcOverride] = useState<Partial<NameConvention> | null>(null)

  // Planner UCID lookup. populated best-effort so we can link over to the
  // Creative Planner for this asset.
  const [plannerUcid, setPlannerUcid] = useState<string | null>(null)

  // Lightweight inline toast. used when copying the UCID to the clipboard.
  const [toast, setToast] = useState<string | null>(null)

  // Analysis / Comments tab toggle on the right-hand panel. Starts on
  // Analysis since that's the behavior the UI has always had.
  const [viewMode, setViewMode] = useState<'analysis' | 'comments'>('analysis')

  // Detail panel prefers the full-resolution HD URL (resolved via Meta's
  // /adimages?hashes=[..] endpoint). Fall back to the stp-stripped image_url
  // and finally to the tiny thumbnail_url if nothing else is available.
  const thumb = toProxyImg(ad.image_url_hd || ad.image_url || ad.thumbnail_url) as string | undefined

  // Ads Manager deep link. Atria-style, scopes to the exact campaign /
  // adset / ad trio so the editor lands directly on the creative, not on
  // the account's full list. business_id is optional. if our payload
  // doesn't carry it, Meta still resolves via the account id.
  const adsManagerUrl = useMemo(() => {
    const raw = (ad as any).account_id as string | undefined
    const numeric = raw ? String(raw).replace(/^act_/i, '') : ''
    if (!numeric) return null
    const params = new URLSearchParams()
    params.set('act', numeric)
    if (ad.campaign_id) params.set('selected_campaign_ids', String(ad.campaign_id))
    if (ad.adset_id) params.set('selected_adset_ids', String(ad.adset_id))
    params.set('selected_ad_ids', String(ad.ad_id))
    const businessId = (ad as any).business_id as string | undefined
    if (businessId) params.set('business_id', businessId)
    params.set('nav_source', 'no_referrer')
    return `https://adsmanager.facebook.com/adsmanager/manage/ads?${params.toString()}`
  }, [ad])

  // Resolve planner UCID. prefer hash-based lookup (one creative = one UCID),
  // fall back to ad_id for entries without a hash.
  useEffect(() => {
    if (IN_REPORT) return  // planner UCID lookup needs the backend
    let cancelled = false
    const run = async () => {
      try {
        if (ad.creative_hash) {
          const r = await fetch(`/api/planner/ucid-for-hash/${encodeURIComponent(ad.creative_hash)}`)
          const d = await r.json()
          if (!cancelled && d?.ucid) { setPlannerUcid(String(d.ucid)); return }
        }
        const r2 = await fetch(`/api/planner/ucid-for-ad/${encodeURIComponent(ad.ad_id)}`)
        const d2 = await r2.json()
        if (!cancelled) setPlannerUcid(d2?.ucid ? String(d2.ucid) : null)
      } catch {
        if (!cancelled) setPlannerUcid(null)
      }
    }
    run()
    return () => { cancelled = true }
  }, [ad.ad_id, ad.creative_hash])

  // Clear any stale toast after 2.5s
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 2500)
    return () => window.clearTimeout(id)
  }, [toast])

  // Keyboard shortcuts for the open panel: ← / → (or J / K) walks the
  // selection through the filtered list, Esc closes. Skipped when the
  // event target is an editable field so the user can still type into
  // the Naming Convention inputs etc.
  useEffect(() => {
    const isEditable = (el: EventTarget | null) => {
      if (!el || !(el instanceof HTMLElement)) return false
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditable(e.target)) return
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'ArrowLeft' || e.key === 'j' || e.key === 'J') {
        if (onPrev) { e.preventDefault(); onPrev() }
      } else if (e.key === 'ArrowRight' || e.key === 'k' || e.key === 'K') {
        if (onNext) { e.preventDefault(); onNext() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onPrev, onNext])

  const copyUcidToClipboard = async () => {
    if (!plannerUcid) return
    try {
      await navigator.clipboard.writeText(plannerUcid)
      setToast(`UCID ${plannerUcid} copied. switch to Planner tab`)
    } catch {
      setToast('Could not copy UCID to clipboard')
    }
  }

  // Download menu. Atria-style "Copy thumbnail" / "Download creative".
  const [downloadOpen, setDownloadOpen] = useState(false)
  // Public preview modal. Facebook social-plugin iframe (no API key, no
  // /api/ads/preview round-trip). Renders the live ad post / video so it
  // works for catalog, video, and static placements alike.
  const [previewOpen, setPreviewOpen] = useState(false)
  const publicPreviewSrc = useMemo<string | null>(() => {
    if (ad.video_permalink) {
      return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(ad.video_permalink)}&show_text=false&width=560`
    }
    if (ad.effective_object_story_id && ad.effective_object_story_id.includes('_')) {
      const [pageId, postId] = ad.effective_object_story_id.split('_')
      const post = `https://www.facebook.com/${pageId}/posts/${postId}`
      return `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(post)}&show_text=true&width=560`
    }
    return null
  }, [ad.video_permalink, ad.effective_object_story_id])
  const copyThumbnailToClipboard = async () => {
    setDownloadOpen(false)
    if (!thumb) { setToast('No thumbnail available'); return }
    try {
      const resp = await fetch(thumb)
      const blob = await resp.blob()
      // Normalize to PNG for widest clipboard support.
      const pngBlob = blob.type === 'image/png'
        ? blob
        : await new Promise<Blob>((resolve, reject) => {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => {
              const c = document.createElement('canvas')
              c.width = img.naturalWidth; c.height = img.naturalHeight
              c.getContext('2d')?.drawImage(img, 0, 0)
              c.toBlob(b => b ? resolve(b) : reject('encode failed'), 'image/png')
            }
            img.onerror = () => reject('load failed')
            img.src = URL.createObjectURL(blob)
          })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
      setToast('Thumbnail copied to clipboard')
    } catch (e) {
      setToast('Copy failed. try Download creative instead')
    }
  }
  const downloadCreative = async () => {
    setDownloadOpen(false)
    // Prefer the raw video file; fall back to the full-res image.
    const sourceUrl = ad.video_source_url || ad.image_url_hd || ad.image_url || thumb
    if (!sourceUrl) { setToast('No creative available to download'); return }
    const isVideo = !!ad.video_source_url
    const ext = isVideo ? 'mp4' : 'jpg'
    const safeName = (ad.ad_name || ad.ad_id).replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 80)
    // Route through our same-origin proxy so cross-origin CORS / Meta
    // CDN headers don't block the fetch. The `<a download>` attribute
    // is unreliable on cross-origin direct URLs. browsers often
    // navigate to the URL instead of saving. Fetching to a Blob URL
    // forces a real save dialog.
    const proxyUrl = isVideo
      ? `/api/ads/video-bytes?u=${encodeURIComponent(sourceUrl)}`
      : `/api/ads/img?u=${encodeURIComponent(sourceUrl)}`
    try {
      setToast(`Preparing ${isVideo ? 'video' : 'image'}…`)
      const r = await fetch(proxyUrl, { credentials: 'include' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const blob = await r.blob()
      const objUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objUrl
      a.download = `${safeName}.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(objUrl), 1500)
      setToast(null)
    } catch (e: any) {
      setToast(`Download failed: ${e?.message || 'unknown error'}`)
    }
  }

  // (Daily-perf fetch removed alongside the chart it powered.)

  // Load previous-period totals for the same ad so we can show deltas.
  // Only fires when the user has explicitly enabled Compare in the
  // top-level date picker. no implicit "prior period" fallback, since
  // showing deltas the user didn't ask for is misleading.
  const effectiveCompare = useMemo(() => {
    if (compareStart && compareEnd) {
      return { prevStart: compareStart, prevEnd: compareEnd }
    }
    return null
  }, [compareStart, compareEnd])

  useEffect(() => {
    if (IN_REPORT) { setCompareTotals(null); return }
    const win = effectiveCompare
    if (!win) { setCompareTotals(null); return }
    let cancelled = false
    fetch(`/api/ads/creative/${encodeURIComponent(ad.ad_id)}?brand=${encodeURIComponent(brand)}&start=${win.prevStart}&end=${win.prevEnd}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        const rows = Array.isArray(d.daily) ? d.daily : []
        if (!rows.length) { setCompareTotals(null); return }
        // Sum raw counters then recompute derived fields via withCustomMetrics.
        const agg: Record<string, number> = {}
        const sumKeys = [
          'spend','impressions','clicks','link_clicks','outbound_clicks',
          'unique_outbound_clicks','reach',
          'purchases','revenue','add_to_cart','add_to_cart_value','initiate_checkout',
          'leads','landing_page_views',
          'thruplays','video_3s_views','video_views','video_15s_views',
          'video_p25','video_p50','video_p75','video_p100',
          'post_reactions','post_comments','post_shares','post_engagement',
          'post_saves','page_follows','see_more_clicks',
        ]
        for (const k of sumKeys) agg[k] = 0
        for (const r of rows) for (const k of sumKeys) agg[k] += Number(r[k] || 0)
        // Rebuild derived ratios (ROAS, CTR, CPM, hook_rate, …).
        agg.roas = agg.spend > 0 ? agg.revenue / agg.spend : 0
        agg.ctr = agg.impressions > 0 ? (agg.clicks / agg.impressions) * 100 : 0
        agg.cpm = agg.impressions > 0 ? (agg.spend / agg.impressions) * 1000 : 0
        agg.cpc = agg.clicks > 0 ? agg.spend / agg.clicks : 0
        agg.frequency = agg.reach > 0 ? agg.impressions / agg.reach : 0
        agg.cost_per_purchase = agg.purchases > 0 ? agg.spend / agg.purchases : 0
        const withDerived = withCustomMetrics(agg as any)
        setCompareTotals(withDerived as any)
      })
      .catch(() => { if (!cancelled) setCompareTotals(null) })
    return () => { cancelled = true }
  }, [ad.ad_id, brand, effectiveCompare])

  // Fetch (or run) analysis on open
  const runAnalysis = async (force = false) => {
    if (IN_REPORT) {
      // No backend. analysis comes from whatever was baked into the
      // snapshot. Surface a friendly note instead of "Failed to fetch".
      setAnalyzing(false)
      setAnalysisErr(null)
      return
    }
    setAnalyzing(true)
    setAnalysisErr(null)
    try {
      const r = await fetch(
        `/api/ads/analyze?ad_id=${encodeURIComponent(ad.ad_id)}&brand=${encodeURIComponent(brand)}&force=${force}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image_url: ad.image_url,
            thumbnail_url: ad.thumbnail_url,
            title: ad.title,
            body: ad.body,
            ad_name: ad.ad_name,
            is_video: ad.is_video,
            // Lets the backend reuse the post-thumb disk cache (keyed by
            // story_id) instead of re-fetching the expired Meta CDN URL.
            effective_object_story_id: ad.effective_object_story_id,
            // Fall back to ad_id when a creative hasn't surfaced a hash
            // yet (legacy data, missing asset_feed_spec, etc.). The
            // backend still key-caches by hash, so a real hash will
            // replace the placeholder on the next pass.
            creative_hash: ad.creative_hash || ad.ad_id,
          }),
        }
      )
      const d = await r.json()
      if (d.detail) { setAnalysisErr(String(d.detail)); setAnalysis(null) }
      else {
        const fresh = (d.analysis || null) as FileAnalysis | null
        setAnalysis(fresh)
        if (fresh) ANALYSIS_MEM_CACHE.set(analysisCacheKey(ad), fresh)
      }
    } catch (e: any) {
      setAnalysisErr(String(e))
    }
    setAnalyzing(false)
  }

  useEffect(() => {
    // Order of preference for showing analysis:
    //   1. In-memory session cache (zero network, no spinner)
    //   2. Parent-preloaded analysis (from /api/ads/dashboard bulk)
    //   3. Fall back to /api/ads/analyze (server-side cache hits ~150ms)
    const key = analysisCacheKey(ad)
    const memHit = ANALYSIS_MEM_CACHE.get(key)
    if (memHit) {
      setAnalysis(memHit)
      setAnalyzing(false)
      setAnalysisErr(null)
      return
    }
    if (preloadedAnalysis) {
      ANALYSIS_MEM_CACHE.set(key, preloadedAnalysis)
      setAnalysis(preloadedAnalysis)
      setAnalyzing(false)
      setAnalysisErr(null)
      return
    }
    runAnalysis(false)
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [ad.ad_id, ad.creative_hash, preloadedAnalysis])

  // Detect whether we got the new deep schema or the legacy flat shape
  const isDeep = !!(analysis && (analysis.concept || analysis.angle || analysis.template || analysis.compositionAnalysis))

  // Merged metric value source. the AdCreative row has all custom metrics
  // pre-computed (via withCustomMetrics in the parent), so we can lookup by
  // metric key directly.
  const getMetricValue = (key: string): number | undefined => {
    const v = (ad as any)[key]
    if (v === undefined || v === null || v === '') return undefined
    const n = Number(v)
    return Number.isNaN(n) ? undefined : n
  }
  const getCompareValue = (key: string): number | undefined => {
    if (!compareTotals) return undefined
    const v = compareTotals[key]
    if (v === undefined || v === null) return undefined
    return Number.isNaN(v) ? undefined : v
  }

  // Merged naming convention tokens (parsed + override). The user can edit
  // any token in-place; overrides are saved on blur.
  const parsedNc: Partial<NameConvention> = useMemo(() => {
    const ad_nc = ad.name_convention?.ad || {}
    const set_nc = ad.name_convention?.adset || {}
    return {
      objective: ad_nc.objective,
      format: ad_nc.format,
      type: ad_nc.type,
      persona_hint: ad_nc.persona_hint,
      concept: ad_nc.concept,
      flight: ad_nc.flight,
      launch_date: ad_nc.launch_date || ad_nc.date,
      funnel: set_nc.funnel || ad_nc.funnel,
      owner: set_nc.owner,
      bidding: set_nc.bidding,
      audience: set_nc.audience || ad_nc.audience,
      test_flag: set_nc.test_flag,
    }
  }, [ad.name_convention])
  const effectiveNc = { ...parsedNc, ...(ncOverride || {}) }

  return createPortal(
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center overflow-y-auto"
      style={{ zIndex: 100000 }}
      onClick={onClose}>
      <div className="mt-16 mb-8 w-[92%] max-w-[1180px] bg-white rounded-2xl shadow-2xl border border-black/[0.08]"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 p-4 border-b border-black/[0.06] sticky top-0 bg-white rounded-t-2xl z-10">
          <div className="flex-1 min-w-0">
            <div className="font-display text-base font-medium truncate">{ad.ad_name || 'Ad detail'}</div>
            <div className="text-[10px] text-text-muted truncate">
              {ad.campaign_name} · {ad.adset_name}
            </div>
          </div>
          {/* Ads Manager deep link. small, grayed, opens in new tab. */}
          {/* Creative Planner link. only shown when a UCID is linked to this
              creative. Clicking copies the UCID to the clipboard so the user
              can paste it in the Planner tab. */}
          {plannerUcid && (
            <button
              onClick={copyUcidToClipboard}
              className="bg-black/[0.04] text-text-muted hover:text-text-primary px-2 py-1 rounded text-[10px] flex items-center gap-1"
              title={`Copy UCID ${plannerUcid} and switch to Planner tab`}
            >
              <ExternalLink size={10} />
              View in Planner
            </button>
          )}
          <button onClick={() => runAnalysis(true)} disabled={analyzing}
            className="px-2.5 py-1 rounded-full text-[11px] glass glass-hover flex items-center gap-1 disabled:opacity-50">
            {analyzing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            Re-analyze
          </button>
          {ad.is_video && (ad as any).video_source_url && (
            <button
              onClick={runTranscribe}
              disabled={transcribing}
              className="px-2.5 py-1 rounded-full text-[11px] glass glass-hover flex items-center gap-1 disabled:opacity-50"
              title={transcript ? "Toggle transcript panel" : "Transcribe audio locally in your browser"}
            >
              {transcribing ? <Loader2 size={11} className="animate-spin" /> : <MessageSquare size={11} />}
              {transcribing ? "Transcribing…" : transcript ? "Transcript" : "Transcribe"}
            </button>
          )}
          {/* Save-to-board removed from our own (Meta-native) ads in
              v0.2. boards are for tracking competitor / inspo ads via
              Atria search, not our own. The SaveToBoardButton still
              renders inside AtriaExploreView for that flow. */}
          {(onPrev || onNext || position) && (
            <div className="flex items-center gap-1 ml-1 text-text-muted">
              {onPrev && (
                <button
                  onClick={onPrev}
                  className="p-1.5 rounded hover:bg-black/[0.04] hover:text-text-primary"
                  title="Previous ad (←)"
                  aria-label="Previous ad"
                >
                  <ChevronLeft size={14} />
                </button>
              )}
              {position && (
                <div className="text-[10px] tabular-nums px-1 select-none" title="Position in current filtered view">
                  {position.current} of {position.total}
                </div>
              )}
              {onNext && (
                <button
                  onClick={onNext}
                  className="p-1.5 rounded hover:bg-black/[0.04] hover:text-text-primary"
                  title="Next ad (→)"
                  aria-label="Next ad"
                >
                  <ChevronRight size={14} />
                </button>
              )}
            </div>
          )}
          <button onClick={onClose} className="p-1.5 rounded hover:bg-black/[0.04]" title="Close (Esc)"><X size={14} /></button>
        </div>

        {/* Inline toast for UCID copy / error. Bottom-right, auto-dismiss. */}
        {toast && (
          <div
            className="fixed bottom-6 right-6 bg-text-primary text-white text-[11px] px-3 py-2 rounded-lg shadow-lg"
            style={{ zIndex: 100001 }}
          >
            {toast}
          </div>
        )}

        <div className="grid md:grid-cols-[440px_1fr] gap-0">
          {/* Left: preview + grouped metrics (Motion layout) */}
          <div className="p-4 border-r border-black/[0.06] flex flex-col gap-4">
            <CreativePreview
              thumb={thumb}
              alt={ad.ad_name || ad.ad_id}
              is_video={!!ad.is_video}
              title={ad.title || ''}
              body={ad.body || ''}
              video_source_url={ad.video_source_url || null}
              video_permalink={ad.video_permalink || null}
              effective_object_story_id={ad.effective_object_story_id || null}
              ad_id={ad.ad_id}
              adsManagerUrl={adsManagerUrl}
              subjectBbox={analysis?.compositionAnalysis?.subjectBoundingBox}
              onCopyThumbnail={copyThumbnailToClipboard}
              onDownloadCreative={downloadCreative}
              downloadOpen={downloadOpen}
              setDownloadOpen={setDownloadOpen}
            />

            {/* Transcript panel. only visible after the user clicks
                Transcribe in the header. Open/loading/result/error are
                folded into one block so the panel area stays compact. */}
            {ad.is_video && transcribeOpen && (
              <div className="border border-black/[0.08] rounded-lg p-2.5 bg-white/60 flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] uppercase tracking-widest text-text-muted">Transcript</div>
                  <div className="flex items-center gap-1">
                    {transcript && (
                      <button
                        onClick={() => { navigator.clipboard?.writeText(transcript).catch(() => {}); }}
                        className="text-[10px] text-text-muted hover:text-text-primary inline-flex items-center gap-1"
                        title="Copy transcript"
                      >
                        <Copy size={10} /> Copy
                      </button>
                    )}
                    <button
                      onClick={() => setTranscribeOpen(false)}
                      className="text-[10px] text-text-muted hover:text-text-primary px-1"
                      title="Hide"
                    >
                      ×
                    </button>
                  </div>
                </div>
                {transcribing && (
                  <div className="text-[11px] text-text-muted inline-flex items-center gap-1.5">
                    <Loader2 size={10} className="animate-spin" />
                    Transcribing locally in your browser…
                  </div>
                )}
                {transcribeErr && (
                  <div className="text-[11px] text-red-600">{transcribeErr}</div>
                )}
                {transcript && !transcribing && (
                  <div className="text-[12px] leading-relaxed text-text-primary whitespace-pre-wrap max-h-48 overflow-y-auto">
                    {transcript}
                  </div>
                )}
              </div>
            )}

            {/* Metrics (Motion-style grouped panel). Compare deltas render
                next to each value when previous-period data is available. */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-widest text-text-muted font-medium">
                  Metrics
                </div>
                {compareTotals && effectiveCompare && (
                  <div className="text-[9px] text-text-muted">
                    {compareLabel(start, end, effectiveCompare.prevStart, effectiveCompare.prevEnd)}
                  </div>
                )}
              </div>
              {DETAIL_GROUPS
                // Drop the Media group on non-video ads. all the
                // video_* metrics are 0 for static images and the empty
                // tiles are noise. Video-specific metric groups should
                // only render when the ad is actually a video.
                .filter(group => group.name !== 'Media' || !!ad.is_video)
                .map(group => (
                  <MetricGroupBlock
                    key={group.name}
                    name={group.name}
                    metrics={group.metrics}
                    getValue={getMetricValue}
                    getCompare={getCompareValue}
                    hasCompare={!!compareTotals}
                  />
                ))}
            </div>

            {/* Daily spend & ROAS, demographic breakdown, placement
                breakdown, and video retention charts were removed -
                Meta's per-ad attribution coverage is too sparse for them
                to render anything useful most of the time. The empty-
                state messaging that occupied the panel ("Meta hasn't
                published…") was noisier than the absence of the section.
                Component definitions (DemoBreakdownCharts,
                PlacementBreakdownChart, VideoRetentionChart) are kept in
                this file for a future re-introduction once we have a
                richer attribution source. */}
          </div>

          {/* Right: Analysis / Comments tab */}
          <div className="p-4 flex flex-col gap-4 text-xs min-w-0">

            {/* Segmented slider. light gray pill container with two options.
                Matches Atelier's subtle-toggle design language. */}
            <div
              className="inline-flex items-center p-0.5 rounded-full self-start"
              style={{ background: 'rgba(0,0,0,0.05)', width: 180 }}
              role="tablist"
              aria-label="Detail view mode"
            >
              <SegmentButton
                active={viewMode === 'analysis'}
                onClick={() => setViewMode('analysis')}
                icon={<Sparkles size={10} />}
                label="Analysis"
              />
              <SegmentButton
                active={viewMode === 'comments'}
                onClick={() => setViewMode('comments')}
                icon={<MessageSquare size={10} />}
                label="Comments"
              />
            </div>

            {viewMode === 'analysis' ? (
              <>
                <section>
                  <div className="flex items-center gap-1.5 mb-3">
                    <Sparkles size={12} style={{ color: '#B7410E' }} />
                    <div className="text-[11px] font-medium">AI Analysis</div>
                  </div>
                  {analyzing && !analysis ? (
                    <div className="flex items-center gap-2 text-text-muted py-4">
                      <Loader2 size={14} className="animate-spin" />
                      <span>Analyzing creative with Haiku…</span>
                    </div>
                  ) : analysisErr ? (
                    <div className="text-red-600 text-[11px]">{analysisErr}</div>
                  ) : analysis?.error ? (
                    <div className="text-red-600 text-[11px]">{analysis.error}</div>
                  ) : analysis && isDeep ? (
                    <DeepAnalysisView analysis={analysis} />
                  ) : analysis ? (
                    <LegacyAnalysisView analysis={analysis} />
                  ) : (
                    <div className="text-text-muted text-[11px]">No analysis yet.</div>
                  )}
                </section>

                {/* Naming Convention. editable */}
                <section className="border-t border-black/[0.06] pt-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Tag size={12} style={{ color: '#B7410E' }} />
                    <div className="text-[11px] font-medium">Naming Convention</div>
                    <div className="text-[10px] text-text-muted">· parsed from ad + adset name</div>
                  </div>
                  <NamingConvention
                    tokens={effectiveNc}
                    onChange={(patch) => setNcOverride(prev => ({ ...(prev || {}), ...patch }))}
                  />
                  {ad.name_convention?.adset?.raw && (
                    <div className="text-[9.5px] text-text-muted mt-2 italic">
                      Adset: {ad.name_convention.adset.raw}
                    </div>
                  )}
                </section>
              </>
            ) : (
              <section>
                <div className="flex items-center gap-1.5 mb-3">
                  <MessageSquare size={12} style={{ color: '#B7410E' }} />
                  <div className="text-[11px] font-medium">Comments</div>
                  <div className="text-[10px] text-text-muted">· FB + IG on the ad's post</div>
                </div>
                <CommentsView adId={ad.ad_id} brand={brand} />
              </section>
            )}
          </div>
        </div>

        {previewOpen && (
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-8"
            style={{ zIndex: 100002 }}
            onClick={() => setPreviewOpen(false)}
          >
            <div
              className="bg-white rounded-2xl shadow-2xl flex flex-col"
              style={{ width: 600 }}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 p-3 border-b border-black/[0.06]">
                <Eye size={14} />
                <div className="text-[13px] font-medium">Live preview</div>
                <div className="text-[10px] text-text-muted">· Public Facebook embed</div>
                <div className="flex-1" />
                <button
                  onClick={() => setPreviewOpen(false)}
                  className="p-1.5 rounded hover:bg-black/[0.04]"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="flex items-center justify-center bg-black/[0.02]" style={{ height: 720 }}>
                {publicPreviewSrc ? (
                  <iframe
                    title="Public ad preview"
                    src={publicPreviewSrc}
                    width={560}
                    height={720}
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                    scrolling="no"
                    style={{ border: 0, display: 'block', overflow: 'hidden' }}
                    className="bg-white"
                  />
                ) : (
                  <div className="text-[12px] text-text-muted max-w-[400px] text-center px-4">
                    No public link available for this ad. The ad's post may be unpublished or restricted.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

// ---------------------------------------------------------------------------
// Segmented slider button. one half of the Analysis / Comments toggle.
// Active side gets a white pill + shadow; inactive side stays transparent
// inside the light-gray container.
// ---------------------------------------------------------------------------

function SegmentButton({
  active, onClick, icon, label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1 text-[10.5px] font-medium rounded-full py-1 transition ${
        active
          ? 'bg-white text-text-primary shadow-sm'
          : 'text-text-muted hover:text-text-secondary'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Metric group block. one section of the Motion-style metrics panel
// ---------------------------------------------------------------------------

function MetricGroupBlock({
  name, metrics, getValue, getCompare, hasCompare,
}: {
  name: string
  metrics: DetailMetric[]
  getValue: (key: string) => number | undefined
  getCompare: (key: string) => number | undefined
  hasCompare: boolean
}) {
  // Hide the group if every metric is missing (e.g. static image ads have
  // no video metrics). Keeps the panel clean per-ad.
  const visible = metrics.filter(m => getValue(m.key) !== undefined)
  if (!visible.length) return null
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest text-text-muted mb-1.5">{name}</div>
      <div className="grid grid-cols-2 gap-1.5">
        {visible.map(m => (
          <MetricChip
            key={m.key}
            label={m.label}
            value={getValue(m.key)}
            prev={hasCompare ? getCompare(m.key) : undefined}
            format={m.format}
            lowerIsBetter={LOWER_IS_BETTER.has(m.key)}
          />
        ))}
      </div>
    </div>
  )
}

function MetricChip({
  label, value, prev, format, lowerIsBetter,
}: {
  label: string
  value: number | undefined
  prev: number | undefined
  format: DetailFormat
  lowerIsBetter: boolean
}) {
  const str = formatDetailValue(value, format)
  const hasDelta = prev !== undefined && value !== undefined && prev !== 0
  const deltaPct = hasDelta ? ((value as number) - (prev as number)) / Math.abs(prev as number) * 100 : 0
  const up = deltaPct > 0
  // Semantic color: "up" on lower-is-better metrics (CPM, CPC, CPA) is bad.
  const good = lowerIsBetter ? !up : up
  const deltaColor = deltaPct === 0 ? 'text-text-muted' : good ? 'text-emerald-600' : 'text-red-500'

  return (
    <div className="rounded-lg bg-black/[0.03] px-2 py-1.5 flex flex-col">
      <div className="text-[9px] uppercase tracking-wider text-text-muted truncate">{label}</div>
      {/* Sans-serif numerics per user feedback. reserve font-display for
          the AI Analysis section headers and score numbers. */}
      <div className="text-[13px] tabular-nums text-text-primary leading-tight font-medium">{str}</div>
      {hasDelta && Number.isFinite(deltaPct) && (
        <div className={`text-[9px] tabular-nums flex items-center gap-0.5 ${deltaColor}`}>
          {deltaPct !== 0 && (up ? <ArrowUp size={7} /> : <ArrowDown size={7} />)}
          {Math.abs(deltaPct) < 0.05 ? '0%' : `${Math.abs(deltaPct).toFixed(0)}%`}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Creative preview with composition bbox overlay
// ---------------------------------------------------------------------------

function CreativePreview({
  thumb, alt, is_video, title, body, video_source_url, video_permalink, effective_object_story_id, ad_id, adsManagerUrl,
  subjectBbox,
  onCopyThumbnail, onDownloadCreative, downloadOpen, setDownloadOpen,
}: {
  thumb?: string | null
  alt: string
  is_video: boolean
  title?: string
  body?: string
  adsManagerUrl?: string | null
  // Normalized 0..1 rect from compositionAnalysis. When present and the
  // static-image preview path is the one actually rendering, a small
  // toggle in the preview corner overlays the box on the thumbnail.
  // The Meta iframe / public-embed paths can't be overlaid because the
  // iframe is cross-origin.
  subjectBbox?: { x: number; y: number; width: number; height: number }
  onCopyThumbnail?: () => void
  onDownloadCreative?: () => void
  downloadOpen?: boolean
  setDownloadOpen?: (v: boolean) => void
  video_source_url?: string | null
  video_permalink?: string | null
  effective_object_story_id?: string | null
  ad_id: string
}) {
  const [showBbox, setShowBbox] = useState(false)
  // DPA / Advantage+ catalog ads render a carousel of product cards with
  // no body text or reactions. their iframe content is much shorter than
  // a static post. Detect via `{{product.*}}` template tokens in title/body.
  const isCatalog = /\{\{\s*product\./i.test((title || '') + ' ' + (body || ''))
  const imgRef = useRef<HTMLImageElement>(null)

  // Preview strategy:
  //   1) Meta `/api/ads/preview`. authenticated, hydrates DPA templates
  //      and renders the actual paid creative. This is what Ads Manager
  //      uses; the public `plugins/post.php` embed cannot match it
  //      because Meta serves template tokens / page avatars publicly.
  //   2) Public FB iframe (post / video plugin). only when the API
  //      call errors out (rate limited, scope missing, ad expired).
  //   3) Static thumbnail.
  // Container fills the parent column via ResizeObserver so the preview
  // grows with the panel instead of being fixed at 340×600.
  const hostRef = useRef<HTMLDivElement>(null)
  const [hostSize, setHostSize] = useState<{ w: number; h: number }>({ w: 360, h: 640 })
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const cr = entry.contentRect
        if (cr.width > 0 && cr.height > 0) {
          setHostSize({ w: Math.round(cr.width), h: Math.round(cr.height) })
        }
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const [metaHtml, setMetaHtml] = useState<string | null>(null)
  const [metaLoading, setMetaLoading] = useState(false)
  const [metaFailed, setMetaFailed] = useState(false)
  const PREVIEW_FORMAT = 'MOBILE_FEED_STANDARD'
  // Meta's preview HTML embeds an inner iframe at fixed width=335 height=450
  // with scrolling=yes. that's where the scrollbar comes from and why the
  // ad gets cropped. Rewrite the attributes before rendering so the inner
  // iframe is tall enough to show the whole ad without scrolling.
  const INNER_W = 400
  // Height profiles by ad type:
  //   - Catalog/DPA: carousel cards + footer, no text/reactions → 640
  //   - Video: 1:1 player + minimal footer → 700
  //   - Link-style static (short body, no above-image copy): media +
  //     headline card + footer → 720
  //   - Long-form static post (multi-line body, reactions/comments inline):
  //     needs the full 820 to avoid clipping the comments line.
  const bodyLen = (body || '').length
  const isLongStatic = bodyLen > 160 || (body || '').split('\n').length > 2
  const INNER_H = isCatalog ? 640 : is_video ? 700 : (isLongStatic ? 820 : 720)
  const upsizeInnerIframe = (html: string): string => {
    return html
      .replace(/width=["']335["']/g, `width="${INNER_W}"`)
      .replace(/height=["']450["']/g, `height="${INNER_H}"`)
      .replace(/scrolling=["']yes["']/g, 'scrolling="no"')
  }
  useEffect(() => {
    if (IN_REPORT || !ad_id) return
    let cancelled = false
    setMetaLoading(true); setMetaFailed(false); setMetaHtml(null)
    fetch(`/api/ads/preview?ad_id=${encodeURIComponent(ad_id)}&ad_format=${PREVIEW_FORMAT}`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(d => { if (!cancelled) setMetaHtml(d?.body ? upsizeInnerIframe(d.body) : null) })
      .catch(() => { if (!cancelled) setMetaFailed(true) })
      .finally(() => { if (!cancelled) setMetaLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ad_id])

  const publicFallback = useMemo(() => {
    if (effective_object_story_id && effective_object_story_id.includes('_')) {
      const [pageId, postId] = effective_object_story_id.split('_')
      const post = `https://www.facebook.com/${pageId}/posts/${postId}`
      const href = encodeURIComponent(post)
      return {
        kind: 'iframe' as const,
        src: `https://www.facebook.com/plugins/post.php?href=${href}&show_text=true&width=${hostSize.w}`,
      }
    }
    if (video_permalink) {
      const href = encodeURIComponent(video_permalink)
      return {
        kind: 'iframe' as const,
        src: `https://www.facebook.com/plugins/video.php?href=${href}&show_text=true&width=${hostSize.w}`,
      }
    }
    if (video_source_url) return { kind: 'video' as const, src: video_source_url }
    return null
  }, [video_source_url, video_permalink, effective_object_story_id, hostSize.w])

  // Meta's preview HTML embeds an inner iframe at fixed 335×450 (Mobile
  // Feed natural size). Sizing the outer iframe to match. no overscan,
  // no scrollbars to clip, and no empty space pushing the metrics below
  // the fold.
  const PREVIEW_W = 400
  const PREVIEW_H = isCatalog ? 640 : is_video ? 700 : (isLongStatic ? 820 : 720)
  const containerClasses = 'relative rounded-xl overflow-hidden bg-black/[0.04] flex items-center justify-center mx-auto'

  return (
    <div ref={hostRef} className={containerClasses} style={{ width: PREVIEW_W, height: PREVIEW_H }}>
      {metaHtml ? (
        <iframe
          srcDoc={metaHtml}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          className="bg-white"
          width={PREVIEW_W}
          height={PREVIEW_H}
          style={{ border: 0, display: 'block' }}
          scrolling="no"
          title="Meta ad preview"
        />
      ) : metaLoading ? (
        <div className="flex flex-col items-center justify-center gap-2 text-text-muted">
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[10px]">Loading Meta preview…</div>
        </div>
      ) : metaFailed && publicFallback?.kind === 'video' ? (
        <video
          src={publicFallback.src}
          controls
          playsInline
          className="w-full h-full object-contain bg-black"
          style={{ display: 'block' }}
        />
      ) : metaFailed && publicFallback?.kind === 'iframe' ? (
        <iframe
          src={publicFallback.src}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          className="bg-white"
          width={PREVIEW_W}
          height={PREVIEW_H}
          style={{ border: 0, display: 'block' }}
          scrolling="no"
          title="Public ad preview"
        />
      ) : thumb ? (
        <div className="relative max-w-full max-h-full flex items-center justify-center">
          <img
            ref={imgRef}
            src={thumb}
            alt={alt}
            className="max-w-full max-h-full object-contain"
          />
          {showBbox && subjectBbox && (
            <div
              className="absolute pointer-events-none border-2 border-[#B7410E] rounded-sm"
              style={{
                left: `${subjectBbox.x * 100}%`,
                top: `${subjectBbox.y * 100}%`,
                width: `${subjectBbox.width * 100}%`,
                height: `${subjectBbox.height * 100}%`,
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.18)',
              }}
              aria-label="Subject bounding box"
            />
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 text-xs text-text-muted px-4 text-center">
          No preview available
        </div>
      )}

      {adsManagerUrl && (
        <a
          href={adsManagerUrl}
          target="_blank"
          rel="noreferrer"
          className="absolute bottom-2 right-2 glass rounded-full px-2 py-1 flex items-center gap-1 text-[10px] text-text-secondary hover:text-text-primary"
          title="Open this ad in Meta Ads Manager"
        >
          <ExternalLink size={9} /> Ads Manager
        </a>
      )}

      {/* Subject-bbox toggle. Only shown when the analyzer reported a
          bbox AND the preview path is the static image (we can't overlay
          on the Meta iframe or the public-embed iframe). */}
      {subjectBbox && !metaHtml && !metaLoading && thumb && (
        <button
          type="button"
          onClick={() => setShowBbox(s => !s)}
          className={`absolute bottom-2 left-2 glass rounded-full px-2 py-1 flex items-center gap-1 text-[10px] transition-colors ${
            showBbox ? 'text-[#B7410E]' : 'text-text-secondary hover:text-text-primary'
          }`}
          title="Toggle the AI-detected subject bounding box"
        >
          <Eye size={9} /> Subject
        </button>
      )}

      {/* Download dropdown pill. Atria-style top-right overlay. */}
      {(onCopyThumbnail || onDownloadCreative) && (
        <div className="absolute top-2 left-2">
          <button
            onClick={() => setDownloadOpen?.(!downloadOpen)}
            className="glass rounded-full px-2.5 py-1 flex items-center gap-1 text-[11px] text-text-primary hover:bg-white/80"
            title="Copy or download this creative"
          >
            <Download size={11} />
            Download
            <span className="text-[9px] opacity-70">▾</span>
          </button>
          {downloadOpen && (
            <>
              <div className="fixed inset-0 z-[60]" onClick={() => setDownloadOpen?.(false)} />
              <div className="absolute left-0 top-full mt-1 z-[61] bg-white rounded-lg shadow-xl border border-black/[0.06] py-1 w-[180px]">
                {onCopyThumbnail && (
                  <button
                    onClick={onCopyThumbnail}
                    className="w-full text-left px-3 py-2 text-[12px] hover:bg-black/[0.04] flex items-center gap-2"
                  >
                    <Copy size={12} /> Copy thumbnail
                  </button>
                )}
                {onDownloadCreative && (
                  <button
                    onClick={onDownloadCreative}
                    className="w-full text-left px-3 py-2 text-[12px] hover:bg-black/[0.04] flex items-center gap-2"
                  >
                    <Download size={12} /> Download creative
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Naming convention editor
// ---------------------------------------------------------------------------

const NC_FIELDS: { key: keyof NameConvention; label: string }[] = [
  { key: 'objective', label: 'Objective' },
  { key: 'format', label: 'Format' },
  { key: 'type', label: 'Type' },
  { key: 'funnel', label: 'Funnel' },
  { key: 'persona_hint', label: 'Persona' },
  { key: 'concept', label: 'Concept' },
  { key: 'launch_date', label: 'Launch' },
  { key: 'owner', label: 'Owner' },
  { key: 'bidding', label: 'Bidding' },
  { key: 'audience', label: 'Audience' },
  { key: 'flight', label: 'Flight' },
]

function NamingConvention({
  tokens, onChange,
}: {
  tokens: Partial<NameConvention>
  onChange: (patch: Partial<NameConvention>) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const filled = NC_FIELDS.filter(f => {
    const v = tokens[f.key]
    return v !== undefined && v !== null && v !== '' && v !== false
  })
  if (!filled.length) {
    return (
      <div className="text-[11px] text-text-muted italic">
        No naming tokens extracted. Add a naming convention on the brand profile to enable parsing.
      </div>
    )
  }
  // Collapsed: single-line summary. Repeats info already shown above in
  // Strategy / MetaItem strip, so we keep it as a one-liner unless the
  // user clicks to edit. Expanded: original grid with editable inputs.
  if (!expanded) {
    const summary = filled
      .map(f => {
        const v = tokens[f.key]
        return typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v ?? '')
      })
      .filter(Boolean)
      .join(' · ')
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full text-left text-[11px] text-text-secondary leading-snug hover:text-text-primary transition-colors"
        title="Click to edit the parsed naming-convention tokens"
      >
        {summary}
        <span className="text-text-muted ml-1.5">· edit</span>
      </button>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        {filled.map(f => {
          const v = tokens[f.key]
          const strVal = typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v ?? '')
          return (
            <div key={f.key as string} className="rounded-lg bg-black/[0.03] px-2 py-1">
              <div className="text-[9px] uppercase tracking-wider text-text-muted">{f.label}</div>
              <input
                type="text"
                defaultValue={strVal}
                onBlur={(e) => {
                  const newVal = e.target.value.trim()
                  if (newVal !== strVal) onChange({ [f.key]: newVal } as Partial<NameConvention>)
                }}
                className="w-full bg-transparent text-[11px] text-text-primary outline-none focus:text-[#B7410E]"
              />
            </div>
          )
        })}
      </div>
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="self-start text-[10px] text-text-muted hover:text-text-primary"
      >
        Collapse
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Deep analysis display. Performance & Differentiation surfaces at top
// ---------------------------------------------------------------------------

function DeepAnalysisView({ analysis }: { analysis: FileAnalysis }) {
  const a = analysis
  return (
    <div className="flex flex-col gap-6">
      {/* Scores. hero section. Big 9/10 numerals with captions. */}
      {(a.creativeClarityScore != null || a.visualDifferentiationScore != null || a.messagingDifferentiationScore != null) && (
        <Section title="Performance & Differentiation">
          <div className="flex flex-col gap-3">
            {a.creativeClarityScore != null && (
              <ScoreRow
                label="Creative Clarity Score"
                score={a.creativeClarityScore}
                feedback={a.creativeClarityFeedback}
              />
            )}
            {a.visualDifferentiationScore != null && (
              <ScoreRow
                label="Visual Differentiation Score"
                score={a.visualDifferentiationScore}
                feedback={a.visualDifferentiationSummary}
              />
            )}
            {a.messagingDifferentiationScore != null && (
              <ScoreRow
                label="Messaging Differentiation Score"
                score={a.messagingDifferentiationScore}
                feedback={a.messagingDifferentiationSummary}
              />
            )}
          </div>
        </Section>
      )}

      {/* Classification metadata. all enums in one quiet strip. Used to
          be colored Pills per-category which screamed louder than the
          actual copy below; now matches the muted LABEL/value rhythm
          used everywhere else on the panel. */}
      {(a.template || a.funnelPosition || a.marketAwareness || a.sentiment || a.productionQuality || a.intendedPlacement || a.format || a.aspectRatio) && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
          {a.template && <MetaItem label="Template" value={a.template} />}
          {a.funnelPosition && <MetaItem label="Funnel" value={a.funnelPosition} />}
          {a.marketAwareness && <MetaItem label="Awareness" value={a.marketAwareness} />}
          {a.sentiment && <MetaItem label="Sentiment" value={a.sentiment} />}
          {a.productionQuality && <MetaItem label="Production" value={a.productionQuality} />}
          {a.intendedPlacement && <MetaItem label="Placement" value={a.intendedPlacement} />}
          {a.format && <MetaItem label="Format" value={a.format} />}
          {a.aspectRatio && <MetaItem label="Ratio" value={a.aspectRatio} />}
        </div>
      )}

      {/* Strategy. consolidated audience + funnel + concept work into one
          block since they all answer "who & why & how". Drops the standalone
          Funnel & Offer / Audience & Market headers. */}
      {(a.concept || a.angle || a.hook || a.persona || a.demographics || a.marketSophistication || a.offer) && (
        <Section title="Strategy">
          {a.concept && <Field label="Concept" value={a.concept} />}
          {a.angle && <Field label="Angle" value={a.angle} />}
          {a.hook && <Field label="Hook" value={a.hook} />}
          {a.persona && <Field label="Persona" value={a.persona} />}
          {a.demographics && <Field label="Demographics" value={a.demographics} />}
          {a.marketSophistication && <Field label="Sophistication" value={a.marketSophistication} />}
          {a.offer && <Field label="Offer" value={a.offer} />}
        </Section>
      )}

      {/* Copy. headline + body + CTA + on-image text. Sentiment removed
          from this section (already shown as a Pill above). */}
      {(a.headline || a.bodyCopy || a.cta || a.textOverlay) && (
        <Section title="Copy">
          {a.headline && <Field label="Headline" value={a.headline} />}
          {a.bodyCopy && <Field label="Body" value={a.bodyCopy} />}
          {a.cta && <Field label="CTA" value={a.cta} />}
          {a.textOverlay && a.textOverlay.toLowerCase() !== 'none' && (
            <Field label="Text overlay" value={a.textOverlay} />
          )}
        </Section>
      )}

      {/* Visual & Composition. merged the prior "Visual Analysis" and
          "Compositional Analysis" headers. Style/Layout/Emotion/Colors/
          Products live alongside the composition prose + bbox + text
          placements so the user sees the full visual picture in one
          scroll. Removed Template/Production from here (in pills row). */}
      {(a.style || a.layoutDescription || a.emotion || (a.colors?.length) || (a.products?.length) || a.compositionAnalysis) && (
        <Section title="Visual & Composition">
          {a.style && <Field label="Style" value={a.style} />}
          {a.layoutDescription && <Field label="Layout" value={a.layoutDescription} />}
          {a.emotion && <Field label="Emotion" value={a.emotion} />}
          {a.compositionAnalysis?.overallComposition && (
            <Field label="Composition" value={a.compositionAnalysis.overallComposition} />
          )}
          {a.compositionAnalysis?.negativeSpaceDescription && (
            <Field label="Negative space" value={a.compositionAnalysis.negativeSpaceDescription} />
          )}
          {a.colors && a.colors.length > 0 && <ColorSwatches colors={a.colors} />}
          {a.products && a.products.length > 0 && <TagField label="Products" items={a.products} />}
          {a.compositionAnalysis?.textPlacements && a.compositionAnalysis.textPlacements.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1.5 font-medium">Text placements</div>
              <div className="flex flex-col gap-2">
                {a.compositionAnalysis.textPlacements.map((tp, i) => (
                  <div key={i} className="rounded-xl bg-white border border-black/[0.06] px-3 py-2.5">
                    <div className="text-[13px] text-text-primary font-display leading-snug mb-1.5">
                      "{tp.text}"
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {tp.type && <MiniChip label="Type" value={tp.type} />}
                      {tp.placementDescription && <MiniChip label="Placement" value={tp.placementDescription} />}
                      {tp.scaleDescription && <MiniChip label="Scale" value={tp.scaleDescription} />}
                      {tp.fontStyleDescription && <MiniChip label="Font" value={tp.fontStyleDescription} />}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {/* Tags & Context. category, collection, moment, and free-form
          tags. Last section because it's the least-actionable info on
          a glance. Free-form tags are de-duped against every other
          field already shown above (Style, Format, Template, Products,
          Category, Collection, …). the model often re-emits "UGC" /
          "video" / the product name as tags, and seeing them five
          times across one panel was the noisiest part of the page. */}
      {(() => {
        const dedupedTags = uniqueTags(a)
        const showSection = !!(a.category || a.collection || a.marketingMoment || dedupedTags.length)
        if (!showSection) return null
        return (
          <Section title="Tags & Context">
            {a.category && <Field label="Category" value={a.category} />}
            {a.collection && <Field label="Collection" value={a.collection} />}
            {a.marketingMoment && <Field label="Moment" value={a.marketingMoment} />}
            {dedupedTags.length > 0 && <TagField label="Tags" items={dedupedTags} />}
          </Section>
        )
      })()}
    </div>
  )
}

// Drop free-form tags that are already covered by other structured
// fields elsewhere on the panel. Matching is case-insensitive and
// normalizes punctuation/spaces so "ugc", "UGC", "U.G.C." all collapse.
function uniqueTags(a: FileAnalysis): string[] {
  if (!a.tags || a.tags.length === 0) return []
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const seen = new Set<string>()
  const stamp = (v?: string | null) => { if (v) seen.add(norm(v)) }
  // Single-value fields shown elsewhere on the page
  stamp(a.template); stamp(a.funnelPosition); stamp(a.marketAwareness)
  stamp(a.sentiment); stamp(a.productionQuality); stamp(a.intendedPlacement)
  stamp(a.format); stamp(a.aspectRatio); stamp(a.style); stamp(a.emotion)
  stamp(a.category); stamp(a.collection); stamp(a.marketingMoment)
  ;(a.products || []).forEach(p => stamp(p))
  return a.tags.filter(t => {
    const n = norm(t)
    if (!n || seen.has(n)) return false
    seen.add(n)
    return true
  })
}

// Legacy fallback for old-shape cached entries still floating around
function LegacyAnalysisView({ analysis }: { analysis: FileAnalysis }) {
  return (
    <div className="flex flex-col gap-2.5">
      {analysis.composition && <Field label="Composition" value={analysis.composition} />}
      {analysis.visual_elements?.length ? <TagField label="Visual elements" items={analysis.visual_elements} /> : null}
      {analysis.colors?.length ? <ColorSwatches colors={analysis.colors} /> : null}
      {analysis.people && <Field label="People" value={analysis.people} />}
      {analysis.product_shown && <Field label="Product" value={analysis.product_shown} />}
      {analysis.copy_on_image && analysis.copy_on_image.toLowerCase() !== 'none' && (
        <Field label="Copy on image" value={analysis.copy_on_image} />
      )}
      {analysis.tone_mood && <Field label="Tone / mood" value={analysis.tone_mood} />}
      {analysis.likely_persona && <Field label="Likely persona" value={analysis.likely_persona} />}
      {analysis.strengths?.length ? <ListField label="Strengths" items={analysis.strengths} tone="good" /> : null}
      {analysis.improvements?.length ? <ListField label="Suggestions" items={analysis.improvements} tone="orange" /> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Smaller UI pieces
// ---------------------------------------------------------------------------

// Type system for the analysis panel. three sizes, period.
//   eyebrow:    10px uppercase, used for ALL labels and section titles
//   body:       12.5px, used for ALL non-emphasized values (consistent
//               across Field, ScoreRow feedback, ListField, etc.)
//   emphasized: 14px display, used for hero values (hook, headline)

function ScoreRow({ label, score, feedback }: { label: string; score: number; feedback?: string }) {
  // Scores are 0..10 from the AI analyzer. Treat >10 values (legacy 0..100)
  // by normalizing display, but always show as X/10. No color coding -
  // user wanted scores to read as clean typography, not as a stoplight.
  const raw = Number(score)
  const tenScale = raw > 10 ? Math.round(raw / 10) : Math.round(raw)
  const s = Math.max(0, Math.min(10, tenScale))
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] uppercase tracking-widest text-text-muted font-medium">{label}</div>
      <div className="flex items-baseline gap-1 -mt-0.5">
        <span className="font-display text-[34px] leading-none tabular-nums font-medium text-text-primary">{s}</span>
        <span className="font-display text-[16px] text-text-muted tabular-nums">/10</span>
      </div>
      {feedback && (
        <div className="text-[12.5px] text-text-secondary leading-snug">{feedback}</div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest font-medium text-text-primary mb-2.5 pb-1.5 border-b border-black/[0.06]">
        {title}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  )
}

function Field({ label, value, emphasized }: { label: string; value: string; emphasized?: boolean }) {
  return (
    <div>
      {label && (
        <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1 font-medium">{label}</div>
      )}
      <div className={`leading-snug ${emphasized ? 'text-[14px] font-display text-text-primary' : 'text-[12.5px] text-text-secondary'}`}>
        {value}
      </div>
    </div>
  )
}

function TagField({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      {label && <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1 font-medium">{label}</div>}
      <div className="flex flex-wrap gap-1.5">
        {items.map((it, i) => (
          <span key={i} className="text-[11px] bg-black/[0.04] rounded-full px-2.5 py-0.5 text-text-secondary">
            {it}
          </span>
        ))}
      </div>
    </div>
  )
}

// Small inline chip for compositional-analysis text-placement cards
function MiniChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-black/[0.04] px-2 py-0.5 text-[10px]">
      <span className="uppercase tracking-widest text-text-muted opacity-80 font-medium">{label}</span>
      <span className="text-text-secondary">{value}</span>
    </span>
  )
}

function ColorSwatches({ colors }: { colors: string[] }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1 font-medium">Colors</div>
      <div className="flex flex-wrap gap-1.5">
        {colors.map((c, i) => (
          <div key={i} className="flex items-center gap-1.5 bg-black/[0.03] rounded-full pl-1 pr-2.5 py-0.5 border border-black/[0.04]">
            <span className="inline-block w-4 h-4 rounded-full border border-black/10"
              style={{ background: cssColor(c) }} />
            <span className="text-[11px] text-text-secondary">{c}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ListField({ label, items, tone }: { label: string; items: string[]; tone: 'good' | 'orange' }) {
  const dot = tone === 'good' ? 'bg-emerald-500' : 'bg-[#B7410E]'
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1 font-medium">{label}</div>
      <ul className="flex flex-col gap-1">
        {items.map((it, i) => (
          <li key={i} className="flex gap-1.5 text-[12.5px] text-text-secondary leading-snug">
            <span className={`inline-block w-1.5 h-1.5 rounded-full mt-[5px] flex-shrink-0 ${dot}`} />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Small two-line metadata cell. uppercase muted label above a normal
// value. Used in the classification strip so enums read like the rest
// of the panel instead of as loud chromatic pills.
function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9.5px] uppercase tracking-widest text-text-muted font-medium leading-tight">{label}</div>
      <div className="text-[12.5px] text-text-primary leading-snug truncate" title={value}>{value}</div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// DemoBreakdownCharts. fetches age/gender breakdowns from Meta on mount
// and renders one stacked bar chart per metric (spend default, switchable
// to impressions / purchases).
// ---------------------------------------------------------------------------
type DemoRow = { spend: number; impressions: number; clicks: number; purchases: number; revenue: number }
type DemoCrossRow = DemoRow & { age: string; gender: string }
type DemoPayload = {
  age: (DemoRow & { bucket: string })[]
  gender: (DemoRow & { bucket: string })[]
  age_gender: DemoCrossRow[]
}

const GENDER_COLORS: Record<string, string> = {
  female: '#B7410E',
  male: '#2563eb',
  unknown: '#9ca3af',
}

function DemoBreakdownCharts({ adId, brand, start, end, spend }: {
  adId: string
  brand: string
  start: string
  end: string
  spend: number
}) {
  const [data, setData] = useState<DemoPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [metric, setMetric] = useState<'spend' | 'impressions' | 'purchases'>(() => {
    if (typeof window === 'undefined') return 'spend'
    const saved = localStorage.getItem('atelier.demo.metric')
    return saved === 'impressions' || saved === 'purchases' ? saved : 'spend'
  })
  useEffect(() => {
    try { localStorage.setItem('atelier.demo.metric', metric) } catch {}
  }, [metric])

  useEffect(() => {
    if (IN_REPORT) return
    let cancelled = false
    setLoading(true); setErr(null)
    fetchJSONWithRetry(`/api/ads/creative/${encodeURIComponent(adId)}/breakdowns?brand=${encodeURIComponent(brand)}&start=${start}&end=${end}`)
      .then((d: DemoPayload) => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setErr(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [adId, brand, start, end])

  const stacked = useMemo(() => {
    if (!data) return []
    const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+', 'unknown']
    const genders = Array.from(new Set(data.age_gender.map(r => r.gender || 'unknown')))
    const byAge: Record<string, any> = {}
    for (const r of data.age_gender) {
      const age = r.age || 'unknown'
      if (!byAge[age]) {
        byAge[age] = { age }
        for (const g of genders) byAge[age][g] = 0
      }
      const g = r.gender || 'unknown'
      byAge[age][g] += Number((r as any)[metric] || 0)
    }
    return Object.values(byAge).sort((a: any, b: any) => {
      const ai = AGE_ORDER.indexOf(a.age); const bi = AGE_ORDER.indexOf(b.age)
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    })
  }, [data, metric])

  const genders = useMemo(
    () => data ? Array.from(new Set(data.age_gender.map(r => r.gender || 'unknown'))).sort() : [],
    [data],
  )

  const total = useMemo(() => {
    if (!data) return 0
    return data.age_gender.reduce((s, r) => s + Number((r as any)[metric] || 0), 0)
  }, [data, metric])

  const fmt = (v: number) => {
    if (metric === 'spend') return `$${Math.round(v).toLocaleString()}`
    return Math.round(v).toLocaleString()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] uppercase tracking-widest text-text-muted">Age × gender</div>
        <div className="flex items-center gap-0.5 text-[10px]">
          {(['spend', 'impressions', 'purchases'] as const).map(m => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={`px-1.5 py-0.5 rounded ${metric === m ? 'bg-black/[0.06] text-text-primary' : 'text-text-muted hover:text-text-primary'}`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="text-[11px] text-text-muted py-4 text-center">
          <Loader2 size={11} className="inline animate-spin mr-1" /> Loading breakdowns…
        </div>
      ) : err ? (
        <div className="text-[11px] text-red-600 py-4 text-center">{err}</div>
      ) : data && stacked.length > 0 && total > 0 ? (
        <div style={{ height: 160 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stacked} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis dataKey="age" tick={{ fontSize: 9, fill: '#6b7280' }} />
              <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} tickFormatter={fmt} />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} formatter={(v: any) => fmt(Number(v))} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              {genders.map(g => (
                <Bar key={g} dataKey={g} stackId="a" fill={GENDER_COLORS[g] || '#9ca3af'} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : spend > 0 ? (
        <div className="text-[11px] text-text-muted py-4 text-center leading-snug">
          Meta hasn't published demographic attribution for this ad over {start} – {end}.
        </div>
      ) : (
        <div className="text-[11px] text-text-muted py-4 text-center">No spend in this period</div>
      )}
    </div>
  )
}

// PlacementBreakdownChart + VideoRetentionChart live in ./ads/PerformanceCharts

// Best-effort color string -> CSS.
function cssColor(s: string): string {
  const t = s.toLowerCase().trim()
  if (/^#[0-9a-f]{3,8}$/.test(t)) return t
  const map: Record<string, string> = {
    red: '#dc2626', orange: '#ea580c', amber: '#f59e0b', yellow: '#eab308',
    lime: '#84cc16', green: '#16a34a', emerald: '#10b981', teal: '#0d9488',
    cyan: '#06b6d4', sky: '#0284c7', blue: '#2563eb', indigo: '#4f46e5',
    violet: '#7c3aed', purple: '#9333ea', fuchsia: '#c026d3', pink: '#ec4899',
    rose: '#f43f5e', white: '#ffffff', black: '#111111', gray: '#6b7280',
    grey: '#6b7280', brown: '#78350f', beige: '#d6c8a3', cream: '#f4ead5',
    tan: '#d2b48c', gold: '#d4af37', silver: '#c0c0c0', navy: '#1e3a8a',
    maroon: '#7f1d1d', olive: '#65a30d', peach: '#fbbf7c',
  }
  for (const k of Object.keys(map)) {
    if (t.includes(k)) return map[k]
  }
  return '#cbd5e1'
}
