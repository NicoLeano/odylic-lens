// Per-brand ad naming convention. The user defines a separator (e.g. "_")
// and a numbered position list (1=Persona, 2=Angle, …). The position
// `number` is a 1-indexed slot into the separator-split tokens of the ad
// name. So with positions [{1, "Persona"}, {2, "Angle"}, {3, "Geo"}] the
// ad name:
//
//   BigSpender_UGC_DTC
//
// parses to { Persona: "BigSpender", Angle: "UGC", Geo: "DTC" }. Tokens
// missing from the ad name leave that label undefined.
//
// An explicit "N:value" prefix on a token still works as an override
// (useful when ad ops don't follow a strict positional order):
//   Something_3:override_4:later  →  { Geo: "override", … }

export type NamingPosition = { number: number; label: string }

export type NamingConvention = {
  separator: string
  positions: NamingPosition[]
}

export const DEFAULT_NAMING_CONVENTION: NamingConvention = {
  separator: '_',
  positions: [],
}

// Slugify a label into a stable key suitable as an object property. Spaces
// become underscores, anything non-alphanumeric is dropped, lowercased.
export function ncFieldKey(label: string): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return `nc_custom_${slug || 'field'}`
}

// Parse one ad name against the convention. Returns a dict keyed by the
// position label; missing positions are left undefined.
//
// Two passes:
//   1. Honor explicit "N:value" tokens as overrides. useful when the
//      naming-convention numbering doesn't match the token order.
//   2. Slot bare tokens by their 1-indexed position (token[0] → number=1,
//      token[1] → number=2, …) for any label not already filled in by
//      pass 1.
export function parseAdName(name: string, conv: NamingConvention): Record<string, string> {
  const out: Record<string, string> = {}
  if (!name || !conv?.positions?.length) return out
  const sep = conv.separator || '_'
  // Split on the literal separator. Fall back to whitespace when sep is
  // empty, to avoid an infinite-empty-array footgun.
  const tokens = sep ? name.split(sep) : name.split(/\s+/)

  // Build a number → label lookup from the convention.
  const byNumber = new Map<number, string>()
  for (const pos of conv.positions) {
    if (pos.label && Number.isFinite(pos.number)) {
      byNumber.set(pos.number, pos.label)
    }
  }

  // Pass 1: explicit "N:value" overrides. Track which token indices
  // were consumed so pass 2 doesn't double-assign them.
  const consumed = new Set<number>()
  tokens.forEach((raw, idx) => {
    const m = raw.match(/^\s*(\d+)\s*:\s*(.*?)\s*$/)
    if (!m) return
    const num = Number(m[1])
    const val = m[2].trim()
    if (!val) return
    const label = byNumber.get(num)
    if (!label) return
    out[label] = val
    consumed.add(idx)
  })

  // Pass 2: positional slotting. Token at array index i (0-based) maps
  // to position number i+1 (1-indexed, matching how the user writes
  // positions in BrandSettings).
  tokens.forEach((raw, idx) => {
    if (consumed.has(idx)) return
    const positionNum = idx + 1
    const label = byNumber.get(positionNum)
    if (!label) return
    if (out[label]) return  // already filled by pass 1
    const val = raw.trim()
    if (!val) return
    // Defensive: if the bare token itself looks like "N:value" but its
    // number didn't match a known position (so pass 1 skipped it), don't
    // silently slot the whole "N:value" string as some other label.
    if (/^\d+\s*:/.test(val)) return
    out[label] = val
  })

  return out
}

// Attach parsed naming-convention values to a row as `nc_custom_<slug>`
// keys, so the GroupBy reducer can pick them up via `ad[groupBy]`.
export function enrichRowWithNamingConvention<T extends Record<string, any>>(
  row: T,
  conv: NamingConvention | undefined | null,
): T {
  if (!conv?.positions?.length) return row
  const name = (row.ad_name as string) || ''
  const parsed = parseAdName(name, conv)
  const next: Record<string, any> = { ...row }
  for (const pos of conv.positions) {
    if (!pos.label) continue
    next[ncFieldKey(pos.label)] = parsed[pos.label] ?? ''
  }
  return next as T
}
