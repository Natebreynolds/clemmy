/**
 * Run: node scripts/run-tests-isolated.mjs apps/relay/server.test.mjs
 *
 * These are the relay's AVAILABILITY controls, exercised over real sockets
 * against a real relay on an ephemeral port. The phone leg is reached from an
 * SNI label alone — no handshake has completed and no credential exists at
 * that point — so every cap below is what stands between a stranger and an
 * amplifier pointed at whichever Mac's pairId they name.
 *
 * The other half of what is pinned here is the failure mode a cap can BE: a
 * bound with no eviction turns an expensive, temporary DoS into a cheap,
 * permanent lockout of the real user, so the tests that matter most are the
 * ones where a legitimate daemon arrives at a full relay.
 *
 * A fake daemon here speaks the same mux framing as src/runtime/mobile-relay.ts
 * (the E2E pin for the daemon itself lives in src/runtime/mobile-relay.test.ts);
 * this file deliberately stays inside apps/relay so the relay keeps its
 * zero-dependency, plain-ESM shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, createSign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';

import { FRAME, allocateStreamId, encodeFrame, frameReader, parseSni, startRelay } from './server.mjs';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-relay-server-test-'));
test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const BASE_DOMAIN = 'r.test.local';

// ─── fixtures ───────────────────────────────────────────────────────────────

/**
 * Mints a self-signed identity the same way mobile-tls.ts does. The pairId is
 * sha256(DER)[0:16] — the relay derives the same value from the certificate in
 * the possession proof, so these must agree byte for byte.
 */
let identityCounter = 0;
function mintIdentity() {
  const dir = path.join(TMP_ROOT, `identity-${identityCounter += 1}`);
  mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-keyout', keyPath, '-out', certPath,
    '-days', '3650', '-nodes',
    '-subj', '/CN=Clementine Relay Test',
    '-addext', 'subjectAltName=DNS:clementine.local',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const keyPem = readFileSync(keyPath, 'utf8');
  const certPem = readFileSync(certPath, 'utf8');
  const der = Buffer.from(
    /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/.exec(certPem)[1].replace(/\s+/g, ''),
    'base64',
  );
  return {
    keyPem,
    certPem,
    pairId: createHash('sha256').update(der).digest('hex').slice(0, 16),
    fingerprint: createHash('sha256').update(der).digest('base64url'),
  };
}

function recordingLog() {
  const warns = [];
  return { info: () => {}, warn: (line) => warns.push(line), error: () => {}, warns };
}

async function waitFor(predicate, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A server_name extension for `hostname`. `declaredNameLen` may lie about it. */
function serverNameExt(hostname, declaredNameLen) {
  const name = Buffer.from(hostname, 'utf8');
  const ext = Buffer.alloc(9 + name.length);
  ext.writeUInt16BE(0x0000, 0);                              // extension type: server_name
  ext.writeUInt16BE(5 + name.length, 2);                     // extension length
  ext.writeUInt16BE(3 + name.length, 4);                     // server_name_list length
  ext.writeUInt8(0, 6);                                      // name type: host_name
  ext.writeUInt16BE(declaredNameLen ?? name.length, 7);      // name length
  name.copy(ext, 9);
  return ext;
}

/** A TLS record carrying a ClientHello whose only extension is `ext`. */
function clientHelloRecord(ext) {
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), Buffer.alloc(32), // version + random
    Buffer.from([0x00]),                          // session id
    Buffer.from([0x00, 0x02, 0x13, 0x01]),        // cipher suites
    Buffer.from([0x01, 0x00]),                    // compression
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(ext.length, 0); return b; })(),
    ext,
  ]);
  const handshake = Buffer.alloc(4);
  handshake.writeUInt8(0x01, 0);
  handshake.writeUIntBE(body.length, 1, 3);
  const record = Buffer.alloc(5);
  record.writeUInt8(0x16, 0);
  record.writeUInt16BE(0x0303, 1);
  record.writeUInt16BE(4 + body.length, 3);
  return Buffer.concat([record, handshake, body]);
}

