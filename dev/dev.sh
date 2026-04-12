#!/bin/bash
# Workspace dev mode — launches one shared Chrome for all registered plugins,
# then starts the central error-loop orchestrator.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="$SCRIPT_DIR/registry.json"
PROFILE_DIR="$SCRIPT_DIR/.chrome-dev-profile"

# ── Read cdpPort from registry.json (default 9222) ───────────────────────────
if command -v node &>/dev/null && [ -f "$REGISTRY" ]; then
  DEBUG_PORT=$(node -e "const r=require('$REGISTRY'); console.log(r.cdpPort||9222)")
else
  DEBUG_PORT=9222
fi

# ── Detect Chrome binary ──────────────────────────────────────────────────────
detect_chrome() {
  case "$(uname -s)" in
    Darwin)
      for p in \
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
        [ -x "$p" ] && echo "$p" && return
      done
      ;;
    Linux)
      for p in google-chrome google-chrome-stable chromium chromium-browser; do
        command -v "$p" &>/dev/null && echo "$p" && return
      done
      ;;
    MINGW*|MSYS*|CYGWIN*)
      for p in \
        "/c/Program Files/Google/Chrome/Application/chrome.exe" \
        "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"; do
        [ -x "$p" ] && echo "$p" && return
      done
      ;;
  esac
  echo ""
}

# ── Detect open-port command ──────────────────────────────────────────────────
port_in_use() {
  local port=$1
  if command -v lsof &>/dev/null; then
    lsof -i :"$port" -sTCP:LISTEN &>/dev/null
  elif command -v ss &>/dev/null; then
    ss -ltn | grep -q ":$port "
  else
    netstat -ltn 2>/dev/null | grep -q ":$port "
  fi
}

# ── Launch Chrome if not already running ─────────────────────────────────────
if port_in_use "$DEBUG_PORT"; then
  echo "Chrome already running on port $DEBUG_PORT — attaching."
else
  CHROME=$(detect_chrome)
  if [ -z "$CHROME" ]; then
    echo "Error: Could not find Chrome or Chromium."
    echo "  macOS:  install Google Chrome from https://www.google.com/chrome"
    echo "  Linux:  sudo apt install chromium-browser"
    exit 1
  fi

  echo "Launching Chrome on debug port $DEBUG_PORT…"
  mkdir -p "$PROFILE_DIR"
  "$CHROME" \
    --remote-debugging-port="$DEBUG_PORT" \
    --user-data-dir="$PROFILE_DIR" \
    --no-first-run \
    --no-default-browser-check \
    &

  echo "Waiting for Chrome…"
  for i in $(seq 1 20); do
    if curl -s "http://localhost:$DEBUG_PORT/json" > /dev/null 2>&1; then
      echo "Chrome ready."; break
    fi
    sleep 0.5
  done
fi

echo ""
echo "---------------------------------------------------------------"
echo "  Load each extension if not already loaded:"
echo "  chrome://extensions → Load unpacked → select extension/ folder"
echo ""
echo "  Registered plugins:"
node -e "
  const r = require('$REGISTRY');
  const path = require('path');
  r.plugins.forEach(p => {
    const dir = path.resolve('$SCRIPT_DIR', p.path);
    try {
      const cfg = require(dir + '/dev.config.json');
      console.log('    ' + (cfg.name || p.path).padEnd(14) + dir + '/extension');
    } catch {
      console.log('    (missing dev.config.json)  ' + dir + '/extension');
    }
  });
"
echo "---------------------------------------------------------------"
echo ""

node "$SCRIPT_DIR/error-loop.js"
