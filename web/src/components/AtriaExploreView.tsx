/**
 * Atelier ↔ Atria explore view
 * ----------------------------
 * Wraps the Atria Open API in an Atelier-shaped grid + filter + detail UX so
 * the Creative Analysis page can flip a toggle and search ~25M cross-brand
 * ads instead of only the user's Meta library.
 *
 * Why this lives next to AdAnalysisView rather than inside it:
 *  - Atria's ad shape is platform-agnostic and bears no relationship to the
 *    Meta-shaped `AdCreative` interface; mixing them in one component would
 *    require either union types or two parallel render paths.
 *  - The data lifecycle is different: Atelier prefetches a window of ads on
 *    brand/date change, Atria pages through a cursor on every filter tweak.
 *  - Keeping it standalone means we can drop the toggle into other pages
 *    later (Inspo, Studio) without untangling shared state.
 *
 * Save flow caveat:
 *  The Atria Open API is read-only as of 2026-05. no POST /boards/{id}/ads.
 *  The "Save to board" button deep-links to the Atria web app where the user
 *  can pin the ad. See ~/.claude/.../project_atelier_atria.md for context.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Search, Loader2, X, ExternalLink, ChevronDown, Filter, Play,
  Image as ImageIcon, Video as VideoIcon, Layers,
  AlertTriangle, LayoutGrid, Table2, Info, Bookmark,
} from 'lucide-react'
import { VideoScriptsTab } from './VideoScriptsTab'
import { SaveToBoardButton } from './ads/SaveToBoardButton'
import { BoardsMenu } from './ads/BoardsMenu'
// BoardDetailModal removed. board click now filters the grid in-place.

// --- Types --------------------------------------------------------------
// Mirror Atria's response shape exactly. Anything we don't read we still
// declare as optional so TS doesn't complain when the upstream evolves.
export type AtriaAdMedia = {
  url: string
  preview_image_url?: string | null
  width?: number | null
  height?: number | null
  duration?: number | null
}

export type AtriaAd = {
  id: string
  ad_id?: string
  status?: 'active' | 'inactive' | string | null
  brand_id?: string | null
  brand_name?: string | null
  brand_avatar_url?: string | null
  platforms?: string[] | null
  display_format?: 'image' | 'video' | 'carousel' | 'dco' | string | null
  media_format?: string | null
  title?: string | null
  body?: string | null
  cta_type?: string | null
  cta_text?: string | null
  link_url?: string | null
  start_date?: string | null
  end_date?: string | null
  images?: AtriaAdMedia[]
  videos?: AtriaAdMedia[]
  categories?: string[] | null
}

type AtriaListResponse = {
  code: number
  message: string
  data: {
    items: AtriaAd[]
    cursor: string | null
    total?: number
    page_size?: number
  } | null
}

type AtriaDetailResponse = {
  code: number
  message: string
  data: AtriaAd | null
}

interface Props {
  /** Seed the keyword search with the current brand name when first
   *  toggled on. surfaces the user's own ads (or their close competitors)
   *  rather than a global firehose by default. */
  brandName?: string
  /** Called when the user toggles AI Search off. we surface it as a chip
   *  in the empty state so the user can return to the regular dashboard
   *  without scrolling back up to the toggle. */
  onClose?: () => void
}

// --- Filter primitives --------------------------------------------------
// Each filter pill is fully controlled here (no popover library) so we
// keep the glassy, low-chrome look consistent with the rest of Atelier.

type EnumOption = { value: string; label: string; icon?: React.ReactNode }

const PLATFORMS: EnumOption[] = [
  { value: 'facebook', label: 'Facebook' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'messenger', label: 'Messenger' },
  { value: 'audience_network', label: 'Audience Network' },
  { value: 'threads', label: 'Threads' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'linkedin', label: 'LinkedIn' },
]

const DISPLAY_FORMATS: EnumOption[] = [
  { value: 'image', label: 'Image', icon: <ImageIcon size={11} /> },
  { value: 'video', label: 'Video', icon: <VideoIcon size={11} /> },
  { value: 'carousel', label: 'Carousel', icon: <Layers size={11} /> },
  { value: 'dco', label: 'Dynamic (DCO)' },
]

const VIDEO_LENGTHS: EnumOption[] = [
  { value: '0-15', label: '0–15s' },
  { value: '15-30', label: '15–30s' },
  { value: '30-60', label: '30–60s' },
  { value: '60-120', label: '60–120s' },
  { value: '120-', label: '120s+' },
]

const STATUSES: EnumOption[] = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
]

// ISO 639-1 short list. the long tail is rare in ad libraries and a
// 30-item dropdown is enough for ~98% of usage; the user can type a
// custom code into the search bar if they really need ko/zh/ar/etc.
const LANGUAGES: EnumOption[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'sv', label: 'Swedish' },
  { value: 'no', label: 'Norwegian' },
  { value: 'da', label: 'Danish' },
  { value: 'pl', label: 'Polish' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ko', label: 'Korean' },
  { value: 'ar', label: 'Arabic' },
]

const SORTS: EnumOption[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'most_active', label: 'Longest running' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'best_match', label: 'Best match' },
]

// Hardcoded Industry taxonomy. mirrors the labels Atria's UI shows so a
// user switching back and forth doesn't see a different vocabulary. The
// values are lower-cased keywords we pass straight through as the
// `industry=` query param; Atria's API does a substring match against
// each ad's `categories[]` field on their side.
// Atria filters by Facebook Page category, not by formal industry buckets.
// Each label maps to one or more page-category keywords we OR together via
// repeated `industry=` query params. single-word stems like "food" rarely
// matched any real category and silently returned ~0 results.
const INDUSTRIES: { value: string; values: string[]; label: string; icon?: React.ReactNode }[] = [
  { value: 'apparel',     values: ['clothing brand', 'clothing store', 'jewelry/watches', 'shoe store'], label: 'Apparel & Accessories' },
  { value: 'appliances',  values: ['appliances', 'home appliances'], label: 'Appliances' },
  { value: 'baby',        values: ['baby goods/kids goods', 'maternity'], label: 'Baby, Kids & Maternity' },
  { value: 'beauty',      values: ['health/beauty', 'cosmetics store', 'beauty salon', 'skin care service'], label: 'Beauty & Personal Care' },
  { value: 'book',        values: ['book', 'book store', 'publisher'], label: 'Book/Publishing' },
  { value: 'business',    values: ['business service', 'consulting agency'], label: 'Business Services' },
  { value: 'charity',     values: ['non-profit organization', 'charity organization'], label: 'Charity, NFP & NGO' },
  { value: 'ecommerce',   values: ['shopping & retail', 'retail company', 'e-commerce website'], label: 'E-Commerce' },
  { value: 'education',   values: ['education', 'education website', 'school'], label: 'Education' },
  { value: 'event',       values: ['event', 'event planner'], label: 'Event' },
  { value: 'financial',   values: ['financial service', 'bank', 'insurance company'], label: 'Financial Services' },
  { value: 'fitness',     values: ['sports & recreation', 'gym/physical fitness center', 'sports league', 'outdoor & sporting goods company'], label: 'Fitness, Sports & Outdoors' },
  { value: 'food',        values: ['food service', 'restaurant', 'meal takeaway', 'food & beverage company', 'food delivery service'], label: 'Food & Beverage' },
  { value: 'games',       values: ['games/toys', 'video game'], label: 'Games' },
  { value: 'government',  values: ['government organization', 'public & government service'], label: 'Government' },
  { value: 'health',      values: ['health/medical/pharmaceuticals', 'hospital', 'doctor', 'medical & health'], label: 'Health & Medical' },
  { value: 'home',        values: ['home improvement', 'home & garden website', 'furniture'], label: 'Home Improvement & Garden' },
  { value: 'life',        values: ['local service', 'personal blog'], label: 'Life Services' },
  { value: 'pets',        values: ['pet service', 'pet supplies', 'pet store'], label: 'Pets' },
  { value: 'science',     values: ['science, technology & engineering', 'software', 'computers & internet website'], label: 'Science, Technology & Engineering' },
  { value: 'travel',      values: ['travel & transportation', 'hotel', 'travel company'], label: 'Travel & Hospitality' },
  { value: 'vehicle',     values: ['cars', 'automotive', 'automotive store'], label: 'Vehicle & Transportation' },
]

