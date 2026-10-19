/** Local, child-isolated admission regressions; never reads a real Clem home. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash, createSign } from 'node:crypto';
import { FRAME, encodeFrame, frameReader } from './server.mjs';

const BASE = 'relay-admission.test';
/** Larger than either write cap below, far smaller than a relay frame. */
const OVERSIZE_REPLY_BYTES = 32_768;
const TEMP = mkdtempSync(path.join(os.tmpdir(), 'clem-relay-admission-'));
let identity;
test.before(() => {
  const key = path.join(TEMP, 'key.pem'), cert = path.join(TEMP, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=relay-admission-test'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const keyPem = readFileSync(key, 'utf8'), certPem = readFileSync(cert, 'utf8');
  const der = Buffer.from(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(certPem)[1].replace(/\s+/g, ''), 'base64');
  identity = { keyPem, certPem, pairId: createHash('sha256').update(der).digest('hex').slice(0, 16) };
});
test.after(() => rmSync(TEMP, { recursive: true, force: true }));

function deadline(promise, description, ms = 3_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), ms); })]).finally(() => clearTimeout(timer));
}
function connected(options) {
  const socket = tls.connect({ host: '127.0.0.1', servername: `tunnel.${BASE}`, rejectUnauthorized: false, ...options });
  socket.on('error', () => socket.destroy());
  return socket;
}
async function fixture(body, limits) {
  const home = mkdtempSync(path.join(TEMP, 'home-')); mkdirSync(path.join(home, '.clementine-next'));
  // A null-HELLO bug must terminate this disposable child, never the test runner.
  const script = `import {startRelay} from ${JSON.stringify(new URL('./server.mjs', import.meta.url).href)};
    let relay;
    process.on('message', async m => {
      if(m.type === 'start') {
        relay = await startRelay({port:0,baseDomain:${JSON.stringify(BASE)},tlsKeyPem:m.key,tlsCertPem:m.cert,limits:m.limits,log:{info(){},warn(){},error(){}}});
        process.send({type:'ready',port:relay.port});
      } else if(m.type === 'status') {
        process.send({type:'status',request:m.request,status:relay.status()});
      } else if(m.type === 'close') {
        await relay.close(); process.disconnect();
      }
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home, CLEMENTINE_HOME: path.join(home, '.clementine-next') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const crash = { nullPropertyTypeError: false };
  let stderrTail = '';
  child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-8_192); if (/TypeError: Cannot read properties of null/.test(stderrTail)) crash.nullPropertyTypeError = true; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    child.once('message', m => m.type === 'ready' ? resolve(m.port) : reject(new Error('Unexpected child message')));
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Relay child exited before ready')));
  });
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  let bodyCompleted = false;
  try {
    child.send({ type: 'start', key: identity.keyPem, cert: identity.certPem, limits });
    const port = await deadline(ready, 'child relay startup');
    let requestCounter = 0;
    const status = async () => {
      const request = ++requestCounter;
      let onMessage;
      const result = new Promise(resolve => { onMessage = m => { if (m.type === 'status' && m.request === request) resolve(m.status); }; child.on('message', onMessage); });
      child.send({ type: 'status', request });
      try { return await deadline(result, 'read-only child status'); } finally { child.off('message', onMessage); }
    };
    await body({ port, track, child, exited, crash, status });
    bodyCompleted = true;
  } finally {
    for (const socket of sockets) socket.destroy();
    if (child.exitCode === null && child.signalCode === null && child.connected) child.send({ type: 'close' });
    try { await deadline(exited, 'child shutdown', 2_000); } catch { child.kill('SIGKILL'); await deadline(exited, 'owned child termination'); if (bodyCompleted) throw new Error('Relay child required forced cleanup instead of natural shutdown'); }
  }
}

async function registered({ port, track }, { postProof = null, firstPhone = null } = {}) {
  const socket = track(connected({ port })), feed = frameReader();
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const app = tls.createServer({ key: identity.keyPem, cert: identity.certPem }, local => {
    track(local);
    local.on('error', () => local.destroy());
    local.once('data', () => local.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK'));
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const locals = new Map();
  let pongResolve;
  const postProofPong = new Promise(resolve => { pongResolve = resolve; });
  const ping = encodeFrame(FRAME.PING, 0);
  let specialPhoneUsed = false;
  socket.on('secureConnect', () => socket.write(encodeFrame(FRAME.HELLO, 0, JSON.stringify({ pairId: identity.pairId, authToken: 'local-admission-test-token', proto: 1 }))));
  socket.on('data', chunk => {
    for (const frame of feed(chunk)) {
      if (frame.type === FRAME.CHALLENGE) {
        const { nonce } = JSON.parse(frame.payload.toString('utf8'));
        const signature = createSign('sha256').update(nonce).sign(identity.keyPem).toString('base64url');
        const proof = encodeFrame(FRAME.PROOF, 0, JSON.stringify({ certPem: identity.certPem, signature }));
        socket.write(postProof ? Buffer.concat([proof, postProof === 'partial' ? ping.subarray(0, 5) : ping]) : proof);
      } else if (frame.type === FRAME.HELLO_OK) { readyResolve(true); if (postProof === 'partial') socket.write(ping.subarray(5)); }
      else if (frame.type === FRAME.PONG) pongResolve(true);
      else if (frame.type === FRAME.OPEN) {
        if (firstPhone && !specialPhoneUsed) {
          specialPhoneUsed = true;
          socket.write(encodeFrame(FRAME.DATA, frame.streamId, firstPhone === 'empty' ? Buffer.alloc(0) : Buffer.alloc(OVERSIZE_REPLY_BYTES, 0x42)));
          continue;
        }
        const local = track(net.connect(app.address().port, '127.0.0.1'));
        locals.set(frame.streamId, local);
        local.on('data', data => socket.write(encodeFrame(FRAME.DATA, frame.streamId, data)));
        local.on('error', () => local.destroy());
        local.on('close', () => { locals.delete(frame.streamId); if (!socket.destroyed) socket.write(encodeFrame(FRAME.CLOSE, frame.streamId)); });
      } else if (frame.type === FRAME.DATA) locals.get(frame.streamId)?.write(frame.payload);
      else if (frame.type === FRAME.CLOSE) locals.get(frame.streamId)?.destroy();
      else if (frame.type === FRAME.PING) socket.write(encodeFrame(FRAME.PONG, 0));
    }
  });
  socket.once('close', () => { readyResolve(false); pongResolve(false); });
  const close = () => { for (const local of locals.values()) local.destroy(); socket.destroy(); app.close(); };
  try { assert.equal(await deadline(ready, 'valid possession registration'), true); }
  catch (error) { close(); throw error; }
  return { socket, postProofPong, close };
}
async function phoneStillWorks({ port, track }) {
  const phone = track(tls.connect({ host: '127.0.0.1', port, servername: `${identity.pairId}.${BASE}`, rejectUnauthorized: false }));
  phone.on('error', () => phone.destroy());
  let raw = '';
  const result = new Promise(resolve => {
    phone.on('secureConnect', () => {
      const fp = createHash('sha256').update(phone.getPeerCertificate().raw).digest('hex').slice(0, 16);
      assert.equal(fp, identity.pairId, 'phone still handshakes against the daemon certificate');
      phone.write('GET /admission-survival HTTP/1.1\r\nHost: local.test\r\n\r\n');
    });
    phone.on('data', data => { raw += data.toString(); if (raw.endsWith('\r\n\r\nOK')) resolve(true); });
    phone.once('close', () => resolve(raw.endsWith('\r\n\r\nOK')));
  });
  assert.equal(await deadline(result, 'existing end-to-end phone after bad registration'), true);
  phone.destroy();
}
async function badHello(context, payload, streamId = 0) {
  const socket = context.track(connected({ port: context.port })), feed = frameReader();
  let challenged = false;
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.once('secureConnect', () => socket.write(encodeFrame(FRAME.HELLO, streamId, payload)));
  socket.on('data', chunk => { for (const frame of feed(chunk)) if (frame.type === FRAME.CHALLENGE) { challenged = true; socket.destroy(); } });
  await deadline(closed, 'malformed registration refusal');
  assert.equal(challenged, false, 'malformed HELLO must not reach the possession stage');
  await Promise.race([context.exited, new Promise(resolve => setTimeout(resolve, 100))]);
  assert.equal(context.child.exitCode, null, `invalid HELLO must not crash the relay child (null-property TypeError: ${context.crash.nullPropertyTypeError})`);
  assert.equal(context.child.signalCode, null, 'invalid HELLO must not terminate the relay child');
}

test('valid JSON null in HELLO closes only its socket and leaves an existing TLS splice usable', async () => {
  await fixture(async context => {
    const daemon = await registered(context);
    try { await badHello(context, 'null'); await phoneStillWorks(context); }
    finally { daemon.close(); }
  });
});

test('HELLO rejects arrays and coerced fields before possession, without harming a valid tunnel', async () => {
  await fixture(async context => {
    const daemon = await registered(context);
    try {
      for (const hello of [[], {}, { pairId: [identity.pairId], authToken: 'local-admission-test-token' }, { pairId: identity.pairId, authToken: ['local-admission-test-token'] }, { pairId: identity.pairId, authToken: 1234567890123456 }, { pairId: identity.pairId, authToken: { nested: 'token' } }]) await badHello(context, JSON.stringify(hello));
      await phoneStillWorks(context);
    } finally { daemon.close(); }
  });
});

test('malformed PROOF is refused without taking over an existing proven tunnel', async () => {
  await fixture(async context => {
    const daemon = await registered(context);
    try {
      for (const proof of ['null', '[]', '{}', '{']) {
        const socket = context.track(connected({ port: context.port })), feed = frameReader();
        const closed = new Promise(resolve => socket.once('close', resolve));
        socket.once('secureConnect', () => socket.write(encodeFrame(FRAME.HELLO, 0, JSON.stringify({ pairId: identity.pairId, authToken: 'other-local-token' }))));
        socket.on('data', chunk => { for (const frame of feed(chunk)) if (frame.type === FRAME.CHALLENGE) socket.write(encodeFrame(FRAME.PROOF, 0, proof)); });
        await deadline(closed, 'malformed proof refusal');
        assert.equal(context.child.exitCode, null);
      }
      await phoneStillWorks(context);
    } finally { daemon.close(); }
  });
});


test('a PING coalesced after a valid PROOF is handled after registration', async () => {
  await fixture(async context => {
    const daemon = await registered(context, { postProof: 'coalesced' });
    try {
      assert.equal(await deadline(daemon.postProofPong, 'PONG for coalesced post-proof frame'), true);
      await phoneStillWorks(context);
    } finally { daemon.close(); }
  });
});

test('a partial frame following PROOF survives the registration parser handoff', async () => {
  await fixture(async context => {
    const daemon = await registered(context, { postProof: 'partial' });
    try {
      assert.equal(await deadline(daemon.postProofPong, 'PONG for reassembled post-proof frame'), true);
      await phoneStillWorks(context);
    } finally { daemon.close(); }
  });
});


async function rejectedPhone(context) {
  const socket = context.track(tls.connect({ host: '127.0.0.1', port: context.port, servername: `${identity.pairId}.${BASE}`, rejectUnauthorized: false }));
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.on('error', () => socket.destroy());
  await deadline(closed, 'bounded phone rejection');
}
async function queuesReleased(context) {
  const until = Date.now() + 2_000;
  for (;;) {
    const state = await context.status();
    if (state.queuedBytes === 0 && state.queuedWrites === 0 && state.streams === 0) return state;
    if (Date.now() > until) assert.fail('closed phone retained queue accounting or stream ownership');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('per-phone and aggregate write caps close only the overflowing phone and release accounting', async t => {
  // The caps sit well above a real TLS handshake flight and below the
  // oversize reply. With 1 KB caps, OpenSSL 3.5's post-quantum hybrid key
  // share (a 1,568-byte ClientHello, a 1,828-byte server flight) tripped them
  // on the healthy traffic instead: the aggregate cap closed the daemon's
  // tunnel while forwarding the phone's hello, and the per-phone cap closed
  // the second, healthy phone on the server's reply.
  for (const [name, limits] of [
    ['per-phone', { maxQueuedBytesPerPhone: 16_384, maxQueuedBytesTotal: 65_536 }],
    ['aggregate', { maxQueuedBytesPerPhone: 65_536, maxQueuedBytesTotal: 16_384 }],
  ]) {
    await t.test(name, async () => fixture(async context => {
      const daemon = await registered(context, { firstPhone: 'oversize' });
      try {
        await rejectedPhone(context);
        const state = await queuesReleased(context);
        assert.equal(state.tunnels, 1, 'a phone overflow must preserve the proven daemon tunnel');
        assert.equal(daemon.socket.destroyed, false);
        await phoneStillWorks(context);
      } finally { daemon.close(); }
    }, limits));
  }
});

test('an empty daemon DATA frame does not disarm the phone first-byte deadline', async () => {
  await fixture(async context => {
    const daemon = await registered(context, { firstPhone: 'empty' });
    try {
      await rejectedPhone(context);
      const state = await queuesReleased(context);
      assert.equal(state.tunnels, 1);
      await phoneStillWorks(context);
    } finally { daemon.close(); }
  }, { phoneFirstByteMs: 250 });
});
