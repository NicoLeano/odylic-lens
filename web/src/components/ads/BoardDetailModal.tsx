/**
 * BoardDetailModal. dedicated full-screen view of a single board.
 *
 * Replaces the prior "click board → filter the current grid" behavior,
 * which surprised users by silently shrinking results when pins were
 * out of range. Now clicking a board genuinely takes you to the board:
 * a portaled modal lists every pin (both `atelier`-source Meta ads and
 * `atria`-source library ads) in one unified masonry of thumbnails.
 *
 * Each tile shows the snapshot data we stored at pin time (brand, body,
 * thumbnail, status) plus the source so you can tell at a glance where
 * the ad came from. Click a tile → open the existing detail panel for
 * full metrics / analysis on atelier ads, or external Atria link for
 * atria ads.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, Trash2 } from 'lucide-react'

type Pin = {
  source: 'atelier' | 'atria'
  ad_id: string
  brand: string | null
  saved_at: number
  snapshot: Record<string, any>
}

type BoardDetail = {
  id: string
  name: string
  ad_count: number
  created_at: number | null
  updated_at: number | null
  ads: Pin[]
}

interface Props {
  boardId: string
  boardName: string
  onClose: () => void
  /** Click an atelier-source tile → parent opens the AdDetailPanel.
   *  Atria-source tiles deep-link out (no local detail view yet). */
  onOpenAtelierAd?: (adId: string, brand: string | null) => void
}

export function BoardDetailModal({ boardId, boardName, onClose, onOpenAtelierAd }: Props) {
  const [data, setData] = useState<BoardDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = () => {
    setLoading(true); setErr(null)
    fetch(`/api/boards/${boardId}`)
      .then(async r => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`)
        return d as BoardDetail
      })
      .then(setData)
      .catch(e => setErr(String(e?.message || e)))
      .finally(() => setLoading(false))
  }
  useEffect(load, [boardId])

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const unpin = async (pin: Pin) => {
    const key = `${pin.source}::${pin.ad_id}`
    setBusy(key)
    try {
      const qs = new URLSearchParams()
      if (pin.brand) qs.set('brand', pin.brand)
      await fetch(
        `/api/boards/${boardId}/ads/${pin.source}/${encodeURIComponent(pin.ad_id)}?${qs.toString()}`,
        { method: 'DELETE' },
      )
      setData(d => d ? { ...d, ads: d.ads.filter(p => !(p.source === pin.source && p.ad_id === pin.ad_id)) } : d)
    } finally {
      setBusy(null)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[120] bg-black/40 backdrop-blur-sm flex items-start justify-center p-6 overflow-auto"
      onClick={onClose}
    >
      <div
        className="bg-bg-primary w-full max-w-[1180px] mt-8 rounded-2xl shadow-2xl border border-black/[0.06] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 flex items-center gap-3 border-b border-black/[0.06]">
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-text-muted">Board</div>
            <div className="font-display text-[20px] leading-tight text-text-primary truncate">{boardName}</div>
          </div>
          <div className="text-[11px] text-text-muted tabular-nums">
            {data ? `${data.ads.length} pin${data.ads.length === 1 ? '' : 's'}` : ''}
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-black/[0.04]" title="Close (Esc)">
            <X size={14} />
          </button>
        </div>

        <div className="p-5 min-h-[400px]">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-text-muted text-[12px] gap-2">
              <Loader2 size={14} className="animate-spin" /> Loading board…
            </div>
          ) : err ? (
            <div className="text-[12px] text-red-600 py-16 text-center">{err}</div>
          ) : !data || data.ads.length === 0 ? (
            <div className="text-[12px] text-text-muted py-16 text-center">
              This board is empty. Save ads to it from Analytics or Search.
            </div>
          ) : (
            <div className="grid gap-3 grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
              {data.ads.map(pin => (
                <PinTile
                  key={`${pin.source}::${pin.ad_id}`}
                  pin={pin}
                  onOpen={() => {
                    if (pin.source === 'atelier' && onOpenAtelierAd) {
                      onOpenAtelierAd(pin.ad_id, pin.brand)
                      onClose()
                    }
                  }}
                  onUnpin={() => unpin(pin)}
                  busy={busy === `${pin.source}::${pin.ad_id}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function PinTile({ pin, onOpen, onUnpin, busy }: {
  pin: Pin
  onOpen: () => void
  onUnpin: () => void
  busy: boolean
}) {
  const s = pin.snapshot || {}
  const thumb = s.thumbnail_url || s.preview_image_url || null
  const title = s.title || s.body || s.brand_name || pin.ad_id
  const isAtelier = pin.source === 'atelier'
  return (
    <div className="group relative flex flex-col rounded-lg overflow-hidden border border-black/[0.08] bg-white hover:shadow-md transition-shadow">
      <button
        onClick={onOpen}
        className="relative bg-black/[0.04] aspect-[4/5] text-left"
        title={isAtelier ? 'Open ad detail' : 'Atria ad. open detail not available'}
      >
        {thumb ? (
          <img
            src={thumb}
            alt=""
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-text-muted">(no media)</div>
        )}
        <div className={`absolute top-1.5 left-1.5 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${
          isAtelier ? 'bg-[#B7410E]/85 text-white' : 'bg-violet-600/85 text-white'
        }`}>
          {pin.source}
        </div>
      </button>
      <div className="px-2 py-1.5 flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium text-text-primary truncate" title={s.brand_name || pin.brand || ''}>
            {s.brand_name || pin.brand || 'Unknown'}
          </div>
          <div className="text-[10.5px] text-text-muted line-clamp-2 leading-tight">
            {title}
          </div>
        </div>
        <button
          onClick={onUnpin}
          disabled={busy}
          className="p-1 rounded hover:bg-red-50 text-text-muted hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
          title="Unpin from this board"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
        </button>
      </div>
    </div>
  )
}
