/**
 * Clementine mobile relay — a dumb splice for off-LAN phone access.
 *
 * Security model: the relay NEVER terminates the phone's TLS. A phone
 * connection arrives as raw TCP, we parse only the ClientHello's SNI to pick
 * a route, then splice bytes into the paired daemon's outbound tunnel. The
 * pinned handshake (phone ⇄ Mac certificate) happens end-to-end through the
 * splice, so a fully compromised relay can observe ciphertext and drop
 * traffic — never read, forge, or impersonate. Relay authentication is
 * therefore an availability control, not a confidentiality one.
 *
 * Routing, all on one listening port, demuxed by SNI:
 *   tunnel.<base>   — a daemon dialing OUT to register its tunnel. This leg
 *                     IS TLS-terminated here (the relay's own self-signed
 *                     cert, whose fingerprint the daemon pins via config)
 *                     because the HELLO carries the pairing's auth token.
 *   <pairId>.<base> — a phone. Raw passthrough into that pairing's tunnel.
 *
 * Registration requires PROOF OF POSSESSION. A tunnel address is
 * sha256(daemon certificate) truncated, and that fingerprint is printed in
 * every pairing QR — so with a first-come claim, anyone who had seen a user's
 * QR could register their address first and lock the real Mac out for good.
 * Instead the relay issues a random challenge and the daemon returns its
 * certificate plus a signature over it; the relay checks the certificate
 * hashes to the claimed address AND that the signature verifies against it.
 * The private key never leaves the user's Mac, so the address is unclaimable
 * by anyone else. The auth token is retained on top as a rebind check.
 *
 * Zero runtime dependencies. Configuration (env):
 *   PORT                — listen port (Railway injects this)
 *   RELAY_BASE_DOMAIN   — e.g. r.example.com  (SNI suffix to demux on)
 *   RELAY_TLS_KEY_PEM / RELAY_TLS_CERT_PEM — PEM material for the tunnel leg
 *     (or RELAY_TLS_KEY_FILE / RELAY_TLS_CERT_FILE paths)
 *   RELAY_DATA_DIR      — claims persistence (default ./data)
 */
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { createHash, timingSafeEqual, randomBytes, createVerify, X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// ─── mux framing (mirrored in src/runtime/mobile-relay.ts — keep in sync) ───
// [u32 payloadLen BE][u8 type][u32 streamId BE][payload]
export const FRAME = {
  HELLO: 1, HELLO_OK: 2, HELLO_ERR: 3, OPEN: 4, DATA: 5, CLOSE: 6, PING: 7, PONG: 8,
  // Proof-of-possession: the relay challenges, the daemon signs.
  CHALLENGE: 9, PROOF: 10,
};
const HEADER_LEN = 9;
const MAX_FRAME = 1024 * 1024;

export function encodeFrame(type, streamId, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt32BE(body.length, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32BE(streamId >>> 0, 5);
  return Buffer.concat([header, body]);
}

/** Incremental frame reader. feed(chunk) → array of {type, streamId, payload}. */
export function frameReader() {
  let buffered = Buffer.alloc(0);
  return function feed(chunk) {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    const frames = [];
    for (;;) {
      if (buffered.length < HEADER_LEN) break;
      const len = buffered.readUInt32BE(0);
      if (len > MAX_FRAME) throw new Error('relay: frame exceeds MAX_FRAME');
      if (buffered.length < HEADER_LEN + len) break;
      frames.push({
        type: buffered.readUInt8(4),
        streamId: buffered.readUInt32BE(5),
        payload: buffered.subarray(HEADER_LEN, HEADER_LEN + len),
      });
      buffered = buffered.subarray(HEADER_LEN + len);
    }
    return frames;
  };
}

// ─── ClientHello SNI parsing (no TLS termination) ───────────────────────────

/**
 * Extracts the SNI hostname from accumulated ClientHello bytes.
 * Returns { sni } when parsed, { need: true } when more bytes are required,
 * or { bad: true } when this is not parseable as a TLS ClientHello.
 */
export function parseSni(buffered) {
  // Concatenate handshake fragments across TLS records (rare but legal).
  let offset = 0;
  let handshake = Buffer.alloc(0);
  for (;;) {
    if (buffered.length < offset + 5) return handshakeSni(handshake) ?? { need: true };
    const contentType = buffered.readUInt8(offset);
    if (contentType !== 0x16) return { bad: true }; // not a handshake record
    const recordLen = buffered.readUInt16BE(offset + 3);
    if (buffered.length < offset + 5 + recordLen) return handshakeSni(handshake) ?? { need: true };
    handshake = Buffer.concat([handshake, buffered.subarray(offset + 5, offset + 5 + recordLen)]);
    offset += 5 + recordLen;
    const result = handshakeSni(handshake);
    if (result) return result;
    if (offset >= buffered.length) return { need: true };
  }
}

function handshakeSni(handshake) {
  if (handshake.length < 4) return null;
  if (handshake.readUInt8(0) !== 0x01) return { bad: true }; // not ClientHello
  const helloLen = handshake.readUIntBE(1, 3);
  if (handshake.length < 4 + helloLen) return null; // need more records
  const hello = handshake.subarray(4, 4 + helloLen);
  try {
    let p = 2 + 32; // legacy_version + random
    const sessionIdLen = hello.readUInt8(p); p += 1 + sessionIdLen;
    const cipherLen = hello.readUInt16BE(p); p += 2 + cipherLen;
    const compLen = hello.readUInt8(p); p += 1 + compLen;
    if (p + 2 > hello.length) return { sni: null };
    const extTotal = hello.readUInt16BE(p); p += 2;
    const extEnd = Math.min(p + extTotal, hello.length);
    while (p + 4 <= extEnd) {
      const extType = hello.readUInt16BE(p);
      const extLen = hello.readUInt16BE(p + 2);
      p += 4;
      if (extType === 0x0000 && extLen >= 5) {
        // server_name list: u16 listLen, u8 nameType(0), u16 nameLen, name
        const nameLen = hello.readUInt16BE(p + 3);
        return { sni: hello.subarray(p + 5, p + 5 + nameLen).toString('utf8').toLowerCase() };
      }
      p += extLen;
    }
    return { sni: null };
  } catch {
    return { bad: true };
  }
}

// ─── claims (TOFU) ──────────────────────────────────────────────────────────

function claimStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'claims.json');
  const load = () => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
  };
  return {
    /** true when pairId is unclaimed or the token matches the stored hash. */
    verify(pairId, token) {
      const claims = load();
      const hash = createHash('sha256').update(token).digest('hex');
      const existing = claims[pairId];
      if (!existing) {
        claims[pairId] = hash;
        writeFileSync(file, JSON.stringify(claims, null, 2));
        return true;
      }
      const a = Buffer.from(existing, 'hex');
      const b = Buffer.from(hash, 'hex');
      return a.length === b.length && timingSafeEqual(a, b);
    },
  };
}

