/**
 * Two-tier attempt rate limiter for the mobile surface.
 *
 * Per-IP bucket: N failed attempts inside a sliding window → lockout.
 * Stops a single attacker hammering from one IP.
 *
 * Global bucket: a larger budget across ALL IPs inside a wider window →
 * daemon-wide lockout, plus a notification fan out (Discord, push, etc.) to the
 * legitimate user. Closes the distributed brute-force gap where each rented IP
 * only spends a few failures before rotating.
 *
 * A successful attempt clears the per-IP bucket but NOT the global one (a legit
 * login during an active attack shouldn't mask the attack). The global bucket
 * relaxes naturally as old failures age past the window.
 *
 * State persists across daemon restarts so a crash doesn't reset either counter
 * for an in-progress brute-force.
 *
 * ## Scopes
 *
 * Credential-establishing endpoints are budgeted SEPARATELY. Originally only
 * PIN login was limited, which left `POST /m/auth/pair` — the other way to mint
 * a full session — entirely unguarded. Sharing one bucket across both would be
 * worse than useless: PIN failures could lock out pairing (the recovery path
 * that needs to keep working), while pairing abuse would eat the PIN budget.
 *
 *   'pin'   — PIN login. The tightest budget; a human typing a PIN needs few tries.
 *   'pair'  — QR pairing-code redemption. The token is 256-bit so guessing is not
 *             the threat; this bounds resource abuse and makes a photographed-QR
 *             window noisy rather than silent.
 *   'proof' — Device-proof verification failures. A client failing this many
 *             signature checks is broken or hostile, not unlucky.
 *
 * Note that the IP a bucket is keyed on is only trustworthy because ingress
 * classification decides when CF-Connecting-IP may be believed — see
 * mobile-ingress.ts. Without that, any caller could rotate the header and mint a
 * fresh bucket per request, making every budget here unenforceable.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { atomicJsonMutate } from './atomic-json.js';

function ensureParentDir(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
}

export type MobileAttemptScope = 'pin' | 'pair' | 'proof';

export const MOBILE_ATTEMPT_SCOPES: readonly MobileAttemptScope[] = ['pin', 'pair', 'proof'];

export interface MobileAttemptBucket {
  /** Unix-ms timestamps of failed attempts inside the window. */
  failures: number[];
  /** When set, all attempts are denied until this Unix-ms timestamp. */
  lockedUntil?: number;
  /** When the bucket transitioned into lockedUntil, used for transition detection. */
  lastLockedAt?: number;
}

interface MobileAttemptsFileV1 {
  version: 1;
  buckets: Record<string, MobileAttemptBucket>;
}

interface MobileAttemptsFileV2 {
  version: 2;
  buckets: Record<string, MobileAttemptBucket>;
  global: MobileAttemptBucket;
}

interface MobileAttemptsFileV3 {
  version: 3;
  /** Keyed `${scope}:${ip}`. */
  buckets: Record<string, MobileAttemptBucket>;
  globals: Record<MobileAttemptScope, MobileAttemptBucket>;
}

/** Retained for back-compat with existing importers; these are the 'pin' policy. */
export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 30 * 60 * 1000;

export const GLOBAL_MAX_FAILURES = 25;
export const GLOBAL_WINDOW_MS = 30 * 60 * 1000;
export const GLOBAL_LOCKOUT_MS = 60 * 60 * 1000;

export interface ScopePolicy {
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
  globalMaxFailures: number;
  globalWindowMs: number;
  globalLockoutMs: number;
}

export const SCOPE_POLICIES: Record<MobileAttemptScope, ScopePolicy> = {
  pin: {
    maxFailures: MAX_FAILURES,
    windowMs: WINDOW_MS,
    lockoutMs: LOCKOUT_MS,
    globalMaxFailures: GLOBAL_MAX_FAILURES,
    globalWindowMs: GLOBAL_WINDOW_MS,
    globalLockoutMs: GLOBAL_LOCKOUT_MS,
  },
  pair: {
    maxFailures: 5,
    windowMs: 10 * 60 * 1000,
    lockoutMs: 15 * 60 * 1000,
    globalMaxFailures: 20,
    globalWindowMs: 30 * 60 * 1000,
    globalLockoutMs: 60 * 60 * 1000,
  },
  proof: {
    maxFailures: 20,
    windowMs: 5 * 60 * 1000,
    lockoutMs: 15 * 60 * 1000,
    globalMaxFailures: 200,
    globalWindowMs: 30 * 60 * 1000,
    globalLockoutMs: 30 * 60 * 1000,
  },
};

