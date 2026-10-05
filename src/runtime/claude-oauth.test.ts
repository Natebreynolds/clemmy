import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAvailable } from './harness/judge-family.js';
import { parseClaudeCredential, assertSubscriptionToken, loadFreshClaudeAccessToken, claudeVaultRefreshDead, claudeVaultFallbackReady, getClaudeAuthSnapshot, ClaudeAuthError, __test__ } from './claude-oauth.js';

const FUTURE = Date.now() + 60 * 60_000;
const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-oauth-test-'));
__test__.setClaudeVaultDeadFileForTests(path.join(TMP, 'claude-auth-dead.json'));
__test__.setClaudeVaultDegradedFileForTests(path.join(TMP, 'claude-auth-degraded.json'));

after(() => {
  __test__.setClaudeVaultDeadFileForTests(null);
  __test__.setClaudeVaultDegradedFileForTests(null);
  rmSync(TMP, { recursive: true, force: true });
});

test('parse: Claude Code claudeAiOauth wrapper', () => {
  const t = parseClaudeCredential(JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-abc', refreshToken: 'rt', expiresAt: FUTURE, scopes: ['user:inference'], subscriptionType: 'max' },
  }));
  assert.equal(t.accessToken, 'sk-ant-oat01-abc');
  assert.equal(t.refreshToken, 'rt');
  assert.equal(t.subscriptionType, 'max');
});

test('parse: snake_case + bare object aliases', () => {
  const t = parseClaudeCredential(JSON.stringify({ access_token: 'sk-ant-oat01-x', expires_at: FUTURE }));
  assert.equal(t.accessToken, 'sk-ant-oat01-x');
});

test('billing guard: a SUBSCRIPTION oat01 token passes', () => {
  assert.equal(assertSubscriptionToken({ accessToken: 'sk-ant-oat01-good', expiresAt: FUTURE }), 'sk-ant-oat01-good');
});

test('billing guard: an API KEY (api03) is REFUSED — fail closed (never API-bill)', () => {
  assert.throws(
    () => assertSubscriptionToken({ accessToken: 'sk-ant-api03-pay-per-token' }),
    (e) => e instanceof ClaudeAuthError && e.kind === 'not_subscription',
  );
});

test('billing guard: unknown prefix is refused', () => {
  assert.throws(() => assertSubscriptionToken({ accessToken: 'weird-token' }), (e) => e instanceof ClaudeAuthError);
});

test('billing guard: missing token → kind=missing', () => {
  assert.throws(() => assertSubscriptionToken(null), (e) => e instanceof ClaudeAuthError && e.kind === 'missing');
});

test('billing guard: expired subscription token → kind=expired', () => {
  assert.throws(
    () => assertSubscriptionToken({ accessToken: 'sk-ant-oat01-old', expiresAt: Date.now() - 1000 }),
    (e) => e instanceof ClaudeAuthError && e.kind === 'expired',
  );
});

test('fresh loader falls back to Claude Code oat01 when vault refresh fails', async () => {
  __test__.setVaultTokenReaderForTests(() => ({
    accessToken: 'sk-ant-oat01-expired-vault',
    refreshToken: 'refresh',
    expiresAt: Date.now() - 60_000,
    source: 'vault',
  }));
  __test__.setRawCredentialReaderForTests(() => JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-cli-good', expiresAt: FUTURE },
  }));
  __test__.setRefreshClaudeTokensForTests(async () => { throw new Error('refresh revoked'); });
  try {
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-cli-good');
  } finally {
    __test__.setVaultTokenReaderForTests(null);
    __test__.setRawCredentialReaderForTests(null);
    __test__.setRefreshClaudeTokensForTests(null);
  }
});

test('invalid_grant refresh is attempted ONCE, then skipped until re-auth (no per-call tax/spam)', async () => {
  __test__.resetDegradedStateForTests();
  let refreshCalls = 0;
  __test__.setVaultTokenReaderForTests(() => ({
    accessToken: 'sk-ant-oat01-expired-vault',
    refreshToken: 'dead-refresh',
    expiresAt: Date.now() - 60_000,
    source: 'vault',
  }));
  __test__.setRawCredentialReaderForTests(() => JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-cli-good', expiresAt: FUTURE },
  }));
  __test__.setRefreshClaudeTokensForTests(async () => {
    refreshCalls += 1;
    throw new Error('Claude token refresh failed (400): {"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}');
  });
  try {
    // First call: refresh attempted, fails invalid_grant, falls back to CLI token.
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-cli-good');
    assert.equal(refreshCalls, 1);
    assert.equal(claudeVaultRefreshDead(), true);
    // Subsequent calls: the dead grant is NOT retried — still falls back cleanly.
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-cli-good');
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-cli-good');
    assert.equal(refreshCalls, 1, 'dead grant must not be re-attempted every call');
  } finally {
    __test__.setVaultTokenReaderForTests(null);
    __test__.setRawCredentialReaderForTests(null);
    __test__.setRefreshClaudeTokensForTests(null);
    __test__.resetDegradedStateForTests();
  }
});

