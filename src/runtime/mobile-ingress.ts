/**
 * Ingress classification — how we know a request really arrived through the
 * pinned-TLS door the iOS app connects to, rather than being crafted by
 * anyone who can reach the loopback port.
 *
 * The proof is the socket, not a header: the direct-app door is its own HTTPS
 * listener, and arriving on that socket IS the classification. It is
 * unforgeable from the outside and degrades to a plain fact about which fd
 * accepted the connection.
 *
 * Two classifications:
 *   'loopback'   — the main listener. Full surface.
 *   'direct-app' — arrived on the pinned-TLS listener the iOS app connects
 *                  to directly. Restricted to /m/* by socket. The socket peer
 *                  IS the client, so the real IP needs no forwarding header.
 */
import http from 'node:http';
import https from 'node:https';
import type { Express, Request, Response, NextFunction } from 'express';
import pino from 'pino';

const logger = pino({ name: 'clementine-next.mobile-ingress' });

export type ClemIngress = 'loopback' | 'direct-app';

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
 * Marker planted on the raw IncomingMessage by the direct-app listener before
 * the Express app ever sees the request. A Symbol so no request body, query,
 * or header can collide with it.
 */
const DIRECT_APP_SOCKET = Symbol('clem.directAppSocket');

export interface DirectAppListenerOptions {
  /** 0 = kernel-assigned; the bound port is reported in `directAppPort`. */
  port: number;
  keyPem: string;
  certPem: string;
  /** Defaults to all interfaces — the phone reaches this door over the LAN. */
  host?: string;
}

export interface IngressListeners {
  main: http.Server;
  directApp: https.Server | null;
  /** LAN-reachable TLS port the iOS app connects to. Null when the door is off. */
  directAppPort: number | null;
  close(): Promise<void>;
}

/**
 * Stamps req.clemIngress. Must be mounted before anything that reads the
 * client IP or decides which surface to serve.
 */
export function classifyIngress(req: Request, _res: Response, next: NextFunction): void {
  const raw = req as unknown as Record<symbol, unknown>;
  if (raw[DIRECT_APP_SOCKET] === true) {
    req.clemIngress = 'direct-app';
    next();
    return;
  }
  req.clemIngress = 'loopback';
  next();
}

/**
 * Restricts direct-app traffic to the mobile surface. The restriction follows
 * from which socket accepted the connection, which a caller cannot influence.
 */
export function restrictDirectAppIngressToMobile(req: Request, res: Response, next: NextFunction): void {
  if (req.clemIngress !== 'direct-app') {
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
 * Binds the main listener plus (when configured) the pinned-TLS direct-app
 * door, both serving the same Express app.
 *
 * The caller supplies `guardMainBind` so the existing LAN double-gate
 * (WEBHOOK_ALLOW_LAN + strong secret) stays exactly where it was and keeps
 * applying only to the publicly-bindable listener.
 */
export async function startIngressListeners(
  app: Express,
  opts: {
    host: string;
    port: number;
    guardMainBind?: () => void;
    /**
     * When present, opens the pinned-TLS door for the iOS app. Serves only
     * /m/* (enforced by restrictDirectAppIngressToMobile via socket marker),
     * so unlike the main listener it carries no admin surface and needs no
     * LAN double-gate — the mobile surface brings its own auth: PIN,
     * device-bound sessions, scoped rate limits, default-deny routes.
     */
    directApp?: DirectAppListenerOptions;
  },
): Promise<IngressListeners> {
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

  let directApp: https.Server | null = null;
  let directAppPort: number | null = null;
  if (opts.directApp) {
    try {
      const conf = opts.directApp;
      directApp = await new Promise<https.Server>((resolve, reject) => {
        const server = https.createServer({ key: conf.keyPem, cert: conf.certPem }, (req, res) => {
          (req as unknown as Record<symbol, unknown>)[DIRECT_APP_SOCKET] = true;
          app(req as never, res as never);
        });
        server.once('error', reject);
        server.listen(conf.port, conf.host ?? '0.0.0.0', () => {
          server.removeListener('error', reject);
          resolve(server);
        });
      });
      const addr = directApp.address();
      directAppPort = addr && typeof addr === 'object' ? addr.port : null;
      logger.info({ directAppPort }, 'Direct-app pinned-TLS listener bound');
    } catch (err) {
      // A failed optional ingress never takes the daemon down; the app door
      // just stays closed until the next boot.
      logger.warn({ err }, 'Direct-app pinned-TLS listener failed to bind');
      directApp = null;
      directAppPort = null;
    }
  }

  return {
    main,
    directApp,
    directAppPort,
    async close() {
      await Promise.all(
        [main, directApp].filter((s): s is http.Server | https.Server => Boolean(s)).map(
          (s) => new Promise<void>((resolve) => s.close(() => resolve())),
        ),
      );
    },
  };
}

// ─── direct-app runtime registry ────────────────────────────────────
//
// QR generation (console process = this process) needs to know whether the
// pinned-TLS door is open, on which port, and with which cert fingerprint.
// Plain module state: the door binds once at boot and never moves.

export interface DirectAppRuntime {
  port: number;
  /** base64url(SHA-256(cert DER)) — rides in the pairing QR as `fp`. */
  fingerprint: string;
}

let directAppRuntime: DirectAppRuntime | null = null;

export function setDirectAppRuntime(runtime: DirectAppRuntime | null): void {
  directAppRuntime = runtime;
}

export function getDirectAppRuntime(): DirectAppRuntime | null {
  return directAppRuntime;
}
