// Analyze tab — recipe generator (Phase 2 Task 2.11).
// Calls POST /api/recipes/analyze on user-triggered click (never auto on
// mount — Claude calls are billed/rate-limited, button-gated by design).
// 401 ClaudeAuthExpired renders a Re-authenticate card with a copy-to-
// clipboard helper (decision 6A).

import { useState } from 'react'
import { Loader2, RefreshCcw, Sparkles, ShieldAlert, Copy, Check } from 'lucide-react'
import { api, ApiError } from '../lib/api'

export type Recipe = {
  recipe_id: string
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

type AnalyzeResponse = { recipes: Recipe[] }

type RequestBody = {
  brand: string
  top_n_winners?: number
  n_recipes?: number
  focus_product?: string | null
  include_video_frames?: boolean
  regenerate?: boolean
}

export function AnalyzeView({ brand }: { brand: string }) {
  const [loading, setLoading] = useState(false)
  const [recipes, setRecipes] = useState<Recipe[] | null>(null)
  const [authExpired, setAuthExpired] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function runAnalyze(regenerate: boolean) {
    if (!brand) {
      setError('Pick a brand first.')
      return
    }
    setLoading(true)
    setError(null)
    setAuthExpired(false)
    const body: RequestBody = {
      brand,
      top_n_winners: 10,
      n_recipes: 5,
      include_video_frames: false,
      regenerate,
    }
    try {
      const out = await api.post<AnalyzeResponse>('/api/recipes/analyze', body)
      setRecipes(out.recipes || [])
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuthExpired(true)
      } else {
        setError(e instanceof Error ? e.message : 'Analyze failed')
      }
    } finally {
      setLoading(false)
    }
  }

  if (authExpired) {
    return <ReauthCard onRetry={() => runAnalyze(false)} />
  }

  return (
    <div className="py-6 flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-text-primary">Recipe Analyze</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Claude reads your top winners + brand context, proposes new ad concepts.
          </p>
        </div>
        {recipes && recipes.length > 0 ? (
          <button
            onClick={() => runAnalyze(true)}
            disabled={loading}
            className="px-3 py-1.5 rounded-full text-xs glass glass-hover flex items-center gap-1.5 disabled:opacity-50"
            aria-label="Regenerate recipes"
          >
            {loading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCcw size={12} />
            )}
            Regenerate
          </button>
        ) : (
          <button
            onClick={() => runAnalyze(false)}
            disabled={loading || !brand}
            className="px-4 py-2 rounded-full text-xs bg-text-primary text-white flex items-center gap-1.5 disabled:opacity-50"
            aria-label="Generate recipes"
          >
            {loading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Sparkles size={12} />
            )}
            Generate Recipes
          </button>
        )}
      </header>

      {error && (
        <div
          role="alert"
          className="glass rounded-2xl px-4 py-3 text-xs text-red-700 border border-red-200/50"
        >
          {error}
        </div>
      )}

      {loading && !recipes && (
        <div className="glass rounded-2xl p-12 flex flex-col items-center gap-3 text-text-muted text-sm">
          <Loader2 size={20} className="animate-spin" />
          Reading winners, asking Claude…
        </div>
      )}

      {recipes && recipes.length === 0 && !loading && (
        <div className="glass rounded-2xl p-12 text-center text-text-muted text-sm">
          No recipes returned. Try regenerating, or check that the brand has recent winning ads.
        </div>
      )}

      {recipes && recipes.length > 0 && (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {recipes.map(r => (
            <li key={r.recipe_id}>
              <RecipeCard recipe={r} />
            </li>
          ))}
        </ul>
      )}

      {!recipes && !loading && !error && (
        <div className="glass rounded-2xl p-12 text-center text-text-muted text-sm">
          Click <span className="font-medium text-text-primary">Generate Recipes</span> to start.
        </div>
      )}
    </div>
  )
}

function RecipeCard({ recipe }: { recipe: Recipe }) {
  return (
    <article
      data-testid="recipe-card"
      className="glass rounded-2xl p-4 flex flex-col gap-2 h-full"
    >
      <header className="flex items-center justify-between gap-2">
        <span className="text-xs text-text-muted uppercase tracking-wide">
          {recipe.angle}
        </span>
        <span className="text-[10px] text-text-muted">
          {recipe.funnel_position} · {recipe.format}
        </span>
      </header>
      <h3 className="text-sm font-medium text-text-primary leading-snug">
        {recipe.hook}
      </h3>
      <p className="text-xs text-text-muted">
        For <span className="text-text-primary">{recipe.persona}</span> · {recipe.product}
      </p>
      <p className="text-xs text-text-muted line-clamp-3">{recipe.rationale}</p>
      <footer className="mt-auto pt-2 flex items-center justify-between text-[10px] text-text-muted">
        <span>{recipe.fal_model_hint}</span>
        <span>{recipe.source_winner_ids.length} winner(s)</span>
      </footer>
    </article>
  )
}

function ReauthCard({ onRetry }: { onRetry: () => void }) {
  const [copied, setCopied] = useState(false)
  const command = 'claude auth login'

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: leave it visible so the user can manual-copy.
    }
  }

  return (
    <div
      role="alert"
      className="glass rounded-2xl p-8 my-8 flex flex-col items-center gap-3 text-center max-w-md mx-auto"
    >
      <ShieldAlert size={20} className="text-amber-600" />
      <h2 className="text-sm font-medium text-text-primary">
        Claude session expired
      </h2>
      <p className="text-xs text-text-muted">
        Re-authenticate in your terminal, then retry.
      </p>
      <button
        onClick={copy}
        className="px-3 py-1.5 rounded-full text-xs glass glass-hover flex items-center gap-1.5 font-mono"
        aria-label="Copy claude auth login command"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {command}
      </button>
      <button
        onClick={onRetry}
        className="px-3 py-1.5 rounded-full text-xs bg-text-primary text-white flex items-center gap-1.5 mt-1"
      >
        Retry
      </button>
    </div>
  )
}
