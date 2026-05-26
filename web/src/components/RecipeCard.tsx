import type { ReactNode } from 'react'
import type { Recipe } from '../types/creative'

export function RecipeCard({
  recipe,
  actions,
  selected = false,
}: {
  recipe: Recipe
  actions?: ReactNode
  selected?: boolean
}) {
  return (
    <article
      data-testid="recipe-card"
      className={`glass rounded-lg p-4 flex flex-col gap-2 h-full border ${
        selected ? 'border-text-primary/30 bg-white/65' : 'border-white/35'
      }`}
    >
      <header className="flex items-center justify-between gap-2 min-w-0">
        <span className="text-xs text-text-muted uppercase tracking-wide truncate">
          {recipe.angle}
        </span>
        <span className="text-[10px] text-text-muted flex-shrink-0">
          {recipe.funnel_position} · {recipe.format}
        </span>
      </header>
      <h3 className="text-sm font-medium text-text-primary leading-snug break-words">
        {recipe.hook}
      </h3>
      <p className="text-xs text-text-muted break-words">
        For <span className="text-text-primary">{recipe.persona}</span> · {recipe.product}
      </p>
      <p className="text-xs text-text-muted line-clamp-3 break-words">{recipe.rationale}</p>
      <footer className="mt-auto pt-2 flex items-center justify-between gap-2 text-[10px] text-text-muted">
        <span className="truncate">{recipe.fal_model_hint}</span>
        <span className="flex-shrink-0">{recipe.source_winner_ids.length} winner(s)</span>
      </footer>
      {actions && <div className="pt-2 flex flex-wrap gap-2">{actions}</div>}
    </article>
  )
}
