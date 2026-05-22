/**
 * Group-by (rollup) types + aggregation logic. Split from GroupBy.tsx
 * so the component file stays component-only and React Fast Refresh
 * can hot-update the GroupByPill cleanly (mixing data + components in
 * one file was killing HMR with "GROUP_BY_FIELDS export is incompatible").
 *
 * The GroupBy.tsx component re-exports everything here for back-compat
 * with `import { ..., groupAds } from './ads/GroupBy'` callers.
 */

export type GroupByKey =
  | 'none'
  | 'campaign_name'
  | 'adset_name'
  | 'ad_name'
  | 'asset_type'
  | 'planner_status'
  | 'analysis_angle'
  | 'analysis_persona'
  | 'analysis_template'
  | 'analysis_funnelPosition'
  | 'analysis_marketAwareness'
  | 'analysis_sentiment'
  | 'analysis_category'
  | 'analysis_collection'
  | 'analysis_offer'
  | 'analysis_marketingMoment'
  | 'analysis_emotion'
  // Name-convention group-bys. populated from the backend naming parser
  | 'nc_objective'
  | 'nc_format'
  | 'nc_type'
  | 'nc_funnel'
  | 'nc_persona_hint'
  | 'nc_owner'
  | 'nc_bidding'
  | 'nc_audience'
  | 'nc_concept'
  // Per-brand custom keys (`nc_custom_<slug>`) defined in the brand's
  // naming convention. Typed as a string template so the union still
  // narrows for the static keys while accepting dynamic ones at runtime.
  | (string & {})

export const GROUP_BY_FIELDS: { key: GroupByKey; label: string }[] = [
  { key: 'none', label: 'None' },
  { key: 'campaign_name', label: 'Campaign' },
  { key: 'adset_name', label: 'Ad Set' },
  { key: 'ad_name', label: 'Ad Name' },
  { key: 'asset_type', label: 'Asset Type' },
  { key: 'planner_status', label: 'Status' },
  // Name convention tokens. come from parse_ad_name / parse_adset_name
  { key: 'nc_objective', label: 'Objective (from name)' },
  { key: 'nc_format', label: 'Format (from name)' },
  { key: 'nc_type', label: 'Type (from name)' },
  { key: 'nc_funnel', label: 'Funnel (from name)' },
  { key: 'nc_persona_hint', label: 'Persona (from name)' },
  { key: 'nc_owner', label: 'Owner (from adset)' },
  { key: 'nc_bidding', label: 'Bidding (from adset)' },
  { key: 'nc_audience', label: 'Audience (from adset)' },
  { key: 'nc_concept', label: 'Concept (from name)' },
  // AI analysis group-bys
  { key: 'analysis_angle', label: 'Angle' },
  { key: 'analysis_persona', label: 'Persona' },
  { key: 'analysis_template', label: 'Template' },
  { key: 'analysis_funnelPosition', label: 'Funnel Position' },
  { key: 'analysis_marketAwareness', label: 'Market Awareness' },
  { key: 'analysis_sentiment', label: 'Sentiment' },
  { key: 'analysis_category', label: 'Category' },
  { key: 'analysis_collection', label: 'Collection' },
  { key: 'analysis_offer', label: 'Offer' },
  { key: 'analysis_marketingMoment', label: 'Moment' },
  { key: 'analysis_emotion', label: 'Emotion' },
]

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

// Metrics that sum across the group. Non-sum derived metrics recompute from
// these totals in DERIVED_METRICS below.
const SUM_METRICS = new Set<string>([
  'spend', 'impressions', 'clicks', 'reach',
  'link_clicks', 'outbound_clicks', 'unique_clicks',
  'purchases', 'revenue',
  'add_to_cart', 'add_to_cart_value',
  'initiate_checkout', 'leads', 'landing_page_views',
  'thruplays', 'video_views', 'video_3s_views', 'video_15s_views',
  'video_p25', 'video_p50', 'video_p75', 'video_p100',
  'video_30_sec_watched_actions',
  // Engagement sums
  'post_reactions', 'post_comments', 'post_shares',
  'post_engagement', 'post_saves', 'page_follows', 'see_more_clicks',
])

