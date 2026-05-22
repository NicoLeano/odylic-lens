/**
 * Metric catalog. single source of truth for the metric picker, table
 * columns, chart axes, and grouped-table rollups.
 *
 * Lives in its own module so AdAnalysisView.tsx can stay component-only
 * and React Fast Refresh hot-updates the file cleanly. When the catalog
 * sat next to AdAnalysisView's component exports, every edit invalidated
 * Fast Refresh ("ALL_METRICS export is incompatible") and silently kept
 * stale chart code in the browser tab.
 *
 * Keys line up with `AdCreative` and with the /creative-timeseries row
 * shape so the same picker drives the table, bar chart, and line chart.
 */

export type MetricGroup =
  | 'Identity'
  | 'Performance'
  | 'Clicks'
  | 'Engagement'
  | 'Media'
  | 'Conversion funnel'
  | 'Conversions'
  | 'AI Analysis'

export type MetricDef = {
  key: string
  label: string
  // 'text' = string rendered as a colored pill (analysis-derived, not sortable numerically)
  format: 'dollar' | 'number' | 'percent' | 'decimal' | 'text'
  // true = comes from /api/ads/analysis-bulk cache, not Meta insights
  analysisField?: boolean
  // Motion-style group header in the picker
  group?: MetricGroup
  description?: string
}

// Ordered list of groups in the picker panel.
export const METRIC_GROUP_ORDER: MetricGroup[] = [
  'Identity',
  'Performance',
  'Clicks',
  'Engagement',
  'Media',
  'Conversion funnel',
  'Conversions',
  'AI Analysis',
]

