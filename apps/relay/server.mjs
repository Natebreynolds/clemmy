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
 * by anyone else. The auth token is noted only as a record of which token last
 * registered an address — never as a veto over the key (see registrationRecord).
 *
 * What is NOT defended: registration is open to any self-signed certificate,
 * because this design has no enrollment authority to check one against. Every
 * limit below is therefore an AVAILABILITY control — it bounds what an
 * unauthenticated stranger can make the relay allocate on someone else's
 * behalf. It does not, and cannot here, decide who is allowed to register.
 *
 * The relay keeps NOTHING across a restart — no database, no state file. It
 * does not need to: the address is proven by the certificate key on every
 * registration, so there is nothing a restart could forget that would let the
 * wrong Mac in. Everything below lives in memory and is bounded there.
 *
 * Zero runtime dependencies. Configuration (env):
 *   PORT                — listen port (Railway injects this)
 *   RELAY_BASE_DOMAIN   — e.g. r.example.com  (SNI suffix to demux on)
 *   RELAY_TLS_KEY_PEM / RELAY_TLS_CERT_PEM — PEM material for the tunnel leg
 *     (or RELAY_TLS_KEY_FILE / RELAY_TLS_CERT_FILE paths)
 */
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { createHash, timingSafeEqual, randomBytes, createVerify, X509Certificate } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
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
  // Every read below is a length-prefixed walk over attacker-controlled bytes.
  // Buffer's read* throw when they run off the end, so the try is the general
  // bounds check; the explicit checks are for the two reads that would NOT
  // throw — subarray silently CLAMPS, so a truncated name would otherwise be
  // routed as a short hostname the peer never actually sent.
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
      if (p + extLen > extEnd) return { bad: true }; // extension runs off the block
      if (extType === 0x0000 && extLen >= 5) {
        // server_name list: u16 listLen, u8 nameType(0), u16 nameLen, name
        const nameLen = hello.readUInt16BE(p + 3);
        if (5 + nameLen > extLen) return { bad: true };
        return { sni: hello.subarray(p + 5, p + 5 + nameLen).toString('utf8').toLowerCase() };
      }
      p += extLen;
    }
    return { sni: null };
  } catch {
    return { bad: true };
  }
}

// ─── the registration record (operator forensics, nothing else) ─────────────

/** How many registrations the record remembers. Bounds it; gates nothing. */
const MAX_REGISTRATIONS = 5_000;

/**
 * pairId → sha256 of the auth token that last registered it, IN MEMORY ONLY.
 *
 * Read this for what it is: one log line. The only thing anything does with a
 * record here is print "rebound to a new auth token" when a proven daemon
 * arrives under a different token than last time, which is a hint for an
 * operator reading logs. Nothing consults it to decide anything, ever.
 *
 * It used to be a gate, and that was the bug: the first token to reach an
 * address owned it forever, checked AFTER the possession proof — so the weaker
 * credential vetoed the stronger one, and a daemon whose state dir was
 * restored or migrated (new token, same certificate key) was locked out of its
 * own address permanently. The certificate key is what makes an address
 * unclaimable; a valid proof rebinds the token rather than being refused by it.
 *
 * It also used to be written to `claims.json`, with a retention window, a
 * debounced atomic rename and an eviction pass — durability machinery around a
 * value nothing reads. That is gone with the file. What is left is the one
 * property this still owes: registration is open to any self-signed
 * certificate, so the record must not let unbounded registration mean
 * unbounded memory. It is capped, oldest-registration-first. Falling out of
 * the record is not a lockout and not a loss — the next proof re-creates it,
 * and after a restart the record is empty, so `new` here means "not seen since
 * this relay started", never "never registered".
 */
