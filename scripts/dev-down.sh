#!/usr/bin/env bash
# dev-down.sh — tear down the iteration daemon, restore your config, bring the
# installed Clementine.app back. Run at the end of a build session.
set -uo pipefail
HOME_DIR="$HOME/.clementine-next"
PORT="$(grep -E '^WEBHOOK_PORT=' "$HOME_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"'"'"' ' )"; PORT="${PORT:-8520}"

echo "→ stopping dev daemon"
# Anchor on the stable argv suffix — the real command is
#   node --import .../tsx/loader.mjs src/index.ts daemon --foreground
# so the OLD pattern "tsx src/index.ts …" never matched (absolute loader path sits
# between tsx and src). It left the dev daemon ALIVE holding $PORT, and the
# installed app below then failed to bind. Match what dev-up.sh kills.
pkill -f "src/index.ts daemon --foreground" 2>/dev/null || true
for _ in $(seq 1 10); do lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1 || break; sleep 1; done
# Belt-and-suspenders: free the port by PID if anything still holds it, so the
# installed app can bind cleanly.
if lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1; then
  STALE_PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN -n 2>/dev/null)"
  [ -n "$STALE_PIDS" ] && echo "→ port $PORT still held by $STALE_PIDS — killing" && kill $STALE_PIDS 2>/dev/null || true
  sleep 1
fi

# Restore proactivity policy
POL="$HOME_DIR/state/proactivity-policy.json"
if [ -f "$POL.devbak" ]; then mv "$POL.devbak" "$POL"; echo "→ restored proactivity policy"; fi

# Clean up smoke/test sessions this harness created (id prefixes used by the suite)
DB="$HOME_DIR/state/harness.db"
if [ -f "$DB" ]; then
  sqlite3 "$DB" "DELETE FROM events WHERE session_id LIKE 'console:%smoke%' OR session_id LIKE 'devsmoke:%'; DELETE FROM sessions WHERE id LIKE 'console:%smoke%' OR id LIKE 'devsmoke:%';" 2>/dev/null \
    && echo "→ cleaned harness test sessions"
fi

rm -rf "$HOME_DIR/vault/00-System/workflows/devsmoke-chain" "$HOME_DIR/vault/00-System/workflows/devsmoke-hard" 2>/dev/null && echo "→ removed devsmoke fixture workflow"
echo "→ restarting installed Clementine.app"
open -a Clementine 2>/dev/null || true
echo "✓ done — installed app relaunching (~90s to bind)"
