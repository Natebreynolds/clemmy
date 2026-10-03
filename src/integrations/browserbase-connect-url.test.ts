/**
 * Run: node scripts/run-tests-isolated.mjs src/integrations/browserbase-connect-url.test.ts
 *
 * Browserbase hands out regional connect URLs bound by a session signing key
 * (wss://connect.usw2.browserbase.com/?signingKey=…). A created session whose
 * URL Clem refused was lost: running and billed, with no record of its id.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { browserbaseConnectUrlFor } from './browserbase-connect-url.js';
import { BrowserbaseApiClient } from './browserbase-client.js';

const sid = 'f770961d-b2ed-4056-916f-9ce6780f9fd2';
const project = 'cfbbac7a-a020-48bd-967a-b2a2796bb2f0';

test('regional signing-key URLs and the original sessionId form are this session', () => {
  assert.ok(browserbaseConnectUrlFor('wss://connect.usw2.browserbase.com/?signingKey=fixture-signing', sid));
  assert.ok(browserbaseConnectUrlFor('wss://connect.euc1.browserbase.com/?signingKey=fixture-signing', sid));
  assert.ok(browserbaseConnectUrlFor(`wss://connect.browserbase.com/?apiKey=fixture&sessionId=${sid}`, sid));
});

test('another host, a path, credentials, or a different or missing identity is refused', () => {
  for (const url of [
    'wss://connect.evil.example/?signingKey=x',
    'wss://connect.browserbase.com.evil.example/?signingKey=x',
    'wss://evil.connect.usw2.browserbase.com/?signingKey=x',
    'ws://connect.usw2.browserbase.com/?signingKey=x',
    'wss://connect.usw2.browserbase.com/debug?signingKey=x',
    'wss://user:pass@connect.usw2.browserbase.com/?signingKey=x',
    'wss://connect.usw2.browserbase.com/?signingKey=',
    'wss://connect.usw2.browserbase.com/',
    'wss://connect.usw2.browserbase.com/?signingKey=a&signingKey=b',
    'wss://connect.browserbase.com/?sessionId=another-session',
    `wss://connect.browserbase.com:8443/?sessionId=${sid}`,
  ]) assert.equal(browserbaseConnectUrlFor(url, sid), null, url);
});

test('a create answered with a regional signing-key URL is a started session, not an invalid response', async () => {
  const api = new BrowserbaseApiClient({ getApiKey: async () => 'fixture-key', fetch: async () => new Response(JSON.stringify({
    id: sid, projectId: project, status: 'RUNNING', keepAlive: true, region: 'us-west-2',
    createdAt: '2026-10-03T16:05:34.513867+00:00', expiresAt: '2026-10-03T16:35:34.505+00:00',
    connectUrl: 'wss://connect.usw2.browserbase.com/?signingKey=fixture-signing', signingKey: 'fixture-signing',
  }), { status: 201, headers: { 'Content-Type': 'application/json' } }) });
  const created = await api.create({ projectId: project, timeoutSeconds: 1800 });
  assert.equal(created.sessionId, sid);
  assert.equal(created.status, 'RUNNING');
  assert.match(created.connectUrl, /^wss:\/\/connect\.usw2\.browserbase\.com\//);
});
