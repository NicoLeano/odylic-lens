/**
 * VideoRetentionMini. Meta-only retention/drop-off curve
 * -------------------------------------------------------
 * Five-point curve plotted from Meta's quartile completion data
 * (video_p25/p50/p75/p100, anchored at video_3s_views = 100%). Matches
 * the Atria web app's "Retain / Drop off" chart aesthetic but powered
 * by *our* Meta insights. accurate to the ad, available without an
 * extra Graph call because the values already come back with the
 * creatives endpoint.
 *
 * Not used on Atria competitor ads. we have no analytics signal for
 * those (and Atria's API doesn't expose performance data either).
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2, ChevronDown } from 'lucide-react'

type CurvePoint = { pct: number; viewers: number; value: number; label: string }

interface Props {
  adId: string
  brand: string
  start: string
  end: string
}

type Mode = 'retain' | 'dropoff'

export function VideoRetentionMini({ adId, brand, start, end }: Props) {
  const [data, setData] = useState<{
    retain_pct: CurvePoint[]
    drop_off_pct: CurvePoint[]
    video_3s_views: number
    video_avg_time_watched_sec: number
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('retain')
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    let cancel = false
    setLoading(true)
    setError(null)
    const p = new URLSearchParams({ ad_id: adId, brand, start, end })
    fetch(`/api/ads/retention?${p.toString()}`)
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}))
          throw new Error(body.detail || `HTTP ${r.status}`)
        }
        return r.json()
      })
      .then(body => {
        if (cancel) return
        setData(body)
      })
      .catch(e => {
        if (cancel) return
        setError(e?.message || 'Failed to load retention')
      })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [adId, brand, start, end])

  const points = useMemo(() => {
    if (!data) return []
    return mode === 'retain' ? data.retain_pct : data.drop_off_pct
  }, [data, mode])

  // SVG polyline path. fixed viewBox so the chart is dimension-agnostic;
  // we letterbox the X axis to the 5 anchor points (0/25/50/75/100).
  const W = 320
  const H = 100
  const PAD_X = 8
  const PAD_Y = 8
  const path = useMemo(() => {
    if (points.length === 0) return ''
    const xs = points.map(
      (_p, i) => PAD_X + (i / (points.length - 1)) * (W - PAD_X * 2),
    )
    const ys = points.map(
      p => PAD_Y + (1 - Math.max(0, Math.min(100, p.value)) / 100) * (H - PAD_Y * 2),
    )
    return xs.map((x, i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' ')
  }, [points])

  if (loading) {
    return (
      <div className="rounded-xl border border-black/[0.06] p-3 bg-white">
        <div className="text-[11px] text-text-muted flex items-center gap-1.5">
          <Loader2 size={10} className="animate-spin" /> Loading retention…
        </div>
      </div>
    )
  }
  if (error || !data) {
    // Retention data simply doesn't exist for image ads or for video ads
    // that haven't earned a single 3s view in the date range. We render
    // a quiet "no data" tile instead of a noisy error.
    return null
  }
  if (data.video_3s_views <= 0) {
    return null
  }

  const stroke = mode === 'retain' ? '#7c3aed' : '#B7410E'

  return (
    <div className="rounded-xl border border-black/[0.06] p-3 bg-white">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="font-display text-[13px]">Video analysis</div>
        <div className="relative">
          <button
            onClick={() => setPickerOpen(o => !o)}
            className="h-6 px-2 rounded-md text-[10px] border border-[#B7410E]/30 text-[#b55719] flex items-center gap-1"
          >
            {mode === 'retain' ? 'Retain' : 'Drop off'}
            <ChevronDown size={9} />
          </button>
          {pickerOpen && (
            <div className="absolute left-0 top-full mt-1 z-30 bg-white rounded-md shadow-[0_6px_24px_-4px_rgba(0,0,0,0.18)] border border-black/[0.08] py-1 min-w-[100px]">
              <button
                onClick={() => { setMode('dropoff'); setPickerOpen(false) }}
                className={`block w-full text-left px-3 py-1 text-[11px] hover:bg-black/[0.04] ${
                  mode === 'dropoff' ? 'text-[#B7410E] font-medium' : ''
                }`}
              >
                Drop off
              </button>
              <button
                onClick={() => { setMode('retain'); setPickerOpen(false) }}
                className={`block w-full text-left px-3 py-1 text-[11px] hover:bg-black/[0.04] ${
                  mode === 'retain' ? 'text-[#B7410E] font-medium' : ''
                }`}
              >
                Retain
              </button>
            </div>
          )}
        </div>
        <div className="ml-auto text-[10px] text-text-muted">
          {data.video_3s_views.toLocaleString()} plays · avg {Math.round(data.video_avg_time_watched_sec)}s
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" role="img">
        {/* Grid lines at 25/50/75 */}
        {[0.25, 0.5, 0.75].map(t => (
          <line
            key={t}
            x1={PAD_X}
            x2={W - PAD_X}
            y1={PAD_Y + t * (H - PAD_Y * 2)}
            y2={PAD_Y + t * (H - PAD_Y * 2)}
            stroke="#e5e7eb"
            strokeDasharray="3 3"
            strokeWidth={1}
          />
        ))}
        {/* Curve */}
        <path d={path} fill="none" stroke={stroke} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        {/* Anchor dots */}
        {points.map((p, i) => {
          const x = PAD_X + (i / (points.length - 1)) * (W - PAD_X * 2)
          const y = PAD_Y + (1 - Math.max(0, Math.min(100, p.value)) / 100) * (H - PAD_Y * 2)
          return <circle key={i} cx={x} cy={y} r={2.5} fill={stroke} />
        })}
      </svg>
      <div className="flex justify-between text-[9px] text-text-muted mt-1 px-1">
        {points.map((p, i) => (
          <span key={i}>{p.label}</span>
        ))}
      </div>
    </div>
  )
}

export default VideoRetentionMini
