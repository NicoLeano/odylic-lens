# Odylic Lens — Strip-Down Audit

Companion to `strip-down-plan.md`. Captures what shipped, what's still
broken, and what to follow up on.

## Final shape

### Frontend (`~/odylic-lens/web/`)

Top-level routes (App.tsx):
* `/setup` → `pages/Setup.tsx` (paste Meta App ID + secret)
* `/` (unauthed) → `pages/Landing.tsx` (Connect with Facebook)
* `/` (authed) → `Shell` with three tabs:
  * **Creative Analysis** (`AdAnalysisView` — 5961 lines, ported verbatim)
  * **Brand Settings** (`BrandSettingsView` — 2138 lines, ported verbatim)
  * **API Settings** (Lens-native `pages/ApiSettings.tsx`)

Components kept (14 + ads/13):
```
components/
  AdAnalysisView.tsx       5961 lines
  AdDetailPanel.tsx        1960 lines
  AtriaExploreView.tsx     1544 lines
  BrandSelector.tsx
  BrandSettingsView.tsx    2138 lines
  ChartView.tsx
  DataTable.tsx
  DatePicker.tsx
  DemoFunnelView.tsx
  FunnelView.tsx
  ProfileDetail.tsx
  VideoRetentionMini.tsx
  VideoScriptsTab.tsx
  ads/
    BoardDetailModal.tsx
    BoardsMenu.tsx
    CommentsView.tsx
    FilterBuilder.tsx
    GroupBy.tsx
    PerformanceCharts.tsx
    ReportsMenu.tsx
    SaveToBoardButton.tsx
    customMetrics.ts
    groupByData.ts
    metrics.ts
    namingConvention.ts
    useVirtualGrid.ts
```

Frontend components stripped (19):
```
ChatView.tsx, MMMView.tsx + mmm/, IncrementalityView.tsx +
IncrementalityWizard.tsx + IncrementalityResults.tsx + incrementality/,
PnLView.tsx, PnLSettings.tsx, ReachView.tsx, TrendsView.tsx,
TrendsCard.tsx, HealthView.tsx, ForecastView.tsx + forecast/,
EfficiencyView.tsx, CreativePlannerView.tsx + planner/, StudioView.tsx +
studio/, ReportView.tsx, ClientReview.tsx, AssetTracker.tsx,
InspoView.tsx
```

### Backend (`~/odylic-lens/api/`)

Files kept / shipped (12):
```
auth.py                  355 lines — OAuth + session
store.py                 425 lines — encrypted SQLite
meta_client.py           417 lines — per-user MetaClient
integrations.py          174 lines — Atria/OpenAI key vault
security.py              116 lines — middleware
test_mock.py             145 lines — E2E mock
pyproject.toml
main.py                  ~115 lines (rewritten)
lens_context.py          ~150 lines (NEW)
lens_routes.py           ~260 lines (NEW)
ad_analysis_endpoints.py 7464 lines (ported from Atelier)
creative_warehouse.py     ~70 lines (replaced with in-process stub)
```

