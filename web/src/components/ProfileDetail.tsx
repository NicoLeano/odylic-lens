import { useEffect, useMemo, useRef, useState } from 'react'
import {
  X, Save, RefreshCw, Loader2, Plus, Trash2, Sparkles, Download, Upload, Search,
  ChevronDown, ChevronRight, FileText, FileCheck2, CheckCircle2, Circle, AlertCircle,
} from 'lucide-react'
import type { NamingConvention } from './ads/namingConvention'
import { DEFAULT_NAMING_CONVENTION, parseAdName } from './ads/namingConvention'

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
  // existing
  domain?: string
  description?: string
  hero_products?: string[]
  categories?: string[]
  target_personas?: Persona[]
  favicon?: string | null
  // Visual Identity
  logo_url?: string
  brand_colors?: BrandColor[]
  brand_fonts?: BrandFonts
  // Products
  products?: Product[]
  // Voice & Positioning
  voice_tone?: string
  competitors?: string[]
  unique_value_props?: string[]
  // Social
  social_links?: SocialLinks
  // Consolidated fields (single source of truth)
  planner_taxonomy?: Taxonomy
  trend_keywords?: Keyword[]
  // ── Extended brand-playbook schema (Interbrand / Wolff Olins / McKinsey
  //    framework synthesis). All optional; old records just have undefined.
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
  // Per-brand ad naming convention used to parse ad_name into structured
  // fields (Persona, Angle, Concept …) that show up in Creative Analysis
  // Group-By.
  naming_convention?: NamingConvention
  error?: string
}

// Ingest-doc diff entry returned by POST /api/brand-profiles/:brand/ingest-doc
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

interface Props {
  brand: string
  onClose: () => void
}

type Tab =
  | 'overview'
  | 'strategy'
  | 'visual'
  | 'products'
  | 'voice'
  | 'social'
  | 'taxonomy'
  | 'naming'
  | 'keywords'
  | 'upload'

const TABS: { k: Tab; label: string }[] = [
  { k: 'overview', label: 'Overview' },
  { k: 'strategy', label: 'Strategy' },
  { k: 'visual', label: 'Visual' },
  { k: 'products', label: 'Products' },
  { k: 'voice', label: 'Voice' },
  { k: 'social', label: 'Social' },
  { k: 'taxonomy', label: 'Taxonomy' },
  { k: 'naming', label: 'Naming' },
  { k: 'keywords', label: 'Keywords' },
  { k: 'upload', label: 'Docs' },
]

// Planner taxonomy fields (mirror of planner_endpoints.TAXONOMY_FIELDS).
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

