import { useMemo, useState } from 'react'
import { ArrowUp, ArrowDown } from 'lucide-react'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatDateLabel(dateStr: string, granularity: string): string {
  if (!dateStr) return ''
  if (granularity === 'week') {
    // Show week range: "Apr 7 – Apr 13"
    const d = new Date(dateStr + 'T00:00:00')
    const end = new Date(d); end.setDate(d.getDate() + 6)
    return `${MONTHS[d.getMonth()]} ${d.getDate()} – ${MONTHS[end.getMonth()]} ${end.getDate()}`
  }
  if (granularity === 'month') {
    // "April 2026"
    const [y, m] = dateStr.split('-')
    const fullMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    return `${fullMonths[parseInt(m) - 1]} ${y}`
  }
  if (granularity === 'quarter') {
    // "Q1 2026"
    const [y, m] = dateStr.split('-')
    const q = Math.ceil(parseInt(m) / 3)
    return `Q${q} ${y}`
  }
  return dateStr
}

type MetricDef = { key: string; label: string; format: string }

interface DataTableProps {
  rows: any[]
  compareRows?: any[]
  metrics: string[]
  metricDefs: MetricDef[]
  granularity: string
  breakdown?: string
  compareDisplay?: 'delta' | 'prev' | 'both'
  /** Optional roll-up dimension. When set, rows collapse to one row per
   *  unique value of this field, with SUM_METRICS summed and derived metrics
   *  recomputed. Overrides the default per-date rendering. */
  groupBy?: string
}

const BREAKDOWN_LABELS: Record<string, string> = {
  age: 'Age',
  gender: 'Gender',
  publisher_platform: 'Platform',
  platform_position: 'Placement',
  impression_device: 'Device',
  country: 'Country',
  region: 'Region',
  dma: 'DMA',
  product_id: 'Product',
  standard_event_content_type: 'Segment',
}

// Metrics where lower values are better (costs, frequency). Everything else
// is treated as higher-is-better. Spend is neutral. direction depends on
// strategy, so we show the delta without a positive/negative color.
const LOWER_IS_BETTER = new Set([
  'cpc', 'cpm', 'cpp', 'cost_per_click', 'cost_per_unique_click',
  'cost_per_inline_link_click', 'cost_per_estimated_ad_recaller',
  'cost_per_purchase', 'cost_per_atc', 'cost_per_ic', 'cost_per_vc',
  'cost_per_lead', 'cost_per_lpv', 'cost_per_api', 'cost_per_search',
  'cost_per_cr', 'cost_per_thruplay', 'cost_per_conv', 'cost_per_all_conv',
  'frequency',
])
const NEUTRAL_METRICS = new Set(['spend'])

function deltaPct(curr: number | null | undefined, prev: number | null | undefined): number | null {
  if (curr === null || curr === undefined || prev === null || prev === undefined) return null
  if (!prev) return null
  return ((curr - prev) / Math.abs(prev)) * 100
}

function CompareLine({ curr, prev, format, metricKey, mode }: {
  curr: number | null | undefined
  prev: number | null | undefined
  format: string
  metricKey: string
  mode: 'delta' | 'prev' | 'both'
}) {
  const pct = deltaPct(curr, prev)
  if (mode === 'prev') {
    return <div className="text-[10px] text-text-muted tabular-nums leading-tight">vs {formatValue(prev, format)}</div>
  }
  if (mode === 'both') {
    return (
      <>
        <div className="text-[10px] text-text-muted tabular-nums leading-tight">vs {formatValue(prev, format)}</div>
        <Delta pct={pct} metricKey={metricKey} />
      </>
    )
  }
  return <Delta pct={pct} metricKey={metricKey} />
}

function Delta({ pct, metricKey }: { pct: number | null; metricKey: string }) {
  if (pct === null || !isFinite(pct)) return null
  const neutral = NEUTRAL_METRICS.has(metricKey)
  const lowerBetter = LOWER_IS_BETTER.has(metricKey)
  const isUp = pct > 0
  const isDown = pct < 0
  let color = 'text-text-muted'
  if (!neutral && (isUp || isDown)) {
    const good = lowerBetter ? isDown : isUp
    color = good ? 'text-emerald-600' : 'text-red-500'
  }
  const sign = pct > 0 ? '+' : ''
  const abs = Math.abs(pct)
  const display = abs >= 1000 ? `${sign}${pct.toFixed(0)}%` : `${sign}${pct.toFixed(1)}%`
  return <div className={`text-[10px] ${color} tabular-nums leading-tight`}>{display}</div>
}

