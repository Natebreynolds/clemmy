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
    && owner.token.length > 0
    && typeof owner.acquiredAt === 'string'
    && fileName === `owner-${owner.pid}-${owner.token}.json`;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockTimeoutMs(): number {
  const override = Number.parseInt(process.env.CLEMENTINE_TEST_RUN_RECORD_LOCK_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(override) && override > 0 ? override : 10_000;
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
export function withWorkflowRunRecordLock<T>(filePath: string, work: () => T): T {
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
  const deadline = Date.now() + lockTimeoutMs();
  let acquiredGeneration: DirectoryIdentity | undefined;

  while (!acquiredGeneration) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      const createdGeneration = directoryIdentity(lockDir);
      waitForTestBarrier(
        'CLEMENTINE_TEST_RUN_RECORD_LOCK_MKDIR_READY',
        'CLEMENTINE_TEST_RUN_RECORD_LOCK_MKDIR_RELEASE',
      );
      let fd: number | undefined;
      try {
        fd = openSync(ownerFile, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify({
          pid: process.pid,
          token: ownerToken,
          acquiredAt: new Date().toISOString(),
        }), 'utf-8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
      } finally {
        if (fd !== undefined) {
          try { closeSync(fd); } catch { /* best effort */ }
        }
      }
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
        try { unlinkSync(ownerFile); } catch { /* token belongs to a vanished generation */ }
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
      let corruptEvidence: string | undefined;
      const unexpectedEntries = entries.filter((entry) => !entry.startsWith('owner-'));
      if (unexpectedEntries.length > 0) {
        corruptEvidence = `unexpected lock entries (${unexpectedEntries.join(', ')})`;
      } else if (owners.length > 1) {
        corruptEvidence = `multiple owner records (${owners.join(', ')})`;
      } else if (owners.length === 1) {
        observedOwnerFile = path.join(lockDir, owners[0]);
        try {
          const parsed = JSON.parse(readFileSync(observedOwnerFile, 'utf-8')) as unknown;
          if (validOwner(owners[0], parsed)) ownerPid = parsed.pid;
          else corruptEvidence = `invalid owner record ${owners[0]}`;
        } catch (ownerErr) {
          if ((ownerErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
          corruptEvidence = `unreadable owner record ${owners[0]}`;
        }
      }

      let ageMs: number;
      try { ageMs = Date.now() - statSync(lockDir).mtimeMs; } catch { continue; }
      const deadOwner = ownerPid !== undefined && !pidIsAlive(ownerPid);
      const abandonedBeforeOwnerWrite = entries.length === 0 && ageMs >= EMPTY_LOCK_RECLAIM_MS;
      if (deadOwner || abandonedBeforeOwnerWrite) {
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
