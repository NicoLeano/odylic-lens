# `lens` CLI for Windows. Installed by install.ps1 — the .cmd wrapper
# in %USERPROFILE%\.local\bin shells out to here.
#
#   lens start              start API in the background
#   lens stop               stop it
#   lens restart            stop + start
#   lens status             show pid + port state
#   lens update             git pull + reinstall deps + rebuild + restart
#   lens logs               tail the API log

$ErrorActionPreference = "Stop"

$LensDir = if ($env:ODYLIC_LENS_DIR) { $env:ODYLIC_LENS_DIR } else { Join-Path $env:USERPROFILE "odylic-lens" }
$RunDir  = Join-Path $LensDir ".run"
if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Path $RunDir -Force | Out-Null }

$ApiPidFile = Join-Path $RunDir "api.pid"
$ApiLogFile = Join-Path $RunDir "api.log"
$PythonExe  = Join-Path $LensDir "api\venv\Scripts\python.exe"

function Is-Alive($pidFile) {
    if (-not (Test-Path $pidFile)) { return $false }
    $procId = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
    if (-not $procId) { return $false }
    try {
        $p = Get-Process -Id [int]$procId -ErrorAction Stop
        return $true
    } catch { return $false }
}

function Cmd-Start {
    if (Is-Alive $ApiPidFile) {
        $existingPid = (Get-Content $ApiPidFile).Trim()
        Write-Host "  api already running (pid $existingPid)"
    } else {
        if (-not (Test-Path $PythonExe)) {
            Write-Host "  ! venv missing at $PythonExe. Run install.ps1 first." -ForegroundColor Yellow
            exit 1
        }
        Push-Location (Join-Path $LensDir "api")
        try {
            # Start detached + redirect both streams to api.log
            $p = Start-Process -FilePath $PythonExe -ArgumentList "main.py" `
                -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput $ApiLogFile `
                -RedirectStandardError  (Join-Path $RunDir "api.err.log")
            $p.Id | Out-File $ApiPidFile -Encoding ascii -NoNewline
            Write-Host "  api → http://localhost:8765"
        } finally { Pop-Location }
    }
    if (Test-Path (Join-Path $LensDir "web\dist\index.html")) {
        Write-Host "  ui  → http://localhost:8765  (served by API from prebuilt bundle)"
    } else {
        Write-Host "  ! web/dist missing. Run 'lens update' to rebuild." -ForegroundColor Yellow
    }
}

function Cmd-Stop {
    if (Is-Alive $ApiPidFile) {
        $procId = (Get-Content $ApiPidFile).Trim()
        try {
            Stop-Process -Id [int]$procId -Force -ErrorAction Stop
            Write-Host "  api stopped"
        } catch {
            Write-Host "  ! failed to stop pid $procId : $_" -ForegroundColor Yellow
        }
    }
    Remove-Item $ApiPidFile -ErrorAction SilentlyContinue
}

function Cmd-Status {
    if (Is-Alive $ApiPidFile) {
        $procId = (Get-Content $ApiPidFile).Trim()
        Write-Host "  api: running (pid $procId)"
    } else {
        Write-Host "  api: stopped"
    }
    # Show which port is bound
    $conn = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        Write-Host "  port 8765: pid $($conn.OwningProcess)"
    }
}

function Cmd-Update {
    Set-Location $LensDir
    Write-Host "  fetching..."
    git fetch --quiet
    $local  = (git rev-parse HEAD).Trim()
    $remote = (git rev-parse '@{u}' 2>$null)
    if ($remote) { $remote = $remote.Trim() } else { $remote = $local }
    if ($local -eq $remote) {
        Write-Host "  already up to date ($local)"
        return
    }
    Write-Host "  $local → $remote"
    Cmd-Stop
    git pull --ff-only --quiet
    Write-Host "  refreshing api deps..."
    Push-Location api
    try {
        & .\venv\Scripts\pip.exe install --quiet -e .
    } finally { Pop-Location }
    Write-Host "  refreshing web deps..."
    Push-Location web
    try {
        npm install --silent --no-fund --no-audit
        Write-Host "  rebuilding web..."
        npm run build --silent
    } finally { Pop-Location }
    Cmd-Start
    Write-Host "  ✓ updated."
}

function Cmd-Logs {
    if (-not (Test-Path $ApiLogFile)) {
        Write-Host "  no log at $ApiLogFile"
        exit 1
    }
    Get-Content $ApiLogFile -Tail 200 -Wait
}

function Cmd-Help {
@"
  lens start              start API in background
  lens stop               stop it
  lens restart            stop + start
  lens status             show pid + port state
  lens update             git pull + reinstall + rebuild + restart
  lens logs               tail the API log

  Install dir: $LensDir  (override with ODYLIC_LENS_DIR=...)
"@
}

$cmd = if ($args.Count -gt 0) { $args[0] } else { "help" }
switch ($cmd) {
    "start"   { Cmd-Start }
    "stop"    { Cmd-Stop }
    "restart" { Cmd-Stop; Cmd-Start }
    "status"  { Cmd-Status }
    "update"  { Cmd-Update }
    "logs"    { Cmd-Logs }
    default   { Cmd-Help }
}