/** The daemon's own HTTPS door, terminated with the DAEMON's certificate. */
async function startLocalApp(identity) {
  const sockets = new Set();
  const server = tls.createServer({ key: identity.keyPem, cert: identity.certPem }, (socket) => {
    sockets.add(socket);
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      for (let end = buffered.indexOf('\r\n\r\n'); end >= 0; end = buffered.indexOf('\r\n\r\n')) {
        const target = buffered.slice(0, end).split(' ')[1] ?? '/';
        buffered = buffered.slice(end + 4);
        const body = JSON.stringify({ ok: true, target });
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }),
  };
}

/**
 * A daemon dialling out to the relay.
 *   'serve'      — splice each OPEN into the local app (the real shape).
 *   'swallow'    — accept the stream and never answer it, which is what a phone
 *                  the daemon cannot serve looks like from the relay's side.
 *   'flood-first'— dump megabytes down the FIRST stream and serve the rest,
 *                  so a phone that stops reading congests the shared tunnel.
 */
function connectFakeDaemon({ relayPort, identity, authToken, localPort, mode = 'serve' }) {
  const socket = tls.connect({
    host: '127.0.0.1',
    port: relayPort,
    servername: `tunnel.${BASE_DOMAIN}`,
    rejectUnauthorized: false,
  });
  const feed = frameReader();
  const streams = new Map();
  const pongs = { count: 0 };
  let flooded = false;
  let settle;
  const outcome = new Promise((resolve) => { settle = resolve; });

  socket.on('secureConnect', () => {
    socket.write(encodeFrame(FRAME.HELLO, 0, JSON.stringify({ pairId: identity.pairId, authToken, proto: 1 })));
  });
  socket.on('data', (chunk) => {
    for (const frame of feed(chunk)) {
      if (frame.type === FRAME.CHALLENGE) {
        const { nonce } = JSON.parse(frame.payload.toString('utf8'));
        const signature = createSign('sha256').update(nonce).sign(identity.keyPem).toString('base64url');
        socket.write(encodeFrame(FRAME.PROOF, 0, JSON.stringify({ certPem: identity.certPem, signature })));
      } else if (frame.type === FRAME.HELLO_OK) {
        settle('HELLO_OK');
      } else if (frame.type === FRAME.HELLO_ERR) {
        settle(JSON.parse(frame.payload.toString('utf8')).error);
        socket.destroy();
      } else if (frame.type === FRAME.PING) {
        socket.write(encodeFrame(FRAME.PONG, 0));
      } else if (frame.type === FRAME.PONG) {
        pongs.count += 1;
      } else if (frame.type === FRAME.OPEN) {
        if (mode === 'swallow') continue;
        if (mode === 'flood-first' && !flooded) {
          flooded = true;
          // 16 MB, well past any socket's high-water mark, so the relay's write
          // to a phone that never reads is guaranteed to come back false.
          const filler = Buffer.alloc(64 * 1024, 0x7a);
          for (let index = 0; index < 256; index += 1) {
            socket.write(encodeFrame(FRAME.DATA, frame.streamId, filler));
          }
          continue;
        }
        const local = net.connect(localPort, '127.0.0.1');
        // DATA can arrive before the local connect completes; queue until then.
        // `queued`, not `pending` — net.Socket already owns that name.
        local.queued = [];
        streams.set(frame.streamId, local);
        local.on('connect', () => {
          for (const chunkToFlush of local.queued) local.write(chunkToFlush);
          local.queued = null;
        });
        local.on('data', (data) => socket.write(encodeFrame(FRAME.DATA, frame.streamId, data)));
        local.on('close', () => {
          if (streams.get(frame.streamId) === local) {
            streams.delete(frame.streamId);
            if (!socket.destroyed) socket.write(encodeFrame(FRAME.CLOSE, frame.streamId));
          }
        });
        local.on('error', () => local.destroy());
      } else if (frame.type === FRAME.DATA) {
        const local = streams.get(frame.streamId);
        if (!local) continue;
        if (local.queued) local.queued.push(frame.payload);
        else local.write(frame.payload);
      } else if (frame.type === FRAME.CLOSE) {
        const local = streams.get(frame.streamId);
        streams.delete(frame.streamId);
        if (local) local.destroy();
      }
    }
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => settle('CLOSED'));

  return {
    outcome,
    pongs,
    /** Resolves when the relay drops this tunnel — an eviction, seen from the daemon. */
    dropped: new Promise((resolve) => socket.once('close', () => resolve('CLOSED'))),
    ping: (times) => {
      for (let index = 0; index < times; index += 1) socket.write(encodeFrame(FRAME.PING, 0));
    },
    stop() {
      for (const local of streams.values()) local.destroy();
      socket.destroy();
    },
  };
}

/** A phone: raw TLS at the relay, SNI `<pairId>.<base>`, no handshake help. */
function openPhone(relayPort, pairId) {
  const socket = tls.connect({
    host: '127.0.0.1',
    port: relayPort,
    servername: `${pairId}.${BASE_DOMAIN}`,
    rejectUnauthorized: false,
  });
  socket.setNoDelay(true);
  const outcome = new Promise((resolve) => {
    socket.once('secureConnect', () => resolve('secure'));
    socket.once('error', () => resolve('refused'));
    socket.once('close', () => resolve('refused'));
  });
  return { socket, outcome };
}

/**
 * A phone that speaks no TLS at all: just the ClientHello that routes it, then
 * whatever we tell it to send. It never attaches a 'data' listener, so it never
 * reads — which is both how a stalled peer behaves and how backpressure is
 * provoked deliberately.
 */
function rawPhone(relayPort, pairId) {
  const socket = net.connect(relayPort, '127.0.0.1');
  socket.setNoDelay(true);
  socket.on('error', () => socket.destroy());
  socket.on('connect', () => socket.write(clientHelloRecord(serverNameExt(`${pairId}.${BASE_DOMAIN}`))));
  const closed = new Promise((resolve) => socket.once('close', () => resolve('closed')));
  return { socket, closed };
}

function httpOver(socket, target) {
  return new Promise((resolve, reject) => {
    let raw = '';
    const onData = (chunk) => {
      raw += chunk.toString('utf8');
      const end = raw.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = raw.slice(0, end);
      const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
      const body = raw.slice(end + 4);
      if (body.length < length) return;
      socket.off('data', onData);
      resolve({ status: Number(head.split(' ')[1]), body: body.slice(0, length) });
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.write(`GET ${target} HTTP/1.1\r\nHost: relay.test\r\n\r\n`);
  });
}

/** Relay + local app + registered daemon, torn down together. */
async function withRegisteredTunnel(options, body) {
  const { limits, recordOptions, daemonMode = 'serve', identity = mintIdentity(), authToken = 'a'.repeat(32) } = options;
  const relayIdentity = mintIdentity();
  const log = recordingLog();
  const app = await startLocalApp(identity);
  const relay = await startRelay({
    port: 0,
    baseDomain: BASE_DOMAIN,
    tlsKeyPem: relayIdentity.keyPem,
    tlsCertPem: relayIdentity.certPem,
    log,
    limits,
    recordOptions,
  });
  const daemon = connectFakeDaemon({
    relayPort: relay.port,
    identity,
    authToken,
    localPort: app.port,
    mode: daemonMode,
  });
  assert.equal(await daemon.outcome, 'HELLO_OK', 'the fake daemon must register');
  try {
    await body({ relay, daemon, identity, relayIdentity, app, log });
  } finally {
    daemon.stop();
    await relay.close();
    await app.close();
  }
}

// ─── the parser ─────────────────────────────────────────────────────────────

test('parseSni refuses a server_name that runs past its own extension', () => {
  // The relay routes on this string. subarray CLAMPS rather than throwing, so
  // without the bounds check a truncated name became a SHORT hostname the peer
  // never sent — and a short hostname is a different routing label.
  const host = 'abcdef0123456789.r.test.local';
  assert.equal(parseSni(clientHelloRecord(serverNameExt(host))).sni, host);
  const overrun = parseSni(clientHelloRecord(serverNameExt(host, host.length + 64)));
  assert.equal(overrun.bad, true, 'a name longer than its extension must not be routed');
  assert.equal(overrun.sni, undefined);
});

// ─── stream ids ─────────────────────────────────────────────────────────────

test('allocateStreamId wraps the u32 counter and skips ids still in use', () => {
  // encodeFrame masks the id with `>>> 0`, so a counter that only ever
  // incremented would, past 2^32, hand a new phone the id of a LIVE stream and
  // cross two phones' bytes together. This is the wrap, and the skip the wrap
  // makes necessary — reachable here only by seeding the counter.
  const live = { socket: null };
  const tunnel = { nextStreamId: 0xfffffffe, streams: new Map([[0xffffffff, live], [1, live]]) };

  assert.equal(allocateStreamId(tunnel, 8), 0xfffffffe, 'the last free id below the wrap');
  // 0xffffffff and 1 are both live, so the walk must wrap PAST the ceiling and
  // then step over the live low id rather than reissuing either.
  assert.equal(allocateStreamId(tunnel, 8), 2, 'the wrap must not reissue a live id');
  assert.equal(tunnel.nextStreamId, 3, 'the counter continues from the id it handed out');

  // Bounded: a tunnel whose ids are all taken reports failure instead of
  // spinning, and the caller refuses the phone rather than aliasing a stream.
  const full = { nextStreamId: 1, streams: new Map([[1, live], [2, live]]) };
  assert.equal(allocateStreamId(full, 2), 3);
  assert.equal(allocateStreamId({ nextStreamId: 1, streams: full.streams }, 1), null);
});

// ─── the caps ───────────────────────────────────────────────────────────────

test('a per-tunnel stream cap refuses the N+1 phone and leaves the first N working', async () => {
  await withRegisteredTunnel({ limits: { maxStreamsPerTunnel: 3, maxStreamsPerIp: 100 } }, async ({ relay, identity, log }) => {
    const phones = [];
    for (let index = 0; index < 3; index += 1) {
      const phone = openPhone(relay.port, identity.pairId);
      assert.equal(await phone.outcome, 'secure', `phone ${index} must complete its handshake`);
      phones.push(phone);
    }
    await waitFor(() => relay.streamCount(identity.pairId) === 3, 'three live streams');

    // The N+1 connection never reaches a handshake: it is destroyed at splice.
    const overflow = openPhone(relay.port, identity.pairId);
    assert.equal(await overflow.outcome, 'refused', 'the cap must destroy the N+1 phone socket');
    assert.equal(relay.streamCount(identity.pairId), 3, 'a refused socket must not occupy a slot');

    // The refusal must not have collateral: the first N still serve requests.
    for (const [index, phone] of phones.entries()) {
      const response = await httpOver(phone.socket, `/m/ping?${index}`);
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).target, `/m/ping?${index}`);
    }

    // The log is throttled to one line per tunnel per interval — otherwise the
    // log write per refused socket becomes the amplifier the cap prevents.
    for (let index = 0; index < 4; index += 1) {
      await openPhone(relay.port, identity.pairId).outcome;
    }
    const capWarnings = log.warns.filter((line) => line.includes('refusing phone streams'));
    assert.equal(capWarnings.length, 1, `expected one throttled cap warning, got ${capWarnings.length}`);

    // Closing a stream returns its slot — the terminal path really releases.
    phones[0].socket.destroy();
    await waitFor(() => relay.streamCount(identity.pairId) === 2, 'the closed stream to be released');
    const replacement = openPhone(relay.port, identity.pairId);
    assert.equal(await replacement.outcome, 'secure', 'a freed slot must be reusable');
    replacement.socket.destroy();
    for (const phone of phones.slice(1)) phone.socket.destroy();
  });
});

