/**
 * Run: npx tsx --test src/runtime/auth-keepalive.test.ts
 *
 * The proactive keepalive must: refresh a soon-to-expire token while idle,
 * leave a comfortably-fresh token alone, never touch a DEAD-latched token, and
 * announce a dead→alive recovery exactly once.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-auth-keepalive-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;
process.env.AUTH_MODE = 'codex_oauth';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const AUTH_FILE = path.join(TMP_HOME, 'state', 'auth.json');
const LOCK_FILE = path.join(TMP_HOME, 'state', 'codex-refresh.lock');
const DEAD_FILE = path.join(TMP_HOME, 'state', 'codex-auth-dead.json');

const { tickAuthKeepalive, __resetAuthKeepaliveStateForTests } = await import('./auth-keepalive.js');
const { __setRefreshTokenImplForTests, markCodexAuthDead, clearCodexAuthDead } = await import('./auth-store.js');
const { getNotification } = await import('./notifications.js');

function jwtWithExp(expSeconds: number): string {
  const b64 = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${b64({ alg: 'none' })}.${b64({ exp: expSeconds })}.sig`;
}

// expSecondsFromNow: when the access token expires; lastRefreshAgoMs: how long
// ago the last refresh happened (controls the 2-min skip window).
function writeVault(expSecondsFromNow: number, lastRefreshAgoMs: number, refreshToken = 'RT1'): void {
  writeFileSync(AUTH_FILE, JSON.stringify({
    source: 'native',
    codexOauth: {
      grantProvenance: 'clementine-oauth-v1',
      grantId: 'grant-auth-keepalive-test',
      accessToken: jwtWithExp(Math.floor(Date.now() / 1000) + expSecondsFromNow),
      refreshToken,
      accountId: 'acct',
      lastRefresh: new Date(Date.now() - lastRefreshAgoMs).toISOString(),
    },
  }), 'utf-8');
}

beforeEach(() => {
  rmSync(LOCK_FILE, { force: true });
  rmSync(AUTH_FILE, { force: true });
  rmSync(DEAD_FILE, { force: true });
  __setRefreshTokenImplForTests(null);
  __resetAuthKeepaliveStateForTests();
});

test('keepalive refreshes a token that is about to expire (while idle)', async () => {
  // Expires in 60s (inside the 5-min keepalive skew); last refresh 10 min ago
  // (outside the 2-min skip window) so a real rotation is attempted.
  writeVault(60, 10 * 60 * 1000, 'RT1');
  let calls = 0;
  __setRefreshTokenImplForTests(async () => {
    calls += 1;
    return { accessToken: jwtWithExp(Math.floor(Date.now() / 1000) + 3600), refreshToken: 'RT2', idToken: 'ID2', accountId: 'acct', lastRefresh: new Date().toISOString() };
  });

  await tickAuthKeepalive();
  assert.equal(calls, 1, 'a soon-to-expire token is refreshed proactively');
});

test('keepalive leaves a comfortably-fresh token alone (no unnecessary rotation)', async () => {
  writeVault(30 * 60, 10 * 60 * 1000, 'RT1'); // expires in 30 min — not soon
  let calls = 0;
  __setRefreshTokenImplForTests(async () => { calls += 1; return { accessToken: 'x', refreshToken: 'RT2', lastRefresh: new Date().toISOString() }; });

  await tickAuthKeepalive();
  assert.equal(calls, 0, 'a token far from expiry is not rotated');
});

test('keepalive never replays a DEAD-latched token, and announces recovery on dead→alive', async () => {
  writeVault(60, 10 * 60 * 1000, 'RT1');
  let calls = 0;
  __setRefreshTokenImplForTests(async () => { calls += 1; return { accessToken: 'x', refreshToken: 'RT2', lastRefresh: new Date().toISOString() }; });

  await markCodexAuthDead('refresh token revoked');
  await tickAuthKeepalive();
  assert.equal(calls, 0, 'a DEAD latch short-circuits — never POST the dead RT');

  // Simulate a re-auth landing between ticks, then tick again → recovery notice.
  clearCodexAuthDead();
  await tickAuthKeepalive();
  const recoveredId = `system-codex-auth-recovered-${new Date().toISOString().slice(0, 10)}`;
  assert.ok(getNotification(recoveredId), 'a dead→alive transition emits a recovery notification');
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});
