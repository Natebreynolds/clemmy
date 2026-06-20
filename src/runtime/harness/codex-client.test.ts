/**
 * Run: npx tsx --test src/runtime/harness/codex-client.test.ts
 *
 * Exercises the codex-native auth bridge for the harness Runner.
 *
 * The auth-store reads tokens from `${BASE_DIR}/state/auth.json`,
 * computed from CLEMENTINE_HOME at module load. Tests set
 * CLEMENTINE_HOME to a temp dir BEFORE importing the module under
 * test, write a fake auth.json, then verify:
 *
 *  - configureHarnessRuntime returns ok:false with a clear reason
 *    when no OAuth tokens are stored
 *  - configureHarnessRuntime returns ok:true and is idempotent once
 *    tokens exist (a second call within the same process is a no-op)
 *  - shouldRefresh's staleness window correctly classifies missing,
 *    just-refreshed, and old token timestamps
 *
 * We do NOT exercise the live OAuth refresh against the codex backend
 * — that's a network integration and belongs in a smoke test.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-codex-client-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CODEX_AUTH_SOURCE_FILE = path.join(TMP_HOME, 'codex-cli-auth.json');
const AUTH_STATE_DIR = path.join(TMP_HOME, 'state');
const AUTH_STATE_FILE = path.join(AUTH_STATE_DIR, 'auth.json');
mkdirSync(AUTH_STATE_DIR, { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { configureHarnessRuntime, resetHarnessRuntimeConfig, __test__ } = await import(
  './codex-client.js'
);

function clearAuth(): void {
  try {
    rmSync(AUTH_STATE_FILE);
  } catch {
    /* not present */
  }
}

function writeAuth(payload: Record<string, unknown>): void {
  writeFileSync(AUTH_STATE_FILE, JSON.stringify(payload, null, 2), 'utf-8');
}

test.beforeEach(() => {
  resetHarnessRuntimeConfig();
  clearAuth();
});

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('configureHarnessRuntime returns ok:false when NO provider is connected', async () => {
  // Block the host's real Claude keychain login so the brain-fallback chain
  // (codex → claude → byo) finds nothing — the "truly nothing connected" path.
  writeClaudeVault({ accessToken: 'sk-ant-api03-block-keychain-fallback' });
  try {
    resetHarnessRuntimeConfig();
    const result = await configureHarnessRuntime();
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /No codex OAuth tokens/);
    assert.match(result.reason ?? '', /Settings|login-native/);
  } finally {
    clearClaudeVault();
    resetHarnessRuntimeConfig();
  }
});

test('configureHarnessRuntime returns ok:true once tokens exist', async () => {
  writeAuth({
    source: 'native',
    codexOauth: {
      accessToken: 'fake-access-token-abc',
      refreshToken: 'fake-refresh-token-xyz',
      lastRefresh: new Date().toISOString(),
    },
  });
  const result = await configureHarnessRuntime();
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
});

test('configureHarnessRuntime is idempotent within a process', async () => {
  writeAuth({
    source: 'native',
    codexOauth: {
      accessToken: 'a',
      refreshToken: 'r',
      lastRefresh: new Date().toISOString(),
    },
  });
  const first = await configureHarnessRuntime();
  assert.equal(first.ok, true);

  // Wipe auth and call again — should still report ok because the
  // module already installed the OpenAI client into the agents SDK.
  clearAuth();
  const second = await configureHarnessRuntime();
  assert.equal(second.ok, true);
});

// --- claude_oauth brain registration (either-flagship coverage) --------------
// The Claude wallet prefers the vault (BASE_DIR/state/claude-auth.json) over the
// Claude Code keychain, so writing a fake vault token makes the configure-time
// fail-closed behavior deterministic regardless of the host's real Claude login.
const CLAUDE_VAULT_FILE = path.join(AUTH_STATE_DIR, 'claude-auth.json');
function writeClaudeVault(payload: Record<string, unknown>): void {
  writeFileSync(CLAUDE_VAULT_FILE, JSON.stringify(payload, null, 2), 'utf-8');
}
function clearClaudeVault(): void { try { rmSync(CLAUDE_VAULT_FILE); } catch { /* not present */ } }

