import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginClaudeLogin, parseTokenResponse, __test__ } from './claude-native-oauth.js';

test('beginClaudeLogin: builds a correct claude.ai PKCE authorize URL', () => {
  const { authorizeUrl, verifier, state } = beginClaudeLogin();
  const u = new URL(authorizeUrl);
  assert.equal(u.origin + u.pathname, 'https://claude.ai/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), __test__.CLIENT_ID);
  assert.equal(u.searchParams.get('redirect_uri'), __test__.REDIRECT_URI);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok((u.searchParams.get('code_challenge') || '').length > 20, 'has an S256 challenge');
  assert.equal(u.searchParams.get('state'), state);
  assert.match(u.searchParams.get('scope') || '', /user:inference/);
  assert.ok(verifier.length > 20);
});

test('beginClaudeLogin: fresh verifier/state each call (no reuse)', () => {
  const a = beginClaudeLogin();
  const b = beginClaudeLogin();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
});

test('parseTokenResponse: maps the Anthropic token shape', () => {
  const t = parseTokenResponse({ access_token: 'sk-ant-oat01-x', refresh_token: 'rt', expires_in: 28800, scope: 'user:inference user:profile' });
  assert.equal(t.accessToken, 'sk-ant-oat01-x');
  assert.equal(t.refreshToken, 'rt');
  assert.ok(t.expiresAt && t.expiresAt > Date.now(), 'expiresAt computed from expires_in');
  assert.deepEqual(t.scopes, ['user:inference', 'user:profile']);
});

test('parseTokenResponse: throws when no access_token', () => {
  assert.throws(() => parseTokenResponse({ refresh_token: 'rt' }));
});
