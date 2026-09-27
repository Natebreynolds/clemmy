/**
 * The memory backup, off the main thread.
 *
 * `backupMemoryDbAsync` runs the same publication protocol as the synchronous
 * db.ts `backupMemoryDb` (memory-backup-protocol.ts), but in a worker thread on
 * its own connection, so the VACUUM INTO and any wait for another process's
 * lease never hold the daemon's event loop. The snapshot is the same file:
 * compacted, rollback-journal header, same name, same retention, same lease.
 *
 * Contract this module owes its caller (the same one the embedding worker
 * keeps):
 *   - Never throw. Every failure is `null`, which callers already read as
 *     "no snapshot, withhold the mutation".
 *   - Never hang forever. A worker still running after 30 minutes is
 *     terminated (its connections close, which releases the lease) and the
 *     call returns null.
 *   - One backup at a time in this process. Callers asking for the same
 *     nightly day share one publication; any other caller waits for the one in
 *     flight and then runs. While any is queued or running, the synchronous
 *     `backupMemoryDb` returns null instead of sleeping on the lease.
 *   - When a worker cannot start at all, fall back to SQLite's paged backup on
 *     the cached connection, which gives the loop a turn between steps. Never
 *     fall back to a synchronous VACUUM INTO.
 */
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import pino from 'pino';
import { memoryBackupPaths, openMemoryDb } from './db.js';
import {
  MEMORY_BACKUP_LEASE_BUSY_TIMEOUT_MS,
  abandonPublication,
  finishPublication,
  memoryBackupInFlight,
  noteAsyncMemoryBackup,
  openMemoryBackupCoordinator,
  partialPathFor,
  preparePublication,
  validatedLocalDayKey,
  type BackupMemoryDbOptions,
  type BackupResult,
  type MemoryBackupPaths,
  type PublishMemorySnapshotOptions,
} from './memory-backup-protocol.js';
import type { MemoryBackupWorkerData, MemoryBackupWorkerMessage } from './memory-backup.worker.js';

export { memoryBackupInFlight };
export type { BackupMemoryDbOptions, BackupResult };

const logger = pino({ name: 'clementine-next.memory.backup' });

const WORKER_TIMEOUT_MS = 30 * 60_000;
/** Pages per step for the paged fallback: small steps keep each turn short. */
const FALLBACK_PAGES_PER_STEP = 16;
/** A write from another connection restarts a paged backup from page one; a
 *  busy writer can livelock it, so give up after this many restarts. */
const FALLBACK_MAX_RESTARTS = 3;
/** The paged fallback holds the lease on the main thread, so it never waits in
 *  SQLite's busy handler: it retries on a timer instead. */
const FALLBACK_LEASE_POLL_MS = 250;

let queue: Promise<unknown> = Promise.resolve();
const sharedByDay = new Map<string, Promise<BackupResult | null>>();
let workerUnavailableLogged = false;
let workerEntryForTest: URL | null = null;
let pagedBackupRuns = 0;
let lastPagedBackupRestarts = 0;

/**
 * Start the worker next to this module, in whichever form is running: the
 * `.js` entry from the built bundle, or the `.ts` entry from source.
 *
 * From source, `--import tsx` in the worker's execArgv loads the entry but
 * does not map the `.js` import specifiers this codebase uses onto `.ts`
 * files inside a worker, so the entry could not import the protocol. A tiny
 * bootstrap registers tsx through its API first, then imports the entry.
 */
function spawnBackupWorker(data: MemoryBackupWorkerData): Worker {
  if (workerEntryForTest) return new Worker(workerEntryForTest, { workerData: data, execArgv: [] });
  const here = import.meta.url;
  if (!here.endsWith('.ts')) return new Worker(new URL('./memory-backup.worker.js', here), { workerData: data });
  const bootstrap = [
    "const { workerData } = require('node:worker_threads');",
    'import(workerData.tsxApi).then(({ register }) => { register(); return import(workerData.entry); });',
  ].join('\n');
  return new Worker(bootstrap, {
    eval: true,
    workerData: {
      ...data,
      tsxApi: import.meta.resolve('tsx/esm/api'),
      entry: new URL('./memory-backup.worker.ts', here).href,
    },
  });
}

