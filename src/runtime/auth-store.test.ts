/**
 * Run: npx tsx --test src/runtime/auth-store.test.ts
 *
 * The Codex OAuth refresh must be SAFE under concurrency. Codex rotates refresh
 * tokens with reuse-detection: submitting an already-consumed RT revokes the
 * whole family (`token_revoked`). The harness fires many agents at once, each
 * calling the refresh at the ~50-min boundary — so the refresh has to use the
 * RT exactly once. These tests prove the single-flight + skip-if-recent guards.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-auth-store-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;
process.env.AUTH_MODE = 'codex_oauth'; // exercise the codex branches of getAuthStatus
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  refreshStoredNativeOAuth,
  __setRefreshTokenImplForTests,
  bootstrapCodexAuth,
  getAuthStatus,
  classifyCodexAuthError,
  isCodexAuthDead,
  clearCodexAuthDead,
  accessTokenExpiresSoon,
  accessTokenExpMs,
} = await import('./auth-store.js');

// Build a fake JWT (header.payload.sig) whose payload carries the given exp
// (epoch SECONDS) so the exp helpers can be exercised without a live token.
function jwtWithExp(expSeconds: number): string {
  const b64url = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${b64url({ alg: 'none' })}.${b64url({ exp: expSeconds })}.sig`;
}

const AUTH_FILE = path.join(TMP_HOME, 'state', 'auth.json');
const LOCK_FILE = path.join(TMP_HOME, 'state', 'codex-refresh.lock');
const DEAD_FILE = path.join(TMP_HOME, 'state', 'codex-auth-dead.json');
const CLI_AUTH_FILE = path.join(TMP_HOME, '.codex', 'auth.json');

function writeNativeVault(refreshToken = 'RT_native'): void {
  writeFileSync(AUTH_FILE, JSON.stringify({
    source: 'native',
    codexOauth: { accessToken: 'AT_native', refreshToken, accountId: 'acct', lastRefresh: new Date().toISOString() },
  }), 'utf-8');
}

function writeCliAuth(refreshToken = 'RT_cli'): void {
  mkdirSync(path.join(TMP_HOME, '.codex'), { recursive: true });
  writeFileSync(CLI_AUTH_FILE, JSON.stringify({
    tokens: { access_token: 'AT_cli', refresh_token: refreshToken, account_id: 'acct' },
    last_refresh: new Date().toISOString(),
  }), 'utf-8');
}

function writeStoredAuth(lastRefreshIso: string, refreshToken = 'RT1'): void {
  writeFileSync(AUTH_FILE, JSON.stringify({
    source: 'native',
    codexOauth: { accessToken: 'AT1', refreshToken, idToken: 'ID1', accountId: 'acct', lastRefresh: lastRefreshIso },
  }), 'utf-8');
}

function storedRefreshToken(): string | undefined {
  return JSON.parse(readFileSync(AUTH_FILE, 'utf-8')).codexOauth?.refreshToken;
}

const tenMinAgo = () => new Date(Date.now() - 10 * 60 * 1000).toISOString();

beforeEach(() => {
  rmSync(LOCK_FILE, { force: true });
  rmSync(AUTH_FILE, { force: true });
  rmSync(CLI_AUTH_FILE, { force: true });
  rmSync(DEAD_FILE, { force: true });
  __setRefreshTokenImplForTests(null);
});

// ── Terminal-vs-transient taxonomy + DEAD latch (the "stop hammering a revoked
// token / don't re-auth on a 429" gap, adopted from the Hermes harness). ──

test('classifyCodexAuthError: revoke/reuse/invalid_grant/401 = terminal; 429/quota/5xx = transient', () => {
  for (const m of ['token_revoked', 'Encountered invalidated oauth token', 'refresh_token_reused', 'invalid_grant', 'unauthorized_client']) {
    assert.equal(classifyCodexAuthError({ message: m }), 'terminal', `${m} should be terminal`);
  }
  assert.equal(classifyCodexAuthError({ status: 401 }), 'terminal', '401 is terminal');
  // The critical false-alarm guard: a quota 429 must NOT be a revoke.
  assert.equal(classifyCodexAuthError({ status: 429, message: 'Rate limit exceeded' }), 'transient', '429 is transient, not a revoke');
  assert.equal(classifyCodexAuthError({ status: 503 }), 'transient', '5xx is transient');
  assert.equal(classifyCodexAuthError({ message: 'something unrelated' }), null, 'non-auth error is null');
});

test('classifyCodexAuthError: a MARKER-LESS 401 is transient on a model call, terminal on the refresh endpoint', () => {
  // The bug fix: a bare model-call 401 (access-token expiry / edge reject) must
  // NOT be treated as a revoke — it is a refresh-and-retry signal.
  assert.equal(classifyCodexAuthError({ status: 401, source: 'model' }), 'transient', 'bare model 401 = needs-refresh, not a logout');
  // …but a 401 carrying a real revoke marker is terminal even on the model call.
  assert.equal(classifyCodexAuthError({ status: 401, source: 'model', message: 'token_revoked' }), 'terminal', 'a real revoke marker is still terminal on a model call');
  // On the refresh/token endpoint a bare 401 means the refresh token was rejected → terminal.
  assert.equal(classifyCodexAuthError({ status: 401, source: 'refresh' }), 'terminal', 'a refresh-endpoint 401 is terminal');
  // Default (no source) stays conservative/terminal — preserves the refresh path.
  assert.equal(classifyCodexAuthError({ status: 401 }), 'terminal', 'no-source 401 stays terminal (legacy)');
});

test('accessTokenExpMs / accessTokenExpiresSoon: decode real exp; tolerate non-JWT tokens', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const future = jwtWithExp(nowSec + 30 * 60);
  const past = jwtWithExp(nowSec - 10);

  assert.equal(typeof accessTokenExpMs(future), 'number');
  assert.equal(accessTokenExpMs('opaque-not-a-jwt'), null, 'no decodable exp → null');
  assert.equal(accessTokenExpMs(undefined), null);

  assert.equal(accessTokenExpiresSoon(future, 60_000), false, 'a token 30m out is not expiring');
  assert.equal(accessTokenExpiresSoon(past, 60_000), true, 'an expired token is expiring');
  assert.equal(accessTokenExpiresSoon('opaque-not-a-jwt'), false, 'no exp → not expiring (caller falls back to heuristic)');
});

test('a terminal refresh failure latches DEAD and short-circuits the next refresh (no replay of the dead RT)', async () => {
  writeStoredAuth(tenMinAgo(), 'RT1');
  let calls = 0;
  __setRefreshTokenImplForTests(async () => {
    calls += 1;
    throw Object.assign(new Error('Native OAuth refresh failed (401): token_revoked'), { status: 401 });
  });

  const first = await refreshStoredNativeOAuth();
  assert.equal(first.ok, false);
  assert.equal(first.terminal, true, 'terminal failure flagged');
  assert.equal(isCodexAuthDead(), true, 'auth is latched DEAD');
  assert.equal(calls, 1, 'the dead RT was POSTed exactly once');

  // Next refresh must NOT POST again — it short-circuits on the latch.
  const second = await refreshStoredNativeOAuth();
  assert.equal(second.ok, false);
  assert.equal(second.terminal, true);
  assert.equal(calls, 1, 'no second POST of the revoked refresh token');
});

test('a TRANSIENT refresh failure (429) does NOT latch DEAD — the token is still valid', async () => {
  writeStoredAuth(tenMinAgo(), 'RT1');
  __setRefreshTokenImplForTests(async () => {
    throw Object.assign(new Error('Native OAuth refresh failed (429): Rate limit exceeded'), { status: 429 });
  });

  const res = await refreshStoredNativeOAuth();
  assert.equal(res.ok, false);
  assert.notEqual(res.terminal, true, 'a 429 is not terminal');
  assert.equal(isCodexAuthDead(), false, 'a quota 429 must never brick auth');
});

test('a successful refresh after a revoke clears the DEAD latch (recovery signal)', async () => {
  // Latch dead first.
  writeStoredAuth(tenMinAgo(), 'RT1');
  __setRefreshTokenImplForTests(async () => { throw Object.assign(new Error('token_revoked'), { status: 401 }); });
  await refreshStoredNativeOAuth();
  assert.equal(isCodexAuthDead(), true);

  // Simulate re-auth: a fresh token is written, then a refresh succeeds.
  clearCodexAuthDead(); // (login/import would clear it; emulate the re-auth write)
  writeStoredAuth(tenMinAgo(), 'RT_new');
  __setRefreshTokenImplForTests(async () => ({ accessToken: 'AT2', refreshToken: 'RT2', idToken: 'ID2', accountId: 'acct', lastRefresh: new Date().toISOString() }));
  const res = await refreshStoredNativeOAuth();
  assert.ok(res.ok, 'refresh succeeds after re-auth');
  assert.equal(isCodexAuthDead(), false, 'a successful token write lifts the latch');
});

// The codex-logout-revokes-Clem trap: bootstrap used to end on an unconditional
// importCodexCliAuth, clobbering a freshly-minted native grant with the CLI's shared
// token family. A `codex logout` then revoked that family and signed Clementine out.
test('bootstrap keeps Clem’s own native grant — never downgrades to the CLI’s shared family', async () => {
  writeNativeVault('RT_native');   // Clementine already owns an independent grant
  writeCliAuth('RT_cli');          // the Codex CLI is signed in with a DIFFERENT family

  const res = await bootstrapCodexAuth();

  assert.ok(res.ok, 'bootstrap succeeds');
  const vault = JSON.parse(readFileSync(AUTH_FILE, 'utf-8'));
  assert.equal(vault.source, 'native', 'source stays native — not downgraded to codex_cli');
  assert.equal(vault.codexOauth.refreshToken, 'RT_native', 'native RT must NOT be clobbered by the CLI import');
});

test('auth status flags a CLI-shared sign-in (imported grant) with the decouple remedy', () => {
  writeFileSync(AUTH_FILE, JSON.stringify({
    source: 'codex_cli',
    codexOauth: { accessToken: 'AT', refreshToken: 'RT', accountId: 'acct', lastRefresh: new Date().toISOString() },
  }), 'utf-8');

  const status = getAuthStatus();
  assert.equal(status.codexOauthPresent, true);
  assert.equal(status.codexSharedWithCli, true, 'an imported CLI grant is flagged as shared');
  assert.match(status.message, /login-device/i, 'message points at the decouple remedy (device-code login)');
});

test('auth status does NOT flag an independent native grant as shared', () => {
  writeNativeVault('RT_native');

  const status = getAuthStatus();
  assert.equal(status.codexOauthPresent, true);
  assert.equal(status.codexSharedWithCli, false, 'a native grant is independent of the CLI');
});

test('concurrent refreshes coalesce into ONE network rotation (no RT reuse → no token_revoked)', async () => {
  writeStoredAuth(tenMinAgo(), 'RT1');
  let calls = 0;
  const seenRTs: string[] = [];
  __setRefreshTokenImplForTests(async (rt: string) => {
    calls += 1;
    seenRTs.push(rt);
    await new Promise((r) => setTimeout(r, 60)); // widen the overlap window
    return { accessToken: 'AT2', refreshToken: 'RT2', idToken: 'ID2', accountId: 'acct', lastRefresh: new Date().toISOString() };
  });

  // 12 agents hit the refresh at the same instant (the real failure mode).
  const results = await Promise.all(Array.from({ length: 12 }, () => refreshStoredNativeOAuth()));

  assert.equal(calls, 1, 'the rotating refresh token must be submitted exactly once');
  assert.deepEqual(seenRTs, ['RT1'], 'the one rotation used the original RT');
  assert.ok(results.every((r) => r.ok), 'every caller gets a success (shared result)');
  assert.equal(storedRefreshToken(), 'RT2', 'the rotated RT is persisted');
});

test('skip-if-just-refreshed: a refresh right after a successful one does NOT re-submit the rotated RT', async () => {
  // Token was refreshed 5s ago (inside the 2-min skip window).
  writeStoredAuth(new Date(Date.now() - 5_000).toISOString(), 'RT2');
  let calls = 0;
  __setRefreshTokenImplForTests(async () => { calls += 1; return { accessToken: 'AT3', refreshToken: 'RT3', idToken: 'ID3', accountId: 'acct', lastRefresh: new Date().toISOString() }; });

  const res = await refreshStoredNativeOAuth();

  assert.equal(calls, 0, 'must NOT POST again — a sibling just refreshed; reuse their token');
  assert.ok(res.ok);
  assert.equal(storedRefreshToken(), 'RT2', 'the just-rotated RT is left untouched');
});

test('force refresh bypasses the time-based skip window (a 401 rejected the current token NOW)', async () => {
  // Token was refreshed 5s ago (inside the 2-min skip window) — a normal refresh
  // would skip. But a model-call 401 means the current access token is being
  // rejected right now, so `force` must actually POST a fresh rotation.
  writeStoredAuth(new Date(Date.now() - 5_000).toISOString(), 'RT2');
  let calls = 0;
  __setRefreshTokenImplForTests(async () => { calls += 1; return { accessToken: 'AT3', refreshToken: 'RT3', idToken: 'ID3', accountId: 'acct', lastRefresh: new Date().toISOString() }; });

  const skipped = await refreshStoredNativeOAuth();         // no force → skip
  assert.equal(calls, 0, 'without force, a recent refresh is reused (skip window)');
  assert.ok(skipped.ok);

  const forced = await refreshStoredNativeOAuth({ force: true }); // force → real rotation
  assert.equal(calls, 1, 'force POSTs a fresh rotation despite the recent refresh');
  assert.ok(forced.ok);
  assert.equal(storedRefreshToken(), 'RT3', 'the forced rotation is persisted');
});

test('a genuinely stale token still refreshes (guards do not block legitimate refresh)', async () => {
  writeStoredAuth(tenMinAgo(), 'RT1');
  let calls = 0;
  __setRefreshTokenImplForTests(async () => { calls += 1; return { accessToken: 'AT2', refreshToken: 'RT2', idToken: 'ID2', accountId: 'acct', lastRefresh: new Date().toISOString() }; });

  const res = await refreshStoredNativeOAuth();

  assert.equal(calls, 1);
  assert.ok(res.ok);
  assert.equal(storedRefreshToken(), 'RT2');
  // Lock is released after the refresh (no deadlock for the next one).
  assert.equal(existsSync(LOCK_FILE), false, 'refresh lock is released');
});

test('missing refresh token → ok:false, no crash', async () => {
  writeFileSync(AUTH_FILE, JSON.stringify({ source: 'native', codexOauth: {} }), 'utf-8');
  const res = await refreshStoredNativeOAuth();
  assert.equal(res.ok, false);
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});
