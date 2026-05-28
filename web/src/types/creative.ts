export type Recipe = {
  recipe_id: string
  draft_id?: string
  angle: string
  persona: string
  funnel_position: 'top' | 'mid' | 'bottom' | string
  hook: string
  copy_outline: string
  visual_direction: string
  product: string
  format: 'image' | 'video' | 'carousel' | string
  fal_model_hint: string
  rationale: string
  source_winner_ids: string[]
}

export type DraftStatus = 'proposed' | 'ready' | 'draft' | 'launched' | 'discarded'

export type DraftAsset = {
  asset_id: string
  draft_id: string
  variant_idx: number
  mime_type: string
  fal_model_used?: string | null
  cost_usd?: number | null
  created_at: number
  filename: string
  url: string
}

export type Draft = {
  draft_id: string
  recipe_id: string
  brand: string
  status: DraftStatus
  recipe: Recipe
  source_winner_ids: string[]
  meta_ad_id?: string | null
  rejection_reason?: string | null
  rejected_at?: number | null
  created_at: number
  updated_at: number
  assets: DraftAsset[]
}
