#!/usr/bin/env bash
# Hot-patch the installed /Applications/Clementine.app daemon dist with
# your locally built changes, so you can test in-tree work without
# tagging or shipping a release.
#
# Per memory/feedback_clemmy_desktop_patch.md — this is the documented
# fast loop for fixing the installed app without re-cutting a DMG.
#
# STRATEGY (since 2026-06-11): full `rsync --delete` of dist/ — NOT a
# curated file list. The curated list failed in production: it copied a
# new brackets.js whose import (runtime/harness/grounding-gate.js) was
# not on the list → ERR_MODULE_NOT_FOUND → daemon crash-loop. A file
# list can never track the import graph; syncing the whole tree can.
# dist/ is pure tsc-emitted JS, byte-portable across architectures, so
# a full sync is always safe. --delete removes orphaned modules from
# superseded releases (leaving them creates mixed-state bundles).
#
# Scope: syncs the daemon dist/ ONLY. Does NOT touch:
#   - the Electron main process (apps/desktop, app.asar)
#   - native modules (better-sqlite3, keytar) — NEVER sync node_modules
#     wholesale: the app's Electron is x86_64; local builds are arm64.
#     Clobbering a native .node = ERR_DLOPEN_FAILED crash-loop (see
#     memory/project_hotpatch_arch_footgun.md).
#   - signing / notarization metadata
#
# A full timestamped backup of the previous installed dist is written
# to /tmp first; the revert command is printed at the end.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLED_DIST="/Applications/Clementine.app/Contents/Resources/daemon/dist"

if [[ ! -d "$INSTALLED_DIST" ]]; then
  echo "✗ $INSTALLED_DIST not found"
  echo "  Is Clementine installed at /Applications/Clementine.app?"
  exit 1
fi

# Bundle must be user-writable. If it isn't, the dashboard's "Repair
# ownership & enable updates" flow handles that — direct user there.
if [[ ! -w "$INSTALLED_DIST" ]]; then
  echo "✗ $INSTALLED_DIST is not writable by you"
  echo "  Open Clementine → tray menu → Repair ownership & enable updates"
  echo "  then re-run this script."
  exit 1
fi

# Make sure the local dist is freshly built so we don't ship stale JS.
if [[ ! -f "$REPO_ROOT/dist/index.js" ]] || \
   [[ -n "$(find "$REPO_ROOT/src" -name '*.ts' -newer "$REPO_ROOT/dist/index.js" -print -quit 2>/dev/null)" ]]; then
  echo "→ Local dist is missing or stale — rebuilding..."
  (cd "$REPO_ROOT" && npm run build) | tail -3
fi

# Full backup of the installed dist so any problem is a one-command revert.
BACKUP="/tmp/clemmy-hotpatch-$(date +%Y%m%d-%H%M%S)"
echo "→ Backing up installed dist to $BACKUP/dist"
mkdir -p "$BACKUP"
cp -R "$INSTALLED_DIST" "$BACKUP/dist"

# Full sync: copy changed/new files, delete orphans, skip junk.
echo "→ Syncing full dist (rsync --delete):"
CHANGES=$(rsync -a --delete --exclude='.DS_Store' --itemize-changes \
  "$REPO_ROOT/dist/" "$INSTALLED_DIST/" | tee /tmp/clemmy-hotpatch-last-sync.log | wc -l | tr -d ' ')
echo "  ✓ $CHANGES file(s) changed/removed (details: /tmp/clemmy-hotpatch-last-sync.log)"

# Sync @openai/agents* + zod packages to the installed app's
# node_modules ONLY when the version differs (these are pure-JS
# packages — never native modules). SDK 0.11.5 needs zod 4 in lockstep
# with the built dist; a zod-4-built daemon on zod 3 crashes during
# agents-core schema handling.
INSTALLED_NM="$(dirname "$INSTALLED_DIST")/node_modules"
echo
echo "→ Checking @openai/agents* + zod package sync"
for pkg in @openai/agents @openai/agents-core @openai/agents-openai @openai/agents-realtime zod; do
  local_pkg="$REPO_ROOT/node_modules/$pkg"
  installed_pkg="$INSTALLED_NM/$pkg"
  if [[ ! -d "$local_pkg" ]]; then continue; fi
  local_v=$(node -e "try{console.log(require('$local_pkg/package.json').version)}catch{}" 2>/dev/null)
  installed_v=$(node -e "try{console.log(require('$installed_pkg/package.json').version)}catch{}" 2>/dev/null)
  if [[ "$local_v" != "$installed_v" && -n "$local_v" ]]; then
    [[ -d "$installed_pkg" ]] && rm -rf "$installed_pkg"
    cp -R "$local_pkg" "$installed_pkg"
    echo "  ✓ $pkg → $local_v (was $installed_v)"
  else
    echo "  · $pkg already at $local_v (no copy)"
  fi
done

echo
echo "──────────────────────────────────────────────────────────────"
echo "Patch applied. Next steps:"
echo
echo "  1. killall Clementine && open -a Clementine"
echo "  2. Wait ~20-90s, then verify: curl -s -o /dev/null -w '%{http_code}' http://localhost:8520/"
echo "     (404 = healthy; the daemon auth-gates everything else)"
echo "  3. Tail ~/.clementine-next/logs/desktop/supervisor.log if it doesn't come up."
echo
echo "Revert if anything goes sideways:"
echo "  rsync -a --delete \"$BACKUP/dist/\" \"$INSTALLED_DIST/\""
echo "  killall Clementine && open -a Clementine"
echo "──────────────────────────────────────────────────────────────"