test('configureHarnessRuntime: claude_oauth registers the Claude brain on a valid oat01 token', async () => {
  const prevMode = process.env.AUTH_MODE;
  const prevDebate = process.env.CLEMMY_DEBATE_MODE;
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_DEBATE_MODE = 'off';
  writeClaudeVault({ accessToken: 'sk-ant-oat01-faketoken', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 });
  try {
    resetHarnessRuntimeConfig();
    const result = await configureHarnessRuntime();
    assert.equal(result.ok, true, result.reason);
  } finally {
    clearClaudeVault();
    if (prevMode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = prevMode;
    if (prevDebate === undefined) delete process.env.CLEMMY_DEBATE_MODE; else process.env.CLEMMY_DEBATE_MODE = prevDebate;
    resetHarnessRuntimeConfig();
  }
});

test('configureHarnessRuntime: claude_oauth FAILS CLOSED on an api03 API key (billing guard)', async () => {
  const prevMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'claude_oauth';
  writeClaudeVault({ accessToken: 'sk-ant-api03-fakeapikey' });
  try {
    resetHarnessRuntimeConfig();
    const result = await configureHarnessRuntime();
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /subscription|api03|Max\/Pro/i);
  } finally {
    clearClaudeVault();
    if (prevMode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = prevMode;
    resetHarnessRuntimeConfig();
  }
});

// REGRESSION GUARD: all_in (BYO brain) takes PRECEDENCE over a stale
// AUTH_MODE=claude_oauth. A user who set a GLM brain via the old backend form
// could be left with claude_oauth + all_in; the brain must run on GLM (no Claude
// token needed) — NOT fail closed on an expired/invalid Claude token. We prove
// the Claude preflight is SKIPPED by writing an api03 token (which would FAIL
// CLOSED if the claude_oauth branch were taken) and asserting ok:true.
test('configureHarnessRuntime: all_in + configured BYO wins over a stale claude_oauth (no Claude preflight)', async () => {
  const prev = {
    mode: process.env.AUTH_MODE, routing: process.env.MODEL_ROUTING_MODE,
    base: process.env.BYO_MODEL_BASE_URL, id: process.env.BYO_MODEL_ID,
    key: process.env.BYO_MODEL_API_KEY, debate: process.env.CLEMMY_DEBATE_MODE,
  };
  process.env.AUTH_MODE = 'claude_oauth';            // stale oauth mode
  process.env.MODEL_ROUTING_MODE = 'all_in';
  process.env.BYO_MODEL_BASE_URL = 'https://api.z.ai/api/paas/v4';
  process.env.BYO_MODEL_ID = 'glm-5.2';
  process.env.BYO_MODEL_API_KEY = 'fake-byo-key';    // → byo.configured = true
  process.env.CLEMMY_DEBATE_MODE = 'off';
  writeClaudeVault({ accessToken: 'sk-ant-api03-would-fail-closed' }); // invalid for Claude brain
  try {
    resetHarnessRuntimeConfig();
    const result = await configureHarnessRuntime();
    assert.equal(result.ok, true, result.reason); // BYO brain wins; Claude preflight skipped
  } finally {
    clearClaudeVault();
    for (const [k, envk] of [['mode','AUTH_MODE'],['routing','MODEL_ROUTING_MODE'],['base','BYO_MODEL_BASE_URL'],['id','BYO_MODEL_ID'],['key','BYO_MODEL_API_KEY'],['debate','CLEMMY_DEBATE_MODE']] as const) {
      const v = (prev as Record<string, string | undefined>)[k];
      if (v === undefined) delete process.env[envk]; else process.env[envk] = v;
    }
    resetHarnessRuntimeConfig();
  }
});

test('configureHarnessRuntime: dead Claude brain FALLS BACK to an available Codex (session-only)', async () => {
  const prev = { mode: process.env.AUTH_MODE, routing: process.env.MODEL_ROUTING_MODE };
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.MODEL_ROUTING_MODE = 'off';
  writeClaudeVault({ accessToken: 'sk-ant-api03-dead-claude' }); // Claude unusable (api03)
  writeAuth({ source: 'native', codexOauth: { accessToken: 'codex-acc', refreshToken: 'r', lastRefresh: new Date().toISOString() } });
  try {
    resetHarnessRuntimeConfig();
    const result = await configureHarnessRuntime();
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.fallback?.to, 'codex_oauth');
    assert.match(result.fallback?.note ?? '', /Claude/);
    assert.equal(process.env.AUTH_MODE, 'codex_oauth', 'session override applied (process.env only)');
  } finally {
    clearClaudeVault(); clearAuth();
    if (prev.mode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = prev.mode;
    if (prev.routing === undefined) delete process.env.MODEL_ROUTING_MODE; else process.env.MODEL_ROUTING_MODE = prev.routing;
    resetHarnessRuntimeConfig();
  }
});

// A token with no decodable JWT exp → shouldRefresh falls back to the
// lastRefresh wall-clock heuristic. `undefined` accessToken hits that path too.
const NO_EXP = undefined;

// Build a fake JWT (header.payload.sig) whose payload carries the given exp
// (epoch SECONDS), so the exp-aware branch of shouldRefresh can be exercised
// without a live token.
function jwtWithExp(expSeconds: number): string {
  const b64url = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${b64url({ alg: 'none' })}.${b64url({ exp: expSeconds })}.sig`;
}

test('shouldRefresh (heuristic fallback): missing lastRefresh forces a refresh', () => {
  assert.equal(__test__.shouldRefresh(NO_EXP, undefined), true);
  assert.equal(__test__.shouldRefresh(NO_EXP, null), true);
  assert.equal(__test__.shouldRefresh(NO_EXP, ''), true);
});

test('shouldRefresh (heuristic fallback): malformed lastRefresh forces a refresh', () => {
  assert.equal(__test__.shouldRefresh(NO_EXP, 'not-a-date'), true);
});

test('shouldRefresh (heuristic fallback): a fresh timestamp does not trigger a refresh', () => {
  const justNow = new Date().toISOString();
  assert.equal(__test__.shouldRefresh(NO_EXP, justNow), false);
});

test('shouldRefresh (heuristic fallback): a token older than REFRESH_AFTER_MS triggers a refresh', () => {
  const old = new Date(Date.now() - __test__.REFRESH_AFTER_MS - 60_000).toISOString();
  assert.equal(__test__.shouldRefresh(NO_EXP, old), true);
});

test('shouldRefresh (heuristic fallback): a token just inside the window does not trigger', () => {
  const recent = new Date(Date.now() - __test__.REFRESH_AFTER_MS + 60_000).toISOString();
  assert.equal(__test__.shouldRefresh(NO_EXP, recent), false);
});

// Exp-aware branch: when the access token carries a real exp, shouldRefresh
// decides STRICTLY off it (skew before expiry) and ignores lastRefresh — even a
// brand-new lastRefresh cannot keep an already-expired token alive.
test('shouldRefresh (exp-aware): an access token past exp triggers a refresh even with a fresh lastRefresh', () => {
  const expired = jwtWithExp(Math.floor(Date.now() / 1000) - 10);
  assert.equal(__test__.shouldRefresh(expired, new Date().toISOString()), true);
});

test('shouldRefresh (exp-aware): a token within the skew window triggers a refresh', () => {
  const expiringNow = jwtWithExp(Math.floor((Date.now() + __test__.REFRESH_SKEW_MS / 2) / 1000));
  assert.equal(__test__.shouldRefresh(expiringNow, new Date().toISOString()), true);
});

test('shouldRefresh (exp-aware): a token comfortably before exp does NOT refresh (even with a stale lastRefresh)', () => {
  const farFuture = jwtWithExp(Math.floor(Date.now() / 1000) + 30 * 60);
  const staleRefresh = new Date(Date.now() - __test__.REFRESH_AFTER_MS - 60_000).toISOString();
  assert.equal(__test__.shouldRefresh(farFuture, staleRefresh), false);
});