test('invalid_grant dead marker survives daemon restart and suppresses doomed refresh', async () => {
  __test__.resetDegradedStateForTests();
  let refreshCalls = 0;
  __test__.setVaultTokenReaderForTests(() => ({
    accessToken: 'sk-ant-oat01-expired-vault',
    refreshToken: 'dead-refresh',
    expiresAt: Date.now() - 60_000,
    source: 'vault',
  }));
  __test__.setRawCredentialReaderForTests(() => JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-cli-good', expiresAt: FUTURE },
  }));
  __test__.setRefreshClaudeTokensForTests(async () => {
    refreshCalls += 1;
    throw new Error('Claude token refresh failed (400): {"error": "invalid_grant"}');
  });
  try {
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-cli-good');
    assert.equal(refreshCalls, 1);
    const marker = __test__.getClaudeVaultDeadStateForTests();
    assert.match(marker?.refreshTokenHash ?? '', /^[a-f0-9]{64}$/);
    assert.notEqual(marker?.refreshTokenHash, 'dead-refresh');
    const degraded = __test__.getClaudeVaultDegradedStateForTests();
    assert.match(degraded?.vaultTokenHash ?? '', /^[a-f0-9]{64}$/);
    assert.equal(degraded?.reason, 'vault_refresh_failed');

    // Simulate a daemon restart: module memory is gone, state file remains.
    __test__.resetDegradedMemoryForTests();
    assert.equal(claudeVaultRefreshDead(), true);
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-cli-good');
    assert.equal(refreshCalls, 1, 'persisted dead marker must prevent a post-restart retry');
    assert.deepEqual(
      __test__.getClaudeVaultDegradedStateForTests(),
      degraded,
      'persisted degraded marker suppresses duplicate fallback warning across restart',
    );
  } finally {
    __test__.setVaultTokenReaderForTests(null);
    __test__.setRawCredentialReaderForTests(null);
    __test__.setRefreshClaudeTokensForTests(null);
    __test__.resetDegradedStateForTests();
  }
});

test('a transient refresh failure (timeout/5xx) IS retried on the next call', async () => {
  __test__.resetDegradedStateForTests();
  let refreshCalls = 0;
  __test__.setVaultTokenReaderForTests(() => ({
    accessToken: 'sk-ant-oat01-expired-vault',
    refreshToken: 'refresh',
    expiresAt: Date.now() - 60_000,
    source: 'vault',
  }));
  __test__.setRawCredentialReaderForTests(() => JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-cli-good', expiresAt: FUTURE },
  }));
  __test__.setRefreshClaudeTokensForTests(async () => {
    refreshCalls += 1;
    throw new Error('Claude token refresh timed out after 15000ms');
  });
  try {
    await loadFreshClaudeAccessToken();
    await loadFreshClaudeAccessToken();
    assert.equal(refreshCalls, 2, 'transient failures must keep retrying');
    assert.equal(claudeVaultRefreshDead(), false);
  } finally {
    __test__.setVaultTokenReaderForTests(null);
    __test__.setRawCredentialReaderForTests(null);
    __test__.setRefreshClaudeTokensForTests(null);
    __test__.resetDegradedStateForTests();
  }
});

test('auth snapshot reports an expired Clementine vault token as configured when it is refreshable', () => {
  __test__.resetDegradedStateForTests();
  __test__.setVaultTokenReaderForTests(() => ({
    accessToken: 'sk-ant-oat01-expired-vault',
    refreshToken: 'refreshable',
    expiresAt: Date.now() - 60_000,
    source: 'vault',
  }));
  __test__.setRawCredentialReaderForTests(() => null);
  try {
    const snapshot = getClaudeAuthSnapshot();
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.source, 'vault');
    assert.equal(snapshot.refreshable, true);
    assert.match(snapshot.reason ?? '', /refreshable/i);
  } finally {
    __test__.setVaultTokenReaderForTests(null);
    __test__.setRawCredentialReaderForTests(null);
    __test__.resetDegradedStateForTests();
  }
});

