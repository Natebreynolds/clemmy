import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    await loadFreshClaudeAccessToken();
    assert.equal(claudeVaultRefreshDead(), true);
    assert.equal(claudeVaultFallbackReady(), false, 'expired access + known-dead refresh must not be advertised as a fallback brain');

    vault.expiresAt = Date.now() + 60 * 60_000;
    assert.equal(claudeVaultFallbackReady(), true, 'a still-valid access token can run even when the refresh grant is dead');

    vault.expiresAt = Date.now() - 60_000;
    vault.refreshToken = 'new-refresh';
    assert.equal(claudeVaultRefreshDead(), false);
    assert.equal(claudeVaultFallbackReady(), true, 'a new re-auth refresh token restores fallback readiness');
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