function formatValue(value: number | null | undefined, format: string): string {
  if (value === null || value === undefined) return '-'
  switch (format) {
    case 'dollar':
      return value >= 1000 ? `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}` :
             value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(2)}`
    case 'number':
      return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
    case 'percent':
      return `${value.toFixed(2)}%`
    case 'decimal':
      return value.toFixed(2)
    default:
      return String(value)
  }
}

// All raw summable metrics across both platforms
const SUM_METRICS = new Set([
  'spend', 'revenue', 'purchases', 'impressions', 'clicks', 'reach',
  'unique_clicks', 'link_clicks', 'inline_link_clicks',
  'outbound_clicks', 'unique_outbound_clicks',
  'add_to_cart', 'atc_value', 'initiate_checkout', 'ic_value',
  'view_content', 'vc_value', 'add_payment_info', 'api_value',
  'leads', 'lead_value', 'landing_page_views', 'search',
  'complete_registration', 'cr_value',
  'post_engagement', 'page_engagement', 'post_reactions', 'post_comments', 'post_shares', 'post_saves',
  'video_views', 'thruplays', 'video_p25', 'video_p50', 'video_p75', 'video_p95', 'video_p100',
  'conv_value', 'conversions', 'all_conversions', 'all_conv_value', 'view_through_conv', 'interactions',
  'estimated_ad_recallers',
])

// Derived metrics. recalculated from raw sums, never averaged
const DERIVED_METRICS: Record<string, (t: Record<string, number>) => number> = {
  // Meta
  roas: t => t.spend > 0 ? (t.revenue || 0) / t.spend : 0,
  cpc: t => t.clicks > 0 ? t.spend / t.clicks : 0,
  cpm: t => t.impressions > 0 ? (t.spend / t.impressions) * 1000 : 0,
  ctr: t => t.impressions > 0 ? (t.clicks / t.impressions) * 100 : 0,
  cpp: t => t.reach > 0 ? t.spend / (t.reach / 1000) : 0,
  unique_ctr: t => t.impressions > 0 ? ((t.unique_clicks || 0) / t.impressions) * 100 : 0,
  frequency: t => t.reach > 0 ? t.impressions / t.reach : 0,
  outbound_ctr: t => t.impressions > 0 ? ((t.outbound_clicks || 0) / t.impressions) * 100 : 0,
  unique_outbound_ctr: t => t.impressions > 0 ? ((t.unique_outbound_clicks || 0) / t.impressions) * 100 : 0,
  inline_link_click_ctr: t => t.impressions > 0 ? ((t.inline_link_clicks || 0) / t.impressions) * 100 : 0,
  cost_per_inline_link_click: t => (t.inline_link_clicks || 0) > 0 ? t.spend / t.inline_link_clicks : 0,
  cost_per_unique_click: t => (t.unique_clicks || 0) > 0 ? t.spend / t.unique_clicks : 0,
  unique_link_clicks_ctr: t => t.impressions > 0 ? ((t.unique_clicks || 0) / t.impressions) * 100 : 0,
  estimated_ad_recall_rate: t => t.reach > 0 ? ((t.estimated_ad_recallers || 0) / t.reach) * 100 : 0,
  cost_per_estimated_ad_recaller: t => (t.estimated_ad_recallers || 0) > 0 ? t.spend / t.estimated_ad_recallers : 0,
  cost_per_purchase: t => (t.purchases || 0) > 0 ? t.spend / t.purchases : 0,
  cost_per_atc: t => (t.add_to_cart || 0) > 0 ? t.spend / t.add_to_cart : 0,
  cost_per_ic: t => (t.initiate_checkout || 0) > 0 ? t.spend / t.initiate_checkout : 0,
  cost_per_vc: t => (t.view_content || 0) > 0 ? t.spend / t.view_content : 0,
  cost_per_lead: t => (t.leads || 0) > 0 ? t.spend / t.leads : 0,
  cost_per_lpv: t => (t.landing_page_views || 0) > 0 ? t.spend / t.landing_page_views : 0,
  cost_per_api: t => (t.add_payment_info || 0) > 0 ? t.spend / t.add_payment_info : 0,
  cost_per_search: t => (t.search || 0) > 0 ? t.spend / t.search : 0,
  cost_per_cr: t => (t.complete_registration || 0) > 0 ? t.spend / t.complete_registration : 0,
  cost_per_thruplay: t => (t.thruplays || 0) > 0 ? t.spend / t.thruplays : 0,
  purchase_cvr: t => (t.unique_outbound_clicks || 0) > 0 ? ((t.purchases || 0) / t.unique_outbound_clicks) * 100 : 0,
  atc_cvr: t => (t.unique_outbound_clicks || 0) > 0 ? ((t.add_to_cart || 0) / t.unique_outbound_clicks) * 100 : 0,
  ic_cvr: t => (t.unique_outbound_clicks || 0) > 0 ? ((t.initiate_checkout || 0) / t.unique_outbound_clicks) * 100 : 0,
  // Google
  value_cost: t => t.spend > 0 ? (t.conv_value || 0) / t.spend : 0,
  cvr: t => t.clicks > 0 ? ((t.conversions || t.purchases || 0) / t.clicks) * 100 : 0,
  cost_per_conv: t => (t.conversions || 0) > 0 ? t.spend / t.conversions : 0,
  conv_rate_by_impr: t => t.impressions > 0 ? ((t.conversions || 0) / t.impressions) * 100 : 0,
  all_value_cost: t => t.spend > 0 ? (t.all_conv_value || 0) / t.spend : 0,
  cost_per_all_conv: t => (t.all_conversions || 0) > 0 ? t.spend / t.all_conversions : 0,
  interaction_rate: t => t.impressions > 0 ? ((t.interactions || 0) / t.impressions) * 100 : 0,
  cost_per_click: t => t.clicks > 0 ? t.spend / t.clicks : 0,
}

function computeTotals(rows: any[], metrics: string[]): Record<string, number> {
  const sums: Record<string, number> = {}
  const allKeys = new Set([...SUM_METRICS, ...metrics])
  for (const key of allKeys) sums[key] = 0
  for (const row of rows) {
    for (const key of allKeys) {
      if (SUM_METRICS.has(key) && typeof row[key] === 'number') {
        sums[key] += row[key]
      }
    }
  }
  const result: Record<string, number> = { ...sums }
  for (const [key, calc] of Object.entries(DERIVED_METRICS)) {
    if (metrics.includes(key)) {
      result[key] = calc(sums)
    }
  }
  return result
}

function applyGroupBy(rows: any[], groupKey: string | undefined, metrics: string[]): { rows: any[]; groupField: string | null } {
  if (!groupKey || groupKey === 'none' || !rows.length) return { rows, groupField: null }
  const bucket: Record<string, any[]> = {}
  for (const r of rows) {
    const v = r[groupKey]
    if (v === undefined || v === null || v === '') continue
    const k = String(v)
    ;(bucket[k] ||= []).push(r)
  }
  const out: any[] = []
  for (const [value, group] of Object.entries(bucket)) {
    const totals = computeTotals(group, metrics)
    const row: any = { [groupKey]: value, date: value, ...totals }
    out.push(row)
  }
  // Sort grouped rows by spend desc (most informative default)
  out.sort((a, b) => (b.spend || 0) - (a.spend || 0))
  return { rows: out, groupField: groupKey }
}

export function DataTable({ rows, compareRows, metrics, metricDefs, granularity, breakdown, compareDisplay = 'delta', groupBy }: DataTableProps) {
  const [sortKey, setSortKey] = useState<string>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [heatmap, setHeatmap] = useState<boolean>(() => {
    try { return localStorage.getItem('atelier.dt.heatmap') === '1' } catch { return false }
  })
  const toggleHeatmap = () => setHeatmap(v => {
    const nv = !v
    try { localStorage.setItem('atelier.dt.heatmap', nv ? '1' : '0') } catch { /* noop */ }
    return nv
  })

  const breakdownFields = useMemo(
    () => (breakdown && breakdown !== 'none') ? breakdown.split(',') : [],
    [breakdown]
  )

  const visibleDefs = useMemo(
    () => metrics.map(k => metricDefs.find(m => m.key === k)).filter(Boolean) as MetricDef[],
    [metrics, metricDefs]
  )

  const rowBdKey = (r: any) => breakdownFields.map(f => r[f] ?? '').join('|')

  // Apply group-by before the normal sort path. When grouping, rows collapse
  // to one-per-unique-value and the date column header becomes the groupBy label.
  const grouped = useMemo(() => applyGroupBy(rows, groupBy, metrics), [rows, groupBy, metrics])
  const effectiveRows = grouped.rows
  const effectiveCompareRows = useMemo(
    () => applyGroupBy(compareRows || [], groupBy, metrics).rows,
    [compareRows, groupBy, metrics]
  )

  const sortedRows = useMemo(() => {
    const sorted = [...effectiveRows].sort((a, b) => {
      // Always sort by date first (respects direction), then by breakdown values
      // so rows for the same day stay grouped together.
      if (sortKey === 'date') {
        const d = sortDir === 'asc' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)
        if (d !== 0) return d
      } else {
        const av = a[sortKey] ?? 0
        const bv = b[sortKey] ?? 0
        const d = typeof av === 'string'
          ? (sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av))
          : (sortDir === 'asc' ? av - bv : bv - av)
        if (d !== 0) return d
      }
      for (const f of breakdownFields) {
        const af = String(a[f] ?? ''), bf = String(b[f] ?? '')
        if (af !== bf) return af.localeCompare(bf)
      }
      return 0
    })
    return sorted
  }, [effectiveRows, sortKey, sortDir, breakdownFields])

  const totals = useMemo(() => computeTotals(rows, metrics), [rows, metrics])

  // Per-metric min/max for heatmap shading. Totals row excluded so it doesn't
  // stretch the color scale.
  const metricRanges = useMemo(() => {
    const ranges: Record<string, { min: number; max: number }> = {}
    for (const m of visibleDefs) {
      let lo = Infinity, hi = -Infinity
      for (const r of rows) {
        const v = Number(r[m.key])
        if (!isFinite(v)) continue
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      if (isFinite(lo) && isFinite(hi)) ranges[m.key] = { min: lo, max: hi }
    }
    return ranges
  }, [rows, visibleDefs])

  const heatmapStyle = (key: string, v: any): React.CSSProperties => {
    if (!heatmap) return {}
    const n = Number(v)
    if (!isFinite(n)) return {}
    const r = metricRanges[key]
    if (!r || r.max === r.min) return {}
    let frac = (n - r.min) / (r.max - r.min)  // 0..1 where 1 = best
    if (LOWER_IS_BETTER.has(key)) frac = 1 - frac
    // Pure white at worst → light green at best (no fill on worst values).
    const alpha = (frac * 0.45).toFixed(3)
    return { backgroundColor: `rgba(134, 239, 172, ${alpha})` }
  }
  const compareTotals = useMemo(
    () => compareRows && compareRows.length ? computeTotals(compareRows, metrics) : null,
    [compareRows, metrics]
  )

  // Match compare rows to current rows by (breakdown-combo, chronological
  // position within that combo). Within each breakdown subset, rows[i] (asc by
  // date) pairs with compare[i]. same day-offset within each range. When
  // there's no breakdown, there's one subset keyed "".
  const compareByKey = useMemo(() => {
    if (!compareRows || !compareRows.length) return null
    // In grouped mode, pair by the group value (e.g. "UGC" current → "UGC"
    // prior period). In normal mode, pair by breakdown-combo + date position.
    if (grouped.groupField) {
      const map = new Map<string, any>()
      for (const c of effectiveCompareRows) {
        const v = String(c[grouped.groupField] ?? '')
        if (v) map.set(`||${v}`, c)
      }
      return map
    }
    const group = (arr: any[]) => {
      const m = new Map<string, any[]>()
      for (const r of arr) {
        const k = breakdownFields.map(f => r[f] ?? '').join('|')
        if (!m.has(k)) m.set(k, [])
        m.get(k)!.push(r)
      }
      for (const list of m.values()) list.sort((a, b) => a.date.localeCompare(b.date))
      return m
    }
    const currG = group(rows)
    const cmpG = group(compareRows)
    const map = new Map<string, any>()
    for (const [bdKey, list] of currG) {
      const cmpList = cmpG.get(bdKey) || []
      for (let i = 0; i < list.length; i++) {
        if (cmpList[i]) map.set(`${bdKey}||${list[i].date}`, cmpList[i])
      }
    }
    return map
  }, [rows, compareRows, breakdownFields, grouped.groupField, effectiveCompareRows])

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  if (!rows.length) {
    return (
      <div className="glass rounded-2xl p-10 text-center text-text-muted text-sm">
        No data for this period
      </div>
    )
  }

  return (
    <div className="glass rounded-2xl overflow-hidden">
      {/* Tiny toolbar. heatmap toggle, etc. */}
      <div className="flex items-center justify-end px-3 py-1.5 border-b border-black/[0.04]">
        <button
          onClick={toggleHeatmap}
          title={heatmap ? 'Heatmap on. click to turn off' : 'Click to grade metrics by performance'}
          className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
            heatmap ? 'bg-emerald-100 text-emerald-700' : 'bg-black/[0.04] text-text-muted hover:text-text-secondary'
          }`}
        >
          {heatmap ? 'Heatmap ●' : 'Heatmap'}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/[0.06]">
              <th
                onClick={() => handleSort('date')}
                className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-text-muted cursor-pointer hover:text-text-primary transition-colors"
              >
                <div className="flex items-center gap-1">
                  {grouped.groupField
                    ? (BREAKDOWN_LABELS[grouped.groupField] || grouped.groupField.replace(/_/g, ' '))
                    : (granularity === 'day' ? 'Date' : granularity.charAt(0).toUpperCase() + granularity.slice(1))}
                  {sortKey === 'date' && (sortDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                </div>
              </th>
              {breakdownFields.map(f => (
                <th key={f} className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-text-muted">
                  {BREAKDOWN_LABELS[f] || f.replace(/_/g, ' ')}
                </th>
              ))}
              {visibleDefs.map(m => (
                <th
                  key={m.key}
                  onClick={() => handleSort(m.key)}
                  className="px-4 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-text-muted cursor-pointer hover:text-text-primary transition-colors"
                >
                  <div className="flex items-center justify-end gap-1">
                    {m.label}
                    {sortKey === m.key && (sortDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Totals row */}
            <tr className="border-b border-black/[0.08] bg-black/[0.02] font-medium">
              <td className="px-4 py-2.5 text-text-primary text-xs align-top">
                Total
              </td>
              {breakdownFields.map(f => <td key={f} className="px-4 py-2.5" />)}
              {visibleDefs.map(m => (
                <td key={m.key} className="px-4 py-2.5 text-right text-text-primary tabular-nums text-xs align-top">
                  <div>{formatValue(totals[m.key], m.format)}</div>
                  {compareTotals && (
                    <CompareLine
                      curr={totals[m.key]} prev={compareTotals[m.key]}
                      format={m.format} metricKey={m.key} mode={compareDisplay}
                    />
                  )}
                </td>
              ))}
            </tr>

            {/* Data rows */}
            {sortedRows.map((row, i) => {
              const cmp = grouped.groupField
                ? compareByKey?.get(`||${String(row[grouped.groupField] ?? '')}`)
                : compareByKey?.get(`${rowBdKey(row)}||${row.date}`)
              return (
                <tr
                  key={i}
                  className="border-b border-black/[0.04] hover:bg-white/40 transition-colors"
                >
                  <td className="px-4 py-2.5 text-text-secondary text-xs whitespace-nowrap align-top">
                    {grouped.groupField ? String(row[grouped.groupField] ?? row.date) : formatDateLabel(row.date, granularity)}
                  </td>
                  {breakdownFields.map(f => (
                    <td key={f} className="px-4 py-2.5 text-text-secondary text-xs whitespace-nowrap align-top capitalize">
                      {row[f] ?? '-'}
                    </td>
                  ))}
                  {visibleDefs.map(m => (
                    <td key={m.key} style={heatmapStyle(m.key, row[m.key])}
                      className="px-4 py-2.5 text-right text-text-primary tabular-nums text-xs align-top">
                      <div>{formatValue(row[m.key], m.format)}</div>
                      {cmp && (
                        <CompareLine
                          curr={row[m.key]} prev={cmp[m.key]}
                          format={m.format} metricKey={m.key} mode={compareDisplay}
                        />
                      )}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
