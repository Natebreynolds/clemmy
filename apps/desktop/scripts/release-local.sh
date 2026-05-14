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

cd "$(dirname "$0")/.."   # apps/desktop

echo "→ Building desktop main process"
npm run build

echo "→ Building daemon (parent project)"
npm run build:daemon

echo "→ electron-builder mac (sign + notarize + dmg + zip)"
# CSC_IDENTITY_AUTO_DISCOVERY=true lets electron-builder find the
# Developer ID cert in your local keychain.
CSC_IDENTITY_AUTO_DISCOVERY=true \
APPLE_ID="$APPLE_ID" \
APPLE_APP_PASSWORD="$APPLE_APP_PASSWORD" \
APPLE_TEAM_ID="$APPLE_TEAM_ID" \
npx electron-builder --mac

echo
echo "Done. Artifacts:"
ls -la release/*.dmg release/*.zip 2>/dev/null
