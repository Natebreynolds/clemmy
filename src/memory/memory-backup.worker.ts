/**
 * The memory backup worker: runs the whole publication protocol
 * (memory-backup-protocol.ts) on its own thread and its own connection, so the
 * VACUUM INTO, the checkpoint and any wait for another process's lease never
 * hold the daemon's main thread.
 *
 * It must not import db.ts: `openMemoryDb` would run migrations and load
 * config. The host (memory-backup.ts) has already opened and migrated the
 * database before it starts this worker.
 *
 * Messages to the host, in order:
 *   { kind: 'started' }                     the module (and better-sqlite3) loaded
 *   { kind: 'result', result }              the protocol finished (result may be null)
 *   { kind: 'error', error }                the protocol threw
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import {
  publishMemorySnapshot,
  type BackupResult,
  type MemoryBackupPaths,
  type PublishMemorySnapshotOptions,
} from './memory-backup-protocol.js';

export interface MemoryBackupWorkerData {
  paths: MemoryBackupPaths;
  opts: PublishMemorySnapshotOptions;
}

export type MemoryBackupWorkerMessage =
  | { kind: 'started' }
  | { kind: 'result'; result: BackupResult | null }
  | { kind: 'error'; error: string };

function post(message: MemoryBackupWorkerMessage): void {
  parentPort?.postMessage(message);
}

// Everything this worker needs has loaded; from here on a failure is a failed
// backup, not an unavailable worker.
post({ kind: 'started' });

const { paths, opts } = workerData as MemoryBackupWorkerData;
let source: Database.Database | null = null;
try {
  source = new Database(paths.dbPath, { fileMustExist: true });
  // The main thread keeps writing; a write lock held there for a moment must
  // not fail this connection's reads.
  source.pragma('busy_timeout = 5000');
  const result = publishMemorySnapshot(source, paths, opts);
  post({ kind: 'result', result });
} catch (error) {
  post({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
} finally {
  try { source?.close(); } catch { /* the thread is exiting anyway */ }
}
