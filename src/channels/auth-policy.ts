/**
 * Declarative auth policy for the daemon's HTTP surface.
 *
 * The problem: authorization is enforced by ~370 hand-written
 * `if (!isAuthorized(req)) return 401` statements scattered across
 * webhook.ts, console-routes.ts, space-routes.ts, and friends. Auditing
 * confirmed every one of them is currently correct — but correctness rests
 * entirely on the author of the next route remembering to add the line. A
 * route registered without it is silently public, and nothing fails.
 *
 * So we invert the default. Every request is classified against this table
 * before it reaches a handler, and ANYTHING THAT DOES NOT MATCH IS TREATED AS
 * ADMIN — denied without a credential. Adding a route now fails closed: it is
 * protected until someone deliberately classifies it otherwise, and
 * route-gating.test.ts fails CI if a reachable route has no entry at all.
 *
 * Only non-admin routes need listing here. That keeps the table short enough
 * to actually read, which is the point — the ~300 admin routes are covered by
 * the default and never need enumerating.
 *
 * The existing inline checks stay exactly where they are. This gate is an
 * additional layer, not a replacement, so a mis-classification here can only
 * over-deny (a visible, immediate break) rather than silently expose a route.
 * Collapsing the inline checks is a separate mechanical change to make once
 * this has baked.
 */
import type { Request, Response, NextFunction } from 'express';

export type Realm =
  /** No credential required. Must stay a short, deliberate list. */
  | 'public'
  /** WEBHOOK_SECRET bearer / ?token= / dashboard session cookie. */
  | 'admin'
  /** Mobile credential-establishing routes; they authenticate their own input. */
  | 'mobile-anon'
  /** Mobile session cookie; enforced by requireMobileSession in the router. */
  | 'mobile-session'
  /** Receiver verifies its own request signature (Slack/Discord style). */
  | 'signed-webhook';

export interface AuthPolicyRule {
  method: '*' | 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /**
   * Path pattern. `:param` matches exactly one segment; a trailing `**`
   * matches any remaining segments (including none).
   */
  pattern: string;
  realm: Realm;
  /** Why this route is not admin-gated. Required for every non-admin rule. */
  reason: string;
}

/**
 * Order matters — first match wins. Specific rules precede their wildcards.
 */