// Themes are NOT a real Atria API filter. there's no themes= param. We
// fold the picked themes into the free-text `query=` so picking
// "Testimonial" appends "testimonial review customer" to whatever the
// user typed. Each theme expands to a small synonym set because
// Atria's text search is substring/keyword based. sending just
// "testimonial" missed obvious testimonial ads that used "review",
// "customer", "story" etc instead of the literal word.
const THEMES: { value: string; label: string; terms: string[] }[] = [
  { value: 'announcement',  label: 'Announcement',      terms: ['announcing', 'introducing', 'new', 'launch'] },
  { value: 'before-after',  label: 'Before & After',    terms: ['before after', 'transformation', 'results'] },
  { value: 'features',      label: 'Features/Benefits', terms: ['features', 'benefits', 'why'] },
  { value: 'holiday',       label: 'Holiday/Festival',  terms: ['holiday', 'sale', 'christmas', 'thanksgiving', 'black friday'] },
  { value: 'media-press',   label: 'Media/Press',       terms: ['featured in', 'press', 'as seen on'] },
  { value: 'promotion',     label: 'Promotion/Discount',terms: ['discount', 'sale', 'off', 'save', 'promo', 'deal'] },
  { value: 'question',      label: 'Question',          terms: ['?', 'do you', 'are you', 'have you'] },
  { value: 'statistics',    label: 'Statistics',        terms: ['percent', '%', 'million', 'thousand', 'data'] },
  { value: 'testimonial',   label: 'Testimonial',       terms: ['testimonial', 'review', 'customer', 'story', 'love it'] },
  { value: 'ugc',           label: 'UGC',               terms: ['UGC', 'creator', 'unboxing', 'haul'] },
  { value: 'unboxing',      label: 'Unboxing',          terms: ['unboxing', 'unbox', 'first impressions'] },
  { value: 'us-vs-them',    label: 'Us vs Them',        terms: ['vs', 'versus', 'compared to', 'unlike'] },
]

type Filters = {
  query: string
  platforms: Set<string>
  formats: Set<string>
  videoLengths: Set<string>
  languages: Set<string>
  statuses: Set<string>
  industries: Set<string>
  themes: Set<string>
  order: string
}

const INITIAL_FILTERS: Filters = {
  query: '',
  platforms: new Set(),
  formats: new Set(),
  videoLengths: new Set(),
  languages: new Set(),
  statuses: new Set(['active']),  // default: only currently-running ads
  industries: new Set(),
  themes: new Set(),
  order: 'newest',
}

