import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = mkdtempSync(path.join(os.tmpdir(), 'clem-xai-refresh-'));
process.env.CLEMENTINE_HOME = temp;
const { saveXaiOAuthTokens, getStoredXaiOAuthTokens, clearXaiOAuthTokens, getFreshXaiAccessToken } = await import('./auth-store.js');
const expired = () => ({ accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: new Date(0).toISOString() });
const fresh = (name = 'new') => ({ accessToken: `${name}-access`, refreshToken: `${name}-refresh`, expiresAt: new Date(Date.now() + 3600000).toISOString() });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => clearXaiOAuthTokens());
after(() => rmSync(temp, { recursive: true, force: true }));

test('parallel requests share one refresh and all receive the rotated access token', async () => {
  saveXaiOAuthTokens(expired()); const gate = deferred(); let calls = 0;
  const refresh = async () => { calls++; await gate.promise; return fresh(); };
  const pending = Array.from({ length: 8 }, () => getFreshXaiAccessToken(refresh));
  gate.resolve(); assert.deepEqual(await Promise.all(pending), Array(8).fill('new-access'));
  assert.equal(calls, 1); assert.equal(getStoredXaiOAuthTokens()?.refreshToken, 'new-refresh');
});

for (const fails of [false, true]) test(`disconnect survives an in-flight refresh that ${fails ? 'fails' : 'succeeds'}`, async () => {
  saveXaiOAuthTokens(expired()); const gate = deferred(); const started = deferred();
  const pending = getFreshXaiAccessToken(async () => { started.resolve(); await gate.promise; if (fails) throw Error('old grant failed'); return fresh(); });
  await started.promise; clearXaiOAuthTokens(); gate.resolve();
  assert.equal(await pending, null); assert.equal(getStoredXaiOAuthTokens(), null);
});

test('a new sign-in wins over a late refresh of the previous grant', async () => {
  saveXaiOAuthTokens(expired()); const gate = deferred(); const started = deferred();
  const pending = getFreshXaiAccessToken(async () => { started.resolve(); await gate.promise; return fresh('obsolete'); });
  await started.promise; saveXaiOAuthTokens(fresh('replacement')); gate.resolve();
  assert.equal(await pending, 'replacement-access');
  assert.equal(getStoredXaiOAuthTokens()?.refreshToken, 'replacement-refresh');
});

test('replacement grants can refresh while the obsolete refresh is still pending', async () => {
  saveXaiOAuthTokens(expired()); const oldGate = deferred(); const newGate = deferred(); const started = deferred(); let calls = 0;
  const refresh = async (token: string) => { calls++; if (token === 'old-refresh') { started.resolve(); await oldGate.promise; return fresh('obsolete'); } await newGate.promise; return fresh('replacement'); };
  const old = getFreshXaiAccessToken(refresh); await started.promise;
  saveXaiOAuthTokens({ ...expired(), refreshToken: 'replacement-expired' });
  const current = getFreshXaiAccessToken(refresh); oldGate.resolve(); newGate.resolve();
  assert.deepEqual(await Promise.all([old, current]), ['replacement-access', 'replacement-access']);
  assert.equal(calls, 2); assert.equal(getStoredXaiOAuthTokens()?.refreshToken, 'replacement-refresh');
});

test('a shared refresh failure preserves the grant and permits a later retry', async () => {
  saveXaiOAuthTokens(expired()); const gate = deferred(); let calls = 0;
  const refresh = async () => { calls++; await gate.promise; throw Error('temporary network outage'); };
  const attempts = Array.from({ length: 3 }, () => getFreshXaiAccessToken(refresh)); gate.resolve();
  const results = await Promise.allSettled(attempts);
  assert.ok(results.every(r => r.status === 'rejected'));
  assert.equal(calls, 1); assert.equal(getStoredXaiOAuthTokens()?.refreshToken, 'old-refresh');
  assert.equal(await getFreshXaiAccessToken(async () => fresh()), 'new-access');
});

test('fresh or disconnected grants require no refresh', async () => {
  let calls = 0; const refresh = async () => { calls++; return fresh(); };
  assert.equal(await getFreshXaiAccessToken(refresh), null);
  saveXaiOAuthTokens(fresh()); assert.equal(await getFreshXaiAccessToken(refresh), 'new-access');
  assert.equal(calls, 0);
});
