import { useEffect, useState } from 'react'
import { Loader2, Heart, MessageSquare } from 'lucide-react'

// ---------------------------------------------------------------------------
// Types. mirror /api/ads/comments payload. When sentiment libs are
// unavailable on the backend the `summary` field is omitted and each
// comment lacks `sentiment` / `emotions`; the UI handles both paths.
// ---------------------------------------------------------------------------

type Sentiment = {
  label: 'positive' | 'neutral' | 'negative'
  score: number  // VADER compound in [-1, 1]
}

type Emotions = {
  anger: number
  anticipation: number
  disgust: number
  fear: number
  joy: number
  sadness: number
  surprise: number
  trust: number
}

type Comment = {
  id: string
  author: string
  avatar?: string
  platform: 'fb' | 'ig'
  message: string
  created_time: string
  like_count: number
  sentiment?: Sentiment
  emotions?: Emotions
}

type Summary = {
  count: number
  sentiment: {
    positive_pct: number
    neutral_pct: number
    negative_pct: number
    avg_compound: number
  }
  emotions: Emotions
  top_emotion: keyof Emotions | null
  top_quotes: { positive: string | null; negative: string | null }
}

type CommentsPayload = {
  brand: string
  ad_id: string
  comments: Comment[]
  notes?: string | null
  summary?: Summary
}

interface Props {
  adId: string
  brand: string
}

// ---------------------------------------------------------------------------
// Emotion color mapping. Plutchik-flavored palette, cream-friendly, with
// explicit bg + text so pills render on any surface. Keys match NRCLex's
// 8 core emotions exactly.
// ---------------------------------------------------------------------------

const EMOTION_COLORS: Record<keyof Emotions, { bg: string; fg: string; label: string }> = {
  joy:          { bg: 'rgba(234, 179, 8, 0.14)',  fg: '#A16207', label: 'Joy' },
  trust:        { bg: 'rgba(34, 197, 94, 0.14)',  fg: '#15803D', label: 'Trust' },
  anticipation: { bg: 'rgba(249, 115, 22, 0.14)', fg: '#C2410C', label: 'Anticipation' },
  surprise:     { bg: 'rgba(14, 165, 233, 0.14)', fg: '#0369A1', label: 'Surprise' },
  sadness:      { bg: 'rgba(59, 130, 246, 0.14)', fg: '#1D4ED8', label: 'Sadness' },
  fear:         { bg: 'rgba(139, 92, 246, 0.14)', fg: '#6D28D9', label: 'Fear' },
  disgust:      { bg: 'rgba(132, 204, 22, 0.14)', fg: '#4D7C0F', label: 'Disgust' },
  anger:        { bg: 'rgba(239, 68, 68, 0.14)',  fg: '#B91C1C', label: 'Anger' },
}

// Sentiment dot colors for per-comment indicator. Reuses the positive/
// negative hue already in the emotion palette for consistency.
const SENTIMENT_DOT: Record<Sentiment['label'], string> = {
  positive: '#15803D',
  neutral:  '#9CA3AF',
  negative: '#B91C1C',
}

// ---------------------------------------------------------------------------
// Relative timestamp formatter. "3h ago" / "2d ago" / "Apr 12"
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  const diffD = Math.floor(diffH / 24)
  if (diffD < 7) return `${diffD}d ago`
  // Fall back to a compact date for anything older than a week.
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