export interface MobileRateLimitOptions {
  stateDir?: string;
  now?: () => number;
  /** Defaults to 'pin' so existing callers keep their behavior. */
  scope?: MobileAttemptScope;
  maxFailures?: number;
  windowMs?: number;
  lockoutMs?: number;
  globalMaxFailures?: number;
  globalWindowMs?: number;
  globalLockoutMs?: number;
}

function scopeOf(opts?: MobileRateLimitOptions): MobileAttemptScope {
  return opts?.scope ?? 'pin';
}

/** Explicit option overrides win over the scope default, for tests and tuning. */
function policyFor(opts?: MobileRateLimitOptions): ScopePolicy {
  const base = SCOPE_POLICIES[scopeOf(opts)];
  return {
    maxFailures: opts?.maxFailures ?? base.maxFailures,
    windowMs: opts?.windowMs ?? base.windowMs,
    lockoutMs: opts?.lockoutMs ?? base.lockoutMs,
    globalMaxFailures: opts?.globalMaxFailures ?? base.globalMaxFailures,
    globalWindowMs: opts?.globalWindowMs ?? base.globalWindowMs,
    globalLockoutMs: opts?.globalLockoutMs ?? base.globalLockoutMs,
  };
}

function bucketKey(scope: MobileAttemptScope, ip: string): string {
  return `${scope}:${ip}`;
}

function scopeOfKey(key: string): MobileAttemptScope {
  const prefix = key.slice(0, key.indexOf(':'));
  return (MOBILE_ATTEMPT_SCOPES as readonly string[]).includes(prefix)
    ? (prefix as MobileAttemptScope)
    : 'pin';
}

function attemptsFile(opts?: MobileRateLimitOptions): string {
  const dir = opts?.stateDir ?? path.join(BASE_DIR, 'state');
  return path.join(dir, 'mobile-pin-attempts.json');
}

function emptyBucket(): MobileAttemptBucket {
  return { failures: [] };
}

function emptyGlobals(): Record<MobileAttemptScope, MobileAttemptBucket> {
  return { pin: emptyBucket(), pair: emptyBucket(), proof: emptyBucket() };
}

function emptyFile(): MobileAttemptsFileV3 {
  return { version: 3, buckets: {}, globals: emptyGlobals() };
}

function loadFile(opts?: MobileRateLimitOptions): MobileAttemptsFileV3 {
  const file = attemptsFile(opts);
  if (!existsSync(file)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as
      | Partial<MobileAttemptsFileV1>
      | Partial<MobileAttemptsFileV2>
      | Partial<MobileAttemptsFileV3>;
    if (!parsed.buckets) return emptyFile();
    if (parsed.version === 3) {
      const v3 = parsed as MobileAttemptsFileV3;
      return {
        version: 3,
        buckets: { ...v3.buckets },
        globals: { ...emptyGlobals(), ...(v3.globals ?? {}) },
      };
    }
    // Migrate v1/v2 → v3. An in-progress lockout MUST survive the upgrade, or
    // shipping a release would hand an active brute-force a free reset.
    const legacy = parsed as Partial<MobileAttemptsFileV2>;
    const buckets: Record<string, MobileAttemptBucket> = {};
    for (const [ip, bucket] of Object.entries(legacy.buckets ?? {})) {
      // Legacy keys are bare IPs and were always PIN attempts.
      buckets[bucketKey('pin', ip)] = bucket;
    }
    const globals = emptyGlobals();
    if (legacy.global && Array.isArray(legacy.global.failures)) globals.pin = legacy.global;
    return { version: 3, buckets, globals };
  } catch {
    return emptyFile();
  }
}

function gcBuckets(
  buckets: Record<string, MobileAttemptBucket>,
  now: number,
): Record<string, MobileAttemptBucket> {
  const next: Record<string, MobileAttemptBucket> = {};
  for (const [key, bucket] of Object.entries(buckets)) {
    // Each key is GC'd against its own scope's window, not the caller's.
    const policy = SCOPE_POLICIES[scopeOfKey(key)];
    const cutoff = now - Math.max(policy.windowMs, policy.lockoutMs);
    const live = bucket.failures.filter((ts) => ts > cutoff);
    const stillLocked = bucket.lockedUntil && bucket.lockedUntil > now;
    if (live.length === 0 && !stillLocked) continue;
    next[key] = {
      failures: live,
      lockedUntil: stillLocked ? bucket.lockedUntil : undefined,
      lastLockedAt: bucket.lastLockedAt,
    };
  }
  return next;
}

