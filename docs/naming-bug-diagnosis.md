# Ad Naming Convention Bug — Diagnosis

Investigation of two symptoms in Atelier (`~/ad-connector`) and Lens
(`~/odylic-lens`, which vendors a copy of the same code):

1. **Preview** in Brand Settings → Ad Naming "doesn't work."
2. **Positions** (Persona / Angle / Concept / …) are not appearing in the
   Dimension Filter dropdown or the Group By dropdown.

The two share a single root cause plus one cosmetic / UX gap. Code is
identical between Atelier and Lens; fixing the Atelier copy and re-
vendoring (or fixing both) closes both.

---

## How the convention is configured and persisted

- UI lives in `~/ad-connector/dashboard/src/components/BrandSettingsView.tsx`
  in `NamingSection` (lines 1607–1725). It edits `profile.naming_convention`,
  shape `{ separator: string, positions: { number, label }[] }`.
- Auto-save POSTs the **entire profile** to `/api/profile` (BrandSettingsView
  line 411–438). The backend (`api_server.py:1397–1415`) merges the body
  into `brand_profiles.json` via `brand_profile_store.save_profiles`. The
  `naming_convention` key is pass-through — written and read verbatim.
- AdAnalysisView reads it back via the same GET `/api/profile`
  (AdAnalysisView lines 1431–1452) and sets `namingConv`.

So the frontend round-trip works. **The legacy `/api/naming-convention`
endpoint (`ad_analysis_endpoints.py:7162–7189`) writes a DIFFERENT key
(`ad_name_convention`) and is never read by the UI** — it's stale and can
be ignored for this bug.

## How parsed tokens are attached to ad rows

Two parallel paths, both in AdAnalysisView:

- **Static tokens** (`nc_objective`, `nc_format`, …`nc_concept`) come from
  the backend `parse_ad_name` / `parse_adset_name` heuristics
  (`ad_analysis_endpoints.py:1960` and `:2035`), attached to each ad as
  `ad.name_convention.{ad,adset}` and flattened in the `enrichedAds`
  memo (AdAnalysisView line 1825–1857, `nc_objective…nc_audience`).
- **User-defined positions** are parsed client-side using
  `parseAdName` from `ads/namingConvention.ts` (lines 33–54). They land on
  each row as `nc_custom_<slug>` keys via the `adsWithAnalysis` memo
  (AdAnalysisView lines 1863–1900). The slug comes from `ncFieldKey`,
  which lowercases and underscores the label.

## Symptom 1 — Preview is "broken"

**File:** `BrandSettingsView.tsx` lines 1690–1722.

The preview Card runs `parseAdName(sample, conv)` (line 1628) against the
sample input. `parseAdName` (namingConvention.ts:33) **requires each
token to literally start with `<number>:`** — e.g.
`1:BigSpender_2:UGC_3:DTC`. Any token that doesn't match the regex
`^\s*(\d+)\s*:\s*(.*?)\s*$` is silently skipped (namingConvention.ts:44).

That format does not match any real Meta ad name. Real ads look like
`Q2_LaunchA_BigSpender_UGC_DTC` — bare tokens, no `1:`, `2:` prefixes.
So when the user pastes a real ad name into Preview, **every token is
skipped, the parsed object is `{}`, every chip renders "—", and the
feature looks broken.**

Root cause: the parser implementation does not match what users actually
write in ad names. The convention as designed only works if the user
also retroactively renames every ad in Meta to embed `1:`, `2:`, `3:`
prefixes, which nobody does.

**Confidence:** HIGH.

**Proposed fix:** treat the position number as the index of the token,
not a prefix the user has to type into ad names. Before:

```ts
// namingConvention.ts:43-52
for (const raw of tokens) {
  const m = raw.match(/^\s*(\d+)\s*:\s*(.*?)\s*$/)
  if (!m) continue
  const num = Number(m[1])
  const val = m[2]
  if (!val) continue
  const pos = conv.positions.find(p => p.number === num)
  if (!pos || !pos.label) continue
  out[pos.label] = val
}
```

After:

```ts
// 1-indexed: position.number === index_in_tokens + 1
tokens.forEach((raw, i) => {
  const val = raw.trim()
  if (!val) return
  const pos = conv.positions.find(p => p.number === i + 1)
  if (!pos || !pos.label) return
  // Still allow the explicit "<n>:value" form for backward compat
  const explicit = val.match(/^\s*(\d+)\s*:\s*(.*?)\s*$/)
  out[pos.label] = explicit ? explicit[2] : val
})
```

