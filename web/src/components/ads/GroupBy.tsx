/**
 * GroupByPill. single-pill dropdown for the Ad Analysis toolbar.
 *
 * Types + aggregation logic live in ./groupByData so this file stays
 * component-only (mixing value exports + components in one file breaks
 * React Fast Refresh).
 *
 * Type-only re-exports are Fast-Refresh-safe (erased at runtime) so
 * callers can still write `import type { GroupByKey } from './ads/GroupBy'`
 * without forcing a new import path. Value imports should point straight
 * at `./ads/groupByData`.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Layers, ChevronDown, Check } from 'lucide-react'
import { GROUP_BY_FIELDS } from './groupByData'
import type { GroupByKey } from './groupByData'

export type { GroupByKey, GroupedRow } from './groupByData'

export function GroupByPill({
  value, onChange, extraFields,
}: {
  value: GroupByKey
  onChange: (v: GroupByKey) => void
  // Per-brand naming-convention fields appended after the static list.
  extraFields?: { key: string; label: string }[]
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  const active = value !== 'none'
  const allFields = useMemo(
    () => [...GROUP_BY_FIELDS, ...((extraFields || []).map(f => ({ key: f.key as GroupByKey, label: f.label })))],
    [extraFields],
  )
  const currentLabel = allFields.find((f) => f.key === value)?.label || 'None'

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`h-7 px-2.5 rounded-full text-[11px] flex items-center gap-1.5 transition-colors ${
          active
            ? 'bg-[#B7410E]/10 border border-[#B7410E]/30 text-[#b55719]'
            : 'glass glass-hover text-text-secondary'
        }`}
      >
        <Layers size={10} />
        Group by{active ? `: ${currentLabel}` : ''}
        <ChevronDown size={9} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-[70] bg-white rounded-md shadow-[0_6px_24px_-4px_rgba(0,0,0,0.18)] border border-black/[0.08] py-1 max-h-[320px] overflow-y-auto min-w-[200px]">
          {allFields.map((f) => (
            <button
              key={f.key}
              onClick={() => { onChange(f.key); setOpen(false) }}
              className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center justify-between hover:bg-black/[0.04] ${
                value === f.key ? 'text-[#B7410E]' : 'text-text-primary'
              }`}
            >
              <span>{f.label}</span>
              {value === f.key && <Check size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
