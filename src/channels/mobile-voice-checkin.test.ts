import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-mobile-voice-checkin-'));
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

test('quick check-in is proof-bound, noncached, and never invokes the reader before authentication', async () => {
  let reads = 0;
  const snapshot = { status: 'partial', generatedAt: '2026-10-29T19:00:00.000Z', spokenText: 'One controlled approval is waiting.' };
  const stateDir = path.join(home, 'phone');
  const app = express();
  app.use(express.json());
  app.use('/m', createMobileRouter({ stateDir, cookieSecure: false, pwaDistDir: null, isAdminAuthorized: () => false,
    voiceCheckInRuntime: { read: async () => { reads += 1; return snapshot as never; } } }));
  const server = await new Promise<Server>(resolve => { const listener = createServer(app); listener.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const route = '/m/api/voice/check-in';
  try {
    assert.equal((await fetch(`${base}${route}`)).status, 401);
    assert.equal(reads, 0);
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicJwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
    const { token: pairToken } = await createMobilePairingCode({}, { stateDir });
    const paired = await fetch(`${base}/m/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken, devicePublicKeyJwk: publicJwk, deviceLabel: 'Controlled check-in fixture' }) });
    assert.equal(paired.status, 200);
    const { sessionFingerprint } = await paired.json() as { sessionFingerprint: string };
    const cookie = paired.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(`${base}${route}`, { headers: { cookie } })).status, 401);
    assert.equal(reads, 0);
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'clem-dpop+jws' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ htm: 'GET', htu: route, iat: Math.floor(Date.now() / 1000),
      jti: webcrypto.randomUUID(), sfp: sessionFingerprint })).toString('base64url');
    const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(`${header}.${claims}`));
    const result = await fetch(`${base}${route}`, { headers: { cookie,
      'x-clem-device-proof': `${header}.${claims}.${Buffer.from(signature).toString('base64url')}` } });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await result.json(), snapshot);
    assert.equal(reads, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('the global route policy keeps quick check-in behind mobile session authority', () => {
  assert.equal(classifyRoute('GET', '/m/api/voice/check-in')?.realm, 'mobile-session');
});
