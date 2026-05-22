// Motion-style filter popovers. Two entry-point pill buttons ("Dimension
// filter" / "Metric filter") open small modals below the pill with a
// multi-row predicate builder. Header / clear-all / cancel / apply layout
// mirrors the Motion screenshots the user shared.
//
// Evaluation helpers (`matchesFilters`, `matchesDimensionFilters`) are
// exported so the parent applies them in its filteredAds memo. We keep the
// underlying AND/OR semantics from the previous implementation. only the
// UX shell has changed.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, X as XIcon, Filter as FilterIcon, ChevronDown } from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricOption = { key: string; label: string; unit?: 'dollar' | 'percent' | 'number' | 'decimal' }

export type FilterOp = '>' | '>=' | '<' | '<=' | '=' | '!='

export type MetricFilter = {
  id: string
  metric: string
  op: FilterOp
  value: number
}

export type JoinMode = 'AND' | 'OR'

// A dimension is any categorical field: campaign / ad name / asset type /
// status / analysis tags (angle, persona, …). Values can be an exact-match
// list ("is one of") OR a text predicate (contains / starts with / equals).
export type DimensionOp = 'is' | 'is_not' | 'contains' | 'starts_with'

export type DimensionFilter = {
  id: string
  field: string                  // dimension key, e.g. 'campaign_name', 'analysis_angle'
  op: DimensionOp
  // For 'is' / 'is_not' we store selected values (multi). For contains /
  // starts_with we store a free-text needle in `text`.
  values: string[]
  text: string
}

export type DimensionFieldDef = {
  key: string
  label: string
  // Static known values (e.g. asset types). If omitted the picker pulls
  // unique values from the dataset at runtime.
  options?: string[]
}

// ---------------------------------------------------------------------------
// Evaluators
// ---------------------------------------------------------------------------

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function newMetricFilter(metric = 'spend'): MetricFilter {
  return { id: uid(), metric, op: '>', value: 0 }
}

export function newDimensionFilter(field = 'campaign_name'): DimensionFilter {
  return { id: uid(), field, op: 'is', values: [], text: '' }
}

export function matchesFilters(
  row: Record<string, any>,
  filters: MetricFilter[],
  join: JoinMode,
): boolean {
  if (!filters.length) return true
  const results = filters.map((f) => {
    const raw = row[f.metric]
    const n = Number(raw)
    if (raw === undefined || raw === null || Number.isNaN(n)) return false
    switch (f.op) {
      case '>': return n > f.value
      case '>=': return n >= f.value
      case '<': return n < f.value
      case '<=': return n <= f.value
      case '=': return n === f.value
      case '!=': return n !== f.value
    }
  })
  return join === 'AND' ? results.every(Boolean) : results.some(Boolean)
}

// Read a dimension value off the row. `analysis_*` keys map directly on the
// enriched ad rows (merged in the parent); everything else is a raw field.
function readDimValue(row: Record<string, any>, field: string): string {
  const v = row[field]
  if (v === null || v === undefined) return ''
  return String(v)
}

export function matchesDimensionFilters(
  row: Record<string, any>,
  filters: DimensionFilter[],
  join: JoinMode,
): boolean {
  if (!filters.length) return true
  const results = filters.map((f) => {
    const val = readDimValue(row, f.field)
    const valLower = val.toLowerCase()
    switch (f.op) {
      case 'is': {
        if (!f.values.length) return true // unconfigured row is a pass-through
        return f.values.includes(val)
      }
      case 'is_not': {
        if (!f.values.length) return true
        return !f.values.includes(val)
      }
      case 'contains': {
        if (!f.text.trim()) return true
        return valLower.includes(f.text.trim().toLowerCase())
      }
      case 'starts_with': {
        if (!f.text.trim()) return true
        return valLower.startsWith(f.text.trim().toLowerCase())
      }
    }
  })
  return join === 'AND' ? results.every(Boolean) : results.some(Boolean)
}