test('a per-source cap bounds one address without exhausting the tunnel', async () => {
  await withRegisteredTunnel({ limits: { maxStreamsPerTunnel: 100, maxStreamsPerIp: 2 } }, async ({ relay, identity }) => {
    const first = openPhone(relay.port, identity.pairId);
    const second = openPhone(relay.port, identity.pairId);
    assert.equal(await first.outcome, 'secure');
    assert.equal(await second.outcome, 'secure');
    await waitFor(() => relay.streamCount(identity.pairId) === 2, 'two live streams');

    const third = openPhone(relay.port, identity.pairId);
    assert.equal(await third.outcome, 'refused', 'the per-source cap must hold below the tunnel cap');
    assert.equal(relay.streamCount(identity.pairId), 2);

    // The bucket is per source, not global: releasing one frees exactly one.
    first.socket.destroy();
    await waitFor(() => relay.streamCount(identity.pairId) === 1, 'the released per-source slot');
    const fourth = openPhone(relay.port, identity.pairId);
    assert.equal(await fourth.outcome, 'secure');
    fourth.socket.destroy();
    second.socket.destroy();
  });
});

test('an unanswered phone is dropped even while it keeps sending bytes', async () => {
  // The daemon swallows the OPEN, so nothing ever comes back down the stream.
  // The deadline used to clear on the first byte in EITHER direction, so one
  // junk byte from the peer disarmed it and the slot — plus a local socket on
  // the victim's Mac — was held for as long as TCP survived. Only the daemon's
  // answer may clear it.
  await withRegisteredTunnel(
    { daemonMode: 'swallow', limits: { phoneFirstByteMs: 400 } },
    async ({ relay, identity }) => {
      const chatty = rawPhone(relay.port, identity.pairId);
      await waitFor(() => relay.streamCount(identity.pairId) === 1, 'the chatty stream to register');

      // It writes continuously for far longer than the deadline. Under the old
      // either-direction rule this socket, its slot and the local socket the
      // OPEN made the Mac dial survived for as long as TCP did.
      const noise = setInterval(() => {
        if (!chatty.socket.destroyed) chatty.socket.write('x'.repeat(64));
      }, 40);
      try {
        assert.equal(
          await Promise.race([chatty.closed, sleep(4_000).then(() => 'still open')]),
          'closed',
          'bytes from the peer must not disarm the answer deadline',
        );
      } finally {
        clearInterval(noise);
      }
      await waitFor(() => relay.streamCount(identity.pairId) === 0, 'the stream slot to come back');
    },
  );
});

