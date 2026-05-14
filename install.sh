#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────
#  Clementine installer  ·  curl -fsSL  …  | bash
#
#  Detects platform, downloads the latest signed Clementine.app from
#  GitHub Releases, mounts the DMG, drag-installs to /Applications,
#  and opens the app.
#
#  Works on macOS today. Windows / Linux paths exist but print a
#  helpful "not yet" message.
# ──────────────────────────────────────────────────────────────────────

REPO="Natebreynolds/clementine-next"
APP_NAME="Clementine"

# ── Colors ────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[1;33m'
  CYAN='\033[0;36m'
  DIM='\033[0;90m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; CYAN=''; DIM=''; BOLD=''; RESET=''
fi

step()  { echo -e "\n${BOLD}→ $1${RESET}"; }
ok()    { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()  { echo -e "  ${YELLOW}!${RESET} $1"; }
fail()  { echo -e "  ${RED}✗${RESET} $1"; exit 1; }
info()  { echo -e "  ${DIM}$1${RESET}"; }

# ── Banner ────────────────────────────────────────────────────────────
echo
echo -e "${CYAN}"
cat << 'BANNER'
   ___  _                       _    _
  / __\| | ___ _ __ ___   ___ _| |_ (_) ___ ___
 / /   | |/ _ \ '_ ` _ \ / _ \_   _|| |/ __/ _ \
/ /___ | |  __/ | | | | |  __/ |_|  | | (_|  __/
\____/ |_|\___|_| |_| |_|\___|       |_|\___\___|

BANNER
echo -e "${RESET}"
info "Personal AI assistant — runs locally, talks via Discord, dashboard, CLI."

# ── Platform detection ────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    if [[ "$ARCH" == "arm64" ]]; then
      ASSET_PATTERN="${APP_NAME}-.*-arm64\\.dmg"
    else
      ASSET_PATTERN="${APP_NAME}-.*(-x64|-amd64)\\.dmg"
    fi
    ;;
  Linux)
    fail "Linux build not yet shipping via this installer. Use 'git clone https://github.com/$REPO.git && cd clementine-next && npm install' for now."
    ;;
  MINGW*|MSYS*|CYGWIN*)
    fail "Windows install not yet shipping via this installer. Use 'git clone https://github.com/$REPO.git' on Windows for now."
    ;;
  *)
    fail "Unsupported OS: $OS"
    ;;
esac

ok "Detected platform: macOS ($ARCH)"

# ── Fetch latest release metadata ─────────────────────────────────────
step "Looking up latest release from $REPO"

if ! command -v curl >/dev/null 2>&1; then
  fail "curl is required."
fi

API_URL="https://api.github.com/repos/${REPO}/releases/latest"
RELEASE_JSON="$(curl -fsSL "$API_URL" || true)"

if [[ -z "$RELEASE_JSON" ]] || echo "$RELEASE_JSON" | grep -q '"message": *"Not Found"'; then
  fail "No published release found at $API_URL. Either the repo has no releases yet, or it's private. If you're the maintainer, run: cd apps/desktop && npm run release"
fi

TAG="$(echo "$RELEASE_JSON" | grep -oE '"tag_name": *"[^"]+' | head -1 | sed 's/.*: *"//')"
ok "Latest release: ${BOLD}${TAG}${RESET}"

# Find the matching DMG asset URL.
ASSET_URL="$(echo "$RELEASE_JSON" \
  | grep -oE '"browser_download_url": *"[^"]+\.dmg"' \
  | sed 's/.*: *"//; s/"$//' \
  | grep -E "$ASSET_PATTERN" \
  | head -1 || true)"

if [[ -z "$ASSET_URL" ]]; then
  fail "Couldn't find a .dmg asset matching '$ASSET_PATTERN' in release $TAG. Available assets:\n$(echo "$RELEASE_JSON" | grep '"name": *"' | grep -oE '"[^"]+\.(dmg|zip)"')"
fi

ok "Asset URL: ${DIM}$ASSET_URL${RESET}"

# ── Download ──────────────────────────────────────────────────────────
TMP_DIR="$(mktemp -d -t clementine-install)"
DMG_PATH="$TMP_DIR/${APP_NAME}.dmg"

step "Downloading installer (~80MB — this may take a minute)"
curl -fL --progress-bar "$ASSET_URL" -o "$DMG_PATH"
ok "Downloaded to $DMG_PATH"

# ── Mount + copy ──────────────────────────────────────────────────────
step "Mounting DMG"
MOUNT_OUTPUT="$(hdiutil attach "$DMG_PATH" -nobrowse -plist)"
MOUNT_POINT="$(echo "$MOUNT_OUTPUT" | grep -A1 '<key>mount-point</key>' | tail -1 | sed -E 's/.*<string>(.+)<\/string>.*/\1/' | head -1)"

if [[ -z "$MOUNT_POINT" || ! -d "$MOUNT_POINT" ]]; then
  fail "Couldn't determine mount point for the DMG."
fi
ok "Mounted at $MOUNT_POINT"

step "Installing to /Applications"
APP_SRC="$MOUNT_POINT/${APP_NAME}.app"
APP_DEST="/Applications/${APP_NAME}.app"

if [[ ! -d "$APP_SRC" ]]; then
  hdiutil detach "$MOUNT_POINT" -quiet || true
  fail "${APP_NAME}.app not found inside the DMG. Aborting."
fi

if [[ -d "$APP_DEST" ]]; then
  warn "${APP_DEST} already exists — overwriting"
  rm -rf "$APP_DEST"
fi

cp -R "$APP_SRC" "$APP_DEST"
ok "Installed at $APP_DEST"

# Unmount and clean up
hdiutil detach "$MOUNT_POINT" -quiet || true
rm -rf "$TMP_DIR"

# ── Quarantine + launch ───────────────────────────────────────────────
# Remove the macOS quarantine xattr so users don't get the "downloaded from
# the internet" prompt — the app is notarized, so this is safe.
xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true

step "Done. Launching Clementine"
open "$APP_DEST"

echo
echo -e "${GREEN}${BOLD}Installation complete.${RESET}"
echo -e "  ${DIM}You can now launch Clementine from /Applications or Spotlight.${RESET}"
echo -e "  ${DIM}First-run setup will guide you through credentials and integrations.${RESET}"
echo