export const ALL_METRICS: MetricDef[] = [
  // ----- Identity (string columns the user can toggle in the table) -----
  { key: 'campaign_name', label: 'Campaign', format: 'text', group: 'Identity' },
  { key: 'adset_name', label: 'Ad set', format: 'text', group: 'Identity' },
  { key: 'effective_status', label: 'Status', format: 'text', group: 'Identity' },
  // ----- Performance -----
  { key: 'spend', label: 'Spend', format: 'dollar', group: 'Performance' },
  { key: 'aov', label: 'AOV', format: 'dollar', group: 'Performance' },
  { key: 'roas', label: 'ROAS', format: 'decimal', group: 'Performance' },
  { key: 'impressions', label: 'Impressions', format: 'number', group: 'Performance' },
  { key: 'cpm', label: 'CPM', format: 'dollar', group: 'Performance' },
  { key: 'reach', label: 'Reach', format: 'number', group: 'Performance' },
  { key: 'frequency', label: 'Frequency', format: 'decimal', group: 'Performance' },
  { key: 'cost_per_1k_ac_reached', label: 'Cost per 1K AC Reached', format: 'dollar', group: 'Performance' },
  { key: 'revenue', label: 'Revenue', format: 'dollar', group: 'Performance' },

  // ----- Clicks -----
  { key: 'link_clicks', label: 'Link clicks', format: 'number', group: 'Clicks' },
  { key: 'outbound_clicks', label: 'Clicks (outbound)', format: 'number', group: 'Clicks' },
  { key: 'unique_outbound_clicks', label: 'Unique outbound clicks', format: 'number', group: 'Clicks' },
  { key: 'clicks', label: 'Clicks (all)', format: 'number', group: 'Clicks' },
  { key: 'ctr', label: 'CTR (all)', format: 'percent', group: 'Clicks' },
  { key: 'ctr_link', label: 'CTR (link click)', format: 'percent', group: 'Clicks' },
  { key: 'ctr_outbound', label: 'CTR (outbound)', format: 'percent', group: 'Clicks' },
  { key: 'cpc', label: 'CPC (all)', format: 'dollar', group: 'Clicks' },
  { key: 'cpc_link', label: 'CPC (link click)', format: 'dollar', group: 'Clicks' },
  { key: 'cpc_outbound', label: 'CPC (outbound)', format: 'dollar', group: 'Clicks' },
  { key: 'cost_per_unique_outbound_click', label: 'CPC (Unique Outbound)', format: 'dollar', group: 'Clicks' },

  // ----- Engagement -----
  { key: 'page_follows', label: 'Follows/Likes', format: 'number', group: 'Engagement' },
  { key: 'follow_like_rate', label: '% Follows/Likes', format: 'percent', group: 'Engagement' },
  { key: 'post_comments', label: 'Comments', format: 'number', group: 'Engagement' },
  { key: 'comment_rate', label: '% Comments', format: 'percent', group: 'Engagement' },
  { key: 'post_engagement', label: 'Post engagements', format: 'number', group: 'Engagement' },
  { key: 'engagement_rate', label: '% Engagements', format: 'percent', group: 'Engagement' },
  { key: 'post_reactions', label: 'Post reactions', format: 'number', group: 'Engagement' },
  { key: 'post_shares', label: 'Post shares', format: 'number', group: 'Engagement' },
  { key: 'psr', label: 'PSR (shares/reactions)', format: 'decimal', group: 'Engagement' },
  { key: 'see_more_clicks', label: 'See more clicks', format: 'number', group: 'Engagement' },
  { key: 'see_more_rate', label: 'See more rate', format: 'percent', group: 'Engagement' },

  // ----- Media -----
  { key: 'video_avg_time_watched', label: 'Video avg play time', format: 'decimal', group: 'Media' },
  { key: 'video_views', label: 'Video plays', format: 'number', group: 'Media' },
  { key: 'video_3s_views', label: '3s video plays', format: 'number', group: 'Media' },
  { key: 'thruplays', label: 'ThruPlays', format: 'number', group: 'Media' },
  { key: 'first_frame_retention', label: '1st Frame Retention', format: 'percent', group: 'Media' },
  { key: 'hook_rate', label: 'Thumbstop / Hook Rate', format: 'percent', group: 'Media' },
  { key: 'hold_rate', label: 'Hold Rate', format: 'percent', group: 'Media' },
  { key: 'sustain_rate', label: 'Sustain Rate', format: 'percent', group: 'Media' },
  { key: 'v15_to_3s', label: '15s/3s Video Rate', format: 'percent', group: 'Media' },
  { key: 'video_completion_rate', label: 'Video Completion Rate', format: 'percent', group: 'Media' },
  { key: 'video_p25', label: 'Video 25%', format: 'number', group: 'Media' },
  { key: 'video_p50', label: 'Video 50%', format: 'number', group: 'Media' },
  { key: 'video_p75', label: 'Video 75%', format: 'number', group: 'Media' },
  { key: 'video_p100', label: 'Video 100%', format: 'number', group: 'Media' },
  { key: 'hook_to_hold', label: 'Hook-to-Hold Ratio', format: 'decimal', group: 'Media' },
  { key: 'stop_rate', label: 'Stop Rate', format: 'percent', group: 'Media' },

  // ----- Conversion funnel -----
  { key: 'click_quality', label: 'Click quality', format: 'percent', group: 'Conversion funnel' },
  { key: 'click_to_atc', label: 'Click → ATC', format: 'percent', group: 'Conversion funnel' },
  { key: 'click_to_leads', label: 'Click → Leads', format: 'percent', group: 'Conversion funnel' },
  { key: 'click_to_purchase', label: 'Click → Purchase', format: 'percent', group: 'Conversion funnel' },
  { key: 'atc_to_purchase', label: 'ATC → Purchase', format: 'percent', group: 'Conversion funnel' },
  { key: 'conversion_rate', label: 'Conversion Rate', format: 'percent', group: 'Conversion funnel' },

  // ----- Conversions -----
  { key: 'purchases', label: 'Purchases', format: 'number', group: 'Conversions' },
  { key: 'cpa', label: 'CPA', format: 'dollar', group: 'Conversions' },
  { key: 'cost_per_purchase', label: 'CPA (Meta)', format: 'dollar', group: 'Conversions' },
  { key: 'add_to_cart', label: 'ATC', format: 'number', group: 'Conversions' },
  { key: 'cost_per_atc', label: 'Cost per ATC', format: 'dollar', group: 'Conversions' },
  { key: 'add_to_cart_value', label: 'ATC Value', format: 'dollar', group: 'Conversions' },
  { key: 'landing_page_views', label: 'Landing page views', format: 'number', group: 'Conversions' },
  { key: 'initiate_checkout', label: 'Initiate checkout', format: 'number', group: 'Conversions' },
  { key: 'leads', label: 'Leads', format: 'number', group: 'Conversions' },

  // ----- AI Analysis columns (populated from the analysis cache when available) -----
  { key: 'analysis_creativeClarityScore', label: 'Clarity', format: 'number', analysisField: true, group: 'AI Analysis' },
  { key: 'analysis_visualDiffScore', label: 'Visual Differentiation', format: 'number', analysisField: true, group: 'AI Analysis' },
  { key: 'analysis_messagingDiffScore', label: 'Messaging Differentiation', format: 'number', analysisField: true, group: 'AI Analysis' },
  { key: 'analysis_template', label: 'Template', format: 'text', analysisField: true, group: 'AI Analysis' },
  { key: 'analysis_funnelPosition', label: 'Funnel', format: 'text', analysisField: true, group: 'AI Analysis' },
  { key: 'analysis_persona', label: 'Persona', format: 'text', analysisField: true, group: 'AI Analysis' },
  { key: 'analysis_sentiment', label: 'Sentiment', format: 'text', analysisField: true, group: 'AI Analysis' },
  { key: 'sentiment_score', label: 'Sentiment score', format: 'decimal', group: 'AI Analysis',
    description: 'AI sentiment mapped to numeric: positive ≈ +0.6, neutral 0, negative ≈ −0.6' },
]

// De-duplicate metrics by key. The picker renders each metric exactly once,
// but `revenue` appears under both Performance and Conversions in Motion's
// grouping. keep the first occurrence only for picker/table lookup.
export const METRICS_BY_KEY: Record<string, MetricDef> = (() => {
  const m: Record<string, MetricDef> = {}
  for (const def of ALL_METRICS) if (!m[String(def.key)]) m[String(def.key)] = def
  return m
})()