// Compact date formatter. Atria returns ISO timestamps (e.g.
// "2026-05-15T07:00:00+00:00") but we only ever care about the calendar
// date in card / table contexts. "May 15" if same year as today,
// "May 15, 2025" otherwise. Matches the AdAnalysisView shorthand.
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function fmtShortDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  // Slice the YYYY-MM-DD prefix so we don't care whether Atria sent us
  // an ISO timestamp or a plain date string.
  const d = new Date(iso.length > 10 ? iso : `${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  const m = SHORT_MONTHS[d.getMonth()]
  const day = d.getDate()
  const year = d.getFullYear()
  const thisYear = new Date().getFullYear()
  return year === thisYear ? `${m} ${day}` : `${m} ${day}, ${year}`
}

// --- Component ----------------------------------------------------------

export function AtriaExploreView({ brandName }: Props) {
  const [filters, setFilters] = useState<Filters>(() => ({
    ...INITIAL_FILTERS,
    query: brandName || '',
  }))
  const [ads, setAds] = useState<AtriaAd[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openFilter, setOpenFilter] = useState<keyof Filters | null>(null)

  // View mode toggle. mirrors AdAnalysisView's chartMode state but only
  // exposes the two modes that make sense here (Atria gives us per-ad
  // metadata, not performance, so chart/scatter views would be empty).
  const [viewMode, setViewMode] = useState<'grid' | 'table'>(() => {
    if (typeof window === 'undefined') return 'grid'
    return (localStorage.getItem('atelier.atria.viewMode') as 'grid' | 'table') || 'grid'
  })
  useEffect(() => {
    try { localStorage.setItem('atelier.atria.viewMode', viewMode) } catch {}
  }, [viewMode])

  // Grid-zoom (1–5). mirrors Creative Analysis. Persisted under its own
  // key so search density doesn't fight with the analytics grid zoom.
  const [gridZoom, setGridZoom] = useState<number>(() => {
    if (typeof window === 'undefined') return 3
    const saved = Number(localStorage.getItem('atelier.atria.gridZoom'))
    return Number.isFinite(saved) && saved >= 1 && saved <= 5 ? saved : 3
  })
  useEffect(() => {
    try { localStorage.setItem('atelier.atria.gridZoom', String(gridZoom)) } catch {}
  }, [gridZoom])
  const hScrollAccum = useRef(0)

  // Clicking a board opens a dedicated modal view of its pins (unified
  // across atelier / atria sources). Replaces the prior approach of
  // re-shaping pins back into AtriaAd rows and swapping the live grid,
  // which felt like a hijacked search and hid the source provenance.
  const [openBoard, setOpenBoard] = useState<{ id: string; name: string } | null>(null)

  // Track the latest fetch. when filters change rapidly we want to
  // discard stale responses landing out of order. A monotonic id is
  // simpler than AbortController plumbing and works the same here.
  const fetchSeq = useRef(0)

  // Debounce the query input so we don't fire a request per keystroke.
  // 280ms is the sweet spot where typing feels responsive but the API
  // sees ~1 call per phrase.
  const [debouncedQuery, setDebouncedQuery] = useState(filters.query)
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(filters.query), 280)
    return () => window.clearTimeout(t)
  }, [filters.query])

  const buildParams = useCallback(
    (extra?: { cursor?: string }): URLSearchParams => {
      const p = new URLSearchParams()

      // Themes don't map to a real Atria API filter. fold each picked
      // theme's synonym list into the free-text query so picking
      // "Testimonial" actually pulls testimonial / review / customer-
      // story ads, not just ads with the literal word "testimonial".
      const themeTerms = Array.from(filters.themes)
        .flatMap(v => THEMES.find(t => t.value === v)?.terms || [v])
        .join(' ')
      // Industries: in addition to the structured ?industry= filter
      // (which Atria does substring-match on its categories[] field),
      // ALSO fold the human label into the free-text query. Atria's
      // category labels are inconsistent across brands (e.g. "Beauty &
      // Personal Care" sometimes shows up as "Cosmetics Store" and
      // sometimes as "Health/Beauty"). folding the label words gives
      // us a second chance to match via body / title text when the
      // structured filter is too strict.
      const industryTerms = Array.from(filters.industries)
        .map(v => INDUSTRIES.find(i => i.value === v)?.label || v)
        // Strip "&" and "/" so they don't accidentally become operators.
        .map(s => s.replace(/[&/]/g, ' ').replace(/\s+/g, ' ').trim())
        .join(' ')
      const queryStr = [debouncedQuery.trim(), themeTerms, industryTerms]
        .filter(Boolean)
        .join(' ')
      if (queryStr) p.set('query', queryStr)

      // Each repeatable enum is appended once per selected value. Atria
      // parses ?platform=facebook&platform=tiktok the same way it parses
      // ?platforms[]=... and URLSearchParams.append serialises cleanly.
      filters.platforms.forEach(v => p.append('platform', v))
      filters.formats.forEach(v => p.append('display_format', v))
      filters.videoLengths.forEach(v => p.append('video_length', v))
      filters.languages.forEach(v => p.append('language', v))
      filters.statuses.forEach(v => p.append('status', v))
      // Each selected industry expands to its Atria page-category list
      // (OR'd via repeated industry= params). Unknown values fall back
      // to the literal string so a future dropdown addition still works.
      filters.industries.forEach(v => {
        const def = INDUSTRIES.find(i => i.value === v)
        const vals = def?.values?.length ? def.values : [v]
        vals.forEach(cat => p.append('industry', cat))
      })
      p.set('order', filters.order)
      p.set('page_size', '24')
      if (extra?.cursor) p.set('cursor', extra.cursor)
      return p
    },
    [debouncedQuery, filters],
  )

  // Convert a board pin's snapshot into an AtriaAd-shaped row so the
  // same grid + detail panel render path works for both "live search"
  // and "open board". Snapshot fields are best-effort. they were
  // captured at pin time and may be partial.
  const pinToAd = useCallback((pin: any): AtriaAd => {
    const snap = pin?.snapshot || {}
    const id = pin?.ad_id || snap.id || ''
    const imgUrl = snap.image_url || snap.thumbnail_url || snap.preview_image_url || null
    const isVideo = !!snap.video_id || snap.display_format === 'video' || snap.media_format === 'video'
    return {
      id,
      ad_id: id,
      status: snap.status || null,
      brand_id: snap.brand_id || null,
      brand_name: snap.brand_name || pin?.brand || null,
      brand_avatar_url: snap.brand_avatar_url || null,
      platforms: snap.platforms || [],
      display_format: snap.display_format || (isVideo ? 'video' : 'image'),
      media_format: snap.media_format || (isVideo ? 'video' : 'image'),
      title: snap.title || '',
      body: snap.body || '',
      caption: snap.caption || '',
      cta_type: snap.cta_type || '',
      cta_text: snap.cta_text || '',
      link_url: snap.link_url || '',
      images: imgUrl && !isVideo ? [{ url: imgUrl, width: 0, height: 0 }] : [],
      videos: isVideo && imgUrl ? [{ url: '', preview_image_url: imgUrl, width: 0, height: 0, duration: 0 }] : [],
      start_date: snap.start_date || null,
      end_date: snap.end_date || null,
      external_link: snap.external_link || null,
      categories: snap.categories || [],
    } as AtriaAd
  }, [])

  // Primary fetch. fires on every filter change OR when a board is
  // selected. In board mode we fetch the board's pins and reshape into
  // AtriaAd rows so the same grid renders them; live filters are
  // ignored while a board is active (the chip near the search bar
  // makes the mode explicit).
  const search = useCallback(async () => {
    const seq = ++fetchSeq.current
    setLoading(true)
    setError(null)
    try {
      // Board mode: bypass the live search and pull pins from the board.
      if (openBoard) {
        const resp = await fetch(`/api/boards/${encodeURIComponent(openBoard.id)}`)
        const body = await resp.json().catch(() => ({} as any))
        if (seq !== fetchSeq.current) return
        if (!resp.ok) {
          throw new Error(body?.detail || `Board fetch failed: HTTP ${resp.status}`)
        }
        const pins = Array.isArray(body?.ads) ? body.ads : []
        setAds(pins.map(pinToAd))
        setCursor(null)  // boards aren't paginated
        return
      }
      const resp = await fetch(`/api/atria/ads?${buildParams().toString()}`)
      const body = (await resp.json()) as AtriaListResponse | { error?: string; message?: string }
      if (seq !== fetchSeq.current) return  // a newer query has started
      if (!resp.ok) {
        const msg = (body as any).message || (body as any).error || `HTTP ${resp.status}`
        throw new Error(msg)
      }
      const env = body as AtriaListResponse
      if (env.code !== 0 || !env.data) throw new Error(env.message || 'Atria error')
      setAds(env.data.items || [])
      setCursor(env.data.cursor || null)
    } catch (e: any) {
      if (seq !== fetchSeq.current) return
      setError(e?.message || 'Failed to load ads')
      setAds([])
      setCursor(null)
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }, [buildParams, openBoard, pinToAd])

  useEffect(() => {
    search()
  }, [search])

  // Cursor pagination. append, never replace. We tie the request to the
  // cursor we're about to spend so an interleaved filter change can't
  // accidentally append yesterday's page-2 onto today's page-1.
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return
    const expectedCursor = cursor
    const seq = fetchSeq.current  // same generation as current results
    setLoadingMore(true)
    try {
      const resp = await fetch(
        `/api/atria/ads?${buildParams({ cursor: expectedCursor }).toString()}`,
      )
      const env = (await resp.json()) as AtriaListResponse
      if (seq !== fetchSeq.current) return
      if (!resp.ok || env.code !== 0 || !env.data) return
      setAds(prev => [...prev, ...(env.data!.items || [])])
      setCursor(env.data.cursor || null)
    } catch {
      // Silent fail on "load more". the user can click again. A toast
      // here would interrupt the scroll flow for what's almost always a
      // transient hiccup.
    } finally {
      if (seq === fetchSeq.current) setLoadingMore(false)
    }
  }, [cursor, loadingMore, buildParams])

  // IntersectionObserver-based infinite scroll. The sentinel is rendered
  // after the grid; when it enters the viewport we kick `loadMore`.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) loadMore()
      },
      { rootMargin: '600px 0px' },  // pre-fetch one screenful early
    )
    io.observe(node)
    return () => io.disconnect()
  }, [loadMore])

  // --- Filter mutators -------------------------------------------------
  const toggleEnum = useCallback(
    (key: 'platforms' | 'formats' | 'videoLengths' | 'languages' | 'statuses' | 'industries' | 'themes', value: string) => {
      setFilters(f => {
        const next = new Set(f[key])
        if (next.has(value)) next.delete(value)
        else next.add(value)
        return { ...f, [key]: next }
      })
    },
    [],
  )

  const clearAllFilters = useCallback(() => {
    setFilters({ ...INITIAL_FILTERS, query: '' })
  }, [])

  // Count of "extra" filters beyond the always-on Active status. drives
  // the "Clear" button visibility and the filter-count badge.
  const activeCount = useMemo(() => {
    let n = 0
    if (filters.query.trim()) n++
    n += filters.platforms.size
    n += filters.formats.size
    n += filters.videoLengths.size
    n += filters.languages.size
    n += filters.industries.size
    n += filters.themes.size
    if (filters.order !== 'newest') n++
    // status=active is the default, only count if changed
    if (!(filters.statuses.size === 1 && filters.statuses.has('active'))) n++
    return n
  }, [filters])

  // --- Render ----------------------------------------------------------
  const selected = useMemo(
    () => ads.find(a => a.id === selectedId) || null,
    [ads, selectedId],
  )

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar. search on the left, then filter pills. Matches the
          gap-4 column rhythm of AdAnalysisView so toggling between
          views doesn't shift the rows below. */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative w-[260px]">
          <Search
            size={12}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            value={filters.query}
            onChange={e => setFilters(f => ({ ...f, query: e.target.value }))}
            placeholder="Search ads or brands…"
            className="w-full h-7 pl-7 pr-7 rounded-full text-[11px] bg-white/70 border border-black/[0.08] focus:outline-none focus:border-[#B7410E]/40 focus:bg-white"
          />
          {filters.query && (
            <button
              onClick={() => setFilters(f => ({ ...f, query: '' }))}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
              title="Clear search"
            >
              <X size={11} />
            </button>
          )}
        </div>

        <FilterPill
          label="Format"
          count={filters.formats.size}
          open={openFilter === 'formats'}
          onClick={() => setOpenFilter(o => (o === 'formats' ? null : 'formats'))}
        >
          <CheckboxList
            options={DISPLAY_FORMATS}
            selected={filters.formats}
            onToggle={v => toggleEnum('formats', v)}
          />
        </FilterPill>

        <FilterPill
          label="Video length"
          count={filters.videoLengths.size}
          open={openFilter === 'videoLengths'}
          onClick={() => setOpenFilter(o => (o === 'videoLengths' ? null : 'videoLengths'))}
        >
          <CheckboxList
            options={VIDEO_LENGTHS}
            selected={filters.videoLengths}
            onToggle={v => toggleEnum('videoLengths', v)}
          />
        </FilterPill>

        <FilterPill
          label="Platform"
          count={filters.platforms.size}
          open={openFilter === 'platforms'}
          onClick={() => setOpenFilter(o => (o === 'platforms' ? null : 'platforms'))}
        >
          <CheckboxList
            options={PLATFORMS}
            selected={filters.platforms}
            onToggle={v => toggleEnum('platforms', v)}
          />
        </FilterPill>

        <FilterPill
          label="Status"
          count={filters.statuses.size}
          open={openFilter === 'statuses'}
          onClick={() => setOpenFilter(o => (o === 'statuses' ? null : 'statuses'))}
        >
          <CheckboxList
            options={STATUSES}
            selected={filters.statuses}
            onToggle={v => toggleEnum('statuses', v)}
          />
        </FilterPill>

        <FilterPill
          label="Language"
          count={filters.languages.size}
          open={openFilter === 'languages'}
          onClick={() => setOpenFilter(o => (o === 'languages' ? null : 'languages'))}
        >
          <CheckboxList
            options={LANGUAGES}
            selected={filters.languages}
            onToggle={v => toggleEnum('languages', v)}
          />
        </FilterPill>

        <FilterPill
          label="Industry"
          count={filters.industries.size}
          open={openFilter === 'industries'}
          onClick={() => setOpenFilter(o => (o === 'industries' ? null : 'industries'))}
        >
          <CheckboxList
            options={INDUSTRIES}
            selected={filters.industries}
            onToggle={v => toggleEnum('industries', v)}
          />
        </FilterPill>

        <FilterPill
          label="Theme"
          count={filters.themes.size}
          open={openFilter === 'themes'}
          onClick={() => setOpenFilter(o => (o === 'themes' ? null : 'themes'))}
        >
          <CheckboxList
            options={THEMES}
            selected={filters.themes}
            onToggle={v => toggleEnum('themes', v)}
          />
        </FilterPill>

        <FilterPill
          label={`Sort: ${SORTS.find(s => s.value === filters.order)?.label || 'Newest'}`}
          open={openFilter === 'order'}
          onClick={() => setOpenFilter(o => (o === 'order' ? null : 'order'))}
        >
          {SORTS.map(s => (
            <button
              key={s.value}
              onClick={() => {
                setFilters(f => ({ ...f, order: s.value }))
                setOpenFilter(null)
              }}
              className={`block w-full text-left px-3 py-1.5 text-[12px] hover:bg-black/[0.04] ${
                filters.order === s.value ? 'text-[#B7410E]' : 'text-text-primary'
              }`}
            >
              {s.label}
            </button>
          ))}
        </FilterPill>

        {/* Per-pill X handles clearing each filter individually and the
            search input has its own X, so a separate Clear-all button is
            redundant noise on this view. */}
      </div>

      {/* View-mode strip. sits on its own row directly below the
          filter pills, same place AdAnalysisView puts its chart-mode
          toggle. Two icons (mosaic + table), identical styling to the
          analytics toggle so muscle memory carries over between modes.
          Boards dropdown lives on the right so the user can save Atria
          search results into the same boards as their Meta-native ads
          without leaving this view. */}
      <div className="flex items-center gap-1 flex-wrap">
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setViewMode('grid')}
            title="Mosaic grid"
            className={`p-1 rounded transition-colors ${
              viewMode === 'grid' ? 'text-text-primary' : 'text-black/25 hover:text-text-secondary'
            }`}
          >
            <LayoutGrid size={11} />
          </button>
          <button
            onClick={() => setViewMode('table')}
            title="Table view"
            className={`p-1 rounded transition-colors ${
              viewMode === 'table' ? 'text-text-primary' : 'text-black/25 hover:text-text-secondary'
            }`}
          >
            <Table2 size={11} />
          </button>
        </div>
        <div className="ml-auto">
          <BoardsMenu
            activeId={openBoard?.id || null}
            onOpen={b => setOpenBoard({ id: b.id, name: b.name })}
          />
        </div>
      </div>

      {/* Active-board chip. only renders when a board is selected.
          Shows which board's pins are filling the grid + an X to clear
          back to live search. */}
      {openBoard && (
        <div className="flex items-center gap-2 px-1">
          <span
            className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1 rounded-full text-[11px] bg-[#B7410E]/10 border border-[#B7410E]/30 text-[#b55719]"
            title={`Filtering grid to pins in "${openBoard.name}"`}
          >
            <Bookmark size={10} />
            <span className="font-medium">Board:</span>
            <span className="max-w-[260px] truncate">{openBoard.name}</span>
            <button
              onClick={() => setOpenBoard(null)}
              className="ml-0.5 w-4 h-4 inline-flex items-center justify-center rounded-full hover:bg-[#B7410E]/20"
              title="Exit board. return to live search"
            >
              <X size={10} />
            </button>
          </span>
          <span className="text-[10px] text-text-muted">
            Filters paused while viewing a board.
          </span>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 flex items-center gap-2 text-[12px] text-red-900">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => search()} className="underline">Retry</button>
        </div>
      )}

      {/* Body. either the mosaic grid or the table, driven by
          `viewMode`. Both share the same sentinel for infinite-scroll
          loading and the same detail-modal hook (clicking a row in
          table view opens the same AtriaDetailPanel that clicking a
          card in grid view does). When a board is active, the live
          board click opens a dedicated modal. see openBoard below. */}
      <div className="min-h-[400px]">
        {loading && ads.length === 0 ? (
          <SkeletonGrid />
        ) : ads.length === 0 ? (
          <EmptyState onReset={clearAllFilters} hasFilters={activeCount > 0} />
        ) : viewMode === 'grid' ? (
          <>
            <div
              onWheel={(e) => {
                if (e.shiftKey) {
                  e.preventDefault()
                  const dir = e.deltaY > 0 ? -1 : 1
                  setGridZoom(z => Math.min(5, Math.max(1, z + dir)))
                  return
                }
                const ax = Math.abs(e.deltaX)
                const ay = Math.abs(e.deltaY)
                if (ax > ay && ax > 0) {
                  e.preventDefault()
                  hScrollAccum.current += e.deltaX
                  const STEP = 60
                  while (Math.abs(hScrollAccum.current) >= STEP) {
                    const dir = hScrollAccum.current > 0 ? 1 : -1
                    setGridZoom(z => Math.min(5, Math.max(1, z + dir)))
                    hScrollAccum.current -= dir * STEP
                  }
                }
              }}
            >
              <div className={`grid gap-2 ${ATRIA_GRID_ZOOM_CLASSES[gridZoom]}`}>
                {ads.map(ad => (
                  <AdCard
                    key={ad.id}
                    ad={ad}
                    selected={selectedId === ad.id}
                    onClick={() => setSelectedId(ad.id)}
                  />
                ))}
              </div>
            </div>
            <div ref={sentinelRef} className="h-12 flex items-center justify-center">
              {loadingMore && <Loader2 size={14} className="animate-spin text-text-muted" />}
              {!cursor && ads.length > 0 && (
                <span className="text-[11px] text-text-muted">End of results · {ads.length} ads</span>
              )}
            </div>
            <AtriaZoomSlider value={gridZoom} onChange={setGridZoom} />
          </>
        ) : (
          <AtriaResultsTable
            ads={ads}
            selectedId={selectedId}
            onOpen={id => setSelectedId(id)}
            sentinelRef={sentinelRef}
            loadingMore={loadingMore}
            cursor={cursor}
          />
        )}
      </div>

      {/* Board view is now an in-place grid filter, not a modal. The
          board chip near the filter bar (rendered above) shows what's
          active and clicking its X clears back to live search. */}

      {selected && (
        <AtriaDetailPanel
          ad={selected}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}

// --- Subcomponents ------------------------------------------------------

/**
 * Generic pill-with-popover used for every filter chip. Renders the
 * trigger button and, when open, an absolutely-positioned popover that
 * receives `children` as the body. We close on outside-click via a
 * window-level listener mounted while the pill is open.
 */
function FilterPill({
  label, count, open, onClick, children, hint,
}: {
  label: string
  count?: number
  open: boolean
  onClick: () => void
  children: React.ReactNode
  /** Optional one-liner above the popover body. surfaces "this is a soft
   *  filter, not a structured one" caveats. */
  hint?: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClick()
    }
    window.addEventListener('mousedown', onDoc)
    return () => window.removeEventListener('mousedown', onDoc)
  }, [open, onClick])

  const active = (count ?? 0) > 0 || open
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={onClick}
        className={`h-7 px-2.5 rounded-full text-[11px] flex items-center gap-1.5 transition-colors ${
          active
            ? 'bg-[#B7410E]/10 border border-[#B7410E]/30 text-[#b55719]'
            : 'glass glass-hover text-text-secondary'
        }`}
      >
        <Filter size={10} />
        {label}{count ? ` (${count})` : ''}
        <ChevronDown size={9} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-[70] bg-white rounded-md shadow-[0_6px_24px_-4px_rgba(0,0,0,0.18)] border border-black/[0.08] py-1 max-h-[320px] overflow-y-auto min-w-[200px]">
          {hint && (
            <div className="px-3 py-1.5 text-[10px] text-text-muted bg-black/[0.02] border-b border-black/[0.04] flex items-start gap-1.5">
              <Info size={10} className="shrink-0 mt-[1px]" />
              <span>{hint}</span>
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  )
}

function CheckboxList({
  options, selected, onToggle,
}: {
  // Accept any option list whose entries carry at least value+label -
  // THEMES carries an extra `terms` field for query expansion that the
  // checkbox UI doesn't need to know about.
  options: { value: string; label: string; icon?: React.ReactNode }[]
  selected: Set<string>
  onToggle: (v: string) => void
}) {
  return (
    <>
      {options.map(o => (
        <label
          key={o.value}
          className="flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-black/[0.04] cursor-pointer"
        >
          <input
            type="checkbox"
            checked={selected.has(o.value)}
            onChange={() => onToggle(o.value)}
            className="rounded accent-[#B7410E]"
          />
          {o.icon && <span className="text-text-muted">{o.icon}</span>}
          {o.label}
        </label>
      ))}
    </>
  )
}

/**
 * Single ad card in the grid. Two display modes:
 *  - image ad → first images[].url with a soft 4:5 frame
 *  - video ad → videos[0].preview_image_url with a play badge overlay
 * Falls back to a copy-only block when the ad is text-only (rare but
 * happens with link-format ads). The whole card is clickable; the
 * Save button stops propagation so it doesn't double as an "open detail."
 */
function AdCard({
  ad, selected, onClick,
}: {
  ad: AtriaAd
  selected: boolean
  onClick: () => void
}) {
  const isVideo = (ad.display_format === 'video') || (ad.videos?.length ?? 0) > 0
  const thumb =
    ad.images?.[0]?.url ||
    ad.videos?.[0]?.preview_image_url ||
    null

  // Minimal projection of the Atria ad for board snapshots. just enough
  // for the saved-board view to render the tile offline if the source
  // de-indexes. Computed once per render rather than inline so the
  // SaveToBoardButton's deps are stable.
  const snapshot = useMemo(() => ({
    brand_name: ad.brand_name,
    brand_avatar_url: ad.brand_avatar_url,
    title: ad.title,
    body: ad.body,
    display_format: ad.display_format,
    thumbnail_url: thumb,
    preview_image_url: ad.videos?.[0]?.preview_image_url ?? null,
    video_id: ad.videos?.[0]?.url ?? null,
    link_url: (ad as any).link_url ?? null,
    cta_type: (ad as any).cta_type ?? null,
    cta_text: (ad as any).cta_text ?? null,
    start_date: ad.start_date,
    end_date: ad.end_date,
    status: ad.status,
    platforms: ad.platforms,
    categories: ad.categories,
  }), [ad, thumb])

  // The card root is a div+role=button so the SaveToBoardButton can be a
  // real <button> child without nesting buttons (which React errors on).
  // Pointer/keyboard activation is handled via onClick / Enter / Space.
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick()
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKey}
      className={`group relative flex flex-col rounded-lg overflow-hidden border text-left transition-shadow bg-white cursor-pointer ${
        selected
          ? 'border-[#B7410E]/50 shadow-[0_4px_16px_-2px_rgba(183,65,14,0.18)]'
          : 'border-black/[0.08] hover:shadow-md'
      }`}
    >
      {/* Media first. exact layout vocabulary of Atelier's Creative
          Analysis card. With the image at the top of the card there's
          literally no DOM path for body text to overlap it. Save-to-board
          pins top-left (mirrors the AdAnalysisView checkbox slot), the
          video pill goes top-right (matches AdAnalysisView's "Video"
          glass pill), Active badge bottom-left so it doesn't fight the
          two corner controls. */}
      <div className="relative bg-black/[0.04]" style={{ aspectRatio: '4 / 5' }}>
        {thumb ? (
          <img
            src={thumb}
            alt=""
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover"
            onError={e => {
              (e.currentTarget as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-text-muted text-[11px]">
            (no media)
          </div>
        )}
        <div className="absolute top-2 left-2">
          <SaveToBoardButton
            source="atria"
            adId={ad.id}
            snapshot={snapshot}
            compact
          />
        </div>
        {isVideo && (
          <div className="absolute top-2 right-2 glass rounded-full px-1.5 py-0.5 flex items-center gap-1 text-[10px] pointer-events-none">
            <Play size={8} fill="currentColor" />
            {ad.videos?.[0]?.duration ? `${Math.round(ad.videos[0].duration!)}s` : 'Video'}
          </div>
        )}
        {/* Status indicator intentionally NOT on the image anymore -
            moved into the brand row below as a small dot, matching the
            Creative Analysis naming-pill idiom. */}
      </div>

      {/* Below-image content. brand row + 2-line body clamp. Image
          lives ABOVE us in the DOM so overflow is mechanically
          impossible, regardless of what the clamp does. */}
      <div className="px-3 py-2 flex flex-col gap-1">
        <div className="flex items-center gap-2 min-w-0">
          {/* Status dot. matches AdAnalysisView's StatusDot exactly
              (7px filled circle + soft halo ring) so the green dot reads
              the same in both views. Emerald for active, muted grey
              otherwise. */}
          {(() => {
            const isActive = ad.status === 'active'
            const bg = isActive ? '#10b981' : '#d1d5db'
            const ring = isActive ? 'rgba(16,185,129,0.30)' : 'rgba(0,0,0,0.06)'
            const label = isActive ? 'Active' : (ad.status || 'Inactive')
            return (
              <span
                className="inline-block rounded-full shrink-0"
                style={{ width: 7, height: 7, background: bg, boxShadow: `0 0 0 2px ${ring}` }}
                title={label}
                aria-label={label}
              />
            )
          })()}
          {ad.brand_avatar_url ? (
            <img
              src={ad.brand_avatar_url}
              alt=""
              className="w-5 h-5 rounded-full object-cover bg-black/[0.04] shrink-0"
              loading="lazy"
            />
          ) : (
            <div className="w-5 h-5 rounded-full bg-black/[0.06] shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium truncate">{ad.brand_name || 'Unknown brand'}</div>
          </div>
        </div>
        {(ad.body || ad.title) && (
          <div
            className="text-[11px] text-text-secondary"
            style={{
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 2,
              overflow: 'hidden',
              lineHeight: '14px',
              height: '28px',
            }}
          >
            {ad.body || ad.title}
          </div>
        )}
      </div>

      {/* Footer dates. calendar dates only, no timestamps. */}
      <div className="px-3 py-1.5 text-[10px] text-text-muted border-t border-black/[0.04]">
        {fmtShortDate(ad.start_date)} – {ad.end_date ? fmtShortDate(ad.end_date) : 'Present'}
      </div>
    </div>
  )
}

/**
 * AtriaDetailPanel. full-screen modal (same idiom as Atelier's
 * AdDetailPanel for Meta ads). Rendered via createPortal so it overlays
 * the whole app, not the search results column.
 *
 * Layout mirrors AdDetailPanel:
 *   ┌─────────────────────────────────────────┐
 *   │ Sticky header (avatar, name, ad id, ✕)  │
 *   ├──────────────────┬──────────────────────┤
 *   │ Media + copy +   │ Performance /        │
 *   │ metadata table   │ Video Scripts tab    │
 *   └──────────────────┴──────────────────────┘
 *   ↑ same rounded-lg, shadow-2xl, w-92%/max-1180, mt-16
 *
 * The right-pane tab strip replaces the old top-of-panel one. same
 * Performance / Video Scripts split, but living in the column where
 * AdDetailPanel puts its Analysis / Comments toggle.
 */
function AtriaDetailPanel({
  ad, onClose,
}: {
  ad: AtriaAd
  onClose: () => void
}) {
  // Refetch on open in case the list response was a projection. Cheap
  // (Atria's detail call returns in <100ms cold) and protects us if the
  // shape ever diverges from the list shape.
  const [full, setFull] = useState<AtriaAd>(ad)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let cancelled = false
    setFull(ad)
    setLoading(true)
    fetch(`/api/atria/ads/${encodeURIComponent(ad.id)}`)
      .then(r => r.json() as Promise<AtriaDetailResponse>)
      .then(env => {
        if (cancelled) return
        if (env.code === 0 && env.data) setFull(env.data)
      })
      .catch(() => { /* keep optimistic copy */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [ad.id])

  // Esc closes the modal. matches AdDetailPanel UX. Listening on window
  // (not the modal node) so any focus state inside still fires it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const isVideo = (full.display_format === 'video') || (full.videos?.length ?? 0) > 0
  const media: AtriaAdMedia | null =
    isVideo ? (full.videos?.[0] || null) : (full.images?.[0] || null)

  const [tab, setTab] = useState<'performance' | 'scripts'>('performance')
  const showScriptsTab = isVideo && !!media?.url

  // Snapshot for save-to-board. minimal shape so the board renders
  // offline if the Atria URL rotates / the ad de-indexes.
  const snapshot = useMemo(() => ({
    brand_name: full.brand_name,
    brand_avatar_url: full.brand_avatar_url,
    title: full.title,
    body: full.body,
    display_format: full.display_format,
    media_format: (full as any).media_format,
    thumbnail_url: media?.preview_image_url || media?.url || null,
    preview_image_url: media?.preview_image_url || null,
    video_id: isVideo ? media?.url || null : null,
    link_url: full.link_url || null,
    cta_type: full.cta_type,
    cta_text: full.cta_text,
    start_date: full.start_date,
    end_date: full.end_date,
    status: full.status,
    platforms: full.platforms,
    categories: full.categories,
  }), [full, media, isVideo])

  return createPortal(
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center overflow-y-auto z-50"
      onClick={onClose}
    >
      <div
        className="mt-16 mb-8 w-[92%] max-w-[1180px] bg-white rounded-lg shadow-2xl border border-black/[0.08]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header. same sticky/rounded-t-2xl idiom as AdDetailPanel */}
        <div className="flex items-center gap-3 p-4 border-b border-black/[0.06] sticky top-0 bg-white rounded-t-2xl z-10">
          {full.brand_avatar_url && (
            <img
              src={full.brand_avatar_url}
              alt=""
              className="w-8 h-8 rounded-full object-cover bg-black/[0.04]"
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="font-display text-base font-medium truncate">
              {full.brand_name || 'Unknown brand'}
            </div>
            <div className="text-[10px] text-text-muted truncate">
              Ad ID: {full.id}
              {full.status && (
                <span className={`ml-2 inline-block w-1.5 h-1.5 rounded-full align-middle ${
                  full.status === 'active' ? 'bg-emerald-500' : 'bg-text-muted'
                }`} />
              )}
              {full.status && <span className="ml-1 capitalize">{full.status}</span>}
              {loading && (
                <span className="ml-2 inline-flex items-center gap-1 text-text-muted">
                  <Loader2 size={9} className="animate-spin" />
                  refreshing
                </span>
              )}
            </div>
          </div>

          {/* Header actions. Save / Landing / Close. Same order as
              AdDetailPanel's analogue (Download / Comments / Close). */}
          <SaveToBoardButton
            source="atria"
            adId={full.id}
            snapshot={snapshot}
          />
          {full.link_url && (
            <a
              href={full.link_url}
              target="_blank"
              rel="noopener noreferrer"
              className="h-8 px-3 rounded-md border border-black/[0.08] hover:bg-black/[0.04] text-[12px] flex items-center gap-1.5"
              title="Visit landing page"
            >
              <ExternalLink size={11} />
              Landing
            </a>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-black/[0.04] text-text-muted"
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        {/* Two-col grid. same 440/1fr split as AdDetailPanel for visual
            parity. Left = media + copy + metadata, right = tabbed panel. */}
        <div className="grid md:grid-cols-[440px_1fr] gap-0">
          {/* Left column */}
          <div className="p-4 border-r border-black/[0.06] flex flex-col gap-4">
            {media && (
              <div className="rounded-lg overflow-hidden bg-black/[0.04]">
                {isVideo && media.url ? (
                  <video
                    src={media.url}
                    poster={media.preview_image_url || undefined}
                    controls
                    playsInline
                    className="w-full max-h-[520px] object-contain bg-black"
                  />
                ) : (
                  <img src={media.url} alt="" className="w-full max-h-[520px] object-contain" />
                )}
              </div>
            )}

            {/* Copy */}
            <div className="space-y-2">
              {full.title && (
                <div className="font-display text-[15px] leading-snug">{full.title}</div>
              )}
              {full.body && (
                <p className="text-[12px] text-text-primary whitespace-pre-line leading-relaxed">
                  {full.body}
                </p>
              )}
              {full.cta_text && (
                <div className="pt-1">
                  <span className="inline-block px-2 py-1 rounded-md bg-black/[0.04] text-[11px]">
                    CTA: <strong>{full.cta_text}</strong>{full.cta_type ? ` (${full.cta_type})` : ''}
                  </span>
                </div>
              )}
            </div>

            {/* Metadata table */}
            <div>
              <div className="text-[10px] uppercase tracking-widest text-text-muted font-medium mb-1.5">
                Metadata
              </div>
              <table className="w-full text-[11px]">
                <tbody>
                  <Row k="Format"     v={full.display_format || '-'} />
                  <Row k="Started"    v={full.start_date || '-'} />
                  <Row k="Ended"      v={full.end_date || 'Present'} />
                  <Row k="Platforms"  v={(full.platforms || []).join(', ') || '-'} />
                  <Row k="Categories" v={(full.categories || []).join(', ') || '-'} />
                  {isVideo && media?.duration && (
                    <Row k="Duration" v={`${Math.round(media.duration)}s`} />
                  )}
                  {media?.width && media?.height && (
                    <Row k="Dimensions" v={`${media.width} × ${media.height}`} />
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right column. tabbed Performance / Video Scripts. Same
              segmented-control idiom AdDetailPanel uses for its
              Analysis / Comments toggle. */}
          <div className="flex flex-col min-h-[480px]">
            <div className="px-4 pt-4">
              <div className="inline-flex p-0.5 rounded-lg bg-black/[0.04] text-[11px]">
                <button
                  onClick={() => setTab('performance')}
                  className={`px-3 h-7 rounded-md transition-colors ${
                    tab === 'performance'
                      ? 'bg-white text-text-primary shadow-sm'
                      : 'text-text-muted hover:text-text-primary'
                  }`}
                >
                  Performance
                </button>
                {showScriptsTab && (
                  <button
                    onClick={() => setTab('scripts')}
                    className={`px-3 h-7 rounded-md transition-colors ${
                      tab === 'scripts'
                        ? 'bg-white text-text-primary shadow-sm'
                        : 'text-text-muted hover:text-text-primary'
                    }`}
                  >
                    Video Scripts
                  </button>
                )}
              </div>
            </div>

            {/* Performance pane. Atria itself doesn't expose performance
                numbers for competitor ads, so we render the qualitative
                metadata the user can act on: copy patterns, platforms,
                language, and a quick deep-link to the live ad library. */}
            <div className="flex-1 p-4 overflow-y-auto" hidden={tab !== 'performance'}>
              <div className="rounded-lg border border-black/[0.06] bg-white p-3 mb-3">
                <div className="font-display text-[13px] mb-1">Atria signals</div>
                <div className="text-[11px] text-text-secondary leading-relaxed">
                  Atria's public API doesn't expose performance numbers for
                  competitor ads. we surface what they do give us: copy,
                  CTAs, platforms, category tags, and run dates. For your
                  own brand's performance, use the regular Creative Analysis
                  view (toggle Search off).
                </div>
              </div>

              <div className="rounded-lg border border-black/[0.06] bg-white p-3 mb-3">
                <div className="font-display text-[13px] mb-2">Platforms & reach</div>
                <div className="flex flex-wrap gap-1.5">
                  {(full.platforms || []).length === 0 && (
                    <span className="text-[11px] text-text-muted">No platforms listed</span>
                  )}
                  {(full.platforms || []).map(p => (
                    <span
                      key={p}
                      className="inline-block px-2 py-0.5 rounded-full bg-black/[0.04] text-[11px] capitalize"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>

              <a
                href={`https://app.tryatria.com/ads/${encodeURIComponent(full.id)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-black/[0.08] hover:bg-black/[0.04] text-[12px]"
              >
                <ExternalLink size={11} />
                Open in Atria
              </a>
            </div>

            {/* Scripts pane. same hidden-not-unmount idiom as
                AdDetailPanel so the inner VideoScriptsTab keeps cache
                state across tab flips. */}
            {showScriptsTab && (
              <div className="flex-1 overflow-hidden" hidden={tab !== 'scripts'}>
                <VideoScriptsTab videoUrl={media?.url || null} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr className="border-b border-black/[0.04] last:border-0">
      <td className="py-1.5 pr-3 text-text-muted whitespace-nowrap align-top">{k}</td>
      <td className="py-1.5 text-text-primary break-words">{v}</td>
    </tr>
  )
}

/**
 * Table view. counterpart to the mosaic grid. Same `ads` array, but
 * dense tabular layout with a sticky-ish thumbnail column on the left.
 * Wrapped in an `overflow-x-auto` shell so the table can scroll
 * horizontally without resizing the page. matches the analytics
 * page's table side-scroll behavior.
 *
 * Click a row → opens the same AtriaDetailPanel modal the grid uses.
 * Infinite-scroll sentinel is reused from the parent (passed in via
 * `sentinelRef`) so we don't double-fire pagination requests.
 */
function AtriaResultsTable({
  ads, selectedId, onOpen, sentinelRef, loadingMore, cursor,
}: {
  ads: AtriaAd[]
  selectedId: string | null
  onOpen: (id: string) => void
  sentinelRef: React.RefObject<HTMLDivElement | null>
  loadingMore: boolean
  cursor: string | null
}) {
  return (
    <div className="rounded-lg border border-black/[0.06] bg-white overflow-x-auto">
      <table className="w-full text-[11px] min-w-[920px]">
        <thead className="text-[10px] uppercase tracking-widest text-text-muted bg-black/[0.02]">
          <tr>
            <th className="py-2 px-3 text-left font-medium w-[60px]">Ad</th>
            <th className="py-2 px-3 text-left font-medium">Brand</th>
            <th className="py-2 px-3 text-left font-medium">Body</th>
            <th className="py-2 px-3 text-left font-medium whitespace-nowrap">Format</th>
            <th className="py-2 px-3 text-left font-medium whitespace-nowrap">CTA</th>
            <th className="py-2 px-3 text-left font-medium whitespace-nowrap">Status</th>
            <th className="py-2 px-3 text-left font-medium whitespace-nowrap">Started</th>
            <th className="py-2 px-3 text-left font-medium whitespace-nowrap">Platforms</th>
            <th className="py-2 px-3 text-right font-medium w-[40px]"></th>
          </tr>
        </thead>
        <tbody>
          {ads.map(ad => {
            const thumb =
              ad.images?.[0]?.url ||
              ad.videos?.[0]?.preview_image_url ||
              null
            const isVideo = (ad.display_format === 'video') || (ad.videos?.length ?? 0) > 0
            const snapshot = {
              brand_name: ad.brand_name,
              brand_avatar_url: ad.brand_avatar_url,
              title: ad.title,
              body: ad.body,
              display_format: ad.display_format,
              thumbnail_url: thumb,
              preview_image_url: ad.videos?.[0]?.preview_image_url ?? null,
              video_id: ad.videos?.[0]?.url ?? null,
              link_url: (ad as any).link_url ?? null,
              cta_type: (ad as any).cta_type ?? null,
              cta_text: (ad as any).cta_text ?? null,
              start_date: ad.start_date,
              end_date: ad.end_date,
              status: ad.status,
              platforms: ad.platforms,
              categories: ad.categories,
            }
            return (
              <tr
                key={ad.id}
                onClick={() => onOpen(ad.id)}
                className={`border-t border-black/[0.04] hover:bg-black/[0.02] cursor-pointer ${
                  selectedId === ad.id ? 'bg-[#B7410E]/[0.04]' : ''
                }`}
              >
                <td className="py-2 px-3">
                  <div className="relative w-10 h-12 rounded-md overflow-hidden bg-black/[0.04]">
                    {thumb && (
                      <img
                        src={thumb}
                        alt=""
                        loading="lazy"
                        className="absolute inset-0 w-full h-full object-cover"
                        onError={e => {
                          (e.currentTarget as HTMLImageElement).style.display = 'none'
                        }}
                      />
                    )}
                    {isVideo && (
                      <div className="absolute bottom-0.5 right-0.5 glass rounded-full px-1 py-px flex items-center text-[8px] pointer-events-none">
                        <Play size={6} fill="currentColor" />
                      </div>
                    )}
                  </div>
                </td>
                <td className="py-2 px-3">
                  <div className="flex items-center gap-2">
                    {ad.brand_avatar_url && (
                      <img
                        src={ad.brand_avatar_url}
                        alt=""
                        className="w-5 h-5 rounded-full object-cover bg-black/[0.04] shrink-0"
                        loading="lazy"
                      />
                    )}
                    <span className="font-medium truncate">{ad.brand_name || 'Unknown'}</span>
                  </div>
                </td>
                <td className="py-2 px-3 max-w-[360px]">
                  <div className="truncate text-text-secondary">{ad.body || ad.title || ''}</div>
                </td>
                <td className="py-2 px-3 capitalize whitespace-nowrap text-text-secondary">
                  {ad.display_format || '-'}
                </td>
                <td className="py-2 px-3 whitespace-nowrap text-text-secondary">
                  {ad.cta_text || '-'}
                </td>
                <td className="py-2 px-3 whitespace-nowrap">
                  <span
                    className={`inline-flex items-center gap-1 capitalize ${
                      ad.status === 'active' ? 'text-emerald-700' : 'text-text-muted'
                    }`}
                  >
                    <span
                      className={`inline-block w-1.5 h-1.5 rounded-full ${
                        ad.status === 'active' ? 'bg-emerald-500' : 'bg-text-muted'
                      }`}
                    />
                    {ad.status || '-'}
                  </span>
                </td>
                <td className="py-2 px-3 whitespace-nowrap text-text-muted">
                  {ad.start_date || '-'}
                </td>
                <td className="py-2 px-3 whitespace-nowrap text-text-muted">
                  {(ad.platforms || []).slice(0, 3).join(', ') || '-'}
                </td>
                <td
                  className="py-2 px-3 text-right"
                  onClick={e => e.stopPropagation()}
                >
                  <SaveToBoardButton
                    source="atria"
                    adId={ad.id}
                    snapshot={snapshot}
                    compact
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div ref={sentinelRef} className="h-12 flex items-center justify-center">
        {loadingMore && <Loader2 size={14} className="animate-spin text-text-muted" />}
        {!cursor && ads.length > 0 && (
          <span className="text-[11px] text-text-muted">End of results · {ads.length} ads</span>
        )}
      </div>
    </div>
  )
}

// Mirrors GRID_ZOOM_CLASSES in AdAnalysisView so toggling AI Search keeps
// the same step ladder of densities (level 3 = default, matches the
// analytics grid).
const ATRIA_GRID_ZOOM_CLASSES: Record<number, string> = {
  1: 'grid-cols-4 sm:grid-cols-6 md:grid-cols-7 lg:grid-cols-8 xl:grid-cols-10 2xl:grid-cols-12',
  2: 'grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8 2xl:grid-cols-10',
  3: 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8',
  4: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7',
  5: 'grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6',
}

function AtriaZoomSlider({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="sticky bottom-3 z-20 flex justify-center pointer-events-none">
      <div
        className="pointer-events-auto flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/80 backdrop-blur-md shadow-sm border border-black/[0.06]"
        title="Card size"
      >
        <input
          type="range"
          min={1}
          max={5}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Card size"
          className="atelier-zoom-range w-40 h-1 appearance-none bg-black/[0.08] rounded-full outline-none cursor-pointer"
        />
      </div>
    </div>
  )
}

function SkeletonGrid() {
  return (
    <div
      className={`grid gap-2 ${ATRIA_GRID_ZOOM_CLASSES[3]}`}
    >
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-black/[0.06] bg-white overflow-hidden"
        >
          <div className="h-9 bg-black/[0.04]" />
          <div className="bg-black/[0.04] animate-pulse" style={{ aspectRatio: '4 / 5' }} />
        </div>
      ))}
    </div>
  )
}

function EmptyState({
  hasFilters, onReset,
}: {
  hasFilters: boolean
  onReset: () => void
}) {
  return (
    <div className="rounded-lg border border-dashed border-black/[0.12] bg-white/40 py-16 px-4 text-center">
      <div className="font-display text-[16px] mb-1">No ads found</div>
      <div className="text-[12px] text-text-muted mb-3">
        {hasFilters
          ? 'Try widening your filters. Atria indexes ~25M ads but a narrow combo can still come up empty.'
          : 'Type a brand, product, or angle in the search bar above.'}
      </div>
      {hasFilters && (
        <button
          onClick={onReset}
          className="h-7 px-3 rounded-full text-[11px] bg-[#B7410E]/10 border border-[#B7410E]/30 text-[#b55719]"
        >
          Clear filters
        </button>
      )}
    </div>
  )
}

export default AtriaExploreView
