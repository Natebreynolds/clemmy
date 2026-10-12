import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-mobile-live-voice-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.MARKITDOWN_WARM = 'off';
const { createMobileRouter } = await import('./mobile-routes.js');
const { createMobilePairingCode } = await import('../runtime/mobile-pairing.js');
const { classifyRoute } = await import('./auth-policy.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
const { closeMemoryDb } = await import('../memory/db.js');
test.after(() => { closeEventLog(); closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });

const offer = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n';

test('phone live voice needs the paired device proof and returns only the session answer', async () => {
  const offers: unknown[] = [];
  const stateDir = path.join(home, 'phone');
  const app = express();
  app.use(express.json());
  app.use('/m', createMobileRouter({ stateDir, cookieSecure: false, pwaDistDir: null, isAdminAuthorized: () => false,
    liveVoiceRuntime: {
      status: () => ({ available: true }),
      createSession: async (input) => { offers.push(input); return { ok: true, sessionId: 'live_phone', sdp: 'answer-sdp' }; },
    } }));
  const server = await new Promise<Server>(resolve => { const listener = createServer(app); listener.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicJwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
    const { token: pairToken } = await createMobilePairingCode({}, { stateDir });
    const paired = await fetch(`${base}/m/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken, devicePublicKeyJwk: publicJwk, deviceLabel: 'Synthetic live voice' }) });
    assert.equal(paired.status, 200);
    const { sessionFingerprint } = await paired.json() as { sessionFingerprint: string };
    const cookie = paired.headers.get('set-cookie')!.split(';')[0];
    const call = async (method: 'GET' | 'POST', route: string, auth: 'proof' | 'cookie' | 'none', body?: unknown) => {
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'clem-dpop+jws' })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ htm: method, htu: route, iat: Math.floor(Date.now() / 1000),
        jti: webcrypto.randomUUID(), sfp: sessionFingerprint })).toString('base64url');
      const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(`${header}.${claims}`));
      return fetch(`${base}${route}`, { method, ...(body ? { body: JSON.stringify(body) } : {}),
        headers: { 'content-type': 'application/json', ...(auth !== 'none' ? { cookie } : {}),
          ...(auth === 'proof' ? { 'x-clem-device-proof': `${header}.${claims}.${Buffer.from(signature).toString('base64url')}` } : {}) } });
    };
    assert.equal((await call('GET', '/m/api/voice/live', 'none')).status, 401);
    const status = await call('GET', '/m/api/voice/live', 'proof');
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { available: true });
    const session = { sdp: offer, history: [{ role: 'assistant', text: 'Want me to send it?' }] };
    assert.equal((await call('POST', '/m/api/voice/live-session', 'none', session)).status, 401);
    assert.equal((await call('POST', '/m/api/voice/live-session', 'cookie', session)).status, 401);
    assert.equal(offers.length, 0);
    const started = await call('POST', '/m/api/voice/live-session', 'proof', session);
    assert.equal(started.status, 201);
    assert.equal(started.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await started.json(), { sessionId: 'live_phone', sdp: 'answer-sdp' });
    assert.deepEqual(offers, [session]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('the global gate lets a paired phone reach live voice', () => {
  for (const [method, route] of [['GET', '/m/api/voice/live'], ['POST', '/m/api/voice/live-session']] as const) {
    assert.equal(classifyRoute(method, route)?.realm, 'mobile-session', route);
  }
});