function registrationRecord({ maxEntries = MAX_REGISTRATIONS } = {}) {
  const seen = new Map();
  return {
    /**
     * Records a registration that has ALREADY proven possession of the
     * address's certificate key. Returns 'new', 'match', or 'rebound' — the
     * caller logs a rebind, it never refuses one.
     */
    note(pairId, token) {
      const hash = createHash('sha256').update(token).digest('hex');
      const existing = seen.get(pairId);
      // Delete first so the re-insert moves this pairId to the end: Map keeps
      // insertion order, which makes the eviction below a plain oldest-first
      // walk instead of a sort of the whole record on every registration.
      seen.delete(pairId);
      seen.set(pairId, hash);
      for (const oldest of seen.keys()) {
        if (seen.size <= maxEntries) break;
        seen.delete(oldest);
      }
      if (!existing) return 'new';
      const a = Buffer.from(existing, 'hex');
      const b = Buffer.from(hash, 'hex');
      return a.length === b.length && timingSafeEqual(a, b) ? 'match' : 'rebound';
    },
    size: () => seen.size,
  };
}

// ─── relay core ─────────────────────────────────────────────────────────────

const PAIR_ID_RE = /^[a-z0-9]{8,64}$/;
const HELLO_TIMEOUT_MS = 10_000;
const SNI_TIMEOUT_MS = 5_000;
const SNI_MAX_BUFFER = 64 * 1024;
const PING_INTERVAL_MS = 30_000;
const PONG_DEADLINE_MS = 90_000;
// A daemon that PINGs us in a loop would otherwise get a PONG per PING for
// free. The relay's own heartbeat is one PING per tunnel per 30 s, so one
// reply per second is three orders of magnitude more than the protocol needs.
const MIN_PONG_INTERVAL_MS = 1_000;

// ─── availability limits ────────────────────────────────────────────────────
//
// The phone leg is reached from the SNI label alone: no TLS handshake has
// completed and no credential has been presented when handlePhoneLeg runs. So
// every allocation it makes on a stranger's behalf — a stream id, an entry in
// tunnel.streams, an OPEN frame that makes the victim's daemon dial a local
// socket — has to be capped, or the relay is a socket amplifier pointed at
// whichever Mac's pairId the attacker names.
//
// The numbers are sized off real use, not off the attack. A phone holds one
// long-lived SSE stream plus whatever fetches are in flight; HTTP/1.1 clients
// open at most ~6 connections per origin, so a phone in heavy use sits under 8.
//
// What "per source address" means here, precisely: `socket.remoteAddress` is
// the address of whatever TCP peer connected to THIS listener. Deployed behind
// a TCP proxy (Railway terminates the client connection and dials us), that is
// the proxy's address for every phone and every daemon alike — one bucket for
// the whole world, not one per household. So the per-source stream cap is only
// a real per-source control on a directly-attached listener; behind a proxy it
// silently becomes a second, lower per-tunnel cap (48 concurrent streams to one
// Mac) and `maxStreamsPerTunnel` never binds. Both numbers are chosen to be
// defensible read either way, and nothing below is allowed to REFUSE a proven
// daemon on the strength of this address — see makeRoomForTunnel.
const DEFAULT_LIMITS = Object.freeze({
  /** Streams one tunnel may hold open at once, across every source. */
  maxStreamsPerTunnel: 128,
  /** Streams one source address may hold in one tunnel (see the note above). */
  maxStreamsPerIp: 48,
  /** Registered tunnels. Bounds `tunnels` against unbounded registration. */
  maxTunnels: 256,
  /**
   * Tunnel legs one source address may hold before it is the first to lose one
   * at capacity. A share, not a refusal: crossing it never turns anyone away,
   * it only decides whose slot is taken when the table is full.
   */
  maxTunnelsPerIp: 32,
  /** Sockets on the listener, tunnel legs included — the aggregate backstop. */
  maxConnections: 4096,
  /**
   * How long a spliced phone socket may wait for the DAEMON'S first byte back
   * before it is dropped. Armed at splice, cleared by the first byte the daemon
   * sends down this stream — never by anything the peer sends us. Clearing on
   * either direction (what this used to do) let a single junk byte disarm it,
   * so a peer could hold a stream slot, a tunnel map entry and a live local
   * socket on the victim's Mac for as long as TCP survived; `setKeepAlive`
   * reaps a peer that VANISHED, not one that is present and mute. It is still
   * deliberately NOT a rolling idle timer — an SSE stream is legitimately quiet
   * for minutes once it has been answered, and reaping those would break
   * exactly the feature the phone comes here for.
   */
  phoneFirstByteMs: 30_000,
});
// One cap-refusal line per tunnel per minute. A log write per refused socket
// would make the log itself the amplification the cap exists to prevent.
const CAP_LOG_INTERVAL_MS = 60_000;

