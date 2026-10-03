import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeMobileRelay } from './mobile-relay-health.js';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-relay-health-'));
process.env.CLEMENTINE_HOME = temporary;
const { ensureMobileTlsIdentity } = await import('./mobile-tls.js');
const identity = ensureMobileTlsIdentity({ stateDir: temporary });
test.after(() => rmSync(temporary, { recursive: true, force: true }));

test('health verification pins the Mac before HTTP, sends no credentials and follows no redirects', async () => {
  let requests = 0;
  let mode: 'ok' | 'redirect' | 'oversized' | 'wrong' = 'ok';
  const server = https.createServer({ key: identity.keyPem, cert: identity.certPem }, (req, res) => {
    requests++;
    assert.equal(req.url, '/m/health');
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    if (mode === 'redirect') { res.writeHead(302, { Location: 'https://example.com/' }); res.end(); }
    else if (mode === 'oversized') res.end('x'.repeat(3000));
    else res.end(JSON.stringify({ ok: mode === 'ok' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  try {
    assert.equal((await probeMobileRelay(origin, identity.fingerprint)).state, 'verified');
    const before = requests;
    assert.equal((await probeMobileRelay(origin, 'incorrect-pin')).reason, 'certificate-mismatch');
    assert.equal(requests, before, 'wrong pin must send zero HTTP requests');
    for (const next of ['redirect', 'oversized', 'wrong'] as const) {
      mode = next;
      assert.equal((await probeMobileRelay(origin, identity.fingerprint)).reason, 'invalid-response');
    }
    assert.equal(requests, before + 3, 'no redirect request may escape');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('a silent TLS endpoint is bounded rather than a permanent connecting state', async () => {
  const peers = new Set<net.Socket>();
  const server = net.createServer((socket) => { peers.add(socket); socket.on('close', () => peers.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await probeMobileRelay(`https://127.0.0.1:${(server.address() as net.AddressInfo).port}`, identity.fingerprint, 75);
    assert.equal(result.reason, 'timeout');
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