test('a spliced phone that is never answered is dropped and gives its slot back', async () => {
  await withRegisteredTunnel(
    { daemonMode: 'swallow', limits: { phoneFirstByteMs: 400 } },
    async ({ relay, identity }) => {
      const phone = openPhone(relay.port, identity.pairId);
      await waitFor(() => relay.streamCount(identity.pairId) === 1, 'the silent stream to register');
      assert.equal(await phone.outcome, 'refused', 'the silent phone socket must be destroyed');
      await waitFor(() => relay.streamCount(identity.pairId) === 0, 'the silent stream to be reclaimed');
    },
  );
});

// ─── backpressure ───────────────────────────────────────────────────────────

test('a phone that dies mid-congestion un-wedges the tunnel it paused', async () => {
  // The tunnel is SHARED. When a phone stops reading, the relay pauses the one
  // socket every other phone on that Mac is served from, and waits for 'drain'.
  // A phone that dies instead of draining never emits one — so without the
  // 'close' pairing the pause is permanent and the whole Mac goes dark.
  await withRegisteredTunnel({ daemonMode: 'flood-first' }, async ({ relay, identity }) => {
    const congested = rawPhone(relay.port, identity.pairId);
    await waitFor(() => relay.streamCount(identity.pairId) === 1, 'the congested stream');
    // Give the flood time to overrun the phone's buffers and pause the tunnel.
    await sleep(300);

    const second = openPhone(relay.port, identity.pairId);
    const wedged = await Promise.race([second.outcome, sleep(600).then(() => 'pending')]);
    assert.equal(wedged, 'pending', 'a paused tunnel must not be able to serve the second phone yet');

    congested.socket.destroy();
    // Raced, not awaited: without the resume this never settles at all, and a
    // pin that hangs the runner reports nothing about why.
    const recovered = await Promise.race([second.outcome, sleep(5_000).then(() => 'still wedged')]);
    assert.equal(recovered, 'secure', 'the dead phone must release the tunnel it paused');
    assert.equal(JSON.parse((await httpOver(second.socket, '/m/after-the-wedge')).body).target, '/m/after-the-wedge');
    second.socket.destroy();
  });
});

