/**
 * Is this machine busy enough that Clem should get out of the way?
 *
 * 2026-09-10: during a Zoom call the daemon ran a vault reindex and an
 * embedding backfill while Zoom held ~80-100% CPU. The maintenance work was not
 * urgent, but it competed with the user's call, took far longer than usual, and
 * blocked the loop long enough for the supervisor to kill the daemon as hung.
 *
 * Discretionary background work should yield under contention. Durable work —
 * reaping, settlement, anything that keeps the database bounded or a promise
 * kept — must NOT: skipping the reapers under load is how a machine that is
 * already struggling ends up with an even larger database.
 *
 * Deliberately load-average based rather than tied to any particular app: a
 * user on a call, compiling, or rendering video all deserve the same courtesy,
 * and Clem should never carry a list of programs it recognizes.
 */
import os from 'node:os';
import { getRuntimeEnv } from '../config.js';

/** Load per core above which discretionary work stands down. 1.4 leaves normal
 *  multitasking alone (a quiet laptop idles well under 1.0 per core) while a
 *  video call, a build, or a render trips it. */
const DEFAULT_CONTENTION_THRESHOLD = 1.4;

/** Never let courtesy become starvation: after this many consecutive deferrals
 *  a discretionary job runs anyway. At the maintenance tick's cadence this is
 *  minutes, not hours. */
export const MAX_CONSECUTIVE_DEFERRALS = 10;

const CACHE_MS = 2_000;
let cachedAt = 0;
let cached = false;

function threshold(): number {
  const raw = Number(getRuntimeEnv('CLEMMY_CONTENTION_THRESHOLD', '') || '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONTENTION_THRESHOLD;
}

/** Load average per CPU, or null where the platform does not report one
 *  (Windows always reports 0, which must read as "unknown", never as "idle"). */
export function loadPerCore(): number | null {
  try {
    const [oneMinute] = os.loadavg();
    const cores = os.cpus()?.length || 0;
    if (!cores || !Number.isFinite(oneMinute) || oneMinute <= 0) return null;
    return oneMinute / cores;
  } catch {
    return null;
  }
}

/**
 * True when the machine is loaded enough that discretionary work should wait.
 * Unknown load reads as NOT contended — this must never be a reason work stops
 * happening on a platform that cannot measure it.
 */
export function systemUnderContention(now = Date.now()): boolean {
  if (now - cachedAt < CACHE_MS) return cached;
  const perCore = loadPerCore();
  cached = perCore !== null && perCore > threshold();
  cachedAt = now;
  return cached;
}

const deferrals = new Map<string, number>();

/**
 * Should this discretionary job yield right now?
 *
 * Returns true to SKIP. Tracks consecutive skips per job so a sustained load
 * (a two-hour call) still lets the work through periodically rather than
 * postponing it indefinitely.
 */
export function shouldDeferDiscretionaryWork(job: string, now = Date.now()): boolean {
  if (!systemUnderContention(now)) {
    deferrals.delete(job);
    return false;
  }
  const prior = deferrals.get(job) ?? 0;
  if (prior >= MAX_CONSECUTIVE_DEFERRALS) {
    deferrals.delete(job);
    return false;
  }
  deferrals.set(job, prior + 1);
  return true;
}

/** Test seam. */
export function _resetContentionStateForTest(): void {
  deferrals.clear();
  cachedAt = 0;
  cached = false;
}
