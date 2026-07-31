/**
 * Outbound relay tunnel — how a paired phone reaches this daemon off-LAN.
 *
 * The daemon dials OUT to the relay (no inbound ports anywhere) over TLS,
 * pinned to the relay certificate's fingerprint from config, and registers
 * its pairId with an auth token minted once and persisted. Phone connections
 * arrive back as multiplexed streams of raw TLS bytes — the phone's pinned
 * handshake with THIS Mac's certificate passes through untouched — and are
 * piped into the loopback relay listener (mobile-ingress.ts), which
 * classifies them 'relay' and restores the relay-observed client IP for
 * rate limiting.
 *
 * The relay can therefore deny service, never read or forge traffic. See
 * apps/relay/server.mjs for the other side; the mux framing here mirrors it
 * byte-for-byte and the E2E test pins the pair.
 *
 * Supervision copies mobile-bonjour.ts: exponential backoff 2s→60s, reset on
 * a successful registration, stop() safe against respawn races. A missing or
 * unreachable relay degrades to LAN-only — never daemon-fatal.
 */
import net from 'node:net';
import tls from 'node:tls';
import { createHash, createSign, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { pemCertToDer } from './mobile-tls.js';
import { registerRelayStreamPeer, unregisterRelayStreamPeer } from './mobile-ingress.js';
import { readLeaseRecord } from '../licensing/lease-store.js';

const logger = pino({ name: 'clementine-next.mobile-relay' });

// ─── mux framing (mirrors apps/relay/server.mjs — keep in sync) ─────────────
// [u32 payloadLen BE][u8 type][u32 streamId BE][payload]
export const FRAME = {
  HELLO: 1, HELLO_OK: 2, HELLO_ERR: 3, OPEN: 4, DATA: 5, CLOSE: 6, PING: 7, PONG: 8,
  /** Proof-of-possession: the relay challenges, this daemon signs. */
  CHALLENGE: 9, PROOF: 10,
} as const;
const HEADER_LEN = 9;
const MAX_FRAME = 1024 * 1024;

export interface RelayFrame {
  type: number;
  streamId: number;
  payload: Buffer;
}

export function encodeFrame(type: number, streamId: number, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt32BE(body.length, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32BE(streamId >>> 0, 5);
  return Buffer.concat([header, body]);
}

export function frameReader(): (chunk: Buffer) => RelayFrame[] {
  let buffered: Buffer = Buffer.alloc(0);
  return (chunk: Buffer): RelayFrame[] => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    const frames: RelayFrame[] = [];
    for (;;) {
      if (buffered.length < HEADER_LEN) break;
      const len = buffered.readUInt32BE(0);
      if (len > MAX_FRAME) throw new Error('mobile-relay: frame exceeds MAX_FRAME');
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

// ─── config ─────────────────────────────────────────────────────────────────

export interface MobileRelayConfig {
  /** Relay TCP endpoint, e.g. "abc.proxy.rlwy.net:30123". */
  url: string;
  /** SNI base domain the relay demuxes on, e.g. "r.example.com". */
  baseDomain: string;
  /** base64url(SHA-256(relay cert DER)) — the daemon-side pin. */
  relayCertFp: string;
}

interface PersistedRelayState {
  authToken?: string;
  /** Optional relay endpoint config — same meaning as the CLEMENTINE_RELAY_* envs.
   *  The packaged app owns the daemon and cannot practically inject env vars,
   *  so file config is the production path; env wins when both are present. */
  url?: string;
  baseDomain?: string;
  relayCertFp?: string;
}

function relayStatePath(stateDir?: string): string {
  return path.join(stateDir ?? path.join(BASE_DIR, 'state'), 'mobile-relay.json');
}

function readRelayState(stateDir?: string): PersistedRelayState {
  const file = relayStatePath(stateDir);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PersistedRelayState;
  } catch {
    return {};
  }
}

/** The per-pairing relay auth token, minted once and persisted (0600). */
export function ensureRelayAuthToken(stateDir?: string): string {
  const state = readRelayState(stateDir);
  if (typeof state.authToken === 'string' && state.authToken.length >= 16) return state.authToken;
  const authToken = randomBytes(32).toString('base64url');
  const file = relayStatePath(stateDir);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Merge rather than replace: the same file may carry endpoint config.
  writeFileSync(file, JSON.stringify({ ...state, authToken } satisfies PersistedRelayState, null, 2), { mode: 0o600 });
  return authToken;
}

/**
 * The DNS label a pairing routes on: lowercase hex of the mobile cert's
 * SHA-256, truncated. Hex (not base64url) because DNS is case-insensitive.
 */
export function relayPairId(certPem: string): string {
  return createHash('sha256').update(pemCertToDer(certPem)).digest('hex').slice(0, 16);
}

/** Reads relay config from env. Null = relay not configured (LAN-only). */
export function relayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MobileRelayConfig | null {
  if ((env.CLEMENTINE_MOBILE_RELAY ?? '').toLowerCase() === 'off') return null;
  const url = env.CLEMENTINE_RELAY_URL?.trim();
  const baseDomain = env.CLEMENTINE_RELAY_BASE?.trim();
  const relayCertFp = env.CLEMENTINE_RELAY_CERT_FP?.trim();
  if (!url || !baseDomain || !relayCertFp) return null;
  return { url, baseDomain, relayCertFp };
}

/**
 * The production loader: env config wins (dev/testing), else the persisted
 * state file (how the packaged, app-owned daemon is configured). The kill
 * switch applies to both sources.
 */
export function loadRelayConfig(stateDir?: string, env: NodeJS.ProcessEnv = process.env): MobileRelayConfig | null {
  if ((env.CLEMENTINE_MOBILE_RELAY ?? '').toLowerCase() === 'off') return null;
  const fromEnv = relayConfigFromEnv(env);
  if (fromEnv) return fromEnv;
  const state = readRelayState(stateDir);
  const url = state.url?.trim();
  const baseDomain = state.baseDomain?.trim();
  const relayCertFp = state.relayCertFp?.trim();
  if (!url || !baseDomain || !relayCertFp) return null;
  return { url, baseDomain, relayCertFp };
}

// ─── relay runtime registry ─────────────────────────────────────────────────
//
// Mirrors the direct-app runtime registry in mobile-ingress.ts: the mobile
// router needs to tell an already-paired phone where the relay door is
// (GET /m/relay-info), and only the boot wiring knows. Plain module state —
// set once when the tunnel starts.

export interface MobileRelayRuntime {
  /** The origin the phone should use off-LAN, e.g. "https://<pairId>.r.example.com:53028". */
  origin: string;
}

let relayRuntime: MobileRelayRuntime | null = null;

export function setMobileRelayRuntime(runtime: MobileRelayRuntime | null): void {
  relayRuntime = runtime;
}

export function getMobileRelayRuntime(): MobileRelayRuntime | null {
  return relayRuntime;
}

// ─── the supervised tunnel ──────────────────────────────────────────────────

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60_000;

export interface MobileRelayClient {
  stop(): void;
  /** Test seam: resolves once the current connection is registered. */
  connected(): boolean;
}

export interface StartRelayClientOptions {
  config: MobileRelayConfig;
  pairId: string;
  authToken: string;
  /** The loopback relay listener's port (startRelayInternalListener). */
  localPort: number;
  /** The mobile TLS identity — proves this Mac owns the address it claims. */
  certPem: string;
  keyPem: string;
  logger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

export function startMobileRelayClient(opts: StartRelayClientOptions): MobileRelayClient {
  const log = opts.logger ?? logger;
  const [host, portRaw] = opts.config.url.split(':');
  const relayPort = Number(portRaw);
  if (!host || !Number.isFinite(relayPort)) {
    log.warn({ url: opts.config.url }, 'mobile-relay: invalid relay URL; tunnel disabled');
    return { stop: () => {}, connected: () => false };
  }

  let stopped = false;
  let backoffMs = RECONNECT_BASE_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let isConnected = false;
  let activeSocket: tls.TLSSocket | null = null;
  let activeStreams = new Map<number, net.Socket>();

  function scheduleReconnect(): void {
    if (stopped) return;
    reconnectTimer = setTimeout(connect, backoffMs);
    reconnectTimer.unref();
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
  }

  function connect(): void {
    if (stopped) return;
    const socket = tls.connect({
      host,
      port: relayPort,
      servername: `tunnel.${opts.config.baseDomain}`,
      // The relay cert is self-signed on purpose; the pin below is the trust.
      rejectUnauthorized: false,
    });
    activeSocket = socket;
    const streams = new Map<number, net.Socket>();
    activeStreams = streams;
    const feed = frameReader();

    socket.on('secureConnect', () => {
      const peerDer = socket.getPeerCertificate()?.raw;
      const fp = peerDer ? createHash('sha256').update(peerDer).digest('base64url') : '';
      if (fp !== opts.config.relayCertFp) {
        log.error({ expected: opts.config.relayCertFp, got: fp }, 'mobile-relay: relay certificate pin mismatch — refusing');
        socket.destroy();
        return;
      }
      // The lease rides along so the relay can verify licensing offline. Absent
        // is fine while the relay is in observation mode.
        let lease: string | undefined;
        try { lease = readLeaseRecord().leaseCompact; } catch { lease = undefined; }
        socket.write(encodeFrame(FRAME.HELLO, 0, JSON.stringify({
          pairId: opts.pairId, authToken: opts.authToken, proto: 1, lease,
        })));
    });

    socket.on('data', (chunk: Buffer) => {
      let frames: RelayFrame[];
      try {
        frames = feed(chunk);
      } catch (err) {
        log.error({ err }, 'mobile-relay: framing error; reconnecting');
        socket.destroy();
        return;
      }
      for (const frame of frames) handleFrame(frame);
    });

    function handleFrame(frame: RelayFrame): void {
      if (frame.type === FRAME.CHALLENGE) {
        // Prove we hold the key for the certificate this address is derived
        // from. Without this a stranger who had seen our QR could claim the
        // address first and lock this Mac out of its own tunnel.
        let nonce = '';
        try {
          nonce = String((JSON.parse(frame.payload.toString('utf8')) as { nonce?: string }).nonce ?? '');
        } catch { /* handled by the empty check below */ }
        if (!nonce) {
          log.error('mobile-relay: relay sent no challenge nonce');
          socket.destroy();
          return;
        }
        try {
          const signature = createSign('sha256').update(nonce).sign(opts.keyPem).toString('base64url');
          socket.write(encodeFrame(FRAME.PROOF, 0, JSON.stringify({ certPem: opts.certPem, signature })));
        } catch (err) {
          log.error({ err }, 'mobile-relay: could not sign the relay challenge');
          socket.destroy();
        }
        return;
      }
      if (frame.type === FRAME.HELLO_OK) {
        isConnected = true;
        backoffMs = RECONNECT_BASE_MS;
        log.info({ pairId: opts.pairId, relay: opts.config.url }, 'mobile-relay: tunnel registered');
        return;
      }
      if (frame.type === FRAME.HELLO_ERR) {
        const body = frame.payload.toString('utf8');
        log.error({ body }, 'mobile-relay: relay refused registration');
        // A licensing refusal will not resolve by retrying in two seconds, so
        // stop hammering: go straight to the maximum backoff and let the
        // license tick fix the cause.
        if (body.includes('LICENSE_')) backoffMs = RECONNECT_MAX_MS;
        socket.destroy();
        return;
      }
      if (frame.type === FRAME.PING) {
        socket.write(encodeFrame(FRAME.PONG, 0));
        return;
      }
      if (frame.type === FRAME.OPEN) {
        let clientIp = '';
        try {
          clientIp = String((JSON.parse(frame.payload.toString('utf8')) as { ip?: string }).ip ?? '');
        } catch { /* ip stays unknown */ }
        openStream(frame.streamId, clientIp);
        return;
      }
      const local = streams.get(frame.streamId);
      if (frame.type === FRAME.DATA) {
        if (local) {
          const pending = (local as unknown as { __clemPending?: Buffer[] }).__clemPending;
          if (pending) pending.push(frame.payload);
          else {
            const ok = local.write(frame.payload);
            if (!ok) {
              socket.pause();
              local.once('drain', () => socket.resume());
            }
          }
        }
        return;
      }
      if (frame.type === FRAME.CLOSE) {
        streams.delete(frame.streamId);
        if (local) local.destroy();
      }
    }

    function openStream(streamId: number, clientIp: string): void {
      const local = net.connect(opts.localPort, '127.0.0.1');
      // DATA can arrive before the local connect completes; queue until then.
      (local as unknown as { __clemPending?: Buffer[] }).__clemPending = [];
      streams.set(streamId, local);
      local.on('connect', () => {
        const localPort = local.localPort;
        if (typeof localPort === 'number' && clientIp) registerRelayStreamPeer(localPort, clientIp);
        const holder = local as unknown as { __clemPending?: Buffer[] };
        for (const buffered of holder.__clemPending ?? []) local.write(buffered);
        holder.__clemPending = undefined;
      });
      local.on('data', (data: Buffer) => {
        if (socket.destroyed) return;
        const ok = socket.write(encodeFrame(FRAME.DATA, streamId, data));
        if (!ok) {
          local.pause();
          socket.once('drain', () => local.resume());
        }
      });
      local.on('close', () => {
        const localPort = local.localPort;
        if (typeof localPort === 'number') unregisterRelayStreamPeer(localPort);
        if (streams.get(streamId) === local) {
          streams.delete(streamId);
          if (!socket.destroyed) socket.write(encodeFrame(FRAME.CLOSE, streamId));
        }
      });
      local.on('error', () => local.destroy());
    }

    const dropAll = (): void => {
      if (isConnected) log.warn('mobile-relay: tunnel lost; reconnecting with backoff');
      isConnected = false;
      for (const local of streams.values()) local.destroy();
      streams.clear();
      scheduleReconnect();
    };
    socket.once('close', dropAll);
    socket.on('error', (err) => {
      log.warn({ err: err.message }, 'mobile-relay: connection error');
      socket.destroy();
    });
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const local of activeStreams.values()) local.destroy();
      activeSocket?.destroy();
    },
    connected: () => isConnected,
  };
}
