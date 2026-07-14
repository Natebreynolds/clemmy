#!/usr/bin/env bash
# Run this on the BROKEN fresh-install computer to figure out why
# Clementine skipped the setup wizard. The setup-complete marker is the only
# skip gate; the remaining checks explain credentials the wizard may reuse.
#
# Safe to run — read-only. Prints a verdict at the end.

set -u

HOME_DIR="${HOME:-$(eval echo ~)}"
STATE_DIR="$HOME_DIR/.clementine-next/state"
APP_PATH="/Applications/Clementine.app"

echo
echo "─── Clementine fresh-install diagnostics ───"
echo "HOME=$HOME_DIR"
echo "uname=$(uname -srm)"
echo "user=$(whoami)"
echo

verdict_skipped_reason=""

# 1. setup-complete marker
MARKER="$STATE_DIR/setup-complete.json"
if [[ -f "$MARKER" ]]; then
  echo "  ⚠ setup-complete marker EXISTS at $MARKER"
  echo "    contents:"
  sed 's/^/      /' "$MARKER" 2>/dev/null
  verdict_skipped_reason="setup-complete.json was already present — the marker file makes Clementine think setup already ran. Something wrote it without the wizard finishing."
else
  echo "  ✓ setup-complete marker absent"
fi

# 2. OPENAI_API_KEY in process env (won't show your shell env when you double-click, but checking anyway)
if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  echo "  ⚠ OPENAI_API_KEY set in this shell"
  echo "    (not necessarily set when Electron launched, but worth noting)"
else
  echo "  ✓ OPENAI_API_KEY not set in current shell"
fi

# 3. .env files at the three checked locations
for envfile in \
  "$HOME_DIR/.clementine-next/.env" \
  "$HOME_DIR/clementine-next/.env" \
  "$(pwd)/.env"; do
  if [[ -f "$envfile" ]]; then
    if grep -qE '^OPENAI_API_KEY\s*=\s*\S' "$envfile" 2>/dev/null; then
      echo "  ⚠ $envfile has OPENAI_API_KEY"
      echo "    (available to the wizard, but does not skip onboarding)"
    else
      echo "  · $envfile exists but no OPENAI_API_KEY"
    fi
  else
    echo "  ✓ no .env at $envfile"
  fi
done

# 4. ~/.codex/auth.json (external Codex CLI tokens; informational only)
CODEX_AUTH="$HOME_DIR/.codex/auth.json"
if [[ -f "$CODEX_AUTH" ]]; then
  echo "  ⚠ ~/.codex/auth.json EXISTS"
  echo "    keys present:"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; d=json.load(open('$CODEX_AUTH')); print('     ', list(d.keys())); print('      tokens keys:', list(d.get('tokens',{}).keys()) if isinstance(d.get('tokens'), dict) else 'no tokens object')" 2>/dev/null \
      || echo "      (couldn't parse)"
  else
    echo "      (no python3 to parse — file size: $(stat -f%z "$CODEX_AUTH" 2>/dev/null || stat -c%s "$CODEX_AUTH") bytes)"
  fi
  echo "    (Clementine deliberately ignores this grant and will mint its own)"
else
  echo "  ✓ ~/.codex/auth.json absent"
fi

# 5. ~/.clementine-next/state/auth.json (usable only with native + provenance marker)
LOCAL_AUTH="$STATE_DIR/auth.json"
if [[ -f "$LOCAL_AUTH" ]]; then
  echo "  ⚠ $LOCAL_AUTH EXISTS"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json; d=json.load(open('$LOCAL_AUTH')); c=d.get('codexOauth',{}); print('     source:', d.get('source')); print('     grant provenance:', c.get('grantProvenance')); print('     grant id present:', bool(c.get('grantId'))); print('     token pair present:', bool(c.get('accessToken') and c.get('refreshToken')))" 2>/dev/null || echo "    (parse failed)"
  fi
  echo "    (reusable only when source=native, provenance=clementine-oauth-v1, and grantId is non-empty; never skips onboarding)"
else
  echo "  ✓ $LOCAL_AUTH absent"
fi

# 6. secrets-vault.json
VAULT="$STATE_DIR/secrets-vault.json"
if [[ -f "$VAULT" ]]; then
  echo "  ⚠ $VAULT EXISTS"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json; d=json.load(open('$VAULT')); print('     entry keys:', list(d.get('entries',{}).keys()))" 2>/dev/null || echo "    (parse failed)"
  fi
else
  echo "  ✓ $VAULT absent"
fi

# 7. installed app version
echo
if [[ -d "$APP_PATH" ]]; then
  PLIST="$APP_PATH/Contents/Info.plist"
  if [[ -f "$PLIST" ]] && command -v defaults >/dev/null 2>&1; then
    APP_VER=$(defaults read "$PLIST" CFBundleShortVersionString 2>/dev/null || echo "unknown")
    echo "  · Installed Clementine.app version: $APP_VER"
  fi

  # Show the snapshot of setup-state.js the app actually ran (in case it
  # was bundled from a stale source).
  BUNDLED_SETUP_STATE="$APP_PATH/Contents/Resources/app.asar"
  if [[ -f "$BUNDLED_SETUP_STATE" ]]; then
    echo "  · Bundled JS is inside app.asar (can't inspect without unpacking)"
  else
    UNPACKED="$APP_PATH/Contents/Resources/app/dist/setup-state.js"
    [[ -f "$UNPACKED" ]] && echo "  · setup-state.js bundled at $UNPACKED ($(wc -l < "$UNPACKED") lines)"
  fi
else
  echo "  ⚠ Clementine.app not found in /Applications"
fi

echo
echo "─── Verdict ───"
if [[ -n "$verdict_skipped_reason" ]]; then
  echo "  ⚠ Wizard was likely skipped because:"
  echo "    $verdict_skipped_reason"
else
  echo "  ✓ setup-complete.json is absent, so the wizard SHOULD have opened regardless of credentials. Possible causes:"
  echo "    a) The bundled .app was built before the setup wizard existed."
  echo "    b) The wizard window opened but failed to attach window.clemmy (preload error)."
  echo
  echo "    Next: open Clementine, then run:"
  echo "      log show --predicate 'process == \"Clementine\"' --info --last 5m | head -200"
  echo "    Or open Console.app and filter by 'Clementine'."
fi
echo
