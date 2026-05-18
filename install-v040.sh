#!/usr/bin/env bash
set -euo pipefail

DMG="$HOME/Downloads/Clementine-0.4.0-arm64.dmg"
APP_SRC=""
MOUNT_POINT=""

cleanup() {
  if [ -n "$MOUNT_POINT" ] && [ -d "$MOUNT_POINT" ]; then
    echo "Unmounting DMG..."
    hdiutil detach "$MOUNT_POINT" -force >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "1/5 · Quitting Clementine if running..."
osascript -e 'tell application "Clementine" to quit' 2>/dev/null || true
sleep 1
pkill -f "/Applications/Clementine.app" 2>/dev/null || true
sleep 1

echo "2/5 · Mounting DMG..."
MOUNT_INFO=$(hdiutil attach "$DMG" -nobrowse -readonly | tail -1)
MOUNT_POINT=$(echo "$MOUNT_INFO" | awk -F'\t' '{print $NF}' | sed 's/^[[:space:]]*//')
if [ -z "$MOUNT_POINT" ] || [ ! -d "$MOUNT_POINT" ]; then
  echo "  Failed to determine mount point. Got: $MOUNT_INFO"
  exit 1
fi
echo "  Mounted at: $MOUNT_POINT"

APP_SRC="$MOUNT_POINT/Clementine.app"
if [ ! -d "$APP_SRC" ]; then
  echo "  Clementine.app not found at $APP_SRC"
  exit 1
fi

echo "3/5 · Removing old /Applications/Clementine.app..."
sudo rm -rf /Applications/Clementine.app

echo "4/5 · Copying v0.4.0 into /Applications..."
sudo cp -R "$APP_SRC" /Applications/Clementine.app

echo "5/5 · Clearing quarantine..."
sudo xattr -dr com.apple.quarantine /Applications/Clementine.app 2>/dev/null || true

echo ""
echo "Done. Launch with:  open -a Clementine"
echo "Or:  open /Applications/Clementine.app"