export function ProfileDetail({ brand, onClose }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deepLoading, setDeepLoading] = useState(false)
  const [tab, setTab] = useState<Tab>('overview')

  const load = async (regen = false) => {
    setLoading(true)
    try {
      const r = await fetch(`/api/profile?brand=${encodeURIComponent(brand)}&regen=${regen}`)
      const d = await r.json()
      setProfile(d)
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [brand])

  const save = async () => {
    if (!profile) return
    setSaving(true)
    try {
      const r = await fetch(`/api/profile?brand=${encodeURIComponent(brand)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      })
      const d = await r.json()
      setProfile(d)
    } finally { setSaving(false) }
  }

  const regenerateDeep = async () => {
    setDeepLoading(true)
    try {
      const r = await fetch(`/api/profile/generate-deep?brand=${encodeURIComponent(brand)}`, {
        method: 'POST',
      })
      const d = await r.json()
      setProfile(d)
    } finally { setDeepLoading(false) }
  }

  const update = <K extends keyof Profile>(k: K, v: Profile[K]) =>
    setProfile(p => p ? { ...p, [k]: v } : p)

  return (
    <div className="fixed inset-0 bg-black/30 flex items-start justify-center" style={{ zIndex: 100000 }}
      onClick={onClose}>
      <div className="mt-16 w-[760px] max-h-[85vh] overflow-hidden bg-white rounded-2xl shadow-2xl border border-black/[0.08] flex flex-col"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-black/[0.06] bg-white">
          {profile?.favicon && <img src={profile.favicon} alt="" className="w-5 h-5 rounded" />}
          <div className="flex-1 min-w-0">
            <div className="font-display text-base font-medium">{brand}</div>
            {profile?.domain && (
              <a href={`https://${profile.domain}`} target="_blank" rel="noreferrer"
                className="text-[10px] text-text-muted hover:text-text-primary truncate block">
                {profile.domain}
              </a>
            )}
          </div>
          <button onClick={regenerateDeep} disabled={deepLoading}
            className="px-2.5 py-1.5 rounded-full text-[11px] font-medium flex items-center gap-1 disabled:opacity-50"
            style={{ color: '#B7410E', backgroundColor: 'rgba(183, 65, 14, 0.1)' }}
            title="Regenerate deep profile with Odylic Studio AI">
            {deepLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            Deep profile
          </button>
          <button onClick={() => load(true)} disabled={loading}
            className="p-1.5 rounded hover:bg-black/[0.04] text-text-muted hover:text-text-primary" title="Regenerate (basic)">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
          <button onClick={save} disabled={saving || !profile}
            className="px-3 py-1.5 rounded-full bg-text-primary text-white text-xs font-medium flex items-center gap-1 disabled:opacity-50">
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            Save
          </button>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-black/[0.04]"><X size={14} /></button>
        </div>

        {/* Master scroll body. the *only* scroller. Everything inside stacks
            flat and lets this container do the scrolling. Tabs are sticky so
            the user can switch while scrolled deep. */}
        <div className="flex-1 overflow-y-auto">
          <div className="sticky top-0 z-10 flex items-center gap-1 px-4 py-2 border-b border-black/[0.06] bg-white/95 backdrop-blur-sm">
            {TABS.map(t => (
              <button key={t.k} onClick={() => setTab(t.k)}
                className={`px-2.5 py-1 rounded-full text-[11px] transition-colors ${
                  tab === t.k
                    ? 'text-white'
                    : 'text-text-muted hover:text-text-primary hover:bg-black/[0.04]'
                }`}
                style={tab === t.k ? { backgroundColor: '#B7410E' } : undefined}>
                {t.label}
              </button>
            ))}
          </div>

          {loading && !profile ? (
            <div className="flex items-center justify-center p-12"><Loader2 size={20} className="animate-spin text-text-muted" /></div>
          ) : profile?.error ? (
            <div className="p-6 text-red-600 text-xs">{profile.error}</div>
          ) : profile ? (
            <div className="px-4 py-3 text-xs">
              {tab === 'overview' && <OverviewTab profile={profile} update={update} />}
              {tab === 'strategy' && <StrategyTab profile={profile} update={update} />}
              {tab === 'visual' && <VisualTab profile={profile} update={update} />}
              {tab === 'products' && <ProductsTab profile={profile} update={update} />}
              {tab === 'voice' && <VoiceTab profile={profile} update={update} />}
              {tab === 'social' && <SocialTab profile={profile} update={update} />}
              {tab === 'taxonomy' && <TaxonomyTab brand={brand} profile={profile} update={update} />}
              {tab === 'naming' && <NamingTab profile={profile} update={update} />}
              {tab === 'keywords' && <KeywordsTab brand={brand} profile={profile} update={update} />}
              {tab === 'upload' && <UploadTab brand={brand} profile={profile} onApplied={setProfile} />}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────── Shared tab primitives ──

type TabProps = {
  profile: Profile
  update: <K extends keyof Profile>(k: K, v: Profile[K]) => void
}

// `Section` replaces the old "card-within-card" pattern. A flat vertical
// stack of these renders a tab; the outer modal body handles scrolling.
function Section({
  title,
  hint,
  action,
  children,
}: {
  title?: string
  hint?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="py-3 border-b border-black/[0.05] last:border-b-0 flex flex-col gap-1.5">
      {(title || action) && (
        <div className="flex items-baseline gap-2">
          {title && (
            <div className="text-[10px] uppercase tracking-widest text-text-muted">{title}</div>
          )}
          {hint && <div className="text-[10px] text-text-muted/70">{hint}</div>}
          {action && <div className="ml-auto flex items-center gap-1.5">{action}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input type="text" value={value} placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      className="w-full border border-black/[0.08] rounded-lg px-2.5 py-1.5 text-xs bg-white/60 focus:outline-none focus:border-text-primary/30" />
  )
}

function TextArea({ value, onChange, rows = 3, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return (
    <textarea value={value} rows={rows} placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      className="w-full border border-black/[0.08] rounded-lg px-2.5 py-1.5 text-xs bg-white/60 focus:outline-none focus:border-text-primary/30 resize-none" />
  )
}

// StringList. flat inline list of strings. No bordered container, no
// per-item card; each item is a lightweight row with an inline input and
// a remove icon. "+ Add" lives in the section header.
function StringList({
  title, values, onChange, placeholder, hint,
}: {
  title: string
  values: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  hint?: string
}) {
  return (
    <Section
      title={title}
      hint={hint}
      action={
        <button onClick={() => onChange([...values, ''])}
          className="text-text-muted hover:text-text-primary flex items-center gap-1 text-[11px]"
          title="Add">
          <Plus size={11} /> Add
        </button>
      }
    >
      <div className="flex flex-col gap-1">
        {values.length === 0 && (
          <div className="text-[11px] text-text-muted/70">None yet.</div>
        )}
        {values.map((v, i) => (
          <div key={i} className="flex items-center gap-1">
            <input type="text" value={v} placeholder={placeholder}
              onChange={e => { const arr = [...values]; arr[i] = e.target.value; onChange(arr) }}
              className="flex-1 border border-black/[0.08] rounded-lg px-2.5 py-1 text-xs bg-white/60 focus:outline-none focus:border-text-primary/30" />
            <button onClick={() => onChange(values.filter((_, j) => j !== i))}
              className="p-1 text-text-muted hover:text-red-500" title="Remove">
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
    </Section>
  )
}

// ────────────────────────────────────────────────────────────── Overview ──

function OverviewTab({ profile, update }: TabProps) {
  return (
    <>
      <Section title="Domain">
        <TextInput value={profile.domain || ''} onChange={v => update('domain', v)} placeholder="brand.com" />
      </Section>
      <Section title="Brand Description">
        <TextArea value={profile.description || ''} onChange={v => update('description', v)} rows={3} />
      </Section>
      <StringList title="Hero Products" values={profile.hero_products || []}
        onChange={v => update('hero_products', v)} />

      <Section
        title="Categories"
        action={
          <button onClick={() => update('categories', [...(profile.categories || []), ''])}
            className="text-text-muted hover:text-text-primary flex items-center gap-1 text-[11px]">
            <Plus size={11} /> Add
          </button>
        }
      >
        <div className="flex flex-wrap gap-1">
          {(profile.categories || []).length === 0 && (
            <div className="text-[11px] text-text-muted/70">None yet.</div>
          )}
          {(profile.categories || []).map((c, i) => (
            <div key={i} className="flex items-center gap-0.5 bg-black/[0.04] rounded-full pl-2.5 pr-0.5 py-0.5">
              <input type="text" value={c}
                onChange={e => {
                  const arr = [...(profile.categories || [])]; arr[i] = e.target.value
                  update('categories', arr)
                }}
                style={{ width: Math.max(60, (c?.length || 0) * 7 + 20) }}
                className="bg-transparent text-[11px] focus:outline-none" />
              <button onClick={() => update('categories', (profile.categories || []).filter((_, j) => j !== i))}
                className="p-0.5 text-text-muted hover:text-red-500" title="Remove">
                <X size={9} />
              </button>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Target Personas"
        hint="Who this brand is talking to"
        action={
          <button onClick={() => update('target_personas', [...(profile.target_personas || []), { name: '', description: '' }])}
            className="text-text-muted hover:text-text-primary flex items-center gap-1 text-[11px]">
            <Plus size={11} /> Add
          </button>
        }
      >
        <div className="flex flex-col divide-y divide-black/[0.05]">
          {(profile.target_personas || []).length === 0 && (
            <div className="text-[11px] text-text-muted/70 py-1">None yet.</div>
          )}
          {(profile.target_personas || []).map((p, i) => (
            <div key={i} className="py-2 flex flex-col gap-1 first:pt-0 last:pb-0">
              <div className="flex items-center gap-1">
                <input type="text" value={p.name} placeholder="Persona name"
                  onChange={e => {
                    const arr = [...(profile.target_personas || [])]
                    arr[i] = { ...arr[i], name: e.target.value }
                    update('target_personas', arr)
                  }}
                  className="flex-1 border-0 border-b border-transparent focus:border-text-primary/30 text-xs font-medium bg-transparent focus:outline-none px-1 py-0.5" />
                <button onClick={() => update('target_personas', (profile.target_personas || []).filter((_, j) => j !== i))}
                  className="p-1 text-text-muted hover:text-red-500" title="Remove">
                  <Trash2 size={11} />
                </button>
              </div>
              <textarea value={p.description} rows={2} placeholder="Who they are, why they buy…"
                onChange={e => {
                  const arr = [...(profile.target_personas || [])]
                  arr[i] = { ...arr[i], description: e.target.value }
                  update('target_personas', arr)
                }}
                className="w-full border border-black/[0.06] rounded px-2 py-1 text-[11px] bg-white/60 focus:outline-none focus:border-text-primary/30 resize-none" />
            </div>
          ))}
        </div>
      </Section>
    </>
  )
}

// ───────────────────────────────────────────────────────── Visual Identity ──

function VisualTab({ profile, update }: TabProps) {
  const colors = profile.brand_colors || []
  const fonts = profile.brand_fonts || {}
  return (
    <>
      <Section title="Logo URL">
        <TextInput value={profile.logo_url || ''} onChange={v => update('logo_url', v)} placeholder="https://…/logo.png" />
        {profile.logo_url && (
          <div className="mt-2 rounded-lg bg-black/[0.02] flex items-center justify-center h-20">
            <img src={profile.logo_url} alt="Logo preview"
              className="max-h-full max-w-full object-contain"
              onError={(e) => { (e.currentTarget.style.display = 'none') }} />
          </div>
        )}
      </Section>

      <Section
        title="Brand Colors"
        action={
          <button onClick={() => update('brand_colors', [...colors, { hex: '#000000', name: '', usage: '' }])}
            className="text-text-muted hover:text-text-primary flex items-center gap-1 text-[11px]">
            <Plus size={11} /> Add
          </button>
        }
      >
        <div className="flex flex-col gap-1">
          {colors.length === 0 && (
            <div className="text-[11px] text-text-muted/70">None yet.</div>
          )}
          {colors.map((c, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className="w-6 h-6 rounded border border-black/[0.08] flex-shrink-0"
                style={{ background: c.hex }} />
              <input type="text" value={c.hex} placeholder="#000000"
                onChange={e => {
                  const arr = [...colors]; arr[i] = { ...arr[i], hex: e.target.value }
                  update('brand_colors', arr)
                }}
                className="w-20 border border-black/[0.08] rounded px-2 py-1 text-[11px] bg-white/60 focus:outline-none focus:border-text-primary/30 font-mono" />
              <input type="text" value={c.name} placeholder="Name"
                onChange={e => {
                  const arr = [...colors]; arr[i] = { ...arr[i], name: e.target.value }
                  update('brand_colors', arr)
                }}
                className="flex-1 border border-black/[0.08] rounded px-2 py-1 text-[11px] bg-white/60 focus:outline-none focus:border-text-primary/30" />
              <input type="text" value={c.usage} placeholder="usage (primary…)"
                onChange={e => {
                  const arr = [...colors]; arr[i] = { ...arr[i], usage: e.target.value }
                  update('brand_colors', arr)
                }}
                className="flex-1 border border-black/[0.08] rounded px-2 py-1 text-[11px] bg-white/60 focus:outline-none focus:border-text-primary/30" />
              <button onClick={() => update('brand_colors', colors.filter((_, j) => j !== i))}
                className="p-1 text-text-muted hover:text-red-500" title="Remove">
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Brand Fonts">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1">Primary</div>
            <TextInput value={fonts.primary || ''}
              onChange={v => update('brand_fonts', { ...fonts, primary: v })}
              placeholder="Canela, Inter…" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1">Secondary</div>
            <TextInput value={fonts.secondary || ''}
              onChange={v => update('brand_fonts', { ...fonts, secondary: v })}
              placeholder="Söhne, Helvetica…" />
          </div>
        </div>
      </Section>
    </>
  )
}

// ────────────────────────────────────────────────────────────── Products ──

function ProductsTab({ profile, update }: TabProps) {
  const products = profile.products || []
  const setProduct = (i: number, patch: Partial<Product>) => {
    const arr = [...products]; arr[i] = { ...arr[i], ...patch }
    update('products', arr)
  }
  return (
    <Section
      title="Products"
      action={
        <button onClick={() => update('products', [...products, { name: '', description: '' }])}
          className="text-text-muted hover:text-text-primary flex items-center gap-1 text-[11px]">
          <Plus size={11} /> Add
        </button>
      }
    >
      <div className="flex flex-col divide-y divide-black/[0.05]">
        {products.length === 0 && (
          <div className="text-[11px] text-text-muted/70 py-1">None yet.</div>
        )}
        {products.map((p, i) => (
          <div key={i} className="py-2 flex gap-2 first:pt-0 last:pb-0">
            <div className="w-16 h-16 flex-shrink-0 rounded-lg bg-black/[0.03] overflow-hidden flex items-center justify-center">
              {p.hero_image ? (
                <img src={p.hero_image} alt={p.name} className="w-full h-full object-cover"
                  onError={(e) => { (e.currentTarget.style.display = 'none') }} />
              ) : (
                <div className="text-[9px] text-text-muted">no image</div>
              )}
            </div>
            <div className="flex-1 flex flex-col gap-1 min-w-0">
              <div className="flex items-center gap-1">
                <input type="text" value={p.name} placeholder="Product name"
                  onChange={e => setProduct(i, { name: e.target.value })}
                  className="flex-1 border-0 border-b border-transparent focus:border-text-primary/30 text-xs font-medium bg-transparent focus:outline-none px-1 py-0.5" />
                <button onClick={() => update('products', products.filter((_, j) => j !== i))}
                  className="p-1 text-text-muted hover:text-red-500" title="Remove">
                  <Trash2 size={11} />
                </button>
              </div>
              <textarea value={p.description || ''} rows={2} placeholder="Product description…"
                onChange={e => setProduct(i, { description: e.target.value })}
                className="w-full border border-black/[0.06] rounded px-2 py-1 text-[11px] bg-white/60 focus:outline-none focus:border-text-primary/30 resize-none" />
              <div className="grid grid-cols-3 gap-1">
                <input type="text" value={p.hero_image || ''} placeholder="image URL"
                  onChange={e => setProduct(i, { hero_image: e.target.value })}
                  className="border border-black/[0.06] rounded px-2 py-1 text-[10px] bg-white/60 focus:outline-none focus:border-text-primary/30" />
                <input type="text" value={p.price_range || ''} placeholder="price range"
                  onChange={e => setProduct(i, { price_range: e.target.value })}
                  className="border border-black/[0.06] rounded px-2 py-1 text-[10px] bg-white/60 focus:outline-none focus:border-text-primary/30" />
                <input type="text" value={p.sku || ''} placeholder="SKU"
                  onChange={e => setProduct(i, { sku: e.target.value })}
                  className="border border-black/[0.06] rounded px-2 py-1 text-[10px] bg-white/60 focus:outline-none focus:border-text-primary/30" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

// ────────────────────────────────────────────────── Voice & Positioning ──

function VoiceTab({ profile, update }: TabProps) {
  return (
    <>
      <Section title="Voice & Tone">
        <TextArea value={profile.voice_tone || ''} onChange={v => update('voice_tone', v)}
          rows={4} placeholder="Tone, word choice, sentence style…" />
      </Section>
      <StringList title="Competitors" values={profile.competitors || []}
        onChange={v => update('competitors', v)} placeholder="Competitor brand" />
      <StringList title="Unique Value Props" values={profile.unique_value_props || []}
        onChange={v => update('unique_value_props', v)} placeholder="UVP" />
    </>
  )
}

// ──────────────────────────────────────────────────────────────── Social ──

function SocialTab({ profile, update }: TabProps) {
  const s = profile.social_links || {}
  return (
    <>
      <Section title="Instagram">
        <TextInput value={s.instagram || ''} onChange={v => update('social_links', { ...s, instagram: v })}
          placeholder="https://instagram.com/handle" />
      </Section>
      <Section title="TikTok">
        <TextInput value={s.tiktok || ''} onChange={v => update('social_links', { ...s, tiktok: v })}
          placeholder="https://tiktok.com/@handle" />
      </Section>
      <Section title="Website">
        <TextInput value={s.website || ''} onChange={v => update('social_links', { ...s, website: v })}
          placeholder="https://brand.com" />
      </Section>
    </>
  )
}

// ──────────────────────────────────────────────────────────── Taxonomy ──
// Flat stacked layout. one row per taxonomy field. No nested scrollers,
// no per-field bordered cards. The outer modal body scrolls everything.
// Top toolbar carries Search, Download template, Import CSV, Save.

type TaxonomyTabProps = {
  brand: string
  profile: Profile
  update: <K extends keyof Profile>(k: K, v: Profile[K]) => void
}

function TaxonomyTab({ brand, profile, update }: TaxonomyTabProps) {
  const tax: Taxonomy = profile.planner_taxonomy || {}
  const [loading, setLoading] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [importOpen, setImportOpen] = useState(false)

  // Fetch from the planner endpoint on first mount to pick up any ARC_SEED /
  // xlsx-driven defaults the backend seeded on first touch.
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

  const setField = (field: string, vals: string[]) => {
    update('planner_taxonomy', { ...tax, [field]: vals })
    setSavedMsg(null)
  }

  const addValue = (field: string, v: string) => {
    const val = v.trim()
    if (!val) return
    const curr = tax[field] || []
    if (curr.includes(val)) return
    setField(field, [...curr, val])
  }

  const removeValue = (field: string, v: string) => {
    setField(field, (tax[field] || []).filter(x => x !== v))
  }

  const renameValue = (field: string, oldV: string, newV: string) => {
    const val = newV.trim()
    if (!val || val === oldV) return
    setField(field, (tax[field] || []).map(x => (x === oldV ? val : x)))
  }

  const persist = async () => {
    setErr(null)
    setSavedMsg(null)
    try {
      const r = await fetch(`/api/planner/taxonomy?brand=${encodeURIComponent(brand)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tax),
      })
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      if (d.taxonomy) update('planner_taxonomy', d.taxonomy)
      setSavedMsg('Saved')
      setTimeout(() => setSavedMsg(null), 1500)
    } catch (e) {
      setErr(String(e))
    }
  }

  const downloadTemplate = () => {
    const url = `/api/planner/taxonomy/template?brand=${encodeURIComponent(brand)}&format=csv`
    const a = document.createElement('a')
    a.href = url
    a.download = `${brand}_taxonomy_template.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const reloadAfterImport = async () => {
    try {
      const r = await fetch(`/api/planner/taxonomy?brand=${encodeURIComponent(brand)}`)
      const d = await r.json()
      if (d.taxonomy) update('planner_taxonomy', d.taxonomy)
    } catch (e) {
      setErr(String(e))
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return TAXONOMY_FIELDS
    return TAXONOMY_FIELDS.filter(f => {
      if (f.label.toLowerCase().includes(q)) return true
      if (f.key.toLowerCase().includes(q)) return true
      const vals = tax[f.key] || []
      return vals.some(v => v.toLowerCase().includes(q))
    })
  }, [query, tax])

  if (loading && !Object.keys(tax).length) {
    return <div className="flex items-center justify-center p-8"><Loader2 size={16} className="animate-spin text-text-muted" /></div>
  }

  return (
    <>
      <Section
        hint="Per-brand Planner picklists. back every dropdown in the Creative Planner grid."
        action={
          <>
            <button
              onClick={downloadTemplate}
              className="rounded-full px-2.5 py-1 text-[11px] border border-black/[0.08] hover:bg-black/[0.04] flex items-center gap-1"
              title="Download a CSV template pre-filled with existing values"
            >
              <Download size={11} /> Template
            </button>
            <button
              onClick={() => setImportOpen(true)}
              className="rounded-full px-2.5 py-1 text-[11px] border border-black/[0.08] hover:bg-black/[0.04] flex items-center gap-1"
              title="Import values from a CSV"
            >
              <Upload size={11} /> Import
            </button>
            <button onClick={persist}
              className="rounded-full px-2.5 py-1 text-[11px] font-medium flex items-center gap-1 text-white"
              style={{ backgroundColor: '#B7410E' }}>
              <Save size={11} /> Save
              {savedMsg && <span className="ml-1 text-[10px] opacity-80">· {savedMsg}</span>}
            </button>
          </>
        }
      >
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 flex-1 bg-white/60 border border-black/[0.08] rounded-full px-3 py-1">
            <Search size={12} className="text-text-muted" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search across all taxonomy fields…"
              className="flex-1 bg-transparent text-[11px] outline-none placeholder:text-text-muted/70 py-0.5"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-text-muted hover:text-text-primary" title="Clear">
                <X size={11} />
              </button>
            )}
          </div>
          <div className="text-[10px] text-text-muted/80 whitespace-nowrap">
            {filtered.length}/{TAXONOMY_FIELDS.length}
          </div>
        </div>
      </Section>

      {err && (
        <div className="rounded-lg p-2 text-[11px] text-red-600 border border-red-200 bg-red-50/70 mb-2">{err}</div>
      )}

      <div className="flex flex-col divide-y divide-black/[0.05]">
        {filtered.map(f => (
          <TaxonomyFieldRow key={f.key}
            label={f.label}
            hint={f.hint}
            values={tax[f.key] || []}
            onAdd={v => addValue(f.key, v)}
            onRemove={v => removeValue(f.key, v)}
            onRename={(oldV, newV) => renameValue(f.key, oldV, newV)}
          />
        ))}
        {filtered.length === 0 && (
          <div className="text-[11px] text-text-muted/80 text-center py-6">
            No fields match "{query}".
          </div>
        )}
      </div>

      {importOpen && (
        <ImportCsvModal
          brand={brand}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false)
            reloadAfterImport()
          }}
        />
      )}
    </>
  )
}

// Flat row. no bordered card, no inner scroll.
function TaxonomyFieldRow({
  label, hint, values, onAdd, onRemove, onRename,
}: {
  label: string
  hint?: string
  values: string[]
  onAdd: (v: string) => void
  onRemove: (v: string) => void
  onRename: (oldV: string, newV: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <div className="py-2 flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <div className="text-[11px] font-medium text-text-primary">{label}</div>
        {hint && <div className="text-[10px] text-text-muted">{hint}</div>}
        <div className="ml-auto text-[10px] text-text-muted/70">
          {values.length} {values.length === 1 ? 'value' : 'values'}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {values.length === 0 && <span className="text-[10px] text-text-muted/70">No values yet.</span>}
        {values.map(v =>
          editing === v ? (
            <input key={v} autoFocus defaultValue={v}
              onBlur={e => { onRename(v, e.currentTarget.value); setEditing(null) }}
              onKeyDown={e => {
                if (e.key === 'Enter') { onRename(v, (e.currentTarget as HTMLInputElement).value); setEditing(null) }
                if (e.key === 'Escape') setEditing(null)
              }}
              className="bg-white border border-black/10 rounded-full px-2 py-0.5 text-[10px] outline-none" />
          ) : (
            <span key={v} className="inline-flex items-center gap-1 bg-white/80 border border-black/[0.08] rounded-full pl-2 pr-1 py-0.5 text-[10px] text-text-secondary">
              <button onClick={() => setEditing(v)} className="hover:text-text-primary" title="Rename">
                {v}
              </button>
              <button onClick={() => onRemove(v)} className="text-text-muted hover:text-red-500 p-0.5" title="Remove">
                <X size={9} />
              </button>
            </span>
          ),
        )}
        <span className="inline-flex items-center gap-1 bg-white/60 border border-dashed border-black/[0.12] rounded-full pl-2 pr-1 py-0.5">
          <input value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { onAdd(draft); setDraft('') } }}
            placeholder="Add…"
            className="w-20 bg-transparent text-[10px] outline-none placeholder:text-text-muted/70" />
          <button onClick={() => { onAdd(draft); setDraft('') }} disabled={!draft.trim()}
            className="p-0.5 disabled:opacity-40"
            style={{ color: '#B7410E' }} title="Add">
            <Plus size={10} />
          </button>
        </span>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────── Keywords ──

type KeywordsTabProps = {
  brand: string
  profile: Profile
  update: <K extends keyof Profile>(k: K, v: Profile[K]) => void
}

function KeywordsTab({ brand, profile, update }: KeywordsTabProps) {
  const kws: Keyword[] = profile.trend_keywords || []
  const [loading, setLoading] = useState(false)
  const [regenLoading, setRegenLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)

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
      setSavedMsg('Saved')
      setTimeout(() => setSavedMsg(null), 1200)
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

  if (loading && kws.length === 0) {
    return <div className="flex items-center justify-center p-8"><Loader2 size={16} className="animate-spin text-text-muted" /></div>
  }

  return (
    <>
      <Section
        hint="Google Trends keywords tracked on this brand's Trends view."
        action={
          <>
            <button onClick={add}
              className="rounded-full px-2.5 py-1 text-[11px] border border-black/[0.08] hover:bg-black/[0.04] flex items-center gap-1">
              <Plus size={11} /> Add
            </button>
            <button onClick={regenerate} disabled={regenLoading}
              className="rounded-full px-2.5 py-1 text-[11px] border border-black/[0.08] hover:bg-black/[0.04] flex items-center gap-1 disabled:opacity-50"
              title="Regenerate via Claude (replaces current list)">
              {regenLoading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              Regenerate
            </button>
            {savedMsg && <span className="text-[10px] text-text-muted">· {savedMsg}</span>}
          </>
        }
      >
        {err && (
          <div className="rounded-lg p-2 text-[11px] text-red-600 border border-red-200 bg-red-50/70">{err}</div>
        )}

        <div className="flex flex-col divide-y divide-black/[0.05]">
          {kws.length === 0 && (
            <div className="text-[11px] text-text-muted/80 text-center py-6">
              No keywords yet. Click <b>Regenerate</b> to pick 4 via Claude, or <b>Add</b> to create one manually.
            </div>
          )}
          {kws.map((kw, i) => (
            <div key={i} className="py-2 flex gap-2 items-center first:pt-0 last:pb-0">
              <div className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: ['#B7410E', '#2563eb', '#059669', '#7c3aed'][i % 4] }} />
              <div className="flex-1 grid grid-cols-2 gap-1 min-w-0">
                <input type="text" value={kw.label}
                  onChange={e => updateAt(i, { label: e.target.value })}
                  placeholder="Label (e.g. Kinn Brand)"
                  className="border border-black/[0.08] rounded px-2 py-1 text-[11px] bg-white/60 focus:outline-none focus:border-text-primary/30" />
                <input type="text" value={kw.query}
                  onChange={e => updateAt(i, { query: e.target.value })}
                  placeholder="Search query (e.g. Kinn jewelry)"
                  className="border border-black/[0.08] rounded px-2 py-1 text-[11px] bg-white/60 focus:outline-none focus:border-text-primary/30" />
              </div>
              <button onClick={() => remove(i)}
                className="p-1 text-text-muted hover:text-red-500" title="Delete">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="text-[10px] text-text-muted/80 mt-1">
          Up to 5 keywords are charted at once in the Trends view. Changes here save immediately and also appear in the Trends tab.
        </div>
      </Section>
    </>
  )
}

// ──────────────────────────────────────────────────── ImportCsvModal ──
// Shared with the standalone TaxonomyEditor but kept inline here so the
// ProfileDetail modal doesn't have to import from a sibling file.

function ImportCsvModal({
  brand,
  onClose,
  onImported,
}: {
  brand: string
  onClose: () => void
  onImported: () => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<{
    added: Record<string, number>
    total_before: number
    total_after: number
  } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFile = (f: File) => {
    const r = new FileReader()
    r.onload = () => setText(String(r.result || ''))
    r.onerror = () => setErr('Could not read file.')
    r.readAsText(f)
  }

  const submit = async () => {
    setBusy(true)
    setErr(null)
    setResult(null)
    try {
      const r = await fetch(`/api/planner/taxonomy/import?brand=${encodeURIComponent(brand)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: text }),
      })
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      setResult({ added: d.added || {}, total_before: d.total_before || 0, total_after: d.total_after || 0 })
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  const addedEntries = result ? Object.entries(result.added).filter(([, n]) => n > 0) : []

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center"
      style={{ zIndex: 100010 }}
      onClick={onClose}
    >
      <div
        className="w-[560px] max-h-[80vh] bg-white rounded-2xl shadow-2xl border border-black/[0.08] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/[0.06]">
          <div>
            <div className="font-display text-base">Import taxonomy CSV</div>
            <div className="text-[10px] text-text-muted mt-0.5">
              Paste the CSV text or pick a file. Long shape: <code>field,value</code>. Wide shape:
              field names as the first row, values below.
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-black/[0.04]"><X size={14} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) handleFile(f)
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="rounded-full px-3 py-1.5 text-[11px] border border-black/[0.08] hover:bg-black/[0.04] flex items-center gap-1.5"
            >
              <Upload size={11} /> Choose file…
            </button>
            <div className="text-[10px] text-text-muted">or paste below</div>
          </div>

          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={10}
            placeholder={'field,value\npersonas,The Fashionista\npersonas,Tech-Optimized Professional\nangles,Bold\n…'}
            className="w-full border border-black/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] font-mono bg-white/60 focus:outline-none focus:border-text-primary/30 resize-none"
          />

          {err && (
            <div className="rounded-lg p-2 text-[11px] text-red-600 border border-red-200 bg-red-50/70">
              {err}
            </div>
          )}

          {result && (
            <div className="rounded-lg p-3 text-[11px] border border-black/[0.08] bg-white/60">
              <div className="font-medium mb-1" style={{ color: '#B7410E' }}>
                Imported: {result.total_after - result.total_before} new values
                <span className="text-text-muted font-normal"> ({result.total_before} → {result.total_after} total)</span>
              </div>
              {addedEntries.length === 0 ? (
                <div className="text-text-muted">No new values. everything was already in the taxonomy.</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {addedEntries.map(([field, n]) => (
                    <span
                      key={field}
                      className="inline-flex items-center gap-1 bg-white/80 border border-black/[0.08] rounded-full px-2 py-0.5"
                    >
                      <span className="text-text-primary">{field}</span>
                      <span className="text-text-muted">+{n}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-black/[0.06]">
          <button
            onClick={onClose}
            className="rounded-full px-3 py-1.5 text-[11px] border border-black/[0.08] hover:bg-black/[0.04]"
          >
            {result ? 'Close' : 'Cancel'}
          </button>
          {result ? (
            <button
              onClick={onImported}
              className="rounded-full px-3 py-1.5 text-[11px] text-white flex items-center gap-1.5"
              style={{ backgroundColor: '#B7410E' }}
            >
              Done
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!text.trim() || busy}
              className="rounded-full px-3 py-1.5 text-[11px] text-white flex items-center gap-1.5 disabled:opacity-50"
              style={{ backgroundColor: '#B7410E' }}
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
              Import
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────── Strategy Tab ──
// Collapsible pro-services-style brand playbook. Groups derived from a synthesis
// of Interbrand (pyramid), Wolff Olins (positioning + category frame), and
// McKinsey brand-purpose frameworks. Each section renders on demand so the
// modal doesn't feel like a wall of inputs.

type Collapsible = { key: string; label: string; hint?: string; defaultOpen?: boolean }

const STRATEGY_SECTIONS: Collapsible[] = [
  { key: 'identity', label: 'Identity', hint: 'Name, tagline, HQ, founding', defaultOpen: true },
  { key: 'positioning', label: 'Positioning', hint: 'Category, frame, differentiator' },
  { key: 'pyramid', label: 'Brand Pyramid', hint: 'Essence, values, benefits, personality' },
  { key: 'audience', label: 'Audience', hint: 'Personas, jobs-to-be-done, objections' },
  { key: 'performance', label: 'Performance Context', hint: 'CAC, LTV, margin, channels' },
  { key: 'compliance', label: 'Compliance', hint: 'Claims, trademarks' },
]

function Accordion({
  section, open, onToggle, children,
}: {
  section: Collapsible
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="border-b border-black/[0.05] last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 py-2.5 text-left hover:bg-black/[0.015] -mx-2 px-2 rounded transition-colors"
      >
        {open ? <ChevronDown size={13} className="text-text-muted" /> : <ChevronRight size={13} className="text-text-muted" />}
        <span className="font-display text-[13px] text-text-primary">{section.label}</span>
        {section.hint && <span className="text-[10px] text-text-muted ml-1">{section.hint}</span>}
      </button>
      {open && <div className="pb-3 pl-5">{children}</div>}
    </div>
  )
}

function StrategyTab({ profile, update }: TabProps) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    STRATEGY_SECTIONS.forEach(s => { init[s.key] = !!s.defaultOpen })
    return init
  })
  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }))

  return (
    <div className="flex flex-col">
      {STRATEGY_SECTIONS.map(s => (
        <Accordion key={s.key} section={s} open={!!open[s.key]} onToggle={() => toggle(s.key)}>
          {s.key === 'identity' && <IdentitySection profile={profile} update={update} />}
          {s.key === 'positioning' && <PositioningSection profile={profile} update={update} />}
          {s.key === 'pyramid' && <PyramidSection profile={profile} update={update} />}
          {s.key === 'audience' && <AudienceSection profile={profile} update={update} />}
          {s.key === 'performance' && <PerformanceSection profile={profile} update={update} />}
          {s.key === 'compliance' && <ComplianceSection profile={profile} update={update} />}
        </Accordion>
      ))}
    </div>
  )
}

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 mb-2">
      <div className="flex items-baseline gap-2">
        <div className="text-[10px] uppercase tracking-widest text-text-muted">{label}</div>
        {hint && <div className="text-[10px] text-text-muted/70">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function InlineStringList({ label, values, onChange, placeholder }: {
  label: string; values: string[]; onChange: (v: string[]) => void; placeholder?: string
}) {
  return (
    <div className="mb-2">
      <div className="flex items-baseline gap-2 mb-1">
        <div className="text-[10px] uppercase tracking-widest text-text-muted">{label}</div>
        <button
          onClick={() => onChange([...values, ''])}
          className="ml-auto text-[10px] text-text-muted hover:text-text-primary flex items-center gap-0.5"
        >
          <Plus size={10} /> Add
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {values.length === 0 && (
          <div className="text-[11px] text-text-muted/70">None yet.</div>
        )}
        {values.map((v, i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              type="text"
              value={v}
              placeholder={placeholder}
              onChange={e => { const a = [...values]; a[i] = e.target.value; onChange(a) }}
              className="flex-1 border border-black/[0.08] rounded-lg px-2.5 py-1 text-xs bg-white/60 focus:outline-none focus:border-text-primary/30"
            />
            <button
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              className="p-1 text-text-muted hover:text-red-500"
              title="Remove"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function IdentitySection({ profile, update }: TabProps) {
  return (
    <>
      <FieldRow label="Domain">
        <TextInput value={profile.domain || ''} onChange={v => update('domain', v)} placeholder="brand.com" />
      </FieldRow>
      <FieldRow label="Tagline">
        <TextInput value={profile.tagline || ''} onChange={v => update('tagline', v)} placeholder="Short line under the logo" />
      </FieldRow>
      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Founded">
          <TextInput value={profile.founded_year || ''} onChange={v => update('founded_year', v)} placeholder="2018" />
        </FieldRow>
        <FieldRow label="HQ">
          <TextInput value={profile.hq_location || ''} onChange={v => update('hq_location', v)} placeholder="Los Angeles, CA" />
        </FieldRow>
      </div>
      <FieldRow label="Mission statement" hint="Why the brand exists">
        <TextArea value={profile.mission_statement || ''} onChange={v => update('mission_statement', v)} rows={2} />
      </FieldRow>
    </>
  )
}

function PositioningSection({ profile, update }: TabProps) {
  return (
    <>
      <FieldRow label="Positioning statement" hint="For [audience], [brand] is the [category] that [differentiator].">
        <TextArea
          value={profile.positioning_statement || ''}
          onChange={v => update('positioning_statement', v)}
          rows={3}
        />
      </FieldRow>
      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Category">
          <TextInput value={profile.category || ''} onChange={v => update('category', v)} placeholder="Fine jewelry" />
        </FieldRow>
        <FieldRow label="Competitive frame">
          <TextInput value={profile.competitive_frame || ''} onChange={v => update('competitive_frame', v)} placeholder="Heirloom DTC jewelry" />
        </FieldRow>
      </div>
      <FieldRow label="Differentiator" hint="The ONE sharpest thing vs. competitors">
        <TextArea value={profile.differentiator || ''} onChange={v => update('differentiator', v)} rows={2} />
      </FieldRow>
      <InlineStringList
        label="Proof points"
        values={profile.proof_points || []}
        onChange={v => update('proof_points', v)}
        placeholder="Press, award, years in business, number"
      />
    </>
  )
}

function PyramidSection({ profile, update }: TabProps) {
  return (
    <>
      <FieldRow label="Brand essence" hint="2–4 words. The soul of the brand.">
        <TextInput value={profile.brand_essence || ''} onChange={v => update('brand_essence', v)} placeholder="Modern heirlooms" />
      </FieldRow>
      <InlineStringList label="Brand values" values={profile.brand_values || []} onChange={v => update('brand_values', v)} placeholder="Craft over speed" />
      <InlineStringList label="Personality traits" values={profile.personality_traits || []} onChange={v => update('personality_traits', v)} placeholder="Warm, confident, playful" />
      <InlineStringList label="Functional benefits" values={profile.functional_benefits || []} onChange={v => update('functional_benefits', v)} placeholder="What it DOES for the user" />
      <InlineStringList label="Emotional benefits" values={profile.emotional_benefits || []} onChange={v => update('emotional_benefits', v)} placeholder="How it makes them FEEL" />
    </>
  )
}

function AudienceSection({ profile, update }: TabProps) {
  const secondary = profile.secondary_personas || []
  return (
    <>
      <FieldRow label="Primary persona (one-liner)">
        <TextArea value={profile.primary_persona || ''} onChange={v => update('primary_persona', v)} rows={2} />
      </FieldRow>
      <div className="mb-2">
        <div className="flex items-baseline gap-2 mb-1">
          <div className="text-[10px] uppercase tracking-widest text-text-muted">Secondary personas</div>
          <button
            onClick={() => update('secondary_personas', [...secondary, { name: '', description: '' }])}
            className="ml-auto text-[10px] text-text-muted hover:text-text-primary flex items-center gap-0.5"
          >
            <Plus size={10} /> Add
          </button>
        </div>
        <div className="flex flex-col divide-y divide-black/[0.05]">
          {secondary.length === 0 && <div className="text-[11px] text-text-muted/70 py-1">None yet.</div>}
          {secondary.map((p, i) => (
            <div key={i} className="py-2 flex flex-col gap-1 first:pt-0 last:pb-0">
              <div className="flex items-center gap-1">
                <input
                  type="text" value={p.name} placeholder="Persona name"
                  onChange={e => {
                    const arr = [...secondary]
                    arr[i] = { ...arr[i], name: e.target.value }
                    update('secondary_personas', arr)
                  }}
                  className="flex-1 border-0 border-b border-transparent focus:border-text-primary/30 text-xs font-medium bg-transparent focus:outline-none px-1 py-0.5"
                />
                <button onClick={() => update('secondary_personas', secondary.filter((_, j) => j !== i))}
                  className="p-1 text-text-muted hover:text-red-500"><Trash2 size={11} /></button>
              </div>
              <textarea
                value={p.description} rows={2} placeholder="Who they are, why they buy…"
                onChange={e => {
                  const arr = [...secondary]
                  arr[i] = { ...arr[i], description: e.target.value }
                  update('secondary_personas', arr)
                }}
                className="w-full border border-black/[0.06] rounded px-2 py-1 text-[11px] bg-white/60 focus:outline-none focus:border-text-primary/30 resize-none"
              />
            </div>
          ))}
        </div>
      </div>
      <InlineStringList label="Jobs to be done" values={profile.jobs_to_be_done || []} onChange={v => update('jobs_to_be_done', v)} placeholder="When I __, I want to __, so I can __" />
      <InlineStringList label="Objections" values={profile.objections || []} onChange={v => update('objections', v)} placeholder="Common reason not to buy" />
    </>
  )
}

function PerformanceSection({ profile, update }: TabProps) {
  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <FieldRow label="CAC target">
          <TextInput value={profile.cac_target || ''} onChange={v => update('cac_target', v)} placeholder="$45" />
        </FieldRow>
        <FieldRow label="LTV target">
          <TextInput value={profile.ltv_target || ''} onChange={v => update('ltv_target', v)} placeholder="$220" />
        </FieldRow>
        <FieldRow label="Gross margin">
          <TextInput value={profile.margin_target || ''} onChange={v => update('margin_target', v)} placeholder="62%" />
        </FieldRow>
      </div>
      <InlineStringList label="Top channels" values={profile.top_channels || []} onChange={v => update('top_channels', v)} placeholder="Meta, Google, Email" />
    </>
  )
}

function ComplianceSection({ profile, update }: TabProps) {
  return (
    <>
      <InlineStringList label="Claims allowed" values={profile.claims_allowed || []} onChange={v => update('claims_allowed', v)} placeholder="What we CAN say" />
      <InlineStringList label="Claims avoided" values={profile.claims_avoided || []} onChange={v => update('claims_avoided', v)} placeholder="What we must NEVER say" />
      <InlineStringList label="Trademarks" values={profile.trademarks || []} onChange={v => update('trademarks', v)} placeholder="Registered mark" />
    </>
  )
}

// ─────────────────────────────────────────────────────────── Upload Tab ──
// Drag-drop any brand doc (.txt .md .csv .pdf .docx). We POST to
// /api/brand-profiles/:brand/ingest-doc, which returns a per-field diff.
// The user reviews the diff and clicks "Apply selected". nothing merges
// until they do.

function UploadTab({ brand, profile, onApplied }: {
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
      // Pre-select every non-noop diff row.
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
      <Section
        title="Upload brand docs"
        hint=".txt .md .csv .pdf .docx. Claude extracts playbook fields and shows a diff to review."
      >
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault(); setDragOver(false)
            if (e.dataTransfer?.files?.length) ingest(e.dataTransfer.files)
          }}
          onClick={() => fileInputRef.current?.click()}
          className={`rounded-xl border-2 border-dashed cursor-pointer transition-colors px-4 py-8 text-center flex flex-col items-center gap-2 ${
            dragOver ? 'border-text-primary/40 bg-black/[0.02]' : 'border-black/[0.12] hover:bg-black/[0.015]'
          }`}
        >
          <Upload size={18} className="text-text-muted" />
          <div className="text-[12px] font-display">Drop brand docs here</div>
          <div className="text-[10px] text-text-muted">or click to browse. .txt .md .csv .pdf .docx</div>
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
      </Section>

      {result && (
        <Section
          title="Review & merge"
          hint={`Claude proposes ${diffCount} change${diffCount === 1 ? '' : 's'}. Toggle to accept/reject, then apply.`}
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
                {applying ? <Loader2 size={11} className="animate-spin" /> : <FileCheck2 size={11} />}
                Apply {selected.size > 0 ? `${selected.size} field${selected.size === 1 ? '' : 's'}` : 'selected'}
              </button>
            </>
          }
        >
          {result.files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {result.files.map((f, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-[10px] bg-white/80 border border-black/[0.08] rounded-full pl-2 pr-2.5 py-0.5 text-text-secondary"
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
          {result.diff.filter(r => r.action !== 'noop').length === 0 ? (
            <div className="text-[11px] text-text-muted/80 text-center py-4">
              Nothing new to merge. the docs didn't add anything the profile doesn't already have.
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-black/[0.05]">
              {result.diff.map(row => {
                if (row.action === 'noop') return null
                const checked = selected.has(row.field)
                return (
                  <DiffRow
                    key={row.field}
                    row={row}
                    checked={checked}
                    onToggle={() => {
                      const next = new Set(selected)
                      if (checked) next.delete(row.field); else next.add(row.field)
                      setSelected(next)
                    }}
                  />
                )
              })}
            </div>
          )}
        </Section>
      )}

      {uploaded.length > 0 && (
        <Section title="Recent uploads" hint="History stored under brand_uploads/<brand>/">
          <div className="flex flex-col divide-y divide-black/[0.05]">
            {uploaded.slice().reverse().slice(0, 10).map((u, i) => (
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
        </Section>
      )}
    </>
  )
}

function DiffRow({ row, checked, onToggle }: { row: DiffEntry; checked: boolean; onToggle: () => void }) {
  const badge =
    row.action === 'add' ? { label: 'new', color: '#2d8a4e' } :
    row.action === 'extend' ? { label: 'extend', color: '#B7410E' } :
    row.action === 'overwrite' ? { label: 'overwrite', color: '#c47a15' } :
    { label: 'same', color: '#999' }
  return (
    <div className="py-2 flex gap-2 items-start first:pt-0 last:pb-0">
      <button onClick={onToggle} className="pt-0.5 flex-shrink-0" title="Toggle">
        {checked ? (
          <CheckCircle2 size={14} style={{ color: '#B7410E' }} />
        ) : (
          <Circle size={14} className="text-text-muted" />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <div className="text-[11px] font-medium text-text-primary">{row.field}</div>
          <span
            className="text-[9px] uppercase tracking-widest rounded-full px-1.5 py-0.5"
            style={{ color: badge.color, backgroundColor: `${badge.color}18` }}
          >
            {badge.label}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-1">
          <DiffSide label="Current" value={row.current} muted />
          <DiffSide label="Proposed" value={row.proposed} />
        </div>
      </div>
    </div>
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
    <div className={`text-[10px] ${muted ? 'text-text-muted' : 'text-text-secondary'}`}>
      <div className="uppercase tracking-widest text-[9px] mb-0.5 opacity-70">{label}</div>
      <div className="rounded border border-black/[0.06] bg-white/50 px-1.5 py-1 min-h-[22px]">
        {render()}
      </div>
    </div>
  )
}

// Naming-convention editor. Defines a separator and a numbered list of
// position labels (1=Persona, 2=Angle, …). Used by Creative Analysis to
// parse ad_name into structured group-by fields. Includes a live preview
// pane so the user can paste a real ad name and confirm the mapping.
function NamingTab({ profile, update }: TabProps) {
  const conv: NamingConvention = profile.naming_convention || DEFAULT_NAMING_CONVENTION
  const [sample, setSample] = useState('')

  const setConv = (next: NamingConvention) => update('naming_convention', next)

  const setSeparator = (sep: string) => setConv({ ...conv, separator: sep })

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
      <Section
        title="Separator"
        hint="Character (or string) that joins position tokens in the ad name. Defaults to underscore."
      >
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={conv.separator}
            onChange={e => setSeparator(e.target.value)}
            className="w-20 border border-black/[0.08] rounded-lg px-2.5 py-1.5 text-xs bg-white/60 focus:outline-none focus:border-text-primary/30 text-center font-mono"
            placeholder="_"
          />
          <span className="text-[11px] text-text-muted/70">
            Each token is <code>&lt;number&gt;:&lt;value&gt;</code>; tokens are joined by this separator.
          </span>
        </div>
      </Section>

      <Section
        title="Positions"
        hint="Position numbers appear in the ad name. Label each one. those labels show up in Creative Analysis Group By."
        action={
          <button onClick={addPosition}
            className="text-text-muted hover:text-text-primary flex items-center gap-1 text-[11px]">
            <Plus size={11} /> Add position
          </button>
        }
      >
        <div className="flex flex-col gap-1">
          {conv.positions.length === 0 && (
            <div className="text-[11px] text-text-muted/70">No positions defined yet.</div>
          )}
          {conv.positions.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={p.number}
                onChange={e => updatePosition(i, { number: Number(e.target.value) || 1 })}
                className="w-14 border border-black/[0.08] rounded-lg px-2 py-1.5 text-xs bg-white/60 focus:outline-none focus:border-text-primary/30 text-center font-mono"
              />
              <span className="text-text-muted text-xs">→</span>
              <input
                type="text"
                value={p.label}
                onChange={e => updatePosition(i, { label: e.target.value })}
                placeholder="e.g. Persona, Angle, Concept"
                className="flex-1 border border-black/[0.08] rounded-lg px-2.5 py-1.5 text-xs bg-white/60 focus:outline-none focus:border-text-primary/30"
              />
              <button onClick={() => removePosition(i)}
                className="p-1 rounded hover:bg-black/[0.04] text-text-muted hover:text-red-600" title="Remove">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Preview" hint="Paste a real ad name to confirm the mapping.">
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
                <div key={`${p.number}-${p.label}`}
                  className="text-[10px] flex items-center gap-1 px-2 py-0.5 rounded-full"
                  style={v
                    ? { backgroundColor: 'rgba(183, 65, 14, 0.1)', color: '#B7410E' }
                    : { backgroundColor: 'rgba(0,0,0,0.04)', color: 'var(--color-text-muted)' }}>
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
      </Section>
    </>
  )
}
