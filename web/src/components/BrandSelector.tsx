// BrandSelector. left-rail circle button + popover. Single-select only:
// pick exactly one brand at a time. Meta-only (Lens doesn't talk to Google).
// No "All brands" mode, no "Solo" button, no "Select all", no count chips.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Settings } from 'lucide-react'

export type Brand = {
  name: string
  meta?: boolean
  meta_account_id?: string | null
}

type BrandProfile = {
  favicon?: string | null
  domain?: string
  description?: string
}

interface Props {
  brands: Brand[]
  profiles: Record<string, BrandProfile>
  selected: string[]   // accepted as array for back-compat with parent code
  onSelectedChange: (next: string[]) => void
  onOpenSettings: (brand: string) => void
}

export function BrandSelector({
  brands, profiles, selected, onSelectedChange, onOpenSettings,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const popoverRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Auto-focus search when popover opens.
  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => searchRef.current?.focus(), 50)
      return () => window.clearTimeout(id)
    }
  }, [open])

  // Close on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return brands
    return brands.filter(b => {
      if (b.name.toLowerCase().includes(q)) return true
      const p = profiles[b.name]
      if (p?.domain?.toLowerCase().includes(q)) return true
      if (p?.description?.toLowerCase().includes(q)) return true
      return false
    })
  }, [brands, profiles, query])

  // Single-select: only the first entry counts. Parent still hands us an
  // array for back-compat, but we always emit `[name]` on change.
  const current = selected[0] || ''
  const currentProfile = current ? profiles[current] : undefined

  const pick = (name: string) => {
    onSelectedChange([name])
    setOpen(false)
  }

  // Hover-prefetch. When the user hovers a brand in the picker, kick
  // off the dashboard fetch in the background so by the time they
  // click, the response is already warming. Atelier's `/api/ads/dashboard`
  // cache key is (brand, start, end) so we can't hit it without dates,
  // but the cheaper `/api/profile` + `/api/ads/creatives` (no date scope)
  // warms the backend's in-process cache and lets the disk cache
  // resolve when the real call lands. Best-effort only. failures are
  // silent (no toast, no log spam).
  const prefetchedRef = useRef<Set<string>>(new Set())
  const prefetch = (name: string) => {
    if (!name || prefetchedRef.current.has(name)) return
    prefetchedRef.current.add(name)
    const encoded = encodeURIComponent(name)
    // Two cheap warmers. profile (instant) + brands list refresh.
    fetch(`/api/profile?brand=${encoded}`, { credentials: 'include' }).catch(() => {})
  }

  return (
    <>
      <div className="relative">
        <button
          onClick={() => setOpen(v => !v)}
          title={current ? `${current}. click to change` : 'Select a brand'}
          className={`w-10 h-10 rounded-full flex items-center justify-center overflow-hidden transition-all ring-2 ${
            open ? 'ring-text-primary' : 'ring-black/[0.1] hover:ring-text-primary/40'
          } ring-offset-1 ring-offset-white/40`}
        >
          {currentProfile?.favicon ? (
            <img
              src={currentProfile.favicon}
              alt={current}
              className="w-full h-full object-cover"
              onError={e => {
                const img = e.currentTarget as HTMLImageElement
                img.style.display = 'none'
                const fb = img.nextElementSibling as HTMLElement | null
                if (fb) fb.style.display = 'flex'
              }}
            />
          ) : null}
          <div
            className="w-full h-full items-center justify-center bg-text-primary/90 text-white text-[11px] font-medium"
            style={{ display: currentProfile?.favicon ? 'none' : 'flex' }}
          >
            {current ? current.charAt(0).toUpperCase() : '-'}
          </div>
        </button>
      </div>

      {open && (
        <>
          {/* Backdrop. closes on click anywhere else. */}
          <div
            className="fixed inset-0"
            style={{ zIndex: 10000 }}
            onClick={() => setOpen(false)}
          />
          <div
            ref={popoverRef}
            className="atelier-section"
            style={{
              position: 'fixed',
              top: 12,
              left: 60,
              width: 320,
              maxHeight: '80vh',
              padding: 0,
              zIndex: 10001,
              display: 'flex',
              flexDirection: 'column',
              // Override .atelier-section's translucent glass gradient
              // with an opaque white. Frosted-glass blur breaks down on
              // some stacking contexts (Brand popover lives at z=10001
              // above the rest of the app), making content underneath
              // read through. Opaque keeps the brand list legible at
              // every render path.
              background: 'rgba(255, 255, 255, 0.98)',
              backdropFilter: 'blur(40px) saturate(180%)',
              WebkitBackdropFilter: 'blur(40px) saturate(180%)',
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center px-3 pt-3 pb-2">
              <div className="font-display text-[15px] font-medium tracking-tight">Brands</div>
            </div>

            {/* Search */}
            <div className="px-3 pb-2">
              <div className="flex items-center gap-1.5 bg-white/70 border border-black/[0.08] rounded-full px-3 py-1.5 focus-within:border-text-primary/30">
                <Search size={12} className="text-text-muted" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search brands…"
                  className="flex-1 bg-transparent text-[12px] outline-none placeholder:text-text-muted/70"
                />
                {query && (
                  <button
                    onClick={() => setQuery('')}
                    className="text-text-muted hover:text-text-primary"
                    title="Clear"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            </div>

            {/* List. single-select. Click row picks it. */}
            <div className="flex-1 overflow-y-auto px-1.5 pb-1">
              {filtered.length === 0 && (
                <div className="text-[11px] text-text-muted/80 text-center py-6">
                  No brands match "{query}".
                </div>
              )}
              {filtered.map(b => {
                const p = profiles[b.name] || {}
                const isCurrent = current === b.name
                return (
                  <div
                    key={b.name}
                    className={`group relative flex items-center gap-2 px-2 py-1.5 mx-0.5 rounded-lg transition-colors ${
                      isCurrent ? 'bg-white/70' : 'hover:bg-white/40'
                    }`}
                  >
                    <button
                      onClick={() => pick(b.name)}
                      onMouseEnter={() => prefetch(b.name)}
                      onFocus={() => prefetch(b.name)}
                      className="flex items-center gap-2 flex-1 min-w-0 text-left"
                    >
                      <span className="w-6 h-6 rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center bg-black/[0.05] ring-1 ring-black/[0.05]">
                        {p.favicon ? (
                          <img
                            src={p.favicon}
                            alt=""
                            className="w-full h-full object-cover"
                            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                          />
                        ) : (
                          <span className="text-[10px] text-text-muted">{b.name.charAt(0).toUpperCase()}</span>
                        )}
                      </span>
                      <div className="flex-1 min-w-0 flex flex-col leading-tight">
                        <span className="text-[12px] text-text-primary truncate">{b.name}</span>
                        {b.meta_account_id ? (
                          <span className="text-[9px] text-text-muted/70 truncate font-mono">
                            {b.meta_account_id}
                          </span>
                        ) : null}
                      </div>
                    </button>

                    {/* Hover-only: settings gear */}
                    <button
                      onClick={() => { onOpenSettings(b.name); setOpen(false) }}
                      className="p-1.5 rounded-full hover:bg-black/[0.06] text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Brand settings"
                    >
                      <Settings size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </>
  )
}