// Derived metrics. sum-then-divide. Matches the approach used in
// DataTable.tsx and the custom-metric compute fns in customMetrics.ts so a
// grouped ROAS equals the ROAS over the pooled spend/revenue, not an
// arithmetic mean.
const DERIVED_METRICS: Record<string, (t: Record<string, number>) => number> = {
  roas: t => t.spend > 0 ? (t.revenue || 0) / t.spend : 0,
  cpc: t => t.clicks > 0 ? t.spend / t.clicks : 0,
  cpm: t => t.impressions > 0 ? (t.spend / t.impressions) * 1000 : 0,
  ctr: t => t.impressions > 0 ? (t.clicks / t.impressions) * 100 : 0,
  frequency: t => t.reach > 0 ? t.impressions / t.reach : 0,
  cost_per_purchase: t => (t.purchases || 0) > 0 ? t.spend / t.purchases : 0,
  cpa: t => (t.purchases || 0) > 0 ? t.spend / t.purchases : 0,
  // Custom metrics. match customMetrics.ts formulas (sum-then-divide)
  hook_rate: t => {
    const v = t.video_3s_views || t.video_views || 0
    return t.impressions > 0 ? (v / t.impressions) * 100 : 0
  },
  hold_rate: t => {
    const v = t.video_3s_views || t.video_views || 0
    const tp = t.thruplays || t.video_p100 || 0
    return v > 0 ? (tp / v) * 100 : 0
  },
  conversion_rate: t => t.clicks > 0 ? ((t.purchases || 0) / t.clicks) * 100 : 0,
  video_completion_rate: t => {
    const v = t.video_3s_views || t.video_views || 0
    return v > 0 ? ((t.video_p100 || 0) / v) * 100 : 0
  },
  hook_to_hold: t => {
    const v = t.video_3s_views || t.video_views || 0
    const tp = t.thruplays || t.video_p100 || 0
    if (!v || !t.impressions) return 0
    const hook = (v / t.impressions) * 100
    const hold = (tp / v) * 100
    return hook > 0 ? hold / hook : 0
  },
  stop_rate: t => {
    const v = t.video_3s_views || t.video_views || 0
    if (!t.impressions) return 0
    const hook = (v / t.impressions) * 100
    return Math.max(0, 100 - hook)
  },
  // Motion-parity derived metrics
  ctr_link: t => t.impressions > 0 ? ((t.link_clicks || 0) / t.impressions) * 100 : 0,
  ctr_outbound: t => t.impressions > 0 ? ((t.outbound_clicks || 0) / t.impressions) * 100 : 0,
  cpc_link: t => (t.link_clicks || 0) > 0 ? t.spend / t.link_clicks : 0,
  cpc_outbound: t => (t.outbound_clicks || 0) > 0 ? t.spend / t.outbound_clicks : 0,
  follow_like_rate: t => t.impressions > 0 ? ((t.page_follows || 0) / t.impressions) * 100 : 0,
  comment_rate: t => t.impressions > 0 ? ((t.post_comments || 0) / t.impressions) * 100 : 0,
  engagement_rate: t => t.impressions > 0 ? ((t.post_engagement || 0) / t.impressions) * 100 : 0,
  psr: t => (t.post_reactions || 0) > 0 ? (t.post_shares || 0) / t.post_reactions : 0,
  see_more_rate: t => t.impressions > 0 ? ((t.see_more_clicks || 0) / t.impressions) * 100 : 0,
  first_frame_retention: t => {
    const v = t.video_views || t.video_3s_views || 0
    return t.impressions > 0 ? (v / t.impressions) * 100 : 0
  },
  sustain_rate: t => {
    const v = t.video_3s_views || t.video_views || 0
    return v > 0 ? ((t.video_p50 || 0) / v) * 100 : 0
  },
  v15_to_3s: t => {
    const v = t.video_3s_views || t.video_views || 0
    return v > 0 ? ((t.video_15s_views || 0) / v) * 100 : 0
  },
  click_quality: t => (t.link_clicks || 0) > 0 ? ((t.landing_page_views || 0) / t.link_clicks) * 100 : 0,
  click_to_atc: t => (t.link_clicks || 0) > 0 ? ((t.add_to_cart || 0) / t.link_clicks) * 100 : 0,
  click_to_leads: t => (t.link_clicks || 0) > 0 ? ((t.leads || 0) / t.link_clicks) * 100 : 0,
  click_to_purchase: t => (t.link_clicks || 0) > 0 ? ((t.purchases || 0) / t.link_clicks) * 100 : 0,
  atc_to_purchase: t => (t.add_to_cart || 0) > 0 ? ((t.purchases || 0) / t.add_to_cart) * 100 : 0,
  aov: t => (t.purchases || 0) > 0 ? (t.revenue || 0) / t.purchases : 0,
}