/** Normalizes IPv4-mapped IPv6 so rate-limit buckets are stable per host. */
function normalizeIp(remoteAddress) {
  return (remoteAddress ?? '').replace(/^::ffff:/i, '');
}

/**
 * Picks a free stream id for `tunnel`, wrapping the u32 counter explicitly.
 * The counter used to only ever increment: `encodeFrame` masks it with `>>> 0`,
 * so past 2^32 a new stream would silently alias a live one and cross two
 * phones' bytes together. Wrapping means the counter can land on an id that is
 * still open, so the walk skips live ids. Callers have already checked the
 * per-tunnel cap, so a free id exists; `maxAttempts` only keeps the search
 * finite. Module scope, not a closure over `limits`, so it can be tested at
 * the wrap without seeding a live relay's counter.
 */
export function allocateStreamId(tunnel, maxAttempts) {
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    const candidate = tunnel.nextStreamId;
    tunnel.nextStreamId = tunnel.nextStreamId >= 0xffffffff ? 1 : tunnel.nextStreamId + 1;
    if (!tunnel.streams.has(candidate)) return candidate;
  }
  return null;
}

export function startRelay(opts) {
  const {
    port, baseDomain, tlsKeyPem, tlsCertPem, log = console,
    // Overridable so tests can prove a cap with three sockets instead of a
    // hundred, and so a self-hoster can size a bigger box. Defaults are the
    // shipped behaviour — there is no flag to turn any of this on.
    limits: limitOverrides, recordOptions,
  } = opts;
  const base = baseDomain.toLowerCase();
  const limits = { ...DEFAULT_LIMITS, ...(limitOverrides ?? {}) };
  const registrations = registrationRecord(recordOptions ?? {});
  /**
   * pairId → tunnel {
   *   socket, ip, feed, nextStreamId, lastPong, lastStreamAt, pauses,
   *   streams: Map<streamId, { socket, ip, release, answered }>,
   *   streamsByIp: Map<ip, count>,
   * }
   */
  const tunnels = new Map();

  function attachTunnel(rawTlsSocket, pairId, sourceIp) {
    const existing = tunnels.get(pairId);
    if (existing) existing.socket.destroy();
    const tunnel = {
      socket: rawTlsSocket,
      /** Where this leg dialled from — see the note above DEFAULT_LIMITS. */
      ip: sourceIp,
      streams: new Map(),
      /** source address → how many of `streams` it holds. Per-IP cap bucket. */
      streamsByIp: new Map(),
      nextStreamId: 1,
      lastPong: Date.now(),
      /**
       * When this tunnel last carried a phone; registration counts as the
       * first. It is the eviction key, so it deliberately does NOT move on a
       * PONG: every tunnel answers the heartbeat, including a squatter's, and
       * an eviction order that treats "still breathing" as "still useful"
       * cannot tell them apart.
       */
      lastStreamAt: Date.now(),
      /** How many congested streams are currently holding this tunnel paused. */
      pauses: 0,
      lastPongSentAt: 0,
      lastCapLogAt: 0,
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
          const stream = tunnel.streams.get(frame.streamId);
          if (stream && !stream.socket.destroyed) {
            // THE daemon answered this stream: the deadline's whole question.
            stream.answered();
            const ok = stream.socket.write(frame.payload);
            // Resume on 'close' as well as 'drain': a phone that dies while
            // the tunnel is paused for it would otherwise wedge the tunnel —
            // and with it every OTHER stream on the same Mac — permanently.
            // Each resume unsubscribes BOTH, or the never-fired sibling
            // accumulates on a long-lived socket. The count is what makes two
            // congested phones safe: one draining must not un-pause the tunnel
            // while the other is still backed up.
            if (!ok) {
              tunnel.pauses += 1;
              rawTlsSocket.pause();
              const resume = () => {
                stream.socket.off('drain', resume);
                stream.socket.off('close', resume);
                tunnel.pauses -= 1;
                if (tunnel.pauses === 0) rawTlsSocket.resume();
              };
              stream.socket.once('drain', resume);
              stream.socket.once('close', resume);
            }
          }
        } else if (frame.type === FRAME.CLOSE) {
          const stream = tunnel.streams.get(frame.streamId);
          // Release before destroy so the socket's own 'close' does not echo
          // a CLOSE back for the CLOSE the daemon just sent us.
          if (stream) { stream.release({ notifyTunnel: false }); stream.socket.destroy(); }
        } else if (frame.type === FRAME.PONG) {
          tunnel.lastPong = Date.now();
        } else if (frame.type === FRAME.PING) {
          const now = Date.now();
          if (now - tunnel.lastPongSentAt >= MIN_PONG_INTERVAL_MS) {
            tunnel.lastPongSentAt = now;
            rawTlsSocket.write(encodeFrame(FRAME.PONG, 0));
          }
        }
      }
    });
    const drop = () => {
      if (tunnels.get(pairId) === tunnel) tunnels.delete(pairId);
      for (const stream of tunnel.streams.values()) stream.socket.destroy();
      tunnel.streams.clear();
      tunnel.streamsByIp.clear();
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
   *
   * The auth token is noted, never enforced — see registrationRecord for why a
   * stale token must not veto a good proof.
   */
  function handleTunnelLeg(rawSocket, buffered) {
    const sourceIp = normalizeIp(rawSocket.remoteAddress);
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
          // Registering a NEW address costs a tunnel slot; re-registering one
          // we already hold does not. Without this bound, unbounded
          // registration is unbounded memory, since anyone can mint a
          // certificate to prove. With a bound and no eviction it was worse
          // than unbounded — see makeRoomForTunnel.
          if (!tunnels.has(pendingPairId) && tunnels.size >= limits.maxTunnels
              && !makeRoomForTunnel(sourceIp)) {
            log.warn(`relay: at capacity (${tunnels.size} tunnels, all carrying streams); refused ${pendingPairId}`);
            refuse('AT_CAPACITY');
            return;
          }
          // The token is a record, not a veto. It used to be able to refuse a
          // daemon that had just proven possession of the certificate key —
          // so a restored or migrated state dir locked a Mac out of its own
          // address for good. The stronger credential wins; the token rebinds.
          const binding = registrations.note(pendingPairId, pendingToken);
          if (binding === 'rebound') {
            log.warn(`relay: ${pendingPairId} rebound to a new auth token on a valid possession proof`);
          }
          stage = 'done';
          clearTimeout(helloTimer);
          tlsSocket.removeListener('data', onData);
          tlsSocket.write(encodeFrame(FRAME.HELLO_OK, 0, JSON.stringify({ ok: true })));
          attachTunnel(tlsSocket, pendingPairId, sourceIp);
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

  /**
   * Frees one tunnel slot for a newly proven address, or reports that there is
   * nothing to free. Returns true when a slot was taken.
   *
   * A hard refusal at the cap was the worse failure. Registration is open to
   * any self-signed certificate, so 256 minted certs on 256 idle sockets —
   * one `openssl` loop — would hold every slot, and from then on every genuine
   * Mac that reconnected would be refused. That trades an expensive, temporary
   * memory DoS for a cheap, permanent lockout of the real user.
   *
   * So the relay takes a squatter's slot rather than turning the newcomer away
   * whenever it holds one that is not doing any work. A tunnel with zero open
   * streams is carrying no phone, and its daemon reconnects on its own; the
   * least recently used of those goes first. Failing that, a source address
   * holding more than its share of the whole table loses its own least
   * recently used leg, so one host cannot fill the relay — and since that
   * address may be a proxy's (see DEFAULT_LIMITS), this share can only ever
   * choose a victim, never refuse a caller. Behind a proxy every leg shares one
   * address, so the share is always crossed and this degenerates to plain LRU
   * eviction at capacity: churn, deliberately, in preference to lockout.
   *
   * Only when every tunnel is carrying live streams AND no source is over its
   * share is there nothing to take. AT_CAPACITY then says something true: the
   * relay is full of work, not full of squatters.
   */
  function makeRoomForTunnel(newcomerIp) {
    const legsByIp = new Map();
    let idle = null;
    for (const entry of tunnels) {
      const tunnel = entry[1];
      legsByIp.set(tunnel.ip, (legsByIp.get(tunnel.ip) ?? 0) + 1);
      if (tunnel.streams.size > 0) continue;
      if (!idle || tunnel.lastStreamAt < idle[1].lastStreamAt) idle = entry;
    }
    let overShare = null;
    if (!idle) {
      for (const entry of tunnels) {
        const tunnel = entry[1];
        if ((legsByIp.get(tunnel.ip) ?? 0) <= limits.maxTunnelsPerIp) continue;
        if (!overShare || tunnel.lastStreamAt < overShare[1].lastStreamAt) overShare = entry;
      }
    }
    const victim = idle ?? overShare;
    if (!victim) return false;
    const [victimId, tunnel] = victim;
    log.warn(
      `relay: at capacity (${tunnels.size} tunnels); evicting ${victimId} `
      + `(${idle ? 'no open streams' : `source over its ${limits.maxTunnelsPerIp}-leg share`}) `
      + `to admit a newly proven address from ${newcomerIp}`,
    );
    // Delete before destroy: `drop` only clears the map when it still owns the
    // entry, so the slot is free for the newcomer either way.
    tunnels.delete(victimId);
    tunnel.socket.destroy();
    return true;
  }

  /** Logs a cap refusal at most once per tunnel per CAP_LOG_INTERVAL_MS. */
  function logCapRefusal(tunnel, pairId, reason) {
    const now = Date.now();
    if (now - tunnel.lastCapLogAt < CAP_LOG_INTERVAL_MS) return;
    tunnel.lastCapLogAt = now;
    log.warn(`relay: refusing phone streams for ${pairId} — ${reason} (${tunnel.streams.size} open)`);
  }

  function handlePhoneLeg(rawSocket, pairId, buffered) {
    const tunnel = tunnels.get(pairId);
    if (!tunnel || tunnel.socket.destroyed) {
      rawSocket.destroy(); // daemon offline — phone falls back / retries
      return;
    }
    const ip = normalizeIp(rawSocket.remoteAddress);
    // Caps FIRST. Everything below allocates on behalf of a peer that has
    // presented nothing but an SNI label — a stream id, a map entry, and an
    // OPEN frame that makes the named Mac dial one of its own local sockets.
    if (tunnel.streams.size >= limits.maxStreamsPerTunnel) {
      logCapRefusal(tunnel, pairId, 'tunnel stream cap reached');
      rawSocket.destroy();
      return;
    }
    if ((tunnel.streamsByIp.get(ip) ?? 0) >= limits.maxStreamsPerIp) {
      logCapRefusal(tunnel, pairId, `per-source cap reached for ${ip}`);
      rawSocket.destroy();
      return;
    }
    const streamId = allocateStreamId(tunnel, limits.maxStreamsPerTunnel);
    if (streamId === null) {
      logCapRefusal(tunnel, pairId, 'no free stream id');
      rawSocket.destroy();
      return;
    }

    // A peer that opens a stream and is never answered holds this slot, and a
    // local socket on the victim's Mac, for as long as the TCP connection
    // survives. Only the daemon's first byte back clears this: whatever the
    // peer sends us proves nothing — it is the side that would be lying. A
    // real TLS handshake gets its answer within a round trip.
    let answerDeadline = setTimeout(() => {
      answerDeadline = null;
      rawSocket.destroy();
    }, limits.phoneFirstByteMs);
    answerDeadline.unref?.();
    const answered = () => {
      if (!answerDeadline) return;
      clearTimeout(answerDeadline);
      answerDeadline = null;
    };

    let released = false;
    const release = ({ notifyTunnel }) => {
      if (released) return;
      released = true;
      answered();
      if (tunnel.streams.get(streamId) === stream) tunnel.streams.delete(streamId);
      const held = (tunnel.streamsByIp.get(ip) ?? 1) - 1;
      if (held > 0) tunnel.streamsByIp.set(ip, held);
      else tunnel.streamsByIp.delete(ip);
      if (notifyTunnel && !tunnel.socket.destroyed) {
        tunnel.socket.write(encodeFrame(FRAME.CLOSE, streamId));
      }
    };
    const stream = { socket: rawSocket, ip, release, answered };
    tunnel.streams.set(streamId, stream);
    tunnel.streamsByIp.set(ip, (tunnel.streamsByIp.get(ip) ?? 0) + 1);
    // This tunnel is carrying a phone right now; it is not an eviction target.
    tunnel.lastStreamAt = Date.now();
    // A phone that vanishes (airplane mode, dead battery) leaves a half-open
    // socket that no application byte will ever close. Let the OS reap it so
    // the stream slot comes back without waiting for the tunnel to drop.
    rawSocket.setKeepAlive(true, 60_000);

    tunnel.socket.write(encodeFrame(FRAME.OPEN, streamId, JSON.stringify({ ip })));
    // Replay the ClientHello bytes we consumed while sniffing SNI, then pipe.
    if (buffered.length) tunnel.socket.write(encodeFrame(FRAME.DATA, streamId, buffered));
    rawSocket.on('data', (chunk) => {
      // Deliberately NOT clearing the answer deadline: bytes from the peer are
      // the thing the deadline exists to be unimpressed by.
      const ok = tunnel.socket.write(encodeFrame(FRAME.DATA, streamId, chunk));
      // Same pairing as the tunnel→phone direction above: resume on either
      // event, and unsubscribe both so nothing piles up on the tunnel socket.
      if (!ok) {
        rawSocket.pause();
        const resume = () => {
          tunnel.socket.off('drain', resume);
          tunnel.socket.off('close', resume);
          rawSocket.resume();
        };
        tunnel.socket.once('drain', resume);
        tunnel.socket.once('close', resume);
      }
    });
    // Every terminal path releases the slot. 'error' destroys, which emits
    // 'close', but registering both keeps the release independent of that
    // ordering — `released` makes the second call a no-op.
    rawSocket.on('close', () => release({ notifyTunnel: true }));
    rawSocket.on('error', () => { release({ notifyTunnel: true }); rawSocket.destroy(); });
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
  // The aggregate backstop, under every per-tunnel and per-source cap: Node
  // destroys anything past this before 'connection' is even emitted, so a
  // flood across many pairIds still cannot exhaust the relay's descriptors.
  server.maxConnections = limits.maxConnections;

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
      // The four counters are read-only observation, and exist because the
      // caps and the evictions are only assertable from outside the process by
      // looking at what the relay is actually holding.
      resolve({
        port: bound,
        tunnelCount: () => tunnels.size,
        streamCount: (pairId) => tunnels.get(pairId)?.streams.size ?? 0,
        hasTunnel: (pairId) => tunnels.has(pairId),
        registrationCount: () => registrations.size(),
        // Nothing is written anywhere, so shutdown has nothing to flush and a
        // kill -9 loses nothing a restart would have wanted.
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
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
