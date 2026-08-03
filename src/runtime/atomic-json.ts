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
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
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

interface HeldFileLockScope {
  filePath: string;
  active: boolean;
  parent?: HeldFileLockScope;
}

const heldFileLocks = new AsyncLocalStorage<HeldFileLockScope>();

async function acquireInProcessLock(key: string): Promise<() => void> {
  const previous = inProcessLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  inProcessLocks.set(key, tail);
  await previous;
  return () => {
    release();
    // Best-effort cleanup so the Map doesn't grow unbounded across
    // long-lived processes that touch many different files.
    if (inProcessLocks.get(key) === tail) {
      inProcessLocks.delete(key);
    }
  };
}

function assertFileLockIsNotReentrant(filePath: string): void {
  let scope = heldFileLocks.getStore();
  while (scope) {
    if (scope.active && scope.filePath === filePath) break;
    scope = scope.parent;
  }
  if (!scope) return;
  throw new BoundaryError({
    kind: 'state.write_failed',
    retryable: false,
    userMessage: `Couldn't safely re-enter the write lock on ${path.basename(filePath)}.`,
    operatorMessage: `file lock is not re-entrant: ${filePath}`,
    context: { filePath, reason: 'non_reentrant_lock' },
  });
}

async function runWithHeldFileLockAsync<T>(
  filePath: string,
  work: () => Promise<T> | T,
): Promise<T> {
  const scope: HeldFileLockScope = {
    filePath,
    active: true,
    parent: heldFileLocks.getStore(),
  };
  return heldFileLocks.run(scope, async () => {
    try {
      return await work();
    } finally {
      // Detached async descendants retain this scope object. Marking it
      // inactive prevents a callback that runs after release from being
      // mistaken for recursive ownership.
      scope.active = false;
    }
  });
}

function runWithHeldFileLockSync<T>(filePath: string, work: () => T): T {
  const scope: HeldFileLockScope = {
    filePath,
    active: true,
    parent: heldFileLocks.getStore(),
  };
  return heldFileLocks.run(scope, () => {
    try {
      return work();
    } finally {
      scope.active = false;
    }
  });
}

/**
 * Cross-process advisory lock via a `<path>.lock` file holding a unique owner
 * lease (`pid:startedAt:token`). Other processes see the file and back off. A
 * valid live PID is never evicted merely because the lease is old: a slow
 * durable write is preferable to split-brain writers. Dead owners are reaped;
 * malformed legacy lock files are reaped only after `STALE_LOCK_MS`.
 *
 * This is advisory — nothing prevents a misbehaving process from
 * writing the file directly. The daemon and CLI both go through this
 * helper, which is the only contract we need.
 */
const STALE_LOCK_MS = 60_000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_WAIT_MS = 10_000;

interface FileGeneration {
  dev: bigint;
  ino: bigint;
}

interface FileLockLease extends FileGeneration {
  ownerToken: string;
}

interface FileLockSnapshot extends FileLockLease {
  ctimeMs: number;
}

interface FileLockDeletionGuard extends FileLockLease {
  path: string;
  ticket: number;
}

interface DeletionGuardMarker {
  path: string;
  ownerToken: string;
  ownerPid: number;
  ticket?: number;
}

function lockFilePath(filePath: string): string {
  return `${filePath}.lock`;
}

function sameFileGeneration(
  left: FileGeneration,
  right: FileGeneration | null,
): boolean {
  return right !== null && left.dev === right.dev && left.ino === right.ino;
}

