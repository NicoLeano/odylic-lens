# Odylic Lens — Strip-Down Plan

**Goal:** Replace `~/odylic-lens/` with an Atelier-derived clone that contains only Creative Analysis + Brand Settings + API Settings + OAuth onboarding. Atelier (`~/ad-connector/`) is the source-of-truth and must not be modified.

**Strategy:** Build at `~/odylic-lens-new/` from a fresh copy of Atelier; atomically swap at the end.

---

## Phase 0 — Plan (this doc)

Identify everything to keep vs strip. No file system changes in this phase.

---

## Phase 1 — Stage Atelier

```bash
mkdir -p ~/odylic-lens-new
cp -r ~/ad-connector/dashboard ~/odylic-lens-new/web   # Vite frontend
mkdir -p ~/odylic-lens-new/api
```

Then immediately purge:
- `web/node_modules/`
- `web/dist/`
- `web/dist-report/`
- `web/dashboard.log`
- `web/.atelier_*`

Backend is assembled file-by-file (Phase 3), not bulk-copied.

---

## Phase 2 — Strip the frontend

### Files to KEEP (verbatim from Atelier)

| Path | Notes |
|---|---|
| `web/src/main.tsx` | Entry |
| `web/src/index.css` | Tailwind 4 + tokens |
| `web/src/report.tsx` | Used by `report.html`; leave alone |
| `web/src/ErrorBoundary.tsx` | |
| `web/src/assets/` | Logos / images |
| `web/src/components/AdAnalysisView.tsx` | The CA workspace (5961 lines) |
| `web/src/components/AdDetailPanel.tsx` | Side panel |
| `web/src/components/ads/` (all 13 files) | Filters, group-by, metrics, naming, virtual grid, boards, reports |
| `web/src/components/BrandSelector.tsx` | Topbar brand dropdown |
| `web/src/components/BrandSettingsView.tsx` | Settings page (naming convention) |
| `web/src/components/DatePicker.tsx` | Gorgeous one w/ compare-period |
| `web/src/components/DataTable.tsx` | Shared |
| `web/src/components/ChartView.tsx` | Shared |
| `web/src/components/ProfileDetail.tsx` | Used by BrandSettingsView |
| `web/src/components/FunnelView.tsx` | Imported by AdAnalysisView |
| `web/src/components/DemoFunnelView.tsx` | Imported by AdAnalysisView |
| `web/src/components/AtriaExploreView.tsx` | Imported by AdAnalysisView (creative-explore flow). Strip only deep deps if needed. |
| `web/src/components/VideoScriptsTab.tsx` | Imported by AtriaExploreView |
| `web/src/components/VideoRetentionMini.tsx` | Used in AdDetailPanel / AdAnalysisView |

### Files to STRIP

| Path | Reason |
|---|---|
| `web/src/components/ChatView.tsx` | Chat — not CA |
| `web/src/components/MMMView.tsx`, `mmm/` | MMM |
| `web/src/components/IncrementalityView.tsx`, `IncrementalityWizard.tsx`, `IncrementalityResults.tsx`, `incrementality/` | Incrementality |
| `web/src/components/PnLView.tsx`, `PnLSettings.tsx` | P&L |
| `web/src/components/ReachView.tsx` | Reach |
| `web/src/components/TrendsView.tsx`, `TrendsCard.tsx` | Trends |
| `web/src/components/HealthView.tsx` | Health |
| `web/src/components/ForecastView.tsx`, `forecast/` | Forecast |
| `web/src/components/EfficiencyView.tsx` | Efficiency |
| `web/src/components/CreativePlannerView.tsx`, `planner/` | Planner |
| `web/src/components/StudioView.tsx`, `studio/` | Studio |
| `web/src/components/ReportView.tsx` | Standalone report (CA has its own export flow) |
| `web/src/components/ClientReview.tsx` | Client review tab |
| `web/src/components/AssetTracker.tsx` | Asset tracker |
| `web/src/components/InspoView.tsx` | Inspo tab — separate from CA |

### `App.tsx` rewrite

Atelier's `App.tsx` (1136 lines) has many tabs; Lens collapses to three:
- **Creative Analysis** (default) → `AdAnalysisView`
- **Brand Settings** → `BrandSettingsView`
- **API Settings** → existing Lens `pages/ApiSettings.tsx` (copied over)

Auth gating layered at top of App:
- Hit `GET /api/auth/status` on mount.
- If `app_configured === false` → render `<Landing />` ("Get started — paste your Facebook app credentials").
- If `logged_in === false` → render `<Landing />` w/ Connect Facebook CTA.
- Else render Atelier-style shell.

`BrandSelector` is populated from `GET /api/auth/accounts` (per-user), not a hardcoded dict.

### Lens pages to copy in