// ─── the registration record ────────────────────────────────────────────────

test('a valid possession proof with a rotated auth token rebinds the record', async () => {
  const identity = mintIdentity();
  const relayIdentity = mintIdentity();
  const log = recordingLog();
  const app = await startLocalApp(identity);
  const relay = await startRelay({
    port: 0,
    baseDomain: BASE_DOMAIN,
    tlsKeyPem: relayIdentity.keyPem,
    tlsCertPem: relayIdentity.certPem,
    log,
  });
  try {
    const original = 'original-token-original-token';
    const first = connectFakeDaemon({ relayPort: relay.port, identity, authToken: original, localPort: app.port });
    assert.equal(await first.outcome, 'HELLO_OK');
    first.stop();
    await waitFor(() => relay.tunnelCount() === 0, 'the first tunnel to drop');

    // The state dir was restored / re-created: same certificate key, new token.
    // The old store refused this forever with CLAIMED, locking a Mac out of
    // its own address. The key is the stronger credential and must win.
    const rotated = 'rotated-token-rotated-token';
    const second = connectFakeDaemon({ relayPort: relay.port, identity, authToken: rotated, localPort: app.port });
    assert.equal(await second.outcome, 'HELLO_OK', 'a proven key must not be refused by a stale token');
    assert.equal(
      log.warns.filter((line) => line.includes('rebound to a new auth token')).length,
      1,
      'the rebind must be logged exactly once',
    );
    second.stop();
    await waitFor(() => relay.tunnelCount() === 0, 'the second tunnel to drop');

    // ...and the line must mean what it says: coming back on the SAME token is
    // not a rebind, so it must not produce a second warning.
    const third = connectFakeDaemon({ relayPort: relay.port, identity, authToken: rotated, localPort: app.port });
    assert.equal(await third.outcome, 'HELLO_OK');
    assert.equal(
      log.warns.filter((line) => line.includes('rebound to a new auth token')).length,
      1,
      'an unchanged token must not be reported as a rebind',
    );
    assert.equal(relay.registrationCount(), 1, 'one address, one record');
    third.stop();
  } finally {
    await relay.close();
    await app.close();
  }
});

