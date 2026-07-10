#!/usr/bin/env bash
# Build the daemon, patch a staged copy of Clementine.app, sign + notarize it,
# then promote that exact validated bundle into /Applications.
#
# The canonical app is never edited in place. A failure before promotion leaves
# it untouched; a failure after promotion restores the complete previous app.
# This is intentionally slower than a raw rsync because a modified macOS bundle
# is not launchable until its new resource seal has been notarized and stapled.
#
# Scope: daemon dist, the daemon package version, and the approved pure-JS
# @openai/agents* + zod packages. Desktop app.asar and native modules are not
# rebuilt or replaced.

set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLED_APP="${CLEMENTINE_APP_PATH:-/Applications/Clementine.app}"
APP_DIR="$(dirname "$INSTALLED_APP")"
APP_NAME="$(basename "$INSTALLED_APP")"
INSTALLED_DIST="$INSTALLED_APP/Contents/Resources/daemon/dist"
ENTITLEMENTS="$REPO_ROOT/apps/desktop/build/entitlements.mac.plist"
NOTARY_PROFILE="${CLEMENTINE_NOTARY_PROFILE:-ClementineNotary}"
LOCK_DIR="${TMPDIR:-/tmp}/clementine-hotpatch.lock"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Hotpatch already running (lock: $LOCK_DIR)"
  exit 1
fi

BACKUP="$(mktemp -d "${TMPDIR:-/tmp}/clemmy-hotpatch.XXXXXX")"
STAGED_APP="$APP_DIR/.${APP_NAME%.app}-hotpatch-$$.app"
PREVIOUS_APP="$BACKUP/$APP_NAME"
FAILED_APP="$BACKUP/${APP_NAME%.app}-failed.app"
ARCHIVE="$BACKUP/notary-upload.zip"
NOTARY_RESULT="$BACKUP/notary-result.json"
OLD_MOVED=0
PROMOTED=0

stop_installed_app() {
  killall Clementine 2>/dev/null || true
  for _ in {1..20}; do
    if ! pgrep -f "^${INSTALLED_APP}/Contents/" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  pkill -KILL -f "^${INSTALLED_APP}/Contents/" 2>/dev/null || true
}

on_exit() {
  local rc=$?
  trap - EXIT INT TERM

  if (( rc != 0 )); then
    if (( PROMOTED == 1 )); then
      echo
      echo "Hotpatch failed after promotion; restoring the previous complete app..."
      stop_installed_app
      if [[ -d "$INSTALLED_APP" ]]; then mv "$INSTALLED_APP" "$FAILED_APP" || true; fi
      if [[ -d "$PREVIOUS_APP" ]]; then mv "$PREVIOUS_APP" "$INSTALLED_APP" || true; fi
      open -n "$INSTALLED_APP" 2>/dev/null || true
    elif (( OLD_MOVED == 1 )) && [[ ! -d "$INSTALLED_APP" ]] && [[ -d "$PREVIOUS_APP" ]]; then
      mv "$PREVIOUS_APP" "$INSTALLED_APP" || true
    fi
  fi

  rm -rf "$STAGED_APP"
  rm -f "$ARCHIVE"
  rmdir "$LOCK_DIR" 2>/dev/null || true
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

for command in node npm rsync security codesign ditto xcrun spctl curl; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command"; exit 1; }
done

if [[ ! -d "$INSTALLED_DIST" ]]; then
  echo "$INSTALLED_DIST not found"
  echo "Install Clementine at $INSTALLED_APP first."
  exit 1
fi
if [[ ! -f "$ENTITLEMENTS" ]]; then
  echo "Missing desktop entitlements: $ENTITLEMENTS"
  exit 1
fi
if [[ ! -w "$APP_DIR" ]]; then
  echo "$APP_DIR is not writable by the current user."
  echo "Repair Clementine ownership from the app's updater menu, then retry."
  exit 1
fi

IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
  | sed -nE 's/^[[:space:]]*[0-9]+\) [0-9A-F]+ "([^"]*Developer ID Application[^"]*)".*/\1/p' \
  | head -n 1 || true)"
if [[ -z "$IDENTITY" ]]; then
  echo "No Developer ID Application signing identity was found in Keychain."
  exit 1
fi
TEAM_ID="$(printf '%s\n' "$IDENTITY" | sed -nE 's/.*\(([A-Z0-9]{10})\)$/\1/p')"
if [[ -z "$TEAM_ID" ]]; then
  echo "Could not derive the Apple team id from signing identity: $IDENTITY"
  exit 1
