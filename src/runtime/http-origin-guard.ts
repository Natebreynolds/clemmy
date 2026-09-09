/**
 * Host allowlist + same-origin enforcement for the daemon's HTTP surface.
 *
 * The gap this closes is DNS rebinding. An attacker publishes evil.example with a
 * very short TTL, gets the victim's browser to load a page from it, then re-answers
 * the next lookup with 127.0.0.1. The browser now believes requests to
 * `http://evil.example:8420` are same-origin with the attacker's page, so it will
 * happily send them AND let the page read the responses — the same-origin policy
 * is satisfied because the *name* never changed. Those requests reach the daemon
 * carrying `Host: evil.example`.
 *
 * Unknown *names* are rejected outright with 421.
 *
 * IP literals are deliberately allowed. Rebinding fundamentally requires a
 * hostname — it works by changing what a name resolves to. A page cannot cause
 * the browser to treat `http://192.168.1.5:8420` as same-origin with itself
 * unless it was already served from that origin. Rejecting IP literals would
 * therefore buy no security while breaking every LAN user who reaches a
 * WEBHOOK_ALLOW_LAN daemon by address.
 */
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Request, Response, NextFunction } from 'express';
import { WEBHOOK_HOST } from '../config.js';

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
 * Hosts registered at runtime by subsystems that legitimately answer for a
 * name we cannot know statically — today the mobile relay, whose hostname is
 * `<pairId>.<relay base>` and only exists once relay config is loaded. Kept
 * additive and process-local; nothing request-controlled can reach it.
 */
const runtimeAllowedHosts = new Set<string>();

export function allowHostName(hostname: string): void {
  const normalized = normalizeHostHeader(hostname);
  if (normalized) runtimeAllowedHosts.add(normalized);
}

/** Builds the allowlist fresh on every call — env-driven entries stay live. */
export function buildAllowedHostNames(): Set<string> {
  const allowed = new Set<string>(LOOPBACK_NAMES);
  const configured = normalizeHostHeader(WEBHOOK_HOST);
  if (configured && !net.isIP(configured) && configured !== '0.0.0.0') allowed.add(configured);
  for (const extra of extraAllowedHosts()) allowed.add(extra);
  for (const runtime of runtimeAllowedHosts) allowed.add(runtime);
  return allowed;
}

export function isAllowedHost(host: string): boolean {
  if (!host) return false;
  // IP literals cannot be a rebinding vector — see the module header.
  if (net.isIP(host) !== 0) return true;
  return buildAllowedHostNames().has(host);
}

/**
 * The addresses this machine actually answers on.
 *
 * Read fresh per call rather than cached: a laptop changes networks constantly,
 * and a stale list would refuse a legitimate LAN origin after a DHCP move.
 */
function localAddresses(): Set<string> {
  const out = new Set<string>(['127.0.0.1', '::1']);
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        // Node reports link-local v6 with a zone suffix (fe80::1%en0) that a
        // browser never puts in an Origin, so compare on the bare address.
        out.add(entry.address.toLowerCase().split('%')[0]);
      }
    }
  } catch {
    /* an interface enumeration failure must not open the door, only narrow it */
  }
  return out;
}

/**
 * Whether an ORIGIN header names an origin this daemon serves.
 *
 * THE DEFECT THIS EXISTS TO FIX. `isAllowedHost` answers "could this Host
 * header be a rebinding attack?", and its IP-literal shortcut is right for that
 * question: a name is what rebinding changes. The CSRF check reused the same
 * predicate to answer a DIFFERENT question — "did this request come from a page
 * I serve?" — and there the shortcut is a hole. Any page on any bare IP
 * (`http://198.51.100.7/`) sends `Origin: http://198.51.100.7`, passes, and the
 * one explicit CSRF layer under a SameSite=Lax cookie is gone.
 *
 * So an IP origin is admitted only when it is an address this machine is
 * actually reachable at. Two consequences worth naming: the old predicate also
 * REFUSED every IPv6 literal by accident (URL.hostname keeps the brackets, so
 * net.isIP saw `[::1]` and returned 0), which broke legitimate v6 LAN clients —
 * normalizing here fixes that in the same move.
 */
export function isAllowedOrigin(originHost: string): boolean {
  if (!originHost) return false;
  // A BARE IPv6 literal must be recognised before normalizing. normalizeHostHeader
  // strips a trailing `:<digits>` as a port, which is right for a Host header
  // (where IPv6 is always bracketed) and wrong for `::1`, whose last group it
  // eats. Test the raw value first so both spellings reach the same answer.
  const raw = originHost.trim().toLowerCase();
  const host = net.isIP(raw) !== 0 ? raw : normalizeHostHeader(originHost);
  if (!host) return false;
  if (net.isIP(host) !== 0) return localAddresses().has(host);
  return buildAllowedHostNames().has(host);
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
      // URL.hostname keeps IPv6 brackets; normalizeHostHeader strips them, so
      // `http://[::1]:8520` is judged on `::1` rather than being refused.
      originHost = normalizeHostHeader(new URL(origin).hostname);
    } catch {
      originHost = '';
    }
    if (!originHost || !isAllowedOrigin(originHost)) {
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