Backend files stripped (compared to Atelier's 48 root `.py` files):
```
api_server.py, api_health.py, daily.py, weekend_recap.py,
sh_morning_report.py, send_slack.py, token_reminder.py, cli.py,
mcp_server.py, mmm_*.py, incrementality_endpoints.py, pnl_endpoints.py,
pnl_forecasting.py, planner_endpoints.py, planner_autofill.py,
studio_endpoints.py, chat_endpoints.py, chat_smoke_test.py,
client_review_endpoints.py, script_endpoints.py,
ads_reports_endpoints.py, inspo_connectors.py, inspo_store.py,
boards_endpoints.py, brand_profile_endpoints.py, atria_endpoints.py,
audit_*.py, brand_asset_scraper.py, brand_doc_extractor.py,
facebook_ads_pipeline.py, google_ads_pipeline.py,
shopify_dlt_pipeline.py, live_breakdowns.py, local_extract.py,
generic_pulls.py, pull.py
```
Net: stripped ~33 backend Python modules + `agents/`, `atelier/`,
`pipelines/`, `mmm_runs/`.

### Route summary

`/api/auth/*` (8 routes), `/api/integrations/*` (~6),
Lens-native (`/api/brands`, `/api/metrics`, `/api/profile`,
`/api/brand-profiles/*`, `/api/planner/*` stubs, `/api/trends/keywords`
stub, `/api/atria/ads` stub, `/api/boards*` stubs, `/api/ads/reports`
stub) (~17), `/api/ads/*` (35 — full Atelier CA suite), `/api/status` —
**total 81 routes**.

## Audit findings

### 1. Slider thumb color (was previously blue in Lens)

`index.css` line 395 — `.atelier-zoom-range::-webkit-slider-thumb` is
`#999999`. **No blue thumb anywhere.** Confirmed against the Atelier
original.

### 2. Calendar / DatePicker with compare period

`App.tsx` uses Atelier's `components/DatePicker.tsx` (the gorgeous one)
with `compareStart` / `compareEnd` props threaded through to
`AdAnalysisView`. **Confirmed.**

### 3. BrandSelector is a topbar (sidebar) dropdown, not a route

App.tsx mounts `<BrandSelector ... />` in the left nav rail with a
circle button + popover (Atelier pattern). No `/brands` route exists.
**Confirmed.**

### 4. parseAdName naming-bug fix carried over

`web/src/components/ads/namingConvention.ts` is byte-identical to the
prior fixed copy in `~/odylic-lens-old-*`. **Confirmed.**

### 5. DimensionFilterPopover namingExtraDimensions merge

`AdAnalysisView.tsx` was copied verbatim from Atelier, which already
contains the fix per `~/odylic-lens-old-*/docs/naming-bug-diagnosis.md`.
**Confirmed (carried over by virtue of copying the whole file).**

### 6. Backend still references META_ACCOUNTS and META_ACCESS_TOKEN

By design — these were left in place because `lens_context.py`
monkey-patches `_get_meta_accounts()` and `os.environ` inside the
module to return per-user values. The lookups inside
ad_analysis_endpoints look unchanged at source level but route to the
current user's session at runtime. **By design, but it's a sharp edge.**

If a contributor later refactors `ad_analysis_endpoints.py` and breaks
that indirection, every CA call will silently fall back to env (which
is empty in production Lens), and every brand lookup returns "Not in
META_ACCOUNTS". Mitigation: add a unit test asserting the patch took.

### 7. ReportView / report.html shipping was dropped

Atelier exports standalone HTML "ad report" snapshots via the
`vite.report.config.ts` build and a `report.tsx` entry. Dropped — Lens
doesn't ship that workflow yet. The "Save Report" / "Export" button in
the CA toolbar still appears (it's part of `ReportsMenu`), but
`/api/ads/reports` is now a stub returning `[]`. Export buttons may
404 until we port `ads_reports_endpoints.py`.

### 8. Atria, Boards, Comments-sentiment backends are stubs

Endpoints are wired but return empty / 501:
* `/api/atria/ads` returns `{"ads": [], "configured": false}`
* `/api/boards*` returns `[]` / 501 on create
* `/api/ads/reports*` returns `[]`
* `/api/ads/comments/sentiment-rollup` — uses Atelier's RoBERTa /
  Anthropic flow; will fail if `anthropic` / `transformers` aren't
  installed (they're in `[project.optional-dependencies]`)

The CA UI handles empty payloads gracefully (boards menu shows
"No boards yet", Atria tab will show empty). Comments thread still
works as long as Anthropic API key is set in
`/api/integrations/openai`-style storage — Atelier reads it from env;
Lens has no wiring for that yet.

### 9. Brand profile store is a single JSON file per user

Lens-native: `~/.odylic-lens/brand_profile.json` keyed by
`{fb_user_id: {brand: {profile dict}}}`. Atelier had a more elaborate
multi-section profile store via `brand_profile_endpoints.py`. The
BrandSettingsView's "section" UI (Identity, Connections, Positioning,
etc.) calls `/api/brand-profiles/{brand}/section/{section}` — all those
return empty `{data: {}}`, so the sections render but **don't persist
yet**. Follow-up: port the section store.

### 10. Planner / Trends / VideoScripts integrations missing

The BrandSettingsView's "Planner Taxonomy" and "Trend Keywords" tabs
hit `/api/planner/taxonomy*` and `/api/trends/keywords`. Both are
stubs returning empty. The VideoScripts tab inside AdDetailPanel hits
`/api/ads/script/*` — those routes exist (ported from Atelier inside
ad_analysis_endpoints) but require Anthropic; **graceful failure**.

### 11. Frontend bundle is one giant 1MB chunk

Vite warned about the chunk size. Atelier code-split via `lazy()` on
the tab components, but BrandSettingsView in Lens is the only thing
lazy-loaded. Most of the size is `AdAnalysisView` (5961 lines) +
Recharts + AdDetailPanel. Could be optimized later by lazy-loading
`AdDetailPanel` and the boards modal, but not a regression — Atelier's
build was similar.

### 12. React 19 → React 18 downgrade

No functional regressions found. The downgrade was forced because:
- `react-grid-layout@2` doesn't have a stable React 19 peer
- `react-markdown@10` requires React 19
- `react@19` is still new

We pinned: `react@18.3.1`, `react-dom@18.3.1`, `react-grid-layout@1.5`,
`react-markdown@9`, `recharts@2.13`, `lucide-react@0.460`. No
React-19-only APIs found in the ported components (no `use()` hook,
no `<Suspense>` for data fetching as actions, etc.).

### 13. Vite dev port + API port changed

* Dev: web on `:5173`, api on `:8765` (changed from `:3001` which
  was Atelier's port; `:3001` was a port conflict on Peter's machine).
* Update `install.sh` if needed (currently references `3001` — TODO).

## Features that worked in Atelier and may not in Lens

| Feature | Atelier | Lens status |
|---|---|---|
| Save Report (CA toolbar) | yes, persisted via `ads_reports_endpoints.py` | stub returns `[]` |
| Boards (save creative to a board) | yes, `boards_endpoints.py` | stub 501 |
| Atria creative search | yes, `atria_endpoints.py` | stub returns empty |
| Comments + sentiment overlay | RoBERTa + Anthropic | works if optional deps installed |
| Video scripts tab | Anthropic | works if Anthropic key in env |
| Brand-profile multi-section storage | `brand_profile_endpoints.py` | stub no-op writes |
| Planner taxonomy | `planner_endpoints.py` | stub returns empty |
| Trend keywords | `pytrends` cache | stub returns empty |
| Prewarm (background warmer for cache) | yes, iterates all brands | disabled in Lens (per-user, anonymous-burst risk) |

## Known sharp edges

* `lens_context.LensContextMiddleware` patches `os.environ` on the
  `ad_analysis_endpoints` module **once at import**. If something
  reimports the module (e.g. `importlib.reload`), the patch is lost
  unless `patch_ad_analysis_endpoints()` is re-called. The `main.py`
  startup calls it exactly once, before mounting the router.
* `ad_analysis_endpoints._fetch_ad_creative()` and similar accept
  `token: str` as a positional arg — Lens passes the per-user token
  via the contextvar-aware `os.environ.get("META_ACCESS_TOKEN")`.
  Verified at three sample endpoints (`/dashboard`, `/creatives`,
  `/creative/{ad_id}`); a deeper sweep is recommended before the
  first real user session.
* Old `~/odylic-lens-old-<timestamp>` directory preserved for
  diff/recovery. Do NOT delete until production smoke passes.

## Sanity output

```
$ cd ~/odylic-lens/web && npm run build
✓ 2418 modules transformed.
dist/assets/index-*.js   1,049 kB │ gzip: 297 kB
✓ built in 2.10s

$ cd ~/odylic-lens/api && ./venv/bin/python -c "import main; print(len(main.app.routes))"
[prewarm] disabled via ATELIER_DISABLE_PREWARM=1
81

$ curl http://localhost:8765/api/auth/status
{"app_configured": false, "logged_in": false, ...}

$ curl http://localhost:8765/api/brands
[]
```
