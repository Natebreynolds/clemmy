/**
 * Run: npx tsx --test src/runtime/xai-native-oauth.test.ts
 *
 * The xAI device-code lane. Two properties carry real risk and are pinned in
 * both directions:
 *
 *   RFC 8628 delivers its IN-PROGRESS states as HTTP 400 with a typed error
 *   body. Treating a non-2xx as failure is the classic way to break this flow —
 *   the user would see "sign-in failed" the instant they were asked to approve.
 *   So `authorization_pending` / `slow_down` must NOT throw, while a genuinely
 *   unrecognized error must.
 *
 *   A refresh response may legitimately omit `refresh_token` when the server is
 *   not rotating it. Dropping it there would downgrade a long-lived grant to a
 *   single-use token and sign the user out on the following refresh.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  startXaiDeviceAuth,
  pollXaiDeviceAuth,
  refreshNativeXaiTokens,
  XAI_OAUTH_ENDPOINTS,
} = await import('./xai-native-oauth.js');

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string, body: URLSearchParams) => { status: number; json: unknown }): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = new URLSearchParams(String(init?.body ?? ''));
    const { status, json } = handler(url, body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(json),
    } as Response;
  }) as typeof globalThis.fetch;
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test('the lane targets the endpoints the discovery document advertises', () => {
  assert.equal(XAI_OAUTH_ENDPOINTS.issuer, 'https://auth.x.ai');
  assert.equal(XAI_OAUTH_ENDPOINTS.deviceCodeUrl, 'https://auth.x.ai/oauth2/device/code');
  assert.equal(XAI_OAUTH_ENDPOINTS.tokenUrl, 'https://auth.x.ai/oauth2/token');
  // api:access is what grants model inference; offline_access is what returns a
  // refresh token. Losing either silently degrades the connection.
  assert.match(XAI_OAUTH_ENDPOINTS.scope, /\bapi:access\b/);
  assert.match(XAI_OAUTH_ENDPOINTS.scope, /\boffline_access\b/);
});

test('device start returns the code, the prefilled URL, and never polls faster than asked', async () => {
  stubFetch(() => ({
    status: 200,
    json: {
      device_code: 'dc-1',
      user_code: 'ABCD-1234',
      verification_uri: 'https://accounts.x.ai/oauth2/device',
      verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-1234',
      expires_in: 1800,
      interval: 5,
    },
  }));
  const start = await startXaiDeviceAuth();
  assert.equal(start.userCode, 'ABCD-1234');
  assert.equal(start.deviceCode, 'dc-1');
  assert.equal(start.verificationUriComplete, 'https://accounts.x.ai/oauth2/device?user_code=ABCD-1234');
  assert.equal(start.intervalSeconds, 5);
  assert.ok(Date.parse(start.expiresAt) > Date.now(), 'the pending grant carries its own deadline');
});

test('an in-progress 400 is NOT a failure', async () => {
  for (const [error, expected] of [
    ['authorization_pending', 'pending'],
    ['access_denied', 'denied'],
    ['expired_token', 'expired'],
  ] as const) {
    stubFetch(() => ({ status: 400, json: { error } }));
    const poll = await pollXaiDeviceAuth('dc-1');
    assert.equal(poll.status, expected, `${error} must resolve, not throw`);
  }
});

test('slow_down widens the interval instead of failing', async () => {
  stubFetch(() => ({ status: 400, json: { error: 'slow_down', interval: 12 } }));
  const poll = await pollXaiDeviceAuth('dc-1');
  assert.equal(poll.status, 'slow_down');
  if (poll.status === 'slow_down') assert.equal(poll.intervalSeconds, 12);
});

test('an UNRECOGNIZED error still throws — the tolerance is not blanket', async () => {
  stubFetch(() => ({ status: 400, json: { error: 'invalid_client' } }));
  await assert.rejects(() => pollXaiDeviceAuth('dc-1'), /invalid_client/);
});

test('a completed poll yields a usable token set with an absolute expiry', async () => {
  stubFetch(() => ({
    status: 200,
    json: { access_token: 'at-1', refresh_token: 'rt-1', id_token: 'it-1', expires_in: 3600 },
  }));
  const poll = await pollXaiDeviceAuth('dc-1');
  assert.equal(poll.status, 'complete');
  if (poll.status !== 'complete') return;
  assert.equal(poll.tokens.accessToken, 'at-1');
  assert.equal(poll.tokens.refreshToken, 'rt-1');
  assert.ok(Date.parse(poll.tokens.expiresAt ?? '') > Date.now());
});

test('a refresh that omits refresh_token carries the prior one forward', async () => {
  stubFetch(() => ({ status: 200, json: { access_token: 'at-2', expires_in: 3600 } }));
  const refreshed = await refreshNativeXaiTokens('rt-original');
  assert.equal(refreshed.accessToken, 'at-2');
  assert.equal(
    refreshed.refreshToken,
    'rt-original',
    'a non-rotating server must not silently downgrade the grant to single-use',
  );
});

test('a rotating refresh replaces the token', async () => {
  stubFetch(() => ({ status: 200, json: { access_token: 'at-3', refresh_token: 'rt-rotated', expires_in: 3600 } }));
  const refreshed = await refreshNativeXaiTokens('rt-original');
  assert.equal(refreshed.refreshToken, 'rt-rotated');
});