function gcGlobal(
  bucket: MobileAttemptBucket | undefined,
  now: number,
  windowMs: number,
  lockoutMs: number,
): MobileAttemptBucket {
  const source = bucket ?? emptyBucket();
  const cutoff = now - Math.max(windowMs, lockoutMs);
  const live = source.failures.filter((ts) => ts > cutoff);
  const stillLocked = source.lockedUntil && source.lockedUntil > now;
  return {
    failures: live,
    lockedUntil: stillLocked ? source.lockedUntil : undefined,
    lastLockedAt: source.lastLockedAt,
  };
}

export interface AttemptDecision {
  allowed: boolean;
  /** ms until the next attempt is allowed; 0 when allowed. */
  retryAfterMs: number;
  /** Failures observed for THIS IP inside the current window. */
  failures: number;
  /** True when the global daemon-wide lockout is in effect for this scope. */
  globalLocked: boolean;
  /** Failures observed globally inside the global window for this scope. */
  globalFailures: number;
}

/**
 * Check whether the IP may attempt right now. This DOES NOT record an attempt —
 * the caller records the outcome via `recordFailure` or `recordSuccess` after
 * verification completes.
 */
export function checkAttempt(
  ip: string,
  opts?: MobileRateLimitOptions,
): AttemptDecision {
  const now = opts?.now?.() ?? Date.now();
  const scope = scopeOf(opts);
  const policy = policyFor(opts);
  const file = loadFile(opts);
  const globalBucket = file.globals[scope] ?? emptyBucket();

  // Global gate first — overrides everything when tripped.
  const globalRecent = globalBucket.failures.filter((ts) => ts > now - policy.globalWindowMs);
  const globalLocked = Boolean(globalBucket.lockedUntil && globalBucket.lockedUntil > now);
  if (globalLocked) {
    return {
      allowed: false,
      retryAfterMs: (globalBucket.lockedUntil ?? now) - now,
      failures: file.buckets[bucketKey(scope, ip)]?.failures.length ?? 0,
      globalLocked: true,
      globalFailures: globalRecent.length,
    };
  }

  const bucket = file.buckets[bucketKey(scope, ip)];
  if (!bucket) {
    return {
      allowed: true,
      retryAfterMs: 0,
      failures: 0,
      globalLocked: false,
      globalFailures: globalRecent.length,
    };
  }

  if (bucket.lockedUntil && bucket.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterMs: bucket.lockedUntil - now,
      failures: policy.maxFailures,
      globalLocked: false,
      globalFailures: globalRecent.length,
    };
  }
  const recent = bucket.failures.filter((ts) => ts > now - policy.windowMs);
  if (recent.length >= policy.maxFailures) {
    return {
      allowed: false,
      retryAfterMs: policy.lockoutMs,
      failures: recent.length,
      globalLocked: false,
      globalFailures: globalRecent.length,
    };
  }
  return {
    allowed: true,
    retryAfterMs: 0,
    failures: recent.length,
    globalLocked: false,
    globalFailures: globalRecent.length,
  };
}

export interface RecordedFailure extends AttemptDecision {
  /**
   * True the moment this failure transitions the global bucket from
   * "not locked" to "locked". Callers use this signal to fire a one-shot
   * notification to the legitimate user. Re-locking after a previous lock
   * has expired also triggers true.
   */
  globalTrippedNow: boolean;
}

