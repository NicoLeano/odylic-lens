// BrandSettingsView. full-page editor for every field on a brand profile.
// Replaces the modal ProfileDetail with a left-rail of sections + right-pane
// content that auto-saves on blur. Designed to feel native to Atelier:
// glass tiles, serif headlines, charcoal text, orange accent.

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  RefreshCw,
  Loader2,
  Plus,
  Trash2,
  Sparkles,
  Upload,
  FileText,
  AlertCircle,
  CheckCircle2,
  Globe,
  Music2,
  Palette,
  Box,
  MessageSquare,
  Target,
  Shield,
  TrendingUp as TrendingUpIcon,
  Type,
  Image as ImageIcon,
  Tag,
  PieChart,
  ChevronRight,
  Copy,
  Check,
  ExternalLink,
  Settings as SettingsIcon,
  AtSign,
} from 'lucide-react'
import type { NamingConvention } from './ads/namingConvention'
import { DEFAULT_NAMING_CONVENTION, parseAdName } from './ads/namingConvention'

// ─────────────────────────────────────────────────────────────── types ──

type Persona = { name: string; description: string }
type BrandColor = { hex: string; name: string; usage: string }
type BrandFonts = { primary?: string; secondary?: string }
type Product = { name: string; description: string; hero_image?: string; price_range?: string; sku?: string }
type SocialLinks = { instagram?: string; tiktok?: string; website?: string }
type Keyword = { label: string; query: string; visible?: boolean }
type Taxonomy = Record<string, string[]>
type UploadedDoc = {
  filename: string
  stored_path?: string
  size_bytes?: number
  pages?: number | null
  uploaded_at?: string
  fields_extracted?: string[]
  parse_error?: string | null
}

type Profile = {
  domain?: string
  description?: string
  hero_products?: string[]
  categories?: string[]
  target_personas?: Persona[]
  favicon?: string | null
  logo_url?: string
  brand_colors?: BrandColor[]
  brand_fonts?: BrandFonts
  products?: Product[]
  voice_tone?: string
  competitors?: string[]
  unique_value_props?: string[]
  social_links?: SocialLinks
  planner_taxonomy?: Taxonomy
  trend_keywords?: Keyword[]
  tagline?: string
  founded_year?: string
  hq_location?: string
  mission_statement?: string
  positioning_statement?: string
  category?: string
  competitive_frame?: string
  differentiator?: string
  proof_points?: string[]
  brand_essence?: string
  brand_values?: string[]
  personality_traits?: string[]
  functional_benefits?: string[]
  emotional_benefits?: string[]
  primary_persona?: string
  secondary_personas?: Persona[]
  jobs_to_be_done?: string[]
  objections?: string[]
  voice_attributes?: string[]
  do_say?: string[]
  dont_say?: string[]
  example_snippets?: string[]
  color_primary?: string
  color_secondary?: string
  typography_display?: string
  typography_body?: string
  logo_dos?: string[]
  logo_donts?: string[]
  price_range?: string
  merchandising_notes?: string
  cac_target?: string
  ltv_target?: string
  margin_target?: string
  top_channels?: string[]
  claims_allowed?: string[]
  claims_avoided?: string[]
  trademarks?: string[]
  uploaded_docs?: UploadedDoc[]
  naming_convention?: NamingConvention
  error?: string
}

type DiffEntry = {
  field: string
  current: unknown
  proposed: unknown
  kind: 'scalar' | 'list' | 'object'
  action: 'add' | 'extend' | 'overwrite' | 'noop'
}

type IngestResult = {
  brand: string
  files: Array<{ filename: string; size_bytes: number; pages: number | null; chars_extracted: number; error: string | null }>
  parse_errors: Array<{ filename: string; error: string }>
  extraction: Record<string, unknown>
  diff: DiffEntry[]
  extraction_error?: string | null
  docs_meta: Array<{ filename: string; stored_path: string; size_bytes: number; pages: number | null }>
}

type BrandRow = {
  name: string
  meta?: boolean
  google?: boolean
  meta_account_id?: string | null
  google_account_ids?: string[]
}

interface Props {
  brand: string
  brandRow?: BrandRow
}

// ───────────────────────────────────────────────────────────── sections ──

type SectionKey =
  | 'identity'
  | 'connections'
  | 'positioning'
  | 'pyramid'
  | 'audience'
  | 'voice'
  | 'visual'
  | 'products'
  | 'social'
  | 'performance'
  | 'compliance'
  | 'taxonomy'
  | 'naming'
  | 'keywords'
  | 'docs'

const SECTIONS: Array<{
  key: SectionKey
  label: string
  hint: string
  icon: React.ComponentType<any>
}> = [
  { key: 'identity', label: 'Identity', hint: 'Name, domain, tagline, mission', icon: Globe },
  { key: 'connections', label: 'Connections', hint: 'Meta + Google accounts, status', icon: SettingsIcon },
  { key: 'positioning', label: 'Positioning', hint: 'Category, frame, differentiator', icon: Target },
  { key: 'pyramid', label: 'Brand Pyramid', hint: 'Essence, values, benefits', icon: PieChart },
  { key: 'audience', label: 'Audience', hint: 'Personas, jobs, objections', icon: MessageSquare },
  { key: 'voice', label: 'Voice & Tone', hint: 'Words to use / avoid, snippets', icon: Type },
  { key: 'visual', label: 'Visual', hint: 'Logo, palette, fonts', icon: Palette },
  { key: 'products', label: 'Products', hint: 'Catalog, pricing, hero items', icon: Box },
  { key: 'social', label: 'Social', hint: 'IG, TikTok, website', icon: AtSign },
  { key: 'performance', label: 'Performance', hint: 'CAC, LTV, margin, channels', icon: TrendingUpIcon },
  { key: 'compliance', label: 'Compliance', hint: 'Claims, trademarks', icon: Shield },
  { key: 'taxonomy', label: 'Planner Taxonomy', hint: 'Picklists for the Planner', icon: Tag },
  { key: 'naming', label: 'Ad Naming', hint: 'Parse ad_name into fields', icon: Type },
  { key: 'keywords', label: 'Trend Keywords', hint: 'Google Trends queries', icon: TrendingUpIcon },
  { key: 'docs', label: 'Documents', hint: 'Upload + auto-extract', icon: FileText },
]

// ───────────────────────────────────────────────────── small primitives ──

function CopyChip({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
      className="inline-flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-white/70 hover:bg-white/90 px-2 py-0.5 text-[10px] text-text-secondary transition-colors"
      title="Copy"
    >
      {label && <span className="text-text-muted">{label}</span>}
      <span className="font-mono">{value}</span>
      {copied ? <Check size={10} className="text-[#2d8a4e]" /> : <Copy size={10} className="opacity-50" />}
    </button>
  )
}

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-1">
      <div className="text-[10px] uppercase tracking-widest text-text-muted">{children}</div>
      {hint && <div className="text-[10px] text-text-muted/70">{hint}</div>}
    </div>
  )
}

function TextInput({
  value, onChange, onCommit, placeholder, mono,
}: {
  value: string
  onChange: (v: string) => void
  onCommit?: () => void
  placeholder?: string
  mono?: boolean
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      onBlur={onCommit}
      className={`w-full border border-black/[0.08] rounded-lg px-3 py-2 text-xs bg-white/60 focus:outline-none focus:border-text-primary/30 focus:bg-white/90 transition-colors ${mono ? 'font-mono' : ''}`}
    />
  )
}

function TextArea({
  value, onChange, onCommit, rows = 3, placeholder,
}: {
  value: string
  onChange: (v: string) => void
  onCommit?: () => void
  rows?: number
  placeholder?: string
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      onBlur={onCommit}
      className="w-full border border-black/[0.08] rounded-lg px-3 py-2 text-xs bg-white/60 focus:outline-none focus:border-text-primary/30 focus:bg-white/90 transition-colors resize-none leading-relaxed"
    />
  )
}

function Card({
  title, hint, action, children,
}: {
  title?: string
  hint?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="atelier-tile flex flex-col gap-3">
      {(title || action) && (
        <div className="flex items-baseline gap-2">
          {title && <div className="font-display text-[14px] text-text-primary">{title}</div>}
          {hint && <div className="text-[10px] text-text-muted">{hint}</div>}
          {action && <div className="ml-auto flex items-center gap-1.5">{action}</div>}
        </div>
      )}
      {children}
    </div>
  )
}

