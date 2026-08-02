import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const LOCK_RETRY_MS = 10;
const EMPTY_LOCK_RECLAIM_MS = 5_000;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

interface HeldLock {
  depth: number;
  token: string;
}

const heldLocks = new Map<string, HeldLock>();

function sleepSync(ms: number): void {
  Atomics.wait(LOCK_WAIT, 0, 0, ms);
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

interface LockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

function lockDirectory(filePath: string): string {
  return `${filePath}.record-lock`;
}

function directoryIdentity(dir: string): DirectoryIdentity {
  const stat = statSync(dir);
  return { dev: stat.dev, ino: stat.ino };
}

function sameDirectoryIdentity(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function validOwner(fileName: string, value: unknown): value is LockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Partial<LockOwner>;
  return Number.isSafeInteger(owner.pid)
    && (owner.pid ?? 0) > 0
    && typeof owner.token === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner.token)
    && typeof owner.acquiredAt === 'string'
    && ownerPidFromFileName(fileName) === owner.pid
    && fileName === `owner-${owner.pid}-${owner.token}.json`;
}

function ownerPidFromFileName(fileName: string): number | undefined {
  const match = /^owner-([1-9]\d*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/.exec(fileName);
  if (!match) return undefined;
  const pid = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH is the only affirmative dead-process signal. Permission errors and
    // unknown platform failures stay fail-closed as potentially live owners.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function lockTimeoutMs(callOverride?: number): number {
  if (callOverride !== undefined) {
    return Number.isFinite(callOverride) && callOverride >= 0 ? callOverride : 10_000;
  }
  const envOverride = Number.parseInt(process.env.CLEMENTINE_TEST_RUN_RECORD_LOCK_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(envOverride) && envOverride > 0 ? envOverride : 10_000;
}

export interface WorkflowRunRecordLockOptions {
  /** Zero performs one safe acquisition/reclamation attempt without sleeping. */
  timeoutMs?: number;
}

function waitForTestBarrier(readyEnv: string, releaseEnv: string): void {
  const ready = process.env[readyEnv];
  const release = process.env[releaseEnv];
  if (!ready || !release) return;
  writeFileSync(ready, 'ready', 'utf-8');
  while (!existsSync(release)) sleepSync(LOCK_RETRY_MS);
}

function release(
  lockDir: string,
  ownerFile: string,
  token: string,
  generation: DirectoryIdentity,
): void {
  try {
    if (!sameDirectoryIdentity(generation, directoryIdentity(lockDir))) return;
    const parsed = JSON.parse(readFileSync(ownerFile, 'utf-8')) as unknown;
    if (!validOwner(path.basename(ownerFile), parsed) || parsed.pid !== process.pid || parsed.token !== token) return;
    unlinkSync(ownerFile);
    if (sameDirectoryIdentity(generation, directoryIdentity(lockDir))) rmdirSync(lockDir);
  } catch {
    // Missing, malformed, multi-owner, or replacement-generation evidence all
    // fail closed. A later dead-owner reclaimer can recover a verified token.
  }
}

/**
 * Strict cross-process critical section for one workflow run record.
 *
 * Unlike the generic hot-path sync lock, this never runs the callback after a
 * lock timeout. Terminal state, cancellation, and report acknowledgement are
 * correctness boundaries: unavailable serialization must fail closed.
 */
export function withWorkflowRunRecordLock<T>(
  filePath: string,
  work: () => T,
  options: WorkflowRunRecordLockOptions = {},
): T {
  const key = path.resolve(filePath);
  const held = heldLocks.get(key);
  if (held) {
    held.depth += 1;
    try { return work(); } finally { held.depth -= 1; }
  }

  mkdirSync(path.dirname(key), { recursive: true });
  const token = `${process.pid}:${randomUUID()}`;
  const ownerToken = randomUUID();
  const lockDir = lockDirectory(key);
  const ownerFile = path.join(lockDir, `owner-${process.pid}-${ownerToken}.json`);
  // Publish a complete, fsynced owner record with one rename only after mkdir
  // wins the lock generation. A crash can now leave an empty lock directory or
  // an ignored sibling staging file, never a visible zero-byte owner that every
  // future daemon must treat as ambiguous forever.
  const ownerStagingFile = `${lockDir}.owner-${process.pid}-${ownerToken}.${randomUUID()}.tmp`;
  const ownerRecord = JSON.stringify({
    pid: process.pid,
    token: ownerToken,
    acquiredAt: new Date().toISOString(),
  });
  let ownerStaged = false;
  let publishedGeneration: DirectoryIdentity | undefined;
  const ensureOwnerStaged = (): void => {
    if (ownerStaged) return;
    let fd: number | undefined;
    try {
      fd = openSync(ownerStagingFile, 'wx', 0o600);
      writeFileSync(fd, ownerRecord, 'utf-8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      ownerStaged = true;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
      if (!ownerStaged) {
        try { unlinkSync(ownerStagingFile); } catch { /* best effort */ }
      }
    }
  };
  const deadline = Date.now() + lockTimeoutMs(options.timeoutMs);
  const maxAcquisitionAttempts = options.timeoutMs === 0 ? 3 : Number.POSITIVE_INFINITY;
  let acquisitionAttempts = 0;
  let acquiredGeneration: DirectoryIdentity | undefined;

  try {
    while (!acquiredGeneration) {
      acquisitionAttempts += 1;
      if (acquisitionAttempts > maxAcquisitionAttempts) {
        throw new Error(`Timed out acquiring workflow run record lock for ${path.basename(key)}.`);
      }
      try {
        mkdirSync(lockDir, { mode: 0o700 });
        const createdGeneration = directoryIdentity(lockDir);
        waitForTestBarrier(
          'CLEMENTINE_TEST_RUN_RECORD_LOCK_MKDIR_READY',
          'CLEMENTINE_TEST_RUN_RECORD_LOCK_MKDIR_RELEASE',
        );
        ensureOwnerStaged();
        renameSync(ownerStagingFile, ownerFile);
        ownerStaged = false;
        publishedGeneration = createdGeneration;
        if (process.platform !== 'win32') {
          const dirFd = openSync(lockDir, 'r');
          try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
        }
        let ownsCreatedGeneration = false;
        try {
          const entries = readdirSync(lockDir);
          ownsCreatedGeneration = sameDirectoryIdentity(createdGeneration, directoryIdentity(lockDir))
            && entries.length === 1
            && entries[0] === path.basename(ownerFile);
        } catch { /* pathname generation disappeared */ }
        if (!ownsCreatedGeneration) {
          try {
            unlinkSync(ownerFile);
            publishedGeneration = undefined;
          } catch { /* token belongs to a vanished generation */ }
          continue;
        }
        acquiredGeneration = createdGeneration;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        if (code !== 'EEXIST') throw err;

        let observedGeneration: DirectoryIdentity;
        let owners: string[];
        let entries: string[];
        try {
          observedGeneration = directoryIdentity(lockDir);
          entries = readdirSync(lockDir);
          owners = entries.filter((entry) => entry.startsWith('owner-'));
        } catch {
          continue;
        }
        let observedOwnerFile: string | undefined;
        let ownerPid: number | undefined;
        let legacyIncompleteOwner = false;
        let corruptEvidence: string | undefined;
        const unexpectedEntries = entries.filter((entry) => !entry.startsWith('owner-'));
        if (unexpectedEntries.length > 0) {
          corruptEvidence = `unexpected lock entries (${unexpectedEntries.join(', ')})`;
        } else if (owners.length > 1) {
          corruptEvidence = `multiple owner records (${owners.join(', ')})`;
        } else if (owners.length === 1) {
          observedOwnerFile = path.join(lockDir, owners[0]);
          const encodedOwnerPid = ownerPidFromFileName(owners[0]);
          try {
            const parsed = JSON.parse(readFileSync(observedOwnerFile, 'utf-8')) as unknown;
            if (validOwner(owners[0], parsed)) ownerPid = parsed.pid;
            else {
              try {
                if (encodedOwnerPid !== undefined && statSync(observedOwnerFile).size === 0) {
                  ownerPid = encodedOwnerPid;
                  legacyIncompleteOwner = true;
                }
              } catch { /* exact owner disappeared; generation will be retried */ }
              corruptEvidence = `invalid owner record ${owners[0]}`;
            }
          } catch (ownerErr) {
            if ((ownerErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
            try {
              if (encodedOwnerPid !== undefined && statSync(observedOwnerFile).size === 0) {
                ownerPid = encodedOwnerPid;
                legacyIncompleteOwner = true;
              }
            } catch { /* keep ambiguous evidence fail-closed */ }
            corruptEvidence = `unreadable owner record ${owners[0]}`;
          }
        }

        let ageMs: number;
        try { ageMs = Date.now() - statSync(lockDir).mtimeMs; } catch { continue; }
        const deadOwner = ownerPid !== undefined
          && !pidIsAlive(ownerPid)
          && (!corruptEvidence || ageMs >= EMPTY_LOCK_RECLAIM_MS);
        const abandonedLegacyIncompleteOwner = legacyIncompleteOwner && ageMs >= EMPTY_LOCK_RECLAIM_MS;
        const abandonedBeforeOwnerWrite = entries.length === 0 && ageMs >= EMPTY_LOCK_RECLAIM_MS;
        if (deadOwner || abandonedLegacyIncompleteOwner || abandonedBeforeOwnerWrite) {
          waitForTestBarrier(
            'CLEMENTINE_TEST_RUN_RECORD_LOCK_STALE_READY',
            'CLEMENTINE_TEST_RUN_RECORD_LOCK_STALE_RELEASE',
          );
          try {
            if (!sameDirectoryIdentity(observedGeneration, directoryIdentity(lockDir))) continue;
          } catch { continue; }
          if (observedOwnerFile) {
            try {
              // The pathname contains the exact observed generation token. If a
              // competing reclaimer already removed it, ENOENT means this waiter
              // must stop; it never unlinks a successor's different owner token.
              unlinkSync(observedOwnerFile);
            } catch {
              continue;
            }
          }
          try {
            if (!sameDirectoryIdentity(observedGeneration, directoryIdentity(lockDir))) continue;
            rmdirSync(lockDir);
          } catch { /* another reclaimer or a successor generation won */ }
          continue;
        }

        if (Date.now() >= deadline) {
          if (corruptEvidence) {
            throw new Error(
              `Workflow run record lock for ${path.basename(key)} has ${corruptEvidence}; refusing unsafe reclamation.`,
            );
          }
          throw new Error(`Timed out acquiring workflow run record lock for ${path.basename(key)}.`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }

    waitForTestBarrier(
      'CLEMENTINE_TEST_RUN_RECORD_LOCK_OWNED_READY',
      'CLEMENTINE_TEST_RUN_RECORD_LOCK_OWNED_RELEASE',
    );
    heldLocks.set(key, { depth: 1, token });
    try {
      return work();
    } finally {
      heldLocks.delete(key);
      release(lockDir, ownerFile, ownerToken, acquiredGeneration);
    }
  } finally {
    if (!acquiredGeneration && publishedGeneration) {
      release(lockDir, ownerFile, ownerToken, publishedGeneration);
    }
    if (ownerStaged) {
      try { unlinkSync(ownerStagingFile); } catch { /* best-effort orphan cleanup */ }
    }
  }
}

/** Read the current canonical JSON while the caller holds the run lock. */
export function readWorkflowRunRecordUnlocked<T extends object>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Workflow run record ${path.basename(filePath)} is not a JSON object.`);
  }
  return parsed as T;
}

/** Atomically replace + fsync a run record while the caller holds its lock. */
export function writeWorkflowRunRecordDurablyUnlocked(
  filePath: string,
  record: object,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(record, null, 2), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, filePath);
    if (process.platform !== 'win32') {
      const dirFd = openSync(path.dirname(filePath), 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(temp); } catch { /* already renamed or best-effort cleanup */ }
  }
}

/** Test/diagnostic read serialized with every correctness-critical writer. */
export function readWorkflowRunRecord<T extends object>(filePath: string): T | null {
  return withWorkflowRunRecordLock(filePath, () => readWorkflowRunRecordUnlocked<T>(filePath));
}

/**
 * Atomic point-in-time read for broad maintenance inventory. Record writers
 * publish with rename, so a scan sees the complete old or complete new value;
 * any later mutation still takes the strict lock and re-reads authoritative
 * state. This path deliberately never creates, fsyncs, waits on, or reclaims a
 * lock while enumerating a potentially large workflow corpus.
 */
export function readWorkflowRunRecordSnapshot<T extends object>(filePath: string): T | null {
  try { return readWorkflowRunRecordUnlocked<T>(filePath); }
  catch { return null; }
}

export interface WorkflowRunRecordTryRead<T extends object> {
  acquired: boolean;
  record: T | null;
}

/**
 * Maintenance-scan read that never sleeps on the daemon event loop. A busy or
 * ambiguous record is skipped for this tick and retried by the next one.
 */
export function tryReadWorkflowRunRecord<T extends object>(filePath: string): WorkflowRunRecordTryRead<T> {
  try {
    return {
      acquired: true,
      record: withWorkflowRunRecordLock(
        filePath,
        () => readWorkflowRunRecordUnlocked<T>(filePath),
        { timeoutMs: 0 },
      ),
    };
  } catch {
    return { acquired: false, record: null };
  }
}