export async function recordFailure(
  ip: string,
  opts?: MobileRateLimitOptions,
): Promise<RecordedFailure> {
  const now = opts?.now?.() ?? Date.now();
  const scope = scopeOf(opts);
  const policy = policyFor(opts);
  const key = bucketKey(scope, ip);

  let result: RecordedFailure = {
    allowed: true,
    retryAfterMs: 0,
    failures: 0,
    globalLocked: false,
    globalFailures: 0,
    globalTrippedNow: false,
  };
  const file = attemptsFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobileAttemptsFileV3>(
    file,
    (raw) => {
      const current = normalizeForMutate(raw);
      const buckets = gcBuckets(current.buckets, now);
      const globalBefore = gcGlobal(
        current.globals[scope],
        now,
        policy.globalWindowMs,
        policy.globalLockoutMs,
      );
      const wasGloballyLocked = Boolean(
        globalBefore.lockedUntil && globalBefore.lockedUntil > now,
      );

      // Per-IP tick.
      const bucket = buckets[key] ?? { failures: [], lockedUntil: undefined };
      const recent = bucket.failures.filter((ts) => ts > now - policy.windowMs);
      recent.push(now);
      const lockedUntil = recent.length >= policy.maxFailures ? now + policy.lockoutMs : bucket.lockedUntil;
      const lastLockedAt =
        lockedUntil && (!bucket.lockedUntil || bucket.lockedUntil <= now)
          ? now
          : bucket.lastLockedAt;
      buckets[key] = { failures: recent, lockedUntil, lastLockedAt };

      // Global tick.
      const globalFailures = globalBefore.failures.filter((ts) => ts > now - policy.globalWindowMs);
      globalFailures.push(now);
      const globalLockedUntil =
        globalFailures.length >= policy.globalMaxFailures
          ? now + policy.globalLockoutMs
          : globalBefore.lockedUntil;
      const globalLastLockedAt =
        globalLockedUntil && !wasGloballyLocked ? now : globalBefore.lastLockedAt;
      const nextGlobal: MobileAttemptBucket = {
        failures: globalFailures,
        lockedUntil: globalLockedUntil,
        lastLockedAt: globalLastLockedAt,
      };
      const isGloballyLockedNow = Boolean(globalLockedUntil && globalLockedUntil > now);

      result = {
        allowed: !(lockedUntil && lockedUntil > now) && !isGloballyLockedNow,
        retryAfterMs: isGloballyLockedNow
          ? (globalLockedUntil ?? now) - now
          : lockedUntil && lockedUntil > now
            ? lockedUntil - now
            : 0,
        failures: recent.length,
        globalLocked: isGloballyLockedNow,
        globalFailures: globalFailures.length,
        globalTrippedNow: isGloballyLockedNow && !wasGloballyLocked,
      };
      return {
        version: 3,
        buckets,
        globals: { ...current.globals, [scope]: nextGlobal },
      };
    },
    emptyFile(),
  );
  return result;
}

export async function recordSuccess(
  ip: string,
  opts?: MobileRateLimitOptions,
): Promise<void> {
  const now = opts?.now?.() ?? Date.now();
  const scope = scopeOf(opts);
  const policy = policyFor(opts);
  const file = attemptsFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobileAttemptsFileV3>(
    file,
    (raw) => {
      const current = normalizeForMutate(raw);
      const buckets = gcBuckets(current.buckets, now);
      delete buckets[bucketKey(scope, ip)];
      // A successful attempt does NOT clear the global bucket — an active
      // brute-force is still active even if the legitimate user got in.
      const global = gcGlobal(
        current.globals[scope],
        now,
        policy.globalWindowMs,
        policy.globalLockoutMs,
      );
      return {
        version: 3,
        buckets,
        globals: { ...current.globals, [scope]: global },
      };
    },
    emptyFile(),
  );
}

/**
 * atomicJsonMutate hands back whatever is on disk, which may still be a v1/v2
 * shape on the first write after upgrade. Normalizing inside the mutation keeps
 * the migration atomic with the write rather than depending on a prior read.
 */
function normalizeForMutate(raw: unknown): MobileAttemptsFileV3 {
  const candidate = raw as Partial<MobileAttemptsFileV3> & Partial<MobileAttemptsFileV2>;
  if (candidate?.version === 3 && candidate.buckets) {
    return {
      version: 3,
      buckets: { ...candidate.buckets },
      globals: { ...emptyGlobals(), ...(candidate.globals ?? {}) },
    };
  }
  const buckets: Record<string, MobileAttemptBucket> = {};
  for (const [ip, bucket] of Object.entries(candidate?.buckets ?? {})) {
    buckets[ip.includes(':') ? ip : bucketKey('pin', ip)] = bucket;
  }
  const globals = emptyGlobals();
  if (candidate?.global && Array.isArray(candidate.global.failures)) globals.pin = candidate.global;
  return { version: 3, buckets, globals };
}

/** Diagnostics for the dashboard. */
export function readGlobalBucket(
  opts?: MobileRateLimitOptions,
): MobileAttemptBucket {
  const now = opts?.now?.() ?? Date.now();
  const scope = scopeOf(opts);
  const policy = policyFor(opts);
  return gcGlobal(loadFile(opts).globals[scope], now, policy.globalWindowMs, policy.globalLockoutMs);
}
