// =============================================================================
// FunnelView. Miro-style infinite-zoom canvas with creatives placed into
// TOF / MOF / BOF sections. Sections narrow top → bottom (TOF widest,
// BOF narrowest) so the silhouette reads as an actual funnel.
//
// Layout
// ------
// Canvas content has a fixed max-width (BASE_WIDTH). Within it:
//
//   ┌──────────────────────────────────────┐  100%  TOF section
//   │              TOP OF FUNNEL            │
//   │  [card] [card] [card] [card] [card]  │
//   │  [card] [card] [card] [card] [card]  │
//   ├──────────────────────────────────────┤
//   │     ┌─────────────────────────┐      │   75%  MOF section
//   │     │     MIDDLE OF FUNNEL     │     │
//   │     │  [card] [card] [card]    │     │
//   │     │  [card] [card] [card]    │     │
//   │     └─────────────────────────┘      │
//   ├──────────────────────────────────────┤
//   │       ┌──────────────────┐           │   50%  BOF section
//   │       │ BOTTOM OF FUNNEL  │          │
//   │       │  [card] [card]    │          │
//   │       └──────────────────┘           │
//   └──────────────────────────────────────┘
//
// Cards wrap inside their section's width. if BOF has more cards than
// fit in 50%, they extend down into more rows but the section width
// stays narrow, so the silhouette still funnels.
//
// Bucketing
// ---------
// freq_dev = (freq − median_freq) / iqr_freq
// cpmr_dev = (cpmr − median_cpmr) / iqr_cpmr
// score    = (freq_dev + cpmr_dev) / 2
// ≤ −0.3 → TOF, ≥ +0.3 → BOF, else MOF.
//
// Median + IQR (not mean + stddev) so log-tail outliers don't move the
// baseline. CPMR = `cost_per_1k_ac_reached` if present, else
// spend / reach × 1000.
//
// Filter: drop ads with no freq, no CPMR, or spend < $50.
// Caveat: this is a proxy for new vs. returning customer mix.
// =============================================================================

import { useMemo, useRef, useState, useEffect } from 'react'
import { Thumbnail, type AdCreative } from './AdAnalysisView'

interface Props {
  ads: AdCreative[]
  brand: string
  onOpen: (adId: string) => void
}

type Bucket = 'TOF' | 'MOF' | 'BOF'

interface Scored {
  ad: AdCreative
  cpmr: number
  freq: number
  score: number
  bucket: Bucket
  members: number   // how many ad_ids share this creative_hash
}

const SECTION_LABEL: Record<Bucket, string> = {
  TOF: 'TOP OF FUNNEL',
  MOF: 'MIDDLE OF FUNNEL',
  BOF: 'BOTTOM OF FUNNEL',
}

// Width budget per section, as a fraction of the canvas. Drives the
// funnel silhouette.
const SECTION_WIDTH_PCT: Record<Bucket, number> = {
  TOF: 1.0,
  MOF: 0.7,
  BOF: 0.45,
}

const BASE_WIDTH = 1400         // px. full TOF width on canvas
const CARD_W = 110
const CARD_H = 145
const CARD_GAP_X = 18
const CARD_GAP_Y = 16
const SECTION_GAP_Y = 56
const HEADING_GAP_Y = 18
const MIN_SPEND = 50

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

