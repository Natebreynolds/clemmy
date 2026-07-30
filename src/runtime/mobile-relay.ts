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
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { pemCertToDer } from './mobile-tls.js';
import { registerRelayStreamPeer, unregisterRelayStreamPeer } from './mobile-ingress.js';

const logger = pino({ name: 'clementine-next.mobile-relay' });

// ─── mux framing (mirrors apps/relay/server.mjs — keep in sync) ─────────────
// [u32 payloadLen BE][u8 type][u32 streamId BE][payload]
export const FRAME = { HELLO: 1, HELLO_OK: 2, HELLO_ERR: 3, OPEN: 4, DATA: 5, CLOSE: 6, PING: 7, PONG: 8 } as const;
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
  authToken: string;
}

function relayStatePath(stateDir?: string): string {
  return path.join(stateDir ?? path.join(BASE_DIR, 'state'), 'mobile-relay.json');
}

/** The per-pairing relay auth token, minted once and persisted (0600). */
export function ensureRelayAuthToken(stateDir?: string): string {
  const file = relayStatePath(stateDir);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as PersistedRelayState;
      if (typeof parsed.authToken === 'string' && parsed.authToken.length >= 16) return parsed.authToken;
    } catch { /* fall through to re-mint */ }
  }
  const authToken = randomBytes(32).toString('base64url');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ authToken } satisfies PersistedRelayState, null, 2), { mode: 0o600 });
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
      socket.write(encodeFrame(FRAME.HELLO, 0, JSON.stringify({ pairId: opts.pairId, authToken: opts.authToken, proto: 1 })));
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
      if (frame.type === FRAME.HELLO_OK) {
        isConnected = true;
        backoffMs = RECONNECT_BASE_MS;
        log.info({ pairId: opts.pairId, relay: opts.config.url }, 'mobile-relay: tunnel registered');
        return;
      }
      if (frame.type === FRAME.HELLO_ERR) {
        log.error({ body: frame.payload.toString('utf8') }, 'mobile-relay: relay refused registration');
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
