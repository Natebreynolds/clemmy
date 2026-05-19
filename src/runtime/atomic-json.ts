/**
 * Atomic JSON / NDJSON writers — the single primitive every state file
 * uses for read-modify-write or append-only persistence.
 *
 * Why this exists: prior to this module, every JSON state file
 * (`runs.json`, `usage-log/<date>.ndjson`, `notifications.json`, the
 * future `alert-buckets.json`) had its own ad-hoc write pattern. The
 * audit on 2026-05-18 found two failure classes:
 *   - last-writer-wins on concurrent writers (run-events.ts:154-182
 *     loads → mutates → saves with no lock; two callers stomp).
 *   - silent swallows on ENOSPC / EACCES (usage-log.ts:62-69 catches
 *     every error and returns void; token-spend audit trail vanishes).
 *
 * This module is the single fix:
 *   - `atomicJsonMutate(filePath, mutator)` — read JSON, apply mutator,
 *     write to temp, fsync, rename, all under in-process Mutex + a
 *     cross-process advisory `.lock` file with PID + ctime stale check.
 *   - `atomicAppendNdjson(filePath, line)` — append one NDJSON line
 *     with O_APPEND (POSIX-atomic for writes < PIPE_BUF) and an
 *     advisory lock so the same daily log doesn't get interleaved
 *     bytes from two PIDs at once.
 *
 * Both helpers throw `BoundaryError(kind: 'state.write_failed')` on
 * persistent failure — they refuse to silently drop. Callers that
 * want best-effort behavior wrap in a try and decide what to do with
 * the BoundaryError; the helper itself does not silence.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BoundaryError } from './boundary-error.js';

// ---------------------------------------------------------------- locks

/**
 * Per-file in-process mutex. Same chain pattern as the session lock —
 * each acquire awaits the previous holder's promise and replaces it.
 * Zero-cost when there's no contention.
 */
const inProcessLocks = new Map<string, Promise<void>>();

async function acquireInProcessLock(key: string): Promise<() => void> {
  const previous = inProcessLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  inProcessLocks.set(key, previous.then(() => current));
  await previous;
  return () => {
    release();
    // Best-effort cleanup so the Map doesn't grow unbounded across
    // long-lived processes that touch many different files.
    if (inProcessLocks.get(key) === previous.then(() => current)) {
      inProcessLocks.delete(key);
    }
  };
}

/**
 * Cross-process advisory lock via a `<path>.lock` file holding the
 * owner PID + ctime. Other processes see the file and back off; if
 * the holder's PID is dead OR the lock is older than `STALE_LOCK_MS`,
 * the next acquire steals it (the previous owner crashed).
 *
 * This is advisory — nothing prevents a misbehaving process from
 * writing the file directly. The daemon and CLI both go through this
 * helper, which is the only contract we need.
 */
const STALE_LOCK_MS = 60_000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_WAIT_MS = 10_000;

function lockFilePath(filePath: string): string {
  return `${filePath}.lock`;
}

