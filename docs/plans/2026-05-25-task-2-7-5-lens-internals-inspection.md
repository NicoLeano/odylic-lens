# Task 2.7.5 — Lens internals inspection (decision 5A)

**Purpose:** Confirm real signatures of the Lens modules the new
`analyze_endpoints.py` will depend on, so Task 2.8 tests mock against
production names — no orphan stubs in shipped code.

**Inspected commit:** `832a34d` on `feat/analyze-stage`.

---

## 1. `brand_profile_store.get_profile(brand: str) -> dict`

File: `api/brand_profile_store.py:59`.

Returns the profile dict for the brand (looks in `__lens_global__`
bucket first, falls back to any per-user bucket that holds the brand).
Empty profile when not found — returns `{}`, never `None`. So
`analyze_endpoints` does NOT need a `_fetch_brand_context` indirection;
call `brand_profile_store.get_profile(brand)` directly.

Profile content matters for cache key per 4A — every profile mutation
must bust the cache. Use `hashlib.sha256(json.dumps(profile,
sort_keys=True))` for the hash leg.

## 2. `claude_client.call(...)` — unified router

File: `api/claude_client.py:127`.

```python
def call(
    *,                                     # kwargs-only
    strategy: Literal["api", "subprocess"],
    prompt: str,
    model: str = "claude-sonnet-4-6",
    system: Optional[str] = None,
    frames: Optional[list[str]] = None,
    max_tokens: int = 4096,
    timeout: int = 120,
) -> dict
```

For Analyze: `strategy="subprocess"` (per 1A — uses the Max-plan
subscription, $0 marginal). `frames` accepts the list returned by
`frame_extractor.extract_frames` / `extract_frames_concurrent`.

Auth-expired path: `ClaudeAuthExpired` (subclass of `RuntimeError`)
bubbles up — the route handler must catch and re-raise as HTTP 401 with
a payload the frontend recognizes (`{"error": "claude_auth_expired"}`).

## 3. Top-winners data source

`@router.get("/creatives")` at `api/ad_analysis_endpoints.py:2697`
delegates to `_list_creatives_impl(brand, start, end, limit)`. That's
the real fetcher we wire in at Task 2.10. For 2.8/2.9 we keep
`_fetch_top_winners(brand, top_n, focus_product) -> list[dict]` as a
private stub that returns `[]` by default; tests patch it.

When wiring, derive `start`/`end` from "last 30 days" by default and
filter by `focus_product` against creative metadata after the impl
returns its list.

## 4. Route path collision

`@router.post("/analyze")` already exists at
`api/ad_analysis_endpoints.py:5755` — that's the legacy ad-detail
analyzer (Anthropic SDK, per-creative). Our new route is for *recipe
recommendations from winners* — different domain, different output.

**Decision:** mount new route at `POST /api/recipes/analyze`. Test file
uses the same prefix. Frontend Analyze tab calls
`/api/recipes/analyze`.

## 5. No `drafts` table in `store.py`

`store.py` defines: `users`, `connections`, `ad_accounts`, `sessions`,
`integrations`, `brand_section_data`. No `drafts` / `draft_assets`
schema yet — those land in Task 2.10 (real wiring) per 3C and 7A.

For 2.8/2.9 TDD red+green, `_save_proposed_drafts(brand, recipes) ->
None` stays a private stub tests patch. Real implementation lands when
the table is added.

## 6. `_fetch_top_winners` signature

Keep as `(brand: str, top_n: int, focus_product: Optional[str]) ->
list[dict]`. Each dict carries: `ad_id`, `name`, `spend`, `roas`,
`purchases`, `cpa`, `creative_type`, `video_url` (optional). Subset of
what `_list_creatives_impl` returns — only what the recipe prompt
needs.