function readFileLockSnapshot(lockPath: string): FileLockSnapshot | null {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, 'r');
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return null;
    return {
      ownerToken: readFileSync(fd, 'utf-8'),
      dev: stat.dev,
      ino: stat.ino,
      ctimeMs: Number(stat.ctimeMs),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const UUID_TOKEN_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const OWNER_TOKEN_PATTERN = new RegExp(`^([1-9]\\d*):([1-9]\\d*)(?::(${UUID_TOKEN_PATTERN}))?$`, 'i');

function createOwnerToken(): string {
  return `${process.pid}:${Date.now()}:${randomUUID()}`;
}

function lockOwnerPid(ownerToken: string): number | null {
  // Accept the exact historic `pid:startedAt` lease and the current
  // `pid:startedAt:uuid` lease. Prefix parsing is unsafe: e.g. `1garbage`
  // otherwise becomes a forever-live PID 1 lock instead of malformed state.
  const match = OWNER_TOKEN_PATTERN.exec(ownerToken);
  if (!match) return null;
  const pid = Number(match[1]);
  const startedAt = Number(match[2]);
  return Number.isSafeInteger(pid)
    && pid > 0
    && Number.isSafeInteger(startedAt)
    && startedAt > 0
    ? pid
    : null;
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

function lockSnapshotIsStale(snapshot: FileLockSnapshot): boolean {
  const ownerPid = lockOwnerPid(snapshot.ownerToken);
  if (ownerPid !== null) return !isPidAlive(ownerPid);
  return Date.now() - snapshot.ctimeMs > STALE_LOCK_MS;
}

/** Deterministic cross-process seam for the stale-observation/reclaim race. */
function waitAfterStaleLockObservationForTest(): void {
  const marker = process.env.CLEMENTINE_TEST_FILE_LOCK_STALE_OBSERVED_MARKER;
  if (!marker) return;
  const markerFd = openSync(marker, 'w');
  try { writeSync(markerFd, `${process.pid}\n`); } finally { closeSync(markerFd); }
  const release = process.env.CLEMENTINE_TEST_FILE_LOCK_STALE_OBSERVED_RELEASE;
  if (!release) return;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) Atomics.wait(wait, 0, 0, 10);
}

/** Deterministic seam at the decisive check-to-unlink boundary. */
function waitAfterDeletionGuardValidationForTest(): void {
  const marker = process.env.CLEMENTINE_TEST_FILE_LOCK_DELETE_VALIDATED_MARKER;
  if (!marker) return;
  const markerFd = openSync(marker, 'w');
  try { writeSync(markerFd, `${process.pid}\n`); } finally { closeSync(markerFd); }
  const release = process.env.CLEMENTINE_TEST_FILE_LOCK_DELETE_VALIDATED_RELEASE;
  if (!release) return;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) Atomics.wait(wait, 0, 0, 10);
}

function deletionGuardStillOwned(guard: FileLockDeletionGuard): boolean {
  const current = readFileLockSnapshot(guard.path);
  return current !== null
    && current.ownerToken === guard.ownerToken
    && sameFileGeneration(guard, current);
}

function deletionGuardOwnerParts(ownerToken: string): {
  pid: number;
  startedAt: number;
  token: string;
} {
  const match = OWNER_TOKEN_PATTERN.exec(ownerToken);
  if (!match?.[3]) throw new Error('Internal error: deletion guard owner token is malformed.');
  return { pid: Number(match[1]), startedAt: Number(match[2]), token: match[3] };
}

function deletionGuardPrefixes(lockPath: string): { choose: string; ticket: string } {
  const basename = path.basename(lockPath);
  return {
    choose: `${basename}.reclaim-choose.`,
    ticket: `${basename}.reclaim-ticket.`,
  };
}