| From → To |
|---|
| `~/odylic-lens/web/src/pages/Landing.tsx` → `~/odylic-lens-new/web/src/pages/Landing.tsx` |
| `~/odylic-lens/web/src/pages/Setup.tsx` → `~/odylic-lens-new/web/src/pages/Setup.tsx` |
| `~/odylic-lens/web/src/pages/ApiSettings.tsx` → `~/odylic-lens-new/web/src/pages/ApiSettings.tsx` |
| `~/odylic-lens/web/src/lib/api.ts` → merge into Lens's `web/src/lib/api.ts` (auth + accounts endpoints) |

### `package.json`

Downgrade Atelier (React 19, TS 6, Vite 8) to Lens stack (React 18, TS 5, Vite 5). React 19 packages aren't compatible with `react-grid-layout` 1.5 / `react-markdown` 9. Keep `recharts` 2.13.

---

## Phase 3 — Strip the backend

Assemble `~/odylic-lens-new/api/` from a hand-picked list, not bulk copy.

### Files to copy from Atelier (`~/ad-connector/`)

| File | Lines | Notes |
|---|---|---|
| `ad_analysis_endpoints.py` | 7464 | The big one. Will be adapted to use per-user `MetaClient` (~46 substitutions). |
| `creative_warehouse.py` | 304 | DuckDB cache helpers (imported lazily by ad_analysis). |
| `generic_pulls.py` | 896 | Meta Graph helpers. |
| `pull.py` | 363 | DuckDB query helper. |

Tracing `ad_analysis_endpoints.py` imports:
- `creative_warehouse` (line 1524, 1650, 2467, 4400)
- `local_extract` (line 5719) — image extraction helper. Pull `local_extract.py` only if it exists and is small.
- `brand_profile_store` (line 7166, 7182) — naming convention storage. Either pull file or stub the two functions (`get_profile`, `save_profile`) into a thin local module that reads `~/.odylic-lens/brand_profile.json`. Decision: **stub locally** for Lens (per-user).
- `from api_server import META_ACCOUNTS` (line 1278) — replace with `auth.list_accounts(lens_session)`.

### Files to ship from current Lens (`~/odylic-lens/api/`) — copy AS-IS

| File | Lines | Notes |
|---|---|---|
| `auth.py` | 355 | OAuth flow + `require_meta` helper |
| `store.py` | 425 | Encrypted SQLite |
| `meta_client.py` | 417 | Per-user MetaClient |
| `integrations.py` | 174 | Atria/OpenAI key storage |
| `security.py` | 116 | Middleware |
| `pyproject.toml` | — | Python deps |

### Replaces / merges

| File | Action |
|---|---|
| `main.py` (Lens) + `api_server.py` (Atelier, stripped) | Merge. Keep Lens `main.py` as base; pull in any extra middleware Atelier had (CORS already there). Mount only routers Lens needs. |
| `creative_analysis.py` (Lens) | KEEP. This is Lens's wrapper layer that pre-dates Atelier's CA. After porting Atelier's full `ad_analysis_endpoints.py`, decide: **deprecate** (use Atelier's) or keep alongside as an alternate `/api/lens-ca/*` mount. Decision: **deprecate**; Atelier's is far more featureful. |
| `ad_analysis_endpoints.py` (current Lens — 708 lines, 4 routes) | DELETE. Replaced by Atelier-port. |

### Files to STRIP (do not copy from Atelier)

All other root Python files in `~/ad-connector/*.py` are not copied:
- `api_server.py` (we write our own from `main.py`)
- `api_health.py`, `daily.py`, `weekend_recap.py`, `sh_morning_report.py`, `send_slack.py`, `token_reminder.py`, `cli.py`, `mcp_server.py`
- `mmm_*.py`, `mmm_atelier.py`, `mmm_runner.py`
- `incrementality_endpoints.py`
- `pnl_endpoints.py`, `pnl_forecasting.py`
- `planner_endpoints.py`, `planner_autofill.py`, `PLANNER_*.py`
- `studio_endpoints.py`
- `chat_endpoints.py`, `chat_smoke_test.py`
- `client_review_endpoints.py`
- `health_*.py` (no separate health py — handled in `api_server.py`)
- `forecast` (lives inside `api_server.py`)
- `script_endpoints.py`
- `ads_reports_endpoints.py`
- `inspo_*.py`
- `boards_endpoints.py` — boards UI is kept in CA frontend; backend can be stubbed or also ported. Decision: **port `boards_endpoints.py`** (simple JSON store, ~hundreds of lines, used by `BoardsMenu`/`SaveToBoardButton` in `ads/`).
- `brand_profile_endpoints.py` — naming convention API. Decision: **stub local Lens version** (per-user, in `~/.odylic-lens/`).
- `atria_endpoints.py` — if AtriaExploreView is kept, we'll need a stripped Atria backend. Decision: **stub endpoints to 501 / disabled** so the UI gracefully shows "not configured" until later.
- `audit_*.py`, `brand_asset_scraper.py`, `brand_doc_extractor.py`
- `facebook_ads_pipeline.py`, `google_ads_pipeline.py`, `shopify_dlt_pipeline.py`, `live_breakdowns.py`, `local_extract.py` (probably skip — we live off Graph API)
- `agents/`, `atelier/` (sub-package), `pipelines/`, `mmm_runs/`, etc.

