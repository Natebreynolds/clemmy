#!/usr/bin/env bash
# smoke-all.sh — one-shot local verification: the deterministic layers always,
# plus the live read-only probes when the dev daemon is up. Runs EVERY layer
# (doesn't stop at the first failure) and prints a summary. Safe: no sends.
#   npm run smoke:all
set -uo pipefail
HOME_DIR="$HOME/.clementine-next"
PORT="$(grep -E '^WEBHOOK_PORT=' "$HOME_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"'"'"' ')"; PORT="${PORT:-8520}"
PASS=0; FAIL=0; SKIP=0
layer(){ # layer "name" cmd...
  local name="$1"; shift
  printf '\n\033[1m── %s ──\033[0m\n' "$name"
  if "$@"; then printf '   \033[32m✓ %s\033[0m\n' "$name"; PASS=$((PASS+1));
  else printf '   \033[31m✗ %s (exit %d)\033[0m\n' "$name" "$?"; FAIL=$((FAIL+1)); fi
}

layer "typecheck"            npm run -s typecheck
layer "unit + integration"   npm test
layer "gate benchmark"       npm run -s bench:gates
layer "pass^k eval"          npm run -s eval:passk
layer "code-mode opportunity" npm run -s measure:code-mode

# Live read-only probes — only meaningful against the running dev daemon + real auth.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  layer "probe: cross-family judge (live)" env CLEMENTINE_HOME="$HOME_DIR" npx tsx scripts/probe-judge-live.ts
  layer "probe: code-mode (live)"          env CLEMENTINE_HOME="$HOME_DIR" CLEMMY_CODE_MODE_WRITES=on npx tsx scripts/probe-code-mode.ts
else
  printf '\n   \033[33m• live probes SKIPPED — dev daemon not on :%s (run ./scripts/dev-up.sh)\033[0m\n' "$PORT"; SKIP=$((SKIP+2))
fi

printf '\n\033[1m═══ smoke:all — %d passed, %d failed, %d skipped ═══\033[0m\n' "$PASS" "$FAIL" "$SKIP"
exit "$FAIL"
