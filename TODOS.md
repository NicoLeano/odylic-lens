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

## ~~TODO-004: claude_client._parse_json_loose uses greedy regex~~ RESOLVED 2026-05-26

Replaced greedy `_JSON_BLOCK_RE` with `_first_balanced_json_block` — a state-machine scanner that honors string literals + backslash escapes and returns the first balanced `{...}` substring. Added regression tests for embedded-example output and braces inside string literals. Lands in same commit as TODO-005.

---

## ~~TODO-005: claude_client subprocess timeout / empty / mime polish~~ RESOLVED 2026-05-26

All three items fixed:
1. `subprocess.TimeoutExpired` → `RuntimeError("claude CLI timed out after Ns")`.
2. Empty stdout (`returncode=0` + blank text) → explicit `RuntimeError("claude CLI returned empty stdout")` before `_parse_json_loose` sees it.
3. `_mime_for` raises `ValueError("unsupported frame extension '.webp'")` instead of silently defaulting to `image/png`.

Regression tests in `tests/test_claude_client.py`. 17/17 pass.

---

## TODO-006: Phase 3.5 — make multi-variant fal.ai generation non-blocking

**What:** Replace the sequential `variant_count` loop in `fal_generation.generate_video()` with bounded parallelism or the fal.ai submit/poll API.

**Why:** Phase 3 correctly keeps the database lock released during fal.ai calls, but `variant_count > 1` can still hold one HTTP request for several minutes. The frontend currently hardcodes `variant_count: 1`, so user risk is low, but the backend accepts up to 4 variants.

**Acceptance:**
- Multi-variant generation runs concurrently with bounded workers, or uses `fal_client.submit` plus polling.
- The Create route still does not hold `store._LOCK` during fal.ai work.
- Existing single-variant behavior and response shape stay compatible.
- Regression coverage pins the no-DB-lock behavior during generation.

---

## TODO-007: Phase 3.5 — sniff upload media bytes before storing draft assets

**What:** Validate uploaded image/video bytes instead of trusting the multipart content type or filename extension.

**Why:** Phase 3 manual uploads currently use `UploadFile.content_type` and extension fallback. A spoofed request could store bytes under an attacker-chosen media type and replay them through `/api/draft-assets/{asset_id}/file`. Blast radius is local single-tenant/self-XSS, but byte sniffing is the correct boundary.

**Acceptance:**
- Validate upload bytes with a real detector, e.g. `python-magic`, or a small allowlisted signature check.
- Reject mismatched or unknown image/video types before inserting `draft_assets`.
- Return a clear HTTP 400 for unsupported media.
- Add route tests for spoofed content type and valid image/video upload.

---

## TODO-008: Phase 3.5 — clean orphan files on multi-variant fal.ai failure

**What:** Remove files downloaded during a failed multi-variant fal.ai request before returning an error.

**Why:** Phase 3 inserts asset rows transactionally, but if `variant_count > 1` and a later fal.ai call/download fails, earlier downloaded files from that same request can remain on disk without matching `draft_assets` rows. The frontend currently requests one variant, but the backend allows up to 4.

**Acceptance:**
- Generation failures remove files downloaded during the failed request.
- Existing successful draft assets are not deleted.
- Add test coverage for a mid-loop failure leaving no new files behind.
- Keep existing transactional DB insert behavior unchanged.

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
