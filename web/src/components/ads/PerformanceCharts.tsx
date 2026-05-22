/**
 * PlacementBreakdownChart + VideoRetentionChart
 * ---------------------------------------------
 * Lifted out of AdDetailPanel.tsx into their own module so React Fast
 * Refresh can hot-update them cleanly. When they were defined ~1600
 * lines below their call sites inside the 2k-line AdDetailPanel.tsx,
 * Fast Refresh occasionally swapped in a stale wrapper that resolved
 * the symbol as undefined at runtime. a known footgun with very large
 * single-file modules + Fast Refresh.
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip,
  ComposedChart, Bar, AreaChart, Area,
} from 'recharts'

// `IN_REPORT` mirrors the standalone-report check used by AdDetailPanel
// so this file stays standalone-safe even when bundled into a static
// report HTML with no backend.
const IN_REPORT = typeof window !== 'undefined' && !!(window as any).__REPORT__

// Same retry logic as AdDetailPanel. duplicated here so this file
// stays standalone-importable. Two retries with linear backoff so a
// brief API hiccup (eg. a restart underneath an open detail panel)
// resolves silently instead of leaving "Failed to fetch" on screen.
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

// --- Placement breakdown ---------------------------------------------------

type PlacementRow = {
  placement: string
  platform: string
  position: string
  spend: number
  impressions: number
  clicks: number
  purchases: number
  revenue: number
  roas: number
  cpm: number
  ctr: number
  cpa: number
}

type PlacementMetric = 'roas' | 'spend' | 'cpm' | 'ctr' | 'purchases' | 'cpa' | 'impressions'

const PLACEMENT_METRIC_LABEL: Record<PlacementMetric, string> = {
  roas: 'ROAS', spend: 'Spend', cpm: 'CPM', ctr: 'CTR',
  purchases: 'Purchases', cpa: 'CPA', impressions: 'Impressions',
}
const PLACEMENT_METRIC_FMT: Record<PlacementMetric, (v: number) => string> = {
  roas: v => v.toFixed(2),
  spend: v => `$${Math.round(v).toLocaleString()}`,
  cpm: v => `$${v.toFixed(2)}`,
  ctr: v => `${v.toFixed(2)}%`,
  purchases: v => Math.round(v).toLocaleString(),
  cpa: v => `$${Math.round(v).toLocaleString()}`,
  impressions: v => Math.round(v).toLocaleString(),
}

function shortPlacement(p: string): string {
  // Make labels readable: "instagram/feed" → "IG Feed", "facebook/story" → "FB Story".
  const [plat, pos] = p.split('/')
  const platShort =
    plat === 'instagram' ? 'IG' :
    plat === 'facebook' ? 'FB' :
    plat === 'audience_network' ? 'AN' :
    plat === 'messenger' ? 'MSG' :
    plat
  const posShort = (pos || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return `${platShort} ${posShort}`.trim()
}

function MetricSelect({ value, onChange, color }: {
  value: PlacementMetric
  onChange: (v: PlacementMetric) => void
  color: string
}) {
  return (
    <label className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-black/[0.08] bg-white/60 hover:bg-white cursor-pointer">
      <span className="w-1.5 h-1.5 rounded-sm" style={{ background: color }} />
      <select
        value={value}
        onChange={e => onChange(e.target.value as PlacementMetric)}
        className="bg-transparent text-[10px] text-text-primary outline-none cursor-pointer pr-0.5"
      >
        {(Object.keys(PLACEMENT_METRIC_LABEL) as PlacementMetric[]).map(k => (
          <option key={k} value={k}>{PLACEMENT_METRIC_LABEL[k]}</option>
        ))}
      </select>
    </label>
  )
}

export function PlacementBreakdownChart({ adId, brand, start, end, spend }: {
  adId: string
  brand: string
  start: string
  end: string
  spend: number
}) {
  const [data, setData] = useState<PlacementRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [leftMetric, setLeftMetric] = useState<PlacementMetric>(() => {
    if (typeof window === 'undefined') return 'roas'
    return (localStorage.getItem('atelier.placement.left') as PlacementMetric) || 'roas'
  })
  const [rightMetric, setRightMetric] = useState<PlacementMetric>(() => {
    if (typeof window === 'undefined') return 'spend'
    return (localStorage.getItem('atelier.placement.right') as PlacementMetric) || 'spend'
  })
  useEffect(() => { try { localStorage.setItem('atelier.placement.left', leftMetric) } catch {} }, [leftMetric])
  useEffect(() => { try { localStorage.setItem('atelier.placement.right', rightMetric) } catch {} }, [rightMetric])

  useEffect(() => {
    if (IN_REPORT) return
    let cancelled = false
    setLoading(true); setErr(null)
    fetchJSONWithRetry(`/api/ads/creative/${encodeURIComponent(adId)}/placements?brand=${encodeURIComponent(brand)}&start=${start}&end=${end}`)
      .then((d: { placements: PlacementRow[] }) => { if (!cancelled) setData(d.placements || []) })
      .catch(e => { if (!cancelled) setErr(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [adId, brand, start, end])

  const chartData = useMemo(() => {
    if (!data) return []
    return data.map(r => ({
      label: shortPlacement(r.placement),
      raw: r.placement,
      left: Number((r as any)[leftMetric] || 0),
      right: Number((r as any)[rightMetric] || 0),
    }))
  }, [data, leftMetric, rightMetric])

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] uppercase tracking-widest text-text-muted">Placement breakdown</div>
        <div className="flex items-center gap-1.5 text-[10px]">
          <MetricSelect color="#B7410E" value={leftMetric} onChange={setLeftMetric} />
          <MetricSelect color="#2563eb" value={rightMetric} onChange={setRightMetric} />
        </div>
      </div>
      {loading ? (
        <div className="text-[11px] text-text-muted py-4 text-center">
          <Loader2 size={11} className="inline animate-spin mr-1" /> Loading placements…
        </div>
      ) : err ? (
        <div className="text-[11px] text-red-600 py-4 text-center">{err}</div>
      ) : chartData.length > 0 ? (
        <div style={{ height: 180 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#6b7280' }} interval={0} />
              <YAxis yAxisId="l" tick={{ fontSize: 9, fill: '#6b7280' }} tickFormatter={v => PLACEMENT_METRIC_FMT[leftMetric](v)} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 9, fill: '#6b7280' }} tickFormatter={v => PLACEMENT_METRIC_FMT[rightMetric](v)} />
              <Tooltip
                contentStyle={{ fontSize: 11, borderRadius: 8 }}
                formatter={(v: any, name: any) => {
                  if (name === 'left') return [PLACEMENT_METRIC_FMT[leftMetric](Number(v)), PLACEMENT_METRIC_LABEL[leftMetric]]
                  if (name === 'right') return [PLACEMENT_METRIC_FMT[rightMetric](Number(v)), PLACEMENT_METRIC_LABEL[rightMetric]]
                  return v
                }}
              />
              <Bar yAxisId="l" dataKey="left" fill="#B7410E" radius={[2, 2, 0, 0]} maxBarSize={28} />
              <Bar yAxisId="r" dataKey="right" fill="#2563eb" radius={[2, 2, 0, 0]} maxBarSize={28} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : spend > 0 ? (
        <div className="text-[11px] text-text-muted py-4 text-center leading-snug">
          Meta hasn't published placement-level attribution for this ad over {start} – {end}.
        </div>
      ) : (
        <div className="text-[11px] text-text-muted py-4 text-center">No spend in this period</div>
      )}
    </div>
  )
}

// --- Video retention -------------------------------------------------------

export function VideoRetentionChart({ adId, brand, start, end }: {
  adId: string
  brand: string
  start: string
  end: string
}) {
  const [points, setPoints] = useState<{ second: number; viewers: number }[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (IN_REPORT) return
    let cancelled = false
    setLoading(true); setErr(null)
    fetchJSONWithRetry(`/api/ads/creative/${encodeURIComponent(adId)}/video-curve?brand=${encodeURIComponent(brand)}&start=${start}&end=${end}`)
      .then((d: { points: { second: number; viewers: number }[] }) => { if (!cancelled) setPoints(d.points || []) })
      .catch(e => { if (!cancelled) setErr(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [adId, brand, start, end])

  const fmtSec = (s: number) => {
    const m = Math.floor(s / 60); const ss = s % 60
    return m > 0 ? `${m}:${String(ss).padStart(2, '0')}` : `0:${String(ss).padStart(2, '0')}`
  }
  const peak = useMemo(() => (points || []).reduce((m, p) => Math.max(m, p.viewers), 0), [points])
  const at3s = useMemo(() => (points || []).find(p => p.second === 3)?.viewers ?? 0, [points])
  const hookRate = peak > 0 ? (at3s / peak) * 100 : 0

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] uppercase tracking-widest text-text-muted">Video retention</div>
        {points && points.length > 0 && (
          <div className="text-[10px] text-text-muted tabular-nums">
            peak {peak.toLocaleString()} · 3s-hold {hookRate.toFixed(0)}%
          </div>
        )}
      </div>
      {loading ? (
        <div className="text-[11px] text-text-muted py-4 text-center">
          <Loader2 size={11} className="inline animate-spin mr-1" /> Loading retention curve…
        </div>
      ) : err ? (
        <div className="text-[11px] text-red-600 py-4 text-center">{err}</div>
      ) : points && points.length > 0 ? (
        <div style={{ height: 160 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
              <defs>
                <linearGradient id="retentionGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#B7410E" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#B7410E" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis dataKey="second" tickFormatter={fmtSec} tick={{ fontSize: 9, fill: '#6b7280' }} />
              <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} tickFormatter={v => Math.round(v).toLocaleString()} />
              <Tooltip
                contentStyle={{ fontSize: 11, borderRadius: 8 }}
                labelFormatter={(s: any) => `at ${fmtSec(Number(s))}`}
                formatter={(v: any) => [Math.round(Number(v)).toLocaleString(), 'viewers']}
              />
              <Area type="monotone" dataKey="viewers" stroke="#B7410E" strokeWidth={1.5} fill="url(#retentionGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="text-[11px] text-text-muted py-4 text-center">No retention data available</div>
      )}
    </div>
  )
}
