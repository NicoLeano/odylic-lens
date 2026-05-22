import { useMemo } from 'react'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'

type MetricDef = { key: string; label: string; format: string }

interface Props {
  rows: any[]
  compareRows?: any[]
  metricDefs: MetricDef[]
  type: 'bar' | 'line'
  xAxis: string
  yPrimary: string[]
  ySecondary: string[]
  stacked: boolean
  breakdown?: string
  showTrend?: boolean
  showMA?: boolean
  showAvg?: boolean
  maWindow?: number
}

const COLORS = [
  '#B7410E', '#2563eb', '#059669', '#dc2626', '#7c3aed',
  '#0891b2', '#ca8a04', '#be185d', '#0d9488', '#4b5563',
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fmtValue(value: any, def?: MetricDef) {
  const n = Number(value)
  if (isNaN(n)) return value
  if (!def) return n.toLocaleString()
  if (def.format === 'dollar') {
    return n >= 1000
      ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : `$${n.toFixed(2)}`
  }
  if (def.format === 'percent') return `${n.toFixed(2)}%`
  if (def.format === 'decimal') return n.toFixed(2)
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

export function ChartView({
  rows, compareRows, metricDefs, type, xAxis, yPrimary, ySecondary, stacked,
  showTrend = false, showMA = false, showAvg = false, maWindow = 7,
}: Props) {
  const defsMap = useMemo(
    () => Object.fromEntries(metricDefs.map(d => [d.key, d])) as Record<string, MetricDef>,
    [metricDefs]
  )

  const allKeys = useMemo(() => [...yPrimary, ...ySecondary], [yPrimary, ySecondary])
  const hasCompare = !!(compareRows && compareRows.length)

  // Aggregate rows by xAxis value. sum numeric metrics across duplicates
  // (e.g. breakdown-split rows on the same date). Derived rates are not
  // recalculated here; if the user picks a rate metric, they get the arithmetic
  // sum, which is wrong for rates but matches the table's per-row behavior.
  const aggregate = (src: any[]) => {
    const byX: Record<string, any> = {}
    for (const r of src) {
      const x = r[xAxis] ?? ''
      if (!byX[x]) byX[x] = { [xAxis]: x }
      for (const k of allKeys) {
        const v = Number(r[k])
        if (!isNaN(v)) byX[x][k] = (byX[x][k] ?? 0) + v
      }
    }
    return Object.values(byX).sort((a: any, b: any) =>
      String(a[xAxis]).localeCompare(String(b[xAxis]))
    )
  }

  const data = useMemo(() => {
    const curr = aggregate(rows)
    let merged: any[] = curr
    if (hasCompare) {
      const cmp = aggregate(compareRows!)
      // xAxis='date' → curr[i] pairs with cmp[i]. For non-date xAxis, match on
      // x value (same categories across both ranges).
      if (xAxis === 'date') {
        merged = curr.map((row: any, i: number) => {
          const cmpRow = cmp[i]
          if (!cmpRow) return row
          const out: any = { ...row, _prevX: cmpRow[xAxis] }
          for (const k of allKeys) out[`${k}__prev`] = cmpRow[k]
          return out
        })
      } else {
        const cmpMap = new Map(cmp.map((r: any) => [r[xAxis], r]))
        merged = curr.map((row: any) => {
          const cmpRow = cmpMap.get(row[xAxis])
          if (!cmpRow) return row
          const out: any = { ...row }
          for (const k of allKeys) out[`${k}__prev`] = cmpRow[k]
          return out
        })
      }
    }

    // Trend (linear least-squares) and moving average are only meaningful for
    // ordered x (date). For categorical breakdown x, skip.
    if ((showTrend || showMA) && xAxis === 'date' && merged.length > 1) {
      for (const k of allKeys) {
        const ys = merged.map(r => Number(r[k]) || 0)
        const n = ys.length
        if (showTrend) {
          // slope, intercept via least squares
          let sx = 0, sy = 0, sxy = 0, sxx = 0
          for (let i = 0; i < n; i++) {
            sx += i; sy += ys[i]; sxy += i * ys[i]; sxx += i * i
          }
          const denom = n * sxx - sx * sx
          const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0
          const intercept = (sy - slope * sx) / n
          for (let i = 0; i < n; i++) merged[i][`${k}__trend`] = slope * i + intercept
        }
        if (showMA) {
          const w = Math.max(2, maWindow)
          for (let i = 0; i < n; i++) {
            const lo = Math.max(0, i - w + 1)
            let sum = 0, count = 0
            for (let j = lo; j <= i; j++) { sum += ys[j]; count++ }
            merged[i][`${k}__ma`] = count > 0 ? sum / count : 0
          }
        }
      }
    }

    return merged
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, compareRows, xAxis, yPrimary, ySecondary, hasCompare, showTrend, showMA, maWindow])

  // Averages per metric. used for horizontal reference lines.
  const averages = useMemo(() => {
    const out: Record<string, number> = {}
    for (const k of allKeys) {
      let sum = 0, count = 0
      for (const r of data) {
        const v = Number(r[k])
        if (!isNaN(v)) { sum += v; count++ }
      }
      out[k] = count > 0 ? sum / count : 0
    }
    return out
  }, [data, allKeys])

  const xLabel = (v: any) => {
    if (xAxis === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const d = new Date(v + 'T00:00:00')
      return `${MONTHS[d.getMonth()]} ${d.getDate()}`
    }
    return String(v)
  }

  if (!rows.length) {
    return <div className="glass rounded-2xl p-10 text-center text-text-muted text-sm">No data for this period</div>
  }
  if (!yPrimary.length && !ySecondary.length) {
    return <div className="glass rounded-2xl p-10 text-center text-text-muted text-sm">Pick at least one Y-axis metric</div>
  }

  const ChartRoot: any = type === 'bar' ? BarChart : LineChart
  const Series: any = type === 'bar' ? Bar : Line

  return (
    <div className="atelier-tile" style={{ height: 420 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ChartRoot data={data} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
          <XAxis dataKey={xAxis} tickFormatter={xLabel} tick={{ fontSize: 10, fill: '#6b7280' }} />
          <YAxis yAxisId="left" tick={{ fontSize: 10, fill: '#6b7280' }}
            tickFormatter={(v) => fmtValue(v, defsMap[yPrimary[0]])} />
          {ySecondary.length > 0 && (
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: '#6b7280' }}
              tickFormatter={(v) => fmtValue(v, defsMap[ySecondary[0]])} />
          )}
          <Tooltip
            labelFormatter={xLabel}
            formatter={(value: any, name: any) => {
              const n = String(name ?? '')
              const def = metricDefs.find(d => d.label === n || d.key === n)
              return [fmtValue(value, def), n]
            }}
            contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)' }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {yPrimary.flatMap((k, i) => {
            const color = COLORS[i % COLORS.length]
            const curr = (
              <Series key={`p-${k}`} yAxisId="left" dataKey={k} name={defsMap[k]?.label || k}
                fill={color} stroke={color}
                stackId={stacked && type === 'bar' ? 'primary' : undefined}
                dot={false} strokeWidth={2} />
            )
            if (!hasCompare) return [curr]
            const prev = (
              <Series key={`p-${k}-prev`} yAxisId="left" dataKey={`${k}__prev`}
                name={`${defsMap[k]?.label || k} (prev)`}
                fill={color} stroke={color} fillOpacity={type === 'bar' ? 0.35 : 1}
                stackId={stacked && type === 'bar' ? 'primary-prev' : undefined}
                dot={false} strokeWidth={1.5}
                strokeDasharray={type === 'line' ? '4 3' : undefined}
                strokeOpacity={type === 'line' ? 0.6 : 1} />
            )
            return [curr, prev]
          })}
          {ySecondary.flatMap((k, i) => {
            const color = COLORS[(i + yPrimary.length) % COLORS.length]
            const curr = (
              <Series key={`s-${k}`} yAxisId="right" dataKey={k} name={defsMap[k]?.label || k}
                fill={color} stroke={color}
                stackId={stacked && type === 'bar' ? 'secondary' : undefined}
                dot={false} strokeWidth={2}
                strokeDasharray={type === 'line' ? '4 3' : undefined} />
            )
            if (!hasCompare) return [curr]
            const prev = (
              <Series key={`s-${k}-prev`} yAxisId="right" dataKey={`${k}__prev`}
                name={`${defsMap[k]?.label || k} (prev)`}
                fill={color} stroke={color} fillOpacity={type === 'bar' ? 0.35 : 1}
                stackId={stacked && type === 'bar' ? 'secondary-prev' : undefined}
                dot={false} strokeWidth={1.5}
                strokeDasharray={type === 'line' ? '2 2' : undefined}
                strokeOpacity={type === 'line' ? 0.5 : 1} />
            )
            return [curr, prev]
          })}

          {/* Trendlines. always rendered as lines, even on bar charts */}
          {showTrend && xAxis === 'date' && yPrimary.flatMap((k, i) => {
            const color = COLORS[i % COLORS.length]
            return [
              <Line key={`tp-${k}`} yAxisId="left" dataKey={`${k}__trend`}
                name={`${defsMap[k]?.label || k} trend`}
                stroke={color} strokeWidth={1.5} strokeDasharray="5 4"
                dot={false} legendType="none" />
            ]
          })}
          {showTrend && xAxis === 'date' && ySecondary.flatMap((k, i) => {
            const color = COLORS[(i + yPrimary.length) % COLORS.length]
            return [
              <Line key={`ts-${k}`} yAxisId="right" dataKey={`${k}__trend`}
                name={`${defsMap[k]?.label || k} trend`}
                stroke={color} strokeWidth={1.5} strokeDasharray="5 4"
                dot={false} legendType="none" />
            ]
          })}

          {/* Moving averages */}
          {showMA && xAxis === 'date' && yPrimary.flatMap((k, i) => {
            const color = COLORS[i % COLORS.length]
            return [
              <Line key={`mp-${k}`} yAxisId="left" dataKey={`${k}__ma`}
                name={`${defsMap[k]?.label || k} MA${maWindow}`}
                stroke={color} strokeWidth={1.5} strokeOpacity={0.55}
                dot={false} legendType="none" />
            ]
          })}
          {showMA && xAxis === 'date' && ySecondary.flatMap((k, i) => {
            const color = COLORS[(i + yPrimary.length) % COLORS.length]
            return [
              <Line key={`ms-${k}`} yAxisId="right" dataKey={`${k}__ma`}
                name={`${defsMap[k]?.label || k} MA${maWindow}`}
                stroke={color} strokeWidth={1.5} strokeOpacity={0.55}
                dot={false} legendType="none" />
            ]
          })}

          {/* Period average reference lines */}
          {showAvg && yPrimary.map((k, i) => (
            <ReferenceLine key={`avgp-${k}`} yAxisId="left" y={averages[k]}
              stroke={COLORS[i % COLORS.length]} strokeDasharray="3 3" strokeOpacity={0.5}
              label={{ value: `avg ${fmtValue(averages[k], defsMap[k])}`, position: 'insideTopLeft', fontSize: 9, fill: COLORS[i % COLORS.length] }} />
          ))}
          {showAvg && ySecondary.map((k, i) => (
            <ReferenceLine key={`avgs-${k}`} yAxisId="right" y={averages[k]}
              stroke={COLORS[(i + yPrimary.length) % COLORS.length]} strokeDasharray="3 3" strokeOpacity={0.5}
              label={{ value: `avg ${fmtValue(averages[k], defsMap[k])}`, position: 'insideTopRight', fontSize: 9, fill: COLORS[(i + yPrimary.length) % COLORS.length] }} />
          ))}
        </ChartRoot>
      </ResponsiveContainer>
    </div>
  )
}
