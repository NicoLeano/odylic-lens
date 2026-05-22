// Atria-style Saved Reports dropdown for the Ad Analysis tab.
//
// Renders a "Reports ▾" pill next to the other filter pills; the popover
// lists saved reports, lets the user load / rename / delete any of them,
// save the current view as a new report, and (when a report is loaded and
// the user has edited state since) show a "Save changes" affordance.
//
// Dirtiness is fully handled by the parent via the `dirty` prop. the menu
// just surfaces the UI. The config snapshot is whatever JSON the parent
// passes into `captureConfig` / receives via `onLoad`.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Pencil, Trash2, Save, Plus, Check, X as XIcon, Search, FolderOpen, Loader2, Radio, Square, Eye, Share2 } from 'lucide-react'

// Date-mode options map to server-side `_effective_date_range`. Static
// pins the report to its saved dates; rolling modes recompute the window
// at every export (including the nightly daily.py refresh). Dynamic
// captures the *length* of the currently-selected range and rolls it
// forward. e.g. saving with "Last 14 days" selected gives a 14-day
// window that updates daily.
const DATE_MODES: { key: string; label: string; hint: string }[] = [
  { key: 'static', label: 'Static', hint: 'Pin to these exact dates' },
  { key: 'rolling_7d', label: 'Rolling 7-day', hint: 'Last 7 days, updates daily' },
  { key: 'rolling_30d', label: 'Rolling 30-day', hint: 'Last 30 days, updates daily' },
  { key: 'weekly_mon_sun', label: 'Weekly (Mon–Sun)', hint: 'Last complete week' },
  { key: 'dynamic', label: 'Dynamic', hint: 'Rolls the saved range length daily' },
]

export type SavedReport = {
  name: string
  brand: string
  created_at: string
  updated_at: string
  config: Record<string, any>
}

type Props = {
  brand: string
  // Snapshot of current view. written when user picks "Save current as…" /
  // "Save changes".
  captureConfig: () => Record<string, any>
  // Called when user picks a report from the list.
  onLoad: (report: SavedReport) => void
  // Currently active report name (null = none active).
  activeName: string | null
  // Parent-maintained dirty flag (true when the user has edited state since
  // the active report was loaded).
  dirty: boolean
  // Fired after a save so the parent can reset its dirty flag.
  onSaved?: (report: SavedReport) => void
  // Fired after an active report is deleted.
  onDeleted?: (name: string) => void
  // Fired after a rename.
  onRenamed?: (oldName: string, newName: string) => void
  // Called when user clicks the X on the active-report pill to exit the
  // loaded report and return to the unsaved/default view.
  onClear?: () => void
}