type WorkerOutcome =
  | { kind: 'done'; result: BackupResult | null }
  | { kind: 'unavailable'; reason: string };

function runInWorker(data: MemoryBackupWorkerData): Promise<WorkerOutcome> {
  return new Promise<WorkerOutcome>((resolve) => {
    let worker: Worker;
    try {
      worker = spawnBackupWorker(data);
    } catch (error) {
      resolve({ kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    let started = false;
    let settled = false;
    const finish = (outcome: WorkerOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      logger.warn({ timeoutMs: WORKER_TIMEOUT_MS }, 'memory backup worker timed out; terminating it');
      void worker.terminate().catch(() => { /* already gone */ });
      finish({ kind: 'done', result: null });
    }, WORKER_TIMEOUT_MS);
    timer.unref?.();
    worker.on('message', (message: MemoryBackupWorkerMessage) => {
      if (message.kind === 'started') {
        started = true;
      } else if (message.kind === 'result') {
        finish({ kind: 'done', result: message.result });
      } else if (message.kind === 'error') {
        logger.warn({ err: message.error }, 'memory backup failed in its worker');
        finish({ kind: 'done', result: null });
      }
    });
    // Before 'started', an error or exit means the worker never ran (a missing
    // entry, a module that cannot load): fall back. After it, the backup
    // itself failed: that is a null, not a reason to copy again on this thread.
    worker.on('error', (error) => {
      const reason = error instanceof Error ? error.message : String(error);
      finish(started ? { kind: 'done', result: null } : { kind: 'unavailable', reason });
    });
    worker.on('exit', (code) => {
      finish(started ? { kind: 'done', result: null } : { kind: 'unavailable', reason: `worker exited (${code})` });
    });
  });
}

function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'SQLITE_BUSY' || (error instanceof Error && /database is locked/i.test(error.message));
}

/** Take the cross-process lease without ever sleeping in SQLite's busy
 *  handler on this thread: a zero busy timeout, retried on a timer. */
async function acquireLeaseWithoutBlocking(paths: MemoryBackupPaths): Promise<Database.Database> {
  const deadline = Date.now() + MEMORY_BACKUP_LEASE_BUSY_TIMEOUT_MS;
  for (;;) {
    let coordinator: Database.Database | null = null;
    try {
      coordinator = openMemoryBackupCoordinator(paths, 0);
      coordinator.exec('BEGIN IMMEDIATE');
      return coordinator;
    } catch (error) {
      try { coordinator?.close(); } catch { /* ignore */ }
      if (!isBusyError(error) || Date.now() >= deadline) throw error;
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, FALLBACK_LEASE_POLL_MS); });
  }
}

class PagedBackupRestartLimit extends Error {
  constructor(restarts: number) {
    super(`memory backup restarted ${restarts} times because another connection kept writing`);
  }
}

/**
 * The fallback when no worker can start: SQLite's online backup, a few pages
 * per step with a macrotask turn between steps, on the cached connection
 * (writes through that same connection are mirrored into the copy; a write
 * from any other connection restarts it). The copy keeps the source's WAL
 * header, so it is switched to a rollback journal before the probe, and then
 * published exactly like a VACUUM INTO copy. It is not compacted.
 */
