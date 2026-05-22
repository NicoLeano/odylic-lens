/**
 * BoardsMenu. Atelier's saved-ad boards dropdown.
 *
 * Lives next to ReportsMenu in the Creative Analysis toolbar. Same pill +
 * popover visual idiom on purpose. the user explicitly asked for boards
 * to feel "reminiscent of the reports UI" so we mirror its affordances:
 *   - Pill button at the top of the toolbar (`Boards ▾`)
 *   - Popover lists boards, each row shows ad count
 *   - Click a row → opens the board (parent handles routing)
 *   - + New board… → inline input → POST /api/boards
 *   - Per-row kebab: rename / delete
 *
 * Unlike ReportsMenu we don't have date modes / publishing. boards are
 * just curated ad collections, no auto-refresh logic, no exports.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Bookmark, ChevronDown, Loader2, Plus, Pencil, Trash2,
  Check, X as XIcon, Search,
} from 'lucide-react'

export type BoardSummary = {
  id: string
  name: string
  ad_count: number
  created_at: number | null
  updated_at: number | null
}

type Props = {
  /** Fired when the user clicks a board row. parent opens the detail view. */
  onOpen?: (board: BoardSummary) => void
  /** Currently-open board id, used for a subtle "active" highlight. */
  activeId?: string | null
  /** Fired after any mutation (create/rename/delete) so parents can refetch. */
  onMutated?: () => void
}

