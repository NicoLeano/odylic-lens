/**
 * SaveToBoardButton. bookmark button on any ad.
 *
 * Drop-in for both Meta-native (`source: 'atelier'`) and Atria search
 * results (`source: 'atria'`). Reads membership on mount so the bookmark
 * icon renders filled when the ad is already pinned anywhere.
 *
 * Click → popover lists all boards with a checkbox per row. Toggling a
 * row immediately pins/unpins. "+ New board…" at the bottom creates and
 * pins in one shot.
 *
 * Replaces the previous Atria deep-link "Save to a board…" button. the
 * user doesn't want their saves to leave Atelier.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bookmark, BookmarkCheck, Loader2, Plus, Check } from 'lucide-react'
import type { BoardSummary } from './BoardsMenu'

type Source = 'atria' | 'atelier'

interface Props {
  source: Source
  adId: string
  /** Only meaningful when source='atelier'. same ad_id can live under
   *  different ad accounts so we scope membership by brand on that side. */
  brand?: string | null
  /** Minimal snapshot the backend pins alongside the ad. Just enough to
   *  render the board offline if the source de-indexes. */
  snapshot: Record<string, any>
  /** Compact = icon-only (used in grid tile corners). Default = pill with label. */
  compact?: boolean
}

export function SaveToBoardButton({ source, adId, brand, snapshot, compact = false }: Props) {
  const [open, setOpen] = useState(false)
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const rootRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  // Initial membership ping. Cheap (server-side it's a single in-memory
  // scan of boards.json) so we do it on mount rather than lazy-loading
  //. the filled vs. empty icon is the only way the user knows an ad is
  // already saved without clicking.
  useEffect(() => {
    let cancel = false
    const params = new URLSearchParams({ source, ad_id: adId })
    if (brand) params.set('brand', brand)
    fetch(`/api/boards/membership/check?${params.toString()}`)
      .then(r => r.ok ? r.json() : { board_ids: [] })
      .then(d => { if (!cancel) setMemberIds(new Set(d.board_ids || [])) })
      .catch(() => { if (!cancel) setMemberIds(new Set()) })
    return () => { cancel = true }
  }, [source, adId, brand])

  // Outside-click closes the popover. The popover is portaled to
  // document.body, so a mousedown inside it does NOT bubble through the
  // trigger's DOM subtree. we have to check popoverRef explicitly,
  // otherwise clicking "New board" (or any row) inside the popover
  // collapses it before the click handler fires.
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (rootRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [open])

  // Refetch boards when opening. keeps the list fresh against renames /
  // new boards from BoardsMenu in the same session.
  useEffect(() => {
    if (!open) return
    setLoading(true)
    fetch('/api/boards')
      .then(r => r.json())
      .then(d => setBoards(Array.isArray(d.items) ? d.items : []))
      .catch(() => setBoards([]))
      .finally(() => setLoading(false))
  }, [open])

  const isPinned = memberIds.size > 0

  const togglePin = async (board: BoardSummary) => {
    setBusyId(board.id)
    const already = memberIds.has(board.id)
    try {
      if (already) {
        const params = new URLSearchParams()
        if (brand) params.set('brand', brand)
        await fetch(
          `/api/boards/${board.id}/ads/${source}/${encodeURIComponent(adId)}?${params.toString()}`,
          { method: 'DELETE' },
        )
        setMemberIds(prev => {
          const next = new Set(prev)
          next.delete(board.id)
          return next
        })
      } else {
        await fetch(`/api/boards/${board.id}/ads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, ad_id: adId, brand: brand || null, snapshot }),
        })
        setMemberIds(prev => new Set(prev).add(board.id))
      }
    } finally {
      setBusyId(null)
    }
  }

  const createAndPin = async () => {
    const name = newName.trim()
    if (!name) return
    setBusyId('__new__')
    try {
      const r = await fetch('/api/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (r.ok) {
        const b = (await r.json()) as BoardSummary
        await fetch(`/api/boards/${b.id}/ads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, ad_id: adId, brand: brand || null, snapshot }),
        })
        setBoards(prev => [{ ...b, ad_count: 1 }, ...prev])
        setMemberIds(prev => new Set(prev).add(b.id))
        setNewName('')
        setCreating(false)
      }
    } finally {
      setBusyId(null)
    }
  }

  // Compact mode = bookmark icon only. Used in grid card corners where
  // a labeled pill would overwhelm the tile.
  if (compact) {
    return (
      <div ref={rootRef} className="relative inline-block">
        <button
          onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
          className={`p-1.5 rounded-md transition-colors ${
            isPinned
              ? 'text-[#B7410E] bg-[#B7410E]/[0.08] hover:bg-[#B7410E]/[0.14]'
              : 'text-text-muted bg-white/80 hover:bg-white hover:text-text-primary backdrop-blur-sm'
          }`}
          title={isPinned ? 'Saved to board · click to manage' : 'Save to board'}
        >
          {isPinned ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}
        </button>
        {open && (
          <Popover
            anchorRef={rootRef}
            popoverRef={popoverRef}
            boards={boards}
            memberIds={memberIds}
            loading={loading}
            busyId={busyId}
            creating={creating}
            setCreating={setCreating}
            newName={newName}
            setNewName={setNewName}
            onToggle={togglePin}
            onCreate={createAndPin}
          />
        )}
      </div>
    )
  }

  // Pill mode. labeled, used in detail-panel toolbars.
  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        onClick={() => setOpen(o => !o)}
        className={`h-8 px-3 rounded-md text-[12px] flex items-center gap-1.5 transition-colors ${
          isPinned
            ? 'bg-[#B7410E] hover:bg-[#a13a0c] text-white'
            : 'border border-black/[0.08] hover:bg-black/[0.04] text-text-primary'
        }`}
      >
        {isPinned ? <BookmarkCheck size={12} /> : <Bookmark size={12} />}
        {isPinned ? `Saved · ${memberIds.size}` : 'Save to board'}
      </button>
      {open && (
        <Popover
          anchorRef={rootRef}
          popoverRef={popoverRef}
          boards={boards}
          memberIds={memberIds}
          loading={loading}
          busyId={busyId}
          creating={creating}
          setCreating={setCreating}
          newName={newName}
          setNewName={setNewName}
          onToggle={togglePin}
          onCreate={createAndPin}
        />
      )}
    </div>
  )
}

