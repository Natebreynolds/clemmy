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
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { refreshStoredNativeOAuth, __setRefreshTokenImplForTests } = await import('./auth-store.js');

const AUTH_FILE = path.join(TMP_HOME, 'state', 'auth.json');
const LOCK_FILE = path.join(TMP_HOME, 'state', 'codex-refresh.lock');

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
  __setRefreshTokenImplForTests(null);
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
