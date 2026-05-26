import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ClipboardCopy,
  Download,
  ExternalLink,
  Film,
  ImageUp,
  Loader2,
  RefreshCcw,
  Trash2,
} from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { RecipeCard } from './RecipeCard'
import type { Draft, DraftAsset, DraftStatus } from '../types/creative'

type CreateViewProps = {
  brand: string
  focusDraftId?: string | null
}

type DraftsResponse = { drafts: Draft[] }
type DraftResponse = { draft: Draft }
type PrepareResponse = { prompt: string; draft: Draft }

const ACTIVE_STATUSES: DraftStatus[] = ['proposed', 'ready', 'draft', 'launched']
const PENDING_STATUSES = new Set<DraftStatus>(['proposed', 'ready'])
const GALLERY_STATUSES = new Set<DraftStatus>(['draft', 'launched'])

export function CreateView({ brand, focusDraftId }: CreateViewProps) {
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [loading, setLoading] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [copiedDraftId, setCopiedDraftId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'active' | 'pending' | 'gallery'>('active')
  const [error, setError] = useState<string | null>(null)
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})

  const pendingDrafts = useMemo(
    () => drafts.filter(d => PENDING_STATUSES.has(d.status)),
    [drafts],
  )
  const galleryDrafts = useMemo(
    () => drafts.filter(d => GALLERY_STATUSES.has(d.status)),
    [drafts],
  )
  const shownDrafts = filter === 'pending'
    ? pendingDrafts
    : filter === 'gallery'
      ? galleryDrafts
      : drafts

  async function loadDrafts() {
    if (!brand) {
      setDrafts([])
      return
    }
    setLoading(true)
    setError(null)
    const statuses = ACTIVE_STATUSES.map(s => `status=${encodeURIComponent(s)}`).join('&')
    try {
      const out = await api.get<DraftsResponse>(
        `/api/drafts?brand=${encodeURIComponent(brand)}&${statuses}&limit=50`,
      )
      setDrafts(out.drafts || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Drafts failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadDrafts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand])

  useEffect(() => {
    if (focusDraftId) setFilter('pending')
  }, [focusDraftId])

  function mergeDraft(draft: Draft) {
    setDrafts(prev => {
      const next = [draft, ...prev.filter(d => d.draft_id !== draft.draft_id)]
      return next.sort((a, b) => b.created_at - a.created_at)
    })
  }

  function dropDraft(draftId: string) {
    setDrafts(prev => prev.filter(d => d.draft_id !== draftId))
  }

  function setBusy(action: string, draftId: string) {
    setBusyKey(`${action}:${draftId}`)
  }

  function isBusy(action: string, draftId: string) {
    return busyKey === `${action}:${draftId}`
  }

  async function copyPrompt(draft: Draft) {
    setBusy('copy', draft.draft_id)
    setError(null)
    try {
      const out = await api.post<PrepareResponse>(`/api/drafts/${encodeURIComponent(draft.draft_id)}/prepare`)
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard is unavailable in this browser.')
      }
      await navigator.clipboard.writeText(out.prompt)
      mergeDraft(out.draft)
      setCopiedDraftId(draft.draft_id)
      window.setTimeout(() => setCopiedDraftId(null), 1800)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Prompt copy failed')
    } finally {
      setBusyKey(null)
    }
  }

  async function uploadAsset(draft: Draft, file: File | null | undefined) {
    if (!file) return
    setBusy('upload', draft.draft_id)
    setError(null)
    const form = new FormData()
    form.append('file', file)
    try {
      const res = await fetch(`/api/drafts/${encodeURIComponent(draft.draft_id)}/upload`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      })
      const text = await res.text()
      let body: any = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = text
      }
      if (!res.ok) {
        const message = body?.detail || body?.message || res.statusText
        throw new ApiError(res.status, String(message), body)
      }
      mergeDraft((body as DraftResponse).draft)
      setFilter('gallery')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setBusyKey(null)
      const input = fileInputs.current[draft.draft_id]
      if (input) input.value = ''
    }
  }

  async function generateVideo(draft: Draft) {
    setBusy('video', draft.draft_id)
    setError(null)
    try {
      const out = await api.post<DraftResponse>(
        `/api/drafts/${encodeURIComponent(draft.draft_id)}/generate-video`,
        { variant_count: 1 },
      )
      mergeDraft(out.draft)
      setFilter('gallery')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Video generation failed')
    } finally {
      setBusyKey(null)
    }
  }

  async function updateStatus(draft: Draft, status: DraftStatus) {
    setBusy(status, draft.draft_id)
    setError(null)
    try {
      const out = await api.patch<DraftResponse>(
        `/api/drafts/${encodeURIComponent(draft.draft_id)}`,
        { status },
      )
      if (status === 'discarded') dropDraft(draft.draft_id)
      else mergeDraft(out.draft)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Draft update failed')
    } finally {
      setBusyKey(null)
    }
  }

  async function deleteAsset(asset: DraftAsset) {
    setBusyKey(`asset:${asset.asset_id}`)
    setError(null)
    try {
      const out = await api.delete<{ ok: boolean; draft: Draft | null }>(
        `/api/draft-assets/${encodeURIComponent(asset.asset_id)}`,
      )
      if (out.draft) mergeDraft(out.draft)
      else await loadDrafts()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Asset delete failed')
    } finally {
      setBusyKey(null)
    }
  }

  if (!brand) {
    return (
      <div className="glass rounded-lg p-12 my-6 text-center text-text-muted text-sm">
        Pick a brand from the left to create drafts.
      </div>
    )
  }

  return (
    <div className="py-6 flex flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-text-primary">Create</h2>
          <p className="text-xs text-text-muted mt-0.5">
            {brand} · {pendingDrafts.length} pending · {galleryDrafts.length} draft assets
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="glass rounded-full p-0.5 flex items-center gap-0.5">
            {([
              ['active', 'All'],
              ['pending', 'Pending'],
              ['gallery', 'Gallery'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`px-3 py-1 rounded-full text-xs transition-colors ${
                  filter === key ? 'bg-text-primary text-white' : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={loadDrafts}
            disabled={loading}
            className="px-3 py-1.5 rounded-full text-xs glass glass-hover flex items-center gap-1.5 disabled:opacity-50"
            aria-label="Refresh drafts"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCcw size={12} />}
            Refresh
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" className="glass rounded-lg px-4 py-3 text-xs text-red-700 border border-red-200/50">
          {error}
        </div>
      )}

      {loading && !drafts.length ? (
        <div className="glass rounded-lg p-12 flex flex-col items-center gap-3 text-text-muted text-sm">
          <Loader2 size={20} className="animate-spin" />
          Loading drafts…
        </div>
      ) : null}

      {!loading && shownDrafts.length === 0 ? (
        <div className="glass rounded-lg p-12 text-center text-text-muted text-sm">
          No drafts in this view.
        </div>
      ) : null}

      {shownDrafts.length > 0 && (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(300px,380px)_1fr] gap-4 items-start">
          <section className="flex flex-col gap-3 min-w-0">
            <div className="flex items-center justify-between gap-2 px-1">
              <h3 className="text-sm font-medium text-text-primary">Pending recipes</h3>
              <span className="text-[10px] uppercase tracking-wider text-text-muted">
                {pendingDrafts.length}
              </span>
            </div>
            {pendingDrafts.length ? (
              <ul className="flex flex-col gap-3">
                {pendingDrafts.map(draft => (
                  <li key={draft.draft_id}>
                    <RecipeCard
                      recipe={draft.recipe}
                      selected={draft.draft_id === focusDraftId}
                      actions={
                        <>
                          <button
                            onClick={() => copyPrompt(draft)}
                            disabled={busyKey !== null}
                            className="px-3 py-1.5 rounded-full text-xs glass glass-hover flex items-center gap-1.5 disabled:opacity-50"
                            aria-label={`Copy ChatGPT prompt for ${draft.recipe.hook}`}
                          >
                            {isBusy('copy', draft.draft_id) ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : copiedDraftId === draft.draft_id ? (
                              <Check size={12} />
                            ) : (
                              <ClipboardCopy size={12} />
                            )}
                            Prompt
                          </button>
                          <button
                            onClick={() => fileInputs.current[draft.draft_id]?.click()}
                            disabled={busyKey !== null}
                            className="px-3 py-1.5 rounded-full text-xs glass glass-hover flex items-center gap-1.5 disabled:opacity-50"
                            aria-label={`Upload image for ${draft.recipe.hook}`}
                          >
                            {isBusy('upload', draft.draft_id) ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <ImageUp size={12} />
                            )}
                            Upload
                          </button>
                          <input
                            ref={el => { fileInputs.current[draft.draft_id] = el }}
                            type="file"
                            accept="image/*,video/mp4,video/webm,video/quicktime"
                            className="sr-only"
                            onChange={e => uploadAsset(draft, e.currentTarget.files?.[0])}
                          />
                          <button
                            onClick={() => generateVideo(draft)}
                            disabled={busyKey !== null}
                            className="px-3 py-1.5 rounded-full text-xs bg-text-primary text-white flex items-center gap-1.5 disabled:opacity-50"
                            aria-label={`Generate fal.ai video for ${draft.recipe.hook}`}
                          >
                            {isBusy('video', draft.draft_id) ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Film size={12} />
                            )}
                            Video
                          </button>
                        </>
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="glass rounded-lg p-6 text-xs text-text-muted text-center">
                No pending recipes.
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3 min-w-0">
            <div className="flex items-center justify-between gap-2 px-1">
              <h3 className="text-sm font-medium text-text-primary">Draft gallery</h3>
              <span className="text-[10px] uppercase tracking-wider text-text-muted">
                {galleryDrafts.length}
              </span>
            </div>
            {galleryDrafts.length ? (
              <ul className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-3">
                {galleryDrafts.map(draft => (
                  <li key={draft.draft_id}>
                    <DraftGalleryCard
                      draft={draft}
                      onLaunch={() => updateStatus(draft, 'launched')}
                      onDiscard={() => updateStatus(draft, 'discarded')}
                      onDeleteAsset={deleteAsset}
                      busyKey={busyKey}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="glass rounded-lg p-10 text-xs text-text-muted text-center">
                No generated assets yet.
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function DraftGalleryCard({
  draft,
  onLaunch,
  onDiscard,
  onDeleteAsset,
  busyKey,
}: {
  draft: Draft
  onLaunch: () => void
  onDiscard: () => void
  onDeleteAsset: (asset: DraftAsset) => void
  busyKey: string | null
}) {
  const asset = draft.assets[0]
  const assetBusy = asset ? busyKey === `asset:${asset.asset_id}` : false

  return (
    <article data-testid="draft-card" className="glass rounded-lg p-3 flex flex-col gap-3 h-full">
      <div className="aspect-[4/5] rounded-lg overflow-hidden bg-black/[0.04] flex items-center justify-center">
        {asset ? (
          asset.mime_type.startsWith('video/') ? (
            <video
              src={asset.url}
              className="w-full h-full object-cover"
              muted
              playsInline
              controls
            />
          ) : (
            <img
              src={asset.url}
              alt={draft.recipe.hook}
              className="w-full h-full object-cover"
            />
          )
        ) : (
          <Film size={18} className="text-text-muted" />
        )}
      </div>
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-text-primary leading-snug break-words">
            {draft.recipe.hook}
          </h4>
          <p className="text-xs text-text-muted mt-1 truncate">
            {draft.recipe.product} · {asset?.fal_model_used || 'manual'}
          </p>
        </div>
        <StatusPill status={draft.status} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-auto">
        {asset && (
          <>
            <a
              href={asset.url}
              target="_blank"
              rel="noreferrer"
              className="p-1.5 rounded-full glass glass-hover text-text-muted hover:text-text-primary"
              aria-label={`Open ${draft.recipe.hook} asset`}
            >
              <ExternalLink size={12} />
            </a>
            <a
              href={asset.url}
              download={asset.filename}
              className="p-1.5 rounded-full glass glass-hover text-text-muted hover:text-text-primary"
              aria-label={`Download ${draft.recipe.hook} asset`}
            >
              <Download size={12} />
            </a>
            <button
              onClick={() => onDeleteAsset(asset)}
              disabled={assetBusy}
              className="p-1.5 rounded-full glass glass-hover text-text-muted hover:text-red-600 disabled:opacity-50"
              aria-label={`Delete ${draft.recipe.hook} asset`}
            >
              {assetBusy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            </button>
          </>
        )}
        {draft.status !== 'launched' && (
          <button
            onClick={onLaunch}
            disabled={busyKey !== null}
            className="ml-auto px-3 py-1.5 rounded-full text-xs bg-text-primary text-white disabled:opacity-50"
            aria-label={`Mark ${draft.recipe.hook} launched`}
          >
            Launch
          </button>
        )}
        <button
          onClick={onDiscard}
          disabled={busyKey !== null}
          className={`${draft.status === 'launched' ? 'ml-auto' : ''} px-3 py-1.5 rounded-full text-xs glass glass-hover text-text-muted hover:text-red-600 disabled:opacity-50`}
          aria-label={`Discard ${draft.recipe.hook}`}
        >
          Discard
        </button>
      </div>
      {asset?.cost_usd != null && (
        <div className="text-[10px] text-text-muted tabular-nums">
          ${asset.cost_usd.toFixed(2)}
        </div>
      )}
    </article>
  )
}

function StatusPill({ status }: { status: DraftStatus }) {
  const color = status === 'launched'
    ? 'bg-emerald-100 text-emerald-700'
    : status === 'draft'
      ? 'bg-black/[0.06] text-text-secondary'
      : 'bg-amber-100 text-amber-700'
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] capitalize flex-shrink-0 ${color}`}>
      {status}
    </span>
  )
}