export function BoardsMenu({ onOpen, activeId, onMutated }: Props) {
  const [open, setOpen] = useState(false)
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // Popover alignment. defaults to anchoring on the trigger's left edge,
  // but flips to the right edge if there isn't 280px of room to the right
  // (e.g. when BoardsMenu is rendered at the far right of the toolbar via
  // ml-auto, the old left-anchored popover ran off the viewport).
  const [align, setAlign] = useState<'left' | 'right'>('left')
  useLayoutEffect(() => {
    if (!open) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const POPOVER_W = 280
    const PAD = 8
    const roomRight = window.innerWidth - rect.left - POPOVER_W - PAD
    setAlign(roomRight < 0 ? 'right' : 'left')
  }, [open])

  // Outside-click closes the popover. same listener style as ReportsMenu
  // so the close behavior matches what the user already expects from the
  // other dropdowns in the toolbar.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  const refresh = async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/boards')
      const d = await r.json()
      setBoards(Array.isArray(d.items) ? d.items : [])
    } catch {
      setBoards([])
    }
    setLoading(false)
  }
  // Refetch when the popover opens. keeps the list fresh if another tab
  // / another session pinned something to a board in the meantime.
  useEffect(() => { if (open) refresh() }, [open])

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return boards
    return boards.filter(b => b.name.toLowerCase().includes(n))
  }, [boards, q])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    try {
      const r = await fetch('/api/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (r.ok) {
        setNewName('')
        setCreating(false)
        await refresh()
        onMutated?.()
      }
    } finally {
      setBusy(false)
    }
  }

  const handleRename = async (board: BoardSummary) => {
    const name = renameDraft.trim()
    if (!name || name === board.name) {
      setRenamingId(null)
      return
    }
    setBusy(true)
    try {
      await fetch(`/api/boards/${board.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      setRenamingId(null)
      await refresh()
      onMutated?.()
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (board: BoardSummary) => {
    // Always confirm. boards may contain dozens of pinned ads and we
    // don't keep an undo trail. Cheap protection against fat-fingers.
    if (!window.confirm(`Delete board "${board.name}"? This can't be undone.`)) return
    setBusy(true)
    try {
      await fetch(`/api/boards/${board.id}`, { method: 'DELETE' })
      await refresh()
      onMutated?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        className="h-7 px-2.5 rounded-full text-[11px] flex items-center gap-1 glass glass-hover text-text-secondary"
        title="Boards"
      >
        <Bookmark size={11} />
        Boards
        <ChevronDown size={11} className="-mr-0.5" />
      </button>

      {open && (
        <div
          className={`absolute top-[calc(100%+6px)] z-40 w-[280px] bg-white rounded-xl shadow-[0_8px_28px_-4px_rgba(0,0,0,0.18)] border border-black/[0.08] overflow-hidden ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
          role="menu"
        >
          {/* Search bar. matches ReportsMenu */}
          <div className="px-3 py-2 border-b border-black/[0.04]">
            <div className="relative">
              <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Search boards…"
                className="w-full h-7 pl-6 pr-2 rounded-md text-[11px] bg-black/[0.03] border border-transparent focus:outline-none focus:border-[#B7410E]/30 focus:bg-white"
              />
            </div>
          </div>

          {/* List */}
          <div className="max-h-[320px] overflow-y-auto">
            {loading && (
              <div className="px-3 py-3 text-[11px] text-text-muted flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" />
                Loading…
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="px-3 py-4 text-center text-[11px] text-text-muted">
                {q ? `No boards match "${q}"` : 'No boards yet. create one below.'}
              </div>
            )}
            {!loading && filtered.map(b => (
              <div
                key={b.id}
                className={`group flex items-center gap-2 px-2 py-1.5 hover:bg-black/[0.03] ${
                  activeId === b.id ? 'bg-[#B7410E]/[0.06]' : ''
                }`}
              >
                {renamingId === b.id ? (
                  <>
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={e => setRenameDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRename(b)
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      className="flex-1 h-6 px-1.5 text-[11px] rounded-md border border-[#B7410E]/40 focus:outline-none"
                    />
                    <button
                      onClick={() => handleRename(b)}
                      className="p-1 rounded-md hover:bg-black/[0.04] text-emerald-700"
                      title="Save"
                    >
                      <Check size={11} />
                    </button>
                    <button
                      onClick={() => setRenamingId(null)}
                      className="p-1 rounded-md hover:bg-black/[0.04] text-text-muted"
                      title="Cancel"
                    >
                      <XIcon size={11} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        onOpen?.(b)
                        setOpen(false)
                      }}
                      className="flex-1 flex items-center gap-2 text-left min-w-0"
                    >
                      <Bookmark
                        size={11}
                        className={activeId === b.id ? 'text-[#B7410E]' : 'text-text-muted'}
                      />
                      <span className={`flex-1 truncate text-[11px] ${
                        activeId === b.id ? 'text-[#B7410E] font-medium' : 'text-text-primary'
                      }`}>
                        {b.name}
                      </span>
                      <span className="text-[10px] text-text-muted tabular-nums">{b.ad_count}</span>
                    </button>
                    <button
                      onClick={() => {
                        setRenameDraft(b.name)
                        setRenamingId(b.id)
                      }}
                      className="p-1 rounded-md hover:bg-black/[0.04] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Rename"
                    >
                      <Pencil size={10} />
                    </button>
                    <button
                      onClick={() => handleDelete(b)}
                      className="p-1 rounded-md hover:bg-red-50 text-text-muted hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Delete board"
                    >
                      <Trash2 size={10} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* Create row */}
          <div className="border-t border-black/[0.04] px-2 py-1.5 bg-black/[0.015]">
            {creating ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleCreate()
                    if (e.key === 'Escape') {
                      setCreating(false)
                      setNewName('')
                    }
                  }}
                  placeholder="Board name…"
                  className="flex-1 h-7 px-2 rounded-md text-[11px] border border-[#B7410E]/40 focus:outline-none"
                />
                <button
                  onClick={handleCreate}
                  disabled={busy || !newName.trim()}
                  className="h-7 px-2 rounded-md bg-[#B7410E] hover:bg-[#a13a0c] text-white text-[11px] disabled:opacity-60"
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : 'Create'}
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
        </div>
      )}
    </div>
  )
}

export default BoardsMenu
