// =============================================================================
// DemoFunnelView. three side-by-each (vertically stacked) funnels, one per
// audience cohort, all in one shared infinite-zoom canvas.
//
// Why
// ---
// A single funnel collapses every audience into one median. But older
// audiences cost more, women cost more than men, big-city impressions
// cost more than rural. The composite freq/CPMR distance number you see
// in the base funnel can hide real per-cohort dynamics. Splitting by
// the highest-spend audiences makes the funnel position cohort-relative
// and lets the user see, e.g., "this UGC ad is BOF for 55+ women but
// TOF for 25–34 men".
//
// Data flow
// ---------
// 1. Fetch /api/ads/creatives-by-demo (cells of {ad_id, age, gender,
//    region, spend, reach, frequency, purchases, ...}).
// 2. Aggregate by (dim, key) → cohort totals + ad set.
// 3. Rank cohorts by spend × stat_sig_factor; pick top 3.
//    stat_sig_factor = purchases >= 5 ? 1 : 0.3 (penalize low-volume).
// 4. Per cohort: filter cells, compute median freq + median CPMR INSIDE
//    that cohort, bucket each cell as TOF/MOF/BOF, render a funnel.
//
// Layout
// ------
// One big pan/zoom canvas. Three funnels stacked vertically, each with
// a cohort heading and TOF/MOF/BOF sub-sections. Same widening rules:
// TOF 100% → MOF 70% → BOF 45% of the per-funnel base width.
//
// Caveat the user already flagged: this is still a proxy for true
// new vs. returning customer mix; Meta's API doesn't expose that.
// =============================================================================

import { useMemo, useRef, useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { Thumbnail, type AdCreative } from './AdAnalysisView'

interface Props {
  ads: AdCreative[]               // already-loaded creatives, used as lookup
  brand: string
  start: string
  end: string
  onOpen: (adId: string) => void
}

type Bucket = 'TOF' | 'MOF' | 'BOF'

interface Cell {
  ad_id: string
  dim: 'age_gender' | 'region'
  age: string | null
  gender: string | null
  region: string | null
  spend: number
  impressions: number
  reach: number
  frequency: number
  purchases: number
  revenue: number
  cpmr: number
}

interface Cohort {
  key: string                  // e.g. "55-64/female" or "California"
  label: string
  dim: 'age_gender' | 'region'
  spend: number
  purchases: number
  cells: Cell[]
}

interface Scored {
  ad: AdCreative
  cell: Cell
  freq: number
  cpmr: number
  score: number
  bucket: Bucket
}

const SECTION_LABEL: Record<Bucket, string> = {
  TOF: 'TOP OF FUNNEL',
  MOF: 'MIDDLE OF FUNNEL',
  BOF: 'BOTTOM OF FUNNEL',
}

const SECTION_WIDTH_PCT: Record<Bucket, number> = {
  TOF: 1.0,
  MOF: 0.7,
  BOF: 0.45,
}

const BASE_WIDTH = 1400
const CARD_W = 110
const CARD_H = 145
const CARD_GAP_X = 18
const CARD_GAP_Y = 16
const SECTION_GAP_Y = 48
const HEADING_GAP_Y = 16
const COHORT_GAP_Y = 90        // breathing room between cohort funnels
const COHORT_HEADING_GAP_Y = 28

function quantile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  const frac = idx - lo
  return sorted[lo] * (1 - frac) + sorted[hi] * frac
}

function bucketOf(score: number): Bucket {
  if (score <= -0.3) return 'TOF'
  if (score >= 0.3) return 'BOF'
  return 'MOF'
}

function cohortLabel(c: { dim: string; age: string | null; gender: string | null; region: string | null }): string {
  if (c.dim === 'age_gender') {
    const g = (c.gender || '').toLowerCase()
    const gender = g === 'female' ? 'F' : g === 'male' ? 'M' : 'U'
    return `${c.age} · ${gender}`
  }
  return c.region || 'Unknown'
}

function cohortKey(c: { dim: string; age: string | null; gender: string | null; region: string | null }): string {
  if (c.dim === 'age_gender') return `age_gender:${c.age}|${c.gender}`
  return `region:${c.region}`
}