test('auth snapshot reports CLI fallback as configured when the vault grant is degraded', async () => {
  __test__.resetDegradedStateForTests();
  let refreshCalls = 0;
  __test__.setVaultTokenReaderForTests(() => ({
    accessToken: 'sk-ant-oat01-expired-vault',
    refreshToken: 'dead-refresh',
    expiresAt: Date.now() - 60_000,
    source: 'vault',
  }));
  __test__.setRawCredentialReaderForTests(() => JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-cli-good', expiresAt: FUTURE },
  }));
  __test__.setRefreshClaudeTokensForTests(async () => {
    refreshCalls += 1;
    throw new Error('Claude token refresh failed (400): {"error": "invalid_grant"}');
  });
  try {
    await loadFreshClaudeAccessToken();
    assert.equal(refreshCalls, 1);
    const snapshot = getClaudeAuthSnapshot();
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.source, 'claude-code');
    assert.equal(snapshot.degraded, true);
    assert.match(snapshot.reason ?? '', /Claude Code subscription token/i);
  } finally {
    __test__.setVaultTokenReaderForTests(null);
    __test__.setRawCredentialReaderForTests(null);
    __test__.setRefreshClaudeTokensForTests(null);
    __test__.resetDegradedStateForTests();
  }
});

test('the dead-grant marker is keyed by token string — a re-auth (new refresh token) auto-recovers', async () => {
  __test__.resetDegradedStateForTests();
  // NOTE: keep every refresh throwing so the REAL saveClaudeTokens never runs —
  // a successful refresh would write the live vault file and clobber real auth.
  const vault: { accessToken: string; refreshToken: string; expiresAt: number; source: 'vault' } = {
    accessToken: 'sk-ant-oat01-expired-vault',
    refreshToken: 'dead-refresh',
    expiresAt: Date.now() - 60_000,
    source: 'vault',
  };
  __test__.setVaultTokenReaderForTests(() => ({ ...vault }));
  __test__.setRawCredentialReaderForTests(() => JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-cli-good', expiresAt: FUTURE },
  }));
  __test__.setRefreshClaudeTokensForTests(async () => {
    throw new Error('Claude token refresh failed (400): {"error": "invalid_grant"}');
  });
  try {
    await loadFreshClaudeAccessToken();
    assert.equal(claudeVaultRefreshDead(), true);
    // Re-auth rotates in a NEW refresh token. Because the dead marker is keyed by
    // the exact token string, the new grant is not considered dead, so the next
    // request re-attempts refresh instead of short-circuiting to fallback.
    vault.refreshToken = 'new-refresh';
    assert.equal(claudeVaultRefreshDead(), false, 'a new refresh token must not inherit the dead flag');
  } finally {
    __test__.setVaultTokenReaderForTests(null);
    __test__.setRawCredentialReaderForTests(null);
    __test__.setRefreshClaudeTokensForTests(null);
    __test__.resetDegradedStateForTests();
  }
});

test('fallback readiness does not advertise an expired vault token with a known-dead refresh grant', async () => {
  __test__.resetDegradedStateForTests();
  const vault: { accessToken: string; refreshToken: string; expiresAt: number; source: 'vault' } = {
    accessToken: 'sk-ant-oat01-expired-vault',
    refreshToken: 'dead-refresh',
    expiresAt: Date.now() - 60_000,
    source: 'vault',
  };
  __test__.setVaultTokenReaderForTests(() => ({ ...vault }));
  __test__.setRawCredentialReaderForTests(() => JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-cli-good', expiresAt: FUTURE },
  }));
  __test__.setRefreshClaudeTokensForTests(async () => {
    throw new Error('Claude token refresh failed (400): {"error": "invalid_grant"}');
  });
  try {
    assert.equal(claudeVaultFallbackReady(), true, 'before the server rejects it, an expired refreshable vault grant is a candidate');
    assert.equal(claudeAvailable(), true);
    await loadFreshClaudeAccessToken();
    assert.equal(claudeVaultRefreshDead(), true);
    assert.equal(claudeVaultFallbackReady(), false, 'expired access + known-dead refresh must not be advertised as a fallback brain');
    assert.equal(claudeAvailable(), true, 'valid subscription fallback remains available');
    __test__.setRawCredentialReaderForTests(() => null);
    assert.equal(claudeAvailable(), false, 'dead vault with no usable fallback is unavailable to judges too');

    vault.expiresAt = Date.now() + 60 * 60_000;
    assert.equal(claudeVaultFallbackReady(), true, 'a still-valid access token can run even when the refresh grant is dead');
    assert.equal(claudeAvailable(), true);

    vault.expiresAt = Date.now() - 60_000;
    vault.refreshToken = 'new-refresh';
    assert.equal(claudeVaultRefreshDead(), false);
    assert.equal(claudeVaultFallbackReady(), true, 'a new re-auth refresh token restores fallback readiness');
    assert.equal(claudeAvailable(), true);
  } finally {
    __test__.setVaultTokenReaderForTests(null);
    __test__.setRawCredentialReaderForTests(null);
    __test__.setRefreshClaudeTokensForTests(null);
    __test__.resetDegradedStateForTests();
  }
});

