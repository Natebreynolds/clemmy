/**
 * Per-IP login throttle.
 *
 * In-memory on purpose: this is a single-operator panel on a single Railway
 * instance, and a shared store would be a new dependency guarding one login
 * form. A process restart resets counters, which is acceptable — the floor that
 * actually stops guessing is TOTP, and this only blunts online brute force.
 */

type Attempt = { failures: number; firstFailureAt: number; lockedUntil: number };

declare global {
  // eslint-disable-next-line no-var
  var __clemAdminLoginAttempts: Map<string, Attempt> | undefined;
}

const attempts: Map<string, Attempt> = (globalThis.__clemAdminLoginAttempts ??= new Map());

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_TRACKED_IPS = 5000;

function prune(now: number) {
  for (const [ip, entry] of attempts) {
    const expired = now - entry.firstFailureAt > WINDOW_MS && now > entry.lockedUntil;
    if (expired) attempts.delete(ip);
  }
  // Hard ceiling so a spoofed-XFF flood cannot grow the map without bound.
  if (attempts.size > MAX_TRACKED_IPS) attempts.clear();
}

export function loginRateStatus(ip: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
  prune(now);
  const entry = attempts.get(ip);
  if (!entry) return { allowed: true, retryAfterSeconds: 0 };
  if (now < entry.lockedUntil) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordLoginFailure(ip: string, now = Date.now()): void {
  const entry = attempts.get(ip);
  if (!entry || now - entry.firstFailureAt > WINDOW_MS) {
    attempts.set(ip, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
    return;
  }
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS;
    entry.failures = 0;
    entry.firstFailureAt = now;
  }
}

export function clearLoginFailures(ip: string): void {
  attempts.delete(ip);
}

/**
 * Railway terminates TLS at its edge, so the socket address is always the proxy.
 * The left-most x-forwarded-for entry is the client as the edge saw it. It is
 * spoofable by a determined attacker — which is why this is a speed bump, not
 * an authentication control.
 */
export function clientIpFrom(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}
