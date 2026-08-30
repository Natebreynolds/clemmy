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
# Optional reproducible model-routing overrides (process-local; .env is untouched):
#   DEV_PRIMARY_MODEL=gpt-5.6-sol DEV_FUSION_MODE=all ./scripts/dev-up.sh
#   DEV_FUSION_MODE=high DEV_FUSION_STRATEGY=verify ./scripts/dev-up.sh
#   DEV_TURN_ENGINE=host_v1 ./scripts/dev-up.sh          # production host engine
#   DEV_TURN_ENGINE=host_v1_read_only ./scripts/dev-up.sh # read-only host canary
#   DEV_CUTOVER_HOLD=on ./scripts/dev-up.sh               # sealed build-attestation boot
# Mid-turn and boot-auth fallover are both ON for the dev daemon by default; set
# DEV_BRAIN_FALLOVER=off and/or DEV_AUTH_FALLOVER=off to isolate a provider.
# Re-run after every source patch (ESM cache → needs a fresh process to pick up changes).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="$HOME/.clementine-next"
PORT="$(grep -E '^WEBHOOK_PORT=' "$HOME_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"'"'"' ' || true)"; PORT="${PORT:-8420}"
IMPLEMENTATION_ARTIFACT_ROOT="$ROOT/src/runtime/harness/implementation-artifacts/emitted"
DEV_PRIMARY_MODEL="${DEV_PRIMARY_MODEL:-}"
DEV_FUSION_MODE="${DEV_FUSION_MODE:-}"
DEV_FUSION_STRATEGY="${DEV_FUSION_STRATEGY:-}"
DEV_BRAIN_FALLOVER="${DEV_BRAIN_FALLOVER:-on}"
DEV_AUTH_FALLOVER="${DEV_AUTH_FALLOVER:-on}"
DEV_TURN_ENGINE="${DEV_TURN_ENGINE:-}"
DEV_CUTOVER_HOLD="${DEV_CUTOVER_HOLD:-off}"
DEV_DISCORD="${DEV_DISCORD:-true}"
DAEMON_LOG="$HOME_DIR/logs/daemon.log"
DEV_LAUNCH_VERIFIED=false
DEV_ROLLBACK_ARMED=false
DEV_POLICY_CREATED=false
DEV_POLICY_PATH="$HOME_DIR/state/proactivity-policy.json"
DEV_POLICY_CREATED_MARKER="$HOME_DIR/state/proactivity-policy.json.devcreated"
stop_owned_daemon_and_wait() {
  local owned_pid owned_state
  owned_pid="$(cd "$ROOT" && CLEMENTINE_HOME="$HOME_DIR" NODE_OPTIONS= node --import tsx --input-type=module --eval '
    import { readDaemonPid } from "./src/daemon/process.ts";
    console.log(readDaemonPid() ?? "");
  ' 2>/dev/null || true)"
  (cd "$ROOT" && CLEMENTINE_HOME="$HOME_DIR" NODE_OPTIONS= node --import tsx --input-type=module --eval '
    import { stopDaemon } from "./src/daemon/process.ts";
    stopDaemon();
  ') >/dev/null 2>&1 || true
  if [ -n "$owned_pid" ]; then
    for _ in $(seq 1 100); do
      owned_state="$(ps -p "$owned_pid" -o state= 2>/dev/null | tr -d '[:space:]' || true)"
      case "$owned_state" in ""|Z*) break ;; esac
      sleep 0.1
    done
  fi
}
quit_installed_app_bounded() {
  local quit_pid quit_state
  osascript -e 'tell application "Clementine" to quit' >/dev/null 2>&1 &
  quit_pid=$!
  for _ in $(seq 1 30); do
    quit_state="$(ps -p "$quit_pid" -o state= 2>/dev/null | tr -d '[:space:]' || true)"
    case "$quit_state" in ""|Z*) wait "$quit_pid" 2>/dev/null || true; return ;; esac
    sleep 0.1
  done
  # Apple Events can wedge behind an unresponsive Electron main process. The
  # installed app is terminated immediately below, so stop waiting on the
  # messenger instead of blocking source-launch recovery forever.
  kill "$quit_pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$quit_pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -9 "$quit_pid" 2>/dev/null || true
  wait "$quit_pid" 2>/dev/null || true
}
rollback_failed_launch() {
  if [ "$DEV_ROLLBACK_ARMED" = "true" ] && [ "$DEV_LAUNCH_VERIFIED" != "true" ]; then
    stop_owned_daemon_and_wait
    if [ "$DEV_CUTOVER_HOLD" != "on" ]; then
      if [ -f "$HOME_DIR/state/proactivity-policy.json.devbak" ]; then
        mv "$HOME_DIR/state/proactivity-policy.json.devbak" "$HOME_DIR/state/proactivity-policy.json" 2>/dev/null || true
      elif [ "$DEV_POLICY_CREATED" = "true" ]; then
        rm -f "$DEV_POLICY_PATH"
        rm -f "$DEV_POLICY_CREATED_MARKER"
      fi
    fi
  fi
}
trap rollback_failed_launch EXIT