test('fresh loader never falls back to a Claude Code api03 key', async () => {
  __test__.setVaultTokenReaderForTests(() => ({
    accessToken: 'sk-ant-oat01-expired-vault',
    refreshToken: 'refresh',
    expiresAt: Date.now() - 60_000,
    source: 'vault',
  }));
  __test__.setRawCredentialReaderForTests(() => JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-api03-pay-per-token', expiresAt: FUTURE },
  }));
  __test__.setRefreshClaudeTokensForTests(async () => { throw new Error('refresh revoked'); });
  try {
    await assert.rejects(
      () => loadFreshClaudeAccessToken(),
      (e) => e instanceof ClaudeAuthError && e.kind === 'expired',
    );
  } finally {
    __test__.setVaultTokenReaderForTests(null);
    __test__.setRawCredentialReaderForTests(null);
    __test__.setRefreshClaudeTokensForTests(null);
  }
});


function resetKeychainFixture() {
  __test__.setKeychainProbeForTests(null);
  __test__.setVaultTokenReaderForTests(null);
  __test__.setRawCredentialReaderForTests(null);
  __test__.setRefreshClaudeTokensForTests(null);
  __test__.resetDegradedStateForTests();
}
const cliPayload = (expiresAt = FUTURE, accessToken = 'sk-ant-oat01-keychain-fixture') => JSON.stringify({
  claudeAiOauth: { accessToken, expiresAt, refreshToken: 'cli-owned-never-rotate' },
});

test('cold keychain readiness is one awaited probe for concurrent async callers; sync status never probes', async () => {
  resetKeychainFixture();
  __test__.setVaultTokenReaderForTests(() => null);
  let probes = 0;
  let release!: (value: { raw: string }) => void;
  __test__.setKeychainProbeForTests(async () => {
    probes += 1;
    return new Promise(resolve => { release = resolve; });
  });
  try {
    assert.equal(getClaudeAuthSnapshot().configured, false);
    assert.equal(probes, 0, 'status-only readers do not initiate a keychain prompt');
    const pending = Promise.all([loadFreshClaudeAccessToken(), loadFreshClaudeAccessToken(), loadFreshClaudeAccessToken()]);
    let timerRan = false;
    await new Promise<void>(resolve => setTimeout(() => { timerRan = true; resolve(); }, 5));
    assert.equal(timerRan, true, 'waiting for readiness never blocks the event loop');
    assert.equal(probes, 1);
    release({ raw: cliPayload() });
    assert.deepEqual(await pending, Array(3).fill('sk-ant-oat01-keychain-fixture'));
    assert.equal(getClaudeAuthSnapshot().configured, true);
    assert.equal(probes, 1);
  } finally { resetKeychainFixture(); }
});

test('a known-dead vault awaits cold CLI access without rotating either refresh grant', async () => {
  resetKeychainFixture();
  const refreshToken = 'known-dead-vault-fixture';
  __test__.setVaultTokenReaderForTests(() => ({ accessToken: 'sk-ant-oat01-expired-vault', refreshToken,
    expiresAt: Date.now() - 60_000, source: 'vault' }));
  writeFileSync(path.join(TMP, 'claude-auth-dead.json'), JSON.stringify({
    refreshTokenHash: createHash('sha256').update(refreshToken).digest('hex'), reason: 'fixture invalid_grant', since: new Date().toISOString(),
  }));
  let refreshes = 0;
  let probes = 0;
  __test__.setRefreshClaudeTokensForTests(async () => { refreshes += 1; throw new Error('must not refresh'); });
  __test__.setKeychainProbeForTests(async () => {
    probes += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { raw: cliPayload() };
  });
  try {
    const results = await Promise.all([loadFreshClaudeAccessToken(), loadFreshClaudeAccessToken()]);
    assert.deepEqual(results, Array(2).fill('sk-ant-oat01-keychain-fixture'));
    assert.equal(refreshes, 0);
    assert.equal(probes, 1);
    assert.equal(getClaudeAuthSnapshot().source, 'claude-code');
  } finally { resetKeychainFixture(); }
});

test('keychain timeout settles every waiter, caches the negative, and ignores a late result after a newer probe', async () => {
  resetKeychainFixture();
  __test__.setVaultTokenReaderForTests(() => null);
  let now = Date.now();
  let probes = 0;
  let late!: (value: { raw: string }) => void;
  __test__.setKeychainProbeForTests(async () => {
    probes += 1;
    if (probes === 1) return new Promise(resolve => { late = resolve; });
    return { raw: cliPayload(FUTURE, 'sk-ant-oat01-new-generation') };
  }, { now: () => now, timeoutMs: 25 });
  try {
    const first = await Promise.allSettled([loadFreshClaudeAccessToken(), loadFreshClaudeAccessToken()]);
    assert.ok(first.every(result => result.status === 'rejected' && result.reason instanceof ClaudeAuthError && result.reason.kind === 'missing'));
    assert.equal(probes, 1);
    await assert.rejects(loadFreshClaudeAccessToken(), (e: unknown) => e instanceof ClaudeAuthError && e.kind === 'missing');
    assert.equal(probes, 1, 'timeout negative remains cached');
    now += 5 * 60_000 + 1;
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-new-generation');
    late({ raw: cliPayload(FUTURE, 'sk-ant-oat01-stale-generation') });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-new-generation');
    assert.equal(probes, 2);
  } finally { resetKeychainFixture(); }
});

