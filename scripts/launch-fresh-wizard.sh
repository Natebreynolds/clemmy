#!/usr/bin/env bash
# Pop the Clementine setup wizard against a clean throwaway HOME so
# you can walk through it on this machine WITHOUT touching the real
# ~/.clementine-next, ~/.codex, or your existing keychain entries.
#
# What this does:
#   1. Makes a temp HOME under /tmp/.
#   2. Builds the desktop sources + daemon dist if they're stale.
#   3. Spawns Electron from apps/desktop with HOME pointed at the temp dir.
#   4. Streams logs to your terminal.
#   5. On Ctrl-C, removes the temp HOME so nothing leaks.
#
# It does NOT package, sign, notarize, or auto-update. This is purely
# the local dev run-loop for debugging the wizard.
#
# Usage:
#   scripts/launch-fresh-wizard.sh                 # production OAuth (real auth.openai.com)
#   scripts/launch-fresh-wizard.sh --fake-oauth    # local fake OAuth server (no real browser)
#
# When --fake-oauth is set, the OAuth flow is redirected to a tiny local
# fake server that issues placeholder tokens. Useful for clicking
# through the wizard without burning a real ChatGPT session.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FAKE_OAUTH=0
for arg in "$@"; do
  case "$arg" in
    --fake-oauth) FAKE_OAUTH=1 ;;
    -h|--help)
      sed -n '2,22p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
  esac
done

TMP_HOME="$(mktemp -d -t clemmy-wizard-XXXXXX)"
TMP_CWD="$(mktemp -d -t clemmy-wizard-cwd-XXXXXX)"

cleanup() {
  echo
  echo "→ cleaning up temp HOME $TMP_HOME"
  rm -rf "$TMP_HOME" "$TMP_CWD" || true
  if [[ -n "${FAKE_PID:-}" ]] && kill -0 "$FAKE_PID" 2>/dev/null; then
    kill "$FAKE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "→ HOME            $TMP_HOME"
echo "→ working dir     $TMP_CWD"

# ─── Build only if dist is stale ───────────────────────────────────

if [[ ! -f dist/index.js ]]; then
  echo "→ building daemon dist (one-time)"
  npm run build
fi
if [[ ! -f apps/desktop/dist/main.js ]]; then
  echo "→ building desktop dist (one-time)"
  (cd apps/desktop && npm run build)
fi

# ─── Optional fake OAuth server ────────────────────────────────────

if [[ "$FAKE_OAUTH" == "1" ]]; then
  echo "→ starting fake OAuth server (no real ChatGPT login required)"
  node -e '
    import("node:http").then(({ createServer }) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        if (url.pathname === "/oauth/authorize") {
          const cb = new URL(url.searchParams.get("redirect_uri"));
          cb.searchParams.set("code", "fake-code-" + Date.now());
          cb.searchParams.set("state", url.searchParams.get("state") || "");
          res.statusCode = 302;
          res.setHeader("Location", cb.toString());
          res.end();
          return;
        }
        if (url.pathname === "/oauth/token") {
          let body = "";
          req.on("data", (c) => body += c);
          req.on("end", () => {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({
              access_token: "fake-access-" + Date.now(),
              refresh_token: "fake-refresh-" + Date.now(),
              id_token: "h." + Buffer.from(JSON.stringify({
                sub: "user-fake",
                "https://api.openai.com/auth": { chatgpt_account_id: "acct-fake" }
              })).toString("base64url") + ".s",
              token_type: "Bearer",
              expires_in: 3600,
            }));
          });
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      });
      server.listen(43217, "127.0.0.1", () => {
        console.log("fake OAuth listening on http://127.0.0.1:43217");
      });
    });
  ' &
  FAKE_PID=$!
  sleep 1
  export CODEX_OAUTH_AUTH_BASE_URL="http://127.0.0.1:43217"
  echo "→ CODEX_OAUTH_AUTH_BASE_URL=$CODEX_OAUTH_AUTH_BASE_URL"
fi

# ─── Spawn Electron ────────────────────────────────────────────────

export HOME="$TMP_HOME"
export CLEMENTINE_HOME="$TMP_HOME/.clementine-next"
# Don't let any inherited OPENAI_API_KEY skip the wizard.
unset OPENAI_API_KEY

cd "$TMP_CWD"

echo "→ launching Electron"
echo "    quit the app or press Ctrl-C in this terminal to tear down the temp HOME"
echo

exec "$REPO_ROOT/apps/desktop/node_modules/.bin/electron" "$REPO_ROOT/apps/desktop"