export function DemoFunnelView({ ads, brand, start, end, onOpen }: Props) {
  const adById = useMemo(() => {
    const m = new Map<string, AdCreative>()
    for (const a of ads) m.set(a.ad_id, a)
    return m
  }, [ads])

  // Cells live in component state; refetched whenever brand/dates change.
  const [cells, setCells] = useState<Cell[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!brand || !start || !end) { setCells(null); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(
      `/api/ads/creatives-by-demo?brand=${encodeURIComponent(brand)}&start=${start}&end=${end}`,
    )
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => {
        if (cancelled) return
        if (Array.isArray(d?.cells)) setCells(d.cells)
        if (Array.isArray(d?.errors) && d.errors.length) {
          setError(d.errors.join(' · '))
        }
      })
      .catch(e => { if (!cancelled) setError(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [brand, start, end])

  // Aggregate cells into cohorts; rank by spend × stat-sig factor.
  const topCohorts: Cohort[] = useMemo(() => {
    if (!cells || !cells.length) return []
    const byKey = new Map<string, Cohort>()
    for (const c of cells) {
      const key = cohortKey(c)
      let cohort = byKey.get(key)
      if (!cohort) {
        cohort = {
          key,
          label: cohortLabel(c),
          dim: c.dim,
          spend: 0,
          purchases: 0,
          cells: [],
        }
        byKey.set(key, cohort)
      }
      cohort.spend += c.spend
      cohort.purchases += c.purchases
      cohort.cells.push(c)
    }
    // Stat-sig factor: cohorts with ≥5 purchases get full weight; below
    // that, 0.3×. they may still rank but won't displace high-confidence
    // cohorts. Tweak threshold if accounts with low-purchase signal need
    // more leeway.
    const ranked = Array.from(byKey.values()).map(c => ({
      cohort: c,
      score: c.spend * (c.purchases >= 5 ? 1 : 0.3),
    }))
    ranked.sort((a, b) => b.score - a.score)
    return ranked.slice(0, 3).map(r => r.cohort)
  }, [cells])

  // Build the bucket-grouped, scored ad set per cohort. Each cohort gets
  // its OWN median freq + median CPMR. funnel position is relative to
  // the cohort, not the account.
  type CohortSection = {
    cohort: Cohort
    medFreq: number
    medCpmr: number
    bySection: Record<Bucket, Scored[]>
  }
  const cohortSections: CohortSection[] = useMemo(() => {
    return topCohorts.map(cohort => {
      const usable = cohort.cells.filter(c =>
        c.frequency > 0 && c.cpmr > 0 && isFinite(c.cpmr) && c.spend >= 50,
      )
      if (!usable.length) {
        return {
          cohort,
          medFreq: 0,
          medCpmr: 0,
          bySection: { TOF: [], MOF: [], BOF: [] },
        }
      }
      const freqs = usable.map(c => c.frequency)
      const cpmrs = usable.map(c => c.cpmr)
      const medFreq = quantile(freqs, 0.5)
      const medCpmr = quantile(cpmrs, 0.5)
      const iqrFreq = (quantile(freqs, 0.75) - quantile(freqs, 0.25)) || 1
      const iqrCpmr = (quantile(cpmrs, 0.75) - quantile(cpmrs, 0.25)) || 1

      const scored: Scored[] = []
      for (const cell of usable) {
        const ad = adById.get(cell.ad_id)
        if (!ad) continue                // can't render without creative metadata
        const score = ((cell.frequency - medFreq) / iqrFreq + (cell.cpmr - medCpmr) / iqrCpmr) / 2
        scored.push({
          ad,
          cell,
          freq: cell.frequency,
          cpmr: cell.cpmr,
          score,
          bucket: bucketOf(score),
        })
      }
      const bySection: Record<Bucket, Scored[]> = { TOF: [], MOF: [], BOF: [] }
      for (const s of scored) bySection[s.bucket].push(s)
      for (const b of ['TOF', 'MOF', 'BOF'] as Bucket[]) {
        bySection[b].sort((a, b2) => (b2.cell.spend || 0) - (a.cell.spend || 0))
      }
      return { cohort, medFreq, medCpmr, bySection }
    })
  }, [topCohorts, adById])

  // ---------------------------------------------------------------------
  // Pan + zoom canvas. same as FunnelView. Native wheel listener so
  // Mac trackpad pinch doesn't bleed into browser page zoom.
  // ---------------------------------------------------------------------
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const stateRef = useRef({ scale, tx, ty })
  stateRef.current = { scale, tx, ty }

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const rect = wrap.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const { scale: s, tx: t, ty: ty0 } = stateRef.current
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01)
        const next = Math.max(0.2, Math.min(3, s * factor))
        setScale(next)
        setTx(cx - (cx - t) * (next / s))
        setTy(cy - (cy - ty0) * (next / s))
      } else {
        setTx(t - e.deltaX)
        setTy(ty0 - e.deltaY)
      }
    }
    wrap.addEventListener('wheel', handler, { passive: false })
    return () => { wrap.removeEventListener('wheel', handler) }
  }, [])

  const drag = useRef<{ startX: number; startY: number; tx0: number; ty0: number } | null>(null)
  const onMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-funnel-card]')) return
    drag.current = { startX: e.clientX, startY: e.clientY, tx0: tx, ty0: ty }
  }
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current
      if (!d) return
      setTx(d.tx0 + (e.clientX - d.startX))
      setTy(d.ty0 + (e.clientY - d.startY))
    }
    const up = () => { drag.current = null }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    setTx((wrap.clientWidth - BASE_WIDTH) / 2)
  }, [])

  const reset = () => {
    const wrap = wrapRef.current
    setScale(1)
    setTy(0)
    setTx(wrap ? (wrap.clientWidth - BASE_WIDTH) / 2 : 0)
  }

  // Connector layer. across each cohort's three sections. Light gray
  // bezier from each card's bottom-center to its nearest x-neighbor in
  // the next section, scoped per cohort so lines don't cross between
  // funnels.
  const canvasRef = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<string[]>([])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const compute = () => {
      const rect = canvas.getBoundingClientRect()
      const cards = Array.from(canvas.querySelectorAll<HTMLElement>('[data-funnel-card]'))
      const byCohortSection: Record<string, Record<string, { cx: number; top: number; bottom: number }[]>> = {}
      for (const c of cards) {
        const cohort = c.dataset.cohort
        const section = c.dataset.section
        if (!cohort || !section) continue
        const r = c.getBoundingClientRect()
        const node = {
          cx: (r.left + r.width / 2 - rect.left) / scale,
          top: (r.top - rect.top) / scale,
          bottom: (r.bottom - rect.top) / scale,
        }
        ;((byCohortSection[cohort] ||= {})[section] ||= []).push(node)
      }
      const out: string[] = []
      const order: Bucket[] = ['TOF', 'MOF', 'BOF']
      for (const cohort of Object.keys(byCohortSection)) {
        const sections = byCohortSection[cohort]
        for (let i = 0; i < order.length - 1; i++) {
          const a = sections[order[i]] || []
          const b = sections[order[i + 1]] || []
          if (!a.length || !b.length) continue
          for (const src of a) {
            let best = b[0]
            let bestDx = Math.abs(b[0].cx - src.cx)
            for (let j = 1; j < b.length; j++) {
              const dx = Math.abs(b[j].cx - src.cx)
              if (dx < bestDx) { best = b[j]; bestDx = dx }
            }
            const dy = (best.top - src.bottom) * 0.55
            out.push(
              `M ${src.cx} ${src.bottom} ` +
              `C ${src.cx} ${src.bottom + dy}, ${best.cx} ${best.top - dy}, ${best.cx} ${best.top}`,
            )
          }
        }
      }
      setPaths(out)
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(canvas)
    window.addEventListener('resize', compute)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', compute)
    }
  }, [cohortSections, scale, tx, ty])

  if (loading && !cells) {
    return (
      <div className="glass rounded-2xl p-10 flex items-center justify-center text-text-muted text-sm gap-2">
        <Loader2 size={14} className="animate-spin" />
        Fetching demographic breakdowns from Meta… (5–60s on first load, then cached for 1h)
      </div>
    )
  }
  if (error && !cells) {
    return (
      <div className="glass rounded-2xl p-10 text-center text-sm text-red-700/80">
        Couldn't fetch demos: {error}
      </div>
    )
  }
  if (!cohortSections.length || cohortSections.every(c => c.bySection.TOF.length + c.bySection.MOF.length + c.bySection.BOF.length === 0)) {
    return (
      <div className="glass rounded-2xl p-10 text-center text-text-muted text-sm">
        No statistically meaningful demo cohorts in this period. Try a wider date range
        or a brand with more conversion volume.
      </div>
    )
  }

  return (
    <div className="glass rounded-2xl relative overflow-hidden" style={{ height: 760 }}>
      <button
        onClick={reset}
        className="absolute top-2 right-3 z-10 px-2 py-0.5 rounded text-[10px] text-neutral-500 hover:bg-black/[0.05] font-sans"
        title="Reset view (⌘+scroll zoom, drag to pan)"
      >reset</button>

      <div
        ref={wrapRef}
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        onMouseDown={onMouseDown}
      >
        <div
          className="absolute inset-0 pointer-events-none opacity-60"
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.07) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        />

        <div
          ref={canvasRef}
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transformOrigin: '0 0',
            position: 'absolute',
            top: 32,
            left: 0,
            width: BASE_WIDTH,
            paddingBottom: 40,
          }}
        >
          <svg
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 0, left: 0,
              width: '100%',
              height: '100%',
              overflow: 'visible',
              pointerEvents: 'none',
            }}
          >
            {paths.map((d, i) => (
              <path
                key={i}
                d={d}
                fill="none"
                stroke="rgba(0,0,0,0.10)"
                strokeWidth={1}
                strokeLinecap="round"
              />
            ))}
          </svg>

          {cohortSections.map((cs, cohortIdx) => (
            <div
              key={cs.cohort.key}
              style={{
                marginTop: cohortIdx === 0 ? 0 : COHORT_GAP_Y,
                position: 'relative',
              }}
            >
              {/* Cohort heading. smaller than section headings, more emphatic */}
              <div
                className="font-sans text-center font-bold tracking-[0.12em] text-neutral-700"
                style={{ fontSize: 18, marginBottom: COHORT_HEADING_GAP_Y }}
              >
                {cs.cohort.label}
                <span className="font-normal text-neutral-400 ml-3" style={{ fontSize: 11 }}>
                  ${(cs.cohort.spend).toLocaleString('en-US', { maximumFractionDigits: 0 })} spend ·
                  {' '}{cs.cohort.purchases.toLocaleString()} purchases ·
                  {' '}med freq {cs.medFreq.toFixed(2)} · med CPMR ${cs.medCpmr.toFixed(2)}
                </span>
              </div>

              {(['TOF', 'MOF', 'BOF'] as Bucket[]).map((bucket, idx) => {
                const items = cs.bySection[bucket]
                const sectionWidth = BASE_WIDTH * SECTION_WIDTH_PCT[bucket]
                return (
                  <div
                    key={bucket}
                    style={{
                      width: sectionWidth,
                      margin: '0 auto',
                      marginTop: idx === 0 ? 0 : SECTION_GAP_Y,
                      position: 'relative',
                    }}
                  >
                    <div
                      className="font-sans text-center font-bold uppercase tracking-[0.2em] text-neutral-400"
                      style={{ fontSize: 16, marginBottom: HEADING_GAP_Y }}
                    >
                      {SECTION_LABEL[bucket]}
                    </div>
                    <div
                      className="flex flex-wrap justify-center"
                      style={{ gap: `${CARD_GAP_Y}px ${CARD_GAP_X}px` }}
                    >
                      {items.length === 0 ? (
                        <div
                          className="rounded-md border border-dashed border-black/10 flex items-center justify-center text-[10px] text-neutral-400"
                          style={{ width: CARD_W, height: CARD_H }}
                        >-</div>
                      ) : (
                        items.map(s => (
                          <DemoFunnelCard
                            key={`${cs.cohort.key}|${s.cell.ad_id}`}
                            scored={s}
                            cohort={cs.cohort.label}
                            brand={brand}
                            cohortKey={cs.cohort.key}
                            section={bucket}
                            medFreq={cs.medFreq}
                            medCpmr={cs.medCpmr}
                            onClick={() => onOpen(s.cell.ad_id)}
                          />
                        ))
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function DemoFunnelCard({
  scored, cohort, brand, cohortKey, section, medFreq, medCpmr, onClick,
}: {
  scored: Scored
  cohort: string
  brand: string
  cohortKey: string
  section: Bucket
  medFreq: number
  medCpmr: number
  onClick: () => void
}) {
  const tooltip =
    `${cohort} · ${scored.bucket} · score ${scored.score.toFixed(2)}\n` +
    `Freq ${scored.freq.toFixed(2)} (median ${medFreq.toFixed(2)})\n` +
    `CPMR $${scored.cpmr.toFixed(2)} (median $${medCpmr.toFixed(2)})\n` +
    `Spend $${scored.cell.spend.toFixed(0)} · Purchases ${scored.cell.purchases}`

  return (
    <button
      type="button"
      data-funnel-card
      data-cohort={cohortKey}
      data-section={section}
      onClick={onClick}
      title={tooltip}
      className="group relative shrink-0 rounded-md overflow-hidden bg-black/[0.04] border border-black/[0.08] hover:ring-1 hover:ring-text-primary/30 transition-shadow"
      style={{ width: CARD_W, height: CARD_H }}
    >
      <Thumbnail ad={scored.ad} brand={brand} className="absolute inset-0" />
    </button>
  )
}