if [ -n "$DEV_PRIMARY_MODEL" ] && [[ ! "$DEV_PRIMARY_MODEL" =~ ^[A-Za-z0-9._:-]+$ ]]; then
  echo "✗ DEV_PRIMARY_MODEL contains unsupported characters"; exit 2
fi
case "$DEV_FUSION_MODE" in ""|off|high|all) ;; *) echo "✗ DEV_FUSION_MODE must be off, high, or all"; exit 2 ;; esac
case "$DEV_FUSION_STRATEGY" in ""|verify|debate) ;; *) echo "✗ DEV_FUSION_STRATEGY must be verify or debate"; exit 2 ;; esac
case "$DEV_BRAIN_FALLOVER" in on|off) ;; *) echo "✗ DEV_BRAIN_FALLOVER must be on or off"; exit 2 ;; esac
case "$DEV_AUTH_FALLOVER" in on|off) ;; *) echo "✗ DEV_AUTH_FALLOVER must be on or off"; exit 2 ;; esac
case "$DEV_TURN_ENGINE" in ""|host_v1|host_v1_read_only) ;; *) echo "✗ DEV_TURN_ENGINE must be host_v1 or host_v1_read_only; legacy_sdk is resume-only"; exit 2 ;; esac
case "$DEV_CUTOVER_HOLD" in on|off) ;; *) echo "✗ DEV_CUTOVER_HOLD must be on or off"; exit 2 ;; esac
if [ -n "$DEV_FUSION_MODE" ] && [ -z "$DEV_FUSION_STRATEGY" ]; then DEV_FUSION_STRATEGY=verify; fi
if [ "$DEV_CUTOVER_HOLD" = "on" ]; then
  # A held launch attests the production engine candidate, never a read-only or
  # inherited legacy selector. External transports are structurally absent in
  # the daemon too; these overrides make the launch intent independently clear.
  DEV_TURN_ENGINE=host_v1
  DEV_DISCORD=false
fi

echo "→ quitting installed app + the daemon owned by $HOME_DIR"
DEV_ROLLBACK_ARMED=true
quit_installed_app_bounded
pkill -f "/Applications/Clementine.app" 2>/dev/null || true
stop_owned_daemon_and_wait
for _ in $(seq 1 20); do lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1 || break; sleep 1; done
if lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1; then
  BLOCKING_PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN -n 2>/dev/null | sort -u)"
  echo "✗ port $PORT is owned by an unverified process (${BLOCKING_PIDS:-unknown}); refusing to kill it"
  [ -n "$BLOCKING_PIDS" ] && ps -p "$BLOCKING_PIDS" -o pid=,command= 2>/dev/null || true
  exit 1
fi

# Source launches execute these digest-addressed bundles, not the TypeScript
# implementation files directly. The prior owner must be stopped before the
# emitter prunes old digest files. Emit before capturing candidate identity so
# the dirty flag/fingerprint describe the exact generation we will launch.
echo "→ emitting implementation artifacts from current source"
if ! (cd "$ROOT" && NODE_OPTIONS= node scripts/emit-implementation-artifacts.mjs "$IMPLEMENTATION_ARTIFACT_ROOT"); then
  echo "✗ implementation artifact emission failed; refusing to launch"
  exit 1