function StringList({
  values, onChange, onCommit, placeholder, addLabel = 'Add',
}: {
  values: string[]
  onChange: (v: string[]) => void
  onCommit?: () => void
  placeholder?: string
  addLabel?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {values.length === 0 && (
        <div className="text-[11px] text-text-muted/70 italic">None yet.</div>
      )}
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="text"
            value={v}
            placeholder={placeholder}
            onChange={e => { const arr = [...values]; arr[i] = e.target.value; onChange(arr) }}
            onBlur={onCommit}
            className="flex-1 border border-black/[0.08] rounded-lg px-2.5 py-1.5 text-[12px] bg-white/60 focus:outline-none focus:border-text-primary/30 focus:bg-white/90 transition-colors"
          />
          <button
            onClick={() => { onChange(values.filter((_, j) => j !== i)); onCommit?.() }}
            className="p-1.5 text-text-muted hover:text-red-500 rounded hover:bg-black/[0.04]"
            title="Remove"
          >
            <Trash2 size={11} />
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...values, ''])}
        className="self-start mt-0.5 inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary"
      >
        <Plus size={11} /> {addLabel}
      </button>
    </div>
  )
}

function ChipList({
  values, onChange, onCommit, placeholder,
}: {
  values: string[]
  onChange: (v: string[]) => void
  onCommit?: () => void
  placeholder?: string
}) {
  const [draft, setDraft] = useState('')
  const commitDraft = () => {
    const v = draft.trim()
    if (!v) return
    if (values.includes(v)) { setDraft(''); return }
    onChange([...values, v])
    onCommit?.()
    setDraft('')
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.length === 0 && (
        <span className="text-[11px] text-text-muted/70 italic">None yet.</span>
      )}
      {values.map((v, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 bg-white/70 border border-black/[0.08] rounded-full pl-2.5 pr-1 py-0.5 text-[11px] text-text-secondary"
        >
          <span className="truncate max-w-[12rem]">{v}</span>
          <button
            onClick={() => { onChange(values.filter((_, j) => j !== i)); onCommit?.() }}
            className="text-text-muted/60 hover:text-red-500 p-0.5"
            title="Remove"
          >
            <Trash2 size={9} />
          </button>
        </span>
      ))}
      <span className="inline-flex items-center gap-0.5 bg-white/40 border border-dashed border-black/[0.12] rounded-full pl-2.5 pr-1 py-0.5">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commitDraft() }
            if (e.key === 'Escape') setDraft('')
          }}
          onBlur={() => commitDraft()}
          placeholder={placeholder || 'Add…'}
          className="w-24 bg-transparent text-[11px] outline-none placeholder:text-text-muted/60"
        />
      </span>
    </div>
  )
}

// ────────────────────────────────────────────── main view container ──