// Deterministic initials for avatar fallback.
function initials(name: string): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map(p => p.charAt(0).toUpperCase()).join('') || '?'
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CommentsView({ adId, brand }: Props) {
  const [payload, setPayload] = useState<CommentsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Pagination. comments API returns up to 100, we slice client-side.
  const [visible, setVisible] = useState(25)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    fetch(`/api/ads/comments?brand=${encodeURIComponent(brand)}&ad_id=${encodeURIComponent(adId)}`)
      .then(async r => {
        const d = await r.json()
        if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`)
        return d as CommentsPayload
      })
      .then(d => { if (!cancelled) setPayload(d) })
      .catch(e => { if (!cancelled) setErr(String(e.message || e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [adId, brand])

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map(i => (
          <div key={i} className="flex gap-2.5 animate-pulse">
            <div className="w-8 h-8 rounded-full bg-black/[0.06] shrink-0" />
            <div className="flex-1 flex flex-col gap-1.5 py-1">
              <div className="h-2.5 w-24 rounded bg-black/[0.06]" />
              <div className="h-2 w-full rounded bg-black/[0.04]" />
              <div className="h-2 w-3/4 rounded bg-black/[0.04]" />
            </div>
          </div>
        ))}
        <div className="flex items-center justify-center gap-1.5 text-[11px] text-text-muted mt-2">
          <Loader2 size={11} className="animate-spin" />
          Fetching comments…
        </div>
      </div>
    )
  }

  if (err) {
    return (
      <div className="text-red-600 text-[11px]">
        Could not load comments: {err}
      </div>
    )
  }

  const comments = payload?.comments || []
  // `notes` is backend diagnostic text. typically Meta permission /
  // scope errors like "#10 pages_read_engagement permission". Useful in
  // server logs but not in the user-facing panel: the user has no
  // action they can take without redoing the Meta app's Login Review.
  // Hide it from the UI. Set `?debug=1` on the URL to surface for
  // troubleshooting.
  const showNotes = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1"
  const notes = showNotes ? (payload?.notes || null) : null
  const summary = payload?.summary

  if (!comments.length) {
    return (
      <div className="flex flex-col items-center text-center py-8 gap-2">
        <div className="w-10 h-10 rounded-full bg-black/[0.04] flex items-center justify-center">
          <MessageSquare size={16} className="text-text-muted" />
        </div>
        <div className="text-[12px] text-text-primary font-medium">No comments yet</div>
        {notes && (
          <div className="text-[10px] text-text-muted max-w-[340px] leading-snug">{notes}</div>
        )}
      </div>
    )
  }

  const shown = comments.slice(0, visible)
  const hasMore = comments.length > visible

  return (
    <div className="flex flex-col gap-4">
      {summary && summary.count > 0 && <SentimentSummaryCard summary={summary} />}
      {notes && (
        <div className="text-[10px] text-text-muted bg-black/[0.03] rounded-lg px-2.5 py-1.5 leading-snug">
          {notes}
        </div>
      )}
      <ul className="flex flex-col divide-y divide-black/[0.04]">
        {shown.map(c => (
          <li key={c.id} className="flex gap-2.5 py-2.5 first:pt-0">
            {/* Avatar. 32x32, rounded, fallback to initials chip. */}
            {c.avatar ? (
              <img
                src={c.avatar}
                alt={c.author}
                className="w-8 h-8 rounded-full object-cover shrink-0 bg-black/[0.04]"
                loading="lazy"
              />
            ) : (
              <div
                className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-[10px] font-medium text-text-secondary bg-black/[0.06]"
                aria-hidden
              >
                {initials(c.author)}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                {c.sentiment && (
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: SENTIMENT_DOT[c.sentiment.label] }}
                    title={`${c.sentiment.label} (${c.sentiment.score >= 0 ? '+' : ''}${c.sentiment.score.toFixed(2)})`}
                    aria-label={`Sentiment: ${c.sentiment.label}`}
                  />
                )}
                <span className="text-[11px] font-medium text-text-primary truncate">
                  {c.author}
                </span>
                <PlatformBadge platform={c.platform} />
                <span className="text-[9.5px] text-text-muted">
                  {relativeTime(c.created_time)}
                </span>
              </div>
              {c.message && (
                <div className="text-[12px] text-text-secondary leading-snug whitespace-pre-wrap mt-0.5 break-words">
                  {c.message}
                </div>
              )}
              {c.like_count > 0 && (
                <div className="flex items-center gap-1 text-[10px] text-text-muted mt-1">
                  <Heart size={9} className="fill-current" />
                  <span>{c.like_count}</span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button
          onClick={() => setVisible(v => v + 25)}
          className="text-[11px] text-text-secondary hover:text-text-primary bg-black/[0.03] hover:bg-black/[0.05] rounded-lg px-3 py-1.5 transition"
        >
          Load more ({comments.length - visible} remaining)
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Summary card. sits at the top of the comments list. Three bar segments
// for pos/neu/neg %, an avg sentiment label, top-3 emotion pills, and top
// positive + negative quote blockquotes when present.
// ---------------------------------------------------------------------------

function SentimentSummaryCard({ summary }: { summary: Summary }) {
  const { sentiment, emotions, top_quotes, count } = summary

  // Top 3 emotions by average frequency, filtered to non-zero.
  const topEmotions = (Object.entries(emotions) as [keyof Emotions, number][])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)

  const avg = sentiment.avg_compound
  const avgLabel = `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}`

  return (
    <div className="flex flex-col gap-3">
      {/* Header. uppercase label + count + avg, matches the typographic
          rhythm of the rest of the analysis sections. No box, no cream
          background. sentiment is just data, not a hero element. */}
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-widest text-text-muted font-medium">Sentiment</span>
          <span className="text-[10px] text-text-muted">{count} comment{count === 1 ? '' : 's'}</span>
        </div>
        <div className="text-[10px] text-text-muted tabular-nums">avg {avgLabel}</div>
      </div>

      {/* Segmented bar. slightly thicker so the proportions read at a
          glance. Hover tooltips still carry the precise pcts. */}
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-black/[0.04]">
        {sentiment.positive_pct > 0 && (
          <div style={{ width: `${sentiment.positive_pct}%`, background: '#15803D' }}
            title={`${sentiment.positive_pct}% positive`} />
        )}
        {sentiment.neutral_pct > 0 && (
          <div style={{ width: `${sentiment.neutral_pct}%`, background: '#D1D5DB' }}
            title={`${sentiment.neutral_pct}% neutral`} />
        )}
        {sentiment.negative_pct > 0 && (
          <div style={{ width: `${sentiment.negative_pct}%`, background: '#B91C1C' }}
            title={`${sentiment.negative_pct}% negative`} />
        )}
      </div>
      {/* Proper legend. colored dot + label + pct so the bar's three
          numbers actually map to something the user can read. Replaces
          the cryptic "+40% ·50% -10%" string under the bar. */}
      <div className="flex items-center gap-4 text-[11px] -mt-0.5">
        <span className="inline-flex items-center gap-1.5 text-text-secondary">
          <span className="w-2 h-2 rounded-full" style={{ background: '#15803D' }} />
          <span className="tabular-nums font-medium">{sentiment.positive_pct}%</span>
          <span className="text-text-muted">positive</span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-text-secondary">
          <span className="w-2 h-2 rounded-full" style={{ background: '#D1D5DB' }} />
          <span className="tabular-nums font-medium">{sentiment.neutral_pct}%</span>
          <span className="text-text-muted">neutral</span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-text-secondary">
          <span className="w-2 h-2 rounded-full" style={{ background: '#B91C1C' }} />
          <span className="tabular-nums font-medium">{sentiment.negative_pct}%</span>
          <span className="text-text-muted">negative</span>
        </span>
      </div>

      {/* Top emotions. same muted text/value rhythm as MetaItem on
          the analysis page. No colored pills. */}
      {topEmotions.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[10px] uppercase tracking-widest text-text-muted font-medium">Emotions</span>
          {topEmotions.map(([k, v]) => (
            <span key={k} className="text-[11px] text-text-primary tabular-nums">
              {EMOTION_COLORS[k].label}
              <span className="text-text-muted ml-1">{(v * 100).toFixed(0)}%</span>
            </span>
          ))}
        </div>
      )}

      {/* Top quotes. label now stacked above the quote on its own
          line + colored, so the eye can find each block. The old
          inline-uppercase-label-before-text layout made the pair read
          like one run-on sentence. */}
      {(top_quotes.positive || top_quotes.negative) && (
        <div className="flex flex-col gap-3 pt-1">
          {top_quotes.positive && <Quote tone="positive" text={top_quotes.positive} />}
          {top_quotes.negative && <Quote tone="negative" text={top_quotes.negative} />}
        </div>
      )}
    </div>
  )
}

function Quote({ tone, text }: { tone: 'positive' | 'negative'; text: string }) {
  // Clip long comments. ad comments can run 1K+ chars and we don't
  // want one rant to dominate the summary.
  const clipped = text.length > 180 ? `${text.slice(0, 180).trim()}…` : text
  const colorBorder = tone === 'positive' ? '#15803D' : '#B91C1C'
  const colorLabel  = tone === 'positive' ? '#15803D' : '#B91C1C'
  const labelText = tone === 'positive' ? 'Top positive' : 'Top negative'
  return (
    <div
      className="text-[12px] text-text-secondary leading-snug pl-3 border-l-2 flex flex-col gap-1"
      style={{ borderColor: colorBorder }}
    >
      <span
        className="text-[9.5px] uppercase tracking-widest font-semibold"
        style={{ color: colorLabel }}
      >
        {labelText}
      </span>
      <span className="text-text-primary leading-relaxed">"{clipped}"</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Platform badge. tiny pill, uses brand-ish blue for FB + pink for IG.
// ---------------------------------------------------------------------------

function PlatformBadge({ platform }: { platform: 'fb' | 'ig' }) {
  if (platform === 'ig') {
    return (
      <span
        className="text-[8.5px] uppercase tracking-wider font-medium px-1.5 py-[1px] rounded"
        style={{ background: 'rgba(225, 48, 108, 0.08)', color: '#C13584' }}
      >
        IG
      </span>
    )
  }
  return (
    <span
      className="text-[8.5px] uppercase tracking-wider font-medium px-1.5 py-[1px] rounded"
      style={{ background: 'rgba(24, 119, 242, 0.08)', color: '#1877F2' }}
    >
      FB
    </span>
  )
}
