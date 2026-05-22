# Odylic Lens — Windows PowerShell installer.
#
# One-liner from a PowerShell terminal (any version, no admin needed):
#
#   iwr -useb https://raw.githubusercontent.com/peterquads/odylic-lens/main/install.ps1 | iex
#
# What it does:
#   1. Verifies Git, Python 3.11+, and Node.js are installed. Offers to
#      install missing ones via winget when available.
#   2. Clones (or updates) the repo to %USERPROFILE%\odylic-lens.
#   3. Creates a Python venv + pip installs base API deps.
#   4. Runs npm install + npm run build (prebuilt SPA served by the API).
#   5. Writes .env from .env.example with a fresh LENS_SECRET_KEY.
#   6. Creates a Desktop shortcut + Start Menu entry that boots the API
#      and opens http://localhost:8765 in the default browser.
#   7. Installs a `lens` command into %USERPROFILE%\.local\bin and adds
#      that folder to the user PATH so PowerShell can find it.
#
# Idempotent. Re-running pulls latest, re-installs deps, and rebuilds.

$ErrorActionPreference = "Stop"

$RepoUrl     = "https://github.com/peterquads/odylic-lens.git"
$InstallDir  = if ($env:ODYLIC_LENS_DIR) { $env:ODYLIC_LENS_DIR } else { Join-Path $env:USERPROFILE "odylic-lens" }
$UserBinDir  = Join-Path $env:USERPROFILE ".local\bin"

function Write-Step($msg) { Write-Host "→ $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  ✗ $msg" -ForegroundColor Red }

function Ensure-Tool {
    param(
        [string]$Command,
        [string]$WingetId,
        [string]$FriendlyName,
        [string]$InstallUrl
    )
    if (Get-Command $Command -ErrorAction SilentlyContinue) {
        Write-OK "$FriendlyName found"
        return
    }
    Write-Warn "$FriendlyName not found"
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Step "Installing $FriendlyName via winget"
        try {
            winget install --silent --accept-source-agreements --accept-package-agreements --id $WingetId | Out-Null
        } catch {
            Write-Warn "winget install failed: $_"
        }
        # Refresh PATH so the just-installed tool is callable in this session.
        $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
        if (Get-Command $Command -ErrorAction SilentlyContinue) {
            Write-OK "$FriendlyName installed"
            return
        }
    }
    Write-Err "Could not auto-install $FriendlyName. Install it from $InstallUrl and re-run this script."
    exit 1
}

# 1) Prerequisites
Write-Step "Checking prerequisites"
Ensure-Tool -Command "git"    -WingetId "Git.Git"           -FriendlyName "Git"        -InstallUrl "https://git-scm.com/download/win"
Ensure-Tool -Command "python" -WingetId "Python.Python.3.12" -FriendlyName "Python 3.12" -InstallUrl "https://www.python.org/downloads/windows/"
Ensure-Tool -Command "node"   -WingetId "OpenJS.NodeJS.LTS"  -FriendlyName "Node.js LTS" -InstallUrl "https://nodejs.org/en/download"

# Sanity: python >= 3.11
$pyVer = & python --version 2>&1
if ($pyVer -match "Python (\d+)\.(\d+)") {
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]
    if ($major -lt 3 -or ($major -eq 3 -and $minor -lt 11)) {
        Write-Err "Python $pyVer is too old. Need 3.11 or newer."
        exit 1
    }
}

# 2) Clone or update
#
# $env:LENS_SKIP_GIT = "1" short-circuits the clone-or-pull step. Set by
# CI when the workspace is already a checkout (potentially in a detached-
# HEAD state where `git pull --ff-only` would fail) and the installer
# just needs to set up the venv + npm build against the current tree.
if ($env:LENS_SKIP_GIT -eq "1") {
    Write-Step "Skipping clone/pull (LENS_SKIP_GIT=1)"
} elseif (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Step "Updating existing checkout at $InstallDir"
    Push-Location $InstallDir
    try {
        git fetch --quiet
        git pull --ff-only --quiet
    } finally { Pop-Location }
} else {
    Write-Step "Cloning into $InstallDir"
    git clone --quiet $RepoUrl $InstallDir
}

Set-Location $InstallDir

# 3) Backend deps
Write-Step "Installing API dependencies"
Push-Location api
try {
    if (-not (Test-Path "venv")) {
        python -m venv venv
    }
    # Use `python -m pip` for the upgrade step. Calling pip.exe directly
    # to upgrade itself fails on Windows with "To modify pip, please run
    # the following command: ... python.exe -m pip install --upgrade pip"
    # because the running .exe holds an open handle to its own file.
    $venvPython = ".\venv\Scripts\python.exe"
    & $venvPython -m pip install --quiet --upgrade pip
    & $venvPython -m pip install --quiet -e .
} finally { Pop-Location }

# 4) Frontend deps + production build
#
# Pre-build the web bundle here so the desktop launcher can start the
# API alone and serve the SPA from `web/dist/` (FastAPI's StaticFiles
# mount in main.py). Skipping `npm run dev` at launch time turns a
# 15-30s Vite cold-start into a single-process API boot (~2s).
Write-Step "Installing web dependencies"
Push-Location web
try {
    npm install --silent --no-fund --no-audit
    Write-Step "Building web bundle"
    npm run build --silent
} finally { Pop-Location }

# 5) .env
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    # Generate a random 32-byte hex secret
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $secret = ($bytes | ForEach-Object { '{0:x2}' -f $_ }) -join ''
    (Get-Content ".env") -replace '^LENS_SECRET_KEY=.*$', "LENS_SECRET_KEY=$secret" | Set-Content ".env"
    Write-OK "Generated LENS_SECRET_KEY in .env"
}

# 6) Desktop shortcut + Start Menu entry + browser favicon
Write-Step "Generating desktop launcher + Start Menu entry"
& powershell.exe -ExecutionPolicy Bypass -NoProfile -File ".\scripts\make-launcher.ps1"

# 7) Install `lens` CLI into user bin + PATH
Write-Step "Installing 'lens' CLI"
if (-not (Test-Path $UserBinDir)) {
    New-Item -ItemType Directory -Path $UserBinDir -Force | Out-Null
}
Copy-Item ".\scripts\lens.cmd" (Join-Path $UserBinDir "lens.cmd") -Force

# Persist install dir for the .cmd shim
[Environment]::SetEnvironmentVariable("ODYLIC_LENS_DIR", $InstallDir, "User")

# Add user bin to PATH if missing
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if (-not $userPath -or $userPath -notlike "*$UserBinDir*") {
    $newPath = if ($userPath) { "$userPath;$UserBinDir" } else { $UserBinDir }
    [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
    Write-OK "Added $UserBinDir to user PATH (open a new terminal for it to take effect)"
}

Write-Host ""
Write-Host "  ✓ Odylic Lens installed at $InstallDir" -ForegroundColor Green
Write-Host ""
Write-Host "  Next:"
Write-Host "    - Double-click the 'Odylic Lens' shortcut on your Desktop, OR"
Write-Host "    - Open a NEW PowerShell window and run: lens start"
Write-Host "    - Then open http://localhost:8765 in your browser."
Write-Host ""
Write-Host "  First-launch will land you in the onboarding wizard to connect Meta."
Write-Host ""