async function pagedFallback(paths: MemoryBackupPaths, opts: PublishMemorySnapshotOptions): Promise<BackupResult | null> {
  let coordinator: Database.Database | null = null;
  let partialPath: string | null = null;
  pagedBackupRuns += 1;
  lastPagedBackupRestarts = 0;
  try {
    coordinator = await acquireLeaseWithoutBlocking(paths);
    const prepared = preparePublication(coordinator, paths, opts);
    if (prepared.done) return prepared.result;
    const source = openMemoryDb();
    partialPath = partialPathFor(prepared.pending);
    let restarts = 0;
    let lastCopied = -1;
    await source.backup(partialPath, {
      progress: ({ totalPages, remainingPages }) => {
        // Every step that makes progress copies more pages than the last one
        // had (source growth through this connection raises both counts
        // equally). A restart starts over from page one, so the count stays
        // put or drops: count that as a restart.
        const copied = totalPages - remainingPages;
        if (lastCopied >= 0 && copied <= lastCopied) {
          restarts += 1;
          lastPagedBackupRestarts = restarts;
          if (restarts >= FALLBACK_MAX_RESTARTS) throw new PagedBackupRestartLimit(restarts);
        }
        lastCopied = copied;
        return FALLBACK_PAGES_PER_STEP;
      },
    });
    const copy = new Database(partialPath);
    try { copy.pragma('journal_mode = DELETE'); } finally { copy.close(); }
    const result = finishPublication(coordinator, paths, opts, prepared.pending, partialPath, () => { partialPath = null; });
    return result;
  } catch (error) {
    if (coordinator) abandonPublication(coordinator, partialPath);
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'memory backup (paged fallback) failed');
    return null;
  } finally {
    try { coordinator?.close(); } catch { /* ignore */ }
  }
}

async function runBackup(opts: BackupMemoryDbOptions, localDayKey: string | null): Promise<BackupResult | null> {
  const publishOpts: PublishMemorySnapshotOptions = {
    retain: Math.max(1, opts.retain ?? 7),
    localDayKey,
    // PASSIVE never takes the writer lock, so the main thread keeps writing.
    checkpoint: 'passive',
    availableBytesForTest: opts._availableBytesForTest,
  };
  // The worker opens the file with fileMustExist and never migrates, so the
  // database must exist and be current before it starts. Cached in the daemon.
  try {
    openMemoryDb();
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'memory backup could not open the memory database');
    return null;
  }
  const paths = memoryBackupPaths();
  const outcome = await runInWorker({ paths, opts: publishOpts });
  if (outcome.kind === 'done') return outcome.result;
  if (!workerUnavailableLogged) {
    workerUnavailableLogged = true;
    logger.warn({ reason: outcome.reason }, 'memory backup worker unavailable; using the paged backup on this thread');
  }
  return pagedFallback(paths, { ...publishOpts, checkpoint: 'none' });
}

/**
 * Back up the memory database without holding the main thread. Same options
 * and result as db.ts `backupMemoryDb`; null on any failure. Never throws.
 */
export function backupMemoryDbAsync(opts: BackupMemoryDbOptions = {}): Promise<BackupResult | null> {
  let localDayKey: string | null;
  try {
    localDayKey = validatedLocalDayKey(opts.localDayKey);
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'memory backup refused an invalid day key');
    return Promise.resolve(null);
  }
  if (localDayKey) {
    const shared = sharedByDay.get(localDayKey);
    if (shared) return shared;
  }
  noteAsyncMemoryBackup(true);
  const settled: Promise<BackupResult | null> = queue
    .then(() => runBackup(opts, localDayKey))
    .catch((error: unknown) => {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'memory backup failed');
      return null;
    })
    .finally(() => {
      noteAsyncMemoryBackup(false);
      if (localDayKey && sharedByDay.get(localDayKey) === settled) sharedByDay.delete(localDayKey);
    });
  queue = settled;
  if (localDayKey) sharedByDay.set(localDayKey, settled);
  return settled;
}

/** Test seam: point the host at another worker entry (null restores it). */
export function _setMemoryBackupWorkerEntryForTest(url: URL | null): void {
  workerEntryForTest = url;
  workerUnavailableLogged = false;
}

/** Test seam: how many paged fallbacks ran, and the restarts the last one saw. */
export function _pagedBackupStatsForTest(): { runs: number; lastRestarts: number } {
  return { runs: pagedBackupRuns, lastRestarts: lastPagedBackupRestarts };
}
