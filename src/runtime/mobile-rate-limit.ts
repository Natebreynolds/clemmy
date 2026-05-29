/**
 * Two-tier PIN-attempt rate limiter for the mobile PWA login endpoint.
 *
 * Per-IP bucket: 5 failed attempts inside a 15-minute sliding window
 * → 30-min lockout. Stops a single attacker hammering from one IP.
 *
 * Global bucket: 25 failed attempts across ALL IPs inside a 30-minute
 * sliding window → 1-hour daemon-wide lockout, plus a notification fan
 * out (Discord, push, etc.) to the legitimate user. Closes the
 * distributed brute-force gap where each rented IP only spends 4
 * failures before rotating.
 *
 * A successful login clears the per-IP bucket but NOT the global one
 * (a legit login during an active attack shouldn't mask the attack).
 * Global bucket relaxes naturally as old failures age past the window.
 *
 * State persists across daemon restarts so a crash doesn't reset
 * either counter for an in-progress brute-force.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { atomicJsonMutate } from './atomic-json.js';

function ensureParentDir(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
}

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

export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 30 * 60 * 1000;

export const GLOBAL_MAX_FAILURES = 25;
export const GLOBAL_WINDOW_MS = 30 * 60 * 1000;
export const GLOBAL_LOCKOUT_MS = 60 * 60 * 1000;

export interface MobileRateLimitOptions {
  stateDir?: string;
  now?: () => number;
  maxFailures?: number;
  windowMs?: number;
  lockoutMs?: number;
  globalMaxFailures?: number;
  globalWindowMs?: number;
  globalLockoutMs?: number;
}

function attemptsFile(opts?: MobileRateLimitOptions): string {
  const dir = opts?.stateDir ?? path.join(BASE_DIR, 'state');
  return path.join(dir, 'mobile-pin-attempts.json');
}

function emptyGlobal(): MobileAttemptBucket {
  return { failures: [] };
}

function emptyFile(): MobileAttemptsFileV2 {
  return { version: 2, buckets: {}, global: emptyGlobal() };
}

function loadFile(opts?: MobileRateLimitOptions): MobileAttemptsFileV2 {
  const file = attemptsFile(opts);
  if (!existsSync(file)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as
      | Partial<MobileAttemptsFileV1>
      | Partial<MobileAttemptsFileV2>;
    if (!parsed.buckets) return emptyFile();
    // Migrate v1 → v2 transparently: the buckets are still valid,
    // we just need to add an empty global bucket. The next failure
    // will start populating it.
    const v2: MobileAttemptsFileV2 = {
      version: 2,
      buckets: { ...parsed.buckets },
      global:
        (parsed as Partial<MobileAttemptsFileV2>).global &&
        Array.isArray((parsed as Partial<MobileAttemptsFileV2>).global!.failures)
          ? (parsed as MobileAttemptsFileV2).global
          : emptyGlobal(),
    };
    return v2;
  } catch {
    return emptyFile();
  }
}

function gcBuckets(
  buckets: Record<string, MobileAttemptBucket>,
  now: number,
  windowMs: number,
  lockoutMs: number,
): Record<string, MobileAttemptBucket> {
  const cutoff = now - Math.max(windowMs, lockoutMs);
  const next: Record<string, MobileAttemptBucket> = {};
  for (const [ip, bucket] of Object.entries(buckets)) {
    const live = bucket.failures.filter((ts) => ts > cutoff);
    const stillLocked = bucket.lockedUntil && bucket.lockedUntil > now;
    if (live.length === 0 && !stillLocked) continue;
    next[ip] = {
      failures: live,
      lockedUntil: stillLocked ? bucket.lockedUntil : undefined,
      lastLockedAt: bucket.lastLockedAt,
    };
  }
  return next;
}

function gcGlobal(
  bucket: MobileAttemptBucket,
  now: number,
  windowMs: number,
  lockoutMs: number,
): MobileAttemptBucket {
  const cutoff = now - Math.max(windowMs, lockoutMs);
  const live = bucket.failures.filter((ts) => ts > cutoff);
  const stillLocked = bucket.lockedUntil && bucket.lockedUntil > now;
  return {
    failures: live,
    lockedUntil: stillLocked ? bucket.lockedUntil : undefined,
    lastLockedAt: bucket.lastLockedAt,
  };
}

export interface AttemptDecision {
  allowed: boolean;
  /** ms until the next attempt is allowed; 0 when allowed. */
  retryAfterMs: number;
  /** Failures observed for THIS IP inside the current window. */
  failures: number;
  /** True when the global daemon-wide lockout is in effect. */
  globalLocked: boolean;
  /** Failures observed globally inside the global window. */
  globalFailures: number;
}

/**
 * Check whether the IP may attempt a login right now. This DOES NOT
 * record an attempt — the caller records the outcome via
 * `recordFailure` or `recordSuccess` after verification completes.
 */