// ---------------------------------------------------------------------------
// Shared popover shell
// ---------------------------------------------------------------------------

// The popover uses a fixed backdrop overlay for outside-click + a positioned
// absolute panel just below the anchor. No third-party popover lib.
function PopoverShell({
  anchorRef, onClose, width, children,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  width: number
  children: React.ReactNode
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    // Anchor below the pill; clamp horizontally so the panel stays on-screen.
    // Using fixed positioning -> viewport coords, no scroll offset needed.
    const top = rect.bottom + 6
    let left = rect.left
    const vw = window.innerWidth
    if (left + width > vw - 12) left = Math.max(12, vw - width - 12)
    setPos({ top, left })
  }, [anchorRef, width])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!pos) return null

  return (
    <>
      {/* Click-out backdrop; transparent but captures clicks */}
      <div
        className="fixed inset-0 z-[60]"
        onClick={onClose}
        style={{ background: 'transparent' }}
      />
      <div
        role="dialog"
        className="fixed z-[61] bg-white rounded-xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.18),0_2px_6px_rgba(0,0,0,0.08)] border border-black/[0.06]"
        style={{ top: pos.top, left: pos.left, width }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>
  )
}

// Thin bordered dropdown styled to match the Motion screenshots. `children`
// renders the menu body.
function DropdownButton({
  label, open, onToggle, width, className = '',
}: {
  label: React.ReactNode
  open: boolean
  onToggle: () => void
  width?: number
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={width ? { width } : undefined}
      className={`h-8 px-2.5 rounded-md border text-[12px] flex items-center justify-between gap-1.5 bg-white transition-colors ${
        open ? 'border-[#B7410E]/60 ring-1 ring-[#B7410E]/30' : 'border-black/[0.12] hover:border-black/25'
      } ${className}`}
    >
      <span className="truncate text-left text-text-primary">{label}</span>
      <ChevronDown size={12} className="text-text-muted flex-shrink-0" />
    </button>
  )
}