fi
EXPECTED_GIT_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
if [[ ! "$EXPECTED_GIT_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  echo "✗ could not resolve the candidate's full git SHA"; exit 2
fi
EXPECTED_GIT_DIRTY=false
[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=all 2>/dev/null)" ] && EXPECTED_GIT_DIRTY=true
EXPECTED_RUNTIME_JSON="$(cd "$ROOT" && NODE_OPTIONS= node --import tsx --input-type=module --eval '
  import { fingerprintRuntimeSourceFromGit } from "./src/runtime/source-fingerprint.ts";
  import { HARNESS_SCHEMA_VERSION } from "./src/runtime/harness/schema-version.ts";
  console.log(JSON.stringify({
    sourceFingerprint: fingerprintRuntimeSourceFromGit({ repoRoot: process.cwd() }),
    schemaVersion: HARNESS_SCHEMA_VERSION,
  }));
')"
EXPECTED_SOURCE_FINGERPRINT="$(node -e 'console.log(JSON.parse(process.argv[1]).sourceFingerprint)' "$EXPECTED_RUNTIME_JSON")"
EXPECTED_SCHEMA_VERSION="$(node -e 'console.log(JSON.parse(process.argv[1]).schemaVersion)' "$EXPECTED_RUNTIME_JSON")"
if [[ ! "$EXPECTED_SOURCE_FINGERPRINT" =~ ^[a-f0-9]{64}$ ]]; then
  echo "✗ could not fingerprint the exact candidate source"; exit 2
fi
if [[ ! "$EXPECTED_SCHEMA_VERSION" =~ ^[1-9][0-9]*$ ]]; then
  echo "✗ invalid expected harness schema: $EXPECTED_SCHEMA_VERSION"; exit 2
fi
if ! (cd "$ROOT" && NODE_OPTIONS= node scripts/emit-implementation-artifacts.mjs --verify-current "$IMPLEMENTATION_ARTIFACT_ROOT"); then
  echo "✗ implementation artifacts changed or source moved during emission; refusing to launch"
  exit 1
fi
echo "✓ implementation artifacts match current source"

# The source daemon serves apps/mobile-web/dist verbatim. A source-only patch
# otherwise leaves the phone on yesterday's ignored bundle, even though the
# daemon build attestation is current. Rebuild after the old owner is stopped,
# and require index.html to have been emitted during THIS invocation before any
# new daemon is allowed to serve it.
echo "→ rebuilding mobile web from the exact source candidate"
MOBILE_BUILD_STARTED_AT="$(date +%s)"
if ! (cd "$ROOT" && NODE_OPTIONS= npm run build:mobile-web); then
  echo "✗ mobile web build failed; refusing to launch a stale PWA"
  exit 1
fi
MOBILE_WEB_INDEX="$ROOT/apps/mobile-web/dist/index.html"
if [ ! -s "$MOBILE_WEB_INDEX" ]; then
  echo "✗ mobile web build emitted no dist/index.html; refusing to launch"
  exit 1
fi
MOBILE_WEB_INDEX_MTIME="$(stat -f '%m' "$MOBILE_WEB_INDEX" 2>/dev/null || echo 0)"
if [ "$MOBILE_WEB_INDEX_MTIME" -lt "$MOBILE_BUILD_STARTED_AT" ]; then
  echo "✗ mobile web dist was not refreshed by this launch; refusing to serve it"
  exit 1
fi
echo "✓ mobile web rebuilt from current source"

# Disable proactivity for the build (reversible; dev-down.sh restores it) WITHOUT
# wiping the user's real autonomy settings. The old version overwrote the WHOLE
# policy with a minimal object, which dropped autoApproveScope — so a user in
# YOLO ran the dev daemon as 'balanced' and hit approval prompts production never
# shows (observed live 2026-06-17: a Acme email batch asked for a plan that
# YOLO would have auto-approved). Merge instead: preserve every real field
# (autoApproveScope, batchConfirmThreshold, …) and flip ONLY proactivity off.
if [ "$DEV_CUTOVER_HOLD" != "on" ]; then
  POL="$HOME_DIR/state/proactivity-policy.json"
  if [ -f "$POL" ] && [ ! -f "$POL.devbak" ]; then cp "$POL" "$POL.devbak"; fi
  if [ ! -f "$POL" ] && [ ! -f "$POL.devbak" ]; then DEV_POLICY_CREATED=true; fi
  if [ "$DEV_POLICY_CREATED" = "true" ]; then : > "$DEV_POLICY_CREATED_MARKER"; fi
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
fi

# Discord ON by default so Alexander can test via the Discord surface; DEV_DISCORD=false
# suppresses it for pure automated smoke runs.
PRIMARY_LABEL="${DEV_PRIMARY_MODEL:-profile}"
FUSION_LABEL="${DEV_FUSION_MODE:-profile}"
TURN_ENGINE_LABEL="${DEV_TURN_ENGINE:-host_v1}"
echo "→ starting dev daemon from source (cutover hold $DEV_CUTOVER_HOLD, Discord $DEV_DISCORD, model $PRIMARY_LABEL, Fusion $FUSION_LABEL, turn engine $TURN_ENGINE_LABEL, fallover brain=$DEV_BRAIN_FALLOVER auth=$DEV_AUTH_FALLOVER)"
LOG_START_LINE=1
if [ -f "$DAEMON_LOG" ]; then LOG_START_LINE=$(( $(wc -l < "$DAEMON_LOG") + 1 )); fi
if ! (
  cd "$ROOT" || exit 1
  export CLEMENTINE_HOME="$HOME_DIR"
  export DISCORD_ENABLED="$DEV_DISCORD"
  export CLEMMY_CUTOVER_HOLD="$DEV_CUTOVER_HOLD"
  export CLEMMY_HARNESS_DASHBOARD=on CLEMMY_HARNESS_HOME=on CLEMMY_HARNESS_WORKFLOW=on
  export CLEMMY_BRAIN_FALLOVER="$DEV_BRAIN_FALLOVER"
  export CLEMMY_AUTH_FALLOVER="$DEV_AUTH_FALLOVER"
  # The generation verified above is the only implementation root this source
  # launch may inherit; a shell-level override must not substitute stale bytes.
  export CLEMMY_IMPLEMENTATION_ARTIFACT_ROOT="$IMPLEMENTATION_ARTIFACT_ROOT"
  # Always overwrite a caller's inherited selector. An old shell-level
  # CLEMMY_TURN_ENGINE=legacy_sdk must not silently turn a host-labelled dev
  # launch into a blocked or legacy-owned fresh chat.
  export CLEMMY_TURN_ENGINE="$TURN_ENGINE_LABEL"
  if [ "$DEV_CUTOVER_HOLD" = "on" ]; then
    export WEBHOOK_ENABLED=true WEBHOOK_HOST=127.0.0.1
    export DISCORD_ENABLED=false SLACK_ENABLED=false CLEMENTINE_MOBILE_APP_LISTENER=off
    export CLEMMY_BOOT_WARMUP=off CLEMMY_CLI_DISCOVERY_WARMUP=off CLEMMY_MCP_PREWARM=off
  fi
  if [ -n "$DEV_PRIMARY_MODEL" ]; then export OPENAI_MODEL_PRIMARY="$DEV_PRIMARY_MODEL"; fi
  if [ -n "$DEV_FUSION_MODE" ]; then export CLEMMY_DEBATE_MODE="$DEV_FUSION_MODE"; fi
  if [ -n "$DEV_FUSION_STRATEGY" ]; then export CLEMMY_FUSION_STRATEGY="$DEV_FUSION_STRATEGY"; fi
  # Use the product's detached daemon launcher rather than backgrounding a
  # foreground process. The latter inherits a non-interactive caller's process
  # group and can be reaped as soon as a hotpatch command/CI shell exits.
  # Invoke the installed loader directly with ambient NODE_OPTIONS cleared: a
  # held boot must not download an npx package or execute a caller's preload.
  if [ "$DEV_CUTOVER_HOLD" = "on" ]; then
    NODE_OPTIONS= node --import tsx src/daemon/cutover-hold-entry.ts start
  else
    node --import tsx src/index.ts daemon start
  fi
); then
  echo "✗ detached source daemon failed to start — see $DAEMON_LOG"
  exit 1
fi
# Keep the familiar dev-tail path while preserving the real daemon log and its
# rotation/history. Readiness checks below only inspect lines from THIS launch.
ln -sf "$DAEMON_LOG" /tmp/clem-dev-daemon.log
for _ in $(seq 1 60); do lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1 && break; sleep 1; done
if ! lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1; then
  echo "✗ dev daemon failed to bind $PORT — see /tmp/clem-dev-daemon.log"; tail -25 /tmp/clem-dev-daemon.log; exit 1
fi

# A listener is not proof that THIS launch won the port. A stale scratch daemon
# used to survive the kill pattern and made this script print a false success.
# Require one owner, the exact source entry, and an authenticated build report
# matching the candidate tree before handing the daemon to a tester.
OWNER_PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN -n 2>/dev/null | sort -u)"
if [ -z "$OWNER_PIDS" ] || [ "$(printf '%s\n' "$OWNER_PIDS" | wc -l | tr -d ' ')" != "1" ]; then
  echo "✗ expected exactly one daemon owner on $PORT, found: ${OWNER_PIDS:-none}"
  exit 1
fi
OWNER_COMMAND="$(ps -p "$OWNER_PIDS" -o command= 2>/dev/null)"
if [ "$DEV_CUTOVER_HOLD" = "on" ]; then
  EXPECTED_OWNER_COMMAND="$ROOT/src/daemon/cutover-hold-entry.ts --foreground"
else
  EXPECTED_OWNER_COMMAND="$ROOT/src/index.ts daemon --foreground"
fi
if [[ "$OWNER_COMMAND" != *"$EXPECTED_OWNER_COMMAND"* ]]; then
  echo "✗ port $PORT belongs to the wrong process: $OWNER_COMMAND"
  exit 1
fi
RECORDED_DAEMON_PID="$(cd "$ROOT" && CLEMENTINE_HOME="$HOME_DIR" NODE_OPTIONS= node --import tsx --input-type=module --eval '
  import { readDaemonPid } from "./src/daemon/process.ts";
  console.log(readDaemonPid() ?? "");
')"
if [ "$RECORDED_DAEMON_PID" != "$OWNER_PIDS" ]; then
  echo "✗ expected home $HOME_DIR records daemon pid ${RECORDED_DAEMON_PID:-none}, but port owner is $OWNER_PIDS"
  exit 1
fi
if ! (
  cd "$ROOT" || exit 1
  export CLEMENTINE_HOME="$HOME_DIR"
  export EXPECTED_CLEMENTINE_ROOT="$ROOT"
  export EXPECTED_CLEMENTINE_SHA="$EXPECTED_GIT_SHA"
  export EXPECTED_CLEMENTINE_DIRTY="$EXPECTED_GIT_DIRTY"
  export EXPECTED_CLEMENTINE_SOURCE_FINGERPRINT="$EXPECTED_SOURCE_FINGERPRINT"
  export EXPECTED_CLEMENTINE_SCHEMA_VERSION="$EXPECTED_SCHEMA_VERSION"
  export EXPECTED_CLEMENTINE_PID="$OWNER_PIDS"
  export EXPECTED_CUTOVER_HOLD="$DEV_CUTOVER_HOLD"
  NODE_OPTIONS= node --import tsx --input-type=module --eval '
    import { WEBHOOK_HOST, WEBHOOK_PORT, WEBHOOK_SECRET } from "./src/config.ts";
    import { fingerprintRuntimeSourceFromGit } from "./src/runtime/source-fingerprint.ts";
    void (async () => {
      if (!WEBHOOK_SECRET) throw new Error("WEBHOOK_SECRET unavailable");
      const expectedCutoverHold = process.env.EXPECTED_CUTOVER_HOLD === "on";
      const host = expectedCutoverHold
        ? "127.0.0.1"
        : WEBHOOK_HOST === "0.0.0.0"
        ? "127.0.0.1"
        : WEBHOOK_HOST === "::"
          ? "[::1]"
          : WEBHOOK_HOST.includes(":") ? `[${WEBHOOK_HOST}]` : WEBHOOK_HOST;
      const response = await fetch(`http://${host}:${WEBHOOK_PORT}/api/console/build-info`, {
        headers: { authorization: `Bearer ${WEBHOOK_SECRET}` },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json();
      const build = body;
      const expectedEntry = expectedCutoverHold
        ? `${process.env.EXPECTED_CLEMENTINE_ROOT}/src/daemon/cutover-hold-entry.ts`
        : `${process.env.EXPECTED_CLEMENTINE_ROOT}/src/index.ts`;
      const expectedDirty = process.env.EXPECTED_CLEMENTINE_DIRTY === "true";
      const expectedFingerprint = process.env.EXPECTED_CLEMENTINE_SOURCE_FINGERPRINT;
      const expectedSchema = Number(process.env.EXPECTED_CLEMENTINE_SCHEMA_VERSION);
      const currentFingerprint = fingerprintRuntimeSourceFromGit({ repoRoot: process.env.EXPECTED_CLEMENTINE_ROOT });
      const errors = [
        response.status === 200 ? null : `HTTP ${response.status}`,
        build?.entry === expectedEntry ? null : `entry=${String(build?.entry)}`,
        build?.packaged === false ? null : `packaged=${String(build?.packaged)}`,
        build?.gitSha === process.env.EXPECTED_CLEMENTINE_SHA ? null : `gitSha=${String(build?.gitSha)}`,
        build?.gitDirty === expectedDirty ? null : `gitDirty=${String(build?.gitDirty)}`,
        build?.sourceFingerprint === expectedFingerprint
          ? null
          : `sourceFingerprint=${String(build?.sourceFingerprint)}`,
        currentFingerprint === expectedFingerprint
          ? null
          : `source changed during launch: current=${currentFingerprint}`,
        build?.expectedSchemaVersion === expectedSchema
          ? null
          : `expectedSchemaVersion=${String(build?.expectedSchemaVersion)}`,
        build?.schemaVersion === expectedSchema ? null : `schemaVersion=${String(build?.schemaVersion)}`,
        build?.cutoverHold === expectedCutoverHold ? null : `cutoverHold=${String(build?.cutoverHold)}`,
        !expectedCutoverHold || build?.cutoverHoldProcessId === Number(process.env.EXPECTED_CLEMENTINE_PID)
          ? null
          : `cutoverHoldProcessId=${String(build?.cutoverHoldProcessId)}`,
        !expectedCutoverHold || build?.effectiveFreshTurnEngine === "host_v1"
          ? null
          : `effectiveFreshTurnEngine=${String(build?.effectiveFreshTurnEngine)}`,
      ].filter(Boolean);
      if (errors.length) throw new Error(`daemon identity mismatch: ${errors.join(", ")}`);
      console.log(`verified ${build.entry} · ${build.gitSha}${build.gitDirty ? "-dirty" : ""} · source ${build.sourceFingerprint.slice(0, 12)} · schema ${build.schemaVersion}`);
    })();
  '
); then
  echo "✗ daemon answered on $PORT but failed exact-tree identity verification"
  exit 1
fi
echo "✓ dev daemon up on $PORT (pid $OWNER_PIDS, source: $ROOT, home: $HOME_DIR)"

# When Discord is on, prove the bot actually CONNECTED (login happens async after
# the port binds). "Discord bot ready" logs the bot tag + guild count; surface it
# so a token/intents failure is obvious instead of a silently-dark test surface.
if [ "$DEV_DISCORD" = "true" ]; then
  printf '→ waiting for Discord to connect'
  READY=""
  for _ in $(seq 1 30); do
    if tail -n +"$LOG_START_LINE" "$DAEMON_LOG" 2>/dev/null | grep -q "Discord bot ready"; then READY=1; break; fi
    printf '.'; sleep 1
  done
  if [ -n "$READY" ]; then
    TAG="$(tail -n +"$LOG_START_LINE" "$DAEMON_LOG" | grep -m1 "Discord bot ready" | sed -E 's/.*"user":"([^"]+)".*/\1/')"
    printf '\r✓ Discord live as %s — DM the bot or @mention it to test           \n' "$TAG"
  else
    printf '\r✗ Discord did not report ready in 30s — check /tmp/clem-dev-daemon.log (token/intents?)\n'
    exit 1
  fi
fi
DEV_LAUNCH_VERIFIED=true
echo "✓ exact candidate daemon is ready for local acceptance testing"
