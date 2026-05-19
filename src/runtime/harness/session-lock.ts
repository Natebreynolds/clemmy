/**
 * Per-session write lock — guarantees in-process AND cross-process
 * serialization of state mutations for a single sessionId.
 *
 * Why this exists: the audit on 2026-05-18 found that the harness
 * session row + event log can diverge under concurrent writers:
 *   - getSession + JS-side merge + updateSession is TOCTOU (eventlog
 *     332-359). Two writers silently lose each other's updates.
 *   - appendEvent has no idempotency key (361-394). A crashed retry
 *     duplicates an event.
 *   - saveInterruptState and markStatus are not atomic with each
 *     other; "is paused" computed three different ways disagrees.
 *
 * The fix is uniform: every non-event mutation routes through
 * `withSessionLock(sessionId, work)`. In-process callers share a
 * Promise chain keyed by sessionId; cross-process callers (CLI +
 * daemon both writing) coordinate via a `session_locks` row that
 * carries the owner PID + token and has a 60s stale-lock TTL.
 *
 * The lock is intentionally narrow: it serializes WRITES on a single
 * session. Reads are unguarded — SQLite already gives us read snapshot
 * isolation under WAL. Writers across DIFFERENT sessions run in
 * parallel; only same-session conflicts serialize.
 *
 * Gating: behind `HARNESS_SESSION_LOCK` env flag. Default OFF so we
 * can ship the primitive without flipping behavior, dogfood for 48h,
 * then flip default-on per the rollout plan.
 */

import { randomUUID } from 'node:crypto';
import { openEventLog } from './eventlog.js';
import { BoundaryError } from '../boundary-error.js';

// In-process per-session promise chain.
const inProcessChain = new Map<string, Promise<void>>();

const STALE_LOCK_MS = 60_000;
const ACQUIRE_RETRY_MS = 25;
const ACQUIRE_MAX_WAIT_MS = 10_000;

/**
 * Test/probe helper — reads the feature flag every call so tests can
 * flip it via `process.env.HARNESS_SESSION_LOCK = 'on'` mid-test.
 */
function isLockEnabled(): boolean {
  return process.env.HARNESS_SESSION_LOCK === 'on';
}

interface SessionLockRow {
  session_id: string;
  owner_pid: number;
  owner_token: string;
  acquired_at: number;
  expires_at: number;
}

function isPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryAcquireRow(sessionId: string, token: string): boolean {
  const db = openEventLog();
  const now = Date.now();
  const expiresAt = now + STALE_LOCK_MS;

  // The acquire is a single SQL statement: INSERT-or-UPSERT when the
  // existing row is stale (expires_at < now) or the owner_pid is
  // dead. SQLite's `ON CONFLICT DO UPDATE` is atomic under WAL.
  const existing = db
    .prepare('SELECT session_id, owner_pid, owner_token, acquired_at, expires_at FROM session_locks WHERE session_id = ?')
    .get(sessionId) as SessionLockRow | undefined;

  if (!existing) {
    // No lock — try to claim. INSERT can race with another claimer;
    // catch UNIQUE-constraint failure and return false so the caller
    // retries.
    try {
      db.prepare(
        'INSERT INTO session_locks (session_id, owner_pid, owner_token, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      ).run(sessionId, process.pid, token, now, expiresAt);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return false;
      throw err;
    }
  }

  // Existing lock — steal if stale or owner is dead.
  const stale = existing.expires_at < now || !isPidAlive(existing.owner_pid);
  if (!stale) return false;

  // Steal by overwriting. UPDATE returns the number of rows changed;
  // if it's 0, another claimer beat us — retry.
  const changes = db
    .prepare(
      `UPDATE session_locks
         SET owner_pid    = ?,
             owner_token  = ?,
             acquired_at  = ?,
             expires_at   = ?
       WHERE session_id   = ?
         AND owner_token  = ?`,
    )
    .run(process.pid, token, now, expiresAt, sessionId, existing.owner_token).changes;
  return changes > 0;
}

function releaseRow(sessionId: string, token: string): void {
  const db = openEventLog();
  // Only release if WE still own it. A stolen-then-released-by-thief
  // scenario is fine — the thief deletes their own row, and our
  // delete is a no-op.
  db.prepare('DELETE FROM session_locks WHERE session_id = ? AND owner_token = ?')
    .run(sessionId, token);
}

async function acquireCrossProcess(sessionId: string): Promise<{ release: () => void }> {
  const token = randomUUID();
  const startedAt = Date.now();
  while (!tryAcquireRow(sessionId, token)) {
    if (Date.now() - startedAt > ACQUIRE_MAX_WAIT_MS) {
      throw new BoundaryError({
        kind: 'state.write_failed',
        retryable: true,
        userMessage: `Couldn't get a write lock on session ${sessionId} — another process may be stuck.`,
        operatorMessage: `session-lock acquire timeout after ${ACQUIRE_MAX_WAIT_MS}ms for ${sessionId}`,
        context: { sessionId, waitedMs: Date.now() - startedAt },
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ACQUIRE_RETRY_MS));
  }
  return { release: () => releaseRow(sessionId, token) };
}

async function acquireInProcess(sessionId: string): Promise<() => void> {
  const previous = inProcessChain.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  inProcessChain.set(sessionId, chained);
  await previous;
  return () => {
    release();
    // Best-effort cleanup so the Map doesn't grow unbounded.
    if (inProcessChain.get(sessionId) === chained) {
      inProcessChain.delete(sessionId);
    }
  };
}

/**
 * Run `work` while holding the lock for `sessionId`. The lock covers
 * BOTH in-process serialization (one Map chain) AND cross-process
 * serialization (one row in session_locks).
 *
 * When the feature flag is off (`HARNESS_SESSION_LOCK !== 'on'`), the
 * helper is a no-op pass-through — `work` runs immediately with no
 * locking. This lets us ship the primitive ahead of any callers and
 * flip on later without code changes.
 */
export async function withSessionLock<T>(
  sessionId: string,
  work: () => Promise<T> | T,
): Promise<T> {
  if (!isLockEnabled()) {
    return await work();
  }
  const inReleaser = await acquireInProcess(sessionId);
  try {
    const xp = await acquireCrossProcess(sessionId);
    try {
      return await work();
    } finally {
      xp.release();
    }
  } finally {
    inReleaser();
  }
}

/** Test-only — drops the in-process chain so a fresh test starts clean. */
export function __resetSessionLocks(): void {
  inProcessChain.clear();
}