### `api_server.py` strip-down → merged into Lens `main.py`

Of Atelier's 17 `include_router` calls, Lens keeps **1**: `ad_analysis_router`. Plus Lens-native: `auth_router`, `integrations_router`, optionally `boards_router`.

### Brand list endpoint

`GET /api/brands` (currently in `api_server.py`) becomes:
- Reads `store.list_ad_accounts(fb_user_id)` for the logged-in Lens session.
- Returns a payload shape compatible with what the Atelier `BrandSelector` expects: `[{ brand, account_id, ... }]`.

Inside `ad_analysis_endpoints.py`, the local `from api_server import META_ACCOUNTS` call (line 1278) is replaced with a helper `def get_user_accounts(request)` that calls `auth.list_accounts()`.

---

## Phase 4 — Adapt `ad_analysis_endpoints.py`

Patterns to substitute (46 token-related lines):

1. `token = os.environ.get("META_ACCESS_TOKEN")` → `client = auth.require_meta(request); token = client.token`
2. `if not token: raise HTTPException(...)` → already handled by `require_meta`
3. `if brand not in META_ACCOUNTS: raise HTTPException(404, ...)` → `acct = auth.resolve_brand(request, brand)` (lookup in user's accounts)
4. `f"act_{META_ACCOUNTS[brand]}"` → `acct.act_id` (which is already `act_<id>` or just `<id>`)
5. `from api_server import META_ACCOUNTS` → removed; use the helper

This is mechanical. Add a header to the file:

```python
# Lens-port note: derived from ad-connector/ad_analysis_endpoints.py.
# Adapted to per-user Meta credentials via auth.require_meta + meta_client.MetaClient.
```

For routes that take `brand` as query param, signatures change from:

```python
@router.get("/dashboard")
def dashboard(brand: str, ...):
```

to:

```python
@router.get("/dashboard")
def dashboard(brand: str, request: Request, ...):
    client = auth.require_meta(request)
    acct = auth.resolve_brand(client, brand)
```

`auth.require_meta(request)` and `auth.resolve_brand(client, brand)` are added to `auth.py` if not already there.

---

## Phase 5 — Atomic swap

```bash
cd ~/odylic-lens-new/web && npm install && npm run build
cd ~/odylic-lens-new/api && python3 -m venv venv && source venv/bin/activate && pip install -e .
# Smoke test: python -c "from main import app; print(len(app.routes))"
mv ~/odylic-lens ~/odylic-lens-old-$(date +%Y%m%d-%H%M%S)
mv ~/odylic-lens-new ~/odylic-lens
```

Update `~/odylic-lens/install.sh` if it references hardcoded paths.

---

## Phase 6 — Audit → `docs/strip-down-audit.md`

Sweep checklist:
1. `grep -r 'from.*MMM\|from.*Incrementality\|from.*PnL\|TrendsView\|HealthView\|ForecastView' ~/odylic-lens/web/src/` — should be empty.
2. `grep -r 'META_ACCOUNTS\|os.environ.*META_ACCESS_TOKEN' ~/odylic-lens/api/` — should be empty (only via MetaClient).
3. Inspect `index.css` for slider thumb color — should be `#999`, not blue.
4. Inspect DatePicker in `App.tsx` — should be Atelier's component with compare period.
5. Inspect `App.tsx` topbar — `BrandSelector` is a dropdown, not a route-level page list.
6. Verify `ads/namingConvention.ts` `parseAdName` patch carries over (the prior bug-fix).
7. Verify `AdAnalysisView.tsx` `DimensionFilterPopover` carries over the `namingExtraDimensions` merge.
8. List features that were known to work in Atelier but now disconnected (boards backend? Atria? comments? sentiment?).
9. Count stripped frontend / backend modules.

---

## Risk log

- **AdAnalysisView is 5961 lines.** Adapting it should be unnecessary — it consumes endpoints, not env vars. Verify no `META_ACCESS_TOKEN` reference in frontend.
- **`ad_analysis_endpoints.py` is 7464 lines.** Mechanical substitution. The risk is missing one branch and getting a 500.
- **Brand profile store / boards backend.** Either port or stub; document either way.
- **Atria endpoints.** Stub to "not configured" responses; the UI is kept but data may be empty.
- **React 19 → React 18 downgrade.** Tailwind 4 + Vite 5 should both still work. Watch for `use()` / new React 19 hooks in the codebase (unlikely in views that predate it).