function parseDeletionGuardMarker(
  directory: string,
  name: string,
  prefixes: { choose: string; ticket: string },
): DeletionGuardMarker | null {
  let ticket: number | undefined;
  let ownerText: string;
  if (name.startsWith(prefixes.choose)) {
    ownerText = name.slice(prefixes.choose.length);
  } else if (name.startsWith(prefixes.ticket)) {
    const rest = name.slice(prefixes.ticket.length);
    const dot = rest.indexOf('.');
    if (dot <= 0) return null;
    ticket = Number(rest.slice(0, dot));
    if (!Number.isSafeInteger(ticket) || ticket <= 0) return null;
    ownerText = rest.slice(dot + 1);
  } else {
    return null;
  }

  const ownerMatch = new RegExp(`^([1-9]\\d*)\\.([1-9]\\d*)\\.(${UUID_TOKEN_PATTERN})$`, 'i')
    .exec(ownerText);
  if (!ownerMatch) return null;
  const ownerPid = Number(ownerMatch[1]);
  const startedAt = Number(ownerMatch[2]);
  if (!Number.isSafeInteger(ownerPid) || !Number.isSafeInteger(startedAt)) return null;
  return {
    path: path.join(directory, name),
    ownerToken: `${ownerPid}:${startedAt}:${ownerMatch[3]}`,
    ownerPid,
    ...(ticket === undefined ? {} : { ticket }),
  };
}

function listDeletionGuardMarkers(lockPath: string): DeletionGuardMarker[] {
  const directory = path.dirname(lockPath);
  const prefixes = deletionGuardPrefixes(lockPath);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names.flatMap((name) => {
    const marker = parseDeletionGuardMarker(directory, name, prefixes);
    return marker ? [marker] : [];
  });
}