// Dropdown menu body. absolutely positioned under its anchor. Uses the
// parent `relative` wrapper for positioning.
function DropdownMenu({
  open, onClose, children, width,
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      ref={ref}
      style={width ? { width } : undefined}
      className="absolute left-0 top-full mt-1 z-[70] bg-white rounded-md shadow-[0_6px_24px_-4px_rgba(0,0,0,0.18)] border border-black/[0.08] py-1 max-h-[280px] overflow-y-auto"
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dimension filter popover
// ---------------------------------------------------------------------------

export function DimensionFilterPopover({
  fields, rules, onChange, join, onJoinChange, onClose, anchorRef, getOptions,
}: {
  fields: DimensionFieldDef[]
  rules: DimensionFilter[]
  onChange: (rules: DimensionFilter[]) => void
  join: JoinMode
  onJoinChange: (j: JoinMode) => void
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
  // Runtime option lookup. returns unique values for a dimension field.
  getOptions: (field: string) => string[]
}) {
  // Local draft so the user can Cancel without committing.
  const [draft, setDraft] = useState<DimensionFilter[]>(rules.length ? rules : [newDimensionFilter(fields[0]?.key || 'campaign_name')])
  const [draftJoin, setDraftJoin] = useState<JoinMode>(join)

  const update = (id: string, patch: Partial<DimensionFilter>) => {
    setDraft(draft.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  }
  const remove = (id: string) => setDraft(draft.filter((f) => f.id !== id))
  const add = () => setDraft([...draft, newDimensionFilter(fields[0]?.key || 'campaign_name')])
  const clearAll = () => setDraft([])

  const apply = () => {
    // Strip empty rows on apply
    onChange(draft.filter((r) => (r.op === 'contains' || r.op === 'starts_with') ? r.text.trim() : r.values.length))
    onJoinChange(draftJoin)
    onClose()
  }

  return (
    <PopoverShell anchorRef={anchorRef} onClose={onClose} width={640}>
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-medium text-text-primary">Dimension filter records</div>
          {draft.length > 1 && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">Join</span>
              <div className="rounded-md border border-black/[0.1] p-0.5 flex">
                {(['AND', 'OR'] as JoinMode[]).map((m) => (
                  <button key={m} onClick={() => setDraftJoin(m)}
                    className={`px-2 py-0.5 text-[10px] rounded ${
                      draftJoin === m ? 'bg-text-primary text-white' : 'text-text-secondary hover:text-text-primary'
                    }`}>
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          {draft.map((rule) => (
            <DimensionRuleRow
              key={rule.id}
              rule={rule}
              fields={fields}
              getOptions={getOptions}
              onChange={(patch) => update(rule.id, patch)}
              onRemove={() => remove(rule.id)}
            />
          ))}
        </div>

        <button
          onClick={add}
          className="self-start flex items-center gap-1 text-[12px] text-text-muted hover:text-text-primary"
        >
          <Plus size={12} /> Add condition
        </button>

        <div className="flex items-center justify-between pt-3 border-t border-black/[0.06]">
          <button
            onClick={clearAll}
            className="text-[12px] text-[#B7410E] hover:underline"
          >
            Clear all
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="h-8 px-3 rounded-md text-[12px] border border-black/[0.12] text-text-secondary hover:border-black/25"
            >
              Cancel
            </button>
            <button
              onClick={apply}
              className="h-8 px-3 rounded-md text-[12px] bg-[#B7410E] text-white hover:bg-[#d56e25]"
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </PopoverShell>
  )
}

function DimensionRuleRow({
  rule, fields, getOptions, onChange, onRemove,
}: {
  rule: DimensionFilter
  fields: DimensionFieldDef[]
  getOptions: (field: string) => string[]
  onChange: (patch: Partial<DimensionFilter>) => void
  onRemove: () => void
}) {
  const [fieldOpen, setFieldOpen] = useState(false)
  const [opOpen, setOpOpen] = useState(false)
  const [valOpen, setValOpen] = useState(false)
  const fieldRef = useRef<HTMLDivElement>(null)
  const opRef = useRef<HTMLDivElement>(null)
  const valRef = useRef<HTMLDivElement>(null)

  const fieldDef = fields.find((f) => f.key === rule.field) || fields[0]
  const options = useMemo(() => {
    const fromDef = fieldDef?.options
    if (fromDef && fromDef.length) return fromDef
    return getOptions(rule.field)
  }, [fieldDef, rule.field, getOptions])

  const opLabel = (op: DimensionOp): string => {
    switch (op) {
      case 'is': return 'is'
      case 'is_not': return 'is not'
      case 'contains': return 'contains'
      case 'starts_with': return 'starts with'
    }
  }
  const isTextMode = rule.op === 'contains' || rule.op === 'starts_with'

  return (
    <div className="flex items-center gap-2">
      {/* Field dropdown */}
      <div className="relative" ref={fieldRef}>
        <DropdownButton
          label={fieldDef?.label || rule.field}
          open={fieldOpen}
          onToggle={() => setFieldOpen((v) => !v)}
          width={180}
        />
        <DropdownMenu open={fieldOpen} onClose={() => setFieldOpen(false)} width={220}>
          {fields.map((f) => (
            <button key={f.key}
              onClick={() => { onChange({ field: f.key, values: [], text: '' }); setFieldOpen(false) }}
              className={`w-full text-left px-3 py-1.5 text-[12px] hover:bg-black/[0.04] ${
                rule.field === f.key ? 'text-[#B7410E]' : 'text-text-primary'
              }`}>
              {f.label}
            </button>
          ))}
        </DropdownMenu>
      </div>

      {/* Operator dropdown */}
      <div className="relative" ref={opRef}>
        <DropdownButton
          label={opLabel(rule.op)}
          open={opOpen}
          onToggle={() => setOpOpen((v) => !v)}
          width={120}
        />
        <DropdownMenu open={opOpen} onClose={() => setOpOpen(false)} width={140}>
          {(['is', 'is_not', 'contains', 'starts_with'] as DimensionOp[]).map((op) => (
            <button key={op}
              onClick={() => { onChange({ op }); setOpOpen(false) }}
              className={`w-full text-left px-3 py-1.5 text-[12px] hover:bg-black/[0.04] ${
                rule.op === op ? 'text-[#B7410E]' : 'text-text-primary'
              }`}>
              {opLabel(op)}
            </button>
          ))}
        </DropdownMenu>
      </div>

      {/* Value: either multi-select (is/is_not) or text input (contains/starts_with).
          Both variants use flex-1 + min-w-0 so long values (e.g.
          "OM | TOF-CONVERSION-ABO-LC-CREATIVE_TEST-NC") don't push the remove
          button out of the 640px popover. The inner label is truncated and
          the menu is capped at 320px wide so the list of options wraps long
          strings instead of overflowing the menu. */}
      {isTextMode ? (
        <input
          type="text"
          value={rule.text}
          onChange={(e) => onChange({ text: e.target.value })}
          placeholder="e.g. UGC_V3"
          className="h-8 px-2.5 rounded-md border border-black/[0.12] text-[12px] bg-white focus:outline-none focus:border-[#B7410E]/60 focus:ring-1 focus:ring-[#B7410E]/30 flex-1 min-w-0 truncate"
        />
      ) : (
        <div className="relative flex-1 min-w-0 max-w-full" ref={valRef}>
          <DropdownButton
            label={
              rule.values.length === 0
                ? <span className="text-text-muted">Select value</span>
                : rule.values.length === 1
                  ? (rule.values[0] || '(blank)')
                  : `${rule.values.length} selected`
            }
            open={valOpen}
            onToggle={() => setValOpen((v) => !v)}
            className="w-full"
          />
          <DropdownMenu open={valOpen} onClose={() => setValOpen(false)} width={320}>
            <ValuePickerMenu
              options={options}
              selected={rule.values}
              onChange={(v) => onChange({ values: v })}
            />
          </DropdownMenu>
        </div>
      )}

      {/* Remove row */}
      <button
        onClick={onRemove}
        className="h-8 w-8 rounded-md flex items-center justify-center text-text-muted hover:text-red-600 hover:bg-black/[0.04]"
        title="Remove condition"
      >
        <XIcon size={14} />
      </button>
    </div>
  )
}

function ValuePickerMenu({
  options, selected, onChange,
}: {
  options: string[]
  selected: string[]
  onChange: (v: string[]) => void
}) {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => {
    if (!search) return options
    const q = search.toLowerCase()
    return options.filter((o) => o.toLowerCase().includes(q))
  }, [options, search])
  const toggle = (v: string) => {
    if (selected.includes(v)) onChange(selected.filter((x) => x !== v))
    else onChange([...selected, v])
  }
  return (
    <div className="w-full">
      <div className="px-2 py-1.5 sticky top-0 bg-white">
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          className="w-full border border-black/[0.1] rounded px-2 py-1 text-[12px] focus:outline-none focus:border-[#B7410E]/60"
        />
      </div>
      {filtered.length === 0 ? (
        <div className="px-3 py-2 text-[11px] text-text-muted italic">
          {options.length === 0 ? 'None in current data' : 'No matches'}
        </div>
      ) : (
        filtered.map((opt) => {
          const checked = selected.includes(opt)
          return (
            <label key={opt}
              className="flex items-center gap-2 px-3 py-1 text-[12px] hover:bg-black/[0.04] cursor-pointer min-w-0">
              <input type="checkbox" checked={checked}
                onChange={() => toggle(opt)}
                className="rounded accent-[#B7410E] flex-shrink-0" />
              <span className="truncate flex-1 min-w-0" title={opt}>{opt || '(blank)'}</span>
            </label>
          )
        })
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Metric filter popover
// ---------------------------------------------------------------------------

const OPS: FilterOp[] = ['>', '>=', '<', '<=', '=', '!=']

function unitLabel(unit?: MetricOption['unit']): string {
  switch (unit) {
    case 'dollar': return '$'
    case 'percent': return '%'
    case 'decimal': return 'x'
    default: return '#'
  }
}

export function MetricFilterPopover({
  metrics, rules, onChange, join, onJoinChange, onClose, anchorRef,
}: {
  metrics: MetricOption[]
  rules: MetricFilter[]
  onChange: (rules: MetricFilter[]) => void
  join: JoinMode
  onJoinChange: (j: JoinMode) => void
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
}) {
  const [draft, setDraft] = useState<MetricFilter[]>(rules.length ? rules : [newMetricFilter(metrics[0]?.key || 'spend')])
  const [draftJoin, setDraftJoin] = useState<JoinMode>(join)

  const update = (id: string, patch: Partial<MetricFilter>) => {
    setDraft(draft.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  }
  const remove = (id: string) => setDraft(draft.filter((f) => f.id !== id))
  const add = () => setDraft([...draft, newMetricFilter(metrics[0]?.key || 'spend')])
  const clearAll = () => setDraft([])
  const apply = () => {
    onChange(draft)
    onJoinChange(draftJoin)
    onClose()
  }

  return (
    <PopoverShell anchorRef={anchorRef} onClose={onClose} width={600}>
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-medium text-text-primary">Metric filter records</div>
          {draft.length > 1 && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">Join</span>
              <div className="rounded-md border border-black/[0.1] p-0.5 flex">
                {(['AND', 'OR'] as JoinMode[]).map((m) => (
                  <button key={m} onClick={() => setDraftJoin(m)}
                    className={`px-2 py-0.5 text-[10px] rounded ${
                      draftJoin === m ? 'bg-text-primary text-white' : 'text-text-secondary hover:text-text-primary'
                    }`}>
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          {draft.map((rule) => (
            <MetricRuleRow
              key={rule.id}
              rule={rule}
              metrics={metrics}
              onChange={(patch) => update(rule.id, patch)}
              onRemove={() => remove(rule.id)}
            />
          ))}
        </div>

        <button
          onClick={add}
          className="self-start flex items-center gap-1 text-[12px] text-text-muted hover:text-text-primary"
        >
          <Plus size={12} /> Add condition
        </button>

        <div className="flex items-center justify-between pt-3 border-t border-black/[0.06]">
          <button
            onClick={clearAll}
            className="text-[12px] text-[#B7410E] hover:underline"
          >
            Clear all
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="h-8 px-3 rounded-md text-[12px] border border-black/[0.12] text-text-secondary hover:border-black/25"
            >
              Cancel
            </button>
            <button
              onClick={apply}
              className="h-8 px-3 rounded-md text-[12px] bg-[#B7410E] text-white hover:bg-[#d56e25]"
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </PopoverShell>
  )
}

function MetricRuleRow({
  rule, metrics, onChange, onRemove,
}: {
  rule: MetricFilter
  metrics: MetricOption[]
  onChange: (patch: Partial<MetricFilter>) => void
  onRemove: () => void
}) {
  const [metricOpen, setMetricOpen] = useState(false)
  const [opOpen, setOpOpen] = useState(false)
  const metricDef = metrics.find((m) => m.key === rule.metric) || metrics[0]

  return (
    <div className="flex items-center gap-2">
      {/* Metric dropdown */}
      <div className="relative">
        <DropdownButton
          label={metricDef?.label || rule.metric}
          open={metricOpen}
          onToggle={() => setMetricOpen((v) => !v)}
          width={200}
        />
        <DropdownMenu open={metricOpen} onClose={() => setMetricOpen(false)} width={220}>
          <MetricSearchList
            metrics={metrics}
            selected={rule.metric}
            onPick={(key) => { onChange({ metric: key }); setMetricOpen(false) }}
          />
        </DropdownMenu>
      </div>

      {/* Operator dropdown */}
      <div className="relative">
        <DropdownButton
          label={rule.op}
          open={opOpen}
          onToggle={() => setOpOpen((v) => !v)}
          width={80}
        />
        <DropdownMenu open={opOpen} onClose={() => setOpOpen(false)} width={80}>
          {OPS.map((op) => (
            <button key={op}
              onClick={() => { onChange({ op }); setOpOpen(false) }}
              className={`w-full text-left px-3 py-1.5 text-[12px] hover:bg-black/[0.04] tabular-nums ${
                rule.op === op ? 'text-[#B7410E]' : 'text-text-primary'
              }`}>
              {op}
            </button>
          ))}
        </DropdownMenu>
      </div>

      {/* Value input + unit label */}
      <div className="flex items-center flex-1 min-w-0 border border-black/[0.12] rounded-md bg-white focus-within:border-[#B7410E]/60 focus-within:ring-1 focus-within:ring-[#B7410E]/30">
        <input
          type="number"
          value={Number.isFinite(rule.value) ? rule.value : 0}
          onChange={(e) => onChange({ value: Number(e.target.value) })}
          step="any"
          className="h-8 px-2.5 text-[12px] bg-transparent focus:outline-none flex-1 min-w-0 tabular-nums"
        />
        <span className="px-2 text-[11px] text-text-muted border-l border-black/[0.08]">
          {unitLabel(metricDef?.unit)}
        </span>
      </div>

      <button
        onClick={onRemove}
        className="h-8 w-8 rounded-md flex items-center justify-center text-text-muted hover:text-red-600 hover:bg-black/[0.04]"
        title="Remove condition"
      >
        <XIcon size={14} />
      </button>
    </div>
  )
}

function MetricSearchList({
  metrics, selected, onPick,
}: {
  metrics: MetricOption[]
  selected: string
  onPick: (key: string) => void
}) {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => {
    if (!search) return metrics
    const q = search.toLowerCase()
    return metrics.filter((m) => m.label.toLowerCase().includes(q))
  }, [metrics, search])
  return (
    <div>
      <div className="px-2 py-1.5 sticky top-0 bg-white">
        <input
          type="text"
          placeholder="Search metrics..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          className="w-full border border-black/[0.1] rounded px-2 py-1 text-[12px] focus:outline-none focus:border-[#B7410E]/60"
        />
      </div>
      {filtered.length === 0 ? (
        <div className="px-3 py-2 text-[11px] text-text-muted italic">No matches</div>
      ) : (
        filtered.map((m) => (
          <button key={m.key}
            onClick={() => onPick(m.key)}
            className={`w-full text-left px-3 py-1.5 text-[12px] hover:bg-black/[0.04] ${
              selected === m.key ? 'text-[#B7410E]' : 'text-text-primary'
            }`}>
            {m.label}
          </button>
        ))
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small pill button (the entry point in the filter bar)
// ---------------------------------------------------------------------------

export const FilterPillButton = React.forwardRef<
  HTMLButtonElement,
  { label: string; count?: number; active?: boolean; onClick: () => void }
>(function FilterPillButton({ label, count = 0, active, onClick }, ref) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      className={`h-7 px-2.5 rounded-full text-[11px] flex items-center gap-1.5 transition-colors ${
        active || count > 0
          ? 'bg-[#B7410E]/10 border border-[#B7410E]/30 text-[#b55719]'
          : 'glass glass-hover text-text-secondary'
      }`}
    >
      <FilterIcon size={10} />
      {label}
      {count > 0 && (
        <span className="bg-[#B7410E] text-white rounded-full text-[9px] px-1.5 py-0 tabular-nums leading-[14px]">
          {count}
        </span>
      )}
    </button>
  )
})

