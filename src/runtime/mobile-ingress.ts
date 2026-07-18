/**
 * Ingress classification — how we know a request really arrived through our
 * own Cloudflare tunnel rather than being crafted by anyone who can reach the
 * loopback port.
 *
 * The problem this solves: rate limiting for the mobile surface is keyed on the
 * caller's IP, and behind the tunnel the socket peer is always cloudflared on
 * loopback. So the real client IP has to come from Cloudflare's
 * `CF-Connecting-IP` header. But a header is only trustworthy if you know who
 * set it, and previously we believed it unconditionally — the old comment in
 * `clientIp()` said "the only path to /m/* is via the tunnel", which nothing
 * enforced. Any local process (or anything reaching a LAN-bound daemon) could
 * rotate that header per request and mint a fresh rate-limit bucket every time,
 * defeating the per-IP lockout entirely.
 *
 * Why a second listener rather than a shared-secret header: cloudflared cannot
 * inject an arbitrary custom header on the origin request. The only header knob
 * it exposes is `originRequest.httpHostHeader`, which overwrites Host — and we
 * need Host intact to serve the right surface. So instead of asking the request
 * to prove where it came from, we give the tunnel its own private door: a second
 * HTTP listener on an ephemeral loopback port whose number is only ever handed
 * to the cloudflared process we spawned. Arriving on that socket IS the proof.
 * It is unforgeable from the public internet, needs no Cloudflare feature, and
 * degrades to a plain fact about which fd accepted the connection.
 *
 * Three classifications:
 *   'tunnel'        — arrived on the private tunnel listener. Trust CF headers.
 *                     Restricted to /m/* by the socket it came in on.
 *   'tunnel-legacy' — arrived on the main listener, but Host matches the
 *                     configured tunnel hostname. This is a user running their
 *                     own cloudflared from ~/.cloudflared/config.yml pointed at
 *                     the main port. Same /m/* restriction and same CF-header
 *                     trust as before this change, so nobody breaks; we log a
 *                     one-time nudge to re-point at the private port.
 *   'loopback'      — everything else. Full surface, CF headers IGNORED.
 */
import http from 'node:http';
import type { Express, Request, Response, NextFunction } from 'express';
import pino from 'pino';
import { readMobileAccess } from './mobile-access-state.js';
import { normalizeHostHeader } from './http-origin-guard.js';

const logger = pino({ name: 'clementine-next.mobile-ingress' });

export type ClemIngress = 'loopback' | 'tunnel' | 'tunnel-legacy';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by classifyIngress(); never trust a client to supply this. */
      clemIngress?: ClemIngress;
    }
  }
}

/**
 * Marker planted on the raw IncomingMessage by the tunnel listener before the
 * Express app ever sees the request. A Symbol so no request body, query, or
 * header can collide with it.
 */
const TUNNEL_SOCKET = Symbol('clem.tunnelSocket');

export interface IngressListeners {
  main: http.Server;
  tunnel: http.Server | null;
  /** Loopback port to point cloudflared at. Null when the tunnel door is off. */
  tunnelPort: number | null;
  close(): Promise<void>;
}

/** `CLEMENTINE_MOBILE_INGRESS=shared` reverts to a single listener. */
export function ingressSplitEnabled(): boolean {
  return (process.env.CLEMENTINE_MOBILE_INGRESS ?? '').trim().toLowerCase() !== 'shared';
}

function isConfiguredMobileHost(req: Request): boolean {
  const host = normalizeHostHeader(req.headers.host);
  if (!host) return false;
  const mobileHost = readMobileAccess().tunnel?.hostname?.trim().toLowerCase() ?? '';
  return Boolean(mobileHost && host === mobileHost);
}

let warnedLegacyIngress = false;

/**
 * Stamps req.clemIngress. Must be mounted before anything that reads the
 * client IP or decides which surface to serve.
 */
