/** Real loopback lifecycle controls; no real Clem home, account, or deployment. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { FRAME, encodeFrame, frameReader, startRelay } from './server.mjs';

const BASE = 'r.test.local';
const TEMP = mkdtempSync(path.join(os.tmpdir(), 'clem-relay-operations-'));
const quiet = { info() {}, warn() {}, error() {} };
const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));
let identity;
test.before(() => {
  const key = path.join(TEMP, 'key.pem');
  const cert = path.join(TEMP, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=relay-operations-test'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  const keyPem = readFileSync(key, 'utf8');
  const certPem = readFileSync(cert, 'utf8');
  const der = Buffer.from(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(certPem)[1].replace(/\s+/g, ''), 'base64');
  identity = { key, cert, keyPem, certPem, pairId: createHash('sha256').update(der).digest('hex').slice(0, 16) };
});
test.after(() => rmSync(TEMP, { recursive: true, force: true }));

function bounded(promise, label, ms = 2_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
  })]).finally(() => clearTimeout(timer));
}
async function waitFor(predicate, label, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function closed(socket) {
  return socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve));
}
async function rawConnection(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  await bounded(new Promise((resolve, reject) => {
    socket.once('connect', resolve); socket.once('error', reject);
  }), 'loopback connection');
  return socket;
}
async function fixture(t, options = {}) {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', baseDomain: BASE,
    tlsKeyPem: identity.keyPem, tlsCertPem: identity.certPem, log: quiet, ...options });
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await bounded(relay.close(), 'owned relay cleanup');
  });
  return { relay, track(socket) { sockets.add(socket); return socket; } };
}
async function request(port, target, method = 'GET') {
  return bounded(new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('end', () => resolve({ code: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.setTimeout(1_000, () => req.destroy(new Error('Health request timed out')));
    req.end();
  }), 'loopback health response');
}
function clientHello(hostname) {
  const name = Buffer.from(hostname);
  const extension = Buffer.alloc(9 + name.length);
  extension.writeUInt16BE(0, 0); extension.writeUInt16BE(5 + name.length, 2);
  extension.writeUInt16BE(3 + name.length, 4); extension.writeUInt8(0, 6);
  extension.writeUInt16BE(name.length, 7); name.copy(extension, 9);
  const extensionsLength = Buffer.alloc(2); extensionsLength.writeUInt16BE(extension.length);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0, 0, 2, 0x13, 1, 1, 0]), extensionsLength, extension]);
  const handshake = Buffer.alloc(4); handshake.writeUInt8(1); handshake.writeUIntBE(body.length, 1, 3);
  const record = Buffer.alloc(5); record.writeUInt8(0x16); record.writeUInt16BE(0x0303, 1); record.writeUInt16BE(handshake.length + body.length, 3);
  return Buffer.concat([record, handshake, body]);
}
async function liveStream(f) {
  const daemon = f.track(tls.connect({ host: '127.0.0.1', port: f.relay.port, servername: `tunnel.${BASE}`, rejectUnauthorized: false }));
  daemon.on('error', () => {});
  const feed = frameReader();
  let accept, rejectRegistration;
  const accepted = new Promise((resolve, reject) => { accept = resolve; rejectRegistration = reject; });
  daemon.once('error', rejectRegistration);
  daemon.once('close', () => rejectRegistration(new Error('Controlled daemon closed before registration')));
  daemon.once('secureConnect', () => daemon.write(encodeFrame(FRAME.HELLO, 0,
    JSON.stringify({ pairId: identity.pairId, authToken: 'synthetic-operations-token', proto: 1 }))));
  daemon.on('data', chunk => {
    for (const frame of feed(chunk)) {
      if (frame.type === FRAME.CHALLENGE) {
        const { nonce } = JSON.parse(frame.payload.toString('utf8'));
        const signature = createSign('sha256').update(nonce).sign(identity.keyPem).toString('base64url');
        daemon.write(encodeFrame(FRAME.PROOF, 0, JSON.stringify({ certPem: identity.certPem, signature })));
      } else if (frame.type === FRAME.HELLO_OK) accept();
      else if (frame.type === FRAME.OPEN) daemon.write(encodeFrame(FRAME.DATA, frame.streamId, Buffer.from('x')));
      else if (frame.type === FRAME.PING) daemon.write(encodeFrame(FRAME.PONG, 0));
    }
  });
  await bounded(accepted, 'controlled possession proof');
  const phone = f.track(await rawConnection(f.relay.port));
  const answered = new Promise(resolve => phone.once('data', resolve));
  phone.write(clientHello(`${identity.pairId}.${BASE}`));
  assert.equal((await bounded(answered, 'controlled stream first byte')).toString(), 'x');
  await waitFor(() => f.relay.status().streams === 1, 'one active stream');
  return { phone, daemon };
}
async function listen(server, port = 0) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server.address().port;
}
async function closeServer(server) {
  if (server.listening) await bounded(new Promise(resolve => server.close(resolve)), 'owned listener cleanup');
}
async function freePort() {
  const server = net.createServer();
  const port = await listen(server); await closeServer(server); return port;
}
async function assertBindable(port) {
  const probe = net.createServer();
  try { assert.equal(await listen(probe, port), port); } finally { await closeServer(probe); }
}

test('health endpoints are optional, generic, read-only, and separate from encrypted TCP', { timeout: 8_000 }, async t => {
  const { relay } = await fixture(t, { healthPort: 0, healthHost: '127.0.0.1' });
  assert.notEqual(relay.port, relay.healthPort);
  assert.deepEqual(relay.status(), { ready: true, draining: false, connections: 0, pendingRegistrations: 0,
    tunnels: 0, streams: 0, queuedBytes: 0, queuedWrites: 0 });
  for (const [route, expected] of [['/healthz', { ok: true }], ['/readyz', { ready: true }]]) {
    const response = await request(relay.healthPort, route);
    assert.equal(response.code, 200); assert.deepEqual(JSON.parse(response.text), expected);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.headers['content-type'], /^application\/json/);
    const head = await request(relay.healthPort, route, 'HEAD');
    assert.equal(head.code, 200); assert.equal(head.text, '');
  }
  for (const route of ['/', '/healthz?detail=1', '/readyz/']) {
    const response = await request(relay.healthPort, route);
    assert.equal(response.code, 404); assert.deepEqual(JSON.parse(response.text), { ok: false });
  }
  const unsupported = await request(relay.healthPort, '/readyz', 'POST');
  assert.equal(unsupported.code, 405); assert.equal(unsupported.headers.allow, 'GET, HEAD');
  assert.deepEqual(JSON.parse(unsupported.text), { ok: false });
  assert.equal(relay.status().connections, 0, 'operational requests do not create relay routing state');
  const noHealth = await fixture(t);
  assert.equal(noHealth.relay.healthPort, undefined);
});

test('shutdown owns idle TCP, partial ClientHello, and unregistered TLS sockets', { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const idle = f.track(await rawConnection(f.relay.port));
  const partial = f.track(await rawConnection(f.relay.port)); partial.write(Buffer.from([0x16]));
  const unregistered = f.track(tls.connect({ host: '127.0.0.1', port: f.relay.port,
    servername: `tunnel.${BASE}`, rejectUnauthorized: false }));
  unregistered.on('error', () => {});
  await bounded(new Promise((resolve, reject) => {
    unregistered.once('secureConnect', resolve); unregistered.once('error', reject);
  }), 'unregistered TLS handshake');
  await waitFor(() => f.relay.status().connections === 3 && f.relay.status().pendingRegistrations === 1, 'all pre-registration owners');
  const closes = [idle, partial, unregistered].map(closed);
  const shutdown = f.relay.close({ graceMs: 1_000 });
  assert.strictEqual(f.relay.close(), shutdown, 'idempotence preserves the original bounded shutdown');
  await bounded(Promise.all([shutdown, ...closes]), 'pre-registration sockets close without waiting for SNI/HELLO/grace timers', 700);
  await waitFor(() => f.relay.status().connections === 0 && f.relay.status().pendingRegistrations === 0, 'all pre-registration counts released');
});

test('drain immediately withdraws readiness, preserves an active stream, and finishes on release', { timeout: 8_000 }, async t => {
  const f = await fixture(t, { healthPort: 0, healthHost: '127.0.0.1' });
  const { phone, daemon } = await liveStream(f);
  const shutdown = f.relay.close({ graceMs: 1_500 });
  assert.equal(f.relay.status().ready, false); assert.equal(f.relay.status().draining, true);
  assert.strictEqual(f.relay.close({ graceMs: 0 }), shutdown);
  const readiness = await request(f.relay.healthPort, '/readyz');
  assert.equal(readiness.code, 503); assert.deepEqual(JSON.parse(readiness.text), { ready: false });
  const health = await request(f.relay.healthPort, '/healthz');
  assert.equal(health.code, 200); assert.deepEqual(JSON.parse(health.text), { ok: true });
  assert.equal(phone.destroyed, false); assert.equal(daemon.destroyed, false);
  const phoneClosed = closed(phone), daemonClosed = closed(daemon);
  phone.destroy();
  await bounded(Promise.all([shutdown, phoneClosed, daemonClosed]), 'released stream finishes well before drain deadline', 700);
  assert.equal(f.relay.status().ready, false);
  await assert.rejects(request(f.relay.healthPort, '/healthz'));
});

test('an unreleased active encrypted stream cannot outlive the selected grace bound', { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const { phone, daemon } = await liveStream(f);
  const closes = [phone, daemon].map(closed);
  const started = performance.now();
  await bounded(Promise.all([f.relay.close({ graceMs: 120 }), ...closes]), 'forced bounded stream drain', 1_500);
  assert.ok(performance.now() - started >= 80, 'active user stream was not closed immediately');
  await waitFor(() => f.relay.status().connections === 0 && f.relay.status().tunnels === 0, 'active routing state released');
});

test('invalid startup ports, domain, TLS material, and limits allocate no listener', { timeout: 8_000 }, async () => {
  const port = await freePort();
  const base = { port, host: '127.0.0.1', baseDomain: BASE, tlsKeyPem: identity.keyPem, tlsCertPem: identity.certPem, log: quiet };
  for (const bad of [{ port: -1 }, { port: 65536 }, { port: 1.5 }, { port: '9400' },
    { healthPort: -1 }, { healthPort: port }, { baseDomain: 'not a domain' }, { baseDomain: 'a..test' },
    { limits: { maxConnections: 0 } }, { limits: { maxConnections: NaN } }, { limits: { maxQueuedBytesTotal: Number.MAX_SAFE_INTEGER } },
    { tlsKeyPem: 'synthetic-invalid-key' }]) {
    await assert.rejects(startRelay({ ...base, ...bad }));
    await assertBindable(port);
  }
});

test('a failed health bind rolls back the already-open encrypted listener', { timeout: 8_000 }, async t => {
  const occupied = net.createServer(); const healthPort = await listen(occupied);
  t.after(() => closeServer(occupied));
  const relayPort = await freePort();
  await assert.rejects(startRelay({ port: relayPort, host: '127.0.0.1', healthPort, healthHost: '127.0.0.1',
    baseDomain: BASE, tlsKeyPem: identity.keyPem, tlsCertPem: identity.certPem, log: quiet }), { code: 'EADDRINUSE' });
  await assertBindable(relayPort);
  assert.equal(occupied.listening, true, 'rollback never closes another listener');
});

function cli(env) {
  const home = mkdtempSync(path.join(TEMP, 'child-home-'));
  const child = spawn(process.execPath, [serverPath], { cwd: TEMP,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLEMENTINE_HOME: home,
      RELAY_BASE_DOMAIN: BASE, RELAY_TLS_KEY_FILE: identity.key, RELAY_TLS_CERT_FILE: identity.cert,
      RELAY_DRAIN_TIMEOUT_MS: '150', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let settleReady, rejectReady;
  const ready = new Promise((resolve, reject) => { settleReady = resolve; rejectReady = reject; });
  child.stdout.on('data', chunk => {
    output = (output + chunk.toString()).slice(-8_192);
    const found = /relay: listening on :(\d+) for/.exec(output);
    if (found) settleReady(Number(found[1]));
  });
  child.stderr.on('data', () => {});
  child.once('error', rejectReady);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    rejectReady(new Error('Controlled CLI exited before ready')); resolve({ code, signal });
  }));
  // Invalid-start cases intentionally never await readiness.
  ready.catch(() => {});
  return { child, ready, exited };
}
async function cleanupChild(handle) {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  handle.child.kill('SIGTERM');
  try { await bounded(handle.exited, 'controlled CLI cleanup', 1_000); }
  catch {
    handle.child.kill('SIGKILL');
    await bounded(handle.exited, 'failed controlled CLI termination');
    throw new Error('Controlled relay required forced cleanup; natural shutdown did not pass');
  }
}

test('CLI keeps legacy PORT and SIGTERM naturally closes its pending raw socket', { timeout: 8_000, skip: process.platform === 'win32' }, async t => {
  const handle = cli({ PORT: '0' }); t.after(() => cleanupChild(handle));
  const port = await bounded(handle.ready, 'legacy PORT startup');
  const socket = await rawConnection(port); t.after(() => socket.destroy());
  const socketClosed = closed(socket);
  assert.equal(handle.child.kill('SIGTERM'), true);
  assert.deepEqual(await bounded(handle.exited, 'SIGTERM natural exit with pending socket'), { code: 0, signal: null });
  await bounded(socketClosed, 'SIGTERM closes pending connection');
  await assertBindable(port);
});

test('CLI RELAY_PORT overrides an occupied legacy PORT without touching that listener', { timeout: 8_000, skip: process.platform === 'win32' }, async t => {
  const legacy = net.createServer(); const legacyPort = await listen(legacy); t.after(() => closeServer(legacy));
  const handle = cli({ PORT: String(legacyPort), RELAY_PORT: '0' }); t.after(() => cleanupChild(handle));
  const port = await bounded(handle.ready, 'explicit encrypted listener port override');
  assert.notEqual(port, legacyPort); assert.equal(legacy.listening, true);
  handle.child.kill('SIGTERM');
  assert.deepEqual(await bounded(handle.exited, 'override child natural shutdown'), { code: 0, signal: null });
});

test('CLI rejects invalid drain bounds naturally before opening a port', { timeout: 8_000 }, async () => {
  for (const grace of ['-1', '300001', 'NaN']) {
    const port = await freePort(); const handle = cli({ PORT: String(port), RELAY_DRAIN_TIMEOUT_MS: grace });
    try {
      assert.deepEqual(await bounded(handle.exited, 'invalid startup natural refusal'), { code: 1, signal: null });
      await assertBindable(port);
    } finally { await cleanupChild(handle); }
  }
});
