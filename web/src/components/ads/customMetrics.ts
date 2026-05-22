// Pre-computed "custom metrics" à la Motion / Atria. Pure functions so they
// can be consumed by the table, chart, and filter builder from one place.
//
// Design: every custom metric has a `key` the row-merger will attach to each
// ad row (as a plain number), a display label, a formatter hint, and a
// `compute` that takes the raw AdCreative-shaped row and returns a number or
// undefined. When inputs are missing we return undefined. the UI renders
// '-' and the filter builder treats the row as "doesn't match" for that
// predicate. This keeps noisy data from silently producing 0% hook rates.

// We avoid importing the full AdCreative type to keep this file dependency
// free. the row shape we need is a loose map.
export type AdRow = {
  ad_id: string
  ad_name?: string
  adset_name?: string
  campaign_name?: string
  video_id?: string | null
  is_video?: boolean
  spend?: number
  impressions?: number
  clicks?: number
  ctr?: number
  cpm?: number
  cpc?: number
  reach?: number
  frequency?: number
  purchases?: number
  revenue?: number
  roas?: number
  link_clicks?: number
  outbound_clicks?: number
  add_to_cart?: number
  add_to_cart_value?: number
  initiate_checkout?: number
  leads?: number
  landing_page_views?: number
  thruplays?: number
  video_3s_views?: number
  video_views?: number
  video_15s_views?: number
  video_avg_time_watched?: number
  video_p25?: number
  video_p50?: number
  video_p75?: number
  video_p100?: number
  cost_per_purchase?: number
  // Engagement counters (Motion parity)
  post_reactions?: number
  post_comments?: number
  post_shares?: number
  post_engagement?: number
  post_saves?: number
  page_follows?: number
  see_more_clicks?: number
  // Raw Meta video_30_sec_watched_actions surfaced through the insights call
  video_30_sec_watched_actions?: Array<{ action_type: string; value: string | number }> | number
  // Meta fields added for agency-level creative analysis
  cpp?: number                     // Cost per 1k AC Reached (Meta native)
  unique_outbound_clicks?: number  // Unique outbound clicks (de-duped)
  // Planner status attached after bulk lookup
  planner_status?: string
  // Asset type derived. Image | Video | Carousel
  asset_type?: string
  [k: string]: any
}

export type CustomMetricDef = {
  key: string
  label: string
  format: 'percent' | 'dollar' | 'decimal' | 'number'
  compute: (row: AdRow) => number | undefined
  // Tooltip explaining the derivation, shown in the Metrics picker
  description?: string
  // Motion-style grouping for the picker panel. Every metric falls under one.
  group?:
    | 'Performance'
    | 'Clicks'
    | 'Engagement'
    | 'Media'
    | 'Conversion funnel'
    | 'Conversions'
}

// Try multiple field aliases. different pipelines hydrate different names.
function firstNum(...vs: Array<number | string | undefined | null>): number | undefined {
  for (const v of vs) {
    if (v === null || v === undefined || v === '') continue
    const n = Number(v)
    if (!Number.isNaN(n)) return n
  }
  return undefined
}

// "3-second video views". Meta's closest proxy for a hook. Tries the
// dedicated field first, falls back to the generic video_views.
function videoViews(r: AdRow): number | undefined {
  const direct = firstNum(r.video_3s_views, r.video_views)
  if (direct !== undefined) return direct
  // Meta returns video_30_sec_watched_actions as an action-style array; if
  // the backend left it raw, pull the first bucket.
  const arr = r.video_30_sec_watched_actions
  if (Array.isArray(arr) && arr.length) {
    const first = arr[0]
    return firstNum(first?.value)
  }
  return undefined
}

function thruplays(r: AdRow): number | undefined {
  return firstNum(r.thruplays, r.video_p100)
}

// Safe ratio helper. returns undefined when either side is missing or the
// divisor is zero. Output is multiplied by 100 when `asPercent`.
function ratio(
  num: number | undefined,
  den: number | undefined,
  asPercent = true,
): number | undefined {
  if (num === undefined || den === undefined) return undefined
  if (!den) return undefined
  const r = num / den
  return asPercent ? r * 100 : r
}