export function classifyIngress(req: Request, _res: Response, next: NextFunction): void {
  const raw = req as unknown as Record<symbol, unknown>;
  if (raw[TUNNEL_SOCKET] === true) {
    req.clemIngress = 'tunnel';
    next();
    return;
  }
  if (isConfiguredMobileHost(req)) {
    req.clemIngress = 'tunnel-legacy';
    if (!warnedLegacyIngress) {
      warnedLegacyIngress = true;
      logger.warn(
        { host: normalizeHostHeader(req.headers.host) },
        'Mobile tunnel traffic arrived on the main listener. An externally-managed '
        + 'cloudflared is pointed at the shared port; restart the tunnel from Clementine '
        + 'so it uses the private ingress port instead.',
      );
    }
    next();
    return;
  }
  req.clemIngress = 'loopback';
  next();
}

/**
 * Restricts tunnel-borne traffic to the mobile surface.
 *
 * This supersedes the Host-header-based requireMobileSurfaceForMobileHost as
 * the primary rule: for real tunnel traffic the restriction now follows from
 * which socket accepted the connection, which a caller cannot influence.
 */
export function restrictTunnelIngressToMobile(req: Request, res: Response, next: NextFunction): void {
  if (req.clemIngress !== 'tunnel' && req.clemIngress !== 'tunnel-legacy') {
    next();
    return;
  }
  if (req.path === '/m' || req.path.startsWith('/m/')) {
    next();
    return;
  }
  res.status(404).type('text/plain').send('Not found');
}

/**
 * True when CF-Connecting-IP on this request may be believed.
 *
 * Only tunnel-borne requests qualify. On the loopback door the header is
 * attacker-controlled and must be ignored.
 */
export function trustsForwardedClientIp(req: Request): boolean {
  return req.clemIngress === 'tunnel' || req.clemIngress === 'tunnel-legacy';
}

/**
 * Binds the main listener plus (unless disabled) the private tunnel listener,
 * both serving the same Express app.
 *
 * The caller supplies `guardMainBind` so the existing LAN double-gate
 * (WEBHOOK_ALLOW_LAN + strong secret) stays exactly where it was and keeps
 * applying only to the publicly-bindable listener. The tunnel listener is
 * always loopback + ephemeral, so it needs no such gate.
 */
export async function startIngressListeners(
  app: Express,
  opts: {
    host: string;
    port: number;
    guardMainBind?: () => void;
    enableTunnelListener?: boolean;
  },
): Promise<IngressListeners> {
  const wantTunnel = opts.enableTunnelListener ?? ingressSplitEnabled();

  const main = await new Promise<http.Server>((resolve, reject) => {
    try {
      opts.guardMainBind?.();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });

  let tunnel: http.Server | null = null;
  let tunnelPort: number | null = null;
  if (wantTunnel) {
    try {
      tunnel = await new Promise<http.Server>((resolve, reject) => {
        const server = http.createServer((req, res) => {
          (req as unknown as Record<symbol, unknown>)[TUNNEL_SOCKET] = true;
          app(req as never, res as never);
        });
        server.once('error', reject);
        // Port 0 = kernel-assigned ephemeral. Loopback only, always.
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve(server);
        });
      });
      const addr = tunnel.address();
      tunnelPort = addr && typeof addr === 'object' ? addr.port : null;
      logger.info({ tunnelPort }, 'Private mobile ingress listener bound');
    } catch (err) {
      // A failed private door must never take the daemon down; fall back to the
      // shared listener, which is exactly the pre-change behavior.
      logger.warn({ err }, 'Private mobile ingress listener failed to bind; using shared listener');
      tunnel = null;
      tunnelPort = null;
    }
  }

  return {
    main,
    tunnel,
    tunnelPort,
    async close() {
      await Promise.all(
        [main, tunnel].filter((s): s is http.Server => Boolean(s)).map(
          (s) => new Promise<void>((resolve) => s.close(() => resolve())),
        ),
      );
    },
  };
}

/** Test seam — resets the once-per-process legacy-ingress warning. */
export function resetIngressWarningsForTests(): void {
  warnedLegacyIngress = false;
}