test('the registration record stays bounded in memory and refuses nobody', async () => {
  const relayIdentity = mintIdentity();
  const log = recordingLog();
  const relay = await startRelay({
    port: 0,
    baseDomain: BASE_DOMAIN,
    tlsKeyPem: relayIdentity.keyPem,
    tlsCertPem: relayIdentity.certPem,
    log,
    // Registration is open to any self-signed certificate — there is no
    // enrollment authority in this design — so the only defence available is
    // refusing to let unbounded registration mean unbounded state. The record
    // is a log line's worth of forensics, never a gate: falling out of it
    // costs an operator a hint, and costs a daemon nothing.
    recordOptions: { maxEntries: 2 },
  });
  try {
    for (let index = 0; index < 4; index += 1) {
      const identity = mintIdentity();
      const app = await startLocalApp(identity);
      const daemon = connectFakeDaemon({
        relayPort: relay.port,
        identity,
        authToken: `record-token-number-${index}`,
        localPort: app.port,
      });
      assert.equal(await daemon.outcome, 'HELLO_OK', 'every prover is admitted; only the record is capped');
      daemon.stop();
      await app.close();
      await waitFor(() => relay.tunnelCount() === 0, `tunnel ${index} to drop`);
    }
    assert.equal(relay.registrationCount(), 2, 'four registrations must leave two records');
  } finally {
    await relay.close();
  }
});

// ─── the tunnel table ───────────────────────────────────────────────────────