function isPidAlive(pid: number): boolean {
  try {
    // signal 0 = existence probe, no actual signal sent.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but we can't signal it.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryAcquireFileLock(filePath: string): boolean {
  const lockPath = lockFilePath(filePath);
  const ownerToken = `${process.pid}:${Date.now()}`;
  try {
    // 'wx' fails if the file already exists — atomic create.
    const fd = openSync(lockPath, 'wx');
    try {
      writeSync(fd, ownerToken);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Existing lock — check whether it's stale.
    try {
      const existing = readFileSync(lockPath, 'utf-8');
      const [pidStr] = existing.split(':');
      const ownerPid = Number.parseInt(pidStr ?? '', 10);
      const lockStat = statSync(lockPath);
      const age = Date.now() - lockStat.ctimeMs;
      const ownerDead = Number.isFinite(ownerPid) && !isPidAlive(ownerPid);
      if (ownerDead || age > STALE_LOCK_MS) {
        // Steal the stale lock. The race between unlink+open is
        // tolerated — if another process steals first, this open
        // returns EEXIST again and we retry from the top.
        try {
          unlinkSync(lockPath);
        } catch {
          /* lock vanished between stat and unlink — fine */
        }
        return tryAcquireFileLock(filePath);
      }
    } catch {
      /* lock file disappeared between EEXIST and stat — retry */
    }
    return false;
  }
}

function releaseFileLock(filePath: string): void {
  try {
    unlinkSync(lockFilePath(filePath));
  } catch {
    /* lock already gone — fine */
  }
}

async function withFileLock<T>(filePath: string, work: () => Promise<T> | T): Promise<T> {
  const inProcessRelease = await acquireInProcessLock(filePath);
  const startedAt = Date.now();
  try {
    while (!tryAcquireFileLock(filePath)) {
      if (Date.now() - startedAt > LOCK_MAX_WAIT_MS) {
        throw new BoundaryError({
          kind: 'state.write_failed',
          retryable: true,
          userMessage: `Couldn't get a write lock on ${path.basename(filePath)} — another process may be stuck. Try again.`,
          operatorMessage: `withFileLock timeout after ${LOCK_MAX_WAIT_MS}ms on ${filePath}`,
          context: { filePath, waitedMs: Date.now() - startedAt },
        });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
    try {
      return await work();
    } finally {
      releaseFileLock(filePath);
    }
  } finally {
    inProcessRelease();
  }
}

// -------------------------------------------------------- atomicJsonMutate

/**
 * Read JSON, apply `mutator`, atomic-write back. The mutator runs
 * UNDER the lock so concurrent callers see each other's mutations
 * (last writer doesn't win — each writer reads-then-mutates the
 * latest committed state).
 *
 * `mutator` returns the new value. If it returns `undefined`, the
 * file is unchanged (no write). If it throws, the lock is released
 * and the exception propagates — no partial write lands.
 *
 * `fallback` is the value used when the file doesn't exist yet.
 */
export async function atomicJsonMutate<T>(
  filePath: string,
  mutator: (current: T) => T | undefined | Promise<T | undefined>,
  fallback: T,
): Promise<void> {
  await withFileLock(filePath, async () => {
    let current: T;
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        current = JSON.parse(raw) as T;
      } catch (err) {
        // Corrupt file: preserve it for inspection, fall back to the
        // caller-supplied default so the mutator sees something
        // workable.
        const corruptPath = `${filePath}.corrupt-${Date.now()}`;
        try {
          renameSync(filePath, corruptPath);
        } catch {
          /* best effort — if rename fails the next write overwrites */
        }
        throw new BoundaryError({
          kind: 'state.read_corrupted',
          retryable: false,
          userMessage: `${path.basename(filePath)} was corrupted; a copy was preserved at ${path.basename(corruptPath)}.`,
          operatorMessage: `atomicJsonMutate: corrupt JSON at ${filePath}, moved to ${corruptPath}`,
          context: { filePath, corruptPath, parseError: (err as Error).message },
          cause: err,
        });
      }
    } else {
      current = fallback;
    }

    const next = await mutator(current);
    if (next === undefined) return;

    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
      const payload = JSON.stringify(next, null, 2);
      const fd = openSync(tmp, 'w');
      try {
        writeSync(fd, payload);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, filePath);
    } catch (err) {
      throw new BoundaryError({
        kind: 'state.write_failed',
        retryable: false,
        userMessage: `Couldn't save ${path.basename(filePath)} — disk may be full or read-only.`,
        operatorMessage: `atomicJsonMutate write failed: ${(err as Error).message}`,
        context: { filePath, errno: (err as NodeJS.ErrnoException).code },
        cause: err,
      });
    }
  });
}

// ------------------------------------------------------ atomicAppendNdjson

/**
 * Append a single NDJSON line to `filePath`. The line MUST NOT include
 * a trailing newline — we add one. POSIX guarantees writes < PIPE_BUF
 * (4096) are atomic against concurrent writes when opened O_APPEND;
 * the advisory lock provides cross-process serialization for callers
 * who may write larger lines.
 *
 * Used by usage-log.ts and the future Recent Errors append store.
 */
export async function atomicAppendNdjson(filePath: string, line: string): Promise<void> {
  if (line.includes('\n')) {
    throw new BoundaryError({
      kind: 'state.write_failed',
      retryable: false,
      userMessage: 'Internal error: NDJSON line contained a newline.',
      operatorMessage: 'atomicAppendNdjson: caller passed multi-line input',
      context: { filePath, lineLength: line.length },
    });
  }
  await withFileLock(filePath, () => {
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      appendFileSync(filePath, line + '\n', { encoding: 'utf-8', flag: 'a' });
    } catch (err) {
      throw new BoundaryError({
        kind: 'state.write_failed',
        retryable: false,
        userMessage: `Couldn't append to ${path.basename(filePath)} — disk may be full or read-only.`,
        operatorMessage: `atomicAppendNdjson failed: ${(err as Error).message}`,
        context: { filePath, errno: (err as NodeJS.ErrnoException).code, lineLength: line.length },
        cause: err,
      });
    }
  });
}
