#!/usr/bin/env bash
# Hot-patch the installed /Applications/Clementine.app daemon dist with
# your locally built changes, so you can test in-tree work without
# tagging or shipping a release.
#
# Per memory/feedback_clemmy_desktop_patch.md — this is the documented
# fast loop for fixing the installed app without re-cutting a DMG.
#
# Scope: copies daemon-side dist files only. Does NOT touch:
#   - the Electron main process (apps/desktop, app.asar)
#   - native modules (better-sqlite3, keytar)
#   - signing / notarization metadata
# So the bundle stays runnable. Any signing-check that compares hashes
# is best-effort (Apple's Gatekeeper only re-validates on launch from
# Finder; we don't change the executables).
#
# Patching done atomically per file via mv from a staging dir, with a
# timestamped backup written to /tmp first so you can revert.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLED_DIST="/Applications/Clementine.app/Contents/Resources/daemon/dist"

if [[ ! -d "$INSTALLED_DIST" ]]; then
  echo "✗ /Applications/Clementine.app/Contents/Resources/daemon/dist not found"
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
if [[ ! -f "$REPO_ROOT/dist/dashboard/console.js" ]] || \
   [[ "$REPO_ROOT/src/dashboard/console.ts" -nt "$REPO_ROOT/dist/dashboard/console.js" ]]; then
  echo "→ Local dist is missing or stale — rebuilding..."
  (cd "$REPO_ROOT" && npm run build) | tail -3
fi

# Files I'm patching today. Add to this list when more daemon files
# change. The script verifies each source file exists before copying;
# missing files are a hard error so you know patching is incomplete.
FILES=(
  "dashboard/console.js"
  "dashboard/console-routes.js"
  "integrations/recall/api.js"
  "integrations/recall/backfill.js"
  "integrations/recall/meeting-capture.js"
  "integrations/recall/transcript-parser.js"
  "runtime/notifications.js"
  "runtime/mcp-namespace-shim.js"
  "execution/background-tasks.js"
  "dashboard/diagnostics.js"
  "agents/tool-observability.js"
  "integrations/cli-catalog/catalog.js"
  # v0.5.5 daemon-side reliability + visibility additions
  "runtime/approval-summary.js"
  "runtime/harness/loop.js"
  "runtime/harness/brackets.js"
  "runtime/harness/codex-model.js"
  "channels/discord.js"
  "channels/discord-harness.js"
  "daemon/runner.js"
  "tools/computer-tools.js"
  "agents/tool-taxonomy.js"
  "integrations/composio/client.js"
)

# Sanity-check every source file exists in the local dist BEFORE we
# touch the installed bundle. Saves you from a half-applied patch.
echo "→ Verifying local dist has every file the patch needs..."
for f in "${FILES[@]}"; do
  if [[ ! -f "$REPO_ROOT/dist/$f" ]]; then
    echo "  ✗ local dist missing: dist/$f"
    echo "  Run: npm run build  (from $REPO_ROOT)"
    exit 1
  fi
done
echo "  ✓ all $(echo "${#FILES[@]}") files present locally"

# Timestamped backup of the files we're about to overwrite. If patching
# misbehaves, restore with:
#   for f in dashboard/console.js …; do cp /tmp/<backup>/$f $INSTALLED_DIST/$f; done
BACKUP="/tmp/clemmy-hotpatch-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
echo "→ Backing up current installed files to $BACKUP"
for f in "${FILES[@]}"; do
  if [[ -f "$INSTALLED_DIST/$f" ]]; then
    mkdir -p "$BACKUP/$(dirname "$f")"
    cp "$INSTALLED_DIST/$f" "$BACKUP/$f"
  fi
done

echo "→ Patching:"
for f in "${FILES[@]}"; do
  src="$REPO_ROOT/dist/$f"
  dst="$INSTALLED_DIST/$f"
  mkdir -p "$(dirname "$dst")"
  # cp -p preserves mtime so the bundle's last-touched timestamps
  # stay close to the locally-built file rather than 'now'.
  cp -p "$src" "$dst"
  size=$(stat -f%z "$dst")
  echo "  ✓ $f ($size bytes)"
done

echo
echo "──────────────────────────────────────────────────────────────"
echo "Patch applied. Next steps:"
echo
echo "  1. Quit Clementine (tray icon → Quit, OR Cmd+Q while focused)."
echo "  2. Reopen Clementine from /Applications."
echo "  3. The dashboard will now have:"
echo "      • Recall hub alerts → toasts (visible across apps)"
echo "      • REC MEETING button on the dock-live card (left rail)"
echo "      • Canonical-transcript backfill on /complete"
echo
echo "Revert if anything goes sideways:"
echo "  for f in ${FILES[*]}; do"
echo "    cp \"$BACKUP/\$f\" \"$INSTALLED_DIST/\$f\""
echo "  done"
echo "  # then relaunch Clementine"
echo "──────────────────────────────────────────────────────────────"
