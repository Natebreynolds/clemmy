/**
 * The memory backup publication protocol, as a pure function of a source
 * connection and explicit paths.
 *
 * It is the body that used to live inside db.ts `backupMemoryDb`, moved here so
 * the SAME protocol can run on the main thread (the synchronous callers) and in
 * a worker thread (memory-backup.worker.ts, on its own connection), without the
 * worker importing db.ts: `openMemoryDb` would run migrations and load config.
 * This module therefore imports nothing from the rest of the app.
 *
 * The protocol, in order, all under one cross-process lease:
 *   1. BEGIN IMMEDIATE on the coordinator database (process death releases it)
 *   2. remove orphaned partials
 *   3. keyed nightly reuse, or re-adoption after a crash between rename and record
 *   4. free-space guard
 *   5. optional WAL checkpoint
 *   6. VACUUM INTO a unique partial
 *   7. readable probe, fsync, atomic rename, directory fsync
 *   8. record the keyed publication, prune, COMMIT
 */
import Database from 'better-sqlite3';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  statfsSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface BackupResult {
  backupPath: string;
  bytes: number;
  /** True when another process already published the requested keyed snapshot. */
  reused: boolean;
}

export interface BackupMemoryDbOptions {
  retain?: number;
  /**
   * Local calendar day for the nominal nightly snapshot. Supplying this opts
   * into cross-process, once-per-day reuse. Backup-first repair callers must
   * omit it so every mutation still receives a fresh rollback point.
   */
  localDayKey?: string;
  /** Test-only free-space observation. Honored only outside the real default
   * home so production callers cannot bypass the filesystem measurement. */
  _availableBytesForTest?: number;
}

export interface MemoryBackupPaths {
  dbPath: string;
  backupDir: string;
  coordinatorPath: string;
  stateDir: string;
}

export interface PublishMemorySnapshotOptions {
  retain: number;
  /** Already validated (see validatedLocalDayKey); null for a repair snapshot. */
  localDayKey: string | null;
  /**
   * 'truncate' folds the WAL back and resets it, taking the writer lock: only
   * for the synchronous main-thread caller, as before. 'passive' never takes
   * the writer lock, so a worker can run it while the main thread writes.
   * 'none' leaves the WAL alone (VACUUM INTO and the backup API read WAL frames
   * anyway).
   */
  checkpoint: 'truncate' | 'passive' | 'none';
  availableBytesForTest?: number;
}

// The real default home (~/.clementine-next): the test-only free-space
// override is refused against it.
const REAL_DEFAULT_HOME = path.join(os.homedir(), '.clementine-next');
const MEMORY_BACKUP_MIN_SAFETY_MARGIN_BYTES = 64 * 1024 * 1024;
/** A multi-gigabyte VACUUM can legitimately take minutes. SQLite owns the wait
 *  and drops the lock automatically if the winner exits or is SIGKILLed. */
export const MEMORY_BACKUP_LEASE_BUSY_TIMEOUT_MS = 300_000;

// ── In-process flight ──────────────────────────────────────────────────────
// Set by the async host (memory-backup.ts) from the moment an async backup is
// queued until it settles. Kept here, not in the host, so db.ts can read it
// without importing the host (which imports db.ts).
let asyncBackupsInFlight = 0;

/** True while an async backup is queued or running in THIS process. */
export function memoryBackupInFlight(): boolean {
  return asyncBackupsInFlight > 0;
}