export function ReportsMenu({
  brand, captureConfig, onLoad, activeName, dirty, onSaved, onDeleted, onRenamed, onClear,
}: Props) {
  const [open, setOpen] = useState(false)
  const [reports, setReports] = useState<SavedReport[]>([])
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')

  const [saving, setSaving] = useState(false)
  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  // Extra per-report metadata captured at save time: a folder bucket
  // (used as the on-disk directory for exports + for grouping in this
  // menu) and a date mode that controls whether nightly cron re-exports
  // the report with a fresh window.
  const [saveFolder, setSaveFolder] = useState('')
  const [saveDateMode, setSaveDateMode] = useState<string>('static')
  const [saveClient, setSaveClient] = useState('')

  const [renamingName, setRenamingName] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  // Publish / export state per-report (keyed by name). Tracks in-flight
  // export requests so multi-clicks on the Publish button don't race.
  // Per-row publishing state removed alongside the export-HTML flow.

  const rootRef = useRef<HTMLDivElement>(null)

  // Close on outside click
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

  // Load reports whenever brand changes or the popover opens.
  const refresh = async () => {
    if (!brand) { setReports([]); return }
    setLoading(true)
    try {
      const r = await fetch(`/api/ads/reports?brand=${encodeURIComponent(brand)}`)
      const d = await r.json()
      setReports(Array.isArray(d.reports) ? d.reports : [])
    } catch {
      setReports([])
    }
    setLoading(false)
  }
  useEffect(() => { if (open) refresh() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, brand])

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return reports
    return reports.filter(r => r.name.toLowerCase().includes(n))
  }, [reports, q])

  const handleLoad = (r: SavedReport) => {
    onLoad(r)
    setOpen(false)
  }

  const doSave = async (
    name: string,
    extras?: { folder?: string; date_mode?: string; client?: string; title?: string },
  ) => {
    if (!name.trim() || !brand) return
    setSaving(true)
    try {
      // Merge the user-facing extras into the live config snapshot so the
      // backend doesn't need to know about folders / date modes directly
      // (it stores config as free-form JSON).
      const cfg = captureConfig()
      if (extras?.folder !== undefined) cfg.folder = extras.folder
      if (extras?.date_mode !== undefined) cfg.date_mode = extras.date_mode
      if (extras?.client !== undefined) cfg.client = extras.client
      if (extras?.title !== undefined) cfg.title = extras.title
      // Dynamic mode: capture the *length* of the currently-selected
      // range so the backend can roll a same-length window forward.
      if (extras?.date_mode === 'dynamic' && cfg.start && cfg.end) {
        const s = new Date(`${cfg.start}T00:00:00`)
        const e = new Date(`${cfg.end}T00:00:00`)
        const days = Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1)
        cfg.dynamic_window_days = days
      }
      const r = await fetch(`/api/ads/reports?brand=${encodeURIComponent(brand)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), config: cfg }),
      })
      const d = await r.json()
      if (d?.report) {
        onSaved?.(d.report as SavedReport)
        await refresh()
      }
    } catch {}
    setSaving(false)
    setSaveModalOpen(false)
    setSaveName('')
    setSaveFolder('')
    setSaveClient('')
    setSaveDateMode('static')
  }

  const handleSaveAs = () => {
    // Pre-fill the modal from whatever the active report had set. makes
    // the common "edit-and-resave" flow zero-click on metadata.
    const activeRow = reports.find(r => r.name === activeName)
    const cfg = activeRow?.config || {}
    setSaveName(activeName || '')
    setSaveFolder(String(cfg.folder || ''))
    setSaveClient(String(cfg.client || ''))
    setSaveDateMode(String(cfg.date_mode || 'static'))
    setSaveModalOpen(true)
  }
  const handleSaveChanges = async () => {
    if (!activeName) return
    const activeRow = reports.find(r => r.name === activeName)
    const cfg = activeRow?.config || {}
    await doSave(activeName, {
      folder: cfg.folder, date_mode: cfg.date_mode,
      client: cfg.client, title: cfg.title,
    })
  }

  // Single-file HTML "Publish" flow was removed in Lens v0.2. Reports
  // are local-only; use the DownloadMenu (next to Refresh) to export
  // a CSV or print the view as PDF. Keeping the empty signature stub
  // here would just rot. gone.

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete report "${name}"?`)) return
    try {
      await fetch(`/api/ads/reports?brand=${encodeURIComponent(brand)}&name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
      })
      onDeleted?.(name)
      await refresh()
    } catch {}
  }

  const startRename = (name: string) => {
    setRenamingName(name)
    setRenameDraft(name)
  }
  const commitRename = async () => {
    const old = renamingName
    const fresh = renameDraft.trim()
    setRenamingName(null)
    if (!old || !fresh || fresh === old) return
    try {
      const r = await fetch(
        `/api/ads/reports?brand=${encodeURIComponent(brand)}&name=${encodeURIComponent(old)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ new_name: fresh }),
        },
      )
      if (r.ok) {
        onRenamed?.(old, fresh)
        await refresh()
      }
    } catch {}
  }

  // Display label on the pill.
  const pillLabel = activeName
    ? `${activeName}${dirty ? ' · edited' : ''}`
    : 'Reports'

  return (
    <div className="relative inline-flex items-center" ref={rootRef}>
      <button
        onClick={() => setOpen(v => !v)}
        className={`h-7 px-2.5 rounded-full text-[11px] flex items-center gap-1.5 transition-colors ${
          activeName
            ? 'bg-[#B7410E]/10 border border-[#B7410E]/30 text-[#b55719]'
            : 'glass glass-hover text-text-secondary'
        } ${activeName ? 'pr-1.5' : ''}`}
      >
        <Save size={10} />
        <span className="max-w-[180px] truncate">{pillLabel}</span>
        <ChevronDown size={9} />
        {/* Inline X. clears the active report without opening the
            dropdown. Only visible when a report is loaded. */}
        {activeName && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onClear?.() }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                e.preventDefault()
                onClear?.()
              }
            }}
            title="Exit report. return to default view"
            className="ml-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full hover:bg-[#B7410E]/20 text-[#b55719] cursor-pointer"
          >
            <XIcon size={10} />
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 bg-white rounded-xl shadow-xl border border-black/[0.06] min-w-[280px] max-w-[340px] py-1"
        >
          {/* Search */}
          <div className="px-2 py-1.5 sticky top-0 bg-white z-10 border-b border-black/[0.04]">
            <div className="relative">
              <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                type="text"
                placeholder="Search reports..."
                value={q}
                onChange={e => setQ(e.target.value)}
                autoFocus
                className="w-full bg-white/60 border border-black/[0.08] rounded-lg pl-6 pr-2 py-1 text-xs focus:outline-none"
              />
            </div>
          </div>

          {/* "Save changes". only visible when the active report is dirty */}
          {activeName && dirty && (
            <button
              onClick={handleSaveChanges}
              disabled={saving}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#B7410E] hover:bg-[#B7410E]/[0.05] border-b border-black/[0.04] disabled:opacity-50"
            >
              <Save size={10} />
              Save changes to "{activeName}"
            </button>
          )}

          {/* List. grouped by folder so reports for the same client cluster
              together. Reports with no folder fall into an "Unsorted" bucket. */}
          <div className="max-h-[320px] overflow-y-auto">
            {loading ? (
              <div className="px-3 py-3 text-[11px] text-text-muted">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-3 text-[11px] text-text-muted">
                {reports.length ? 'No matches.' : 'No saved reports yet.'}
              </div>
            ) : (
              // Group by folder; keep folder order stable by first-seen.
              (() => {
                const groups = new Map<string, SavedReport[]>()
                for (const r of filtered) {
                  const key = String(r.config?.folder || '').trim() || '__none__'
                  if (!groups.has(key)) groups.set(key, [])
                  groups.get(key)!.push(r)
                }
                return Array.from(groups.entries()).map(([folder, rows]) => (
                  <div key={folder}>
                    <div className="flex items-center gap-1 px-2 pt-2 pb-0.5 text-[9px] uppercase tracking-wide text-text-muted">
                      <FolderOpen size={9} />
                      <span className="truncate">{folder === '__none__' ? 'Unsorted' : folder}</span>
                      <span className="text-text-muted/60">· {rows.length}</span>
                    </div>
                    {rows.map(r => {
                      const isActive = r.name === activeName
                      const isRenaming = renamingName === r.name
                      const mode = String(r.config?.date_mode || 'static')
                      const modeBadge = DATE_MODES.find(m => m.key === mode)?.label || mode
                      const lastExport = r.config?.last_export?.at
                        ? `Published ${new Date(String(r.config.last_export.at)).toLocaleDateString()}`
                        : 'Not published yet'
                      return (
                        <div
                          key={r.name}
                          className={`group flex items-center gap-1.5 px-2 py-1 hover:bg-black/[0.03] text-xs ${
                            isActive ? 'bg-[#B7410E]/[0.05]' : ''
                          }`}
                        >
                          {/* Active dot */}
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            isActive ? 'bg-[#B7410E]' : 'bg-transparent'
                          }`} />

                          {isRenaming ? (
                            <>
                              <input
                                autoFocus
                                value={renameDraft}
                                onChange={e => setRenameDraft(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') commitRename()
                                  else if (e.key === 'Escape') { setRenamingName(null) }
                                }}
                                className="flex-1 bg-white border border-black/[0.1] rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-[#B7410E]"
                              />
                              <button onClick={commitRename} className="p-0.5 rounded hover:bg-emerald-500/10 text-emerald-600" title="Save">
                                <Check size={11} />
                              </button>
                              <button onClick={() => setRenamingName(null)} className="p-0.5 rounded hover:bg-black/[0.04] text-text-muted" title="Cancel">
                                <XIcon size={11} />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => handleLoad(r)}
                                className="flex-1 min-w-0 text-left truncate text-text-primary py-0.5"
                                title={`${lastExport}\nUpdated ${r.updated_at || ''}`}
                              >
                                <span className="truncate">{r.name}</span>
                                <span className="ml-1 text-[9px] text-text-muted">· {modeBadge}</span>
                                {isActive && dirty && (
                                  <span className="text-[9px] text-[#B7410E] ml-1">· edited</span>
                                )}
                              </button>
                              {/* Publish-as-HTML button removed in v0.2. Use
                                  the Download menu (CSV / Print to PDF)
                                  next to the Refresh button instead. */}
                              <button
                                onClick={(e) => { e.stopPropagation(); startRename(r.name) }}
                                className="p-0.5 rounded hover:bg-black/[0.04] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity"
                                title="Rename"
                              >
                                <Pencil size={10} />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDelete(r.name) }}
                                className="p-0.5 rounded hover:bg-red-500/10 text-text-muted hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                                title="Delete"
                              >
                                <Trash2 size={10} />
                              </button>
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))
              })()
            )}
          </div>

          {/* Save as new */}
          <div className="border-t border-black/[0.04] p-1">
            <button
              onClick={handleSaveAs}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs text-text-secondary hover:bg-black/[0.03] rounded"
            >
              <Plus size={10} />
              Save current as…
            </button>
          </div>
        </div>
      )}

      {/* Share-link modal V2. two-column layout matching the
          reference design. Left rail lists existing shares with date +
          view counts; right side is the Create Share Link form
          (Updating/Static toggle, name, description, password, future
          tracking opt-ins). Replaces the older Save Report modal. */}
      {saveModalOpen && (
        <ShareLinkModal
          mode="updating"
          onClose={() => setSaveModalOpen(false)}
          existing={reports}
          defaultName={saveName}
          defaultFolder={saveFolder || brand}
          defaultClient={saveClient || brand}
          defaultDateMode={saveDateMode}
          saving={saving}
          activeName={activeName}
          onSave={(name, extras) => doSave(name, extras)}
        />
      )}
    </div>
  )
}


// ---------------------------------------------------------------------------
// ShareLinkModal. two-column share creation surface (item #13). Replaces
// the older "Save report" form with a layout that mirrors typical sharing
// UX: existing shares on the left rail, the create-link form on the right.
//
// What's wired today:
//   • Updating ↔ Static toggle (drives `date_mode`. Dynamic | Static)
//   • Static date range field (display-only; honors whatever the dashboard
//     date picker had selected when the modal opened)
//   • Report name + description inputs
//   • Folder + client metadata
//   • Password protect toggle (stub. backend hook TBD)
//   • Track Opens & IPs / Show Comments. labelled "Coming soon"
// ---------------------------------------------------------------------------

interface ShareLinkModalProps {
  mode: 'updating' | 'static'
  onClose: () => void
  existing: SavedReport[]
  defaultName: string
  defaultFolder?: string
  defaultClient?: string
  defaultDateMode: string
  saving: boolean
  activeName: string | null
  onSave: (
    name: string,
    extras: { folder?: string; client?: string; date_mode?: string; title?: string; description?: string; password?: string },
  ) => void
}

function ShareLinkModal({
  onClose, existing, defaultName, defaultFolder, defaultClient,
  defaultDateMode, saving, activeName, onSave,
}: ShareLinkModalProps) {
  // Map the legacy date_mode values into the simpler Updating/Static binary
  // the design calls for. Dynamic / Rolling 7d / Rolling 30d / Weekly all
  // count as "updating"; Static / Custom are "static".
  const initialKind: 'updating' | 'static' =
    defaultDateMode === 'static' || defaultDateMode === 'custom' ? 'static' : 'updating'

  const [kind, setKind] = useState<'updating' | 'static'>(initialKind)
  const [name, setName] = useState(defaultName || '')
  const [folder, setFolder] = useState(defaultFolder || '')
  const [client, setClient] = useState(defaultClient || '')
  const [description, setDescription] = useState('')
  const [updatingMode, setUpdatingMode] = useState<string>(
    initialKind === 'updating' ? (defaultDateMode === 'static' ? 'dynamic' : defaultDateMode) : 'dynamic'
  )

  const handleCreate = () => {
    const finalDateMode = kind === 'static' ? 'static' : updatingMode
    onSave(name, {
      folder: folder || undefined,
      client: client || undefined,
      date_mode: finalDateMode,
      title: name,
      description: description || undefined,
      // Password removed in v0.2. reports are local single-user, so
      // there's no public share-link surface that would need one.
    })
  }

  return (
    <div
      className="fixed inset-0 z-[100001] flex items-center justify-center"
      style={{ background: 'rgba(20,20,20,0.45)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="rounded-2xl shadow-2xl border border-white/40 flex w-[820px] max-h-[80vh] overflow-hidden"
        style={{ background: 'rgba(255,255,255,0.94)', backdropFilter: 'blur(40px) saturate(180%)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Left rail. past shares */}
        <aside className="w-[220px] flex flex-col border-r border-black/[0.06] bg-white/40">
          <div className="px-3 py-3 flex items-center gap-1.5 border-b border-black/[0.06]">
            <Share2 size={11} className="text-text-muted" />
            <div className="text-[10px] uppercase tracking-widest text-text-muted font-medium">Shares</div>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {existing.length === 0 && (
              <div className="px-3 py-6 text-[11px] text-text-muted">
                No shares yet. create your first link on the right.
              </div>
            )}
            {existing.map(r => {
              const cfg = (r.config || {}) as Record<string, unknown>
              const created = cfg.created_at || r.created_at
              const isActive = activeName === r.name
              const dateMode = String(cfg.date_mode || 'static')
              return (
                <button
                  key={r.name}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-black/[0.03] ${
                    isActive ? 'bg-[#B7410E]/[0.06]' : ''
                  }`}
                  title={`${r.name} · ${dateMode}`}
                  onClick={() => { /* future: load this share for re-edit */ }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: dateMode === 'static' ? '#9ca3af' : '#10b981' }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] truncate text-text-primary">{r.name}</div>
                    {created && (
                      <div className="text-[9px] text-text-muted tabular-nums">
                        {new Date(String(created)).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                  <span className="text-[10px] text-text-muted flex items-center gap-0.5">
                    <Eye size={9} /> 0
                  </span>
                </button>
              )
            })}
          </div>
        </aside>

        {/* Right side. create form */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-5 py-3 border-b border-black/[0.06]">
            <div className="font-display text-base font-medium text-text-primary">Save report</div>
            <button
              onClick={handleCreate}
              disabled={saving || !name.trim()}
              className="h-8 px-4 rounded-full text-[11px] font-medium flex items-center gap-1.5 disabled:opacity-40 transition-colors"
              style={{ background: 'rgba(183,65,14,0.10)', border: '1px solid rgba(183,65,14,0.30)', color: '#b55719' }}
              onMouseEnter={e => { if (!saving && name.trim()) e.currentTarget.style.background = 'rgba(183,65,14,0.18)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(183,65,14,0.10)' }}
            >
              {saving
                ? <><Loader2 size={11} className="animate-spin" /> Saving…</>
                : <>Save report</>}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
            {/* Updating vs Static. two big tile buttons */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setKind('updating')}
                className={`text-left px-3 py-2.5 rounded-xl transition-all ${
                  kind === 'updating'
                    ? 'bg-[#B7410E]/[0.06] border-[1.5px] border-[#B7410E]/40'
                    : 'border border-black/[0.10] hover:bg-black/[0.02]'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Radio size={11} style={{ color: kind === 'updating' ? '#B7410E' : '#6b7280' }} />
                  <span className={`text-[12px] font-medium ${kind === 'updating' ? 'text-[#b55719]' : 'text-text-primary'}`}>
                    Updating
                  </span>
                </div>
                <div className="text-[10.5px] text-text-muted leading-snug">
                  Share link that updates with a rolling date range.
                </div>
              </button>
              <button
                onClick={() => setKind('static')}
                className={`text-left px-3 py-2.5 rounded-xl transition-all ${
                  kind === 'static'
                    ? 'bg-[#B7410E]/[0.06] border-[1.5px] border-[#B7410E]/40'
                    : 'border border-black/[0.10] hover:bg-black/[0.02]'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Square size={11} style={{ color: kind === 'static' ? '#B7410E' : '#6b7280' }} />
                  <span className={`text-[12px] font-medium ${kind === 'static' ? 'text-[#b55719]' : 'text-text-primary'}`}>
                    Static
                  </span>
                </div>
                <div className="text-[10.5px] text-text-muted leading-snug">
                  Share with a static date range and no updates.
                </div>
              </button>
            </div>

            {/* Conditional. Updating: pick rolling type. Static: shows the
                date range that was active when the modal opened. */}
            {kind === 'updating' && (
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-text-muted font-medium mb-1.5">
                  Rolling window
                </label>
                <div className="grid grid-cols-2 gap-1">
                  {DATE_MODES.filter(m => m.key !== 'static').map(m => (
                    <button
                      key={m.key}
                      onClick={() => setUpdatingMode(m.key)}
                      className={`text-left px-2.5 py-1.5 rounded-lg text-[11px] transition-colors ${
                        updatingMode === m.key
                          ? 'bg-[#B7410E]/[0.08] text-[#b55719]'
                          : 'hover:bg-black/[0.03] text-text-secondary'
                      }`}
                    >
                      <div className="font-medium">{m.label}</div>
                      <div className="text-[9.5px] text-text-muted">{m.hint}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Report name */}
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-text-muted font-medium mb-1.5">
                Report name
              </label>
              <input
                type="text"
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') onClose() }}
                placeholder="e.g. Top Performers"
                className="w-full bg-white/70 border border-black/[0.10] rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-[#B7410E]"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-text-muted font-medium mb-1.5">
                Description
              </label>
              <input
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="N/A"
                className="w-full bg-white/70 border border-black/[0.10] rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-[#B7410E]"
              />
            </div>

            {/* Folder + Client */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-text-muted font-medium mb-1.5">
                  <FolderOpen size={9} className="inline -mt-0.5 mr-0.5" /> Folder
                </label>
                <input
                  type="text"
                  value={folder}
                  onChange={e => setFolder(e.target.value)}
                  placeholder={defaultFolder || 'e.g. Kinn'}
                  className="w-full bg-white/70 border border-black/[0.10] rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-[#B7410E]"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-text-muted font-medium mb-1.5">
                  Client
                </label>
                <input
                  type="text"
                  value={client}
                  onChange={e => setClient(e.target.value)}
                  placeholder="Optional"
                  className="w-full bg-white/70 border border-black/[0.10] rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-[#B7410E]"
                />
              </div>
            </div>

            {/* Report security removed. reports are local single-user
                in Lens, so password protection added nothing. */}
          </div>
        </div>
      </div>
    </div>
  )
}