export function FunnelView({ ads, brand, onOpen }: Props) {
  const scored: Scored[] = useMemo(() => {
    // ---------------------------------------------------------------
    // Dedupe by creative_hash. Meta accounts with Dynamic Creative or
    // "Copy" ads end up with dozens of distinct ad_ids sharing a single
    // image_hash. Without deduping, the funnel shows the same thumbnail
    // 10×. visual noise. Aggregating across the group makes each card
    // represent a creative, with summed spend/impressions/reach/etc.
    // The card opens the highest-spend ad in the group on click so the
    // detail panel still has a meaningful ad_id.
    // ---------------------------------------------------------------
    type Group = {
      rep: AdCreative                 // representative ad (highest spend)
      spend: number
      impressions: number
      reach: number
      purchases: number
      revenue: number
      directCpmrSum: number           // for weighted-avg CPMR fallback
      directCpmrWeight: number
      members: number
    }
    // Content-based dedupe. strong signals only.
    //
    // Empirically: dashboard `creative_hash` is per-ad (143 unique hashes
    // for 143 Kinn ads), and `image_hash` is NULL for 95%+ of post-based
    // ads. Copy-based dedupe (title+body) over-collapses: many ads share
    // the same headline but use distinct visual creatives, so the user
    // saw a "×46 variants" card that contained ads with different images.
    //
    // The reliable signal is `image_content_sha`. backend hashes the
    // post-thumb cached bytes, so two ads showing the SAME image collapse
    // even when their story_ids and creative_hashes differ. Falls back to
    // video_id / image_hash / ad_id when content sha isn't yet populated
    // (first dashboard load before thumbs are cached).
    const dedupeKey = (ad: AdCreative): string => {
      if (ad.image_content_sha) return `s:${ad.image_content_sha}`
      if (ad.video_id) return `v:${ad.video_id}`
      if (ad.image_hash) return `h:${ad.image_hash}`
      return `a:${ad.ad_id}`
    }
    const hasResolvableImage = (ad: AdCreative): boolean => (
      !!(ad.image_hash || ad.image_url_hd || ad.image_url || ad.thumbnail_url
         || ad.video_id || ad.effective_object_story_id)
    )
    const groups = new Map<string, Group>()
    for (const ad of ads) {
      if (!hasResolvableImage(ad)) continue
      const key = dedupeKey(ad)
      if (!key) continue
      const spend = Number(ad.spend) || 0
      const impressions = Number(ad.impressions) || 0
      const reach = Number(ad.reach) || 0
      const purchases = Number(ad.purchases) || 0
      const revenue = Number(ad.revenue) || 0
      const direct = (ad as any).cost_per_1k_ac_reached
      const cpmrDirect = (typeof direct === 'number' && isFinite(direct) && direct > 0) ? direct : 0
      const existing = groups.get(key)
      if (!existing) {
        groups.set(key, {
          rep: ad,
          spend, impressions, reach, purchases, revenue,
          directCpmrSum: cpmrDirect * spend,
          directCpmrWeight: cpmrDirect > 0 ? spend : 0,
          members: 1,
        })
      } else {
        if (spend > (Number(existing.rep.spend) || 0)) existing.rep = ad
        existing.spend += spend
        existing.impressions += impressions
        existing.reach += reach
        existing.purchases += purchases
        existing.revenue += revenue
        existing.directCpmrSum += cpmrDirect * spend
        existing.directCpmrWeight += cpmrDirect > 0 ? spend : 0
        existing.members += 1
      }
    }

    // Project each group back to an AdCreative-shaped row with aggregated
    // metrics, then run the same scoring path the rest of the component
    // expects.
    const usable: { ad: AdCreative; freq: number; cpmr: number; members: number }[] = []
    for (const g of groups.values()) {
      const freq = g.reach > 0 ? g.impressions / g.reach : 0
      const cpmrFromAggregate = g.reach > 0 ? (g.spend / g.reach) * 1000 : 0
      const cpmrWeighted = g.directCpmrWeight > 0 ? g.directCpmrSum / g.directCpmrWeight : 0
      const cpmr = cpmrWeighted || cpmrFromAggregate
      if (!(freq > 0) || !(cpmr > 0) || !isFinite(cpmr)) continue
      if (g.spend < MIN_SPEND) continue
      const merged: AdCreative = {
        ...g.rep,
        spend: g.spend,
        impressions: g.impressions,
        reach: g.reach,
        purchases: g.purchases,
        revenue: g.revenue,
        frequency: freq,
        // Stamp the rolled-up CPMR so card tooltips reflect the group.
        cost_per_1k_ac_reached: cpmr,
      } as AdCreative
      usable.push({ ad: merged, freq, cpmr, members: g.members })
    }

    if (!usable.length) return []
    const freqs = usable.map(x => x.freq)
    const cpmrs = usable.map(x => x.cpmr)
    const medFreq = quantile(freqs, 0.5)
    const medCpmr = quantile(cpmrs, 0.5)
    const iqrFreq = (quantile(freqs, 0.75) - quantile(freqs, 0.25)) || 1
    const iqrCpmr = (quantile(cpmrs, 0.75) - quantile(cpmrs, 0.25)) || 1
    return usable.map(x => {
      const score = ((x.freq - medFreq) / iqrFreq + (x.cpmr - medCpmr) / iqrCpmr) / 2
      return { ad: x.ad, freq: x.freq, cpmr: x.cpmr, score, bucket: bucketOf(score), members: x.members }
    })
  }, [ads])

  const medians = useMemo(() => {
    if (!scored.length) return null
    return {
      medFreq: quantile(scored.map(s => s.freq), 0.5),
      medCpmr: quantile(scored.map(s => s.cpmr), 0.5),
    }
  }, [scored])

  // One sorted list per bucket; biggest spenders first within section.
  const bySection: Record<Bucket, Scored[]> = useMemo(() => {
    const out: Record<Bucket, Scored[]> = { TOF: [], MOF: [], BOF: [] }
    for (const s of scored) out[s.bucket].push(s)
    for (const b of ['TOF', 'MOF', 'BOF'] as Bucket[]) {
      out[b].sort((a, b2) => (b2.ad.spend || 0) - (a.ad.spend || 0))
    }
    return out
  }, [scored])

  // ---------------------------------------------------------------------
  // Pan + zoom canvas. Native wheel listener with passive:false so the
  // page doesn't zoom along on Mac trackpad pinch.
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

  // Drag-pan with mouse. but only when the click started on the empty
  // canvas, never on a card.
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

  // Auto-center the canvas content on first paint.
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

  // ---------------------------------------------------------------------
  // Section-to-section connector. ONE bezier per adjacent pair, drawn
  // from the bottom-center of section A to the top-center of section B.
  // The earlier per-card version produced visible lines passing through
  // unrelated cards inside the same section (TOF row 1 → MOF would cut
  // through TOF row 2 cards) and through transparent "No preview" tiles.
  // The funnel silhouette + section labels already communicate flow, so
  // the connector is purely decorative. one centered line is enough.
  // ---------------------------------------------------------------------
  const canvasRef = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<string[]>([])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const compute = () => {
      const rect = canvas.getBoundingClientRect()
      const cards = Array.from(canvas.querySelectorAll<HTMLElement>('[data-funnel-card]'))
      const bySectionNodes: Record<string, { cx: number; top: number; bottom: number }[]> = {}
      for (const c of cards) {
        const sec = c.dataset.section
        if (!sec) continue
        const r = c.getBoundingClientRect()
        ;(bySectionNodes[sec] ||= []).push({
          cx: (r.left + r.width / 2 - rect.left) / scale,
          top: (r.top - rect.top) / scale,
          bottom: (r.bottom - rect.top) / scale,
        })
      }
      const order: Bucket[] = ['TOF', 'MOF', 'BOF']
      const out: string[] = []
      for (let i = 0; i < order.length - 1; i++) {
        const a = bySectionNodes[order[i]] || []
        const b = bySectionNodes[order[i + 1]] || []
        if (!a.length || !b.length) continue
        // Center of each section = mean(cx). Connector spans from the
        // lowest bottom in A to the highest top in B.
        const ax = a.reduce((s, n) => s + n.cx, 0) / a.length
        const bx = b.reduce((s, n) => s + n.cx, 0) / b.length
        const ay = Math.max(...a.map(n => n.bottom))
        const by = Math.min(...b.map(n => n.top))
        const dy = (by - ay) * 0.55
        out.push(
          `M ${ax} ${ay} ` +
          `C ${ax} ${ay + dy}, ${bx} ${by - dy}, ${bx} ${by}`,
        )
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
  }, [bySection, scale, tx, ty])

  if (!scored.length) {
    return (
      <div className="glass rounded-2xl p-10 text-center text-text-muted text-sm">
        No ads with frequency + CPMR signal and ≥${MIN_SPEND} spend in this view.
        Try a wider date range.
      </div>
    )
  }

  return (
    <div className="glass rounded-2xl relative overflow-hidden" style={{ height: 720 }}>
      {/* Floating reset. top-right. Medians live in card hover tooltips. */}
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
        {/* Subtle dot grid Miro background */}
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
          {/* SVG connector layer. sits behind cards */}
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

          {(['TOF', 'MOF', 'BOF'] as Bucket[]).map((bucket, idx) => {
            const items = bySection[bucket]
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
                {/* Section heading. big, bold, centered above the cards.
                    Light neutral-400 keeps it ambient rather than shouting
                    for attention; the cards are the content. */}
                <div
                  className="font-sans text-center font-bold uppercase tracking-[0.2em] text-neutral-400"
                  style={{ fontSize: 20, marginBottom: HEADING_GAP_Y }}
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
                      <FunnelCard
                        key={s.ad.ad_id}
                        scored={s}
                        brand={brand}
                        section={bucket}
                        medians={medians}
                        onClick={() => onOpen(s.ad.ad_id)}
                      />
                    ))
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function FunnelCard({
  scored, brand, section, medians, onClick,
}: {
  scored: Scored
  brand: string
  section: Bucket
  medians: { medFreq: number; medCpmr: number } | null
  onClick: () => void
}) {
  const memberSuffix = scored.members > 1 ? ` · ${scored.members} ad variants share this creative` : ''
  const tooltip = (medians
    ? `${scored.bucket} · score ${scored.score.toFixed(2)}\nFreq ${scored.freq.toFixed(2)} (median ${medians.medFreq.toFixed(2)})\nCPMR $${scored.cpmr.toFixed(2)} (median $${medians.medCpmr.toFixed(2)})\nSpend $${(scored.ad.spend || 0).toFixed(0)}`
    : `${scored.bucket} · freq ${scored.freq.toFixed(2)} · CPMR $${scored.cpmr.toFixed(2)}`) + memberSuffix

  return (
    <button
      type="button"
      data-funnel-card
      data-section={section}
      onClick={onClick}
      title={tooltip}
      className="group relative shrink-0 rounded-md overflow-hidden bg-neutral-100 border border-black/[0.08] hover:ring-1 hover:ring-text-primary/30 transition-shadow"
      style={{ width: CARD_W, height: CARD_H }}
    >
      <Thumbnail ad={scored.ad} brand={brand} className="absolute inset-0" />
      {/* Variants badge. small chip top-left when this creative is run as
          multiple ads (Dynamic Creative + Copy patterns are common). */}
      {scored.members > 1 && (
        <div
          className="absolute top-1 left-1 rounded-full bg-black/65 text-white font-sans font-medium tabular-nums"
          style={{
            fontSize: 9,
            padding: '1px 6px',
            letterSpacing: '0.02em',
            backdropFilter: 'blur(4px)',
          }}
          aria-label={`${scored.members} ads share this creative`}
        >
          ×{scored.members}
        </div>
      )}
    </button>
  )
}