test('missing, denied, and thrown keychain probes keep the negative TTL without prompt storms', async () => {
  for (const outcome of ['missing', 'denied', 'throw'] as const) {
    resetKeychainFixture();
    __test__.setVaultTokenReaderForTests(() => null);
    let probes = 0;
    __test__.setKeychainProbeForTests(async () => {
      probes += 1;
      if (outcome === 'throw') throw new Error('fixture failure');
      return { raw: null, ...(outcome === 'denied' ? { errorCode: 'EACCES' } : {}) };
    });
    try {
      for (let index = 0; index < 3; index += 1) await assert.rejects(loadFreshClaudeAccessToken(), ClaudeAuthError);
      assert.equal(probes, 1, outcome);
    } finally { resetKeychainFixture(); }
  }
});

test('expired positive keychain access permits a bounded reread inside the TTL without retrying unchanged expired output', async () => {
  resetKeychainFixture();
  __test__.setVaultTokenReaderForTests(() => null);
  let now = Date.now();
  let probes = 0;
  let refreshes = 0;
  __test__.setRefreshClaudeTokensForTests(async () => { refreshes += 1; throw new Error('CLI refresh must never run'); });
  __test__.setKeychainProbeForTests(async () => ({ raw: ++probes < 3 ? cliPayload(Date.now() - 60_000) : cliPayload() }), { now: () => now });
  try {
    await assert.rejects(loadFreshClaudeAccessToken(), (e: unknown) => e instanceof ClaudeAuthError && e.kind === 'expired');
    for (let index = 0; index < 3; index += 1) await assert.rejects(loadFreshClaudeAccessToken(), ClaudeAuthError);
    assert.equal(probes, 1);
    now += 30_001;
    await assert.rejects(loadFreshClaudeAccessToken(), ClaudeAuthError);
    assert.equal(probes, 2, 'expired access can be reread before the five-minute TTL');
    for (let index = 0; index < 3; index += 1) await assert.rejects(loadFreshClaudeAccessToken(), ClaudeAuthError);
    assert.equal(probes, 2, 'unchanged expired output has a cooldown');
    now += 30_001;
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-keychain-fixture');
    assert.equal(probes, 3);
    assert.equal(refreshes, 0);
  } finally { resetKeychainFixture(); }
});

test('healthy own vault and isolated system access do not probe; keychain API keys remain refused', async () => {
  resetKeychainFixture();
  let probes = 0;
  __test__.setVaultTokenReaderForTests(() => ({ accessToken: 'sk-ant-oat01-healthy-vault', expiresAt: FUTURE, source: 'vault' }));
  __test__.setKeychainProbeForTests(async () => { probes += 1; return { raw: cliPayload() }; });
  try {
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-healthy-vault');
    assert.equal(probes, 0);
    __test__.setVaultTokenReaderForTests(() => null);
    __test__.setKeychainProbeForTests(async () => { probes += 1; return { raw: cliPayload() }; }, { enabled: false });
    await assert.rejects(loadFreshClaudeAccessToken(), ClaudeAuthError);
    assert.equal(probes, 0, 'the disabled/isolation boundary prevents even the mock probe');
    for (const key of ['sk-ant-api03-billing-forbidden', 'unknown-key-kind']) {
      __test__.setKeychainProbeForTests(async () => ({ raw: cliPayload(FUTURE, key) }));
      await assert.rejects(loadFreshClaudeAccessToken(), (e: unknown) => e instanceof ClaudeAuthError && e.kind === 'not_subscription');
    }
  } finally { resetKeychainFixture(); }
});


test('aged healthy CLI access refreshes the positive cache once without waiting for token expiry', async () => {
  resetKeychainFixture();
  __test__.setVaultTokenReaderForTests(() => null);
  let now = Date.now();
  let probes = 0;
  __test__.setKeychainProbeForTests(async () => {
    probes += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { raw: cliPayload(FUTURE, probes === 1 ? 'sk-ant-oat01-first-valid' : 'sk-ant-oat01-new-valid') };
  }, { now: () => now });
  try {
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-first-valid');
    now += 5 * 60_000 + 1;
    assert.deepEqual(await Promise.all([loadFreshClaudeAccessToken(), loadFreshClaudeAccessToken()]), Array(2).fill('sk-ant-oat01-new-valid'));
    assert.equal(probes, 2);
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-new-valid');
    assert.equal(probes, 2);
  } finally { resetKeychainFixture(); }
});

