#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────
#  Build + sign + notarize Clementine.app locally.
#
#  Reads signing credentials from ~/.clementine-secrets/desktop.env so
#  you don't have to remember/expose them. That file is gitignored.
#
#  Outputs the signed + notarized .dmg to apps/desktop/release/.
# ──────────────────────────────────────────────────────────────────────

SECRETS_FILE="${HOME}/.clementine-secrets/desktop.env"

if [[ ! -f "$SECRETS_FILE" ]]; then
  cat <<EOF
Missing secrets file at: $SECRETS_FILE

Create it with these contents (chmod 600):

  export APPLE_ID="natebreynolds@icloud.com"
  export APPLE_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
  export APPLE_TEAM_ID="4AR3Y8XD72"

Then run this script again.
EOF
  exit 1
fi

# shellcheck disable=SC1090
source "$SECRETS_FILE"

if [[ -z "${APPLE_ID:-}" || -z "${APPLE_APP_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
  echo "Secrets file is missing APPLE_ID, APPLE_APP_PASSWORD, or APPLE_TEAM_ID."
  exit 1
fi

IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"
if [[ "$IDENTITIES" != *"Developer ID Application"*"$APPLE_TEAM_ID"* ]]; then
  cat <<EOF
No Developer ID Application signing identity for team $APPLE_TEAM_ID was found in the current Keychain.

Import the Developer ID Application certificate/private key, unlock the Keychain, then rerun.
EOF
  exit 1
fi

cd "$(dirname "$0")/.."   # apps/desktop

echo "→ Building desktop main process"
npm run build

echo "→ Building daemon (parent project)"
npm run build:daemon

# ──────────────────────────────────────────────────────────────────────
# Rebuild the DAEMON's native modules for Electron's Node ABI.
#
# electron-builder's built-in @electron/rebuild only sees the desktop
# package's node_modules (apps/desktop/node_modules/), so it rebuilds
# keytar but never touches the daemon's better-sqlite3 / fsevents
# living in the repo-root node_modules that gets copied via
# `extraResources`.
#
# Without this step, the installed app's daemon throws
# `NODE_MODULE_VERSION 127 vs 130` on every SQLite touch — memory
# search degrades silently and Codex can return empty completions.
#
# We rebuild against the SAME Electron version electron-builder will
# ship, then restore to the host Node ABI at the end of the script so
# the dev daemon (`npm run daemon`) keeps working.
# ──────────────────────────────────────────────────────────────────────
ELECTRON_VERSION=$(node -e "console.log(require('./node_modules/electron/package.json').version)")
echo "→ Rebuilding daemon native modules for Electron ${ELECTRON_VERSION}"
( cd ../.. && npx @electron/rebuild --version="${ELECTRON_VERSION}" --types=prod )

# Make sure we always restore the host Node ABI on exit, even if the
# script fails — otherwise the user can't run `npm run daemon` from
# source until they `npm rebuild` manually.
restore_host_abi() {
  echo "→ Restoring native modules to host Node ABI (so dev daemon keeps working)"
  ( cd ../.. && npm rebuild better-sqlite3 fsevents 2>&1 ) || true
}
trap restore_host_abi EXIT

echo "→ electron-builder mac (sign + notarize + dmg + zip)"
# CSC_IDENTITY_AUTO_DISCOVERY=true lets electron-builder find the
# Developer ID cert in your local keychain.
#
# electron-builder >=25 reads its own built-in notarize step from
# APPLE_APP_SPECIFIC_PASSWORD (not APPLE_APP_PASSWORD), so we export
# both names. The custom afterSign hook reads APPLE_APP_PASSWORD; the
# built-in step reads APPLE_APP_SPECIFIC_PASSWORD. Setting both keeps
# both code paths happy regardless of which actually fires.
CSC_IDENTITY_AUTO_DISCOVERY=true \
APPLE_ID="$APPLE_ID" \
APPLE_APP_PASSWORD="$APPLE_APP_PASSWORD" \
APPLE_APP_SPECIFIC_PASSWORD="$APPLE_APP_PASSWORD" \
APPLE_TEAM_ID="$APPLE_TEAM_ID" \
npx electron-builder --mac

echo
echo "Done. Artifacts:"
ls -la release/*.dmg release/*.zip 2>/dev/null