test('at capacity a genuine daemon takes an idle stranger slot instead of being refused', async () => {
  // THE case a bare cap gets wrong. Minting certificates is an openssl loop, so
  // strangers can fill the table for the price of idle sockets — and a cap that
  // only refuses would then lock every real Mac out permanently, which is worse
  // than the memory it was protecting.
  const relayIdentity = mintIdentity();
  const log = recordingLog();
  const relay = await startRelay({
    port: 0,
    baseDomain: BASE_DOMAIN,
    tlsKeyPem: relayIdentity.keyPem,
    tlsCertPem: relayIdentity.certPem,
    log,
    limits: { maxTunnels: 2 },
  });
  const mine = mintIdentity();
  const app = await startLocalApp(mine);
  const squatters = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const identity = mintIdentity();
      const daemon = connectFakeDaemon({
        relayPort: relay.port,
        identity,
        authToken: `squatter-token-number-${index}`,
        localPort: app.port,
      });
      assert.equal(await daemon.outcome, 'HELLO_OK');
      squatters.push({ identity, daemon });
      await sleep(5); // so "least recently used" is unambiguous below
    }
    assert.equal(relay.tunnelCount(), 2, 'the table is full of strangers');

    const legitimate = connectFakeDaemon({
      relayPort: relay.port, identity: mine, authToken: 'my-token-my-token-my-token', localPort: app.port,
    });
    assert.equal(await legitimate.outcome, 'HELLO_OK', 'a proven daemon must not be locked out by squatters');
    assert.equal(relay.tunnelCount(), 2, 'admitting it took a slot rather than growing the table');
    assert.equal(relay.hasTunnel(mine.pairId), true);

    // The oldest idle leg goes, and the eviction is stated in the log rather
    // than being a tunnel that silently disappears.
    assert.equal(relay.hasTunnel(squatters[0].identity.pairId), false, 'the least recently used stranger loses its slot');
    assert.equal(relay.hasTunnel(squatters[1].identity.pairId), true, 'only one slot is taken');
    assert.equal(await squatters[0].daemon.dropped, 'CLOSED', 'the evicted daemon sees its tunnel close');
    assert.ok(
      log.warns.some((line) => line.includes(`evicting ${squatters[0].identity.pairId}`) && line.includes('no open streams')),
      `the eviction must be logged with its reason, got ${JSON.stringify(log.warns)}`,
    );
    legitimate.stop();
    for (const squatter of squatters) squatter.daemon.stop();
  } finally {
    await relay.close();
    await app.close();
  }
});

test('one source cannot hold every slot: its oldest leg loses to a new address', async () => {
  // Every tunnel here is BUSY, so there is no idle slot to take — but they all
  // dial from one address, which is over its share. Behind a TCP proxy that
  // address is the proxy's for everyone, which is exactly why crossing the
  // share only chooses a victim and never refuses a caller.
  const relayIdentity = mintIdentity();
  const log = recordingLog();
  const relay = await startRelay({
    port: 0,
    baseDomain: BASE_DOMAIN,
    tlsKeyPem: relayIdentity.keyPem,
    tlsCertPem: relayIdentity.certPem,
    log,
    limits: { maxTunnels: 2, maxTunnelsPerIp: 1 },
  });
  const held = [];
  const phones = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const identity = mintIdentity();
      const app = await startLocalApp(identity);
      const daemon = connectFakeDaemon({
        relayPort: relay.port, identity, authToken: `busy-token-number-${index}`, localPort: app.port,
      });
      assert.equal(await daemon.outcome, 'HELLO_OK');
      const phone = openPhone(relay.port, identity.pairId);
      assert.equal(await phone.outcome, 'secure');
      await waitFor(() => relay.streamCount(identity.pairId) === 1, `tunnel ${index} to carry a phone`);
      held.push({ identity, daemon, app });
      phones.push(phone);
      await sleep(5);
    }

    const newcomer = mintIdentity();
    const newApp = await startLocalApp(newcomer);
    const daemon = connectFakeDaemon({
      relayPort: relay.port, identity: newcomer, authToken: 'newcomer-token-newcomer', localPort: newApp.port,
    });
    assert.equal(await daemon.outcome, 'HELLO_OK', 'one host over its share must not be able to lock the table');
    assert.equal(relay.hasTunnel(held[0].identity.pairId), false, 'the oldest leg of the greedy source goes');
    assert.equal(relay.hasTunnel(newcomer.pairId), true);
    assert.ok(
      log.warns.some((line) => line.includes('over its 1-leg share')),
      `the eviction reason must name the share, got ${JSON.stringify(log.warns)}`,
    );
    daemon.stop();
    await newApp.close();
  } finally {
    for (const phone of phones) phone.socket.destroy();
    for (const entry of held) { entry.daemon.stop(); await entry.app.close(); }
    await relay.close();
  }
});