function createDeletionGuardMarker(markerPath: string, ownerToken: string): FileLockLease {
  let fd: number | undefined;
  try {
    fd = openSync(markerPath, 'wx', 0o600);
    writeFileSync(fd, ownerToken, 'utf-8');
    const stat = fstatSync(fd, { bigint: true });
    return { ownerToken, dev: stat.dev, ino: stat.ino };
  } catch (err) {
    // The marker name carries an unguessable UUID and is never reused. Cleaning
    // our own failed create cannot erase another contender's generation.
    try { unlinkSync(markerPath); } catch { /* best effort */ }
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function removeUniqueDeletionGuardMarker(markerPath: string): void {
  try { unlinkSync(markerPath); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Lamport bakery ticket for canonical lock deletion. Every marker pathname is
 * immutable and UUID-scoped, so dead contenders can be ignored/cleaned without
 * ever unlinking a newer owner's pathname. A live chooser or lower ticket is
 * never evicted by age. This avoids both the check-then-unlink race of a fixed
 * `.reclaim` file and filesystem hard-link requirements.
 */
function tryAcquireDeletionGuard(lockPath: string): FileLockDeletionGuard | null {
  const ownerToken = createOwnerToken();
  const owner = deletionGuardOwnerParts(ownerToken);
  const prefixes = deletionGuardPrefixes(lockPath);
  const directory = path.dirname(lockPath);
  const ownerName = `${owner.pid}.${owner.startedAt}.${owner.token}`;
  const choosingPath = path.join(directory, `${prefixes.choose}${ownerName}`);
  createDeletionGuardMarker(choosingPath, ownerToken);

  let guard: FileLockDeletionGuard | null = null;
  try {
    const existingTickets = listDeletionGuardMarkers(lockPath)
      .filter((marker) => marker.ticket !== undefined && isPidAlive(marker.ownerPid));
    const maxTicket = existingTickets.reduce(
      (max, marker) => Math.max(max, marker.ticket ?? 0),
      0,
    );
    if (maxTicket >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`Deletion guard ticket space exhausted for ${lockPath}`);
    }
    const ticket = maxTicket + 1;
    const ticketPath = path.join(directory, `${prefixes.ticket}${ticket}.${ownerName}`);
    const lease = createDeletionGuardMarker(ticketPath, ownerToken);
    guard = { path: ticketPath, ticket, ...lease };
    removeUniqueDeletionGuardMarker(choosingPath);

    const markers = listDeletionGuardMarkers(lockPath);
    let blocked = false;
    for (const marker of markers) {
      const live = isPidAlive(marker.ownerPid);
      if (!live) {
        // UUID-scoped names are never reused, so dead-marker cleanup has no
        // stale-observer-versus-replacement pathname race.
        try { removeUniqueDeletionGuardMarker(marker.path); } catch { /* hygiene only */ }
        continue;
      }
      if (marker.ticket === undefined) {
        blocked = true;
        continue;
      }
      if (
        marker.path !== guard.path
        && (marker.ticket < guard.ticket
          || (marker.ticket === guard.ticket && marker.ownerToken < guard.ownerToken))
      ) blocked = true;
    }
    if (blocked || !deletionGuardStillOwned(guard)) {
      releaseDeletionGuard(guard);
      guard = null;
      return null;
    }
    return guard;
  } catch (err) {
    if (guard) {
      try { releaseDeletionGuard(guard); } catch { /* preserve acquisition error */ }
    }
    throw err;
  } finally {
    try { removeUniqueDeletionGuardMarker(choosingPath); } catch { /* own unique marker */ }
  }
}

function releaseDeletionGuard(guard: FileLockDeletionGuard): void {
  // A compliant contender never revokes this live PID's guard. Token + inode
  // still prevent a late finally block from deleting a replacement pathname.
  if (!deletionGuardStillOwned(guard)) return;
  removeUniqueDeletionGuardMarker(guard.path);
}

function tryReapStaleFileLock(
  lockPath: string,
  observed: FileLockSnapshot,
): void {
  const guard = tryAcquireDeletionGuard(lockPath);
  if (!guard) return;
  try {
    const current = readFileLockSnapshot(lockPath);
    const currentOwnerPid = current ? lockOwnerPid(current.ownerToken) : null;
    const currentIsStillStale = current
      ? (currentOwnerPid !== null
          ? !isPidAlive(currentOwnerPid)
          : Date.now() - observed.ctimeMs > STALE_LOCK_MS)
      : false;
    if (
      !current
      || current.ownerToken !== observed.ownerToken
      || !sameFileGeneration(observed, current)
      || !currentIsStillStale
      || !deletionGuardStillOwned(guard)
    ) return;
    waitAfterDeletionGuardValidationForTest();
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  } finally {
    releaseDeletionGuard(guard);
  }
}

function tryAcquireFileLock(filePath: string): FileLockLease | null {
  const lockPath = lockFilePath(filePath);
  const ownerToken = createOwnerToken();
  let fd: number | undefined;
  try {
    // 'wx' fails if the file already exists — atomic create.
    fd = openSync(lockPath, 'wx');
    writeFileSync(fd, ownerToken, 'utf-8');
    fsyncSync(fd);
    const stat = fstatSync(fd, { bigint: true });
    return { ownerToken, dev: stat.dev, ino: stat.ino };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const observed = readFileLockSnapshot(lockPath);
    if (observed && lockSnapshotIsStale(observed)) {
      waitAfterStaleLockObservationForTest();
      tryReapStaleFileLock(lockPath, observed);
    }
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function releaseFileLockOwned(filePath: string, lease: FileLockLease): void {
  const lockPath = lockFilePath(filePath);
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (true) {
    const current = readFileLockSnapshot(lockPath);
    if (
      !current
      || current.ownerToken !== lease.ownerToken
      || !sameFileGeneration(lease, current)
    ) return;

    const guard = tryAcquireDeletionGuard(lockPath);
    if (!guard) {
      if (Date.now() >= deadline) return;
      sleepSync(LOCK_RETRY_MS);
      continue;
    }
    try {
      const guarded = readFileLockSnapshot(lockPath);
      if (
        guarded
        && guarded.ownerToken === lease.ownerToken
        && sameFileGeneration(lease, guarded)
        && deletionGuardStillOwned(guard)
      ) {
        waitAfterDeletionGuardValidationForTest();
        unlinkSync(lockPath);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    } finally {
      releaseDeletionGuard(guard);
    }
    return;
  }
}

function releaseFileLock(filePath: string, lease: FileLockLease): void {
  try {
    releaseFileLockOwned(filePath, lease);
  } catch {
    // The critical section may already have durably committed. Reporting that
    // operation as failed solely because post-commit lock cleanup hit an
    // unsupported/transient filesystem operation invites a duplicate retry.
    // Leave the canonical lease in place (fail closed); a process restart makes
    // its PID stale and the normal generation-safe reaper can recover it.
  }
}

export async function withFileLock<T>(filePath: string, work: () => Promise<T> | T): Promise<T> {
  assertFileLockIsNotReentrant(filePath);
  const inProcessRelease = await acquireInProcessLock(filePath);
  const startedAt = Date.now();
  try {
    let lease = tryAcquireFileLock(filePath);
    while (!lease) {
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
      lease = tryAcquireFileLock(filePath);
    }
    try {
      return await runWithHeldFileLockAsync(filePath, work);
    } finally {
      releaseFileLock(filePath, lease);
    }
  } finally {
    inProcessRelease();
  }
}

/** Park the thread synchronously without burning CPU. Used only by the
 *  sync lock path, where the critical section is a sub-millisecond JSON
 *  read-modify-write, so total park time under contention is tiny. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const SYNC_LOCK_MAX_WAIT_MS = 2_000;

/**
 * Synchronous sibling of {@link withFileLock} for callers whose critical
 * section is itself synchronous and on a hot path that must keep a sync
 * public API (e.g. `SessionStore`'s load-mutate-save on every chat turn).
 *
 * The JS event loop already serializes synchronous work in-process, so —
 * unlike the async variant — this needs no in-process mutex; only the
 * cross-process advisory `.lock` matters. It is **best-effort by
 * contract**: if the lock can't be acquired within `SYNC_LOCK_MAX_WAIT_MS`
 * (a peer crashed mid-write, etc.) the work runs anyway. Any caller pairs
 * this with an atomic temp+rename write, which already guarantees no torn
 * file; the lock only narrows the cross-process lost-update window. We
 * never block a hot turn on a stuck lock.
 */
export function withFileLockSync<T>(filePath: string, work: () => T): T {
  assertFileLockIsNotReentrant(filePath);
  const startedAt = Date.now();
  let lease = tryAcquireFileLock(filePath);
  while (!lease && Date.now() - startedAt < SYNC_LOCK_MAX_WAIT_MS) {
    sleepSync(LOCK_RETRY_MS);
    lease = tryAcquireFileLock(filePath);
  }
  try {
    return runWithHeldFileLockSync(filePath, work);
  } finally {
    if (lease) releaseFileLock(filePath, lease);
  }
}

/**
 * Fail-closed synchronous lock for durable commitments. Unlike the hot-path
 * best-effort variant above, this never runs the mutation without ownership:
 * a timeout is surfaced so callers can retry without risking a lost update.
 */
export function withFileLockSyncStrict<T>(filePath: string, work: () => T): T {
  assertFileLockIsNotReentrant(filePath);
  const startedAt = Date.now();
  let lease = tryAcquireFileLock(filePath);
  while (!lease) {
    if (Date.now() - startedAt > LOCK_MAX_WAIT_MS) {
      throw new BoundaryError({
        kind: 'state.write_failed',
        retryable: true,
        userMessage: `Couldn't get a write lock on ${path.basename(filePath)} — another process may be stuck. Try again.`,
        operatorMessage: `withFileLockSyncStrict timeout after ${LOCK_MAX_WAIT_MS}ms on ${filePath}`,
        context: { filePath, waitedMs: Date.now() - startedAt },
      });
    }
    sleepSync(LOCK_RETRY_MS);
    lease = tryAcquireFileLock(filePath);
  }
  try {
    return runWithHeldFileLockSync(filePath, work);
  } finally {
    releaseFileLock(filePath, lease);
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
