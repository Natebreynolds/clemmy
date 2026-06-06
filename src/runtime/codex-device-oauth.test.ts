/**
 * Run: npx tsx --test src/runtime/codex-device-oauth.test.ts
 *
 * Device-code (remote / headless) Codex login. We stand up a fake OpenAI auth
 * server on localhost and point CODEX_OAUTH_AUTH_BASE_URL at it (the same seam
 * the smoke scripts use), then drive the full begin → poll(pending) →
 * poll(complete) flow and assert the tokens land in Clementine's OWN vault with
 * the DEAD latch cleared. No real network, fully deterministic.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { AddressInfo } from 'node:net';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-device-oauth-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;
process.env.AUTH_MODE = 'codex_oauth';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// A throwaway JWT (header.payload.sig) so extractAccountId has something to parse.
function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

// ── Fake auth server state ───────────────────────────────────────
let pollCount = 0;
let usercodeRequests = 0;
let server: http.Server;
let baseUrl = '';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    await readBody(req);
    const json = (status: number, obj: unknown): void => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(obj));
    };
    if (url === '/api/accounts/deviceauth/usercode') {
      usercodeRequests += 1;
      json(200, { user_code: 'WXYZ-1234', device_auth_id: 'dev-abc-123', interval: 3 });
      return;
    }
    if (url === '/api/accounts/deviceauth/token') {
      pollCount += 1;
      // First poll: not authorized yet (404 = pending). Second: authorized.
      if (pollCount < 2) { res.statusCode = 404; res.end('not yet'); return; }
      json(200, { authorization_code: 'auth-code-xyz', code_verifier: 'verifier-xyz' });
      return;
    }
    if (url === '/oauth/token') {
      json(200, {
        access_token: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-from-jwt' }, exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'RT-device-1',
        id_token: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-from-jwt' } }),
      });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  process.env.CODEX_OAUTH_AUTH_BASE_URL = baseUrl;
});

after(() => {
  server?.close();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('device-code login: begin → poll(pending) → poll(complete) persists tokens to the vault', async () => {
  const { beginCodexDeviceLogin, pollCodexDeviceLogin, isCodexAuthDead, markCodexAuthDead } = await import('./auth-store.js');

  // Pretend auth was DEAD before the re-auth — a successful login must clear it.
  markCodexAuthDead('was revoked');
  assert.equal(isCodexAuthDead(), true);

  const start = await beginCodexDeviceLogin();
  assert.equal(start.userCode, 'WXYZ-1234', 'user_code surfaced for display');
  assert.equal(start.verificationUri, `${baseUrl}/codex/device`, 'verification URL points at the device page');
  assert.ok(start.loginId, 'a loginId is returned to poll with');
  assert.equal(usercodeRequests, 1);

  const first = await pollCodexDeviceLogin(start.loginId);
  assert.equal(first.status, 'pending', 'first poll is pending (user has not authorized yet)');

  const second = await pollCodexDeviceLogin(start.loginId);
  assert.equal(second.status, 'complete', 'second poll completes');
  assert.equal(second.status === 'complete' ? second.accountId : '', 'acct-from-jwt', 'account id pulled from the JWT');

  // Tokens landed in the OWN vault; DEAD latch cleared by the successful write.
  const vault = JSON.parse(readFileSync(path.join(TMP_HOME, 'state', 'auth.json'), 'utf-8'));
  assert.equal(vault.source, 'native', 'device login writes a native (independent) grant');
  assert.equal(vault.codexOauth.refreshToken, 'RT-device-1', 'refresh token persisted');
  assert.equal(isCodexAuthDead(), false, 'a successful device login lifts the DEAD latch');
});

test('device-code login: polling an unknown/expired loginId reports expired (no crash)', async () => {
  const { pollCodexDeviceLogin } = await import('./auth-store.js');
  const res = await pollCodexDeviceLogin('does-not-exist');
  assert.equal(res.status, 'expired');
});

test('device-code login: a consumed loginId cannot be polled again', async () => {
  const { beginCodexDeviceLogin, pollCodexDeviceLogin } = await import('./auth-store.js');
  pollCount = 1; // next poll completes immediately
  const start = await beginCodexDeviceLogin();
  const done = await pollCodexDeviceLogin(start.loginId);
  assert.equal(done.status, 'complete');
  const again = await pollCodexDeviceLogin(start.loginId);
  assert.equal(again.status, 'expired', 'the pending entry is one-time-consumed on completion');
  assert.ok(existsSync(path.join(TMP_HOME, 'state', 'auth.json')));
});
