#!/usr/bin/env bash
# dev-up.sh — (re)start the local iteration daemon FROM SOURCE for patch→smoke.
# Safe build harness:
#   - installed Clementine.app quit (single owner of port + Codex auth → no race)
#   - runs against your REAL home (real auth/data) BUT:
#       * Discord ON by default so you can TEST via Discord (the parity surface).
#         Opt out for pure automated smokes with: DEV_DISCORD=false ./scripts/dev-up.sh.
#         Safe to leave on: proactivity is off (below) so the daemon won't post
#         unsolicited — it just connects the bot so DMs/@mentions hit the dev build.
#         (The installed app is quit above, so only this daemon owns the bot token.)
#       * proactivity DISABLED (autonomy/briefs/check-ins won't fire) — original
#         policy backed up to state/proactivity-policy.json.devbak, restored by dev-down.sh
#   - the 3 staged FORK surfaces ON so smokes exercise the converted paths
# Re-run after every source patch (ESM cache → needs a fresh process to pick up changes).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="$HOME/.clementine-next"
PORT="$(grep -E '^WEBHOOK_PORT=' "$HOME_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"'"'"' ' )"; PORT="${PORT:-8520}"

echo "→ quitting installed app + any prior dev daemon"
osascript -e 'tell application "Clementine" to quit' 2>/dev/null || true
pkill -f "/Applications/Clementine.app" 2>/dev/null || true
# Match the daemon however tsx is invoked. The real argv is
#   node --import tsx /ABS/PATH/src/index.ts daemon --foreground
# so the old pattern "tsx src/index.ts …" never matched (absolute path between
# tsx and src) — the stale daemon survived, kept the port, and the bind-check
# below false-reported "up" against the OLD code. Anchor on the stable suffix.
pkill -f "src/index.ts daemon --foreground" 2>/dev/null || true
for _ in $(seq 1 20); do lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1 || break; sleep 1; done
# Belt-and-suspenders: if anything STILL holds the port, kill it by PID so we
# never start the new daemon against a port the old one owns (EADDRINUSE).
if lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1; then
  STALE_PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN -n 2>/dev/null)"
  [ -n "$STALE_PIDS" ] && echo "→ port $PORT still held by $STALE_PIDS — killing" && kill $STALE_PIDS 2>/dev/null || true
  for _ in $(seq 1 10); do lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1 || break; sleep 1; done
fi

# Disable proactivity for the build (reversible; dev-down.sh restores it) WITHOUT
# wiping the user's real autonomy settings. The old version overwrote the WHOLE
# policy with a minimal object, which dropped autoApproveScope — so a user in
# YOLO ran the dev daemon as 'balanced' and hit approval prompts production never
# shows (observed live 2026-06-17: a Scorpion email batch asked for a plan that
# YOLO would have auto-approved). Merge instead: preserve every real field
# (autoApproveScope, batchConfirmThreshold, …) and flip ONLY proactivity off.
POL="$HOME_DIR/state/proactivity-policy.json"
if [ -f "$POL" ] && [ ! -f "$POL.devbak" ]; then cp "$POL" "$POL.devbak"; fi
# Source the REAL policy from the backup when present (a prior dev-up may have
# already minimized $POL), else from the live file.
POL_SRC="$POL"; [ -f "$POL.devbak" ] && POL_SRC="$POL.devbak"
node -e '
  const fs = require("fs");
  const [src, dst] = process.argv.slice(1);
  let base = {};
  try { base = JSON.parse(fs.readFileSync(src, "utf8")); } catch {}
  const merged = { ...base, enabled: false, quietHoursEnabled: true, quietHoursStart: "00:00", quietHoursEnd: "23:59" };
  fs.writeFileSync(dst, JSON.stringify(merged, null, 2) + "\n");
' "$POL_SRC" "$POL"

# Discord ON by default so Nathan can test via the Discord surface; DEV_DISCORD=false
# suppresses it for pure automated smoke runs.
DEV_DISCORD="${DEV_DISCORD:-true}"
echo "→ starting dev daemon from source (Discord $DEV_DISCORD, FORK surfaces on, proactivity off)"
( cd "$ROOT" && CLEMENTINE_HOME="$HOME_DIR" DISCORD_ENABLED="$DEV_DISCORD" \
    CLEMMY_HARNESS_DASHBOARD=on CLEMMY_HARNESS_HOME=on CLEMMY_HARNESS_WORKFLOW=on \
    CLEMMY_CODE_MODE=on CLEMMY_CODE_MODE_WRITES=on \
    npx tsx src/index.ts daemon --foreground > /tmp/clem-dev-daemon.log 2>&1 ) &
for _ in $(seq 1 60); do lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1 && break; sleep 1; done
if lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1; then
  echo "✓ dev daemon up on $PORT (source: $ROOT, home: $HOME_DIR)"
else
  echo "✗ dev daemon failed to bind $PORT — see /tmp/clem-dev-daemon.log"; tail -25 /tmp/clem-dev-daemon.log; exit 1
fi

# When Discord is on, prove the bot actually CONNECTED (login happens async after
# the port binds). "Discord bot ready" logs the bot tag + guild count; surface it
# so a token/intents failure is obvious instead of a silently-dark test surface.
if [ "$DEV_DISCORD" = "true" ]; then
  printf '→ waiting for Discord to connect'
  READY=""
  for _ in $(seq 1 30); do
    if grep -q "Discord bot ready" /tmp/clem-dev-daemon.log 2>/dev/null; then READY=1; break; fi
    printf '.'; sleep 1
  done
  if [ -n "$READY" ]; then
    TAG="$(grep -m1 "Discord bot ready" /tmp/clem-dev-daemon.log | sed -E 's/.*"user":"([^"]+)".*/\1/')"
    printf '\r✓ Discord live as %s — DM the bot or @mention it to test           \n' "$TAG"
  else
    printf '\r⚠ Discord did not report ready in 30s — check /tmp/clem-dev-daemon.log (token/intents?)\n'
  fi
fi