export type GroupedRow = {
  group_key: string              // "UGC", "Problem/Solution", "(unanalyzed)", …
  group_value: string            // same as group_key, used as the display label
  ad_count: number
  // Aggregated numeric metrics (sums + derived) plus mode-aggregated
  // text fields. Keys vary at runtime so we widen to `any` here.
  [metric: string]: any
}

// Text/analysis fields we mode-aggregate per group so the grouped
// table can still surface "what's the dominant Template / Persona /
// Angle in this adset?" Each entry produces a `<key>__mode` and a
// `<key>__variety` (distinct value count) on the GroupedRow.
const MODE_FIELDS = [
  'analysis_template',
  'analysis_funnelPosition',
  'analysis_persona',
  'analysis_sentiment',
  'analysis_marketAwareness',
  'analysis_angle',
  'analysis_category',
  'analysis_collection',
  'analysis_offer',
  'analysis_marketingMoment',
  'analysis_emotion',
  'asset_type',
  'effective_status',
  'nc_objective',
  'nc_format',
  'nc_type',
  'nc_funnel',
  'nc_persona_hint',
  'nc_owner',
  'nc_bidding',
  'nc_audience',
  'nc_concept',
]

function modeAndVariety(values: (string | undefined | null)[]): { mode: string; variety: number } {
  const counts: Record<string, number> = {}
  for (const v of values) {
    if (v == null) continue
    const s = String(v).trim()
    if (!s) continue
    counts[s] = (counts[s] || 0) + 1
  }
  const entries = Object.entries(counts)
  if (entries.length === 0) return { mode: '', variety: 0 }
  entries.sort((a, b) => b[1] - a[1])
  return { mode: entries[0][0], variety: entries.length }
}

// Group ads by a dimension key, summing raw metrics, recomputing
// derived ratios, and mode-aggregating analysis / categorical fields
// so a Campaign or Ad Set group row can still show its dominant
// Template / Persona / Angle / Status.
export function groupAds<T extends Record<string, any>>(
  ads: T[],
  groupBy: GroupByKey,
): GroupedRow[] {
  if (groupBy === 'none') return []
  const buckets: Record<string, T[]> = {}
  for (const ad of ads) {
    const raw = ad[groupBy]
    const key = (raw === undefined || raw === null || raw === '') ? '(unanalyzed)' : String(raw)
    ;(buckets[key] ||= []).push(ad)
  }
  const out: GroupedRow[] = []
  for (const [key, members] of Object.entries(buckets)) {
    const sums: Record<string, number> = {}
    for (const m of SUM_METRICS) sums[m] = 0
    for (const ad of members) {
      for (const k of SUM_METRICS) {
        const v = Number((ad as any)[k] ?? 0)
        if (!Number.isNaN(v)) sums[k] += v
      }
    }
    const row: GroupedRow = {
      group_key: key,
      group_value: key,
      ad_count: members.length,
      ...sums,
    }
    for (const [k, fn] of Object.entries(DERIVED_METRICS)) {
      row[k] = fn(sums)
    }
    for (const field of MODE_FIELDS) {
      const { mode, variety } = modeAndVariety(members.map(a => (a as any)[field]))
      row[`${field}__mode`] = mode
      row[`${field}__variety`] = variety
      row[field] = mode
    }
    out.push(row)
  }
  // Unanalyzed bucket sinks to the bottom, rest sorted by spend desc
  out.sort((a, b) => {
    if (a.group_key === '(unanalyzed)') return 1
    if (b.group_key === '(unanalyzed)') return -1
    return (b.spend || 0) - (a.spend || 0)
  })
  return out
}
