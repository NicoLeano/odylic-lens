#!/usr/bin/env bash
# Generate a desktop launcher for Odylic Lens.
#
#   macOS  -> ~/Applications/Odylic Lens.app   (double-clickable, Spotlight-able)
#   Linux  -> ~/.local/share/applications/odylic-lens.desktop
#
# The launcher starts the API + Vite dev server in the background and
# opens the web UI in the default browser. Closing the browser does NOT
# kill the servers; use `lens stop` (installed by install.sh) to halt.
#
# Idempotent. re-running overwrites the existing launcher with the
# current version of this script.
set -e

LENS_DIR="${ODYLIC_LENS_DIR:-$HOME/odylic-lens}"
if [ ! -d "$LENS_DIR" ]; then
  echo "✗ $LENS_DIR not found. Run install.sh first."
  exit 1
fi

UNAME="$(uname -s)"

# Shared start command used by every launcher target.
#
# The API mounts `web/dist/` as a static SPA (see main.py spa_fallback),
# so launch only needs to boot one process. If web/dist is missing
# (someone deleted it or skipped the build step), fall back to the
# Vite dev server on :5173 as a safety net.
read -r -d '' START_CMD <<EOF || true
cd "$LENS_DIR"
mkdir -p .run
if [ -f .run/api.pid ]; then kill "\$(cat .run/api.pid)" 2>/dev/null || true; fi
if [ -f .run/web.pid ]; then kill "\$(cat .run/web.pid)" 2>/dev/null || true; fi
# Start API (serves the SPA bundle + /api/*)
(cd api && nohup ./venv/bin/python main.py > "$LENS_DIR/.run/api.log" 2>&1 &
  echo \$! > "$LENS_DIR/.run/api.pid")
# Fallback: if the prebuilt bundle is missing, start Vite dev too.
PORT=8765
if [ ! -f "$LENS_DIR/web/dist/index.html" ]; then
  (cd web && nohup npm run dev > "$LENS_DIR/.run/web.log" 2>&1 &
    echo \$! > "$LENS_DIR/.run/web.pid")
  PORT=5173
fi
# Wait for the chosen port to bind.
for i in {1..40}; do
  if curl -sf "http://localhost:\$PORT/api/status" >/dev/null 2>&1 \
     || curl -sf "http://localhost:\$PORT" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
EOF

case "$UNAME" in
  Darwin)
    APP="$HOME/Applications/Odylic Lens.app"
    mkdir -p "$APP/Contents/MacOS"
    mkdir -p "$APP/Contents/Resources"

    cat > "$APP/Contents/MacOS/launch" <<EOF
#!/usr/bin/env bash
$START_CMD
open "http://localhost:$PORT"
EOF
    chmod +x "$APP/Contents/MacOS/launch"

    cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIdentifier</key><string>com.odylic.lens</string>
  <key>CFBundleName</key><string>Odylic Lens</string>
  <key>CFBundleDisplayName</key><string>Odylic Lens</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.3.0</string>
  <key>CFBundleVersion</key><string>0.3.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><false/>
</dict>
</plist>
PLIST

    # Drop in a tinted icon if one ships with the repo (web/public/odylic-logo.png)
    if [ -f "$LENS_DIR/web/public/odylic-logo.png" ]; then
      cp "$LENS_DIR/web/public/odylic-logo.png" "$APP/Contents/Resources/AppIcon.png" 2>/dev/null || true
    fi

    echo "  ✓ macOS launcher: $APP"
    echo "    Open from Applications, Spotlight, or 'open -a \"Odylic Lens\"'"
    ;;

  Linux)
    DESKTOP="$HOME/.local/share/applications/odylic-lens.desktop"
    mkdir -p "$(dirname "$DESKTOP")"

    LAUNCH="$LENS_DIR/.run/launch.sh"
    mkdir -p "$LENS_DIR/.run"
    cat > "$LAUNCH" <<EOF
#!/usr/bin/env bash
$START_CMD
xdg-open "http://localhost:$PORT"
EOF
    chmod +x "$LAUNCH"

    cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Odylic Lens
Comment=Self-hosted Meta ad creative analysis
Exec=$LAUNCH
Icon=$LENS_DIR/web/public/odylic-logo.png
Terminal=false
Categories=Development;Office;
StartupNotify=true
EOF
    update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    echo "  ✓ Linux launcher: $DESKTOP"
    ;;

  *)
    echo "  ⚠ Unsupported OS ($UNAME). Manual start: $LENS_DIR/start.sh"
    ;;
esac
