# Odylic Lens

Self-hosted Creative Analysis for Meta Ads. Bring your own Meta App, connect
once, see every creative across every ad account you have access to,
joined with live spend, CTR, CPL, ROAS, AI tagging, transcripts, and
tracking-quality signals.

No SaaS account. No data leaves your machine. No Meta App Review needed
because you use *your own* Meta App credentials.

```
┌──────────┐   /api/*   ┌─────────────┐   Graph API   ┌──────────┐
│  Vite UI │ ─────────► │  FastAPI    │ ────────────► │   Meta   │
│  :8765   │ ◄───────── │  :8765      │ ◄──────────── │  v23.0   │
└──────────┘            └─────────────┘               └──────────┘
                              │
                              ▼
                         SQLite (encrypted)
                         tokens · accounts · sessions
```

## One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/peterquads/odylic-lens/main/install.sh | bash
```

This installer:

1. Clones the repo into `~/odylic-lens` (override with `ODYLIC_LENS_DIR=`).
2. Creates a Python venv, installs API deps, **pre-builds the web bundle**.
3. Generates a random `LENS_SECRET_KEY` in `.env`.
4. Symlinks the `lens` CLI onto your PATH (`/usr/local/bin/lens` or
   `~/.local/bin/lens`).
5. Drops a desktop launcher (`~/Applications/Odylic Lens.app` on macOS,
   `.desktop` entry on Linux) so you can double-click to launch and
   start it from Spotlight.

After install: edit `~/odylic-lens/.env` to paste your Meta App ID +
Secret (one-time, see [docs/setup.md](docs/setup.md)), then launch the
app and walk through the Setup wizard.

## Daily ops

| Command         | What it does                                                |
|-----------------|-------------------------------------------------------------|
| `lens start`    | Start API in the background (serves UI on :8765).           |
| `lens stop`     | Stop the API.                                               |
| `lens restart`  | Stop + start.                                               |
| `lens status`   | Show pid + port state.                                      |
| `lens update`   | `git pull` → reinstall deps → rebuild → restart.            |
| `lens logs api` | Tail the running API log.                                   |

Or click the **Odylic Lens** desktop icon — same as `lens start` plus
opens the browser.

## Updates

Lens polls GitHub for the latest release once per 24h. When an update
is available, **Settings → About** shows an orange "Update available"
chip with a "Release notes" link and a "Check now" button to force a
fresh probe.

To apply: `lens update`.

The `LENS_UPDATE_REPO` env var overrides the default GitHub repo
(`peterquads/odylic-lens`) if you fork.

## Manual install (developers)

If you don't want the curl-bash, you can clone + install by hand:

```bash
git clone https://github.com/peterquads/odylic-lens.git
cd odylic-lens
./install.sh
```

Or skip `install.sh` entirely and run each piece yourself:

```bash
# API
cd api
python3 -m venv venv
source venv/bin/activate
pip install -e .
python main.py                    # → http://localhost:8765

# Web (only needed for hot-reload dev work)
cd ../web
npm install
npm run dev                       # → http://localhost:5173
# OR: npm run build, then the API serves the SPA from :8765 directly.
```

## First-time Meta App setup

One-time per deployment. Detailed walkthrough lives at
[docs/setup.md](docs/setup.md), and the in-app **Setup** wizard
shows you the exact screens to click. The short version:

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create App** → pick the use case **Create and manage ads with Marketing API**.
2. App stays in **Development mode** (no App Review needed, indefinite).
3. From **App settings → Basic**, copy the App ID and App Secret.
4. Paste them into the Setup wizard (or `~/odylic-lens/.env`).
5. Click **Connect Meta**, authorize on facebook.com, you're in.

Localhost redirect URIs are auto-allowed by Meta in Dev mode — you
don't need to register `http://localhost:8765/api/auth/callback`
anywhere.

## What you get

- **Creative Analysis** — every ad in cards / table / line / bar /
  scatter / funnel views, sortable, searchable, with the full creative
  payload (image, video, headline, body, CTA).
- **AI tagging** — Haiku-driven sentiment, angle, persona, template,
  funnel position, market awareness, marketing moment. Saved to a
  hash-keyed cache so each creative is analyzed exactly once. Always
  exported in the CSV.
- **In-browser transcripts** — `whisper-tiny.en` runs entirely in your
  browser (WebGPU when available, WASM everywhere else). No API key,
  no upload, no install. Cached in localStorage per video.
- **Naming conventions** — define position-tokens for ad / adset names
  in Brand Settings. Tokens automatically populate Group-By + Dimension
  Filter dropdowns across every view.
- **Compare period** — pick a comparison window; tables show ↑/↓ delta
  chips next to every metric, cards too. Line + bar charts overlay a
  dotted prior-period series.
- **Customizable dashboard** — drag widgets to reorder, gear to
  configure, X to remove. Widget sizes ⅓ / ½ / ⅔ / full.
- **Atria search** — global ad library search with industry / theme /
  platform / language / status filters. Pin to local boards.
- **Saved reports** — capture filter + metric + sort state. Rolling
  date modes refresh window on load. Export as CSV with AI fields, or
  print to PDF.
- **Per-account QC** — pixel health, paused-but-delivered ads diluting
  historicals, day-over-day variance, account status.

## Security model

- Access tokens + integration keys encrypted at rest with
  `LENS_SECRET_KEY` (Fernet / AES-128-CBC + HMAC-SHA256). Key rotated
  to `~/.odylic-lens/config.json` if missing from env.
- Session cookies are `httponly` + `samesite=lax`. Set
  `LENS_COOKIE_SECURE=1` when serving over HTTPS to add the `Secure`
  flag + HSTS.
- CORS allowlist is explicit (env-configurable via `WEB_ORIGIN`).
- Per-IP rate limits on credential-handling routes
  (`/api/auth/configure`, `/check`, `/unconfigure`, `/disconnect`).
- `X-Frame-Options: DENY` + strict CSP + `frame-ancestors 'none'`.
- Single-tenant by design — the deployment owner is the only user.
  Anyone with browser access to your Lens instance has full read access
  to your Meta data, so don't expose it publicly without a reverse-proxy
  auth layer.

## Data locations

| Path                                | What                                         |
|-------------------------------------|----------------------------------------------|
| `~/.odylic-lens/lens.db`            | Encrypted tokens, accounts, sessions, keys.  |
| `~/.odylic-lens/config.json`        | Meta App ID + encrypted App Secret. Backup-able. |
| `~/.odylic-lens/brand_profile.json` | Per-brand identity + naming conventions.     |
| `~/odylic-lens/api/*.json`          | Disk-backed caches (analyses, boards, reports, creative metadata). Gitignored. |
| `~/odylic-lens/api/image_cache/`    | Disk-cached image bytes (gitignored).        |
| `~/odylic-lens/api/.run/`           | PID + log files for `lens start` (gitignored). |

To migrate to a new machine: `rsync` `~/.odylic-lens/` and `~/odylic-lens/.env`.

## License

MIT
