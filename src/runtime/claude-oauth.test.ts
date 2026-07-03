import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeCredential, assertSubscriptionToken, loadFreshClaudeAccessToken, ClaudeAuthError, __test__ } from './claude-oauth.js';

const FUTURE = Date.now() + 60 * 60_000;

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