export const AUTH_POLICY: readonly AuthPolicyRule[] = [
  // ---- Liveness -----------------------------------------------------------
  {
    method: 'GET',
    pattern: '/api/status',
    realm: 'public',
    reason: 'Liveness probe. Returns only uptime and a timestamp; no state, no config.',
  },

  // ---- Console bootstrap + inert assets -----------------------------------
  {
    method: 'GET',
    pattern: '/console',
    realm: 'public',
    reason:
      'Token-to-cookie exchange handler runs first and calls next() when no token is '
      + 'present. The console HTML itself is served by an auth-gated handler downstream, '
      + 'so this must stay open or the bootstrap redirect breaks.',
  },
  {
    method: 'GET',
    pattern: '/console/assets/**',
    realm: 'public',
    reason: 'Content-hashed immutable build assets. No secrets, and the app they load is gated.',
  },
  {
    method: 'GET',
    pattern: '/console/vendor/**',
    realm: 'public',
    reason: 'Vendored third-party JS (cytoscape, 3d-force-graph). Inert public libraries.',
  },
  {
    method: 'GET',
    pattern: '/console/icon.png',
    realm: 'public',
    reason: 'Public branding asset.',
  },

  // ---- Mobile: establishing a credential ----------------------------------
  {
    method: 'GET',
    pattern: '/m/auth/status',
    realm: 'mobile-anon',
    reason:
      'Reports whether a PIN is configured and whether the CALLER OWN cookie is valid. '
      + 'Leaks no hash and no state about other devices; the PWA needs it before login.',
  },
  {
    method: 'POST',
    pattern: '/m/auth/login',
    realm: 'mobile-anon',
    reason: 'The PIN check IS the authentication. Guarded by the two-tier rate limiter.',
  },
  {
    method: 'POST',
    pattern: '/m/auth/pair',
    realm: 'mobile-anon',
    reason: 'Consuming a single-use 256-bit pairing token IS the authentication.',
  },
  {
    method: 'POST',
    pattern: '/m/auth/logout',
    realm: 'mobile-anon',
    reason: 'Clears the caller own cookie. Nothing to protect; must work with a dead session.',
  },
  {
    method: 'GET',
    pattern: '/m/push/vapid-key',
    realm: 'mobile-anon',
    reason: 'Returns the VAPID PUBLIC key, which is public by construction.',
  },

  // ---- Mobile: admin-only within the mobile router -------------------------
  // Listed explicitly rather than left to the default so the privilege boundary
  // is visible here: a mobile session must never be able to rotate its own PIN
  // or enumerate sessions.
  {
    method: '*',
    pattern: '/m/auth/rotate',
    realm: 'admin',
    reason: 'PIN rotation is a desktop-admin action; a mobile session must not self-elevate.',
  },
  {
    method: '*',
    pattern: '/m/auth/sessions',
    realm: 'admin',
    reason: 'Session enumeration is a desktop-admin action.',
  },

  // ---- Mobile: session-gated API ------------------------------------------
  {
    method: '*',
    pattern: '/m/api/**',
    realm: 'mobile-session',
    reason: 'Enforced by requireMobileSession inside the mobile router.',
  },
  {
    method: '*',
    pattern: '/m/push/subscribe',
    realm: 'mobile-session',
    reason: 'Enforced by requireMobileSession inside the mobile router.',
  },
  {
    method: '*',
    pattern: '/m/push/unsubscribe',
    realm: 'mobile-session',
    reason: 'Enforced by requireMobileSession inside the mobile router.',
  },

  // ---- Mobile: the PWA shell ----------------------------------------------
  // Must come last among /m rules: the SPA fallback answers any unmatched /m
  // path with index.html, so this is a catch-all by design.
  {
    method: 'GET',
    pattern: '/m',
    realm: 'public',
    reason: 'PWA entry point. The shell is inert; every API it calls is session-gated.',
  },
  {
    method: 'GET',
    pattern: '/m/**',
    realm: 'public',
    reason:
      'PWA static assets and the SPA fallback. The bundle contains no secrets and every '
      + 'API it talks to is session-gated.',
  },
];

/** The complete public surface, asserted exactly by route-gating.test.ts. */
export const EXPECTED_PUBLIC_PATTERNS: readonly string[] = AUTH_POLICY
  .filter((rule) => rule.realm === 'public')
  .map((rule) => `${rule.method} ${rule.pattern}`);

function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter((part) => part.length > 0);
}

function patternMatches(pattern: string, pathname: string): boolean {
  const patternParts = segmentsOf(pattern);
  const pathParts = segmentsOf(pathname);
  for (let i = 0; i < patternParts.length; i += 1) {
    const token = patternParts[i]!;
    if (token === '**') return true;
    if (i >= pathParts.length) return false;
    // ':param' matches one segment; so does '*' in an Express-style pattern.
    if (token.startsWith(':') || token === '*') continue;
    if (token !== pathParts[i]) return false;
  }
  return patternParts.length === pathParts.length;
}

/**
 * Resolves a method+path to its rule. Undefined means "no explicit rule",
 * which callers MUST treat as admin.
 */
export function classifyRoute(method: string, pathname: string): AuthPolicyRule | undefined {
  const upper = method.toUpperCase();
  return AUTH_POLICY.find(
    (rule) => (rule.method === '*' || rule.method === upper) && patternMatches(rule.pattern, pathname),
  );
}

/** The realm actually applied, with the fail-closed default made explicit. */
export function realmFor(method: string, pathname: string): Realm {
  return classifyRoute(method, pathname)?.realm ?? 'admin';
}

/**
 * Default-deny gate.
 *
 * Admin routes are required to present a credential here, before dispatch.
 * Every other realm is passed through to the handler or router that owns its
 * enforcement (requireMobileSession for mobile, signature verification for
 * signed webhooks) — duplicating those checks here would risk the two
 * implementations drifting apart.
 */
export function defaultDenyAuthGate(deps: {
  isAdminAuthorized: (req: Request) => boolean;
}): (req: Request, res: Response, next: NextFunction) => void {
  return function authGate(req: Request, res: Response, next: NextFunction): void {
    const realm = realmFor(req.method, req.path);
    if (realm !== 'admin') {
      next();
      return;
    }
    if (deps.isAdminAuthorized(req)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized' });
  };
}