test('AT_CAPACITY is refused only when every tunnel is carrying live streams', async () => {
  const identity = mintIdentity();
  const relayIdentity = mintIdentity();
  const log = recordingLog();
  const app = await startLocalApp(identity);
  const relay = await startRelay({
    port: 0,
    baseDomain: BASE_DOMAIN,
    tlsKeyPem: relayIdentity.keyPem,
    tlsCertPem: relayIdentity.certPem,
    log,
    // A share well above the one leg this test holds, so the only thing that
    // could free a slot is an idle tunnel — and there is none.
    limits: { maxTunnels: 1, maxTunnelsPerIp: 8 },
  });
  let phone;
  try {
    const held = connectFakeDaemon({ relayPort: relay.port, identity, authToken: 'held-token-held-token', localPort: app.port });
    assert.equal(await held.outcome, 'HELLO_OK');
    phone = openPhone(relay.port, identity.pairId);
    assert.equal(await phone.outcome, 'secure');
    await waitFor(() => relay.streamCount(identity.pairId) === 1, 'the held tunnel to carry a phone');

    const stranger = mintIdentity();
    const overflow = connectFakeDaemon({
      relayPort: relay.port,
      identity: stranger,
      authToken: 'stranger-token-stranger',
      localPort: app.port,
    });
    assert.equal(await overflow.outcome, 'AT_CAPACITY', 'a full relay doing real work refuses, and says so');
    assert.equal(relay.tunnelCount(), 1);
    assert.equal(relay.hasTunnel(identity.pairId), true, 'the working tunnel is not sacrificed');
    assert.equal(relay.streamCount(identity.pairId), 1, 'nor is the phone on it');
    assert.ok(
      log.warns.some((line) => line.includes('all carrying streams')),
      `the refusal must say what full means, got ${JSON.stringify(log.warns)}`,
    );

    // Re-registering an address the relay ALREADY holds costs no new slot —
    // otherwise a reconnecting daemon would be locked out by the cap it fills.
    const reconnect = connectFakeDaemon({ relayPort: relay.port, identity, authToken: 'held-token-held-token', localPort: app.port });
    assert.equal(await reconnect.outcome, 'HELLO_OK', 'the same address must be able to reconnect at capacity');
    reconnect.stop();
    held.stop();
  } finally {
    phone?.socket.destroy();
    await relay.close();
    await app.close();
  }
});

test('a PING flood on the tunnel leg gets one PONG, not one per PING', async () => {
  await withRegisteredTunnel({}, async ({ daemon }) => {
    // Only an authenticated daemon reaches this frame, but "authenticated" is
    // not "entitled to a reply per packet" — the relay's own heartbeat needs
    // one PONG per tunnel per 30 s.
    daemon.ping(50);
    await waitFor(() => daemon.pongs.count > 0, 'the first PONG');
    await sleep(250);
    assert.equal(daemon.pongs.count, 1, `expected one rate-limited PONG, got ${daemon.pongs.count}`);
  });
});

// ─── the splice still works ─────────────────────────────────────────────────

test('a genuine daemon and phone still splice end to end, on the daemon certificate', async () => {
  await withRegisteredTunnel({}, async ({ relay, identity, relayIdentity }) => {
    const phone = openPhone(relay.port, identity.pairId);
    assert.equal(await phone.outcome, 'secure');

    // THE property every cap above had to leave intact: the certificate the
    // phone handshook against is the DAEMON's, never the relay's.
    const peerFp = createHash('sha256').update(phone.socket.getPeerCertificate().raw).digest('base64url');
    assert.equal(peerFp, identity.fingerprint, 'the phone must see the daemon certificate through the splice');
    assert.notEqual(peerFp, relayIdentity.fingerprint);

    // Several requests on one stream, and several concurrent streams — the
    // ordinary shape of a phone holding an SSE stream plus fetches.
    assert.equal((await httpOver(phone.socket, '/m/first')).status, 200);
    assert.equal(JSON.parse((await httpOver(phone.socket, '/m/second')).body).target, '/m/second');

    const others = [];
    for (let index = 0; index < 5; index += 1) {
      const extra = openPhone(relay.port, identity.pairId);
      assert.equal(await extra.outcome, 'secure');
      others.push(extra);
    }
    const bodies = await Promise.all(others.map((extra, index) => httpOver(extra.socket, `/m/parallel-${index}`)));
    for (const [index, response] of bodies.entries()) {
      assert.equal(JSON.parse(response.body).target, `/m/parallel-${index}`);
    }

    for (const extra of others) extra.socket.destroy();
    phone.socket.destroy();
    await waitFor(() => relay.streamCount(identity.pairId) === 0, 'every stream slot to come back');
  });
});
