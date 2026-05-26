# Lens Fork Creative Ops Build — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fork Odylic Lens, add Analyze + Create stages to make an integrated 3-stage local creative ops tool (audit → analyze → create) that replaces dose-creative for DOSE OF / Vital Botanics / Odder Me.

**Architecture:** Add two new FastAPI route modules (`analyze_endpoints.py`, `generate_endpoints.py`) + two new React pages (`Analyze.tsx`, `Create.tsx`). Analyze routes through Claude Code subprocess (uses Nico's Max subscription, $0 marginal). Create routes through fal.ai SDK. Audit tagging unchanged (existing Haiku via Anthropic API). All data persists in existing Lens SQLite + new `drafts/` directory.

**Tech Stack:** Python 3.12 / FastAPI / SQLite / Vite / React / TypeScript / Anthropic SDK (existing) / fal-client (new) / ffmpeg-python (new) / Claude Code CLI subprocess.

**Companion docs:**
- Decision: `dose-playbook/techstack/Odylic Lens fork replaces dose-creative as single creative ops tool.md`
- Build context: `dose-playbook/techstack/2026-05-25-lens-fork-build-plan.md`
- Deferred work: `~/odylic-lens/TODOS.md`

---

## Plan review decisions (2026-05-25, via /plan-exit-review)

All 16 review decisions applied. Implementation snippets below assume these. Where a snippet still shows the pre-review code, the bullet here is the source of truth.

### Architecture
- **1A** — Single unified `claude_client.py` with routing strategy. `route_call(strategy: 'api' | 'subprocess', ...)`. Audit tagging uses `'api'`, Analyze uses `'subprocess'`. Future Gemini/Qwen plugs in as new strategy.
- **2D** — Frame extraction runs concurrent via `asyncio.to_thread`. 10 videos × ~12s = ~12s total (was 2-3 min sync).
- **3C** — Single `drafts` table with status `proposed | ready | draft | launched | discarded`. Analyze writes `proposed` rows. "Send to Create" transitions to `ready`. Generate transitions to `draft`. No separate `recipes` table. No localStorage handoff.
- **4A** — `_cache_key` includes brand profile content hash. Edit Voice & Tone → cache key changes → fresh call automatically.

### Code Quality
- **5A** — Inspect Lens internals FIRST (Task 2.7.5, new prep step). Write tests against REAL signatures of `ad_analysis_endpoints` dashboard fn + `brand_profile_store` get fn. No stubs in production code.
- **6A** — Typed `ClaudeAuthExpired` exception class. Detect `auth` / `expired` / `401` substrings in stderr → raise. Frontend catches → renders "Re-authenticate" button that triggers `open -a Terminal.app` with `claude auth login` pre-filled (macOS) or surfaces command for user copy.
- **7A** — Normalize to `draft_assets` side table: `(asset_id PK, draft_id FK, variant_idx, path, mime_type, fal_model_used, cost_usd, created_at)`. Drafts row no longer holds JSON path array. Per-variant discard supported.
- **8A** — Add explicit Task 2.9.5: smoke-test stubs against mocked data → commit "wip: stubs work, real wiring next" → THEN do Task 2.10 wiring. Separates architecture validation from integration.

### Tests
- **9A** — Add tests for the 3 critical gaps: `extract_frames` ffmpeg-failure path, `_download_asset` mid-variant failure path, `_build_prompt` content-correctness snapshot.
- **10A** — Vitest setup + 4-6 frontend tests covering: Analyze tab render with recipes, Generate button click → fetch mock, re-auth button display on `ClaudeAuthExpired`, Create tab pending list, per-variant discard, drafts gallery brand filter.
- **11A** — Golden-set eval suite: 5 Vital + 5 DOSE hand-picked winners with expected recipe shape (angle in {Benefits, Lifestyle, …}, persona contains brand audience, hook in Spanish for Spanish brands). Loose-match assertions + structural checks. Pinned at v1 ship; future prompt edits must hold ≥80% pass rate.
- **12A** — Add tests for: `ClaudeAuthExpired` detection from stderr patterns, `POST /api/recipes/<id>/promote` endpoint, cache invalidation on profile-hash change.

### Performance
- **13A** — `_list_drafts` adds `LIMIT 50` default + cursor pagination via `?after=<created_at>`. Frontend gallery uses infinite scroll.
- **14A** — Wrap multi-row inserts in `BEGIN IMMEDIATE / COMMIT` transaction. All-or-nothing semantics for analyze→drafts and generate→draft_assets.
- **15A** — Replace `urllib.request.urlretrieve` with `requests.get(stream=True)` + `iter_content(chunk_size=8192)` writing to disk. No memory spike on 50-100MB video assets.
- **16A** — `DELETE /api/drafts/<id>` (full delete) AND `DELETE /api/draft_assets/<id>` (per-variant) also remove files from disk. `shutil.rmtree` for full delete (brand/recipe_id dir), `os.remove` for per-variant.

### Image gen routing (added 2026-05-25 post-review)
- **Image generation** → **Manual via ChatGPT Pro subscription (unlimited GPT Image 2.0)** + drag-drop into Lens drafts gallery. Verified Codex CLI does NOT expose image gen (CLI version 0.133.0 inspected — `--image` is input-only, MCP plugins still need their own OpenAI API key). Fork inherits subscription cost benefit via manual handoff, not subprocess.
- **Video generation** → fal.ai SDK exclusively (Kling, Veo, Hunyuan). Sora (Pro plan) deferred until Sora API surfaces or browser-automation viability tested.
- **New endpoint:** `POST /api/drafts/upload` — multipart file + recipe_id → saves to `~/.odylic-lens/drafts/<brand>/<recipe_id>/<idx>.<ext>` + inserts `drafts` row with `fal_model='manual_upload'`. Mirrors auto-gen path's storage layout so gallery treats both identically.
- **Recipe card actions:** Two buttons replace the single "Generate" button: **"Copy prompt → ChatGPT"** (image, default) + **"Generate video"** (fal.ai, when `format='video'`).
- **Cost impact:** Phase 3 first batch drops from $10-30 → **~$3-10** (video only). Steady state $4-20/mo → **~$2-10/mo**. Images = $0 (subscription).

### Updated file count after review (+3 modules)
- `claude_client.py` (replaces both `ad_analysis_endpoints` Anthropic SDK use AND `claude_code_client.py` from original plan)
- `analyze_endpoints.py` (unchanged from original, with 1A + 2D + 3C + 4A + 14A applied)
- `frame_extractor.py` + concurrent helper (unchanged + 2D)
- `fal_client_wrapper.py` (unchanged)
- `generate_endpoints.py` (with 3C + 7A + 13A + 14A + 15A + 16A applied)
- `drafts_endpoints.py` (NEW — separates draft/asset lifecycle endpoints from generate, includes promote + per-variant discard)
- `tests/test_claude_client.py` (replaces test_claude_code_client, adds api + subprocess + routing tests)
- `tests/test_analyze_endpoints.py` (with profile-hash cache + promote tests)
- `tests/test_drafts_endpoints.py` (NEW — covers promote + per-variant)
- `tests/test_generate_endpoints.py` (with draft_assets + streaming download tests)
- `tests/test_frame_extractor.py` (with concurrent + ffmpeg-failure tests)
- `tests/test_fal_client.py` (unchanged)
- `tests/evals/test_build_prompt_eval.py` (NEW — golden-set)
- `web/src/pages/Analyze.tsx` (+ re-auth button)
- `web/src/pages/Create.tsx` (+ per-variant discard)
- `web/tests/*.test.tsx` (NEW — Vitest, 4-6 tests)

**Revised estimate:** 4-6 days (was 3-5). Extra ~1 day for: Vitest setup + frontend tests (10A), golden-set eval (11A), draft_assets normalization (7A), streaming download (15A), unified claude_client refactor of audit tagging (1A).

**Revised cost estimate:** unchanged ($11-33 first month, $4-23/mo steady) — review decisions don't change vendor routing.

---

## Pre-flight checks (do once before Phase 2)

### Check 0.1: Confirm Phase 0 state

Run:
```bash
lens status
```

Expected: `api: running (pid XXX)` and `port 8765: pid XXX`

If not running: `lens start`

### Check 0.2: Confirm Claude Code authenticated

Run:
```bash
claude --version
claude auth status
```

Expected: version printed + "Logged in as nico@takeadoseof.com" (or your account email)

If not authenticated: `claude auth login` and complete browser flow

### Check 0.3: Confirm Anthropic API key in Lens .env

Run:
```bash
grep ANTHROPIC_API_KEY /Users/nico/odylic-lens/.env
```

Expected: `ANTHROPIC_API_KEY=sk-ant-...` line present

If missing: get one at https://console.anthropic.com/settings/keys, paste into `.env`, `lens restart`

### Check 0.4: Confirm fal.ai key

Run:
```bash
grep FAL_KEY /Users/nico/odylic-lens/.env
```

If missing: get one at https://fal.ai/dashboard/keys, paste into `.env` as `FAL_KEY=...`

### Check 0.5: Confirm ffmpeg installed

Run:
```bash
ffmpeg -version
```

Expected: version banner

If missing: `brew install ffmpeg`

---

## Phase 1: Brand Settings (operational, ~1 day)

**Not a code phase.** Click through Brand Settings UI for each brand. No tests, no commits.

### Task 1.1: Configure DOSE OF (Bliss Ventures Read-Only)

**Steps:**

1. Open http://localhost:8765
2. Click brand circle in left rail → popover opens
3. Click gear icon on the row for **Bliss Ventures (Read-Only)** → Brand Settings opens scoped to DOSE
4. Click **Deep profile** (top right). Wait 30-60s. Costs ~$0.10.
5. Review auto-fill. **Critical fix:** "Modern heirlooms" Brand Essence is wrong — replace with something true to DOSE (e.g., "Wellness rituals for the woman over 45")
6. Fill **Products** section manually: Mushroom Coffee, Calm Cacao, Collagen Creamer — one row per SKU with description, USP, target sub-audience
7. Fill **Ad Naming** section: token convention you actually use (look at your live ad names for patterns)
8. Fill **Planner Taxonomy**: funnel positions (Top/Mid/Bottom), angles (Benefits, Lifestyle, Ingredientes, Us-vs-them), market awareness levels
9. Fill **Audience**: 45+ MX women, sub-segments per product
10. Fill **Voice & Tone**: Spanish MX, warm, founder
11. Fill **Compliance**: forbidden claims (no diabetes, no cura, no medical claims unapproved by COFEPRIS)
12. Save (auto-saves on blur)

**Validation:**

- Switch to Creative Analysis tab → click Refresh
- Spot-check 3 recent DOSE ads — tags should reference YOUR products, YOUR angles, YOUR funnel positions
- Filter by Product → ads group correctly

### Task 1.2: Configure Vital Botanics

Repeat Task 1.1 steps 2-12 for **Vital Botanics** brand. Vital-specific differences:
- Products: Testo Booster, women's line, etc.
- Audience: 67% M / 33% F per your handoff doc, sub-segments per product
- Voice: Vital brand voice (may differ from DOSE warmth)
- Compliance: same medical claim restrictions

### Task 1.3: Configure Odder Me

Same pattern for **Odder Me** brand.

### Phase 1 exit criteria

- [ ] All three brands have completed Brand Settings sections (Identity, Products, Ad Naming, Planner Taxonomy, Audience, Voice & Tone, Compliance minimum)
- [ ] Filter by Product works correctly per brand
- [ ] Group By dropdowns show your actual token values

### Phase 1 commit

```bash
# No code changes — Brand Settings persists in ~/.odylic-lens/brand_profile.json
# Backup the brand profiles to dose-playbook vault
cp ~/.odylic-lens/brand_profile.json "/Users/nico/Library/Mobile Documents/iCloud~md~obsidian/Documents/dose-playbook/techstack/odylic-lens-brand-profiles-backup-$(date +%Y-%m-%d).json"
```

---

## Phase 2: Fork + Analyze stage (~1-2 days, TDD)

### Task 2.1: Fork the repo on GitHub

**Steps:**

1. Browser: open https://github.com/peterquads/odylic-lens
2. Click **Fork** (top right)
3. Owner: your GitHub user, name: `odylic-lens`, leave description unchanged
4. Click **Create fork**

Expected: fork lives at `https://github.com/<your-user>/odylic-lens`

### Task 2.2: Retarget local repo to your fork

**Files:**
- Modify: `/Users/nico/odylic-lens/.git/config` (via git remote commands)
- Modify: `/Users/nico/odylic-lens/.env`

**Step 1: Set origin to your fork**

```bash
cd /Users/nico/odylic-lens
git remote set-url origin git@github.com:<your-user>/odylic-lens.git
```

**Step 2: Add upstream remote for syncing future Peter updates**

```bash
git remote add upstream https://github.com/peterquads/odylic-lens.git
```

**Step 3: Verify remotes**

```bash
git remote -v
```

Expected output:
```
origin    git@github.com:<your-user>/odylic-lens.git (fetch)
origin    git@github.com:<your-user>/odylic-lens.git (push)
upstream  https://github.com/peterquads/odylic-lens.git (fetch)
upstream  https://github.com/peterquads/odylic-lens.git (push)
```

**Step 4: Update LENS_UPDATE_REPO in .env**

Edit `/Users/nico/odylic-lens/.env`:
- Add line: `LENS_UPDATE_REPO=<your-user>/odylic-lens`

**Step 5: Create feature branch**

```bash
git checkout -b feat/analyze-stage
```

**Step 6: Confirm push works**

```bash
git push -u origin feat/analyze-stage
```

Expected: branch created on your fork

**Step 7: Commit (.env change)**

```bash
git add .env
git commit -m "chore: retarget LENS_UPDATE_REPO to fork"
git push
```

### Task 2.3: Add pytest + dependencies

**Files:**
- Modify: `/Users/nico/odylic-lens/api/pyproject.toml`

**Step 1: Activate venv**

```bash
cd /Users/nico/odylic-lens/api
source venv/bin/activate
```

**Step 2: Install new deps**

```bash
pip install pytest ffmpeg-python fal-client
```

**Step 3: Update pyproject.toml**

Add to `[project.optional-dependencies]` block (or `[project.dependencies]` if no optional section exists):

```toml
[project.optional-dependencies]
dev = ["pytest>=8.0", "pytest-asyncio>=0.23"]

[project.dependencies]
# ... existing deps ...
ffmpeg-python = ">=0.2.0"
fal-client = ">=0.5.0"
```

**Step 4: Verify**

```bash
pytest --version
python -c "import ffmpeg; import fal_client; print('ok')"
```

Expected: pytest 8.x banner + `ok`

**Step 5: Commit**

```bash
git add api/pyproject.toml
git commit -m "feat: add pytest + ffmpeg + fal-client dependencies"
git push
```

### Task 2.4: Test scaffold — claude_code_client (TDD)

**Files:**
- Create: `/Users/nico/odylic-lens/api/tests/__init__.py` (empty)
- Create: `/Users/nico/odylic-lens/api/tests/test_claude_code_client.py`
- Create: `/Users/nico/odylic-lens/api/claude_code_client.py` (later step)

**Step 1: Create test directory + empty __init__.py**

```bash
cd /Users/nico/odylic-lens/api
mkdir -p tests
touch tests/__init__.py
```

**Step 2: Write the failing test**

Create `/Users/nico/odylic-lens/api/tests/test_claude_code_client.py`:

```python
"""Tests for Claude Code subprocess wrapper."""
from __future__ import annotations
import pytest
from unittest.mock import patch, MagicMock


def test_call_claude_code_returns_parsed_json():
    """call_claude_code returns dict parsed from claude CLI JSON output."""
    from claude_code_client import call_claude_code

    fake_stdout = '{"angle": "Benefits", "hook": "Test hook"}'
    fake_result = MagicMock(returncode=0, stdout=fake_stdout, stderr="")

    with patch("subprocess.run", return_value=fake_result) as mock_run:
        result = call_claude_code("test prompt")

    assert result == {"angle": "Benefits", "hook": "Test hook"}
    mock_run.assert_called_once()


def test_call_claude_code_with_frames_passes_image_flag():
    """When frames provided, --image flag added once per frame path."""
    from claude_code_client import call_claude_code

    fake_result = MagicMock(returncode=0, stdout='{}', stderr="")

    with patch("subprocess.run", return_value=fake_result) as mock_run:
        call_claude_code("prompt", frames=["/tmp/a.jpg", "/tmp/b.jpg"])

    args = mock_run.call_args[0][0]
    assert args.count("--image") == 2
    assert "/tmp/a.jpg" in args
    assert "/tmp/b.jpg" in args


def test_call_claude_code_raises_on_nonzero_exit():
    """Subprocess failure surfaces as RuntimeError with stderr."""
    from claude_code_client import call_claude_code

    fake_result = MagicMock(returncode=1, stdout="", stderr="auth expired")

    with patch("subprocess.run", return_value=fake_result):
        with pytest.raises(RuntimeError, match="auth expired"):
            call_claude_code("prompt")


def test_call_claude_code_strips_wrap_text_before_json():
    """Claude Code sometimes wraps JSON in prose — wrapper finds the JSON block."""
    from claude_code_client import call_claude_code

    wrapped = 'Sure, here is the JSON: {"angle": "Benefits"} hope that helps!'
    fake_result = MagicMock(returncode=0, stdout=wrapped, stderr="")

    with patch("subprocess.run", return_value=fake_result):
        result = call_claude_code("prompt")

    assert result == {"angle": "Benefits"}
```

**Step 3: Run tests — they should fail (module not yet created)**

```bash
cd /Users/nico/odylic-lens/api
source venv/bin/activate
pytest tests/test_claude_code_client.py -v
```

Expected: `ModuleNotFoundError: No module named 'claude_code_client'` × 4

### Task 2.5: Implement claude_code_client.py (TDD green pass)

**Files:**
- Create: `/Users/nico/odylic-lens/api/claude_code_client.py`

**Step 1: Write minimal implementation**

Create `/Users/nico/odylic-lens/api/claude_code_client.py`:

```python
"""Wrap Claude Code CLI as a subprocess for the Analyze stage.

Uses Nico's Max subscription via the `claude` CLI on PATH. Latency is
3-5s per call vs ~200ms for direct Anthropic API, acceptable for low-
volume Analyze runs (~20-50 calls/month). Caller passes prompt + optional
frame paths; we surface parsed JSON or raise on failure.
"""
from __future__ import annotations
import subprocess
import json
import re
from typing import Optional


JSON_BLOCK_RE = re.compile(r'\{.*\}', re.DOTALL)


def call_claude_code(
    prompt: str,
    frames: Optional[list[str]] = None,
    timeout: int = 120,
) -> dict:
    """Invoke `claude -p` with --output-format=json. Return parsed dict.

    Raises RuntimeError if subprocess exits non-zero.
    Raises ValueError if output can't be parsed as JSON.
    """
    args = ["claude", "-p", prompt, "--output-format=json"]
    for path in (frames or []):
        args.extend(["--image", path])

    result = subprocess.run(args, capture_output=True, timeout=timeout, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"claude exit {result.returncode}: {result.stderr.strip()}")

    stdout = result.stdout.strip()
    # Try direct parse first
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        # Claude Code sometimes wraps JSON in prose. Find the first {…} block.
        match = JSON_BLOCK_RE.search(stdout)
        if not match:
            raise ValueError(f"no JSON block in claude output: {stdout[:200]}")
        return json.loads(match.group(0))
```

**Step 2: Run tests**

```bash
pytest tests/test_claude_code_client.py -v
```

Expected: 4 passed

**Step 3: Commit**

```bash
git add api/claude_code_client.py api/tests/__init__.py api/tests/test_claude_code_client.py
git commit -m "feat: Claude Code subprocess wrapper for Analyze stage"
git push
```

### Task 2.6: Test scaffold — frame_extractor (TDD)

**Files:**
- Create: `/Users/nico/odylic-lens/api/tests/test_frame_extractor.py`
- Create: `/Users/nico/odylic-lens/api/frame_extractor.py` (next task)

**Step 1: Write the failing test**

Create `/Users/nico/odylic-lens/api/tests/test_frame_extractor.py`:

```python
"""Tests for ffmpeg-based frame extraction from ad video URLs."""
from __future__ import annotations
import pytest
from unittest.mock import patch, MagicMock
from pathlib import Path


def test_extract_frames_returns_paths(tmp_path):
    """Extracts N frames to temp dir, returns list of file paths."""
    from frame_extractor import extract_frames

    # Mock ffmpeg.input chain to avoid real video processing
    with patch("frame_extractor._run_ffmpeg") as mock_ff:
        # Simulate ffmpeg writing 8 jpgs to tmp_path
        for i in range(8):
            (tmp_path / f"frame_{i:03d}.jpg").write_bytes(b"fake")

        paths = extract_frames(
            video_url="https://example.com/ad.mp4",
            n_frames=8,
            output_dir=tmp_path,
        )

    assert len(paths) == 8
    assert all(Path(p).exists() for p in paths)
    mock_ff.assert_called_once()


def test_extract_frames_skips_videos_over_60_seconds(tmp_path):
    """Cost-cap: skip videos longer than 60s to avoid frame extraction blow-up."""
    from frame_extractor import extract_frames

    with patch("frame_extractor._probe_duration", return_value=120.5):
        paths = extract_frames(
            video_url="https://example.com/long.mp4",
            n_frames=8,
            output_dir=tmp_path,
            max_duration=60,
        )

    assert paths == []


def test_extract_frames_caps_n_at_12(tmp_path):
    """n_frames > 12 clamped to 12 (token-cost guard)."""
    from frame_extractor import extract_frames

    with patch("frame_extractor._probe_duration", return_value=30):
        with patch("frame_extractor._run_ffmpeg") as mock_ff:
            for i in range(12):
                (tmp_path / f"frame_{i:03d}.jpg").write_bytes(b"fake")

            paths = extract_frames(
                video_url="https://example.com/ad.mp4",
                n_frames=50,
                output_dir=tmp_path,
            )

    assert len(paths) == 12
```

**Step 2: Run tests — should fail (module missing)**

```bash
pytest tests/test_frame_extractor.py -v
```

Expected: `ModuleNotFoundError: No module named 'frame_extractor'` × 3

### Task 2.7: Implement frame_extractor.py (TDD green pass)

**Files:**
- Create: `/Users/nico/odylic-lens/api/frame_extractor.py`

**Step 1: Write minimal implementation**

Create `/Users/nico/odylic-lens/api/frame_extractor.py`:

```python
"""Extract evenly-spaced frames from a video URL using ffmpeg.

Used by the Analyze stage to feed video ads to Claude vision (which
accepts images, not video). Frame count capped at 12 to control token
cost; videos > 60s skipped by default.
"""
from __future__ import annotations
import subprocess
import json
from pathlib import Path
from typing import Optional


MAX_FRAMES = 12


def _probe_duration(video_url: str) -> float:
    """Return video duration in seconds via ffprobe."""
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "json", video_url],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        return 0.0
    try:
        return float(json.loads(result.stdout)["format"]["duration"])
    except (json.JSONDecodeError, KeyError, ValueError):
        return 0.0


def _run_ffmpeg(video_url: str, output_pattern: str, fps: float, n_frames: int):
    """Run ffmpeg to extract n_frames evenly spaced. Returns nothing."""
    subprocess.run(
        ["ffmpeg", "-y", "-i", video_url,
         "-vf", f"fps={fps}", "-frames:v", str(n_frames),
         "-q:v", "2", output_pattern],
        capture_output=True, timeout=120, check=False,
    )


def extract_frames(
    video_url: str,
    n_frames: int = 8,
    output_dir: Optional[Path] = None,
    max_duration: int = 60,
) -> list[str]:
    """Extract n_frames evenly-spaced frames from video_url.

    Returns list of frame file paths. Returns empty list if:
    - Video duration exceeds max_duration
    - ffmpeg fails
    n_frames clamped to MAX_FRAMES.
    """
    n_frames = min(n_frames, MAX_FRAMES)
    duration = _probe_duration(video_url)
    if duration > max_duration:
        return []

    out_dir = Path(output_dir) if output_dir else Path("/tmp")
    out_dir.mkdir(parents=True, exist_ok=True)
    pattern = str(out_dir / "frame_%03d.jpg")

    fps = n_frames / duration if duration > 0 else 1.0
    _run_ffmpeg(video_url, pattern, fps, n_frames)

    frames = sorted(out_dir.glob("frame_*.jpg"))
    return [str(p) for p in frames[:n_frames]]
```

**Step 2: Run tests**

```bash
pytest tests/test_frame_extractor.py -v
```

Expected: 3 passed

**Step 3: Commit**

```bash
git add api/frame_extractor.py api/tests/test_frame_extractor.py
git commit -m "feat: ffmpeg frame extractor for video ad analysis"
git push
```

### Task 2.8: Test scaffold — analyze_endpoints (TDD)

**Files:**
- Create: `/Users/nico/odylic-lens/api/tests/test_analyze_endpoints.py`
- Create: `/Users/nico/odylic-lens/api/analyze_endpoints.py` (next task)

**Step 1: Write the failing test**

Create `/Users/nico/odylic-lens/api/tests/test_analyze_endpoints.py`:

```python
"""Tests for /api/analyze route."""
from __future__ import annotations
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    """FastAPI test client with analyze_endpoints router mounted."""
    from fastapi import FastAPI
    from analyze_endpoints import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_analyze_returns_recipe_list(client):
    """POST /api/analyze returns list of AdRecipe dicts."""
    fake_winners = [
        {"ad_id": "120", "spend": 1000, "roas": 3.0, "name": "Test ad"},
    ]
    fake_brand = {"products": ["Mushroom Coffee"], "voice": "Spanish MX"}
    fake_recipes = {
        "recipes": [
            {
                "recipe_id": "r1", "angle": "Benefits", "persona": "45+ MX women",
                "funnel_position": "mid", "hook": "Test hook",
                "copy_outline": "...", "visual_direction": "...",
                "product": "Mushroom Coffee", "format": "image",
                "fal_model_hint": "flux/dev", "rationale": "Test rationale",
                "source_winner_ids": ["120"],
            }
        ]
    }

    with patch("analyze_endpoints._fetch_top_winners", return_value=fake_winners), \
         patch("analyze_endpoints._fetch_brand_context", return_value=fake_brand), \
         patch("analyze_endpoints.call_claude_code", return_value=fake_recipes):

        response = client.post("/api/analyze", json={
            "brand": "DOSE OF",
            "top_n_winners": 1,
            "n_recipes": 1,
        })

    assert response.status_code == 200
    body = response.json()
    assert len(body["recipes"]) == 1
    assert body["recipes"][0]["angle"] == "Benefits"
    assert body["recipes"][0]["product"] == "Mushroom Coffee"


def test_analyze_caches_within_24h(client):
    """Second call with same brand/winners hash returns cached result."""
    fake_winners = [{"ad_id": "120", "spend": 1000, "roas": 3.0, "name": "Test"}]
    fake_recipes = {"recipes": [{"recipe_id": "r1", "angle": "Benefits"}]}

    with patch("analyze_endpoints._fetch_top_winners", return_value=fake_winners), \
         patch("analyze_endpoints._fetch_brand_context", return_value={}), \
         patch("analyze_endpoints.call_claude_code", return_value=fake_recipes) as mock_claude:

        body = {"brand": "DOSE OF", "top_n_winners": 1, "n_recipes": 1}
        client.post("/api/analyze", json=body)
        client.post("/api/analyze", json=body)  # second call

    # call_claude_code should only fire once due to cache
    assert mock_claude.call_count == 1


def test_analyze_regenerate_bypasses_cache(client):
    """regenerate=true forces a fresh claude call."""
    fake_winners = [{"ad_id": "120", "spend": 1000, "roas": 3.0, "name": "Test"}]
    fake_recipes = {"recipes": [{"recipe_id": "r1", "angle": "Benefits"}]}

    with patch("analyze_endpoints._fetch_top_winners", return_value=fake_winners), \
         patch("analyze_endpoints._fetch_brand_context", return_value={}), \
         patch("analyze_endpoints.call_claude_code", return_value=fake_recipes) as mock_claude:

        body = {"brand": "DOSE OF", "top_n_winners": 1, "n_recipes": 1}
        client.post("/api/analyze", json=body)
        client.post("/api/analyze", json={**body, "regenerate": True})

    assert mock_claude.call_count == 2


def test_analyze_includes_video_frames_when_winner_is_video(client):
    """For video winners, frames extracted and passed to claude."""
    fake_winners = [
        {"ad_id": "120", "spend": 1000, "roas": 3.0, "name": "Vid",
         "video_url": "https://example.com/ad.mp4"},
    ]

    with patch("analyze_endpoints._fetch_top_winners", return_value=fake_winners), \
         patch("analyze_endpoints._fetch_brand_context", return_value={}), \
         patch("analyze_endpoints.extract_frames", return_value=["/tmp/f1.jpg", "/tmp/f2.jpg"]) as mock_ex, \
         patch("analyze_endpoints.call_claude_code", return_value={"recipes": []}) as mock_claude:

        client.post("/api/analyze", json={
            "brand": "DOSE OF", "top_n_winners": 1, "n_recipes": 1,
            "include_video_frames": True,
        })

    mock_ex.assert_called_once()
    # claude called with frames list
    assert mock_claude.call_args.kwargs.get("frames") is not None
```

**Step 2: Run tests — should fail (module missing)**

```bash
pytest tests/test_analyze_endpoints.py -v
```

Expected: `ModuleNotFoundError: No module named 'analyze_endpoints'` × 4

### Task 2.9: Implement analyze_endpoints.py (TDD green pass)

**Files:**
- Create: `/Users/nico/odylic-lens/api/analyze_endpoints.py`

**Step 1: Write minimal implementation**

Create `/Users/nico/odylic-lens/api/analyze_endpoints.py`:

```python
"""Analyze endpoint: top winners + brand context → AdRecipe recommendations.

Routes to Claude Code subprocess (Nico's Max subscription, $0 marginal).
Caches results 24h by (brand, winner_ids_hash, n_recipes).
"""
from __future__ import annotations
import hashlib
import json
import tempfile
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from claude_code_client import call_claude_code
from frame_extractor import extract_frames


router = APIRouter()

# In-memory cache: { hash: (timestamp, result) }
_CACHE: dict[str, tuple[float, dict]] = {}
CACHE_TTL_SECONDS = 24 * 3600


class AnalyzeRequest(BaseModel):
    brand: str
    top_n_winners: int = 10
    focus_product: Optional[str] = None
    n_recipes: int = 5
    include_video_frames: bool = True
    regenerate: bool = False


def _fetch_top_winners(brand: str, top_n: int, focus_product: Optional[str]) -> list[dict]:
    """Pull top N winners from Lens's existing dashboard endpoint logic.

    TODO Phase 2.10: replace stub with real call to ad_analysis_endpoints
    or shared service. For now, returns empty list — tests stub this out.
    """
    return []


def _fetch_brand_context(brand: str) -> dict:
    """Load brand profile from Lens's brand_profile_store.

    TODO Phase 2.10: wire to brand_profile_store.get_profile(brand).
    """
    return {}


def _cache_key(brand: str, winners: list[dict], n_recipes: int) -> str:
    """Stable hash for (brand, winner ids, n_recipes)."""
    ids = sorted(w["ad_id"] for w in winners)
    payload = json.dumps({"brand": brand, "ids": ids, "n": n_recipes}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _build_prompt(brand_ctx: dict, winners: list[dict], n_recipes: int) -> str:
    """Compose system + user prompt as a single string for Claude Code."""
    parts = [
        "You are a creative strategist for the brand below.",
        "Brand context:",
        json.dumps(brand_ctx, ensure_ascii=False, indent=2),
        "",
        "Top winning ads (audit data):",
        json.dumps(winners, ensure_ascii=False, indent=2),
        "",
        f"Recommend {n_recipes} new ad concepts that build on the patterns",
        "in the winners but explore fresh angles. Return JSON with shape:",
        '{ "recipes": [ { "recipe_id": "uuid", "angle": "...", "persona": "...",',
        '"funnel_position": "top|mid|bottom", "hook": "...", "copy_outline": "...",',
        '"visual_direction": "...", "product": "...", "format": "image|video|carousel",',
        '"fal_model_hint": "flux/dev or similar", "rationale": "why this concept",',
        '"source_winner_ids": ["..."] } ] }',
    ]
    return "\n".join(parts)


@router.post("/api/analyze")
def analyze(req: AnalyzeRequest) -> dict:
    """Generate AdRecipe recommendations for brand from top winners."""
    winners = _fetch_top_winners(req.brand, req.top_n_winners, req.focus_product)
    brand_ctx = _fetch_brand_context(req.brand)

    cache_key = _cache_key(req.brand, winners, req.n_recipes)
    now = time.time()
    if not req.regenerate and cache_key in _CACHE:
        ts, cached = _CACHE[cache_key]
        if now - ts < CACHE_TTL_SECONDS:
            return cached

    # Extract frames for any video winners
    frames: list[str] = []
    if req.include_video_frames:
        with tempfile.TemporaryDirectory() as tmp:
            for w in winners:
                video_url = w.get("video_url")
                if video_url:
                    frames.extend(extract_frames(
                        video_url, n_frames=8, output_dir=Path(tmp),
                    ))

            prompt = _build_prompt(brand_ctx, winners, req.n_recipes)
            result = call_claude_code(prompt, frames=frames or None)
    else:
        prompt = _build_prompt(brand_ctx, winners, req.n_recipes)
        result = call_claude_code(prompt)

    _CACHE[cache_key] = (now, result)
    return result
```

**Step 2: Run tests**

```bash
pytest tests/test_analyze_endpoints.py -v
```

Expected: 4 passed

**Step 3: Commit**

```bash
git add api/analyze_endpoints.py api/tests/test_analyze_endpoints.py
git commit -m "feat: /api/analyze endpoint with cache + frame extraction"
git push
```

### Task 2.10: Wire _fetch_top_winners + _fetch_brand_context to real Lens data

**Files:**
- Modify: `/Users/nico/odylic-lens/api/analyze_endpoints.py`

**Step 1: Inspect existing dashboard endpoint to find call signature**

Run:
```bash
grep -n "def.*dashboard\|@router.*dashboard" /Users/nico/odylic-lens/api/ad_analysis_endpoints.py | head -5
```

Note the function name + signature for direct import (avoids HTTP loopback overhead).

**Step 2: Inspect brand_profile_store API**

Run:
```bash
grep -n "def " /Users/nico/odylic-lens/api/brand_profile_store.py
```

Find the read function (likely `get_profile` or `load`).

**Step 3: Update _fetch_top_winners and _fetch_brand_context with real wiring**

Replace the stub functions in `analyze_endpoints.py` (use the function/signature you found):

```python
from ad_analysis_endpoints import <dashboard_function>  # adjust import
from brand_profile_store import <profile_function>     # adjust import
from datetime import date, timedelta


def _fetch_top_winners(brand: str, top_n: int, focus_product: Optional[str]) -> list[dict]:
    end = date.today()
    start = end - timedelta(days=90)
    dash = <dashboard_function>(brand=brand, start=start.isoformat(), end=end.isoformat(), limit=120)
    ads = dash.get("ads", [])
    if focus_product:
        ads = [a for a in ads if focus_product.lower() in (a.get("product") or "").lower()]
    # Weighted score: spend × ROAS / cost-per-purchase (avoid div-by-zero)
    def score(a):
        cpa = a.get("cost_per_purchase") or 1
        return (a.get("spend", 0) * a.get("roas", 0)) / max(cpa, 1)
    ads_sorted = sorted(ads, key=score, reverse=True)
    return ads_sorted[:top_n]


def _fetch_brand_context(brand: str) -> dict:
    profile = <profile_function>(brand)
    # Strip noisy / irrelevant fields to keep prompt tight
    return {
        "essence": profile.get("brand_essence"),
        "values": profile.get("brand_values"),
        "audience": profile.get("audience"),
        "voice": profile.get("voice_tone"),
        "products": profile.get("products"),
        "taxonomy": profile.get("planner_taxonomy"),
        "compliance": profile.get("compliance"),
    }
```

**Step 4: Run tests to verify they still pass** (tests mock these functions)

```bash
pytest tests/test_analyze_endpoints.py -v
```

Expected: 4 passed (tests patch these functions, so refactor doesn't break them)

**Step 5: Manual smoke test with real data**

Restart Lens and POST to analyze:

```bash
lens restart
sleep 3
curl -X POST http://localhost:8765/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"brand": "Vital Botanics", "top_n_winners": 5, "n_recipes": 2, "include_video_frames": false}' \
  | python3 -m json.tool
```

Expected: JSON with `recipes` array of 2 items, each with brand-specific angle/product fields.

**Step 6: Commit**

```bash
git add api/analyze_endpoints.py
git commit -m "feat: wire analyze to real Lens dashboard + brand profile"
git push
```

### Task 2.11: Register analyze_endpoints router in main.py

**Files:**
- Modify: `/Users/nico/odylic-lens/api/main.py`

**Step 1: Add import + router registration**

In `main.py`, find the block of `from X import router as Y_router` lines. Add:

```python
from analyze_endpoints import router as analyze_router
```

Find the block of `app.include_router(X)` lines. Add:

```python
app.include_router(analyze_router)
```

**Step 2: Restart Lens and verify endpoint is live**

```bash
lens restart
sleep 3
curl -X POST http://localhost:8765/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"brand": "Vital Botanics", "top_n_winners": 3, "n_recipes": 1, "include_video_frames": false}' \
  | python3 -m json.tool
```

Expected: JSON response with at least 1 recipe

**Step 3: Commit**

```bash
git add api/main.py
git commit -m "feat: register analyze_router in main"
git push
```

### Task 2.12: Build Analyze tab UI (React)

**Files:**
- Create: `/Users/nico/odylic-lens/web/src/pages/Analyze.tsx`
- Modify: `/Users/nico/odylic-lens/web/src/App.tsx`

**Step 1: Inspect App.tsx tab pattern**

```bash
grep -n "activeTab\|Tab\|tabs" /Users/nico/odylic-lens/web/src/App.tsx | head -20
```

Note how existing tabs are registered (the `Tab` type + tabs array around line 49-120 I saw earlier).

**Step 2: Create Analyze.tsx**

Create `/Users/nico/odylic-lens/web/src/pages/Analyze.tsx`:

```tsx
import { useState } from 'react'
import { Sparkles, RefreshCw } from 'lucide-react'

type AdRecipe = {
  recipe_id: string
  angle: string
  persona: string
  funnel_position: 'top' | 'mid' | 'bottom'
  hook: string
  copy_outline: string
  visual_direction: string
  product: string
  format: 'image' | 'video' | 'carousel'
  fal_model_hint: string
  rationale: string
  source_winner_ids: string[]
}

type Props = {
  brand: string
}

export function Analyze({ brand }: Props) {
  const [recipes, setRecipes] = useState<AdRecipe[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nWinners, setNWinners] = useState(10)
  const [nRecipes, setNRecipes] = useState(5)

  const run = async (regenerate = false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand,
          top_n_winners: nWinners,
          n_recipes: nRecipes,
          include_video_frames: true,
          regenerate,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setRecipes(data.recipes || [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-medium">Analyze — {brand}</h1>
        <button
          onClick={() => run(false)}
          disabled={loading}
          className="px-3 py-1.5 bg-black text-white rounded-md flex items-center gap-2 text-sm disabled:opacity-50"
        >
          <Sparkles size={14} />
          {loading ? 'Thinking…' : 'Generate recommendations'}
        </button>
        {recipes.length > 0 && (
          <button
            onClick={() => run(true)}
            disabled={loading}
            className="px-3 py-1.5 border rounded-md flex items-center gap-2 text-sm"
          >
            <RefreshCw size={14} />
            Regenerate
          </button>
        )}
      </div>

      <div className="flex gap-3 mb-6 text-sm">
        <label>
          Top winners:
          <input
            type="number"
            value={nWinners}
            onChange={e => setNWinners(parseInt(e.target.value) || 10)}
            min={1}
            max={30}
            className="ml-2 w-16 px-2 py-1 border rounded"
          />
        </label>
        <label>
          Recipes:
          <input
            type="number"
            value={nRecipes}
            onChange={e => setNRecipes(parseInt(e.target.value) || 5)}
            min={1}
            max={20}
            className="ml-2 w-16 px-2 py-1 border rounded"
          />
        </label>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-2 rounded mb-4 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {recipes.map(r => (
          <div key={r.recipe_id} className="border rounded-lg p-4">
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-xs uppercase tracking-wide bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                {r.angle}
              </span>
              <span className="text-xs uppercase tracking-wide bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                {r.funnel_position}
              </span>
              <span className="text-xs text-gray-500">{r.product}</span>
            </div>
            <h3 className="text-lg font-medium mb-1">{r.hook}</h3>
            <p className="text-sm text-gray-700 mb-2">{r.copy_outline}</p>
            <p className="text-xs text-gray-500 italic mb-3">{r.rationale}</p>
            <div className="flex gap-2 text-xs">
              <button className="px-2 py-1 border rounded">Send to Create</button>
              <button className="px-2 py-1 border rounded">Discard</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

**Step 3: Wire Analyze tab into App.tsx**

In `App.tsx`:

1. Add lazy import near the other lazy imports:
```tsx
const Analyze = lazy(() =>
  import('./pages/Analyze').then(m => ({ default: m.Analyze }))
)
```

2. Update the Tab type:
```tsx
type Tab = 'creatives' | 'analyze' | 'brand' | 'settings'
```

3. Add the tab to the tabs array (next to creatives):
```tsx
{ k: 'analyze' as const, icon: Sparkles, title: 'Analyze' }
```

4. Add the render block (next to the existing tab render):
```tsx
{activeTab === 'analyze' && (
  <Suspense fallback={<div>Loading…</div>}>
    <Analyze brand={primaryBrand || ''} />
  </Suspense>
)}
```

5. Import `Sparkles` from lucide-react if not already imported.

**Step 4: Rebuild web bundle**

```bash
cd /Users/nico/odylic-lens/web
npm run build
```

Expected: no errors, dist/ updated

**Step 5: Restart Lens + smoke test in browser**

```bash
lens restart
open http://localhost:8765
```

In browser:
- Switch to Vital Botanics brand
- Click Analyze tab
- Click "Generate recommendations"
- Wait ~10-30s
- Confirm 5 recipes appear with Vital-specific angles + Spanish hooks

**Step 6: Commit**

```bash
git add web/src/pages/Analyze.tsx web/src/App.tsx
git commit -m "feat: Analyze tab UI with recipe cards"
git push
```

### Phase 2 exit criteria

- [ ] All Phase 2 tests pass (`pytest tests/ -v` → 11 passed)
- [ ] `/api/analyze` returns valid AdRecipe[] for Vital Botanics
- [ ] Analyze tab visible in UI, renders recipe cards
- [ ] Recipes reference: brand products, Spanish hooks (for Spanish brands), defined angles, funnel positions
- [ ] Cache works (second click returns instantly)
- [ ] Regenerate button forces fresh call
- [ ] Video frames extracted when video winners present
- [ ] Claude Code subprocess auth still working (`claude auth status` → logged in)

### Phase 2 final commit + push to upstream branch

```bash
git checkout main
git merge --no-ff feat/analyze-stage
git push origin main
git branch -d feat/analyze-stage
```

---

## Phase 3: Create stage (~1-2 days, TDD)

### Task 3.1: Create feat/create-stage branch

```bash
cd /Users/nico/odylic-lens
git checkout -b feat/create-stage
```

### Task 3.2: SQLite migration for drafts table

**Files:**
- Modify: `/Users/nico/odylic-lens/api/store.py`

**Step 1: Inspect existing init_db pattern**

```bash
grep -n "CREATE TABLE\|init_db\|def " /Users/nico/odylic-lens/api/store.py | head -20
```

**Step 2: Add drafts table CREATE statement**

In `store.py`, find `init_db()` function. Add CREATE TABLE statement following existing pattern:

```python
cur.execute("""
    CREATE TABLE IF NOT EXISTS drafts (
        recipe_id TEXT PRIMARY KEY,
        brand TEXT NOT NULL,
        asset_paths TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'launched', 'discarded')),
        meta_ad_id TEXT,
        recipe_json TEXT NOT NULL,
        fal_model TEXT NOT NULL,
        cost_usd REAL
    )
""")
cur.execute("CREATE INDEX IF NOT EXISTS idx_drafts_brand_status ON drafts(brand, status)")
```

**Step 3: Restart Lens to apply migration**

```bash
lens restart
```

**Step 4: Verify table exists**

```bash
sqlite3 ~/.odylic-lens/lens.db ".schema drafts"
```

Expected: table schema printed

**Step 5: Commit**

```bash
git add api/store.py
git commit -m "feat: drafts table for Create stage"
git push -u origin feat/create-stage
```

### Task 3.3: Test scaffold — fal_client (TDD)

**Files:**
- Create: `/Users/nico/odylic-lens/api/tests/test_fal_client.py`
- Create: `/Users/nico/odylic-lens/api/fal_client_wrapper.py` (next task)

**Step 1: Write the failing test**

Create `/Users/nico/odylic-lens/api/tests/test_fal_client.py`:

```python
"""Tests for fal.ai client wrapper."""
from __future__ import annotations
import pytest
from unittest.mock import patch, MagicMock


def test_generate_image_returns_asset_url():
    """generate_image calls fal_client.run and returns image URL."""
    from fal_client_wrapper import generate_image

    fake_result = {"images": [{"url": "https://fal.ai/result.png"}]}

    with patch("fal_client_wrapper.fal_client.run", return_value=fake_result) as mock_run:
        result = generate_image(
            prompt="A bowl of mushroom coffee",
            model_id="fal-ai/flux/dev",
        )

    assert result["url"] == "https://fal.ai/result.png"
    mock_run.assert_called_once()
    call_args = mock_run.call_args
    assert call_args.args[0] == "fal-ai/flux/dev"
    assert "mushroom coffee" in call_args.kwargs["arguments"]["prompt"]


def test_generate_video_returns_asset_url():
    """generate_video for fal video models returns mp4 URL."""
    from fal_client_wrapper import generate_video

    fake_result = {"video": {"url": "https://fal.ai/result.mp4"}}

    with patch("fal_client_wrapper.fal_client.run", return_value=fake_result):
        result = generate_video(
            prompt="Spinning product shot",
            model_id="fal-ai/kling-video/v1.6/standard",
        )

    assert result["url"] == "https://fal.ai/result.mp4"


def test_generate_image_propagates_fal_errors():
    """fal.ai client failures surface as RuntimeError."""
    from fal_client_wrapper import generate_image

    with patch("fal_client_wrapper.fal_client.run", side_effect=Exception("rate limited")):
        with pytest.raises(RuntimeError, match="fal.ai generation failed"):
            generate_image(prompt="test", model_id="fal-ai/flux/dev")
```

**Step 2: Run tests — should fail (module missing)**

```bash
pytest tests/test_fal_client.py -v
```

Expected: 3 errors / ModuleNotFoundError

### Task 3.4: Implement fal_client_wrapper.py (TDD green pass)

**Files:**
- Create: `/Users/nico/odylic-lens/api/fal_client_wrapper.py`

**Step 1: Write minimal implementation**

```python
"""Wrap fal.ai SDK for image + video generation.

FAL_KEY read from env. Returns asset URLs; caller is responsible for
downloading to disk (separated for testability).
"""
from __future__ import annotations
import fal_client


def generate_image(prompt: str, model_id: str = "fal-ai/flux/dev", **kwargs) -> dict:
    """Generate image via fal.ai. Returns {"url": str, ...}.

    Common model_ids:
    - fal-ai/flux/dev (FLUX dev, fast + high quality)
    - fal-ai/flux/schnell (cheaper, faster)
    - fal-ai/ideogram/v2 (best for text-in-image)
    """
    try:
        result = fal_client.run(model_id, arguments={"prompt": prompt, **kwargs})
    except Exception as e:
        raise RuntimeError(f"fal.ai generation failed: {e}") from e

    if "images" in result and result["images"]:
        return {"url": result["images"][0]["url"], "raw": result}
    raise RuntimeError(f"fal.ai returned no image: {result}")


def generate_video(prompt: str, model_id: str = "fal-ai/kling-video/v1.6/standard", **kwargs) -> dict:
    """Generate video via fal.ai. Returns {"url": str, ...}.

    Common model_ids:
    - fal-ai/kling-video/v1.6/standard
    - fal-ai/veo/v3
    - fal-ai/hunyuan-video
    """
    try:
        result = fal_client.run(model_id, arguments={"prompt": prompt, **kwargs})
    except Exception as e:
        raise RuntimeError(f"fal.ai generation failed: {e}") from e

    if "video" in result:
        return {"url": result["video"]["url"], "raw": result}
    raise RuntimeError(f"fal.ai returned no video: {result}")
```

**Step 2: Run tests**

```bash
pytest tests/test_fal_client.py -v
```

Expected: 3 passed

**Step 3: Commit**

```bash
git add api/fal_client_wrapper.py api/tests/test_fal_client.py
git commit -m "feat: fal.ai client wrapper for Create stage"
git push
```

### Task 3.5: Test scaffold — generate_endpoints (TDD)

**Files:**
- Create: `/Users/nico/odylic-lens/api/tests/test_generate_endpoints.py`
- Create: `/Users/nico/odylic-lens/api/generate_endpoints.py` (next task)

**Step 1: Write the failing test**

```python
"""Tests for /api/generate + /api/drafts routes."""
from __future__ import annotations
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Test client with isolated drafts directory."""
    monkeypatch.setenv("LENS_DRAFTS_DIR", str(tmp_path))
    from fastapi import FastAPI
    from generate_endpoints import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_generate_creates_draft_and_returns_asset_path(client, tmp_path):
    """POST /api/generate runs fal.ai + saves to drafts table + disk."""
    recipe = {
        "recipe_id": "r1", "angle": "Benefits", "product": "Mushroom Coffee",
        "hook": "Test", "visual_direction": "minimalist", "format": "image",
        "fal_model_hint": "fal-ai/flux/dev",
    }

    with patch("generate_endpoints.generate_image", return_value={"url": "https://fake/x.png"}), \
         patch("generate_endpoints._download_asset", return_value="local/path.png"), \
         patch("generate_endpoints._insert_draft") as mock_ins:

        response = client.post("/api/generate", json={
            "brand": "DOSE OF",
            "recipe": recipe,
            "variant_count": 1,
        })

    assert response.status_code == 200
    body = response.json()
    assert body["recipe_id"] == "r1"
    assert "local/path.png" in body["asset_paths"]
    mock_ins.assert_called_once()


def test_list_drafts_filters_by_brand_and_status(client):
    """GET /api/drafts?brand=X&status=Y returns matching rows."""
    fake_rows = [
        {"recipe_id": "r1", "brand": "DOSE OF", "status": "draft",
         "asset_paths": '["a.png"]', "created_at": "2026-05-25", "recipe_json": "{}"},
    ]

    with patch("generate_endpoints._list_drafts", return_value=fake_rows):
        response = client.get("/api/drafts?brand=DOSE+OF&status=draft")

    assert response.status_code == 200
    assert len(response.json()) == 1


def test_discard_draft_marks_status(client):
    """DELETE /api/drafts/<id> marks status=discarded (soft delete)."""
    with patch("generate_endpoints._set_draft_status") as mock_set:
        response = client.delete("/api/drafts/r1")

    assert response.status_code == 200
    mock_set.assert_called_once_with("r1", "discarded")
```

**Step 2: Run tests — should fail (module missing)**

```bash
pytest tests/test_generate_endpoints.py -v
```

### Task 3.6: Implement generate_endpoints.py (TDD green pass)

**Files:**
- Create: `/Users/nico/odylic-lens/api/generate_endpoints.py`

**Step 1: Write minimal implementation**

```python
"""Create stage: AdRecipe → fal.ai generation → drafts gallery.

Routes:
- POST /api/generate — generate asset from recipe
- GET /api/drafts — list drafts for brand
- DELETE /api/drafts/<id> — soft-discard
"""
from __future__ import annotations
import json
import os
import uuid
from pathlib import Path
from typing import Optional
import urllib.request

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from fal_client_wrapper import generate_image, generate_video
from store import get_connection


router = APIRouter()


class GenerateRequest(BaseModel):
    brand: str
    recipe: dict
    model_override: Optional[str] = None
    variant_count: int = 1


def _drafts_dir() -> Path:
    base = Path(os.environ.get("LENS_DRAFTS_DIR", Path.home() / ".odylic-lens" / "drafts"))
    base.mkdir(parents=True, exist_ok=True)
    return base


def _download_asset(url: str, dest: Path) -> str:
    dest.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(url, dest)
    return str(dest)


def _insert_draft(recipe_id: str, brand: str, asset_paths: list[str],
                  recipe_json: str, fal_model: str, cost_usd: Optional[float] = None):
    conn = get_connection()
    conn.execute(
        "INSERT OR REPLACE INTO drafts (recipe_id, brand, asset_paths, recipe_json, fal_model, cost_usd) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (recipe_id, brand, json.dumps(asset_paths), recipe_json, fal_model, cost_usd),
    )
    conn.commit()


def _list_drafts(brand: str, status: str = "draft") -> list[dict]:
    conn = get_connection()
    rows = conn.execute(
        "SELECT recipe_id, brand, status, asset_paths, created_at, recipe_json, fal_model, cost_usd "
        "FROM drafts WHERE brand = ? AND status = ? ORDER BY created_at DESC",
        (brand, status),
    ).fetchall()
    return [dict(r) for r in rows]


def _set_draft_status(recipe_id: str, status: str):
    conn = get_connection()
    conn.execute("UPDATE drafts SET status = ? WHERE recipe_id = ?", (status, recipe_id))
    conn.commit()


@router.post("/api/generate")
def generate(req: GenerateRequest) -> dict:
    recipe = req.recipe
    recipe_id = recipe.get("recipe_id") or str(uuid.uuid4())
    model_id = req.model_override or recipe.get("fal_model_hint") or "fal-ai/flux/dev"
    fmt = recipe.get("format", "image")

    prompt = f"{recipe.get('visual_direction', '')}\n{recipe.get('hook', '')}".strip()
    asset_urls: list[str] = []
    for i in range(req.variant_count):
        if fmt == "video":
            result = generate_video(prompt, model_id=model_id)
        else:
            result = generate_image(prompt, model_id=model_id)
        asset_urls.append(result["url"])

    # Download + save
    brand_dir = _drafts_dir() / req.brand / recipe_id
    local_paths: list[str] = []
    for i, url in enumerate(asset_urls):
        ext = "mp4" if fmt == "video" else "png"
        dest = brand_dir / f"{i}.{ext}"
        local_paths.append(_download_asset(url, dest))

    _insert_draft(
        recipe_id=recipe_id,
        brand=req.brand,
        asset_paths=local_paths,
        recipe_json=json.dumps(recipe),
        fal_model=model_id,
    )

    return {
        "recipe_id": recipe_id,
        "asset_paths": local_paths,
        "fal_model": model_id,
        "status": "draft",
    }


@router.get("/api/drafts")
def list_drafts(brand: str, status: str = "draft") -> list[dict]:
    return _list_drafts(brand, status)


@router.delete("/api/drafts/{recipe_id}")
def discard_draft(recipe_id: str) -> dict:
    _set_draft_status(recipe_id, "discarded")
    return {"recipe_id": recipe_id, "status": "discarded"}
```

**Step 2: Run tests**

```bash
pytest tests/test_generate_endpoints.py -v
```

Expected: 3 passed

**Step 3: Commit**

```bash
git add api/generate_endpoints.py api/tests/test_generate_endpoints.py
git commit -m "feat: /api/generate + /api/drafts routes"
git push
```

### Task 3.7: Register generate_endpoints router in main.py

**Files:**
- Modify: `/Users/nico/odylic-lens/api/main.py`

Add:
```python
from generate_endpoints import router as generate_router
# ...
app.include_router(generate_router)
```

Restart + smoke test:
```bash
lens restart
sleep 3
curl http://localhost:8765/api/drafts?brand=DOSE+OF
```

Expected: `[]` (empty list, no drafts yet)

Commit:
```bash
git add api/main.py
git commit -m "feat: register generate_router in main"
git push
```

### Task 3.8: Build Create tab UI (React)

**Files:**
- Create: `/Users/nico/odylic-lens/web/src/pages/Create.tsx`
- Modify: `/Users/nico/odylic-lens/web/src/App.tsx`

**Step 1: Create Create.tsx**

Skeleton component with two sections:
1. **Pending recipes** — recipes from Analyze tab stored in localStorage, with per-recipe "Generate" button + model selector
2. **Drafts gallery** — fetches `/api/drafts?brand=X`, renders grid of asset previews

(See full UI code template at end of plan if you want a starting block.)

**Step 2: Wire Create tab into App.tsx**

Mirror Phase 2 Task 2.12 pattern: lazy import, Tab type, tabs array, render block.

**Step 3: Rebuild + smoke test**

```bash
cd /Users/nico/odylic-lens/web
npm run build
lens restart
open http://localhost:8765
```

Workflow test:
1. Analyze tab → generate 3 recipes for Vital Botanics
2. Click "Send to Create" on one recipe
3. Switch to Create tab → see recipe in Pending
4. Click "Generate" → wait ~30-60s
5. Asset appears in Drafts gallery

**Step 4: Commit**

```bash
git add web/src/pages/Create.tsx web/src/App.tsx
git commit -m "feat: Create tab UI with drafts gallery"
git push
```

### Phase 3 exit criteria

- [ ] All Phase 3 tests pass (`pytest tests/ -v` → all green)
- [ ] One image generated end-to-end from a Vital recipe → asset on disk + visible in gallery
- [ ] One video generated end-to-end → mp4 on disk + visible
- [ ] Drafts filter by brand correctly
- [ ] Discard marks status, hides from default view
- [ ] fal.ai cost tracked in `cost_usd` column (if API returns it; otherwise null OK for v1)

### Phase 3 final commit + merge

```bash
git checkout main
git merge --no-ff feat/create-stage
git push
git branch -d feat/create-stage
```

---

## Phase 4: Sunset dose-creative (~0.5 day, operational)

**Not a code phase.** Operations + cleanup.

**Status 2026-05-26:** DONE. Executed before Phase 3 by decision after Phase 2.5 hardening shipped. dose-creative is paused, not deleted; Supabase `creative.*` is archived in the vault.

### Task 4.1: Pre-shutdown audit

**Result:** 14 `creative.*` tables exported. Data-side audit found 1 stale pending campaign and 10 draft rings; all were archived before pause.

**Steps:**

1. Browser: open https://dose-creative.vercel.app
2. Log in (`nico@takeadoseof.com`)
3. Check for in-flight briefs, draft campaigns, anything launched but not closed
4. If found: export to JSON manually + save to vault at `techstack/dose-creative-archive-2026-05-25/`

### Task 4.2: Archive Supabase creative schema

**Result:** JSON exports and `creative-schema-openapi.json` saved to `/Users/nico/Library/Mobile Documents/iCloud~md~obsidian/Documents/dose-playbook/techstack/dose-creative-archive-2026-05-25/`.

**Steps:**

1. Open Supabase dashboard for dose-creative project
2. SQL editor: `\dt creative.*` (list tables)
3. For each table, export to CSV/JSON via dashboard download
4. Save dumps to `/Users/nico/Library/Mobile Documents/iCloud~md~obsidian/Documents/dose-playbook/techstack/dose-creative-archive-2026-05-25/`
5. Screenshot final schema state + save

### Task 4.3: Pause Vercel deployment

**Result:** Vercel project `dose-creative` (`prj_L2ZYG3PUeOkEU1G5xDsAWyHIo2Cc`) paused via API. `https://dose-creative.vercel.app` returns `503` with `x-vercel-error: DEPLOYMENT_PAUSED`.

**Steps:**

1. Vercel dashboard → dose-creative project → Settings → General
2. Find "Pause production deployments" toggle → enable
3. DO NOT delete the project (keeps DNS history + redeploy option)
4. Verify dose-creative.vercel.app returns paused/error page

### Task 4.4: Clean CLAUDE.md references

**Result:** CLAUDE.md routes creative ops / Meta creative analysis to the local Lens fork.

**Files:**
- Modify: `/Users/nico/Library/Mobile Documents/iCloud~md~obsidian/Documents/dose-playbook/CLAUDE.md`

Steps:
1. Open CLAUDE.md
2. Find any rows in the routing table that reference dose-creative
3. Remove or replace with Lens fork references
4. Save

### Task 4.5: Close lingering reminders

**Result:** Added weekly Lens fork use reminder for 2026-06-02.

**Files:**
- Modify: `/Users/nico/Library/Mobile Documents/iCloud~md~obsidian/Documents/dose-playbook/ops/reminders.md`

Remove any dose-creative-specific reminders. Add one new reminder: "Lens fork weekly use — capture gaps in inbox/."

### Task 4.6: Update MOC

**Result:** Created `dose-playbook/maps/Creative ops MOC.md`.

**Files:**
- Modify: `dose-playbook/maps/Creative ops MOC.md` (if exists, otherwise create)

Add Lens fork as canonical creative ops entry point. Link to:
- `[[Odylic Lens fork replaces dose-creative as single creative ops tool]]`
- `[[2026-05-25-lens-fork-build-plan]]` (in techstack/)
- `[[2026-05-25-lens-fork-creative-ops-build]]` (this file, in ~/odylic-lens/docs/plans/)

### Phase 4 exit criteria

- [x] dose-creative.vercel.app shows paused state
- [x] Supabase creative.* schema archived to vault
- [x] CLAUDE.md routing table has no active dose-creative routing
- [x] No remaining ops reminders point to dose-creative
- [x] MOC reflects Lens fork as canonical entry point

### Phase 4 commit (vault changes)

```bash
cd "/Users/nico/Library/Mobile Documents/iCloud~md~obsidian/Documents/dose-playbook"
git add CLAUDE.md ops/reminders.md techstack/dose-creative-archive-2026-05-25/ maps/
git commit -m "chore: sunset dose-creative, Lens fork is canonical creative ops"
```

---

## Final validation — one full cycle works end-to-end

After all 4 phases complete:

- [ ] Open Lens at localhost:8765
- [ ] Switch to Vital Botanics brand
- [ ] **Audit tab:** see ads + KPIs from real Meta data
- [ ] **Analyze tab:** generate 5 recipes from top 10 winners
- [ ] Click "Send to Create" on one recipe
- [ ] **Create tab:** generate asset via fal.ai
- [ ] Asset visible in drafts gallery
- [ ] Switch to DOSE OF brand → drafts gallery shows only DOSE drafts
- [ ] Anthropic console shows usage (audit tagging only — Analyze stays $0)
- [ ] fal.ai dashboard shows usage (~$0.20-0.60 per generation)
- [ ] Claude Code dashboard shows session usage (Analyze)

---

## Rollback options (if any phase blocks)

**Phase 1 stalls:** Vanilla Lens unaffected. Just don't use Analyze/Create tabs until Brand Settings filled.

**Phase 2 stalls:** Vanilla Lens still works. Revert remote if needed:
```bash
cd /Users/nico/odylic-lens
git remote set-url origin https://github.com/peterquads/odylic-lens.git
git checkout main
```

**Phase 3 stalls:** Analyze tab still works for "recommendations only" use. Skip Create until ready.

**Phase 4 stalls or premature:** dose-creative paused not deleted — unpause via Vercel dashboard in ~30s.

---

## Skills referenced

- `superpowers:executing-plans` — for task-by-task execution
- `superpowers:test-driven-development` — TDD pattern used in Phase 2 + 3
- `superpowers:subagent-driven-development` — if dispatching fresh subagents per task
- `dose-skill-scaffold` — N/A here (not a DOSE skill)

---

## Open follow-ups (NOT in v1 scope)

- Layer 2 video model (Gemini 2.5 Pro / Qwen3-VL-235B opt-in toggle)
- Meta launch automation from drafts gallery
- Brand Settings tests (currently UI-only, manual validation)
- Cost dashboard (per-stage spend visibility)
- Variant A/B comparison view
- MiniCPM-V 4.5 local Layer 0 for high-volume tagging
