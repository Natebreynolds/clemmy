import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-mobile-voice-speech-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.MARKITDOWN_WARM = 'off';
const { createMobileRouter } = await import('./mobile-routes.js');
const { createMobilePairingCode } = await import('../runtime/mobile-pairing.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
const { closeMemoryDb } = await import('../memory/db.js');
type Speech = NonNullable<Parameters<typeof createMobileRouter>[0]['voiceSpeechRuntime']>['requestSpeech'];
test.after(() => { closeEventLog(); closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });
let sequence = 0;

async function fixture(speech: Speech, run: (post: (text: string, auth?: 'proof' | 'cookie' | 'none', signal?: AbortSignal) => Promise<Response>) => Promise<void>) {
  const stateDir = path.join(home, `phone-${++sequence}`);
  const app = express();
  app.use(express.json());
  app.use('/m', createMobileRouter({ stateDir, cookieSecure: false, pwaDistDir: null,
    isAdminAuthorized: () => false, voiceSpeechRuntime: { requestSpeech: speech } }));
  const server = await new Promise<Server>(resolve => {
    const listener = createServer(app); listener.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicJwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
    const { token: pairToken } = await createMobilePairingCode({}, { stateDir });
    const paired = await fetch(`${base}/m/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken, devicePublicKeyJwk: publicJwk, deviceLabel: 'Synthetic voice acceptance' }) });
    assert.equal(paired.status, 200);
    const { sessionFingerprint } = await paired.json() as { sessionFingerprint: string };
    const cookie = paired.headers.get('set-cookie')!.split(';')[0];
    const route = '/m/api/chat/speak';
    await run(async (text, auth = 'proof', signal) => {
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'clem-dpop+jws' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ htm: 'POST', htu: route, iat: Math.floor(Date.now() / 1000),
        jti: webcrypto.randomUUID(), sfp: sessionFingerprint })).toString('base64url');
      const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(`${header}.${body}`));
      const proof = `${header}.${body}.${Buffer.from(signature).toString('base64url')}`;
      return fetch(`${base}${route}`, { method: 'POST', signal, body: JSON.stringify({ text }),
        headers: { 'content-type': 'application/json', ...(auth !== 'none' ? { cookie } : {}),
          ...(auth === 'proof' ? { 'x-clem-device-proof': proof } : {}) } });
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('mobile speech requires the paired device proof and speaks only bounded readable text', async () => {
  const requests: string[] = [];
  await fixture(async text => {
    requests.push(text);
    return { ok: true, contentType: 'audio/mpeg', response: new Response('synthetic-audio-bytes') };
  }, async post => {
    assert.equal((await post('Private reply', 'none')).status, 401);
    assert.equal((await post('Private reply', 'cookie')).status, 401);
    assert.equal((await post('```js\nsecretCode()\n```')).status, 400);
    assert.equal(requests.length, 0);
    const response = await post('**Here is the answer.**\n\n```js\nsecretCode()\n```\n\n' + 'Another sentence. '.repeat(100));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), 'synthetic-audio-bytes');
    assert.equal(requests.length, 1);
    assert.ok(requests[0].length <= 900);
    assert.match(requests[0], /^Here is the answer\./);
    assert.doesNotMatch(requests[0], /secretCode|```|\*\*/);
  });
});

test('mobile speech preserves an explicit system fallback and reports service failures', async () => {
  let call = 0;
  await fixture(async () => {
    if (++call === 1) return { ok: false, status: 409, error: 'Use device speech.', fallback: 'system' };
    if (call === 2) return { ok: false, status: 502, error: 'Speech unavailable.' };
    throw new Error('private synthetic diagnostic');
  }, async post => {
    const fallback = await post('**Hello.**');
    assert.equal(fallback.status, 409);
    assert.deepEqual(await fallback.json(), { error: 'Use device speech.', fallback: 'system', text: 'Hello.' });
    const failed = await post('Hello.');
    assert.equal(failed.status, 502);
    assert.equal((await failed.json() as { fallback?: string }).fallback, undefined);
    const thrown = await post('Hello.');
    assert.equal(thrown.status, 502);
    assert.doesNotMatch(await thrown.text(), /private synthetic/);
  });
});

test('ending mobile voice aborts its speech request', async () => {
  let ready!: () => void;
  let stopped!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const aborted = new Promise<void>(resolve => { stopped = resolve; });
  await fixture(async (_text, signal) => {
    ready();
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => { stopped(); resolve(); }, { once: true }));
    return { ok: false, status: 499, error: 'Stopped.' };
  }, async post => {
    const controller = new AbortController();
    const response = post('Hello.', 'proof', controller.signal);
    await started;
    controller.abort();
    await assert.rejects(response, { name: 'AbortError' });
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('speech did not abort')), 2000).unref())]);
  });
});
