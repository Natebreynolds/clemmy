#!/usr/bin/env bash
set -euo pipefail

# Hot-patch the installed Clementine.app with fresh dist/ output.
#
# Updates BOTH sides:
#   - Daemon dist  →  /Applications/Clementine.app/Contents/Resources/daemon/dist
#   - Electron dist (inside app.asar) → extract + swap /dist + repack
#
# This avoids waiting for the Squirrel auto-updater to find the next
# GitHub release (~4h cadence). After this runs, launching Clementine
# uses today's code.

REPO=/Users/nathan.reynolds/clementine-next
APP=/Applications/Clementine.app
DAEMON_SRC="$REPO/dist"
DAEMON_DST="$APP/Contents/Resources/daemon/dist"
DESKTOP_SRC="$REPO/apps/desktop/dist"
ASAR="$APP/Contents/Resources/app.asar"
ASAR_EXTRACTED=$(mktemp -d -t clemmy-asar-XXXXXX)

echo "Quitting Clementine if running..."
osascript -e 'tell application "Clementine" to quit' 2>/dev/null || true
sleep 1
pkill -f "/Applications/Clementine.app" 2>/dev/null || true
sleep 1

echo "Replacing daemon dist..."
sudo rm -rf "$DAEMON_DST"
sudo cp -R "$DAEMON_SRC" "$DAEMON_DST"

echo "Patching Electron dist inside app.asar..."
sudo /usr/bin/env npx --yes asar extract "$ASAR" "$ASAR_EXTRACTED"
sudo rm -rf "$ASAR_EXTRACTED/dist"
sudo cp -R "$DESKTOP_SRC" "$ASAR_EXTRACTED/dist"
sudo /usr/bin/env npx --yes asar pack "$ASAR_EXTRACTED" "$ASAR"
sudo rm -rf "$ASAR_EXTRACTED"

echo "Clearing macOS provenance attribute..."
sudo xattr -dr com.apple.provenance "$APP" 2>/dev/null || true

echo "Bumping installed app's Info.plist version label..."
sudo /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 0.4.0" "$APP/Contents/Info.plist" 2>/dev/null || true
sudo /usr/libexec/PlistBuddy -c "Set :CFBundleVersion 0.4.0" "$APP/Contents/Info.plist" 2>/dev/null || true

echo ""
echo "Patched. Launch with: open -a Clementine"
