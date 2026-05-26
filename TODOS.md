# Lens Fork — Deferred Work

> Items intentionally deferred from v1 build (see `docs/plans/2026-05-25-lens-fork-creative-ops-build.md`). Each has why + context + dependencies so future-you can pick up without re-deriving the motivation.

---

## TODO-001: Layer 2 video model (Gemini 2.5 Pro / Qwen3-VL-235B opt-in toggle)

**What:** Add an opt-in "Deep video analysis" toggle on individual recipes in the Analyze tab. Toggle picks Gemini 2.5 Pro or Qwen3-VL-235B (via Together AI) and routes the video through native video-understanding instead of Layer 1's ffmpeg-frame approach.

**Why:** Layer 1 (Claude vision over 8-12 extracted frames + transcript + brand context) covers ~80% of creative critique value at zero extra vendor cost. The other 20% is motion-aware reasoning — pacing energy, hook timing micro-rhythm, scene-transition dynamics. Some Vital winners are video-heavy and the recipe rationale may feel shallow on those specific dimensions. Adding Layer 2 unlocks the missing 20% but only when you actually need it (not on every ad).

**Context:**
- Locked decision in plan: ship v1 with Layer 1 only, re-evaluate after 2-4 weeks of real use
- Re-evaluation criteria: do recipes for video-heavy ads consistently miss insights that frame-only analysis can't surface? If yes → build the toggle.
- Benchmark plan when ready:
  1. Pick 5 Vital winner videos (mix of formats)
  2. Run each through Gemini 2.5 Pro (~$1-3/video) via Google AI Studio
  3. Run same 5 through Qwen3-VL-235B (~$0.50-1/video) via Together AI
  4. Compare recipe quality side-by-side, pick default
- Expected outcome: Gemini wins quality, Qwen wins cost. Mixed default = Qwen for batch + Gemini opt-in for deep dives.
- Cost ceiling expectation: $15-50/month additional at heavy usage
- Implementation surface: extend `claude_client.py` (the unified router from 1A) with a "gemini" / "qwen" strategy, add toggle UI to Analyze recipe card, wire vendor SDK keys via `integrations.py`

**Depends on / blocked by:**
- v1 ships (Phase 2 + 3 complete)
- 2-4 weeks of real Lens use to evaluate need
- Possibly funding allowance for new vendor signups (Google AI Studio free tier covers benchmark, paid tier needed for production)

---

## TODO-002: Meta launch automation via Marketing API

**What:** Add "Launch to Meta" button on draft cards that uses Meta's Marketing API to push the asset + recipe metadata directly into a campaign/adset in your active brand's ad account. No manual download + Ads Manager upload.

**Why:** Today the Create stage produces local files in `~/.odylic-lens/drafts/`. To actually run an ad, you manually download the asset, open Meta Ads Manager, create a new ad, upload, fill metadata. That manual handoff = 5-10 min per ad shipped + room for mistake (wrong adset, wrong creative spec, lost ad name token). Direct push closes the loop end-to-end.

**Context:**
- Blocked on access role: your Facebook user is currently "Read-Only" on Bliss Ventures BM (shown in Lens as `BLISS VENTURES (Read-Only)`). Same constraint on Vital + Odder if you have analyst-only roles there.
- To unblock: ask each BM owner to bump your role to "Advertiser" or "Admin" on the relevant ad account
- Once bumped: Meta Marketing API endpoint is `POST /<adaccount_id>/ads` with creative payload — Lens already has `meta_client.py` for read operations, extend with write
- Recipe → ad mapping: copy fields → ad text, asset → creative image/video, recipe.angle → ad name token via your Brand Settings naming convention
- Status transition: `drafts.status` flow extends `proposed → ready → draft → launched`. Plan currently stops at `draft`; this TODO adds `launched` with `meta_ad_id` populated.
- UI: green "Launch to Meta" button on draft card with confirmation modal showing target ad account + adset

**Depends on / blocked by:**
- BM role bump from Read-Only → Advertiser on each brand's ad account
- v1 Phase 3 complete (drafts table + asset files exist)
- May want to add Meta App permission `ads_management` on full access (currently "ready for testing" tier — may need bump if Meta tightens)

---

## TODO-003: Cost dashboard (per-stage spend visibility)

**What:** Add a Settings → Costs panel that surfaces month-to-date spend per stage: Anthropic API (audit tagging via Haiku), Claude Code subscription session usage (Analyze stage, $0 marginal but useful for cap visibility), fal.ai per-generation cost (Create stage). Pull from each vendor's API where possible, fall back to local SQLite log otherwise.

**Why:** With three AI vendors (Anthropic API, Claude Code subscription, fal.ai) in the pipeline + token billing on Anthropic + per-generation billing on fal.ai, monthly cost can drift without you noticing. dose-creative had a known monthly cost ($20-40 flat). Lens fork has variable cost. Without a dashboard you'll find out via credit card statement, not before. Solo-founder budget discipline needs visibility.

**Context:**
- Current cost expectations (from plan):
  - Audit tagging: $1-3 one-time + $0.10/week steady (Anthropic API direct)
  - Analyze stage: $0 marginal (Claude Code subscription)
  - Create stage: $10-30 first batch + $4-20/month steady (fal.ai)
  - Total month 1: $11-33 / Steady: $4-23/month
- Data sources:
  - **Anthropic API**: query `/v1/organizations/<org>/usage_report` or self-log per-call token counts to SQLite
  - **Claude Code**: session usage visible in Claude Code dashboard; surface via subprocess call to `claude usage` or scrape
  - **fal.ai**: their dashboard shows per-key spend; query via API or self-log per `fal_client.run` call cost return value
- UI shape: 3 cards with MTD totals + sparkline trend + month-over-month delta
- Alerting nicety: optional cap per stage; if approaching, surface warning chip on respective tab
- Backend: new `cost_log` SQLite table with `(timestamp, stage, vendor, units, cost_usd)` rows, written from each stage's client

**Depends on / blocked by:**
- v1 ships (otherwise nothing to track)
- Probably wants Layer 2 (TODO-001) to land first so the dashboard reflects all stages from day 1
- Anthropic + fal.ai usage API access (Anthropic has it; fal.ai depends on their billing endpoint surface)