export const CUSTOM_METRICS: CustomMetricDef[] = [
  // ----- Clicks / CTR derivatives ------------------------------------------
  {
    key: 'ctr_link',
    label: 'CTR (link click)',
    format: 'percent',
    group: 'Clicks',
    description: 'Link clicks / impressions × 100',
    compute: (r) => ratio(firstNum(r.link_clicks), firstNum(r.impressions)),
  },
  {
    key: 'ctr_outbound',
    label: 'CTR (outbound)',
    format: 'percent',
    group: 'Clicks',
    description: 'Outbound clicks / impressions × 100',
    compute: (r) => ratio(firstNum(r.outbound_clicks), firstNum(r.impressions)),
  },
  {
    key: 'cpc_link',
    label: 'CPC (link click)',
    format: 'dollar',
    group: 'Clicks',
    description: 'Spend / link clicks',
    compute: (r) => ratio(firstNum(r.spend), firstNum(r.link_clicks), false),
  },
  {
    key: 'cpc_outbound',
    label: 'CPC (outbound)',
    format: 'dollar',
    group: 'Clicks',
    description: 'Spend / outbound clicks',
    compute: (r) => ratio(firstNum(r.spend), firstNum(r.outbound_clicks), false),
  },

  // ----- Engagement --------------------------------------------------------
  {
    key: 'follow_like_rate',
    label: '% Follows/Likes',
    format: 'percent',
    group: 'Engagement',
    description: 'Page follows/likes / impressions × 100',
    compute: (r) => ratio(firstNum(r.page_follows), firstNum(r.impressions)),
  },
  {
    key: 'comment_rate',
    label: '% Comments',
    format: 'percent',
    group: 'Engagement',
    description: 'Post comments / impressions × 100',
    compute: (r) => ratio(firstNum(r.post_comments), firstNum(r.impressions)),
  },
  {
    key: 'engagement_rate',
    label: '% Engagements',
    format: 'percent',
    group: 'Engagement',
    description: 'Post engagements / impressions × 100',
    compute: (r) => ratio(firstNum(r.post_engagement), firstNum(r.impressions)),
  },
  {
    key: 'psr',
    label: 'PSR (shares / reactions)',
    format: 'decimal',
    group: 'Engagement',
    description: 'Post shares / post reactions. higher = more viral',
    compute: (r) => ratio(firstNum(r.post_shares), firstNum(r.post_reactions), false),
  },
  {
    key: 'see_more_rate',
    label: 'See more rate',
    format: 'percent',
    group: 'Engagement',
    description: 'See more clicks / impressions × 100',
    compute: (r) => ratio(firstNum(r.see_more_clicks), firstNum(r.impressions)),
  },

  // ----- Media / video -----------------------------------------------------
  {
    key: 'hook_rate',
    label: 'Hook Rate (3s/imp)',
    format: 'percent',
    group: 'Media',
    description: '3-sec video views / impressions × 100',
    compute: (r) => ratio(videoViews(r), firstNum(r.impressions)),
  },
  {
    key: 'hold_rate',
    label: 'Hold Rate (TP/3s)',
    format: 'percent',
    group: 'Media',
    description: 'Thruplays / 3-sec views × 100',
    compute: (r) => ratio(thruplays(r), videoViews(r)),
  },
  {
    key: 'first_frame_retention',
    label: '1st Frame Retention',
    format: 'percent',
    group: 'Media',
    description: 'Video plays / impressions × 100. how many saw the first frame',
    compute: (r) => {
      const v = firstNum(r.video_views, r.video_3s_views)
      return ratio(v, firstNum(r.impressions))
    },
  },
  {
    key: 'sustain_rate',
    label: 'Sustain Rate (50%/3s)',
    format: 'percent',
    group: 'Media',
    description: 'Video 50% / 3-sec views × 100',
    compute: (r) => ratio(firstNum(r.video_p50), videoViews(r)),
  },
  {
    key: 'video_completion_rate',
    label: 'Video Completion Rate',
    format: 'percent',
    group: 'Media',
    description: 'Video 100% / 3-sec views × 100',
    compute: (r) => ratio(firstNum(r.video_p100), videoViews(r)),
  },
  {
    key: 'v15_to_3s',
    label: '15s/3s Video Rate',
    format: 'percent',
    group: 'Media',
    description: '15s plays / 3-sec views × 100',
    compute: (r) => ratio(firstNum(r.video_15s_views), videoViews(r)),
  },
  {
    key: 'hook_to_hold',
    label: 'Hook-to-Hold Ratio',
    format: 'decimal',
    group: 'Media',
    description: 'Hold rate / hook rate',
    compute: (r) => {
      const v = videoViews(r)
      const imp = firstNum(r.impressions)
      const t = thruplays(r)
      if (!v || !imp || t === undefined) return undefined
      const hook = (v / imp) * 100
      const hold = (t / v) * 100
      if (!hook) return undefined
      return hold / hook
    },
  },
  {
    key: 'stop_rate',
    label: 'Stop Rate',
    format: 'percent',
    group: 'Media',
    description: 'Inverse of hook rate (100 − hook)',
    compute: (r) => {
      const v = videoViews(r)
      const imp = firstNum(r.impressions)
      if (v === undefined || !imp) return undefined
      const hook = (v / imp) * 100
      return Math.max(0, 100 - hook)
    },
  },

  // ----- Conversion funnel -------------------------------------------------
  {
    key: 'click_quality',
    label: 'Click quality',
    format: 'percent',
    group: 'Conversion funnel',
    description: 'Landing page views / link clicks × 100',
    compute: (r) => ratio(firstNum(r.landing_page_views), firstNum(r.link_clicks)),
  },
  {
    key: 'click_to_atc',
    label: 'Click → ATC',
    format: 'percent',
    group: 'Conversion funnel',
    description: 'Add to cart / link clicks × 100',
    compute: (r) => ratio(firstNum(r.add_to_cart), firstNum(r.link_clicks)),
  },
  {
    key: 'click_to_leads',
    label: 'Click → Leads',
    format: 'percent',
    group: 'Conversion funnel',
    description: 'Leads / link clicks × 100',
    compute: (r) => ratio(firstNum(r.leads), firstNum(r.link_clicks)),
  },
  {
    key: 'click_to_purchase',
    label: 'Click → Purchase',
    format: 'percent',
    group: 'Conversion funnel',
    description: 'Purchases / link clicks × 100',
    compute: (r) => ratio(firstNum(r.purchases), firstNum(r.link_clicks)),
  },
  {
    key: 'atc_to_purchase',
    label: 'ATC → Purchase',
    format: 'percent',
    group: 'Conversion funnel',
    description: 'Purchases / add to cart × 100',
    compute: (r) => ratio(firstNum(r.purchases), firstNum(r.add_to_cart)),
  },
  {
    key: 'conversion_rate',
    label: 'Conversion Rate',
    format: 'percent',
    group: 'Conversion funnel',
    description: 'Purchases / clicks × 100',
    compute: (r) => ratio(firstNum(r.purchases), firstNum(r.clicks)),
  },

  // ----- Conversions / performance -----------------------------------------
  {
    key: 'aov',
    label: 'AOV',
    format: 'dollar',
    group: 'Performance',
    description: 'Revenue / purchases',
    compute: (r) => ratio(firstNum(r.revenue), firstNum(r.purchases), false),
  },
  {
    key: 'cpa',
    label: 'CPA',
    format: 'dollar',
    group: 'Conversions',
    description: 'Spend / purchases (prefers Meta cost_per_purchase when present)',
    compute: (r) => {
      // Prefer Meta's cost_per_purchase if present for parity with Ads Manager
      const cp = firstNum(r.cost_per_purchase)
      if (cp !== undefined && cp > 0) return cp
      return ratio(firstNum(r.spend), firstNum(r.purchases), false)
    },
  },
  {
    key: 'cost_per_atc',
    label: 'Cost per ATC',
    format: 'dollar',
    group: 'Conversions',
    description: 'Spend / add to cart',
    compute: (r) => ratio(firstNum(r.spend), firstNum(r.add_to_cart), false),
  },
  {
    key: 'cost_per_1k_ac_reached',
    label: 'Cost per 1K AC Reached',
    format: 'dollar',
    group: 'Performance',
    description: 'Spend / (reach / 1000). prefers Meta cpp when present',
    compute: (r) => {
      // Prefer Meta's native cpp if populated for Ads Manager parity
      const metaCpp = firstNum(r.cpp)
      if (metaCpp !== undefined && metaCpp > 0) return metaCpp
      const spend = firstNum(r.spend)
      const reach = firstNum(r.reach)
      if (spend === undefined || reach === undefined || reach <= 0) return undefined
      return spend / (reach / 1000)
    },
  },
  {
    key: 'cost_per_unique_outbound_click',
    label: 'CPC (Unique Outbound)',
    format: 'dollar',
    group: 'Clicks',
    description: 'Spend / unique outbound clicks',
    compute: (r) => ratio(firstNum(r.spend), firstNum(r.unique_outbound_clicks), false),
  },
]

// Attach all custom metrics to a row as numeric fields, so the same row can
// be sorted / filtered / charted the way base metrics are.
export function withCustomMetrics<T extends AdRow>(row: T): T {
  const out: any = { ...row }
  for (const m of CUSTOM_METRICS) {
    const v = m.compute(row)
    if (v !== undefined && !Number.isNaN(v)) out[m.key] = v
  }
  return out
}

// Derive an asset type label from the creative shape.
export function deriveAssetType(row: AdRow): 'Video' | 'Image' | 'Carousel' {
  if (row.is_video || row.video_id) return 'Video'
  // No first-class "carousel" flag from the creatives endpoint. look for
  // multi-child hints on object_story_spec when present.
  const anyRow = row as any
  const oss = anyRow.object_story_spec
  if (oss && typeof oss === 'object') {
    const link = oss.link_data || {}
    const children = link.child_attachments
    if (Array.isArray(children) && children.length > 1) return 'Carousel'
  }
  return 'Image'
}
