import assert from 'node:assert/strict';
import test from 'node:test';

import { accessOnlyClaudeAuthPayload } from '../lib/isolated-claude-auth.js';

test('isolated Claude credential keeps a valid subscription access token but never a rotating refresh token', () => {
  const now = Date.UTC(2026, 6, 25, 20, 0, 0);
  const payload = accessOnlyClaudeAuthPayload(JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-live-access',
      refreshToken: 'must-never-enter-a-disposable-home',
      expiresAt: now + 60 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
  }), now);

  assert.deepEqual(payload, {
    accessToken: 'sk-ant-oat01-live-access',
    expiresAt: now + 60 * 60_000,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  });
  assert.equal('refreshToken' in (payload ?? {}), false);
});

test('isolated Claude credential rejects API keys and access tokens too near expiry', () => {
  const now = Date.UTC(2026, 6, 25, 20, 0, 0);
  assert.equal(accessOnlyClaudeAuthPayload(JSON.stringify({
    accessToken: 'sk-ant-api03-pay-per-token',
    expiresAt: now + 60 * 60_000,
  }), now), null);
  assert.equal(accessOnlyClaudeAuthPayload(JSON.stringify({
    accessToken: 'sk-ant-oat01-expiring',
    refreshToken: 'present-but-forbidden',
    expiresAt: now + 60_000,
  }), now), null);
});