test('a keychain probe that times out keeps the credential it already handed us', async () => {
  resetKeychainFixture();
  __test__.setVaultTokenReaderForTests(() => null);
  let now = Date.now();
  let probes = 0;
  __test__.setKeychainProbeForTests(async () => {
    probes += 1;
    if (probes === 1) return { raw: cliPayload(FUTURE, 'sk-ant-oat01-retained') };
    return new Promise(() => { /* the store never answers */ });
  }, { now: () => now, timeoutMs: 25 });
  try {
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-retained');
    now += 6 * 60_000; // past the refresh cadence: the next read re-probes
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-retained', 'a slow store is not an absent credential');
    assert.equal(probes, 2);
    assert.equal(getClaudeAuthSnapshot().configured, true);
  } finally { resetKeychainFixture(); }
});

test('an expired CLI-owned credential waits briefly for the CLI refresh instead of failing the call', async () => {
  resetKeychainFixture();
  __test__.setVaultTokenReaderForTests(() => null);
  let probes = 0;
  __test__.setKeychainProbeForTests(async () => {
    probes += 1;
    if (probes < 3) return { raw: cliPayload(Date.now() - 1, 'sk-ant-oat01-stale') };
    return { raw: cliPayload(FUTURE, 'sk-ant-oat01-refreshed-by-cli') };
  }, { cliRefreshWaitMs: 500, cliRefreshPollMs: 10 });
  try {
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-refreshed-by-cli');
    assert.ok(probes >= 3, `re-probed until the refresh landed (${probes})`);
  } finally { resetKeychainFixture(); }
});

test('an expired CLI-owned credential still fails closed once the bounded wait ends', async () => {
  resetKeychainFixture();
  __test__.setVaultTokenReaderForTests(() => null);
  __test__.setKeychainProbeForTests(async () => ({ raw: cliPayload(Date.now() - 1, 'sk-ant-oat01-stale') }),
    { cliRefreshWaitMs: 40, cliRefreshPollMs: 10 });
  try {
    await assert.rejects(() => loadFreshClaudeAccessToken(), (e) => e instanceof ClaudeAuthError && e.kind === 'expired');
  } finally { resetKeychainFixture(); }
});

// ── refresh outlives its callers; one refresh per token ─────────────────────
// The 10-02 failure: four refreshes timed out client-side in a network blip;
// Anthropic rotates the refresh token on success, so a completed-but-abandoned
// refresh threw the new token away and the next one was invalid_grant.

function vaultFixture(refreshToken: string) {
  let stored: { accessToken: string; refreshToken: string; expiresAt: number; source: 'vault' } | null = { accessToken: 'sk-ant-oat01-expired-vault', refreshToken, expiresAt: Date.now() - 60_000, source: 'vault' };
  const saved: Array<{ accessToken: string; refreshToken?: string }> = [];
  __test__.setVaultTokenReaderForTests(() => stored);
  __test__.setSaveRefreshedTokensForTests((tokens) => {
    saved.push(tokens);
    stored = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? refreshToken, expiresAt: tokens.expiresAt ?? Date.now() + 3_600_000, source: 'vault' };
  });
  return { saved, replace: (next: NonNullable<typeof stored>) => { stored = next; }, clear: () => { stored = null; } };
}

function resetRefreshFixture() {
  __test__.setVaultTokenReaderForTests(null);
  __test__.setRawCredentialReaderForTests(null);
  __test__.setRefreshClaudeTokensForTests(null);
  __test__.setSaveRefreshedTokensForTests(null);
  __test__.setRefreshWaitMsForTests(null);
  __test__.resetDegradedStateForTests();
}

test('concurrent requests near expiry share ONE refresh of the rotating token', async () => {
  __test__.resetDegradedStateForTests();
  const fixture = vaultFixture('rotating-1');
  __test__.setRawCredentialReaderForTests(() => null);
  let calls = 0;
  __test__.setRefreshClaudeTokensForTests(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { accessToken: 'sk-ant-oat01-fresh', refreshToken: 'rotating-2', expiresAt: Date.now() + 3_600_000 };
  });
  try {
    const [a, b, c] = await Promise.all([loadFreshClaudeAccessToken(), loadFreshClaudeAccessToken(), loadFreshClaudeAccessToken()]);
    assert.equal(calls, 1, 'one refresh, shared');
    assert.deepEqual([a, b, c], ['sk-ant-oat01-fresh', 'sk-ant-oat01-fresh', 'sk-ant-oat01-fresh']);
    assert.equal(fixture.saved.length, 1);
    assert.equal(fixture.saved[0]!.refreshToken, 'rotating-2', 'the rotated token is persisted');
  } finally {
    resetRefreshFixture();
  }
});