// ─── relay core ─────────────────────────────────────────────────────────────

const PAIR_ID_RE = /^[a-z0-9]{8,64}$/;
const HELLO_TIMEOUT_MS = 10_000;
const SNI_TIMEOUT_MS = 5_000;
const SNI_MAX_BUFFER = 64 * 1024;
const PING_INTERVAL_MS = 30_000;
const PONG_DEADLINE_MS = 90_000;

export function startRelay(opts) {
  const { port, baseDomain, tlsKeyPem, tlsCertPem, dataDir, log = console } = opts;
  const base = baseDomain.toLowerCase();
  const claims = claimStore(dataDir);
  /** pairId → tunnel { socket, feed, streams: Map<streamId, phoneSocket>, nextStreamId, lastPong } */
  const tunnels = new Map();

  function attachTunnel(rawTlsSocket, pairId) {
    const existing = tunnels.get(pairId);
    if (existing) existing.socket.destroy();
    const tunnel = {
      socket: rawTlsSocket,
      streams: new Map(),
      nextStreamId: 1,
      lastPong: Date.now(),
      feed: frameReader(),
    };
    tunnels.set(pairId, tunnel);

    rawTlsSocket.on('data', (chunk) => {
      let frames;
      try { frames = tunnel.feed(chunk); } catch (err) {
        log.error(`relay: tunnel ${pairId} framing error: ${err.message}`);
        rawTlsSocket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.type === FRAME.DATA) {
          const phone = tunnel.streams.get(frame.streamId);
          if (phone && !phone.destroyed) {
            const ok = phone.write(frame.payload);
            if (!ok) { rawTlsSocket.pause(); phone.once('drain', () => rawTlsSocket.resume()); }
          }
        } else if (frame.type === FRAME.CLOSE) {
          const phone = tunnel.streams.get(frame.streamId);
          tunnel.streams.delete(frame.streamId);
          if (phone) phone.destroy();
        } else if (frame.type === FRAME.PONG) {
          tunnel.lastPong = Date.now();
        } else if (frame.type === FRAME.PING) {
          rawTlsSocket.write(encodeFrame(FRAME.PONG, 0));
        }
      }
    });
    const drop = () => {
      if (tunnels.get(pairId) === tunnel) tunnels.delete(pairId);
      for (const phone of tunnel.streams.values()) phone.destroy();
      tunnel.streams.clear();
    };
    rawTlsSocket.on('close', drop);
    rawTlsSocket.on('error', () => rawTlsSocket.destroy());
    log.info(`relay: tunnel registered for ${pairId}`);
  }

  /**
   * Wraps a raw socket in a duplex that replays already-sniffed bytes first.
   * Necessary because tls.TLSSocket over a net.Socket reads the kernel handle
   * directly — bytes consumed while parsing SNI (and merely unshift()ed back
   * into the JS stream buffer) would be invisible to the handshake.
   */
  function replayedSocket(rawSocket, buffered) {
    const duplex = new Duplex({
      read() { rawSocket.resume(); },
      write(chunk, _enc, cb) { rawSocket.write(chunk, cb); },
      final(cb) { rawSocket.end(); cb(); },
      destroy(err, cb) { rawSocket.destroy(); cb(err); },
    });
    if (buffered.length) duplex.push(buffered);
    rawSocket.on('data', (chunk) => { if (!duplex.push(chunk)) rawSocket.pause(); });
    rawSocket.on('end', () => duplex.push(null));
    rawSocket.on('error', (err) => duplex.destroy(err));
    rawSocket.on('close', () => duplex.destroy());
    return duplex;
  }

  /**
   * Registration, with proof that the caller owns the address it claims.
   *
   * A tunnel address is `sha256(daemon certificate)` truncated — and that
   * certificate's fingerprint is printed in every pairing QR. So with a
   * first-come claim, anyone who had ever seen a user's QR could register
   * their address first and lock the real Mac out permanently.
   *
   * The fix is to make the address unclaimable without the private key: the
   * relay sends a random challenge, the daemon returns its certificate plus a
   * signature over that challenge, and the relay checks that (a) the
   * certificate hashes to the claimed address and (b) the signature verifies
   * against that certificate's public key. Squatting now requires the key,
   * which never leaves the user's Mac.
   */
  function handleTunnelLeg(rawSocket, buffered) {
    const tlsSocket = new tls.TLSSocket(replayedSocket(rawSocket, buffered), {
      isServer: true,
      secureContext: tls.createSecureContext({
        key: tlsKeyPem,
        cert: tlsCertPem,
        // The control leg is our own code on both ends, so there is no legacy
        // client to accommodate and no reason to accept anything older.
        minVersion: 'TLSv1.3',
      }),
    });
    const feed = frameReader();
    let stage = 'hello';
    let pendingPairId = null;
    let pendingToken = '';
    const nonce = randomBytes(32).toString('base64url');
    const helloTimer = setTimeout(() => { if (stage !== 'done') tlsSocket.destroy(); }, HELLO_TIMEOUT_MS);

    const refuse = (error) => {
      tlsSocket.write(encodeFrame(FRAME.HELLO_ERR, 0, JSON.stringify({ error })));
      tlsSocket.destroy();
    };

    const onData = (chunk) => {
      let frames;
      try { frames = feed(chunk); } catch { tlsSocket.destroy(); return; }
      for (const frame of frames) {
        if (stage === 'hello') {
          if (frame.type !== FRAME.HELLO) { tlsSocket.destroy(); return; }
          let hello;
          try { hello = JSON.parse(frame.payload.toString('utf8')); } catch { tlsSocket.destroy(); return; }
          const pairId = String(hello.pairId ?? '').toLowerCase();
          const token = String(hello.authToken ?? '');
          if (!PAIR_ID_RE.test(pairId) || token.length < 16) { refuse('BAD_HELLO'); return; }
          pendingPairId = pairId;
          pendingToken = token;
          stage = 'proof';
          tlsSocket.write(encodeFrame(FRAME.CHALLENGE, 0, JSON.stringify({ nonce })));
          continue;
        }
        if (stage === 'proof') {
          if (frame.type !== FRAME.PROOF) { tlsSocket.destroy(); return; }
          let proof;
          try { proof = JSON.parse(frame.payload.toString('utf8')); } catch { tlsSocket.destroy(); return; }
          if (!verifyPossession(pendingPairId, nonce, proof)) {
            log.warn(`relay: possession proof failed for ${pendingPairId}`);
            refuse('BAD_PROOF');
            return;
          }
          if (!claims.verify(pendingPairId, pendingToken)) {
            log.warn(`relay: rejected HELLO for claimed pairId ${pendingPairId}`);
            refuse('CLAIMED');
            return;
          }
          stage = 'done';
          clearTimeout(helloTimer);
          tlsSocket.removeListener('data', onData);
          tlsSocket.write(encodeFrame(FRAME.HELLO_OK, 0, JSON.stringify({ ok: true })));
          attachTunnel(tlsSocket, pendingPairId);
          return;
        }
      }
    };
    tlsSocket.on('data', onData);
    tlsSocket.on('error', () => tlsSocket.destroy());
  }

  /**
   * True when `proof` shows the caller holds the private key for the
   * certificate whose hash is `pairId`.
   */
  function verifyPossession(pairId, nonce, proof) {
    try {
      const certPem = String(proof?.certPem ?? '');
      const signature = String(proof?.signature ?? '');
      if (!certPem || !signature) return false;
      const cert = new X509Certificate(certPem);
      // (a) the certificate really is the one this address names
      const derived = createHash('sha256').update(cert.raw).digest('hex').slice(0, 16);
      if (derived !== pairId) return false;
      // (b) the caller can sign for it. `cert.publicKey` is already a
      // KeyObject — re-wrapping it throws INVALID_KEY_OBJECT_TYPE.
      return createVerify('sha256')
        .update(nonce)
        .verify(cert.publicKey, Buffer.from(signature, 'base64url'));
    } catch {
      return false;
    }
  }

  function handlePhoneLeg(rawSocket, pairId, buffered) {
    const tunnel = tunnels.get(pairId);
    if (!tunnel || tunnel.socket.destroyed) {
      rawSocket.destroy(); // daemon offline — phone falls back / retries
      return;
    }
    const streamId = tunnel.nextStreamId++;
    tunnel.streams.set(streamId, rawSocket);
    // Normalize IPv4-mapped IPv6 so rate-limit buckets are stable per host.
    const ip = (rawSocket.remoteAddress ?? '').replace(/^::ffff:/i, '');
    tunnel.socket.write(encodeFrame(FRAME.OPEN, streamId, JSON.stringify({ ip })));
    // Replay the ClientHello bytes we consumed while sniffing SNI, then pipe.
    if (buffered.length) tunnel.socket.write(encodeFrame(FRAME.DATA, streamId, buffered));
    rawSocket.on('data', (chunk) => {
      const ok = tunnel.socket.write(encodeFrame(FRAME.DATA, streamId, chunk));
      if (!ok) { rawSocket.pause(); tunnel.socket.once('drain', () => rawSocket.resume()); }
    });
    const closeStream = () => {
      if (tunnel.streams.get(streamId) === rawSocket) {
        tunnel.streams.delete(streamId);
        if (!tunnel.socket.destroyed) tunnel.socket.write(encodeFrame(FRAME.CLOSE, streamId));
      }
    };
    rawSocket.on('close', closeStream);
    rawSocket.on('error', () => rawSocket.destroy());
  }

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    let buffered = Buffer.alloc(0);
    const sniTimer = setTimeout(() => socket.destroy(), SNI_TIMEOUT_MS);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > SNI_MAX_BUFFER) { clearTimeout(sniTimer); socket.destroy(); return; }
      const parsed = parseSni(buffered);
      if (parsed.need) return;
      clearTimeout(sniTimer);
      socket.removeListener('data', onData);
      if (parsed.bad || !parsed.sni || !parsed.sni.endsWith(`.${base}`)) {
        socket.destroy();
        return;
      }
      const label = parsed.sni.slice(0, -(base.length + 1));
      if (label === 'tunnel') {
        handleTunnelLeg(socket, buffered);
      } else if (PAIR_ID_RE.test(label)) {
        handlePhoneLeg(socket, label, buffered);
      } else {
        socket.destroy();
      }
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [pairId, tunnel] of tunnels) {
      if (now - tunnel.lastPong > PONG_DEADLINE_MS) {
        log.warn(`relay: tunnel ${pairId} missed heartbeat; dropping`);
        tunnel.socket.destroy();
      } else if (!tunnel.socket.destroyed) {
        tunnel.socket.write(encodeFrame(FRAME.PING, 0));
      }
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const bound = server.address().port;
      log.info(`relay: listening on :${bound} for *.${base}`);
      resolve({
        port: bound,
        tunnelCount: () => tunnels.size,
        close: () => new Promise((done) => {
          clearInterval(heartbeat);
          for (const tunnel of tunnels.values()) tunnel.socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

// ─── CLI entry ──────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const env = process.env;
  const readMaterial = (inline, file, label) => {
    if (env[inline]) return env[inline].replace(/\\n/g, '\n');
    if (env[file] && existsSync(env[file])) return readFileSync(env[file], 'utf8');
    throw new Error(`relay: ${label} missing — set ${inline} or ${file}`);
  };
  const baseDomain = env.RELAY_BASE_DOMAIN;
  if (!baseDomain) throw new Error('relay: RELAY_BASE_DOMAIN is required');
  startRelay({
    port: Number(env.PORT ?? 9400),
    baseDomain,
    tlsKeyPem: readMaterial('RELAY_TLS_KEY_PEM', 'RELAY_TLS_KEY_FILE', 'TLS key'),
    tlsCertPem: readMaterial('RELAY_TLS_CERT_PEM', 'RELAY_TLS_CERT_FILE', 'TLS cert'),
    dataDir: env.RELAY_DATA_DIR ?? './data',
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