/** For the async host only. */
export function noteAsyncMemoryBackup(active: boolean): void {
  asyncBackupsInFlight = Math.max(0, asyncBackupsInFlight + (active ? 1 : -1));
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface BackupPublicationRow {
  backup_path: string;
  bytes: number;
  mtime_ms: number;
}

function fileBytesOrZero(filePath: string): number {
  try {
    const stat = statSync(filePath);
    return stat.isFile() ? Math.max(0, stat.size) : 0;
  } catch {
    return 0;
  }
}

/** VACUUM INTO needs room for a complete logical image while the live DB and
 * WAL remain in place. Size the guard from the actual source, not a constant;
 * the larger of 64 MiB or 10% absorbs SQLite/filesystem publication overhead. */
export function requiredMemoryBackupFreeBytesFor(dbPath: string): number {
  const sourceBytes = fileBytesOrZero(dbPath) + fileBytesOrZero(`${dbPath}-wal`);
  const safetyMargin = Math.max(
    MEMORY_BACKUP_MIN_SAFETY_MARGIN_BYTES,
    Math.ceil(sourceBytes * 0.1),
  );
  return sourceBytes + safetyMargin;
}

export function validatedLocalDayKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid memory backup localDayKey: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid memory backup localDayKey: ${value}`);
  }
  return value;
}

export function openMemoryBackupCoordinator(
  paths: MemoryBackupPaths,
  busyTimeoutMs: number = MEMORY_BACKUP_LEASE_BUSY_TIMEOUT_MS,
): Database.Database {
  if (!existsSync(paths.backupDir)) mkdirSync(paths.backupDir, { recursive: true });
  const coordinator = new Database(paths.coordinatorPath);
  try {
    coordinator.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    coordinator.pragma('synchronous = FULL');
    coordinator.exec(`
      CREATE TABLE IF NOT EXISTS backup_publications (
        backup_key  TEXT PRIMARY KEY,
        backup_path TEXT NOT NULL,
        bytes       INTEGER NOT NULL,
        mtime_ms    REAL NOT NULL,
        published_at TEXT NOT NULL
      )
    `);
  } catch (error) {
    coordinator.close();
    throw error;
  }
  return coordinator;
}

export function snapshotBytesIfReadable(snapshotPath: string): number | null {
  try {
    const stat = statSync(snapshotPath);
    if (!stat.isFile() || stat.size <= 0) return null;
    const probe = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      const hasFacts = probe.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'consolidated_facts'",
      ).get();
      if (!hasFacts) return null;
      // VACUUM INTO returning successfully is SQLite's consistency boundary.
      // Touch one canonical page before publication/re-adoption so an empty or
      // foreign SQLite file cannot masquerade as a memory snapshot. Full
      // integrity_check remains restore-time policy; doing it for every loser
      // would re-read a multi-gigabyte file N times.
      probe.prepare('SELECT id FROM consolidated_facts LIMIT 1').get();
      return stat.size;
    } finally {
      probe.close();
    }
  } catch {
    return null;
  }
}

function recordedSnapshotBytes(
  coordinator: Database.Database,
  backupKey: string,
  backupPath: string,
): number | null {
  const row = coordinator.prepare(`
    SELECT backup_path, bytes, mtime_ms
      FROM backup_publications
     WHERE backup_key = ?
  `).get(backupKey) as BackupPublicationRow | undefined;
  if (!row || row.backup_path !== backupPath) return null;
  try {
    const stat = statSync(backupPath);
    return stat.isFile() && stat.size === row.bytes && stat.mtimeMs === row.mtime_ms
      ? row.bytes
      : null;
  } catch {
    return null;
  }
}

function recordBackupPublication(
  coordinator: Database.Database,
  backupKey: string,
  backupPath: string,
  bytes: number,
): void {
  const stat = statSync(backupPath);
  coordinator.prepare(`
    INSERT INTO backup_publications
      (backup_key, backup_path, bytes, mtime_ms, published_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(backup_key) DO UPDATE SET
      backup_path = excluded.backup_path,
      bytes = excluded.bytes,
      mtime_ms = excluded.mtime_ms,
      published_at = excluded.published_at
  `).run(backupKey, backupPath, bytes, stat.mtimeMs, new Date().toISOString());
}

function cleanupOrphanedBackupPartials(backupDir: string): void {
  for (const filename of readdirSync(backupDir)) {
    if (!filename.startsWith('memory-') || !filename.includes('.db.partial-')) continue;
    try { unlinkSync(path.join(backupDir, filename)); } catch { /* best effort */ }
  }
}

function pruneMemoryBackups(backupDir: string, retain: number, protectedPath: string): void {
  const protectedName = path.basename(protectedPath);
  const backups = readdirSync(backupDir)
    .filter((filename) => filename.startsWith('memory-') && filename.endsWith('.db'))
    .sort();
  let excess = Math.max(0, backups.length - retain);
  for (const filename of backups) {
    if (excess <= 0) break;
    // The snapshot returned to this caller must still exist when the lease is
    // released, even if an unusual retain/key combination makes it sort old.
    if (filename === protectedName) continue;
    try {
      unlinkSync(path.join(backupDir, filename));
      excess -= 1;
    } catch { /* best effort */ }
  }
}

function fsyncBackupPublication(backupDir: string, backupPath: string): void {
  try {
    const file = openSync(backupPath, 'r');
    try { fsyncSync(file); } finally { closeSync(file); }
  } catch { /* SQLite already closed the snapshot; durability sync is best effort */ }
  try {
    const dir = openSync(backupDir, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { /* directory fsync is unavailable on some platforms */ }
}

function testFreeSpaceOverrideAllowed(paths: MemoryBackupPaths): boolean {
  return path.dirname(paths.stateDir) !== REAL_DEFAULT_HOME
    && (process.env.NODE_TEST_CONTEXT !== undefined
      || process.env.CLEMMY_TEST_ISOLATED_HOME === '1');
}

// ── The protocol, in steps the synchronous and paged paths share ──────────

/** The publication this lease will produce, once reuse and space allow it. */
export interface PendingPublication {
  backupKey: string | null;
  backupPath: string;
}

/**
 * Steps 2-4, with the lease already held. Returns either a finished outcome
 * (keyed reuse: committed; not enough space: rolled back, null) or the
 * publication to produce.
 */
export function preparePublication(
  coordinator: Database.Database,
  paths: MemoryBackupPaths,
  opts: PublishMemorySnapshotOptions,
): { done: true; result: BackupResult | null } | { done: false; pending: PendingPublication } {
  const retain = Math.max(1, opts.retain);
  cleanupOrphanedBackupPartials(paths.backupDir);

  const backupKey = opts.localDayKey ? `nightly:${opts.localDayKey}` : null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = opts.localDayKey
    ? `memory-${opts.localDayKey}-nightly.db`
    : `memory-${stamp}-${randomUUID().slice(0, 8)}.db`;
  const backupPath = path.join(paths.backupDir, filename);

  if (backupKey) {
    let bytes = recordedSnapshotBytes(coordinator, backupKey, backupPath);
    if (bytes === null && existsSync(backupPath)) {
      // Covers SIGKILL after atomic rename but before the coordinator row
      // committed: re-adopt the complete deterministic publication.
      bytes = snapshotBytesIfReadable(backupPath);
      if (bytes === null) {
        const quarantine = `${backupPath}.corrupt-${stamp}-${randomUUID().slice(0, 8)}`;
        renameSync(backupPath, quarantine);
      }
    }
    if (bytes !== null) {
      recordBackupPublication(coordinator, backupKey, backupPath, bytes);
      // Reuse/re-adoption is still a maintenance pass. Repair snapshots may
      // have accumulated since the nightly was first published, so restore
      // the requested bound before releasing the same lease that protects
      // publication. Never prune the snapshot this caller is returning.
      pruneMemoryBackups(paths.backupDir, retain, backupPath);
      coordinator.exec('COMMIT');
      return { done: true, result: { backupPath, bytes, reused: true } };
    }
  }

  // Disk-full guard: a VACUUM INTO snapshot needs room for a full copy. It
  // intentionally runs AFTER keyed reuse, because returning an already-
  // published nightly snapshot needs no free-space headroom. Best-effort only
  // when statfs itself is unavailable; a measured volume must cover the current
  // DB+WAL image plus a proportional safety margin.
  try {
    const freeBytes = opts.availableBytesForTest !== undefined && testFreeSpaceOverrideAllowed(paths)
      ? opts.availableBytesForTest
      : (() => {
          const fsStat = statfsSync(paths.stateDir);
          return fsStat.bavail * fsStat.bsize;
        })();
    if (!Number.isFinite(freeBytes) || freeBytes < requiredMemoryBackupFreeBytesFor(paths.dbPath)) {
      coordinator.exec('ROLLBACK');
      return { done: true, result: null };
    }
  } catch { /* statfs unsupported — fall through and let the write try */ }

  return { done: false, pending: { backupKey, backupPath } };
}

/** A unique, unpublished name next to the final one. */
export function partialPathFor(pending: PendingPublication): string {
  return `${pending.backupPath}.partial-${process.pid}-${randomUUID()}`;
}

/**
 * Steps 7-8: probe, fsync, rename, directory fsync, record, prune, COMMIT.
 * `onRenamed` fires once the partial no longer exists under its own name, so
 * the caller's cleanup never deletes a published snapshot.
 */
export function finishPublication(
  coordinator: Database.Database,
  paths: MemoryBackupPaths,
  opts: PublishMemorySnapshotOptions,
  pending: PendingPublication,
  partialPath: string,
  onRenamed: () => void,
): BackupResult {
  const bytes = snapshotBytesIfReadable(partialPath);
  if (bytes === null) throw new Error('memory backup snapshot is empty or unreadable');
  fsyncBackupPublication(paths.backupDir, partialPath);
  renameSync(partialPath, pending.backupPath);
  onRenamed();
  fsyncBackupPublication(paths.backupDir, pending.backupPath);

  if (pending.backupKey) recordBackupPublication(coordinator, pending.backupKey, pending.backupPath, bytes);
  pruneMemoryBackups(paths.backupDir, Math.max(1, opts.retain), pending.backupPath);
  coordinator.exec('COMMIT');
  return { backupPath: pending.backupPath, bytes, reused: false };
}

/** Undo a lease that did not publish: roll back, remove the partial. */
export function abandonPublication(coordinator: Database.Database, partialPath: string | null): void {
  if (coordinator.open && coordinator.inTransaction) {
    try { coordinator.exec('ROLLBACK'); } catch { /* process-local cleanup */ }
  }
  if (partialPath) {
    for (const file of [partialPath, `${partialPath}-journal`, `${partialPath}-wal`, `${partialPath}-shm`]) {
      try { if (existsSync(file)) unlinkSync(file); } catch { /* next lease cleans it */ }
    }
  }
}

function checkpointSource(source: Database.Database, mode: PublishMemorySnapshotOptions['checkpoint']): void {
  if (mode === 'none') return;
  // Best-effort — a busy checkpoint is not fatal to the backup itself.
  try { source.pragma(mode === 'truncate' ? 'wal_checkpoint(TRUNCATE)' : 'wal_checkpoint(PASSIVE)'); } catch { /* best effort */ }
}

/**
 * Tier C2 — disaster-recovery backup of the memory DB. Unlike the vault
 * (rebuildable from markdown), `consolidated_facts`/`entities`/`embeddings`
 * are NOT derivable from anything on disk — a corrupt memory.db loses the
 * agent's whole long-term memory. This writes a consistent, defragmented
 * snapshot and prunes to the newest `retain` copies.
 *
 * `VACUUM INTO` (vs a raw file copy) is atomic and consistent under WAL — it
 * serializes a clean page image as of the moment its read transaction starts,
 * so the backup is never a torn mid-write file.
 *
 * Synchronous on whichever thread calls it. `source` may be a getter so the
 * main-thread caller opens its cached connection only once a VACUUM is really
 * needed, exactly as before. Never throws: null means no snapshot.
 */
export function publishMemorySnapshot(
  source: Database.Database | (() => Database.Database),
  paths: MemoryBackupPaths,
  opts: PublishMemorySnapshotOptions,
): BackupResult | null {
  try {
    if (!existsSync(paths.backupDir)) mkdirSync(paths.backupDir, { recursive: true });
    const coordinator = openMemoryBackupCoordinator(paths);
    let partialPath: string | null = null;
    try {
      // BEGIN IMMEDIATE is the one cross-process ownership point for BOTH
      // snapshot publication and retention. OS process death releases it;
      // no stale PID/mtime lock-stealing protocol is required.
      coordinator.exec('BEGIN IMMEDIATE');
      const prepared = preparePublication(coordinator, paths, opts);
      if (prepared.done) return prepared.result;

      const db = typeof source === 'function' ? source() : source;
      checkpointSource(db, opts.checkpoint);

      partialPath = partialPathFor(prepared.pending);
      // VACUUM refuses an existing target and writes a consistent source
      // snapshot. The unpublished unique partial is renamed only after the
      // operation closes successfully and its canonical schema is readable.
      db.exec(`VACUUM INTO '${partialPath.replace(/'/g, "''")}'`);
      return finishPublication(coordinator, paths, opts, prepared.pending, partialPath, () => { partialPath = null; });
    } catch (error) {
      abandonPublication(coordinator, partialPath);
      throw error;
    } finally {
      coordinator.close();
    }
  } catch {
    return null;
  }
}