fi
if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" --output-format json >/dev/null 2>&1; then
  echo "Missing or invalid notarytool Keychain profile: $NOTARY_PROFILE"
  echo "Create it once with: xcrun notarytool store-credentials \"$NOTARY_PROFILE\""
  exit 1
fi

echo "-> Building fresh daemon dist"
(cd "$REPO_ROOT" && npm run build) | tail -n 4

LOCAL_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
echo "-> Stopping the installed app before cloning its signed bundle"
stop_installed_app

echo "-> Verifying the source app"
codesign --verify --deep --strict --verbose=1 "$INSTALLED_APP"
spctl --assess --type execute --verbose=4 "$INSTALLED_APP"

echo "-> Cloning the complete app into a private staging path"
rm -rf "$STAGED_APP"
if ! cp -cR "$INSTALLED_APP" "$STAGED_APP" 2>/dev/null; then
  rm -rf "$STAGED_APP"
  ditto "$INSTALLED_APP" "$STAGED_APP"
fi

STAGED_DAEMON="$STAGED_APP/Contents/Resources/daemon"
STAGED_DIST="$STAGED_DAEMON/dist"
STAGED_NM="$STAGED_DAEMON/node_modules"

echo "-> Syncing daemon dist into the staged app"
CHANGES="$(rsync -a --delete --exclude='.DS_Store' --itemize-changes \
  "$REPO_ROOT/dist/" "$STAGED_DIST/" \
  | tee "$BACKUP/rsync.log" | wc -l | tr -d ' ')"
echo "   $CHANGES dist file(s) changed or removed"

# Keep the daemon's runtime banner honest without pretending the unchanged
# Electron shell was rebuilt. Only the daemon package metadata is updated.
node - "$STAGED_DAEMON/package.json" "$LOCAL_VERSION" <<'NODE'
const fs = require('node:fs');
const [file, version] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.version = version;
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
NODE

echo "-> Syncing approved pure-JS runtime packages when versions differ"
SYNCED_PACKAGE_DIRS=()
for pkg in @openai/agents @openai/agents-core @openai/agents-openai @openai/agents-realtime zod; do
  local_pkg="$REPO_ROOT/node_modules/$pkg"
  staged_pkg="$STAGED_NM/$pkg"
  [[ -d "$local_pkg" ]] || continue
  local_v="$(node -e "try{console.log(require('$local_pkg/package.json').version)}catch{}" 2>/dev/null)"
  staged_v="$(node -e "try{console.log(require('$staged_pkg/package.json').version)}catch{}" 2>/dev/null)"
  if [[ -n "$local_v" && "$local_v" != "$staged_v" ]]; then
    mkdir -p "$(dirname "$staged_pkg")"
    rsync -a --delete "$local_pkg/" "$staged_pkg/"
    echo "   $pkg -> $local_v (was ${staged_v:-missing})"
  else
    echo "   $pkg already at $local_v"
  fi
  SYNCED_PACKAGE_DIRS+=("$staged_pkg")
done

# These package syncs are allowed only because they are portable JS. A newly
# introduced native executable would require the full desktop packaging path.
for package_dir in "${SYNCED_PACKAGE_DIRS[@]}"; do
  if [[ -d "$package_dir" ]] && find "$package_dir" -type f -print0 \
    | xargs -0 file 2>/dev/null | grep 'Mach-O' > "$BACKUP/macho-scan"; then
    echo "Refusing hotpatch: a synced package contains a Mach-O binary: $package_dir"
    exit 1
  fi
done

echo "-> Signing the staged app with hardened runtime"
codesign --force \
  --sign "$IDENTITY" \
  --options runtime \
  --timestamp \
  --entitlements "$ENTITLEMENTS" \
  "$STAGED_APP"

RUNTIME_BINARIES=(
  "$STAGED_APP/Contents/MacOS/Clementine"
  "$STAGED_APP/Contents/Frameworks/Clementine Helper.app/Contents/MacOS/Clementine Helper"
  "$STAGED_APP/Contents/Frameworks/Clementine Helper (GPU).app/Contents/MacOS/Clementine Helper (GPU)"
  "$STAGED_APP/Contents/Frameworks/Clementine Helper (Plugin).app/Contents/MacOS/Clementine Helper (Plugin)"
  "$STAGED_APP/Contents/Frameworks/Clementine Helper (Renderer).app/Contents/MacOS/Clementine Helper (Renderer)"
  "$STAGED_APP/Contents/Frameworks/Electron Framework.framework/Versions/Current/Helpers/chrome_crashpad_handler"
)
for binary in "${RUNTIME_BINARIES[@]}"; do
  [[ -e "$binary" ]] || { echo "Missing signed runtime binary: $binary"; exit 1; }
  signature_details="$(codesign -dvv "$binary" 2>&1)"
  [[ "$signature_details" == *"flags="*"runtime"* ]] \
    || { echo "Hardened runtime missing: $binary"; exit 1; }