test('a refresh slower than the wait still saves the rotated token when it lands', async () => {
  __test__.resetDegradedStateForTests();
  const fixture = vaultFixture('slow-1');
  __test__.setRawCredentialReaderForTests(() => JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-cli-good', expiresAt: FUTURE } }));
  __test__.setRefreshWaitMsForTests(10);
  let deadline: number | undefined;
  __test__.setRefreshClaudeTokensForTests(async (_token, options) => {
    deadline = options?.timeoutMs;
    await new Promise((r) => setTimeout(r, 60));
    return { accessToken: 'sk-ant-oat01-late', refreshToken: 'slow-2', expiresAt: Date.now() + 3_600_000 };
  });
  try {
    const first = await loadFreshClaudeAccessToken();
    assert.equal(first, 'sk-ant-oat01-cli-good', 'the request does not wait past its budget');
    assert.ok((deadline ?? 0) > 15_000, 'the refresh itself is not abandoned at the request budget');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(fixture.saved.at(-1)?.refreshToken, 'slow-2', 'the server-side rotation is not lost');
    assert.equal(claudeVaultRefreshDead(), false);
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-late');
  } finally {
    resetRefreshFixture();
  }
});

test('an invalid_grant for a token another refresh already replaced does not kill the grant', async () => {
  __test__.resetDegradedStateForTests();
  const fixture = vaultFixture('old-token');
  __test__.setRawCredentialReaderForTests(() => null);
  __test__.setRefreshClaudeTokensForTests(async () => {
    // Meanwhile another process refreshed and wrote the new grant.
    fixture.replace({ accessToken: 'sk-ant-oat01-from-other-refresh', refreshToken: 'new-token', expiresAt: Date.now() + 3_600_000, source: 'vault' });
    throw new Error('Claude token refresh failed (400): {"error": "invalid_grant"}');
  });
  try {
    assert.equal(await loadFreshClaudeAccessToken(), 'sk-ant-oat01-from-other-refresh');
    assert.equal(claudeVaultRefreshDead(), false);
  } finally {
    resetRefreshFixture();
  }
});


function delayedClaudeRefresh<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const change of ['replace', 'clear', 'same-refresh-token-new-access'] as const) {
  for (const outcome of ['success', 'terminal'] as const) {
    test(`Claude supersession: ${change} wins over a delayed ${outcome} refresh`, async () => {
      __test__.resetDegradedStateForTests();
      const fixture = vaultFixture('original-refresh-fixture');
      __test__.setRawCredentialReaderForTests(() => null);
      const entered = delayedClaudeRefresh<void>();
      const provider = delayedClaudeRefresh<{ accessToken: string; refreshToken: string; expiresAt: number }>();
      __test__.setRefreshClaudeTokensForTests(async () => { entered.resolve(); return provider.promise; });
      try {
        const pending = loadFreshClaudeAccessToken();
        const observed = pending.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
        await entered.promise;
        if (change === 'clear') fixture.clear();
        else fixture.replace({ accessToken: 'sk-ant-oat01-replacement-fixture', refreshToken: change === 'replace' ? 'replacement-refresh-fixture' : 'original-refresh-fixture', expiresAt: FUTURE, source: 'vault' });
        if (outcome === 'success') provider.resolve({ accessToken: 'sk-ant-oat01-old-result-fixture', refreshToken: 'old-rotation-fixture', expiresAt: FUTURE });
        else provider.reject(new Error('Claude token refresh failed (400): invalid_grant'));
        const result = await observed;
        assert.equal(fixture.saved.length, 0, 'obsolete refresh must not persist');
        if (change === 'clear') assert.ok(result.error instanceof ClaudeAuthError && result.error.kind === 'missing', 'cleared credentials must stay missing');
        else assert.equal(result.value === 'sk-ant-oat01-replacement-fixture', true, 'use the current credential under existing selection policy');
        assert.equal(claudeVaultRefreshDead(), false, 'do not mark a replacement grant dead');
        assert.equal(existsSync(path.join(TMP, 'claude-auth-dead.json')), false, 'no stale durable dead marker after replacement/clear');
        assert.equal(existsSync(path.join(TMP, 'claude-auth-degraded.json')), false, 'no stale fallback/degraded marker');
      } finally { resetRefreshFixture(); }
    });
  }
}


