#!/usr/bin/env bash
# dev-down.sh — tear down the iteration daemon, restore your config, bring the
# installed Clementine.app back. Run at the end of a build session.
set -euo pipefail
HOME_DIR="$HOME/.clementine-next"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="$(grep -E '^WEBHOOK_PORT=' "$HOME_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"'"'"' ' || true)"; PORT="${PORT:-8420}"
DB="$HOME_DIR/state/harness.db"

# A dev teardown is an intentional runtime handoff, not a crash. If accepted
# chat work is still owned by the source daemon, launching the installed app
# would make ordinary restart recovery resume that exact turn under an older
# build. Refuse before SIGTERM; the existing attempt-scoped Stop path must win
# and reach its terminal first. Smoke fixtures are the only cleanup-owned rows.
if [ -f "$DB" ]; then
  ACTIVE_ACCEPTANCES=""
  if ! ACTIVE_ACCEPTANCES="$(sqlite3 -readonly -separator '|' "$DB" <<'SQL'
SELECT s.id,
       a.attempt_id,
       COALESCE(a.run_id, ''),
       a.source_user_seq,
       json_extract(s.metadata_json, '$.__run_in_flight')
  FROM sessions AS s
  JOIN run_attempts AS a
    ON a.session_id = s.id
  JOIN events AS source
    ON source.session_id = s.id
   AND source.seq = a.source_user_seq
   AND source.type = 'user_input_received'
 WHERE s.kind = 'chat'
   AND s.status = 'active'
   AND a.status = 'active'
   AND a.finished_at IS NULL
   AND a.source_user_seq IS NOT NULL
   AND json_type(s.metadata_json, '$.__run_in_flight') = 'text'
   AND length(trim(json_extract(s.metadata_json, '$.__run_in_flight'))) > 0
   AND s.id NOT LIKE 'console:%smoke%'
   AND s.id NOT LIKE 'devsmoke:%'
 ORDER BY a.started_at, s.id;
SQL
  )"; then
    echo "✗ refusing to stop dev daemon: could not verify active chat ownership in $DB"
    echo "  No daemon was stopped and Clementine.app was not relaunched."
    exit 1
  fi
  if [ -n "$ACTIVE_ACCEPTANCES" ]; then
    echo "✗ refusing to stop dev daemon: accepted non-test chat work is still active"
    while IFS='|' read -r SESSION_ID ATTEMPT_ID RUN_ID SOURCE_USER_SEQ IN_FLIGHT_SINCE; do
      [ -z "$SESSION_ID" ] && continue
      printf '  session=%s attempt=%s sourceUserSeq=%s runId=%s inFlightSince=%s\n' \
        "$SESSION_ID" "$ATTEMPT_ID" "$SOURCE_USER_SEQ" "${RUN_ID:-none}" "$IN_FLIGHT_SINCE"
    done <<< "$ACTIVE_ACCEPTANCES"
    echo '→ Send `stop` in the originating Discord conversation (or use Stop in desktop Run Control), wait for the exact attempt to become terminal, then rerun scripts/dev-down.sh.'
    echo "  No daemon was stopped and Clementine.app was not relaunched."
    exit 1
  fi
fi

echo "→ stopping dev daemon"
OWNED_PID="$(cd "$ROOT" && CLEMENTINE_HOME="$HOME_DIR" npx tsx -e '
  import { readDaemonPid } from "./src/daemon/process.ts";
  console.log(readDaemonPid() ?? "");
' 2>/dev/null || true)"
(cd "$ROOT" && CLEMENTINE_HOME="$HOME_DIR" npx tsx src/index.ts daemon stop) >/dev/null 2>&1 || true
if [ -n "$OWNED_PID" ]; then
  for _ in $(seq 1 100); do kill -0 "$OWNED_PID" 2>/dev/null || break; sleep 0.1; done
fi
for _ in $(seq 1 10); do lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1 || break; sleep 1; done
if lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1; then
  BLOCKING_PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN -n 2>/dev/null | sort -u)"
  echo "✗ port $PORT remains owned by an unverified process (${BLOCKING_PIDS:-unknown}); refusing to kill it"
  [ -n "$BLOCKING_PIDS" ] && ps -p "$BLOCKING_PIDS" -o pid=,command= 2>/dev/null || true
  exit 1
fi

# Restore proactivity policy
POL="$HOME_DIR/state/proactivity-policy.json"
if [ -f "$POL.devbak" ]; then
  mv "$POL.devbak" "$POL"
  rm -f "$POL.devcreated"
  echo "→ restored proactivity policy"
elif [ -f "$POL.devcreated" ]; then
  rm -f "$POL" "$POL.devcreated"
  echo "→ removed dev-only proactivity policy"
fi

# Clean up smoke/test sessions this harness created (id prefixes used by the suite)
if [ -f "$DB" ]; then
  sqlite3 "$DB" < "$SCRIPT_DIR/dev-clean-harness-sessions.sql" 2>/dev/null \
    && echo "→ cleaned harness test sessions"
fi

rm -rf "$HOME_DIR/vault/00-System/workflows/devsmoke-chain" "$HOME_DIR/vault/00-System/workflows/devsmoke-hard" 2>/dev/null && echo "→ removed devsmoke fixture workflow"
echo "→ restarting installed Clementine.app"
open -a Clementine 2>/dev/null || true
echo "✓ done — installed app relaunching (~90s to bind)"