export function checkAttempt(
  ip: string,
  opts?: MobileRateLimitOptions,
): AttemptDecision {
  const now = opts?.now?.() ?? Date.now();
  const windowMs = opts?.windowMs ?? WINDOW_MS;
  const lockoutMs = opts?.lockoutMs ?? LOCKOUT_MS;
  const maxFailures = opts?.maxFailures ?? MAX_FAILURES;
  const globalWindowMs = opts?.globalWindowMs ?? GLOBAL_WINDOW_MS;
  const globalMaxFailures = opts?.globalMaxFailures ?? GLOBAL_MAX_FAILURES;
  const file = loadFile(opts);

  // Global gate first — overrides everything when tripped.
  const globalRecent = file.global.failures.filter((ts) => ts > now - globalWindowMs);
  const globalLocked = Boolean(file.global.lockedUntil && file.global.lockedUntil > now);
  if (globalLocked) {
    return {
      allowed: false,
      retryAfterMs: (file.global.lockedUntil ?? now) - now,
      failures: file.buckets[ip]?.failures.length ?? 0,
      globalLocked: true,
      globalFailures: globalRecent.length,
    };
  }

  const bucket = file.buckets[ip];
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
      failures: maxFailures,
      globalLocked: false,
      globalFailures: globalRecent.length,
    };
  }
  const recent = bucket.failures.filter((ts) => ts > now - windowMs);
  if (recent.length >= maxFailures) {
    return {
      allowed: false,
      retryAfterMs: lockoutMs,
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
   * "not locked" to "locked". Callers use this signal to fire a
   * one-shot notification to the legitimate user. Re-locking after
   * a previous lock has expired also triggers true.
   */
  globalTrippedNow: boolean;
}

export async function recordFailure(
  ip: string,
  opts?: MobileRateLimitOptions,
): Promise<RecordedFailure> {
  const now = opts?.now?.() ?? Date.now();
  const windowMs = opts?.windowMs ?? WINDOW_MS;
  const lockoutMs = opts?.lockoutMs ?? LOCKOUT_MS;
  const maxFailures = opts?.maxFailures ?? MAX_FAILURES;
  const globalWindowMs = opts?.globalWindowMs ?? GLOBAL_WINDOW_MS;
  const globalLockoutMs = opts?.globalLockoutMs ?? GLOBAL_LOCKOUT_MS;
  const globalMaxFailures = opts?.globalMaxFailures ?? GLOBAL_MAX_FAILURES;

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
  await atomicJsonMutate<MobileAttemptsFileV2>(
    file,
    (current) => {
      const buckets = gcBuckets(current.buckets, now, windowMs, lockoutMs);
      const globalBefore = gcGlobal(current.global, now, globalWindowMs, globalLockoutMs);
      const wasGloballyLocked = Boolean(
        globalBefore.lockedUntil && globalBefore.lockedUntil > now,
      );

      // Per-IP tick.
      const bucket = buckets[ip] ?? { failures: [], lockedUntil: undefined };
      const recent = bucket.failures.filter((ts) => ts > now - windowMs);
      recent.push(now);
      const lockedUntil = recent.length >= maxFailures ? now + lockoutMs : bucket.lockedUntil;
      const lastLockedAt =
        lockedUntil && (!bucket.lockedUntil || bucket.lockedUntil <= now)
          ? now
          : bucket.lastLockedAt;
      buckets[ip] = { failures: recent, lockedUntil, lastLockedAt };

      // Global tick.
      const globalFailures = globalBefore.failures.filter((ts) => ts > now - globalWindowMs);
      globalFailures.push(now);
      const globalLockedUntil =
        globalFailures.length >= globalMaxFailures
          ? now + globalLockoutMs
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
      return { version: 2, buckets, global: nextGlobal };
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
  const windowMs = opts?.windowMs ?? WINDOW_MS;
  const lockoutMs = opts?.lockoutMs ?? LOCKOUT_MS;
  const globalWindowMs = opts?.globalWindowMs ?? GLOBAL_WINDOW_MS;
  const globalLockoutMs = opts?.globalLockoutMs ?? GLOBAL_LOCKOUT_MS;
  const file = attemptsFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobileAttemptsFileV2>(
    file,
    (current) => {
      const buckets = gcBuckets(current.buckets, now, windowMs, lockoutMs);
      if (buckets[ip]) delete buckets[ip];
      // Successful login does NOT clear the global bucket — an
      // active brute-force is still an active brute-force even if
      // the legitimate user happened to log in during it.
      const global = gcGlobal(current.global, now, globalWindowMs, globalLockoutMs);
      return { version: 2, buckets, global };
    },
    emptyFile(),
  );
}

/** Diagnostics for the dashboard. */
export function readGlobalBucket(opts?: MobileRateLimitOptions): MobileAttemptBucket {
  const now = opts?.now?.() ?? Date.now();
  return gcGlobal(loadFile(opts).global, now, GLOBAL_WINDOW_MS, GLOBAL_LOCKOUT_MS);
}