done
signature_details="$(codesign -dvvv "$STAGED_APP" 2>&1)"
[[ "$signature_details" == *"TeamIdentifier=$TEAM_ID"* ]] \
  || { echo "Unexpected signing team on staged app"; exit 1; }
codesign --verify --deep --strict --verbose=2 "$STAGED_APP"

echo "-> Archiving and submitting to Apple notarization (this can take several minutes)"
ditto -c -k --keepParent "$STAGED_APP" "$ARCHIVE"
xcrun notarytool submit "$ARCHIVE" \
  --keychain-profile "$NOTARY_PROFILE" \
  --wait \
  --timeout 30m \
  --output-format json > "$NOTARY_RESULT"

NOTARY_STATUS="$(node -e "const d=require('$NOTARY_RESULT'); console.log(d.status || '')")"
SUBMISSION_ID="$(node -e "const d=require('$NOTARY_RESULT'); console.log(d.id || '')")"
if [[ "$NOTARY_STATUS" != "Accepted" ]]; then
  [[ -n "$SUBMISSION_ID" ]] \
    && xcrun notarytool log "$SUBMISSION_ID" "$BACKUP/notary-log.json" \
      --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 || true
  echo "Apple notarization did not accept the staged app (status: ${NOTARY_STATUS:-unknown})."
  echo "Submission diagnostics: $BACKUP/notary-log.json"
  exit 1
fi

echo "-> Stapling and validating the accepted app"
xcrun stapler staple "$STAGED_APP"
xcrun stapler validate "$STAGED_APP"
codesign --verify --deep --strict --verbose=2 "$STAGED_APP"
spctl --assess --type execute --verbose=4 "$STAGED_APP"
if command -v syspolicy_check >/dev/null 2>&1; then
  syspolicy_check distribution "$STAGED_APP"
fi

# Exercise the exact packaged CLI discovery module from the packaged daemon cwd.
# It must remain stat-only and leave the signed bundle byte-identical.
echo "-> Exercising packaged CLI discovery without executing PATH binaries"
(
  cd "$STAGED_DAEMON"
  ELECTRON_RUN_AS_NODE=1 "$STAGED_APP/Contents/MacOS/Clementine" \
    --input-type=module \
    -e "const m=await import('./dist/runtime/cli-discovery.js'); await m.fullScan({concurrency:1});"
)
codesign --verify --deep --strict --verbose=2 "$STAGED_APP"

echo "-> Promoting the exact validated staged inode"
mv "$INSTALLED_APP" "$PREVIOUS_APP"
OLD_MOVED=1
if ! mv "$STAGED_APP" "$INSTALLED_APP"; then
  mv "$PREVIOUS_APP" "$INSTALLED_APP"
  OLD_MOVED=0
  exit 1
fi
PROMOTED=1

xcrun stapler validate "$INSTALLED_APP"
codesign --verify --deep --strict --verbose=2 "$INSTALLED_APP"
spctl --assess --type execute --verbose=4 "$INSTALLED_APP"

echo "-> Launching the promoted app and waiting for daemon health"
open -n "$INSTALLED_APP"
HEALTHY=0
for i in {1..36}; do
  code="$(curl -sS -o "$BACKUP/health-body" -w '%{http_code}' --max-time 2 \
    http://127.0.0.1:8520/api/status 2>/dev/null || true)"
  if [[ "$code" == "200" ]]; then
    echo "   daemon healthy after $((i * 5))s"
    HEALTHY=1
    break
  fi
  sleep 5
done
if (( HEALTHY == 0 )); then
  echo "Promoted daemon did not become healthy within 180 seconds."
  exit 1
fi

# Final launch-time assessment. The previous fullScan implementation mutated
# the app after signing; this must remain green after the packaged probe + boot.
codesign --verify --deep --strict --verbose=2 "$INSTALLED_APP"
spctl --assess --type execute --verbose=4 "$INSTALLED_APP"

echo
echo "Hotpatch complete: daemon code v$LOCAL_VERSION is running."
echo "Previous complete app retained at: $PREVIOUS_APP"
echo "Diagnostics retained at: $BACKUP"
echo
echo "Revert:"
echo "  killall Clementine"
echo "  mv \"$INSTALLED_APP\" \"$FAILED_APP\""
echo "  mv \"$PREVIOUS_APP\" \"$INSTALLED_APP\""
echo "  open -n \"$INSTALLED_APP\""