export function BrandSettingsView({ brand, brandRow }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(false)
  const [section, setSection] = useState<SectionKey>('identity')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deepLoading, setDeepLoading] = useState(false)
  const saveTimer = useRef<number | null>(null)
  const lastSavedRef = useRef<string>('')

  const load = useCallback(async (regen = false) => {
    setLoading(true)
    try {
      const r = await fetch(`/api/profile?brand=${encodeURIComponent(brand)}&regen=${regen}`)
      const d = await r.json()
      setProfile(d)
      lastSavedRef.current = JSON.stringify(d)
    } finally {
      setLoading(false)
    }
  }, [brand])

  useEffect(() => { load() }, [load])

  // Auto-save on commit. Sends the entire profile (matching POST /api/profile
  // semantics. backend merges over existing). Debounced 350ms so rapid edits
  // Save the current profile to the server. Returns a promise so
  // `regenerateDeep` can `await` it before triggering the LLM call -
  // otherwise the server would generate a deep profile against a
  // stale domain (or no domain at all).
  //
  // Two earlier bugs lived here:
  //   1. The body was the bare profile dict, but the backend expects
  //      `{brand, profile}`. Saves silently no-op'd → domain never
  //      reached disk → Deep Profile ran without any domain context.
  //   2. update() didn't trigger commit() so typing a domain into the
  //      Identity card just updated local state. Closing the tab lost
  //      the entry. Now every update() schedules a debounced save.
  const flushSave = useCallback(async (): Promise<void> => {
    if (!profile) return
    if (saveTimer.current) { window.clearTimeout(saveTimer.current); saveTimer.current = null }
    const snapshot = JSON.stringify(profile)
    if (snapshot === lastSavedRef.current) return
    setSaveState('saving')
    setSaveError(null)
    try {
      const r = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ brand, profile }),  // ← {brand, profile} envelope (was bare dict)
      })
      if (!r.ok) throw new Error(await r.text())
      const body = await r.json()
      if (body?.error) throw new Error(body.error)
      // POST returns {ok: true}. we don't merge server-side data
      // here; the profile we sent is now persisted as-is.
      lastSavedRef.current = snapshot
      setSaveState('saved')
      window.setTimeout(() => setSaveState(s => s === 'saved' ? 'idle' : s), 1500)
    } catch (e: any) {
      setSaveState('error')
      setSaveError(String(e?.message || e))
      throw e
    }
  }, [profile, brand])

  // Debounced commit. schedules flushSave after a short idle window.
  const commit = useCallback(() => {
    if (!profile) return
    const snapshot = JSON.stringify(profile)
    if (snapshot === lastSavedRef.current) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => { flushSave().catch(() => {}) }, 350)
  }, [profile, flushSave])

  // Cleanup any pending debounce on unmount.
  useEffect(() => () => { if (saveTimer.current) window.clearTimeout(saveTimer.current) }, [])

  // Update + auto-commit. Previously `update()` only set local state;
  // callers had to remember to call commit() after every change, and
  // many didn't (notably the domain input on the Identity card).
  const update = useCallback(<K extends keyof Profile>(k: K, v: Profile[K]) => {
    setProfile(p => p ? { ...p, [k]: v } : p)
  }, [])

  // Effect-based auto-commit so every profile mutation gets debounced
  // to disk, regardless of which input triggered it. Lets us drop the
  // commit() calls scattered through array-update handlers later.
  useEffect(() => { commit() }, [profile, commit])

  const regenerateDeep = async () => {
    setDeepLoading(true)
    setSaveError(null)
    try {
      // CRITICAL: flush any pending domain edit BEFORE asking Claude
      // to fill in the profile. Without this, the user types a domain,
      // immediately hits "Deep profile", and the backend reads the
      // brand profile from disk → finds no domain → Claude has no
      // anchor → returns a generic guess that often doesn't match
      // the actual brand the user owns.
      await flushSave().catch(() => {})
      const r = await fetch(`/api/profile/generate-deep?brand=${encodeURIComponent(brand)}`, {
        method: 'POST',
        credentials: 'include',
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        const msg = d?.detail || d?.error || `Deep profile failed (HTTP ${r.status})`
        setSaveError(String(msg))
        return
      }
      if (d?.error) {
        setSaveError(String(d.error))
        return
      }
      setProfile(d)
      lastSavedRef.current = JSON.stringify(d)
    } catch (e: any) {
      setSaveError(String(e?.message || e))
    } finally { setDeepLoading(false) }
  }

  if (loading && !profile) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 size={20} className="animate-spin text-text-muted" />
      </div>
    )
  }

  if (!profile) {
    return (
      <div className="text-text-muted text-xs p-8">No profile loaded.</div>
    )
  }

  return (
    <div className="pt-2 pb-10 flex flex-col gap-4">
      {/* Header. brand title + global actions. Mirrors HealthView header. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full overflow-hidden ring-1 ring-black/[0.08] bg-white/60 flex-shrink-0 flex items-center justify-center">
            {profile.favicon ? (
              <img
                src={profile.favicon}
                alt=""
                className="w-full h-full object-cover"
                onError={e => { (e.currentTarget.style.display = 'none') }}
              />
            ) : (
              <span className="text-text-muted text-xs">{brand.charAt(0)}</span>
            )}
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-medium leading-tight truncate" data-redact>{brand}</h1>
            {profile.domain && (
              <a
                href={`https://${profile.domain}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary"
              >
                {profile.domain}
                <ExternalLink size={10} />
              </a>
            )}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Save status */}
          <div className="text-[11px] text-text-muted min-w-[80px] text-right">
            {saveState === 'saving' && (
              <span className="inline-flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> Saving…</span>
            )}
            {saveState === 'saved' && (
              <span className="inline-flex items-center gap-1 text-[#2d8a4e]"><CheckCircle2 size={11} /> Saved</span>
            )}
            {saveState === 'error' && (
              <span className="inline-flex items-center gap-1 text-[#c43a31]" title={saveError || ''}>
                <AlertCircle size={11} /> Save failed
              </span>
            )}
          </div>
          <button
            onClick={regenerateDeep}
            disabled={deepLoading}
            className="glass glass-hover rounded-full px-3 py-1.5 text-xs flex items-center gap-1.5 text-[#B7410E] disabled:opacity-50"
            title="Regenerate the full profile via Claude"
          >
            {deepLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            Deep profile
          </button>
          <button
            onClick={() => load(true)}
            disabled={loading}
            className="glass glass-hover rounded-full px-3 py-1.5 text-xs flex items-center gap-1.5 text-text-primary"
            title="Refetch / regenerate basic profile"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Refresh
          </button>
        </div>
      </div>

      {/* Body: left rail + content. Sticky rail mimics the sidebar at the
          page level so the user can jump between sections without scrolling
          back to the top. */}
      <div className="grid grid-cols-[220px_1fr] gap-5 items-start">
        {/* Section rail */}
        <nav className="atelier-tile sticky top-3 flex flex-col gap-0.5 p-2.5">
          {SECTIONS.map(s => {
            const Icon = s.icon
            const active = section === s.key
            return (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                className={`group flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors ${
                  active
                    ? 'bg-text-primary text-white'
                    : 'text-text-secondary hover:bg-black/[0.04]'
                }`}
                title={s.hint}
              >
                <Icon
                  size={13}
                  className={active ? 'text-white' : 'text-text-muted group-hover:text-text-primary'}
                />
                <span className="text-[12px] flex-1 truncate">{s.label}</span>
                {active && <ChevronRight size={11} className="text-white/70" />}
              </button>
            )
          })}
        </nav>

        {/* Content */}
        <div className="flex flex-col gap-4 min-w-0">
          {section === 'identity' && (
            <IdentitySection profile={profile} update={update} commit={commit} />
          )}
          {section === 'connections' && (
            <ConnectionsSection brand={brand} brandRow={brandRow} />
          )}
          {section === 'positioning' && (
            <PositioningSection profile={profile} update={update} commit={commit} />
          )}
          {section === 'pyramid' && (
            <PyramidSection profile={profile} update={update} commit={commit} />
          )}
          {section === 'audience' && (
            <AudienceSection profile={profile} update={update} commit={commit} />
          )}
          {section === 'voice' && (
            <VoiceSection profile={profile} update={update} commit={commit} />
          )}
          {section === 'visual' && (
            <VisualSection profile={profile} update={update} commit={commit} />
          )}
          {section === 'products' && (
            <ProductsSection profile={profile} update={update} commit={commit} />
          )}
          {section === 'social' && (
            <SocialSection profile={profile} update={update} commit={commit} />
          )}
          {section === 'performance' && (
            <PerformanceSection profile={profile} update={update} commit={commit} />
          )}
          {section === 'compliance' && (
            <ComplianceSection profile={profile} update={update} commit={commit} />
          )}
          {section === 'taxonomy' && (
            <TaxonomySection brand={brand} profile={profile} update={update} />
          )}
          {section === 'naming' && (
            <NamingSection profile={profile} update={update} commit={commit} />
          )}
          {section === 'keywords' && (
            <KeywordsSection brand={brand} profile={profile} update={update} />
          )}
          {section === 'docs' && (
            <DocsSection brand={brand} profile={profile} onApplied={p => { setProfile(p); lastSavedRef.current = JSON.stringify(p) }} />
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────── identity ──

type SectionProps = {
  profile: Profile
  update: <K extends keyof Profile>(k: K, v: Profile[K]) => void
  commit: () => void
}

function IdentitySection({ profile, update, commit }: SectionProps) {
  return (
    <>
      <Card title="Brand Identity" hint="The starting line of the playbook">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Domain</FieldLabel>
            <TextInput
              value={profile.domain || ''}
              onChange={v => update('domain', v)}
              onCommit={commit}
              placeholder="brand.com"
            />
          </div>
          <div>
            <FieldLabel>Tagline</FieldLabel>
            <TextInput
              value={profile.tagline || ''}
              onChange={v => update('tagline', v)}
              onCommit={commit}
              placeholder="One short line"
            />
          </div>
          <div>
            <FieldLabel>Founded</FieldLabel>
            <TextInput
              value={profile.founded_year || ''}
              onChange={v => update('founded_year', v)}
              onCommit={commit}
              placeholder="2018"
            />
          </div>
          <div>
            <FieldLabel>HQ</FieldLabel>
            <TextInput
              value={profile.hq_location || ''}
              onChange={v => update('hq_location', v)}
              onCommit={commit}
              placeholder="Los Angeles, CA"
            />
          </div>
        </div>
        <div>
          <FieldLabel hint="Why this brand exists">Mission</FieldLabel>
          <TextArea
            value={profile.mission_statement || ''}
            onChange={v => update('mission_statement', v)}
            onCommit={commit}
            rows={2}
          />
        </div>
        <div>
          <FieldLabel hint="2–3 sentence elevator pitch">Description</FieldLabel>
          <TextArea
            value={profile.description || ''}
            onChange={v => update('description', v)}
            onCommit={commit}
            rows={3}
          />
        </div>
      </Card>

      <Card title="Categories" hint="Product / market categories the brand sells in">
        <ChipList
          values={profile.categories || []}
          onChange={v => update('categories', v)}
          onCommit={commit}
          placeholder="Add category…"
        />
      </Card>

      <Card title="Hero Products" hint="Flagship product names (string list)">
        <ChipList
          values={profile.hero_products || []}
          onChange={v => update('hero_products', v)}
          onCommit={commit}
          placeholder="Add product…"
        />
      </Card>
    </>
  )
}

// ────────────────────────────────────────────────────── connections ──

function ConnectionsSection({ brand, brandRow }: { brand: string; brandRow?: BrandRow }) {
  // Derive defaults from the row passed in by App.tsx (already loaded
  // alongside /api/brands). Falls back to a fresh fetch when missing -
  // important for the legacy code path where the brand row didn't carry
  // account IDs yet.
  const [row, setRow] = useState<BrandRow | undefined>(brandRow)
  useEffect(() => {
    if (row?.meta_account_id !== undefined) return
    fetch('/api/brands').then(r => r.json()).then((bs: BrandRow[]) => {
      const found = bs.find(b => b.name === brand)
      if (found) setRow(found)
    }).catch(() => {})
  }, [brand, row])

  const meta = !!row?.meta
  const google = !!row?.google
  const metaId = row?.meta_account_id || ''
  const googleIds = row?.google_account_ids || []

  return (
    <>
      <Card title="Ad Platform Connections" hint="Read-only. change in api_server.py META/GOOGLE_ACCOUNTS">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-black/[0.08] bg-white/50 p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${meta ? 'bg-[#2d8a4e]' : 'bg-black/[0.15]'}`}
                style={meta ? { boxShadow: '0 0 0 4px rgba(45, 138, 78, 0.18)' } : undefined}
              />
              <div className="font-display text-[13px]">Meta</div>
              <span className="ml-auto text-[10px] uppercase tracking-widest text-text-muted">
                {meta ? 'Connected' : 'Not linked'}
              </span>
            </div>
            <div className="text-[10px] text-text-muted uppercase tracking-widest">Account ID</div>
            {meta && metaId ? (
              <CopyChip value={metaId} />
            ) : (
              <div className="text-[11px] text-text-muted/70 italic">No Meta ad account.</div>
            )}
          </div>

          <div className="rounded-xl border border-black/[0.08] bg-white/50 p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${google ? 'bg-[#2d8a4e]' : 'bg-black/[0.15]'}`}
                style={google ? { boxShadow: '0 0 0 4px rgba(45, 138, 78, 0.18)' } : undefined}
              />
              <div className="font-display text-[13px]">Google Ads</div>
              <span className="ml-auto text-[10px] uppercase tracking-widest text-text-muted">
                {google ? 'Connected' : 'Not linked'}
              </span>
            </div>
            <div className="text-[10px] text-text-muted uppercase tracking-widest">Customer IDs</div>
            {googleIds.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {googleIds.map((id, i) => (
                  <CopyChip key={i} value={id} label={i === 0 ? 'CID' : 'MCC'} />
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-text-muted/70 italic">No Google ad account.</div>
            )}
          </div>
        </div>
      </Card>

      <Card title="Brand Key" hint="Used in API filters (cr.brand=, customer_descriptive_name)">
        <CopyChip value={brand} label="brand" />
      </Card>
    </>
  )
}

// ───────────────────────────────────────────────────────── positioning ──

function PositioningSection({ profile, update, commit }: SectionProps) {
  return (
    <>
      <Card title="Positioning Statement" hint="For [audience], [brand] is the [category] that [differentiator].">
        <TextArea
          value={profile.positioning_statement || ''}
          onChange={v => update('positioning_statement', v)}
          onCommit={commit}
          rows={3}
        />
      </Card>
      <Card title="Category & Frame">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Category</FieldLabel>
            <TextInput
              value={profile.category || ''}
              onChange={v => update('category', v)}
              onCommit={commit}
              placeholder="Fine jewelry"
            />
          </div>
          <div>
            <FieldLabel>Competitive frame</FieldLabel>
            <TextInput
              value={profile.competitive_frame || ''}
              onChange={v => update('competitive_frame', v)}
              onCommit={commit}
              placeholder="Heirloom DTC jewelry"
            />
          </div>
        </div>
        <div>
          <FieldLabel hint="The ONE sharpest thing vs. competitors">Differentiator</FieldLabel>
          <TextArea
            value={profile.differentiator || ''}
            onChange={v => update('differentiator', v)}
            onCommit={commit}
            rows={2}
          />
        </div>
      </Card>
      <Card title="Proof Points" hint="Press, awards, hard numbers, credibility">
        <StringList
          values={profile.proof_points || []}
          onChange={v => update('proof_points', v)}
          onCommit={commit}
          placeholder="e.g. 'Featured in Vogue, March 2024'"
        />
      </Card>
      <Card title="Unique Value Props">
        <StringList
          values={profile.unique_value_props || []}
          onChange={v => update('unique_value_props', v)}
          onCommit={commit}
          placeholder="UVP bullet"
        />
      </Card>
      <Card title="Competitors">
        <ChipList
          values={profile.competitors || []}
          onChange={v => update('competitors', v)}
          onCommit={commit}
          placeholder="Add competitor…"
        />
      </Card>
    </>
  )
}

// ─────────────────────────────────────────────────────── brand pyramid ──

function PyramidSection({ profile, update, commit }: SectionProps) {
  return (
    <>
      <Card title="Brand Essence" hint="2–4 words. The soul of the brand.">
        <TextInput
          value={profile.brand_essence || ''}
          onChange={v => update('brand_essence', v)}
          onCommit={commit}
          placeholder="Modern heirlooms"
        />
      </Card>
      <Card title="Values & Personality">
        <FieldLabel>Brand values</FieldLabel>
        <ChipList
          values={profile.brand_values || []}
          onChange={v => update('brand_values', v)}
          onCommit={commit}
          placeholder="Add value…"
        />
        <FieldLabel>Personality traits</FieldLabel>
        <ChipList
          values={profile.personality_traits || []}
          onChange={v => update('personality_traits', v)}
          onCommit={commit}
          placeholder="Add trait…"
        />
      </Card>
      <Card title="Benefits">
        <FieldLabel hint="What it DOES for the user">Functional</FieldLabel>
        <StringList
          values={profile.functional_benefits || []}
          onChange={v => update('functional_benefits', v)}
          onCommit={commit}
          placeholder="Functional benefit"
        />
        <FieldLabel hint="How it makes them FEEL">Emotional</FieldLabel>
        <StringList
          values={profile.emotional_benefits || []}
          onChange={v => update('emotional_benefits', v)}
          onCommit={commit}
          placeholder="Emotional benefit"
        />
      </Card>
    </>
  )
}

// ──────────────────────────────────────────────────────────── audience ──

function AudienceSection({ profile, update, commit }: SectionProps) {
  const personas = profile.target_personas || []
  const setPersona = (i: number, patch: Partial<Persona>) => {
    const arr = [...personas]
    arr[i] = { ...arr[i], ...patch }
    update('target_personas', arr)
  }

  return (
    <>
      <Card title="Primary Persona" hint="One-sentence summary of the core buyer">
        <TextArea
          value={profile.primary_persona || ''}
          onChange={v => update('primary_persona', v)}
          onCommit={commit}
          rows={2}
        />
      </Card>

      <Card
        title="Target Personas"
        hint="Rich personas with name + description"
        action={
          <button
            onClick={() => { update('target_personas', [...personas, { name: '', description: '' }]); commit() }}
            className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary"
          >
            <Plus size={11} /> Add persona
          </button>
        }
      >
        <div className="flex flex-col gap-3">
          {personas.length === 0 && (
            <div className="text-[11px] text-text-muted/70 italic">No personas defined.</div>
          )}
          {personas.map((p, i) => (
            <div
              key={i}
              className="rounded-xl border border-black/[0.06] bg-white/40 p-3 flex flex-col gap-2"
            >
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={p.name}
                  placeholder="Persona name"
                  onChange={e => setPersona(i, { name: e.target.value })}
                  onBlur={commit}
                  className="flex-1 border-0 border-b border-transparent focus:border-text-primary/30 text-[13px] font-display bg-transparent focus:outline-none px-0.5 py-0.5"
                />
                <button
                  onClick={() => { update('target_personas', personas.filter((_, j) => j !== i)); commit() }}
                  className="p-1 text-text-muted hover:text-red-500 rounded hover:bg-black/[0.04]"
                  title="Remove"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <textarea
                value={p.description}
                rows={2}
                placeholder="Who they are, why they buy…"
                onChange={e => setPersona(i, { description: e.target.value })}
                onBlur={commit}
                className="w-full border border-black/[0.06] rounded-lg px-2.5 py-1.5 text-[11.5px] bg-white/60 focus:outline-none focus:border-text-primary/30 resize-none"
              />
            </div>
          ))}
        </div>
      </Card>

      <Card title="Jobs To Be Done" hint="When I __, I want to __, so I can __">
        <StringList
          values={profile.jobs_to_be_done || []}
          onChange={v => update('jobs_to_be_done', v)}
          onCommit={commit}
          placeholder="JTBD"
        />
      </Card>
      <Card title="Objections" hint="Reasons people don't buy">
        <StringList
          values={profile.objections || []}
          onChange={v => update('objections', v)}
          onCommit={commit}
          placeholder="Objection"
        />
      </Card>
    </>
  )
}

// ─────────────────────────────────────────────────────── voice & tone ──

function VoiceSection({ profile, update, commit }: SectionProps) {
  return (
    <>
      <Card title="Voice & Tone" hint="Free-form tone guide. sentence shape, rhythm, formality">
        <TextArea
          value={profile.voice_tone || ''}
          onChange={v => update('voice_tone', v)}
          onCommit={commit}
          rows={4}
        />
      </Card>
      <Card title="Voice attributes" hint="3–6 tone adjectives">
        <ChipList
          values={profile.voice_attributes || []}
          onChange={v => update('voice_attributes', v)}
          onCommit={commit}
          placeholder="Add adjective…"
        />
      </Card>
      <Card title="Do say / Don't say">
        <FieldLabel>Phrases we use</FieldLabel>
        <StringList
          values={profile.do_say || []}
          onChange={v => update('do_say', v)}
          onCommit={commit}
          placeholder="On-brand phrase"
        />
        <FieldLabel>Phrases we avoid</FieldLabel>
        <StringList
          values={profile.dont_say || []}
          onChange={v => update('dont_say', v)}
          onCommit={commit}
          placeholder="Off-brand phrase"
        />
      </Card>
      <Card title="Example snippets" hint="Sample on-brand copy">
        <StringList
          values={profile.example_snippets || []}
          onChange={v => update('example_snippets', v)}
          onCommit={commit}
          placeholder="Snippet"
        />
      </Card>
    </>
  )
}

// ────────────────────────────────────────────────── visual identity ──

function VisualSection({ profile, update, commit }: SectionProps) {
  const colors = profile.brand_colors || []
  const fonts = profile.brand_fonts || {}
  return (
    <>
      <Card title="Logo">
        <FieldLabel>Logo URL</FieldLabel>
        <TextInput
          value={profile.logo_url || ''}
          onChange={v => update('logo_url', v)}
          onCommit={commit}
          placeholder="https://…/logo.png"
        />
        {profile.logo_url && (
          <div className="rounded-xl bg-black/[0.02] border border-black/[0.06] flex items-center justify-center h-28 mt-2">
            <img
              src={profile.logo_url}
              alt="Logo preview"
              className="max-h-full max-w-full object-contain"
              onError={e => { (e.currentTarget.style.display = 'none') }}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div>
            <FieldLabel>Logo do's</FieldLabel>
            <StringList
              values={profile.logo_dos || []}
              onChange={v => update('logo_dos', v)}
              onCommit={commit}
              placeholder="Do…"
            />
          </div>
          <div>
            <FieldLabel>Logo don'ts</FieldLabel>
            <StringList
              values={profile.logo_donts || []}
              onChange={v => update('logo_donts', v)}
              onCommit={commit}
              placeholder="Don't…"
            />
          </div>
        </div>
      </Card>

      <Card
        title="Brand Colors"
        hint="HEX swatches with semantic role"
        action={
          <button
            onClick={() => { update('brand_colors', [...colors, { hex: '#000000', name: '', usage: '' }]); commit() }}
            className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary"
          >
            <Plus size={11} /> Add color
          </button>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Primary</FieldLabel>
            <TextInput
              value={profile.color_primary || ''}
              onChange={v => update('color_primary', v)}
              onCommit={commit}
              placeholder="#1A1A1A"
              mono
            />
          </div>
          <div>
            <FieldLabel>Secondary</FieldLabel>
            <TextInput
              value={profile.color_secondary || ''}
              onChange={v => update('color_secondary', v)}
              onCommit={commit}
              placeholder="#B7410E"
              mono
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          {colors.length === 0 && (
            <div className="text-[11px] text-text-muted/70 italic">No swatches yet.</div>
          )}
          {colors.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <div
                className="w-7 h-7 rounded-lg border border-black/[0.08] flex-shrink-0"
                style={{ background: c.hex }}
              />
              <input
                type="text"
                value={c.hex}
                placeholder="#000000"
                onChange={e => { const arr = [...colors]; arr[i] = { ...arr[i], hex: e.target.value }; update('brand_colors', arr) }}
                onBlur={commit}
                className="w-24 border border-black/[0.08] rounded-lg px-2 py-1.5 text-[11px] bg-white/60 focus:outline-none focus:border-text-primary/30 font-mono"
              />
              <input
                type="text"
                value={c.name}
                placeholder="Name"
                onChange={e => { const arr = [...colors]; arr[i] = { ...arr[i], name: e.target.value }; update('brand_colors', arr) }}
                onBlur={commit}
                className="flex-1 border border-black/[0.08] rounded-lg px-2 py-1.5 text-[11px] bg-white/60 focus:outline-none focus:border-text-primary/30"
              />
              <input
                type="text"
                value={c.usage}
                placeholder="usage (primary, accent…)"
                onChange={e => { const arr = [...colors]; arr[i] = { ...arr[i], usage: e.target.value }; update('brand_colors', arr) }}
                onBlur={commit}
                className="flex-1 border border-black/[0.08] rounded-lg px-2 py-1.5 text-[11px] bg-white/60 focus:outline-none focus:border-text-primary/30"
              />
              <button
                onClick={() => { update('brand_colors', colors.filter((_, j) => j !== i)); commit() }}
                className="p-1 text-text-muted hover:text-red-500 rounded hover:bg-black/[0.04]"
                title="Remove"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Typography">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Display</FieldLabel>
            <TextInput
              value={profile.typography_display || fonts.primary || ''}
              onChange={v => {
                update('typography_display', v)
                update('brand_fonts', { ...fonts, primary: v })
              }}
              onCommit={commit}
              placeholder="Canela, Tiempos…"
            />
          </div>
          <div>
            <FieldLabel>Body</FieldLabel>
            <TextInput
              value={profile.typography_body || fonts.secondary || ''}
              onChange={v => {
                update('typography_body', v)
                update('brand_fonts', { ...fonts, secondary: v })
              }}
              onCommit={commit}
              placeholder="Inter, Söhne, Helvetica…"
            />
          </div>
        </div>
      </Card>
    </>
  )
}

// ──────────────────────────────────────────────────────── products ──

function ProductsSection({ profile, update, commit }: SectionProps) {
  const products = profile.products || []
  const setProduct = (i: number, patch: Partial<Product>) => {
    const arr = [...products]
    arr[i] = { ...arr[i], ...patch }
    update('products', arr)
  }
  return (
    <>
      <Card title="Pricing & Merchandising">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Price range</FieldLabel>
            <TextInput
              value={profile.price_range || ''}
              onChange={v => update('price_range', v)}
              onCommit={commit}
              placeholder="$95. $1,200"
            />
          </div>
        </div>
        <div>
          <FieldLabel hint="How the catalog is organized">Merchandising notes</FieldLabel>
          <TextArea
            value={profile.merchandising_notes || ''}
            onChange={v => update('merchandising_notes', v)}
            onCommit={commit}
            rows={3}
          />
        </div>
      </Card>

      <Card
        title="Catalog"
        hint="Rich product entries. name, description, image, price, SKU"
        action={
          <button
            onClick={() => { update('products', [...products, { name: '', description: '' }]); commit() }}
            className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary"
          >
            <Plus size={11} /> Add product
          </button>
        }
      >
        <div className="flex flex-col gap-3">
          {products.length === 0 && (
            <div className="text-[11px] text-text-muted/70 italic">No products yet.</div>
          )}
          {products.map((p, i) => (
            <div
              key={i}
              className="rounded-xl border border-black/[0.06] bg-white/40 p-3 flex gap-3"
            >
              <div className="w-20 h-20 rounded-lg bg-black/[0.03] overflow-hidden flex items-center justify-center flex-shrink-0">
                {p.hero_image ? (
                  <img
                    src={p.hero_image}
                    alt={p.name}
                    className="w-full h-full object-cover"
                    onError={e => { (e.currentTarget.style.display = 'none') }}
                  />
                ) : (
                  <ImageIcon size={16} className="text-text-muted/60" />
                )}
              </div>
              <div className="flex-1 flex flex-col gap-2 min-w-0">
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={p.name}
                    placeholder="Product name"
                    onChange={e => setProduct(i, { name: e.target.value })}
                    onBlur={commit}
                    className="flex-1 border-0 border-b border-transparent focus:border-text-primary/30 text-[13px] font-display bg-transparent focus:outline-none px-0.5 py-0.5"
                  />
                  <button
                    onClick={() => { update('products', products.filter((_, j) => j !== i)); commit() }}
                    className="p-1 text-text-muted hover:text-red-500 rounded hover:bg-black/[0.04]"
                    title="Remove"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <textarea
                  value={p.description || ''}
                  rows={2}
                  placeholder="Product description…"
                  onChange={e => setProduct(i, { description: e.target.value })}
                  onBlur={commit}
                  className="w-full border border-black/[0.06] rounded-lg px-2.5 py-1.5 text-[11.5px] bg-white/60 focus:outline-none focus:border-text-primary/30 resize-none"
                />
                <div className="grid grid-cols-3 gap-1.5">
                  <input
                    type="text"
                    value={p.hero_image || ''}
                    placeholder="image URL"
                    onChange={e => setProduct(i, { hero_image: e.target.value })}
                    onBlur={commit}
                    className="border border-black/[0.06] rounded-lg px-2 py-1.5 text-[10.5px] bg-white/60 focus:outline-none focus:border-text-primary/30"
                  />
                  <input
                    type="text"
                    value={p.price_range || ''}
                    placeholder="price"
                    onChange={e => setProduct(i, { price_range: e.target.value })}
                    onBlur={commit}
                    className="border border-black/[0.06] rounded-lg px-2 py-1.5 text-[10.5px] bg-white/60 focus:outline-none focus:border-text-primary/30"
                  />
                  <input
                    type="text"
                    value={p.sku || ''}
                    placeholder="SKU"
                    onChange={e => setProduct(i, { sku: e.target.value })}
                    onBlur={commit}
                    className="border border-black/[0.06] rounded-lg px-2 py-1.5 text-[10.5px] bg-white/60 focus:outline-none focus:border-text-primary/30"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}

// ─────────────────────────────────────────────────────── social ──

function SocialSection({ profile, update, commit }: SectionProps) {
  const s = profile.social_links || {}
  const setLink = (k: keyof SocialLinks, v: string) => update('social_links', { ...s, [k]: v })
  return (
    <Card title="Social Channels">
      <div className="flex flex-col gap-3">
        <div>
          <FieldLabel>Website</FieldLabel>
          <div className="flex items-center gap-2">
            <Globe size={13} className="text-text-muted" />
            <TextInput
              value={s.website || ''}
              onChange={v => setLink('website', v)}
              onCommit={commit}
              placeholder="https://brand.com"
            />
          </div>
        </div>
        <div>
          <FieldLabel>Instagram</FieldLabel>
          <div className="flex items-center gap-2">
            <AtSign size={13} className="text-text-muted" />
            <TextInput
              value={s.instagram || ''}
              onChange={v => setLink('instagram', v)}
              onCommit={commit}
              placeholder="https://instagram.com/handle"
            />
          </div>
        </div>
        <div>
          <FieldLabel>TikTok</FieldLabel>
          <div className="flex items-center gap-2">
            <Music2 size={13} className="text-text-muted" />
            <TextInput
              value={s.tiktok || ''}
              onChange={v => setLink('tiktok', v)}
              onCommit={commit}
              placeholder="https://tiktok.com/@handle"
            />
          </div>
        </div>
      </div>
    </Card>
  )
}

// ────────────────────────────────────────────────── performance ──

function PerformanceSection({ profile, update, commit }: SectionProps) {
  return (
    <>
      <Card title="Targets" hint="Used by P&L, MMM, and Forecast as anchors">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <FieldLabel>CAC target</FieldLabel>
            <TextInput
              value={profile.cac_target || ''}
              onChange={v => update('cac_target', v)}
              onCommit={commit}
              placeholder="$45"
            />
          </div>
          <div>
            <FieldLabel>LTV target</FieldLabel>
            <TextInput
              value={profile.ltv_target || ''}
              onChange={v => update('ltv_target', v)}
              onCommit={commit}
              placeholder="$220"
            />
          </div>
          <div>
            <FieldLabel>Gross margin</FieldLabel>
            <TextInput
              value={profile.margin_target || ''}
              onChange={v => update('margin_target', v)}
              onCommit={commit}
              placeholder="62%"
            />
          </div>
        </div>
      </Card>
      <Card title="Top Channels" hint="Where the brand actually spends">
        <ChipList
          values={profile.top_channels || []}
          onChange={v => update('top_channels', v)}
          onCommit={commit}
          placeholder="Meta, Google, Email…"
        />
      </Card>
      <Card title="Cost structure" hint="Edit detailed P&L assumptions on the P&L tab">
        <a
          href="?tab=pnl"
          className="inline-flex items-center gap-1.5 text-[11px] text-[#B7410E] hover:underline"
        >
          Open P&L view <ExternalLink size={11} />
        </a>
      </Card>
    </>
  )
}

// ──────────────────────────────────────────────────────── compliance ──

function ComplianceSection({ profile, update, commit }: SectionProps) {
  return (
    <>
      <Card title="Claims allowed">
        <StringList
          values={profile.claims_allowed || []}
          onChange={v => update('claims_allowed', v)}
          onCommit={commit}
          placeholder="What we CAN say"
        />
      </Card>
      <Card title="Claims avoided">
        <StringList
          values={profile.claims_avoided || []}
          onChange={v => update('claims_avoided', v)}
          onCommit={commit}
          placeholder="What we must NEVER say"
        />
      </Card>
      <Card title="Trademarks">
        <ChipList
          values={profile.trademarks || []}
          onChange={v => update('trademarks', v)}
          onCommit={commit}
          placeholder="Add ™ mark"
        />
      </Card>
    </>
  )
}

// ──────────────────────────────────────────────────────── taxonomy ──

const TAXONOMY_FIELDS: Array<{ key: string; label: string; hint?: string }> = [
  { key: 'personas', label: 'Personas', hint: 'Who the ad speaks to' },
  { key: 'angles', label: 'Angles', hint: 'Creative hook or value prop' },
  { key: 'moments', label: 'Moments', hint: 'Named concept or beat' },
  { key: 'emotions', label: 'Emotions' },
  { key: 'categories', label: 'Categories' },
  { key: 'collections', label: 'Collections' },
  { key: 'offers', label: 'Offers' },
  { key: 'products', label: 'Products' },
  { key: 'concepts', label: 'Concepts' },
  { key: 'formats', label: 'Formats' },
  { key: 'templates', label: 'Templates' },
  { key: 'funnel_positions', label: 'Funnel positions' },
  { key: 'production_styles', label: 'Production styles' },
  { key: 'qualities', label: 'Quality tiers' },
  { key: 'ratios', label: 'Aspect ratios' },
  { key: 'placements', label: 'Placements' },
  { key: 'overlays', label: 'Overlay options' },
  { key: 'managers', label: 'Managers' },
  { key: 'hooks', label: 'Hooks' },
  { key: 'bodies', label: 'Body copy' },
  { key: 'ctas', label: 'CTAs' },
  { key: 'weeks', label: 'Weeks' },
  { key: 'custom_1', label: 'Custom 1' },
  { key: 'custom_2', label: 'Custom 2' },
  { key: 'custom_3', label: 'Custom 3' },
  { key: 'custom_4', label: 'Custom 4' },
]

function TaxonomySection({
  brand, profile, update,
}: {
  brand: string
  profile: Profile
  update: <K extends keyof Profile>(k: K, v: Profile[K]) => void
}) {
  const tax: Taxonomy = profile.planner_taxonomy || {}
  const [loading, setLoading] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (profile.planner_taxonomy) return
    setLoading(true)
    fetch(`/api/planner/taxonomy?brand=${encodeURIComponent(brand)}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d.taxonomy) update('planner_taxonomy', d.taxonomy)
      })
      .catch(e => !cancelled && setErr(String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand])

  const persist = async (next: Taxonomy) => {
    setErr(null)
    update('planner_taxonomy', next)
    try {
      const r = await fetch(`/api/planner/taxonomy?brand=${encodeURIComponent(brand)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!r.ok) throw new Error(await r.text())
      setSavedMsg('Saved')
      setTimeout(() => setSavedMsg(null), 1200)
    } catch (e) {
      setErr(String(e))
    }
  }

  if (loading) {
    return (
      <Card>
        <div className="flex items-center justify-center py-8">
          <Loader2 size={16} className="animate-spin text-text-muted" />
        </div>
      </Card>
    )
  }

  return (
    <>
      <Card
        title="Planner Taxonomy"
        hint="Per-brand picklists that back every Creative Planner dropdown"
      >
        {savedMsg && (
          <div className="text-[10px] text-[#2d8a4e] inline-flex items-center gap-1">
            <Check size={11} /> {savedMsg}
          </div>
        )}
        {err && (
          <div className="rounded-lg p-2 text-[11px] text-red-600 border border-red-200 bg-red-50/70">
            {err}
          </div>
        )}
        <div className="flex flex-col divide-y divide-black/[0.05]">
          {TAXONOMY_FIELDS.map(f => {
            const vals = tax[f.key] || []
            return (
              <div key={f.key} className="py-2 flex flex-col gap-1.5">
                <div className="flex items-baseline gap-2">
                  <div className="text-[11px] font-medium text-text-primary">{f.label}</div>
                  {f.hint && <div className="text-[10px] text-text-muted/70">{f.hint}</div>}
                  <div className="ml-auto text-[10px] text-text-muted/70">
                    {vals.length} {vals.length === 1 ? 'value' : 'values'}
                  </div>
                </div>
                <ChipList
                  values={vals}
                  onChange={v => persist({ ...tax, [f.key]: v })}
                  placeholder="Add value…"
                />
              </div>
            )
          })}
        </div>
      </Card>
    </>
  )
}

// ────────────────────────────────────────────────────────── naming ──

function NamingSection({ profile, update, commit }: SectionProps) {
  const conv: NamingConvention = profile.naming_convention || DEFAULT_NAMING_CONVENTION
  const [sample, setSample] = useState('')
  const setConv = (next: NamingConvention) => { update('naming_convention', next); commit() }

  const addPosition = () => {
    const used = new Set(conv.positions.map(p => p.number))
    let next = 1
    while (used.has(next)) next++
    setConv({ ...conv, positions: [...conv.positions, { number: next, label: '' }] })
  }
  const updatePosition = (idx: number, patch: Partial<{ number: number; label: string }>) => {
    const positions = conv.positions.map((p, i) => i === idx ? { ...p, ...patch } : p)
    setConv({ ...conv, positions })
  }
  const removePosition = (idx: number) => {
    setConv({ ...conv, positions: conv.positions.filter((_, i) => i !== idx) })
  }

  const parsed = useMemo(() => parseAdName(sample, conv), [sample, conv])

  return (
    <>
      <Card title="Separator" hint="Character that joins position tokens in the ad name">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={conv.separator}
            onChange={e => setConv({ ...conv, separator: e.target.value })}
            className="w-20 border border-black/[0.08] rounded-lg px-2.5 py-1.5 text-xs bg-white/60 focus:outline-none focus:border-text-primary/30 text-center font-mono"
            placeholder="_"
          />
          <span className="text-[11px] text-text-muted/70">
            Each token is <code>&lt;number&gt;:&lt;value&gt;</code>; tokens are joined by this separator.
          </span>
        </div>
      </Card>
      <Card
        title="Positions"
        hint="Label each numeric position. labels show up in Creative Analysis Group By"
        action={
          <button
            onClick={addPosition}
            className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary"
          >
            <Plus size={11} /> Add position
          </button>
        }
      >
        <div className="flex flex-col gap-1.5">
          {conv.positions.length === 0 && (
            <div className="text-[11px] text-text-muted/70 italic">No positions defined yet.</div>
          )}
          {conv.positions.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={p.number}
                onChange={e => updatePosition(i, { number: Number(e.target.value) || 1 })}
                className="w-16 border border-black/[0.08] rounded-lg px-2 py-1.5 text-xs bg-white/60 focus:outline-none focus:border-text-primary/30 text-center font-mono"
              />
              <span className="text-text-muted text-xs">→</span>
              <input
                type="text"
                value={p.label}
                onChange={e => updatePosition(i, { label: e.target.value })}
                placeholder="e.g. Persona, Angle, Concept"
                className="flex-1 border border-black/[0.08] rounded-lg px-2.5 py-1.5 text-xs bg-white/60 focus:outline-none focus:border-text-primary/30"
              />
              <button
                onClick={() => removePosition(i)}
                className="p-1 rounded hover:bg-black/[0.04] text-text-muted hover:text-red-600"
                title="Remove"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Preview" hint="Paste a real ad name to confirm the mapping">
        <input
          type="text"
          value={sample}
          onChange={e => setSample(e.target.value)}
          placeholder={`e.g. 1:BigSpender${conv.separator || '_'}2:UGC${conv.separator || '_'}3:DTC`}
          className="w-full border border-black/[0.08] rounded-lg px-2.5 py-1.5 text-xs bg-white/60 focus:outline-none focus:border-text-primary/30 font-mono"
        />
        {sample && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {conv.positions.length === 0 ? (
              <div className="text-[11px] text-text-muted/70">Add positions above to see the parse result.</div>
            ) : conv.positions.map(p => {
              const v = parsed[p.label]
              return (
                <div
                  key={`${p.number}-${p.label}`}
                  className="text-[10px] flex items-center gap-1 px-2 py-0.5 rounded-full"
                  style={v
                    ? { backgroundColor: 'rgba(183, 65, 14, 0.1)', color: '#B7410E' }
                    : { backgroundColor: 'rgba(0,0,0,0.04)', color: 'var(--color-text-muted)' }}
                >
                  <span className="font-mono opacity-70">{p.number}</span>
                  <span className="opacity-60">·</span>
                  <span>{p.label || '(unnamed)'}</span>
                  <span className="opacity-50">→</span>
                  <span className="font-medium">{v || '-'}</span>
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </>
  )
}

// ──────────────────────────────────────────────────────── keywords ──

function KeywordsSection({
  brand, profile, update,
}: {
  brand: string
  profile: Profile
  update: <K extends keyof Profile>(k: K, v: Profile[K]) => void
}) {
  const kws: Keyword[] = profile.trend_keywords || []
  const [loading, setLoading] = useState(false)
  const [regenLoading, setRegenLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (profile.trend_keywords) return
    setLoading(true)
    fetch(`/api/trends/keywords?brand=${encodeURIComponent(brand)}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d.keywords) update('trend_keywords', d.keywords)
      })
      .catch(e => !cancelled && setErr(String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand])

  const persist = async (next: Keyword[]) => {
    update('trend_keywords', next)
    setErr(null)
    try {
      await fetch(`/api/trends/keywords?brand=${encodeURIComponent(brand)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: next }),
      })
    } catch (e) {
      setErr(String(e))
    }
  }

  const updateAt = (i: number, patch: Partial<Keyword>) => {
    persist(kws.map((k, idx) => idx === i ? { ...k, ...patch } : k))
  }
  const add = () => persist([...kws, { label: 'New keyword', query: '', visible: true }])
  const remove = (i: number) => persist(kws.filter((_, idx) => idx !== i))

  const regenerate = async () => {
    setRegenLoading(true)
    setErr(null)
    try {
      const r = await fetch(`/api/trends/keywords?brand=${encodeURIComponent(brand)}&regen=true`)
      const d = await r.json()
      if (d.error) setErr(d.error)
      else if (d.keywords) update('trend_keywords', d.keywords)
    } catch (e) {
      setErr(String(e))
    } finally {
      setRegenLoading(false)
    }
  }

  return (
    <Card
      title="Trend Keywords"
      hint="Up to 5 charted on the Trends view. saved to the brand profile"
      action={
        <>
          <button
            onClick={add}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] border border-black/[0.08] hover:bg-black/[0.04]"
          >
            <Plus size={11} /> Add
          </button>
          <button
            onClick={regenerate}
            disabled={regenLoading}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] border border-black/[0.08] hover:bg-black/[0.04] disabled:opacity-50"
            title="Regenerate via Claude"
          >
            {regenLoading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            Regenerate
          </button>
        </>
      }
    >
      {loading && kws.length === 0 ? (
        <div className="flex items-center justify-center py-6"><Loader2 size={16} className="animate-spin text-text-muted" /></div>
      ) : (
        <>
          {err && (
            <div className="rounded-lg p-2 text-[11px] text-red-600 border border-red-200 bg-red-50/70">{err}</div>
          )}
          {kws.length === 0 ? (
            <div className="text-[11px] text-text-muted/80 text-center py-4">
              No keywords yet. <b>Regenerate</b> picks 4 via Claude or <b>Add</b> creates one manually.
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-black/[0.05]">
              {kws.map((kw, i) => (
                <div key={i} className="py-2 flex gap-2 items-center first:pt-0 last:pb-0">
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: ['#B7410E', '#2563eb', '#059669', '#7c3aed'][i % 4] }}
                  />
                  <div className="flex-1 grid grid-cols-2 gap-1.5 min-w-0">
                    <input
                      type="text"
                      value={kw.label}
                      onChange={e => updateAt(i, { label: e.target.value })}
                      placeholder="Label"
                      className="border border-black/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] bg-white/60 focus:outline-none focus:border-text-primary/30"
                    />
                    <input
                      type="text"
                      value={kw.query}
                      onChange={e => updateAt(i, { query: e.target.value })}
                      placeholder="Search query"
                      className="border border-black/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] bg-white/60 focus:outline-none focus:border-text-primary/30"
                    />
                  </div>
                  <button
                    onClick={() => remove(i)}
                    className="p-1.5 text-text-muted hover:text-red-500 rounded hover:bg-black/[0.04]"
                    title="Delete"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  )
}

// ────────────────────────────────────────────────── docs / uploads ──

function DocsSection({
  brand, profile, onApplied,
}: {
  brand: string
  profile: Profile
  onApplied: (p: Profile) => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<IngestResult | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const ingest = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return
    setBusy(true)
    setErr(null)
    setResult(null)
    try {
      const fd = new FormData()
      for (const f of list) fd.append('files', f, f.name)
      const r = await fetch(`/api/brand-profiles/${encodeURIComponent(brand)}/ingest-doc`, {
        method: 'POST',
        body: fd,
      })
      if (!r.ok) throw new Error(await r.text())
      const d: IngestResult = await r.json()
      setResult(d)
      const pre = new Set<string>()
      ;(d.diff || []).forEach(row => {
        if (row.action !== 'noop') pre.add(row.field)
      })
      setSelected(pre)
      if (d.extraction_error) setErr(d.extraction_error)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  const applySelected = async () => {
    if (!result) return
    setApplying(true)
    setErr(null)
    try {
      const r = await fetch(`/api/brand-profiles/${encodeURIComponent(brand)}/apply-extraction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extraction: result.extraction,
          accept_fields: Array.from(selected),
          docs_meta: result.docs_meta,
        }),
      })
      if (!r.ok) throw new Error(await r.text())
      const merged: Profile = await r.json()
      onApplied(merged)
      setResult(null)
      setSelected(new Set())
    } catch (e) {
      setErr(String(e))
    } finally {
      setApplying(false)
    }
  }

  const diffCount = useMemo(() => {
    if (!result) return 0
    return result.diff.filter(r => r.action !== 'noop').length
  }, [result])

  const uploaded = profile.uploaded_docs || []

  return (
    <>
      <Card title="Upload brand docs" hint=".txt .md .csv .pdf .docx. Claude extracts playbook fields and shows a diff to review.">
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault()
            setDragOver(false)
            if (e.dataTransfer?.files?.length) ingest(e.dataTransfer.files)
          }}
          onClick={() => fileInputRef.current?.click()}
          className={`rounded-xl border-2 border-dashed cursor-pointer transition-colors px-4 py-10 text-center flex flex-col items-center gap-2 ${
            dragOver ? 'border-[#B7410E]/50 bg-[#B7410E]/5' : 'border-black/[0.12] hover:bg-black/[0.015]'
          }`}
        >
          <Upload size={20} className="text-text-muted" />
          <div className="text-[13px] font-display">Drop brand docs here</div>
          <div className="text-[11px] text-text-muted">or click to browse. .txt .md .csv .pdf .docx</div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.markdown,.csv,.pdf,.docx,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={e => e.target.files && ingest(e.target.files)}
          />
        </div>
        {busy && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-text-muted">
            <Loader2 size={12} className="animate-spin" /> Extracting and asking Claude to map fields…
          </div>
        )}
        {err && (
          <div className="mt-2 rounded-lg p-2 text-[11px] text-red-600 border border-red-200 bg-red-50/70 flex items-start gap-1.5">
            <AlertCircle size={12} className="flex-shrink-0 mt-0.5" />
            <span>{err}</span>
          </div>
        )}
      </Card>

      {result && (
        <Card
          title="Review & merge"
          hint={`Claude proposes ${diffCount} change${diffCount === 1 ? '' : 's'}. Toggle to accept/reject.`}
          action={
            <>
              <button
                onClick={() => setSelected(new Set(result.diff.filter(r => r.action !== 'noop').map(r => r.field)))}
                className="rounded-full px-2.5 py-1 text-[11px] border border-black/[0.08] hover:bg-black/[0.04]"
              >
                Select all
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="rounded-full px-2.5 py-1 text-[11px] border border-black/[0.08] hover:bg-black/[0.04]"
              >
                Clear
              </button>
              <button
                onClick={applySelected}
                disabled={applying || selected.size === 0}
                className="rounded-full px-2.5 py-1 text-[11px] font-medium text-white flex items-center gap-1 disabled:opacity-50"
                style={{ backgroundColor: '#B7410E' }}
              >
                {applying ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                Apply {selected.size > 0 ? `${selected.size} field${selected.size === 1 ? '' : 's'}` : 'selected'}
              </button>
            </>
          }
        >
          {result.files.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {result.files.map((f, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-[10.5px] bg-white/80 border border-black/[0.08] rounded-full pl-2 pr-2.5 py-0.5 text-text-secondary"
                  title={f.error || undefined}
                >
                  <FileText size={10} />
                  {f.filename}
                  <span className="text-text-muted">· {(f.size_bytes / 1024).toFixed(1)} KB</span>
                  {f.pages ? <span className="text-text-muted">· {f.pages}p</span> : null}
                </span>
              ))}
            </div>
          )}
          {diffCount === 0 ? (
            <div className="text-[11px] text-text-muted/80 text-center py-4">
              Nothing new to merge.
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-black/[0.05]">
              {result.diff.filter(r => r.action !== 'noop').map(row => {
                const checked = selected.has(row.field)
                return (
                  <div key={row.field} className="py-2 flex gap-2 items-start first:pt-0 last:pb-0">
                    <button
                      onClick={() => {
                        const next = new Set(selected)
                        if (checked) next.delete(row.field); else next.add(row.field)
                        setSelected(next)
                      }}
                      className="pt-0.5 flex-shrink-0"
                      title="Toggle"
                    >
                      {checked ? (
                        <CheckCircle2 size={14} style={{ color: '#B7410E' }} />
                      ) : (
                        <span className="block w-3.5 h-3.5 rounded-full border border-text-muted/40" />
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <div className="text-[11px] font-medium text-text-primary">{row.field}</div>
                        <span
                          className="text-[9px] uppercase tracking-widest rounded-full px-1.5 py-0.5"
                          style={{
                            color: row.action === 'add' ? '#2d8a4e' : row.action === 'extend' ? '#B7410E' : '#c47a15',
                            backgroundColor: `${row.action === 'add' ? '#2d8a4e' : row.action === 'extend' ? '#B7410E' : '#c47a15'}18`,
                          }}
                        >
                          {row.action}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mt-1">
                        <DiffSide label="Current" value={row.current} muted />
                        <DiffSide label="Proposed" value={row.proposed} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      )}

      {uploaded.length > 0 && (
        <Card title="Recent uploads" hint="History stored under brand_uploads/<brand>/">
          <div className="flex flex-col divide-y divide-black/[0.05]">
            {uploaded.slice().reverse().slice(0, 12).map((u, i) => (
              <div key={i} className="py-1.5 flex items-center gap-2 text-[11px]">
                <FileText size={11} className="text-text-muted flex-shrink-0" />
                <span className="flex-1 truncate">{u.filename}</span>
                {u.fields_extracted && u.fields_extracted.length > 0 && (
                  <span className="text-[10px] text-text-muted">
                    {u.fields_extracted.length} field{u.fields_extracted.length === 1 ? '' : 's'}
                  </span>
                )}
                {u.uploaded_at && (
                  <span className="text-[10px] text-text-muted">
                    {new Date(u.uploaded_at).toLocaleDateString()}
                  </span>
                )}
                {u.parse_error && <AlertCircle size={10} className="text-red-400" />}
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  )
}

function DiffSide({ label, value, muted }: { label: string; value: unknown; muted?: boolean }) {
  const render = () => {
    if (value === null || value === undefined || value === '') return <em className="text-text-muted/60">empty</em>
    if (Array.isArray(value)) {
      if (value.length === 0) return <em className="text-text-muted/60">empty</em>
      return (
        <div className="flex flex-wrap gap-1">
          {value.map((v, i) => (
            <span key={i} className="inline-block bg-white/80 border border-black/[0.08] rounded-full px-1.5 py-0.5">
              {typeof v === 'object' ? JSON.stringify(v) : String(v)}
            </span>
          ))}
        </div>
      )
    }
    if (typeof value === 'object') return <code className="text-[10px]">{JSON.stringify(value)}</code>
    return <span>{String(value)}</span>
  }
  return (
    <div className={`text-[10.5px] ${muted ? 'text-text-muted' : 'text-text-secondary'}`}>
      <div className="uppercase tracking-widest text-[9px] mb-0.5 opacity-70">{label}</div>
      <div className="rounded-lg border border-black/[0.06] bg-white/50 px-2 py-1.5 min-h-[24px]">
        {render()}
      </div>
    </div>
  )
}
