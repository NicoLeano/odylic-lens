#!/usr/bin/env bash
# Local validator for the Windows PowerShell scripts. Run before pushing
# changes to install.ps1 / scripts/*.ps1 to avoid burning 2-minute CI
# round-trips on parse-time errors.
#
#   ./scripts/test/check-ps.sh
#
# Auto-downloads a portable PowerShell 7 to $HOME/.local/pwsh on first
# run (~70MB, sudo-free). Uses the AST parser to report syntax errors
# per file with line/column numbers. Exits non-zero if any file fails.
set -eu

PWSH_DIR="$HOME/.local/pwsh"
PWSH_BIN="$PWSH_DIR/pwsh"
PWSH_VER="7.4.6"

# Detect OS + arch for the right portable tarball
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64) URL="https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VER}/powershell-${PWSH_VER}-osx-arm64.tar.gz" ;;
  Darwin-x86_64) URL="https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VER}/powershell-${PWSH_VER}-osx-x64.tar.gz" ;;
  Linux-x86_64) URL="https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VER}/powershell-${PWSH_VER}-linux-x64.tar.gz" ;;
  Linux-aarch64|Linux-arm64) URL="https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VER}/powershell-${PWSH_VER}-linux-arm64.tar.gz" ;;
  *) echo "Unsupported platform: $OS $ARCH" >&2; exit 1 ;;
esac

if [ ! -x "$PWSH_BIN" ]; then
  echo "→ Downloading portable PowerShell $PWSH_VER for $OS-$ARCH"
  mkdir -p "$PWSH_DIR"
  curl -fsSL "$URL" -o "$PWSH_DIR/pwsh.tar.gz"
  tar -xzf "$PWSH_DIR/pwsh.tar.gz" -C "$PWSH_DIR"
  chmod +x "$PWSH_BIN"
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

echo "→ Parse-checking all .ps1 files"
"$PWSH_BIN" -NoProfile -Command "
\$failed = 0
foreach (\$f in @(Get-ChildItem -Recurse -Filter *.ps1 -File | ForEach-Object FullName)) {
  \$errs = \$null
  \$null = [System.Management.Automation.Language.Parser]::ParseFile(\$f, [ref]\$null, [ref]\$errs)
  \$rel = \$f.Substring('$REPO_ROOT'.Length + 1)
  if (\$errs.Count -eq 0) {
    Write-Host (\"  ok   \$rel\")
  } else {
    \$failed += 1
    Write-Host (\"  FAIL \$rel\") -ForegroundColor Red
    foreach (\$e in \$errs) {
      Write-Host (\"       line \" + \$e.Extent.StartLineNumber + \" col \" + \$e.Extent.StartColumnNumber + \": \" + \$e.Message)
    }
  }
}
exit \$failed
"

echo ""
echo "→ Checking line endings (Windows git can mangle here-strings via CRLF)"
mangled=0
for f in $(find . -name "*.ps1" -not -path "./node_modules/*" -not -path "*/venv/*" -not -path "./web/dist/*"); do
  if grep -q $'\r' "$f" 2>/dev/null; then
    echo "  CRLF $f"
    mangled=$((mangled + 1))
  fi
done
if [ $mangled -gt 0 ]; then
  echo ""
  echo "  ✗ Found $mangled file(s) with CRLF. Re-save as LF and ensure"
  echo "    .gitattributes has '*.ps1 text eol=lf'."
  exit 1
fi
echo "  ok   all .ps1 files are LF"

echo ""
echo "✓ All PowerShell pre-push checks passed."