Also update the Preview placeholder (`BrandSettingsView.tsx:1695`) to
show a realistic example like
`Q2_LaunchA_BigSpender_UGC_DTC` instead of `1:BigSpender_…`.

## Symptom 2 — Positions do not show up in Dimension Filter or Group By

**Files:** `AdAnalysisView.tsx:881–909` (`DIMENSION_FIELDS`),
`AdAnalysisView.tsx:1913–1936` (`uniqueDimensionValues`),
`AdAnalysisView.tsx:2479` (GroupByPill), `ads/GroupBy.tsx:41–42`.

**Group By works for user-defined positions.** `namingExtraGroupBy` is
built from `namingConv.positions` (line 1904) and passed as `extraFields`
to `GroupByPill`, which appends them to `GROUP_BY_FIELDS`
(GroupBy.tsx:41–42). So Persona / Angle / etc. *will* appear here once
Symptom 1 is fixed and `namingConv` actually has non-empty positions
(plus, of course, `parseAdName` actually returns values).

**Dimension Filter does NOT.** `DIMENSION_FIELDS` (AdAnalysisView:881) is
a static constant. It only includes the backend's static `nc_*` keys
(`nc_objective`, `nc_format`, …`nc_concept`). It is passed as a literal
prop to `DimensionFilterPopover` (line 2580) with no `extraFields` /
naming-convention merge. There is no equivalent of `namingExtraGroupBy`
on the dimension side.

Result: even if the user defines `1 → Persona` in Brand Settings, the
Dimension Filter dropdown never shows "Persona" as a filterable field.

Additionally, `uniqueDimensionValues` (line 1913) hard-codes the dimension
keys it indexes; `nc_custom_*` keys are absent, so even if a custom
position were added to `DIMENSION_FIELDS`, the value picker would render
empty.

**Confidence:** HIGH for both.

**Proposed fix:**

```tsx
// AdAnalysisView.tsx — after the existing namingExtraGroupBy memo (~line 1909)
const namingExtraDimensions = useMemo<DimensionFieldDef[]>(() => {
  if (!namingConv?.positions?.length) return []
  return namingConv.positions
    .filter(p => p.label && p.label.trim())
    .map(p => ({ key: ncFieldKey(p.label), label: p.label }))
}, [namingConv])

const dimensionFields = useMemo(
  () => [...DIMENSION_FIELDS, ...namingExtraDimensions],
  [namingExtraDimensions],
)
```

```tsx
// AdAnalysisView.tsx:2580 (DimensionFilterPopover invocation)
<DimensionFilterPopover
  fields={dimensionFields}        // was: DIMENSION_FIELDS
  ...
/>
```

```ts
// AdAnalysisView.tsx:1914 — extend uniqueDimensionValues keys
const keys = [
  'campaign_name', 'adset_name', 'ad_name',
  'nc_objective', 'nc_format', 'nc_type', 'nc_funnel',
  'nc_persona_hint', 'nc_owner', 'nc_bidding', 'nc_audience', 'nc_concept',
  ...namingExtraDimensions.map(d => d.key),    // NEW
  'analysis_angle', /* …rest unchanged… */
]
```

(Move the `useMemo` so it can see `namingExtraDimensions`, or merge the
two memos.)

## Secondary observation — Lens vendors the same broken code

`~/odylic-lens/web/src/components/ads/namingConvention.ts`,
`AdAnalysisView.tsx`, `GroupBy.tsx`, `groupByData.ts` are copies of the
Atelier files (verified by grepping the same line-number landmarks).
Fixing only Atelier will leave Lens broken. Either:

- apply the same patches in `~/odylic-lens/web/src/components/...`, or
- extract `namingConvention.ts` + the dimension-extension logic into a
  shared package both apps consume.

**Confidence:** HIGH (file-by-file comparison).

## Summary

| Symptom | File | Root cause | Fix |
| --- | --- | --- | --- |
| Preview always shows "—" | `ads/namingConvention.ts:33` | Parser only accepts `<n>:value` tokens; real ad names are bare-token | Use position number as 1-indexed token index; keep `<n>:value` as optional override |
| Positions absent from Group By | (already works) | n/a — `namingExtraGroupBy` wires this up | none, but depends on Symptom 1 fix to produce values |
| Positions absent from Dimension Filter | `AdAnalysisView.tsx:881, 2580, 1913` | `DIMENSION_FIELDS` is static; no `extraFields` merge; `uniqueDimensionValues` hard-codes keys | Add `namingExtraDimensions` memo, merge into the prop, and append the keys to `uniqueDimensionValues` |
| Lens has the same bug | `~/odylic-lens/web/src/components/ads/*` | vendored copy | apply the same patches |
