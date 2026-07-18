/**
 * Host allowlist + same-origin enforcement for the daemon's HTTP surface.
 *
 * The gap this closes is DNS rebinding. An attacker publishes evil.com with a
 * very short TTL, gets the victim's browser to load a page from it, then re-answers
 * the next lookup with 127.0.0.1. The browser now believes requests to
 * `http://evil.com:8420` are same-origin with the attacker's page, so it will
 * happily send them AND let the page read the responses — the same-origin policy
 * is satisfied because the *name* never changed. Those requests reach the daemon
 * carrying `Host: evil.com`.
 *
 * Previously the only Host check was requireMobileSurfaceForMobileHost, which
 * asks "is this the configured tunnel hostname?" — an allowlist of exactly one
 * name, used to *restrict* that name to /m/*. Any other Host, including a
 * rebound attacker name, fell straight through to the full /api/* surface.
 *
 * So we invert it: unknown *names* are rejected outright with 421.
 *
 * IP literals are deliberately allowed. Rebinding fundamentally requires a
 * hostname — it works by changing what a name resolves to. A page cannot cause
 * the browser to treat `http://192.168.1.5:8420` as same-origin with itself
 * unless it was already served from that origin. Rejecting IP literals would
 * therefore buy no security while breaking every LAN user who reaches a
 * WEBHOOK_ALLOW_LAN daemon by address.
 */
import net from 'node:net';
import type { Request, Response, NextFunction } from 'express';
import { WEBHOOK_HOST } from '../config.js';
import { readMobileAccess } from './mobile-access-state.js';

/**
 * Lowercases a Host header and strips the port and any IPv6 brackets.
 *
 * Moved here from webhook.ts so the guard and the ingress classifier share one
 * implementation rather than drifting apart.
 */
export function normalizeHostHeader(value: unknown): string {
  if (typeof value !== 'string') return '';
  const first = value.split(',')[0]?.trim().toLowerCase() ?? '';
  if (!first) return '';
  if (first.startsWith('[')) {
    const end = first.indexOf(']');
    return end >= 0 ? first.slice(1, end) : first.replace(/^\[/, '');
  }
  return first.replace(/:\d+$/, '');
}

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost']);

function extraAllowedHosts(): string[] {
  return (process.env.CLEMENTINE_EXTRA_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => normalizeHostHeader(entry))
    .filter(Boolean);
}

/**
 * Builds the allowlist fresh on every call.
 *
 * Deliberately uncached: a quick tunnel gets a NEW hostname every time
 * cloudflared restarts, and a cached set would 421 the user's own phone the
 * moment the tunnel rotated. The read is a small JSON file behind the
 * mobile-access state module, not a network call.
 */
export function buildAllowedHostNames(opts?: { hostname?: string | null }): Set<string> {
  const allowed = new Set<string>(LOOPBACK_NAMES);
  const configured = normalizeHostHeader(WEBHOOK_HOST);
  if (configured && !net.isIP(configured) && configured !== '0.0.0.0') allowed.add(configured);
  const tunnelHost = opts?.hostname === undefined
    ? readMobileAccess().tunnel?.hostname
    : opts.hostname;
  const normalizedTunnel = normalizeHostHeader(tunnelHost);
  if (normalizedTunnel) allowed.add(normalizedTunnel);
  for (const extra of extraAllowedHosts()) allowed.add(extra);
  return allowed;
}

export function isAllowedHost(host: string, opts?: { hostname?: string | null }): boolean {
  if (!host) return false;
  // IP literals cannot be a rebinding vector — see the module header.
  if (net.isIP(host) !== 0) return true;
  return buildAllowedHostNames(opts).has(host);
}

/**
 * Rejects requests whose Host header names a host we do not serve.
 *
 * 421 Misdirected Request is the semantically correct status: the request
 * reached a server that is not configured to answer for that authority.
 */
export function hostAllowlistMiddleware(req: Request, res: Response, next: NextFunction): void {
  const host = normalizeHostHeader(req.headers.host);
  // A missing Host is legal in HTTP/1.0 and used by some local health probes.
  // Those are loopback-only by construction, so allow rather than break them.
  if (!host) {
    next();
    return;
  }
  if (isAllowedHost(host)) {
    next();
    return;
  }
  res.status(421).type('text/plain').send('Misdirected request');
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF backstop for state-changing requests.
 *
 * The mobile session cookie is SameSite=Lax rather than Strict, deliberately:
 * Strict breaks the scan-to-pair flow, where the phone's camera app performs a
 * top-level navigation to the pairing URL and the cookie must survive it. Lax
 * already blocks cross-site POSTs in current browsers, but that is a single
 * layer resting entirely on browser behavior, so this adds an explicit one.
 */
export function requireSameOriginForMutations(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin && origin !== 'null') {
    let originHost = '';
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      originHost = '';
    }
    if (!originHost || !isAllowedHost(originHost)) {
      res.status(403).type('text/plain').send('Cross-origin request refused');
      return;
    }
    next();
    return;
  }
  // No Origin header. Modern browsers always send one on cross-origin
  // mutations, so its absence means either a same-origin form post or a
  // non-browser client (CLI, curl, the desktop app). Fetch metadata
  // disambiguates when present; when absent we allow, because non-browser
  // clients are not subject to CSRF and still need a credential.
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    res.status(403).type('text/plain').send('Cross-origin request refused');
    return;
  }
  next();
}
