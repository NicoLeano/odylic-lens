# Meta App setup for Odylic Lens

Last verified: **May 2026** against the live Meta developer console.

This doc is the long-form companion to the in-app Setup wizard at
[`/setup`](http://localhost:5180/setup). Same content, more depth, with
every gotcha discovered during real-world setups in 2026.

---

## TL;DR

1. Create a Meta App with the **"Create and manage ads with Marketing API"**
   use case. Do NOT pick "Other."
2. Skip everything Meta asks about App Review, publishing, or going Live.
3. Verify `ads_read`, `ads_management`, `business_management` show
   **"Ready for testing"** on the use-case Permissions tab.
4. Copy App ID + App Secret from `App settings → Basic`.
5. Paste into Lens Step 4. Click Connect Meta.

You'll never need to touch the OAuth redirect URI field in Meta. Localhost
is auto-allowed in Dev mode and Meta will block any attempt to add it.

---

## What you DON'T need (most tutorials get this wrong)

| Thing | Status |
|---|---|
| App Review | Not needed. Ever, for self-hosted Lens. |
| Going Live / publishing the app | Not needed. Actively counterproductive — Meta scrutinizes Live apps more. |
| Business verification | Not needed. |
| Privacy policy URL | Not needed (only required for Live submission). |
| Terms of Service URL | Not needed. |
| App icon (1024×1024) | Not needed. |
| App Category | Not needed. |
| Data Deletion Callback URL | Not needed. |
| App Domains entry | Not needed for localhost. Meta auto-allows it. |
| Adding `http://localhost:...` to "Valid OAuth Redirect URIs" | **Meta will reject your attempt** — Dev mode auto-allows localhost. |
| "Authorize callback URL" under App settings → Advanced | This is for native/desktop apps only. Leave empty. |
| "Domain manager" under App settings → Advanced | This is for ownership verification of public domains. Leave empty. |
| "Add to App Review" buttons next to permissions | Don't click. App Review takes weeks for permissions you don't need. |
| The red "Currently Ineligible for Submission" banner | Benign — it's the App Review checklist. You're not submitting. |
| The Meta UI prompt "Switch to Live mode?" | Click away. Never go Live. |
| Adding test users | Not needed. Your own Admin account works. |
| Webhooks | Not needed. |

---

## What you DO need

1. **A Facebook account** — used during OAuth. Must be Admin of the Meta App.
2. **Access to at least one ad account** — either personal or via Business Manager (Advertiser role minimum).
3. **A Meta Developer account** — free, auto-created on first visit to developers.facebook.com.
4. **An Admin role** on your Meta App (default for the creator).
5. **The use case "Create and manage ads with Marketing API"** picked at app creation.
6. **`ads_read`, `ads_management`, `business_management`** showing "Ready for testing" status.
7. **App ID + App Secret** from App settings → Basic.

That's the entire list.

---

## Setup steps

### Step 1 · Create the Meta App

Open <https://developers.facebook.com/apps/> → click **Create app** (top right).

1. **App details:**
   - App name: anything memorable. `Odylic Lens (your name)` works.
   - App contact email: your email.
   - Click **Next**.

2. **Use case picker** (this is the screen most tutorials get wrong):
   - Pick **Create and manage ads with Marketing API**.
   - Do NOT pick "Other" — that path is for non-ads apps and won't expose the Marketing API surface.
   - Click **Next**.

3. **Business portfolio:**
   - If you have a Meta Business Manager, select it.
   - Otherwise pick "I don't want to connect a business portfolio yet."
   - Click **Next**.

4. **Publishing requirements:**
   - Meta lists what you'd need to take the app Live (privacy policy, business verification, screencast demo). Ignore all of it.
   - Click **Next**.

5. **Create app:**
   - Click **Create app**.
   - Meta will ask you to re-enter your Facebook password.

You land on the App Dashboard.

### Step 2 · Verify the permissions

Picking the use case automatically requested the permissions Lens needs. Verify they're in the right state:

1. On the Dashboard, find **App customization and requirements** in the right panel.
2. Click **Customize the Create & manage ads with Marketing API use case**.
3. You're now on the **Permissions and features** tab of the use case. Confirm these three rows show **Ready for testing** in the Status column:
   - `ads_read`
   - `ads_management`
   - `business_management`

**"Ready for testing"** is Meta's current name for what older docs call **"Standard Access."** Meta renamed the tier in 2025. It lets the app's Admins, Developers, and Testers use these permissions on their own ad accounts indefinitely without App Review.

**Don't touch the "Get Advanced Access" buttons.** Advanced Access requires App Review (4–6 weeks) and is only useful if you want third-party users to connect to your instance.

**"Marketing API Access Tier"** in the same table will say "Limited access." That's fine for self-use. The Limited tier caps you at 25 ad accounts and standard rate limits — single-user never trips that.

**Do NOT click "+ Add to App Review"** on any other row (`catalog_management`, `email`, `pages_manage_ads`, `threads_business_basic`, `Business Asset User Profile Access`). Lens doesn't use them.

### Step 3 · Get App ID and App Secret

1. Click **App settings → Basic** in the left sidebar (near the bottom).
2. **App ID**: at the top of the page. All digits, 15–16 chars. Copy it.
3. **App Secret**: also at the top, right column. Click **Show**, re-enter your Facebook password if prompted, copy the 32-char hex string.

**Treat the App Secret like a password.** Never commit it, share it in chat, or paste it in a screenshot. If you accidentally expose it, click **Reset** on the same page to invalidate it and generate a new one.

**Ignore the red "Currently Ineligible for Submission" banner.** It lists fields you'd need to submit for App Review (App icon, Privacy policy URL, Category). You're not submitting.

### Step 4 · Paste into Lens

Open <http://localhost:5180/setup> → advance to Step 4.

- **App ID** — paste it.
- **App Secret** — paste it.
- **OAuth Redirect URI** — auto-filled to match your Lens API port. Don't change unless you've moved Lens to a custom port.

Click **Save credentials**.

### Step 5 · Test and connect

1. The test runs automatically (validates App ID + Secret against Meta).
2. If you see a red error, the App Secret is wrong (most common: you rotated it in Meta and the OLD value is still here). Go back to Step 4 and re-paste.
3. If green ✓, click **Connect Meta →**.
4. Facebook OAuth dialog appears. Authorize the permissions.
5. Meta redirects you back to Lens at `/brands`. Your real ad accounts appear.

---

## Token lifetime

| Token type | Lifetime | Refresh |
|---|---|---|
| Short-lived user token (during OAuth) | ~2 hours | Auto-exchanged by Lens for long-lived |
| Long-lived user token (what Lens stores) | ~60 days | Click Connect Meta again to re-issue |
| System User token (Business Manager) | 60 days OR never expires | Not auto-rotated; replace manually |

When your long-lived token has < 7 days remaining, Lens's topbar shows a yellow chip. Click it (or the Connect Meta button on landing) — Lens re-issues a fresh 60-day token without re-prompting permissions.

For zero-touch production deploys, see [Production: System User token](#production-system-user-token).

---

## Production: System User token

For a deployment that runs 24/7 without you re-authorizing every 60 days, generate a System User token:

1. Go to <https://business.facebook.com> → **Business settings**.
2. Left sidebar: **Users → System users**.
3. Click **Add**. Name: `Lens — Server`. Role: **Admin**.
4. Click the new system user → **Add assets** → select your ad accounts → check **Manage ad account** → save.
5. Click **Generate new token**:
   - **App**: your Lens Meta App.
   - **Token expiration**: **Never**.
   - **Permissions**: `ads_read`, `ads_management`, `business_management`.
6. Click **Generate token**. Copy the value — it's shown only once.

Then in Lens's `.env`:

```bash
META_SYSTEM_USER_TOKEN=<paste here>
```

Lens v0.2 will use this token when set, bypassing the user OAuth flow. v0.1 doesn't yet support it — you can still copy the value out as a workaround but the wizard won't recognize it.

---

## Account-safety reality check

Real ban risk for self-hosted Lens following the steps above: **essentially zero**.

What Meta actually bans accounts for:

| Risk | Triggered by | Lens does this? |
|---|---|---|
| Scraping / unauthorized access | Reading accounts you have no role in | No |
| Rate-limit abuse | Thousands of API calls per hour | No (60s response cache, single-user, debounced UI) |
| Token sharing across many users | One token serving N users | No (each user has their own Meta App + token) |
| Reselling Meta data to third parties | Productizing the data | No (data never leaves your machine) |
| Suspicious automation | Logins from many IPs, bot patterns | No (single OAuth from one machine) |
| Wrong-account access attempts | Calling APIs on accounts you can't access | No (Lens only lists accounts your Meta user can read) |

What gets Lens-style apps safely run forever:

- Single user (you) = single Meta App + single token.
- App stays in Development mode.
- "Ready for testing" status on the permissions you use.
- Pulling data on accounts your Meta user has at least Advertiser role on.

Publishing the app to Live actually **increases** Meta's scrutiny. Don't do it.

---

## Troubleshooting (real failures from real setups)

### "Error validating client secret." / "Token exchange failed."

You rotated the App Secret in Meta but the old one is still saved in Lens. Get the current secret from `App settings → Basic → Show next to App Secret`, re-paste in Lens Step 4.

### After Connect Meta, browser shows "Not Found" on a localhost URL

Meta redirected you back to the wrong port. The redirect URI in Lens points to port X but the Lens API is running on port Y. Check `/api/status` to find the actual port, then update Step 4's OAuth Redirect URI field.

### "http://localhost redirects are automatically allowed…" popup when adding to Valid OAuth Redirect URIs

Don't add it. That popup is Meta confirming you don't need to. Localhost is auto-allowed in Dev mode. Click the red X on your entry and skip the field entirely.

### "URL Blocked: This redirect failed because…"

For localhost: confirm the app is in Development mode (top of dashboard) and your redirect URI port matches the Lens API port.

For public deployments: the redirect URI Lens sends doesn't match a chip under `Facebook Login for Business → Settings → Client OAuth settings → Valid OAuth Redirect URIs`. Check for `http` vs `https`, trailing slash, port, `127.0.0.1` vs `localhost`.

### I can't find "Add products to your app"

It doesn't exist any more. The use case bundles the products. If you picked "Create and manage ads with Marketing API" in Step 1, Facebook Login for Business and Marketing API are already wired up — see them in the left sidebar.

### Where is "App Domains"?

It exists at `App settings → Basic → App domains` but you can leave it empty for localhost. Only fill it if you deploy to a public domain.

### "App not active" / "This app is in development mode"

Dev mode is the supported state. The constraint is only Admins/Developers/Testers can connect. Verify the Facebook account you're using is listed at `App roles → Roles` with role **Administrator**.

### "Permissions error" / "missing scope ads_read"

Three checks:
1. `App roles → Roles`: you must be **Administrator** (not Developer or Tester).
2. `Use cases → Customize → Permissions and features`: `ads_read` must show "Ready for testing."
3. The Facebook account you connected with must have at least Advertiser role on the ad accounts you're querying. Check `business.facebook.com → Users → People`.

### OAuth loops or hangs

Clear cookies for `facebook.com` and your Lens domain. Log out of all other Facebook tabs. Try in incognito if you have privacy/tracking extensions installed.

### Token expired after 60 days

Click the yellow chip in the Lens topbar (or Connect Meta on landing). Lens re-issues a fresh token without re-prompting permissions.

### "Switch to Live mode?"

Don't. See [Account-safety reality check](#account-safety-reality-check).

### 0 ad accounts on the Brands page after connecting

The Facebook account you connected with has no ad-account access. Verify at `business.facebook.com → Users → People` — you need at least **Advertiser** role on a real ad account.

### Accidentally shared the App Secret

Reset it: `App settings → Basic → Reset next to App Secret`. Then re-paste in Lens Step 4. Old secret is invalidated immediately.

---

## Local audio transcription (optional)

Lens ships with a free, on-device transcription engine for ad-audio
analysis. Audio never leaves your machine — no OpenAI key needed.

### Install

```bash
cd api
pip install -e '.[transcribe]'
```

The optional `[transcribe]` extra pulls in:

- **`mlx-whisper`** on Apple Silicon Macs (Metal + ANE acceleration, ~30x realtime on M2 Pro). Auto-skipped on other platforms.
- **`faster-whisper`** as the cross-platform fallback (Intel Mac / Linux / Windows; CPU int8 or CUDA float16).
- **`silero-vad`** (~200 KB) to skip music-only clips before they hit Whisper.
- `torch` + `torchaudio` (already required by the optional sentiment extra).

Restart the API after install. Verify on the API Settings page — the
section header will read **"✓ Local Whisper ready"** with the active
engine and model name.

### What it unlocks

- Per-ad transcription via `POST /api/transcribe` (body: `{"url": ...}` or `{"ad_id": ...}`).
- The "Try it" widget on the API Settings page.
- (Coming in v0.2) automatic transcription inside Creative Analysis for video creatives.

### Model and disk usage

- Default model: `mlx-community/whisper-large-v3-turbo` (~800 MB), or `large-v3` on faster-whisper.
- Weights download from HuggingFace Hub on the first transcription request (one-time, cached under `~/.cache/huggingface/hub/`).
- Override with `LENS_WHISPER_MODEL=...` (mlx-whisper) or `LENS_WHISPER_MODEL_FW=...` (faster-whisper) in `.env`.

### Supported platforms

| Platform | Engine | Speed (M2 Pro / 8-core) |
|---|---|---|
| Apple Silicon Mac | `mlx-whisper` | ~30–50x realtime |
| Intel Mac | `faster-whisper` (CPU int8) | ~3–6x realtime |
| Linux + CUDA GPU | `faster-whisper` (float16) | ~10–20x realtime |
| Linux / Windows CPU | `faster-whisper` (CPU int8) | ~3–6x realtime |

On unsupported platforms or when the extras aren't installed, the
endpoints return a structured 503 with the exact install command, and
Lens transparently falls back to the OpenAI Whisper option if you've
configured an API key.

---

## Security model

- **Tokens at rest**: encrypted with Fernet (AES-128-CBC + HMAC-SHA256) using a key derived from `LENS_SECRET_KEY`.
- **App Secret at rest**: when entered via UI, stored encrypted in `~/.odylic-lens/config.json` (mode 0600). When set via env (`META_APP_SECRET=...`), env wins.
- **Session cookies**: `httponly`, `samesite=lax`. Set `LENS_COOKIE_SECURE=1` when serving over HTTPS.
- **Outbound telemetry**: none. Lens never phones home.
- **API hardening**: rate-limited on `/configure` and `/check` endpoints, security headers on every response (CSP, X-Frame-Options DENY, X-Content-Type-Options nosniff).
- **Multi-user warning**: Lens v0.1 is single-tenant by design. Anyone with browser access to the Lens URL has full read access to the connected Meta data. Don't expose Lens on a public IP without a reverse-proxy auth layer (Cloudflare Access, Tailscale, oauth2-proxy).
