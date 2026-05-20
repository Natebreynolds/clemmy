#!/usr/bin/env bash
# Capture the frontmost Clementine window into apps/web/public/screenshots/<name>.png
#
# Usage:
#   ./scripts/capture.sh dashboard
#   ./scripts/capture.sh approval
#   ./scripts/capture.sh mcp
#   ./scripts/capture.sh tool-stream
#   ./scripts/capture.sh memory
#
# Open Clementine, navigate to the state you want, then run this from apps/web/.

set -euo pipefail

NAME="${1:-}"
if [[ -z "$NAME" ]]; then
  echo "usage: $0 <name>   (dashboard|voice|discord|webhook|approval|mcp|tool-stream|memory)" >&2
  echo "   or: $0 demo-video   (records a 10s video of the Clementine window → clementine-demo.mp4)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$NAME" == "demo-video" ]]; then
  OUT="$SCRIPT_DIR/../public/clementine-demo.mp4"
  echo "Capturing 10s of Clementine. Use the app naturally while it records…"
  osascript -e 'tell application "Clementine" to activate' >/dev/null 2>&1 || true
  sleep 1
  # screencapture -v records video; -V sets duration in seconds.
  screencapture -v -V 10 "$OUT"
  echo "saved → $OUT"
  exit 0
fi

OUT_DIR="$SCRIPT_DIR/../public/screenshots"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/${NAME}.png"

# Bring Clementine to the front
osascript -e 'tell application "Clementine" to activate' >/dev/null 2>&1 || true
sleep 0.6

# Find the frontmost window of the Clementine process. Returns "x,y,w,h".
BOUNDS="$(osascript <<'OSA'
tell application "System Events"
  tell process "Clementine"
    if (count of windows) = 0 then return ""
    set w to window 1
    set p to position of w
    set s to size of w
    return ((item 1 of p) as text) & "," & ((item 2 of p) as text) & "," & ((item 1 of s) as text) & "," & ((item 2 of s) as text)
  end tell
end tell
OSA
)"

if [[ -z "$BOUNDS" ]]; then
  echo "No Clementine window found. Click the menu-bar icon to open the dashboard, then re-run." >&2
  exit 2
fi

# screencapture -R takes x,y,w,h. Add a small inset to drop the title bar shadow.
IFS=',' read -r X Y W H <<<"$BOUNDS"
screencapture -R "${X},${Y},${W},${H}" -o -x "$OUT"

# Re-encode to compress a bit and strip alpha for marketing use.
if command -v sips >/dev/null 2>&1; then
  sips -s format png "$OUT" --out "$OUT" >/dev/null
fi

echo "captured → $OUT  ($(wc -c <"$OUT" | tr -d ' ') bytes, ${W}×${H})"
