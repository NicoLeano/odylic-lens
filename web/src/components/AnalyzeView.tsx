// Analyze tab — recipe generator (Phase 2 Task 2.11).
// Calls POST /api/recipes/analyze on user-triggered click (never auto on
// mount — Claude calls are billed/rate-limited, button-gated by design).
// 401 ClaudeAuthExpired renders a Re-authenticate card with a copy-to-
// clipboard helper (decision 6A).

import { useState } from 'react'
import { ArrowRight, Ban, Loader2, RefreshCcw, Sparkles, ShieldAlert, Copy, Check } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { RecipeCard } from './RecipeCard'
import { RejectRecipeDialog } from './RejectRecipeDialog'
import type { Recipe } from '../types/creative'

type AnalyzeResponse = { recipes: Recipe[] }
type DraftResponse = { draft: { draft_id: string } }

type RequestBody = {
  brand: string
  top_n_winners?: number
  n_recipes?: number
  focus_product?: string | null
  include_video_frames?: boolean
  regenerate?: boolean
}

const PILL_BUTTON_BASE = 'min-h-10 px-3 rounded-full text-xs inline-flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.96] transition-[transform,background-color,color,box-shadow] duration-150'

export function AnalyzeView({
  brand,
  onSendToCreate,
}: {
  brand: string
  onSendToCreate?: (draftId: string) => void
}) {
  const [loading, setLoading] = useState(false)
  const [recipes, setRecipes] = useState<Recipe[] | null>(null)
  const [authExpired, setAuthExpired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [rejectingDraftId, setRejectingDraftId] = useState<string | null>(null)
  const [rejectTarget, setRejectTarget] = useState<Recipe | null>(null)

  async function runAnalyze(regenerate: boolean) {
    if (!brand) {
      setError('Pick a brand first.')
      return
    }
    setLoading(true)
    setError(null)
    setNotice(null)
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

  async function rejectRecipe(recipe: Recipe, rejection_reason: string) {
    if (!recipe.draft_id) {
      setError('Recipe is missing a draft id.')
      return
    }
    setRejectingDraftId(recipe.draft_id)
    setError(null)
    try {
      await api.patch<DraftResponse>(
        `/api/drafts/${encodeURIComponent(recipe.draft_id)}`,
        { status: 'discarded', rejection_reason },
      )
      setRecipes(prev => prev?.filter(r => r.draft_id !== recipe.draft_id) ?? prev)
      setRejectTarget(null)
      setNotice('Recipe rejected. Future Analyze runs will avoid similar patterns.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recipe rejection failed')
    } finally {
      setRejectingDraftId(null)
    }
  }

  if (authExpired) {
    return <ReauthCard onRetry={() => runAnalyze(false)} />
  }

  return (
    <div className="py-6 flex flex-col gap-4">
      {rejectTarget && (
        <RejectRecipeDialog
          hook={rejectTarget.hook}
          busy={rejectingDraftId === rejectTarget.draft_id}
          onCancel={() => setRejectTarget(null)}
          onConfirm={reason => rejectRecipe(rejectTarget, reason)}
        />
      )}

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

      {notice && (
        <div
          role="status"
          aria-live="polite"
          className="glass rounded-lg px-4 py-3 text-xs flex items-center gap-2 text-emerald-700"
        >
          <Check size={14} className="flex-shrink-0" />
          <span className="[text-wrap:pretty]">{notice}</span>
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
          {notice
            ? 'No recipes remaining in this run.'
            : 'No recipes returned. Try regenerating, or check that the brand has recent winning ads.'}
        </div>
      )}

      {recipes && recipes.length > 0 && (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {recipes.map(r => (
            <li key={r.recipe_id}>
              <RecipeCard
                recipe={r}
                actions={
                  r.draft_id ? (
                    <>
                      <button
                        onClick={() => setRejectTarget(r)}
                        disabled={rejectingDraftId !== null || loading}
                        className={`${PILL_BUTTON_BASE} glass glass-hover text-text-muted hover:text-red-600`}
                        aria-label={`Reject ${r.hook}`}
                      >
                        {rejectingDraftId === r.draft_id ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Ban size={12} />
                        )}
                        Reject
                      </button>
                      {onSendToCreate ? (
                        <button
                          onClick={() => onSendToCreate(r.draft_id as string)}
                          disabled={rejectingDraftId !== null || loading}
                          className={`${PILL_BUTTON_BASE} bg-text-primary text-white`}
                          aria-label={`Open ${r.hook} in Create`}
                        >
                          <ArrowRight size={12} />
                          Open in Create
                        </button>
                      ) : null}
                    </>
                  ) : null
                }
              />
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