for (const change of ['replace', 'clear'] as const) {
  test(`Claude supersession: ${change} during fallback readiness does not inherit a stale degraded marker`, async () => {
    resetKeychainFixture();
    __test__.resetDegradedStateForTests();
    const fixture = vaultFixture('fallback-original-fixture');
    const entered = delayedClaudeRefresh<void>();
    const probe = delayedClaudeRefresh<{ raw: string }>();
    __test__.setKeychainProbeForTests(async () => { entered.resolve(); return probe.promise; });
    __test__.setRefreshClaudeTokensForTests(async () => { throw new Error('temporary provider failure'); });
    try {
      const pending = loadFreshClaudeAccessToken();
      await entered.promise;
      if (change === 'clear') fixture.clear();
      else fixture.replace({ accessToken: 'sk-ant-oat01-replacement-fixture', refreshToken: 'replacement-fixture', expiresAt: FUTURE, source: 'vault' });
      probe.resolve({ raw: cliPayload(FUTURE, 'sk-ant-oat01-cli-current-fixture') });
      const result = await pending;
      assert.equal(result === (change === 'clear' ? 'sk-ant-oat01-cli-current-fixture' : 'sk-ant-oat01-replacement-fixture'), true, 'current source policy wins');
      assert.equal(fixture.saved.length, 0);
      assert.equal(existsSync(path.join(TMP, 'claude-auth-degraded.json')), false, 'old vault failure cannot mark the new state degraded');
    } finally { resetRefreshFixture(); resetKeychainFixture(); }
  });

  test(`Claude supersession: ${change} after caller timeout defeats background refresh completion`, async () => {
    __test__.resetDegradedStateForTests();
    const fixture = vaultFixture('background-original-fixture');
    __test__.setRawCredentialReaderForTests(() => cliPayload(FUTURE, 'sk-ant-oat01-cli-current-fixture'));
    __test__.setRefreshWaitMsForTests(10);
    const provider = delayedClaudeRefresh<{ accessToken: string; refreshToken: string; expiresAt: number }>();
    __test__.setRefreshClaudeTokensForTests(async () => provider.promise);
    // waitAtMost intentionally unrefs its timer; keep this controlled delayed
    // provider fixture alive until the caller's timeout has actually occurred.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      assert.equal(await loadFreshClaudeAccessToken() === 'sk-ant-oat01-cli-current-fixture', true, 'caller uses existing fallback while the original grant is current');
      if (change === 'clear') fixture.clear();
      else fixture.replace({ accessToken: 'sk-ant-oat01-replacement-fixture', refreshToken: 'replacement-fixture', expiresAt: FUTURE, source: 'vault' });
      provider.resolve({ accessToken: 'sk-ant-oat01-obsolete-result-fixture', refreshToken: 'obsolete-rotation-fixture', expiresAt: FUTURE });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(fixture.saved.length, 0, 'background completion cannot restore the superseded grant');
    } finally { clearTimeout(keepAlive); resetRefreshFixture(); }
  });
}


for (const outcome of ['terminal', 'timeout'] as const) {
  test(`Claude supersession: coalesced waiter uses the originating grant for ${outcome}`, async () => {
    __test__.resetDegradedStateForTests();
    const fixture = vaultFixture('shared-refresh-fixture');
    __test__.setRawCredentialReaderForTests(() => null);
    __test__.setRefreshWaitMsForTests(15);
    const entered = delayedClaudeRefresh<void>();
    const provider = delayedClaudeRefresh<{ accessToken: string; refreshToken: string; expiresAt: number }>();
    let calls = 0;
    __test__.setRefreshClaudeTokensForTests(async () => { calls += 1; entered.resolve(); return provider.promise; });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      const first = loadFreshClaudeAccessToken();
      await entered.promise;
      fixture.replace({ accessToken: 'sk-ant-oat01-replacement-fixture', refreshToken: 'shared-refresh-fixture', expiresAt: Date.now() + 120_000, source: 'vault' });
      const second = loadFreshClaudeAccessToken();
      if (outcome === 'terminal') provider.reject(new Error('Claude token refresh failed (400): invalid_grant'));
      const results = await Promise.all([first, second]);
      assert.equal(calls, 1, 'never spend the same rotating refresh token twice');
      assert.equal(results.every(value => value === 'sk-ant-oat01-replacement-fixture'), true, 'both waiters use current credentials');
      assert.equal(claudeVaultRefreshDead(), false, 'old shared error cannot poison the replacement');
      assert.equal(existsSync(path.join(TMP, 'claude-auth-dead.json')), false);
      assert.equal(existsSync(path.join(TMP, 'claude-auth-degraded.json')), false);
    } finally {
      provider.resolve({ accessToken: 'sk-ant-oat01-obsolete-result-fixture', refreshToken: 'obsolete-rotation-fixture', expiresAt: FUTURE });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(fixture.saved.length, 0, 'shared background work stays superseded');
      clearTimeout(keepAlive);
      resetRefreshFixture();
    }
  });
}