// Extracted to keep the two render paths (compact / pill) DRY without
// duplicating the popover body.
//
// Portaled to document.body with position:fixed so we escape any
// ancestor `overflow:hidden` (the grid card uses one to clip its
// rounded corners, which would otherwise chop the popover off at the
// card edge). Position is read from the trigger's bounding rect on
// mount and on every scroll/resize while open.
function Popover({
  anchorRef, popoverRef, boards, memberIds, loading, busyId,
  creating, setCreating, newName, setNewName,
  onToggle, onCreate,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>
  popoverRef: React.RefObject<HTMLDivElement | null>
  boards: BoardSummary[]
  memberIds: Set<string>
  loading: boolean
  busyId: string | null
  creating: boolean
  setCreating: (v: boolean) => void
  newName: string
  setNewName: (v: string) => void
  onToggle: (b: BoardSummary) => void
  onCreate: () => void
}) {
  const POPOVER_W = 240
  const GUTTER = 8
  const VIEWPORT_PAD = 8
  const ESTIMATED_H = 320  // see comment in recompute()

  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const recompute = () => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (!rect) return
      const vw = window.innerWidth
      const vh = window.innerHeight

      // Horizontal: prefer right-aligned to the trigger (popover hangs
      // down-left). Flip to left-aligned if that clips the left edge,
      // then clamp to keep the right edge inside the viewport too.
      let left = rect.right - POPOVER_W
      if (left < VIEWPORT_PAD) left = rect.left
      if (left + POPOVER_W > vw - VIEWPORT_PAD) left = vw - POPOVER_W - VIEWPORT_PAD

      // Vertical: prefer below the trigger; flip above if there's no
      // room. Content height is dynamic so we conservatively assume
      // ~320px (260px scroll cap + ~60px of chrome).
      let top = rect.bottom + GUTTER
      if (top + ESTIMATED_H > vh - VIEWPORT_PAD) {
        top = rect.top - ESTIMATED_H - GUTTER
        if (top < VIEWPORT_PAD) top = VIEWPORT_PAD
      }

      setPos({ top, left })
    }
    recompute()
    // capture:true so we catch scroll on any ancestor element, not just window.
    window.addEventListener('scroll', recompute, true)
    window.addEventListener('resize', recompute)
    return () => {
      window.removeEventListener('scroll', recompute, true)
      window.removeEventListener('resize', recompute)
    }
  }, [anchorRef])

  if (!pos) return null

  return createPortal(
    <div
      ref={popoverRef}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_W }}
      className="z-50 bg-white rounded-lg shadow-[0_8px_28px_-4px_rgba(0,0,0,0.18)] border border-black/[0.08] overflow-hidden"
      onClick={e => e.stopPropagation()}
    >
      <div className="max-h-[260px] overflow-y-auto">
        {loading && (
          <div className="px-3 py-3 text-[11px] text-text-muted flex items-center gap-1.5">
            <Loader2 size={11} className="animate-spin" />
            Loading…
          </div>
        )}
        {!loading && boards.length === 0 && (
          <div className="px-3 py-3 text-[11px] text-text-muted text-center">
            No boards yet
          </div>
        )}
        {boards.map(b => {
          const isPinned = memberIds.has(b.id)
          const busy = busyId === b.id
          return (
            <button
              key={b.id}
              onClick={() => onToggle(b)}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-black/[0.03] text-left"
            >
              <span
                className={`w-4 h-4 rounded-[4px] border flex items-center justify-center shrink-0 ${
                  isPinned
                    ? 'bg-[#B7410E] border-[#B7410E] text-white'
                    : 'border-black/[0.18] bg-white'
                }`}
              >
                {busy ? <Loader2 size={9} className="animate-spin" /> : isPinned && <Check size={10} />}
              </span>
              <span className="flex-1 text-[11px] truncate">{b.name}</span>
              <span className="text-[10px] text-text-muted tabular-nums">{b.ad_count}</span>
            </button>
          )
        })}
      </div>
      <div className="border-t border-black/[0.04] px-2 py-1.5 bg-black/[0.015]">
        {creating ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') onCreate()
                if (e.key === 'Escape') { setCreating(false); setNewName('') }
              }}
              placeholder="Board name…"
              className="flex-1 h-7 px-2 rounded-md text-[11px] border border-[#B7410E]/40 focus:outline-none"
            />
            <button
              onClick={onCreate}
              disabled={!newName.trim() || busyId === '__new__'}
              className="h-7 px-2 rounded-md bg-[#B7410E] hover:bg-[#a13a0c] text-white text-[11px] disabled:opacity-60"
            >
              {busyId === '__new__' ? <Loader2 size={10} className="animate-spin" /> : 'Add'}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-md hover:bg-black/[0.04] text-[11px] text-text-secondary"
          >
            <Plus size={11} />
            New board
          </button>
        )}
      </div>
    </div>,
    document.body,
  )
}

export default SaveToBoardButton
