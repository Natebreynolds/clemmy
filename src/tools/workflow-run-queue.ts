import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { WORKFLOW_RUNS_DIR } from './shared.js';
import { listWorkflows } from '../memory/workflow-store.js';
import { missingWorkflowRunInputs, normalizeWorkflowRunInputs } from '../execution/workflow-inputs.js';
import { computeResumeState, listFinalFailedItems } from '../execution/workflow-events.js';
import { checkWorkflowRunReadiness, type WorkflowRunReadinessCheck } from '../execution/workflow-run-readiness.js';
import {
  buildWorkflowMutationContractSnapshot,
  isWorkflowMutationContractSnapshot,
  workflowStepMutationReceiptContract,
  type WorkflowMutationContractSnapshot,
} from '../execution/workflow-enforce.js';
import {
  assessWorkflowRunMutationRequeue,
  workflowCallMutationSlotHasLedger,
} from '../execution/workflow-call-receipts.js';
import { withWorkflowRunRecordLock } from '../execution/workflow-run-record.js';

/** Run-record capability marker: this execution was admitted by a runner that
 * enforces fsynced exact-call receipts for every structured mutation. */
export const WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION = 1 as const;

/**
 * Shared workflow-run queueing — the single place that writes a run request
 * to local workflow state. Used by MCP workflow_run, dashboard/legacy UI,
 * mobile, scheduler, trigger dispatch, execution-controller, and
 * plan-continuity resume paths so run record shape, dedupe, and messaging do
 * not drift across surfaces.
 */

function ensureDir(dir: string): void {
  const missing: string[] = [];
  let cursor = dir;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (missing.length > 0) mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') return;
  // Persist every newly-created directory entry, not only the eventual file.
  // A fresh-home power loss must not erase `workflows/runs` after SQLite has
  // terminally accepted a trigger receipt.
  let syncCursor = dir;
  const stop = path.dirname(path.dirname(path.dirname(WORKFLOW_RUNS_DIR)));
  while (true) {
    const createdFd = openSync(syncCursor, 'r');
    try { fsyncSync(createdFd); } finally { closeSync(createdFd); }
    if (syncCursor === stop) break;
    const parent = path.dirname(syncCursor);
    if (parent === syncCursor) break;
    syncCursor = parent;
  }
}

/**
 * Correctness-critical run-queue write. A trigger receipt is accepted only
 * after this returns, so the run record and its receipt id must survive a
 * process crash. Keep updates in the same directory, fsync the file, atomically
 * replace it, then fsync the directory entry.
 */
function writeRunFileDurably(file: string, record: Record<string, unknown>): void {
  const dir = path.dirname(file);
  const dirAlreadyExisted = existsSync(dir);
  ensureDir(dir);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(record, null, 2), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
    // Windows does not reliably allow opening a directory as a file handle.
    // The record itself is still fsynced before atomic replacement there.
    if (process.platform !== 'win32') {
      const dirFd = openSync(dir, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      if (!dirAlreadyExisted) {
        const parentFd = openSync(path.dirname(dir), 'r');
        try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
      }
    }
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort cleanup */ }
    }
    try { unlinkSync(temp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/** Install a brand-new deterministic run without replacing an existing file.
 * A fsynced temporary inode plus an atomic hard-link gives competing trigger
 * claimants one winner; a stale claimant can never overwrite a run that has
 * already advanced to running or terminal. */
function writeNewRunFileDurably(file: string, record: Record<string, unknown>): boolean {
  const dir = path.dirname(file);
  const dirAlreadyExisted = existsSync(dir);
  ensureDir(dir);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.new`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(record, null, 2), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        unlinkSync(temp);
        if (process.platform !== 'win32') {
          const dirFd = openSync(dir, 'r');
          try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
        }
        return false;
      }
      throw err;
    }
    unlinkSync(temp);
    if (process.platform !== 'win32') {
      const dirFd = openSync(dir, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      if (!dirAlreadyExisted) {
        const parentFd = openSync(path.dirname(dir), 'r');
        try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
      }
    }
    return true;
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort cleanup */ }
    }
    try { unlinkSync(temp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

const TRIGGER_RECEIPT_ACCEPTANCE_DIR = path.join(WORKFLOW_RUNS_DIR, '.trigger-receipts');

function triggerReceiptAcceptanceFile(receiptId: string): string {
  const key = createHash('sha256').update(receiptId).digest('hex');
  return path.join(TRIGGER_RECEIPT_ACCEPTANCE_DIR, `${key}.json`);
}

function workflowRunFile(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  if (!safe || safe !== runId) throw new Error(`Invalid workflow run id "${runId}".`);
  return path.join(WORKFLOW_RUNS_DIR, `${safe}.json`);
}

interface TriggerReceiptMarker {
  version: 1 | 2;
  receiptId: string;
  runId: string;
  recordedAt: string;
}

function readWorkflowTriggerReceiptMarker(receiptId: string): TriggerReceiptMarker | null {
  const normalizedReceiptId = normalizedOptionalString(receiptId);
  if (!normalizedReceiptId) return null;
  const file = triggerReceiptAcceptanceFile(normalizedReceiptId);
  if (!existsSync(file)) return null;
  let marker: Partial<TriggerReceiptMarker>;
  try {
    marker = JSON.parse(readFileSync(file, 'utf-8')) as typeof marker;
  } catch (err) {
    throw new Error(`Trigger receipt acceptance marker ${normalizedReceiptId} is corrupt.`, { cause: err });
  }
  if (
    (marker.version !== 1 && marker.version !== 2)
    || marker.receiptId !== normalizedReceiptId
    || typeof marker.runId !== 'string'
    || typeof marker.recordedAt !== 'string'
  ) {
    throw new Error(`Trigger receipt acceptance marker ${normalizedReceiptId} has an invalid shape.`);
  }
  return marker as TriggerReceiptMarker;
}

/** Read an immutable trigger-to-run acceptance marker. V2 is written only
 * after the run file is durable, so it remains terminal proof even after the
 * normal retention reaper deletes that run. Legacy V1 planned markers still
 * require the referenced run to exist. */
export function readWorkflowTriggerReceiptAcceptance(receiptId: string): string | null {
  const marker = readWorkflowTriggerReceiptMarker(receiptId);
  if (!marker) return null;
  const runFile = workflowRunFile(marker.runId);
  if (!existsSync(runFile)) return marker.version === 2 ? marker.runId : null;
  try {
    const run = JSON.parse(readFileSync(runFile, 'utf-8')) as { id?: unknown };
    if (run.id !== marker.runId) {
      throw new Error(`referenced run ${marker.runId} has a mismatched identity`);
    }
  } catch (err) {
    throw new Error(`Trigger receipt ${marker.receiptId} references an unreadable run ${marker.runId}.`, { cause: err });
  }
  // Visibility is not durability: a competing writer's hard link can be read
  // before that writer fsyncs the directory. Promote both proof files and their
  // directory entries before SQLite is allowed to mark the receipt enqueued.
  const runFd = openSync(runFile, 'r');
  try { fsyncSync(runFd); } finally { closeSync(runFd); }
  const markerFile = triggerReceiptAcceptanceFile(marker.receiptId);
  const markerFd = openSync(markerFile, 'r');
  try { fsyncSync(markerFd); } finally { closeSync(markerFd); }
  if (process.platform !== 'win32') {
    for (const dir of [path.dirname(runFile), path.dirname(markerFile)]) {
      const dirFd = openSync(dir, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  }
  if (marker.version === 1) {
    // The legacy marker was created before the run. Its now-verified durable
    // run upgrades that provisional proof to V2 before retention can reap it.
    writeRunFileDurably(markerFile, { ...marker, version: 2 });
  }
  return marker.runId;
}

/** Persist an immutable receipt-to-run marker. New queue records are installed
 * before this marker; a retry can recover that crash window from the receipt id
 * embedded in the immutable initial run record. */
function persistWorkflowTriggerReceiptAcceptance(receiptId: string, runId: string): string {
  const existing = readWorkflowTriggerReceiptMarker(receiptId);
  if (existing) return existing.runId;
  const markerFile = triggerReceiptAcceptanceFile(receiptId);
  const installed = writeNewRunFileDurably(markerFile, {
    version: 2,
    receiptId,
    runId,
    recordedAt: new Date().toISOString(),
  });
  if (!installed) {
    const winner = readWorkflowTriggerReceiptMarker(receiptId);
    if (!winner) throw new Error(`Trigger receipt ${receiptId} lost its atomic run binding.`);
    return winner.runId;
  }
  return runId;
}

function deterministicTriggerRunId(receiptId: string): string {
  return `trigger-${createHash('sha256').update(receiptId).digest('hex').slice(0, 32)}`;
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}

const WORKFLOW_RUN_DEDUPE_LOCKS_DIR = path.join(WORKFLOW_RUNS_DIR, '.dedupe-locks');
const WORKFLOW_RUN_DEDUPE_WAIT = new Int32Array(new SharedArrayBuffer(4));

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

function directoryIdentity(dir: string): DirectoryIdentity {
  const stat = statSync(dir);
  return { dev: stat.dev, ino: stat.ino };
}

function sameDirectoryIdentity(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Deterministic cross-process ABA seam used only by the fault-injection test. */
function waitAfterDedupeLockMkdirForTest(): void {
  const ready = process.env.CLEMENTINE_TEST_DEDUPE_LOCK_MKDIR_READY;
  const release = process.env.CLEMENTINE_TEST_DEDUPE_LOCK_MKDIR_RELEASE;
  if (!ready || !release) return;
  writeFileSync(ready, 'ready', 'utf-8');
  while (!existsSync(release)) Atomics.wait(WORKFLOW_RUN_DEDUPE_WAIT, 0, 0, 10);
}

function waitAfterDedupeLockOwnershipForTest(): void {
  const ready = process.env.CLEMENTINE_TEST_DEDUPE_LOCK_OWNED_READY;
  const release = process.env.CLEMENTINE_TEST_DEDUPE_LOCK_OWNED_RELEASE;
  if (!ready || !release) return;
  writeFileSync(ready, 'ready', 'utf-8');
  while (!existsSync(release)) Atomics.wait(WORKFLOW_RUN_DEDUPE_WAIT, 0, 0, 10);
}

function workflowRunDedupeLockKey(
  workflowName: string,
  inputs: Record<string, string>,
  opts?: QueueWorkflowRunOptions,
): string {
  const material = {
    workflowName,
    inputs: normalizeWorkflowRunInputs(inputs),
    targetStepId: normalizedOptionalString(opts?.targetStepId) ?? null,
    retryFailedItems: retryFailedItemsKey(opts?.retryFailedItems) ?? null,
  };
  return createHash('sha256').update(stableJson(material)).digest('hex');
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

interface WorkflowRunDedupeOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

function validWorkflowRunDedupeOwner(
  fileName: string,
  value: unknown,
): value is WorkflowRunDedupeOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Partial<WorkflowRunDedupeOwner>;
  return Number.isSafeInteger(owner.pid)
    && (owner.pid ?? 0) > 0
    && typeof owner.token === 'string'
    && owner.token.length > 0
    && typeof owner.acquiredAt === 'string'
    && fileName === `owner-${owner.pid}-${owner.token}.json`;
}

function workflowRunDedupeLockTimeoutMs(): number {
  const testOverride = Number.parseInt(process.env.CLEMENTINE_TEST_DEDUPE_LOCK_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(testOverride) && testOverride > 0 ? testOverride : 10_000;
}

/** Serialize the dedupe scan + atomic run install across processes. The lock is
 * deliberately tiny and contains only an owner record; a dead owner is safely
 * reclaimed, while a live owner makes the caller wait rather than double-queue. */
function withWorkflowRunDedupeLock<T>(
  workflowName: string,
  inputs: Record<string, string>,
  opts: QueueWorkflowRunOptions | undefined,
  fn: () => T,
): T {
  ensureDir(WORKFLOW_RUN_DEDUPE_LOCKS_DIR);
  const lockDir = path.join(WORKFLOW_RUN_DEDUPE_LOCKS_DIR, workflowRunDedupeLockKey(workflowName, inputs, opts));
  const ownerToken = randomUUID();
  const ownerFile = path.join(lockDir, `owner-${process.pid}-${ownerToken}.json`);
  const deadline = Date.now() + workflowRunDedupeLockTimeoutMs();
  let acquiredGeneration: DirectoryIdentity | undefined;
  while (true) {
    try {
      mkdirSync(lockDir);
      const createdGeneration = directoryIdentity(lockDir);
      waitAfterDedupeLockMkdirForTest();
      const fd = openSync(ownerFile, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token: ownerToken, acquiredAt: new Date().toISOString() }), 'utf-8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (process.platform !== 'win32') {
        const dirFd = openSync(lockDir, 'r');
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
        const rootFd = openSync(WORKFLOW_RUN_DEDUPE_LOCKS_DIR, 'r');
        try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
      }
      // A stale-owner reclaimer may have removed and recreated the pathname
      // while this creator was paused between mkdir and owner publication.
      // The token alone is insufficient: bind entry to the exact directory
      // generation before entering the scan+install critical section.
      let ownsCreatedGeneration = false;
      try {
        const currentGeneration = directoryIdentity(lockDir);
        const currentOwners = readdirSync(lockDir);
        ownsCreatedGeneration = sameDirectoryIdentity(createdGeneration, currentGeneration)
          && currentOwners.length === 1
          && currentOwners[0] === path.basename(ownerFile);
      } catch { /* generation disappeared while ownership was being verified */ }
      if (!ownsCreatedGeneration) {
        try { unlinkSync(ownerFile); } catch { /* token may belong to a vanished generation */ }
        const lostMarker = process.env.CLEMENTINE_TEST_DEDUPE_LOCK_GENERATION_LOST;
        if (lostMarker) writeFileSync(lostMarker, 'lost', 'utf-8');
        continue;
      }
      acquiredGeneration = createdGeneration;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') continue;
      if (code !== 'EEXIST') throw err;
      let observedGeneration: DirectoryIdentity;
      let ownerFiles: string[];
      try {
        observedGeneration = directoryIdentity(lockDir);
        // Every directory entry is ownership evidence. Treating an unexpected
        // filename as "empty" would let age alone erase malformed evidence.
        ownerFiles = readdirSync(lockDir);
      } catch (observeErr) {
        if ((observeErr as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        if (Date.now() >= deadline) {
          throw new Error(
            `Workflow run dedupe lock for "${workflowName}" has unreadable ownership evidence; refusing to reclaim it.`,
            { cause: observeErr },
          );
        }
        Atomics.wait(WORKFLOW_RUN_DEDUPE_WAIT, 0, 0, 20);
        continue;
      }
      let ownerPid: number | undefined;
      let observedOwnerFile: string | undefined;
      let corruptOwnerEvidence: string | undefined;
      if (ownerFiles.length > 1) {
        corruptOwnerEvidence = `multiple owner records (${ownerFiles.join(', ')})`;
      } else if (ownerFiles.length === 1) {
        observedOwnerFile = path.join(lockDir, ownerFiles[0]);
        try {
          const parsed = JSON.parse(readFileSync(observedOwnerFile, 'utf-8')) as unknown;
          if (validWorkflowRunDedupeOwner(ownerFiles[0], parsed)) {
            ownerPid = parsed.pid;
          } else {
            corruptOwnerEvidence = `invalid owner record ${ownerFiles[0]}`;
          }
        } catch (ownerErr) {
          if ((ownerErr as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
          corruptOwnerEvidence = `unreadable owner record ${ownerFiles[0]}`;
        }
      }
      let lockAgeMs = 0;
      try {
        lockAgeMs = Date.now() - statSync(lockDir).mtimeMs;
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        if (Date.now() >= deadline) {
          throw new Error(
            `Workflow run dedupe lock for "${workflowName}" has unreadable ownership metadata; refusing to reclaim it.`,
            { cause: statErr },
          );
        }
        Atomics.wait(WORKFLOW_RUN_DEDUPE_WAIT, 0, 0, 20);
        continue;
      }
      const deadOwner = ownerPid !== undefined && !processIsAlive(ownerPid);
      // Only a genuinely empty, old generation is the recoverable
      // pre-publication crash window. Once any owner evidence exists, malformed
      // or unreadable evidence is never proof of death and must fail closed.
      const abandonedBeforeOwnerWrite = ownerFiles.length === 0 && lockAgeMs >= 5_000;
      if (deadOwner || abandonedBeforeOwnerWrite) {
        try {
          if (!sameDirectoryIdentity(observedGeneration, directoryIdentity(lockDir))) continue;
        } catch { continue; }
        if (observedOwnerFile) {
          try {
            unlinkSync(observedOwnerFile);
          } catch {
            // Another stale-owner reclaimer won. Never touch the fixed lock
            // directory now: it may already contain a new generation owner.
            continue;
          }
        }
        try {
          if (!sameDirectoryIdentity(observedGeneration, directoryIdentity(lockDir))) continue;
          rmdirSync(lockDir);
          if (process.platform !== 'win32') {
            const rootFd = openSync(WORKFLOW_RUN_DEDUPE_LOCKS_DIR, 'r');
            try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
          }
        } catch { /* another waiter may have reclaimed it */ }
        continue;
      }
      if (Date.now() >= deadline) {
        if (corruptOwnerEvidence) {
          throw new Error(
            `Workflow run dedupe lock for "${workflowName}" has ${corruptOwnerEvidence}; refusing to reclaim without valid dead-owner proof.`,
          );
        }
        throw new Error(`Timed out waiting for workflow run dedupe ownership for "${workflowName}".`);
      }
      Atomics.wait(WORKFLOW_RUN_DEDUPE_WAIT, 0, 0, 20);
    }
  }
  waitAfterDedupeLockOwnershipForTest();
  try {
    return fn();
  } finally {
    let stillOwnsGeneration = false;
    try {
      stillOwnsGeneration = acquiredGeneration !== undefined
        && sameDirectoryIdentity(acquiredGeneration, directoryIdentity(lockDir));
    } catch { /* already reclaimed; never touch a replacement generation */ }
    if (stillOwnsGeneration) {
      let removedExactOwner = false;
      try {
        const parsed = JSON.parse(readFileSync(ownerFile, 'utf-8')) as unknown;
        if (
          validWorkflowRunDedupeOwner(path.basename(ownerFile), parsed)
          && parsed.pid === process.pid
          && parsed.token === ownerToken
          && acquiredGeneration
          && sameDirectoryIdentity(acquiredGeneration, directoryIdentity(lockDir))
        ) {
          unlinkSync(ownerFile);
          removedExactOwner = true;
        }
      } catch { /* malformed/replaced evidence is never erased by release */ }
      if (removedExactOwner) {
        try {
          if (acquiredGeneration && sameDirectoryIdentity(acquiredGeneration, directoryIdentity(lockDir))) {
            rmdirSync(lockDir);
          }
          if (process.platform !== 'win32') {
            const rootFd = openSync(WORKFLOW_RUN_DEDUPE_LOCKS_DIR, 'r');
            try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
          }
        } catch { /* a later caller can reclaim a verified dead-owner lock */ }
      }
    }
  }
}

function findWorkflowRunByTriggerReceiptId(receiptId: string): { id: string; status: string } | null {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return null;
  const matches: Array<{ id: string; status: string }> = [];
  for (const file of readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as {
        id?: unknown;
        status?: unknown;
        triggerReceiptId?: unknown;
      };
      if (parsed.triggerReceiptId !== receiptId) continue;
      matches.push({
        id: typeof parsed.id === 'string' ? parsed.id : path.basename(file, '.json'),
        status: typeof parsed.status === 'string' ? parsed.status : 'queued',
      });
    } catch { /* unrelated corrupt records are handled by their owning path */ }
  }
  if (matches.length > 1) {
    throw new Error(`Trigger receipt ${receiptId} is attached to multiple workflow runs; refusing another queue attempt.`);
  }
  return matches[0] ?? null;
}

export function findDuplicateQueuedWorkflowRun(
  workflowName: string,
  inputs: Record<string, string>,
  excludeRunId?: string,
  opts?: {
    targetStepId?: string;
    retryFailedItems?: QueueWorkflowRunOptions['retryFailedItems'];
  },
): { id: string; status: string } | null {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return null;
  // Normalize BOTH sides so dedupe is correct regardless of whether the
  // caller pre-normalized (url/website aliases must compare equal).
  const wanted = stableJson(normalizeWorkflowRunInputs(inputs));
  const wantedTargetStepId = normalizedOptionalString(opts?.targetStepId);
  const wantedRetryKey = retryFailedItemsKey(opts?.retryFailedItems);
  for (const file of readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json')).sort().reverse()) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as {
        id?: unknown;
        workflow?: unknown;
        inputs?: unknown;
        status?: unknown;
        targetStepId?: unknown;
        retryFailedItemsFromRunId?: unknown;
        retryFailedItemsStepId?: unknown;
        retryFailedItemKeys?: unknown;
      };
      const status = typeof parsed.status === 'string' ? parsed.status : 'queued';
      if (status !== 'queued' && status !== 'running') continue;
      if (parsed.workflow !== workflowName) continue;
      // A requeue-from-run must never see its own SOURCE run as the duplicate
      // (the source is still status:'running' on disk when a goal re-pursuit
      // queues the next attempt mid-completion).
      if (excludeRunId && parsed.id === excludeRunId) continue;
      const existingInputs = normalizeWorkflowRunInputs(
        parsed.inputs && typeof parsed.inputs === 'object' && !Array.isArray(parsed.inputs)
          ? parsed.inputs as Record<string, string>
          : {},
      );
      if (stableJson(existingInputs) !== wanted) continue;
      if (normalizedOptionalString(parsed.targetStepId) !== wantedTargetStepId) continue;
      if (runRecordRetryFailedItemsKey(parsed) !== wantedRetryKey) continue;
      const id = typeof parsed.id === 'string' ? parsed.id : path.basename(file, '.json');
      return { id, status };
    } catch {
      continue;
    }
  }
  return null;
}

function normalizeOriginSessionIds(...values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) add(item);
    }
  };
  for (const value of values) add(value);
  return out;
}

function normalizedOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function uniqueTrimmed(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function retryFailedItemsKey(value: QueueWorkflowRunOptions['retryFailedItems'] | undefined): string | undefined {
  if (!value) return undefined;
  const fromRunId = value.fromRunId.trim();
  const stepId = value.stepId.trim();
  const itemKeys = uniqueTrimmed(value.itemKeys).sort();
  if (!fromRunId || !stepId || itemKeys.length === 0) return undefined;
  return stableJson({ fromRunId, stepId, itemKeys });
}

function runRecordRetryFailedItemsKey(record: {
  retryFailedItemsFromRunId?: unknown;
  retryFailedItemsStepId?: unknown;
  retryFailedItemKeys?: unknown;
}): string | undefined {
  const fromRunId = normalizedOptionalString(record.retryFailedItemsFromRunId);
  const stepId = normalizedOptionalString(record.retryFailedItemsStepId);
  const itemKeys = Array.isArray(record.retryFailedItemKeys)
    ? uniqueTrimmed(record.retryFailedItemKeys.filter((item): item is string => typeof item === 'string')).sort()
    : [];
  if (!fromRunId || !stepId || itemKeys.length === 0) return undefined;
  return stableJson({ fromRunId, stepId, itemKeys });
}

const CONSUMED_TEST_RUN_IDS = new Set<string>();
const RANDOM_RUN_ID_INSTALL_ATTEMPTS = 16;

function createRunId(prefix?: string): string {
  const forcedForTest = normalizedOptionalString(process.env.CLEMENTINE_TEST_QUEUE_RUN_ID_ONCE);
  if (
    forcedForTest
    && forcedForTest === forcedForTest.replace(/[^a-zA-Z0-9_.:-]/g, '')
    && !CONSUMED_TEST_RUN_IDS.has(forcedForTest)
  ) {
    CONSUMED_TEST_RUN_IDS.add(forcedForTest);
    return forcedForTest;
  }
  const suffix = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const safePrefix = normalizedOptionalString(prefix)?.replace(/[^a-zA-Z0-9_.:-]/g, '');
  return safePrefix ? `${safePrefix}-${suffix}` : suffix;
}

function installFreshRandomRunRecord(
  idPrefix: string | undefined,
  buildRecord: (id: string) => Record<string, unknown>,
): { id: string; file: string; record: Record<string, unknown> } {
  for (let attempt = 0; attempt < RANDOM_RUN_ID_INSTALL_ATTEMPTS; attempt += 1) {
    const id = createRunId(idPrefix);
    const file = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
    const record = buildRecord(id);
    if (writeNewRunFileDurably(file, record)) return { id, file, record };
  }
  throw new Error(`Could not allocate a fresh workflow run id after ${RANDOM_RUN_ID_INSTALL_ATTEMPTS} create-only attempts.`);
}

const WORKFLOW_RUN_ORIGINS_DIR = path.join(WORKFLOW_RUNS_DIR, '.run-origins');

function workflowRunOriginDir(runId: string): string {
  const key = createHash('sha256').update(runId).digest('hex');
  return path.join(WORKFLOW_RUN_ORIGINS_DIR, key);
}

/** Read immutable observer sidecars. Duplicate queue requests append these
 * instead of rewriting the live run record and racing the runner's status
 * checkpoint. */
export function readWorkflowRunOriginSessionIds(runId: string): string[] {
  const dir = workflowRunOriginDir(runId);
  if (!existsSync(dir)) return [];
  const origins: string[] = [];
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    let marker: { version?: unknown; runId?: unknown; originSessionId?: unknown };
    try {
      marker = JSON.parse(readFileSync(path.join(dir, file), 'utf-8')) as typeof marker;
    } catch (err) {
      throw new Error(`Workflow run ${runId} has a corrupt origin observer marker.`, { cause: err });
    }
    if (marker.version !== 1 || marker.runId !== runId || typeof marker.originSessionId !== 'string') {
      throw new Error(`Workflow run ${runId} has an invalid origin observer marker.`);
    }
    origins.push(marker.originSessionId);
  }
  return normalizeOriginSessionIds(origins);
}

function attachOriginSessionIdsToRun(runId: string, origins: string[]): void {
  if (origins.length === 0) return;
  const safe = runId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  const file = path.join(WORKFLOW_RUNS_DIR, `${safe}.json`);
  if (!safe || safe !== runId) return;
  // Retention makes its final pending-report decision and unlinks this run
  // under the same record lock. Keep the canonical-record existence check and
  // immutable observer installation in that critical section: otherwise a
  // reaper can observe every known origin acknowledged, then delete the run
  // immediately after this sidecar appears and strand the late observer.
  withWorkflowRunRecordLock(file, () => {
    if (!existsSync(file)) return;
    const dir = workflowRunOriginDir(runId);
    ensureDir(dir);
    for (const originSessionId of normalizeOriginSessionIds(origins)) {
      const key = createHash('sha256').update(originSessionId).digest('hex');
      const installed = writeNewRunFileDurably(path.join(dir, `${key}.json`), {
        version: 1,
        runId,
        originSessionId,
        recordedAt: new Date().toISOString(),
      });
      if (!installed) continue;
    }
  });
}

export interface QueueWorkflowRunResult {
  status: 'queued' | 'duplicate' | 'blocked_readiness';
  id?: string;
  message: string;
  readiness?: WorkflowRunReadinessCheck;
}

export type WorkflowRunRecoveryIntentKind =
  | 'step_try'
  | 'failed_items'
  | 'safe_rerun'
  | 'execution_optimize'
  | 'goal_rerun'
  | 'self_heal'
  | 'manual_requeue';

export interface WorkflowRunRecoveryIntent {
  kind: WorkflowRunRecoveryIntentKind;
  createdAt: string;
  sourceRunId?: string;
  sourceStepId?: string;
  requestedFrom?: string;
  reason?: string;
}

export interface QueueWorkflowRunRecoveryIntentInput {
  kind?: string;
  createdAt?: string;
  sourceRunId?: string;
  sourceStepId?: string;
  requestedFrom?: string;
  reason?: string;
}

const WORKFLOW_RUN_RECOVERY_INTENT_KINDS = new Set<WorkflowRunRecoveryIntentKind>([
  'step_try',
  'failed_items',
  'safe_rerun',
  'execution_optimize',
  'goal_rerun',
  'self_heal',
  'manual_requeue',
]);

function workflowRunRecoveryIntentKind(value: unknown): WorkflowRunRecoveryIntentKind | undefined {
  return typeof value === 'string' && WORKFLOW_RUN_RECOVERY_INTENT_KINDS.has(value as WorkflowRunRecoveryIntentKind)
    ? value as WorkflowRunRecoveryIntentKind
    : undefined;
}

function normalizeWorkflowRunRecoveryIntent(
  input: QueueWorkflowRunRecoveryIntentInput | undefined,
  fallback: QueueWorkflowRunRecoveryIntentInput | undefined,
  createdAt: string,
): WorkflowRunRecoveryIntent | undefined {
  const kind = workflowRunRecoveryIntentKind(input?.kind) ?? workflowRunRecoveryIntentKind(fallback?.kind);
  if (!kind) return undefined;
  const out: WorkflowRunRecoveryIntent = {
    kind,
    createdAt: normalizedOptionalString(input?.createdAt) ?? normalizedOptionalString(fallback?.createdAt) ?? createdAt,
  };
  const sourceRunId = normalizedOptionalString(input?.sourceRunId) ?? normalizedOptionalString(fallback?.sourceRunId);
  const sourceStepId = normalizedOptionalString(input?.sourceStepId) ?? normalizedOptionalString(fallback?.sourceStepId);
  const requestedFrom = normalizedOptionalString(input?.requestedFrom) ?? normalizedOptionalString(fallback?.requestedFrom);
  const reason = normalizedOptionalString(input?.reason) ?? normalizedOptionalString(fallback?.reason);
  if (sourceRunId) out.sourceRunId = sourceRunId;
  if (sourceStepId) out.sourceStepId = sourceStepId;
  if (requestedFrom) out.requestedFrom = requestedFrom;
  if (reason) out.reason = reason;
  return out;
}

/**
 * Write a queued run request for a workflow with already-normalized inputs.
 * Caller is responsible for validating required inputs first (this is the
 * raw queue primitive). Returns a duplicate result without queueing when an
 * identical run is already queued/running.
 */
export interface QueueWorkflowRunOptions {
  /** Gap E: the chat/agent session that should hear the outcome in-context.
   *  Written into the run record so the runner re-enters it on a terminal
   *  state. Omit for scheduled/cron/dashboard/webhook runs (notification-only). */
  originSessionId?: string;
  /** Additional origin chats that requested/observed the same queued/running
   *  work. Backwards-compatible with originSessionId; used only when duplicate
   *  queue requests should also report back to the current chat. */
  originSessionIds?: string[];
  /** Self-heal lineage: how many times this run has already been auto-healed +
   *  re-queued. Carried run→run so the runner can bound auto-heal attempts. */
  selfHealAttempt?: number;
  /** T3.2: the reversible backup snapshotted when the heal was auto-applied.
   *  Carried into the healed re-run so the runner can AUTO-REVERT the fix if
   *  the re-run still fails (a heal that didn't stick must not survive). */
  selfHealBackupId?: string;
  /** Run-goal lineage: how many goal re-pursuits already happened (0 = the
   *  original run). Carried run→run so the runner can bound re-pursuits. */
  goalAttempt?: number;
  /** Validation evidence from the prior unmet attempt — folded into every LLM
   *  step prompt of the re-pursuit so attempt N+1 is targeted, not blind. */
  goalFeedback?: string;
  /** Requeue-from-run: the source run's id, excluded from same-inputs dedupe
   *  (the source is still status:'running' on disk during a mid-completion
   *  re-pursuit queue, and must not count as "already queued"). */
  excludeRunId?: string;
  /** Durable lineage for whole-run requeues, so dashboards can compare attempts
   *  without inferring ancestry from timestamps or matching inputs. */
  requeuedFromRunId?: string;
  /** Failed-item retry lineage: queue a targeted workflow run that inherits
   *  completed upstream work from `fromRunId`, then reprocesses only these
   *  failed forEach item keys for `stepId`. */
  retryFailedItems?: {
    fromRunId: string;
    stepId: string;
    itemKeys: string[];
  };
  /** Origin surface for UI/filtering only (console, mobile, schedule, webhook). */
  source?: string;
  /** Durable trigger-ingestion receipt attached to the accepted run. Recovery
   *  uses it to close the crash window even after the run becomes terminal. */
  triggerReceiptId?: string;
  /** Queue a single-step TRY run. The runner bypasses the enabled gate for these. */
  targetStepId?: string;
  /** Operator-facing lineage for recovery runs: why this queued run exists and
   *  which prior run/step triggered it. */
  recoveryIntent?: QueueWorkflowRunRecoveryIntentInput;
  /** Optional run-id prefix for system-triggered runs such as schedules. */
  idPrefix?: string;
  /** Disable duplicate suppression for sources that intentionally enqueue fresh runs. */
  dedupe?: boolean;
  /** Internal authority used only by the runner after the source execution has
   *  fully settled but before its terminal run record is installed. External
   *  retry surfaces must leave this unset so a live source can never race a
   *  fresh attempt. */
  sourceExecutionSettled?: boolean;
}

const TERMINAL_WORKFLOW_RUN_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'error',
  'failed',
  'cancelled',
]);

function workflowRunIsTerminal(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_WORKFLOW_RUN_STATUSES.has(status);
}

function workflowRunReadinessSnapshot(
  readiness: WorkflowRunReadinessCheck,
  targetStepId?: string,
): Record<string, unknown> {
  return {
    ok: readiness.ok,
    checkedAt: new Date().toISOString(),
    scope: targetStepId ? 'step' : 'run',
    ...(targetStepId ? { targetStepId } : {}),
    blockers: readiness.blockers,
    warnings: readiness.warnings,
    toolReadiness: readiness.plan.toolReadiness,
  };
}

export function queueWorkflowRun(
  name: string,
  normalizedInputs: Record<string, string>,
  opts?: QueueWorkflowRunOptions,
): QueueWorkflowRunResult {
  if (opts?.dedupe === false || normalizedOptionalString(opts?.triggerReceiptId)) {
    return queueWorkflowRunUnlocked(name, normalizedInputs, opts);
  }
  return withWorkflowRunDedupeLock(
    name,
    normalizedInputs,
    opts,
    () => queueWorkflowRunUnlocked(name, normalizedInputs, opts),
  );
}

function queueWorkflowRunUnlocked(
  name: string,
  normalizedInputs: Record<string, string>,
  opts?: QueueWorkflowRunOptions,
): QueueWorkflowRunResult {
  ensureDir(WORKFLOW_RUNS_DIR);
  const triggerReceiptId = normalizedOptionalString(opts?.triggerReceiptId);
  const boundTriggerMarker = triggerReceiptId
    ? readWorkflowTriggerReceiptMarker(triggerReceiptId)
    : null;
  const acceptedTriggerRunId = triggerReceiptId
    ? readWorkflowTriggerReceiptAcceptance(triggerReceiptId)
    : null;
  let triggerBoundRunId = boundTriggerMarker?.runId;
  let duplicate: { id: string; status: string } | null = acceptedTriggerRunId
    ? { id: acceptedTriggerRunId, status: 'accepted' }
    : null;
  if (triggerReceiptId && !duplicate) {
    const receiptRun = findWorkflowRunByTriggerReceiptId(triggerReceiptId);
    if (receiptRun) {
      const bound = persistWorkflowTriggerReceiptAcceptance(triggerReceiptId, receiptRun.id);
      if (bound !== receiptRun.id) {
        throw new Error(`Trigger receipt ${triggerReceiptId} conflicts with workflow runs ${bound} and ${receiptRun.id}.`);
      }
      duplicate = receiptRun;
      triggerBoundRunId = receiptRun.id;
    }
  }
  if (!duplicate && !triggerReceiptId) {
    duplicate = opts?.dedupe === false
      ? null
      : findDuplicateQueuedWorkflowRun(name, normalizedInputs, opts?.excludeRunId, {
        targetStepId: opts?.targetStepId,
        retryFailedItems: opts?.retryFailedItems,
      });
  }
  const origins = normalizeOriginSessionIds(opts?.originSessionId, opts?.originSessionIds);
  if (duplicate) {
    if (triggerReceiptId) {
      const bound = persistWorkflowTriggerReceiptAcceptance(triggerReceiptId, duplicate.id);
      if (bound !== duplicate.id) {
        const accepted = readWorkflowTriggerReceiptAcceptance(triggerReceiptId);
        if (!accepted) {
          throw new Error(
            `Trigger receipt ${triggerReceiptId} has an orphan run binding ${bound} and cannot be rebound to duplicate run ${duplicate.id}.`,
          );
        }
        duplicate = { id: accepted, status: 'accepted' };
      }
    }
    attachOriginSessionIdsToRun(duplicate.id, origins);
    return {
      status: 'duplicate',
      id: duplicate.id,
      message: `Workflow "${name}" is already ${duplicate.status} as run ${duplicate.id} with the same inputs — it's running in the background and will report back here when it finishes. No duplicate was queued; just tell the user it's already on it. (Only call workflow_run_status if the user explicitly asks for a progress check.)`,
    };
  }
  const workflowEntry = listWorkflows().find((entry) => entry.data.name === name || entry.name === name);
  const readinessTargetStepId = opts?.targetStepId ?? opts?.retryFailedItems?.stepId;
  let readiness: WorkflowRunReadinessCheck | undefined;
  if (workflowEntry) {
    readiness = checkWorkflowRunReadiness(workflowEntry.data, workflowEntry.name, {
      targetStepId: readinessTargetStepId,
    });
    if (!readiness.ok) {
      return {
        status: 'blocked_readiness',
        message: readiness.message,
        readiness,
      };
    }
  }
  const createdAt = new Date().toISOString();
  const origin = origins[0];
  const source = normalizedOptionalString(opts?.source);
  const targetStepId = normalizedOptionalString(opts?.targetStepId);
  const requeuedFromRunId = normalizedOptionalString(opts?.requeuedFromRunId);
  const readinessSnapshot = readiness
    ? workflowRunReadinessSnapshot(readiness, normalizedOptionalString(readinessTargetStepId))
    : undefined;
  const selfHealAttempt = typeof opts?.selfHealAttempt === 'number' && opts.selfHealAttempt > 0
    ? opts.selfHealAttempt
    : undefined;
  const goalAttempt = typeof opts?.goalAttempt === 'number' && opts.goalAttempt > 0
    ? opts.goalAttempt
    : undefined;
  const goalFeedback = opts?.goalFeedback?.trim() || undefined;
  const retryFailedItems = opts?.retryFailedItems
    && opts.retryFailedItems.fromRunId.trim()
    && opts.retryFailedItems.stepId.trim()
    && opts.retryFailedItems.itemKeys.length > 0
    ? {
        retryFailedItemsFromRunId: opts.retryFailedItems.fromRunId.trim(),
        retryFailedItemsStepId: opts.retryFailedItems.stepId.trim(),
        retryFailedItemKeys: Array.from(new Set(opts.retryFailedItems.itemKeys.map((k) => k.trim()).filter(Boolean))),
      }
    : undefined;
  const fallbackRecoveryIntent: QueueWorkflowRunRecoveryIntentInput | undefined = targetStepId
    ? {
        kind: 'step_try',
        sourceStepId: targetStepId,
        requestedFrom: source,
        reason: 'single-step try run',
      }
    : retryFailedItems
      ? {
          kind: 'failed_items',
          sourceRunId: retryFailedItems.retryFailedItemsFromRunId,
          sourceStepId: retryFailedItems.retryFailedItemsStepId,
          requestedFrom: source,
          reason: 'retry final failed forEach items',
        }
      : requeuedFromRunId
        ? {
            kind: selfHealAttempt ? 'self_heal' : 'manual_requeue',
            sourceRunId: requeuedFromRunId,
            requestedFrom: source,
            reason: selfHealAttempt ? 'self-heal verification requeue' : 'whole-run requeue',
          }
        : undefined;
  const recoveryIntent = normalizeWorkflowRunRecoveryIntent(opts?.recoveryIntent, fallbackRecoveryIntent, createdAt);
  const buildRunRecord = (runId: string): Record<string, unknown> => ({
    id: runId,
    workflow: name,
    inputs: normalizedInputs,
    status: 'queued',
    mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
    createdAt,
    ...(source ? { source } : {}),
    ...(triggerReceiptId ? { triggerReceiptId } : {}),
    ...(targetStepId ? { targetStepId } : {}),
    ...(requeuedFromRunId ? { requeuedFromRunId } : {}),
    ...(recoveryIntent ? { recoveryIntent } : {}),
    ...(readinessSnapshot ? { readiness: readinessSnapshot } : {}),
    // Only written when present: no origin means notification-only, while
    // chat-dispatched runs can re-enter their originating session on finish.
    ...(origin ? { originSessionId: origin } : {}),
    ...(origins.length > 1 ? { originSessionIds: origins } : {}),
    ...(selfHealAttempt ? { selfHealAttempt } : {}),
    ...(selfHealAttempt && opts?.selfHealBackupId?.trim() ? { selfHealBackupId: opts.selfHealBackupId.trim() } : {}),
    ...(goalAttempt ? { goalAttempt } : {}),
    ...(goalFeedback ? { goalFeedback } : {}),
    ...(retryFailedItems ? retryFailedItems : {}),
  });
  let id: string;
  if (triggerReceiptId) {
    id = triggerBoundRunId ?? deterministicTriggerRunId(triggerReceiptId);
    const runFile = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
    const runRecord = buildRunRecord(id);
    const installed = writeNewRunFileDurably(runFile, runRecord);
    if (!installed) {
      let existingReceiptId: unknown;
      try {
        existingReceiptId = (JSON.parse(readFileSync(runFile, 'utf-8')) as { triggerReceiptId?: unknown }).triggerReceiptId;
      } catch (err) {
        throw new Error(`Existing workflow run ${id} is unreadable during trigger recovery.`, { cause: err });
      }
      if (existingReceiptId !== triggerReceiptId) {
        throw new Error(`Workflow run id ${id} is already owned by a different trigger receipt.`);
      }
    }
    triggerBoundRunId = persistWorkflowTriggerReceiptAcceptance(triggerReceiptId, id);
    if (triggerBoundRunId !== id) {
      throw new Error(`Trigger receipt ${triggerReceiptId} changed run binding during queue installation.`);
    }
    const acceptedRunId = readWorkflowTriggerReceiptAcceptance(triggerReceiptId);
    if (acceptedRunId !== id) {
      throw new Error(`Trigger receipt ${triggerReceiptId} lost ownership while installing workflow run ${id}.`);
    }
    if (!installed) {
      attachOriginSessionIdsToRun(id, origins);
      return {
        status: 'duplicate',
        id,
        ...(readiness ? { readiness } : {}),
        message: `Trigger receipt ${triggerReceiptId} was already accepted by workflow run ${id}; no duplicate was queued.`,
      };
    }
  } else {
    id = installFreshRandomRunRecord(opts?.idPrefix, buildRunRecord).id;
  }
  return {
    status: 'queued',
    id,
    ...(readiness ? { readiness } : {}),
    message:
      `Queued "${name}" (run ${id}) — it is now running in the BACKGROUND. `
      + `Tell the user it's running and that you'll report back here when it finishes; the outcome is delivered to this chat automatically on completion. `
      + `Do NOT wait, poll, or call workflow_run_status, and do NOT do the workflow's work yourself — you're free to take the user's next request right now. `
      + `(Only call workflow_run_status later if the user explicitly asks how it's going.)`,
  };
}

/**
 * Queue a dashboard/operator dry-run request. Dry-runs are deliberately fresh
 * records, not deduped, because they are one-shot preflight checks rather than
 * production work.
 */
export function queueWorkflowDryRun(
  name: string,
  normalizedInputs: Record<string, string>,
  opts?: QueueWorkflowRunOptions,
): QueueWorkflowRunResult {
  ensureDir(WORKFLOW_RUNS_DIR);
  const source = normalizedOptionalString(opts?.source);
  const targetStepId = normalizedOptionalString(opts?.targetStepId);
  const { id } = installFreshRandomRunRecord(opts?.idPrefix, (runId) => ({
    id: runId,
    workflow: name,
    inputs: normalizedInputs,
    status: 'dry_run',
    mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
    createdAt: new Date().toISOString(),
    ...(source ? { source } : {}),
    ...(targetStepId ? { targetStepId } : {}),
  }));
  return {
    status: 'queued',
    id,
    message: `Queued dry-run for "${name}" (run ${id}) — it will preflight without executing workflow steps.`,
  };
}

/**
 * Queue a CREATION TEST run — the real read-only validation that runs once at
 * authoring time (Part B). The runner walks the steps in dependency order,
 * actually EXECUTES the read-only/critical steps (scrape/fetch/query) against
 * the real tools with the run's inputs, and PREVIEWS (does not execute)
 * mutating steps. On pass it auto-enables the workflow; on fail the workflow
 * stays disabled with a one-line reason. Distinct status so the drain loop and
 * report-back can treat it differently from a normal run or a dry_run.
 */
export function queueWorkflowCreationTest(
  name: string,
  normalizedInputs: Record<string, string>,
  opts?: QueueWorkflowRunOptions,
): QueueWorkflowRunResult {
  ensureDir(WORKFLOW_RUNS_DIR);
  const origins = normalizeOriginSessionIds(opts?.originSessionId, opts?.originSessionIds);
  const origin = origins[0];
  const source = normalizedOptionalString(opts?.source);
  const { id } = installFreshRandomRunRecord(opts?.idPrefix, (runId) => ({
    id: runId,
    workflow: name,
    inputs: normalizedInputs,
    status: 'creation_test',
    mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
    createdAt: new Date().toISOString(),
    ...(source ? { source } : {}),
    ...(origin ? { originSessionId: origin } : {}),
    ...(origins.length > 1 ? { originSessionIds: origins } : {}),
  }));
  return {
    status: 'queued',
    id,
    message:
      `Saved "${name}" as DISABLED and started a creation test (run ${id}) — `
      + `it's running the read-only steps now against the real tools to confirm they return data, `
      + `and previewing (not executing) any send/write steps. `
      + `Tell the user it's being tested and that it will auto-enable here on pass (or report what to fix on fail). `
      + `Do NOT wait, poll, or do the work yourself.`,
  };
}

export interface ResumeWorkflowRunResult {
  status: 'queued' | 'duplicate' | 'blocked_readiness' | 'missing_inputs' | 'not_found' | 'disabled';
  id?: string;
  missing?: string[];
  message: string;
  readiness?: WorkflowRunReadinessCheck;
}

/**
 * Resume a workflow run from accumulated inputs (the ask-then-resume path).
 * Looks the workflow up by name, normalizes + validates required inputs, and
 * either queues it or reports exactly which inputs are still missing — so the
 * caller can re-ask without ever falling back into a model-driven retry loop.
 */
export function resumeWorkflowRun(
  name: string,
  rawInputs: Record<string, string>,
  opts?: QueueWorkflowRunOptions,
): ResumeWorkflowRunResult {
  const workflow = listWorkflows().find((entry) => entry.data.name === name);
  if (!workflow) return { status: 'not_found', message: `Workflow "${name}" not found.` };
  if (!workflow.data.enabled) return { status: 'disabled', message: `Workflow "${name}" is disabled.` };
  const normalized = normalizeWorkflowRunInputs(rawInputs);
  const missing = missingWorkflowRunInputs(workflow.data, normalized);
  if (missing.length > 0) {
    return { status: 'missing_inputs', missing, message: `Still missing: ${missing.join(', ')}.` };
  }
  const queued = queueWorkflowRun(name, normalized, opts);
  return { status: queued.status, id: queued.id, message: queued.message, readiness: queued.readiness };
}

export interface RequeueResult {
  status: 'queued' | 'duplicate' | 'blocked_readiness' | 'not_found' | 'no_failed_items' | 'ambiguous';
  id?: string;
  failedItems?: Array<{ stepId: string; itemKey: string; error: string }>;
  message: string;
  readiness?: WorkflowRunReadinessCheck;
}

/**
 * Re-queue a workflow from a PRIOR run's record — the build→fail→fix→re-run
 * loop: after an approved Doctor fix is applied to the workflow definition, run
 * it again with the SAME inputs so the fix is exercised immediately. Reads the
 * prior run file by id; returns not_found if it's gone (best-effort, never
 * throws into the caller — the fix is already applied either way).
 */
export function requeueWorkflowFromRun(
  originalRunId: string,
  opts: QueueWorkflowRunOptions = {},
): RequeueResult {
  const safe = originalRunId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  const file = path.join(WORKFLOW_RUNS_DIR, `${safe}.json`);
  if (!existsSync(file)) {
    return { status: 'not_found', message: `Original run "${originalRunId}" not found; nothing to re-queue.` };
  }
  let rec: {
    workflow?: unknown;
    status?: unknown;
    mutationReceiptProtocolVersion?: unknown;
    mutationContractSnapshot?: unknown;
    inputs?: unknown;
    originSessionId?: unknown;
    originSessionIds?: unknown;
  };
  try {
    rec = JSON.parse(readFileSync(file, 'utf-8')) as typeof rec;
  } catch {
    return { status: 'not_found', message: 'Original run record unreadable; nothing to re-queue.' };
  }
  const workflow = typeof rec.workflow === 'string' ? rec.workflow : undefined;
  if (!workflow) return { status: 'not_found', message: 'Original run record has no workflow name.' };
  if (!workflowRunIsTerminal(rec.status) && opts.sourceExecutionSettled !== true) {
    return {
      status: 'ambiguous',
      message:
        `Run "${originalRunId}" is not terminal, so its execution may still dispatch external work. `
        + 'No overlapping rerun was queued; wait for it to settle or cancel it and verify its final state first.',
    };
  }
  const workflowEntry = listWorkflows().find((entry) => entry.data.name === workflow || entry.name === workflow);
  if (!workflowEntry) {
    return { status: 'not_found', message: `Workflow "${workflow}" no longer exists; no re-run was queued.` };
  }
  const workflowSlug = workflowEntry.name;
  // Resume evidence (what the prior run actually reached) gates the mutation
  // refusals below. Unreadable evidence is fail-closed: we cannot prove the run
  // never dispatched an external mutation, so we refuse.
  let resume: ReturnType<typeof computeResumeState>;
  try {
    resume = computeResumeState(workflowSlug, originalRunId);
  } catch (err) {
    return {
      status: 'ambiguous',
      message:
        `Run "${originalRunId}" has unreadable resume evidence, so a fresh whole-run retry could repeat an external mutation; `
        + `no rerun was queued (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  // A prior run could only have dispatched a step's unreceipted mutation if it
  // actually reached that step: completed it, was mid-flight in it when the run
  // died, or started it and then parked/failed (started-but-unconfirmed). A step
  // the run never reached (it failed at an earlier step) never dispatched, so a
  // fresh whole-run retry cannot repeat that mutation and must not be blocked.
  //
  // BUT the event log is best-effort (appendWorkflowEvent swallows disk
  // failures), so an EMPTY history for a run that actually executed is lost
  // telemetry, NOT proof the run reached nothing. Absence of telemetry is never
  // proof of absence of effect: when the history cannot bound the run's progress
  // at all, every unreceipted mutation must be treated as possibly-reached and
  // blocked (fail closed). A history with any step event is trusted to bound
  // progress and only blocks steps it actually shows were reached.
  const historyBoundsProgress =
    resume.completedSteps.size > 0
    || resume.inFlightStepId !== undefined
    || resume.failedSteps.size > 0;
  const priorRunMayHaveReached = (stepId: string): boolean =>
    !historyBoundsProgress
    || resume.completedSteps.has(stepId)
    || resume.inFlightStepId === stepId
    || resume.failedSteps.has(stepId);
  const unreceiptedMutation = workflowEntry.data.steps.find(
    (step) =>
      workflowStepMutationReceiptContract(step) === 'unreceipted_mutation'
      && priorRunMayHaveReached(step.id),
  );
  if (unreceiptedMutation) {
    return {
      status: 'ambiguous',
      message:
        `Current workflow step "${unreceiptedMutation.id}" mutates external state without a structured direct-call receipt, `
        + 'and the prior run reached that step (completed or started-but-unconfirmed), so a fresh whole-run retry could repeat '
        + 'that mutation; no rerun was queued.',
    };
  }
  const structuredMutationSteps = workflowEntry.data.steps.filter(
    (step) => workflowStepMutationReceiptContract(step) === 'structured_call_receipt',
  );
  const currentMutationSnapshot = buildWorkflowMutationContractSnapshot(workflowEntry.data.steps);
  const sourceUsesMutationReceiptProtocol =
    rec.mutationReceiptProtocolVersion === WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION;
  const sourceMutationSnapshot: WorkflowMutationContractSnapshot | undefined =
    isWorkflowMutationContractSnapshot(rec.mutationContractSnapshot)
      ? rec.mutationContractSnapshot
      : undefined;
  const structuredLedgerSteps = new Set<string>();
  try {
    const receiptAssessment = assessWorkflowRunMutationRequeue({ workflowSlug, runId: originalRunId });
    if (!receiptAssessment.safeToFreshRun) {
      const summary = receiptAssessment.blocking
        .map((item) => `${item.stepId}${item.itemKey ? `:${item.itemKey}` : ''} (${item.status})`)
        .join(', ');
      return {
        status: 'ambiguous',
        message:
          `Run "${originalRunId}" has externally mutating call receipts that cannot be transferred to a fresh run: ${summary}. `
        + 'No rerun was queued. Verify the destination, then start only the downstream/failed work or explicitly start a new run if repeating those mutations is intended.',
      };
    }
    const structuredStepIds = new Set(structuredMutationSteps.map((step) => step.id));
    if (sourceMutationSnapshot) {
      for (const [stepId, contract] of Object.entries(sourceMutationSnapshot.steps)) {
        if (contract === 'structured_call_receipt') structuredStepIds.add(stepId);
      }
    }
    for (const stepId of structuredStepIds) {
      if (workflowCallMutationSlotHasLedger({ workflowSlug, runId: originalRunId, stepId })) {
        structuredLedgerSteps.add(stepId);
      }
    }
  } catch (err) {
    return {
      status: 'ambiguous',
      message: `Run "${originalRunId}" has unreadable mutation receipt evidence; no rerun was queued (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  if (sourceUsesMutationReceiptProtocol && !sourceMutationSnapshot) {
    return {
      status: 'ambiguous',
      message:
        `Run "${originalRunId}" has no valid mutation-contract snapshot from its executing workflow definition. `
        + 'The protocol marker alone cannot prove that a later workflow edit removed or replaced an unreceipted mutation, so no rerun was queued.',
    };
  }
  if (sourceUsesMutationReceiptProtocol && sourceMutationSnapshot) {
    const driftedSourceMutation = Object.entries(sourceMutationSnapshot.steps).find(([stepId, contract]) =>
      currentMutationSnapshot.steps[stepId] !== contract
      && !(contract === 'structured_call_receipt' && structuredLedgerSteps.has(stepId)));
    if (driftedSourceMutation) {
      const [stepId, contract] = driftedSourceMutation;
      return {
        status: 'ambiguous',
        message:
          `Run "${originalRunId}" executed with mutation contract "${stepId}"=${contract}, but the current workflow no longer has that exact contract. `
          + 'Definition drift could hide a prior unreceipted mutation, so no rerun was queued.',
      };
    }
  }
  // Migration belt-and-suspenders: positive legacy completion evidence still
  // blocks a mutating direct call when that source slot predates the receipt
  // protocol. Absence of lifecycle evidence never authorizes an unreceipted
  // mutation (the current-definition gate above owns that decision), while a
  // real proven-no-commit ledger remains retryable even if best-effort events
  // are inconsistent.
  const completedLegacyStructuredMutation = structuredMutationSteps.find((step) =>
    resume.completedSteps.has(step.id) && !structuredLedgerSteps.has(step.id));
  if (completedLegacyStructuredMutation) {
    return {
      status: 'ambiguous',
      message:
        `Run "${originalRunId}" completed mutating direct-call step "${completedLegacyStructuredMutation.id}" before it had durable receipt evidence. `
        + 'A fresh whole-run retry could repeat the legacy mutation, so no rerun was queued.',
    };
  }
  const uncoveredStructuredMutation = structuredMutationSteps.find((step) =>
    !structuredLedgerSteps.has(step.id)
    && !(
      sourceUsesMutationReceiptProtocol
      && sourceMutationSnapshot?.steps[step.id] === 'structured_call_receipt'
    ));
  if (uncoveredStructuredMutation) {
    return {
      status: 'ambiguous',
      message:
        `Run "${originalRunId}" has no matching source mutation contract or exact ledger for current mutating direct-call step "${uncoveredStructuredMutation.id}". `
        + 'An empty best-effort lifecycle log cannot prove that the prior call never dispatched, so no rerun was queued.',
    };
  }
  const inputs = normalizeWorkflowRunInputs(
    rec.inputs && typeof rec.inputs === 'object' && !Array.isArray(rec.inputs)
      ? (rec.inputs as Record<string, string>)
      : {},
  );
  // Carry the original run's chat-origin so the re-run reports back into the
  // SAME chat (closes the deferred report-back gap), unless the caller overrides.
  const originSessionIds = opts.originSessionId || opts.originSessionIds
    ? normalizeOriginSessionIds(opts.originSessionId, opts.originSessionIds)
    : normalizeOriginSessionIds(rec.originSessionId, rec.originSessionIds, readWorkflowRunOriginSessionIds(originalRunId));
  const queued = queueWorkflowRun(workflow, inputs, {
    originSessionId: originSessionIds[0],
    originSessionIds,
    source: opts.source,
    selfHealAttempt: opts.selfHealAttempt,
    selfHealBackupId: opts.selfHealBackupId,
    goalAttempt: opts.goalAttempt,
    goalFeedback: opts.goalFeedback,
    excludeRunId: originalRunId,
    requeuedFromRunId: originalRunId,
    recoveryIntent: opts.recoveryIntent ?? {
      kind: opts.selfHealAttempt ? 'self_heal' : 'manual_requeue',
      sourceRunId: originalRunId,
      requestedFrom: opts.source,
      reason: opts.selfHealAttempt ? 'self-heal verification requeue' : 'whole-run requeue',
    },
  });
  return { status: queued.status, id: queued.id, message: queued.message, readiness: queued.readiness };
}

export function requeueWorkflowFailedItemsFromRun(
  originalRunId: string,
  opts: QueueWorkflowRunOptions & { stepId?: string } = {},
): RequeueResult {
  const safe = originalRunId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  const file = path.join(WORKFLOW_RUNS_DIR, `${safe}.json`);
  if (!existsSync(file)) {
    return { status: 'not_found', message: `Original run "${originalRunId}" not found; no failed items to re-queue.` };
  }
  let rec: {
    workflow?: unknown;
    status?: unknown;
    mutationReceiptProtocolVersion?: unknown;
    mutationContractSnapshot?: unknown;
    inputs?: unknown;
    originSessionId?: unknown;
    originSessionIds?: unknown;
  };
  try {
    rec = JSON.parse(readFileSync(file, 'utf-8')) as typeof rec;
  } catch {
    return { status: 'not_found', message: 'Original run record unreadable; no failed items to re-queue.' };
  }
  const workflow = typeof rec.workflow === 'string' ? rec.workflow : undefined;
  if (!workflow) return { status: 'not_found', message: 'Original run record has no workflow name.' };
  if (!workflowRunIsTerminal(rec.status)) {
    return {
      status: 'ambiguous',
      message:
        `Run "${originalRunId}" is not terminal, so its fan-out may still be processing items. `
        + 'No overlapping failed-item retry was queued; wait for the source run to settle first.',
    };
  }

  const workflowEntry = listWorkflows().find((entry) => entry.data.name === workflow || entry.name === workflow);
  if (!workflowEntry) {
    return { status: 'not_found', message: `Workflow "${workflow}" no longer exists; no failed-item retry was queued.` };
  }
  const workflowSlug = workflowEntry.name;
  const allFailures = listFinalFailedItems(workflowSlug, originalRunId);
  const requestedStep = opts.stepId?.trim();
  const failures = requestedStep ? allFailures.filter((f) => f.stepId === requestedStep) : allFailures;
  if (failures.length === 0) {
    return {
      status: 'no_failed_items',
      message: requestedStep
        ? `Run "${originalRunId}" has no failed forEach items for step "${requestedStep}".`
        : `Run "${originalRunId}" has no failed forEach items to re-run.`,
    };
  }
  const stepIds = Array.from(new Set(failures.map((f) => f.stepId)));
  if (stepIds.length !== 1) {
    return {
      status: 'ambiguous',
      failedItems: failures.map(({ stepId, itemKey, error }) => ({ stepId, itemKey, error })),
      message:
        `Run "${originalRunId}" has failed items in more than one step: ${stepIds.join(', ')}. `
        + `Call again with stepId set to one of those steps so Clementine can re-run that fan-out safely.`,
    };
  }
  const stepId = stepIds[0];
  const retryStep = workflowEntry.data.steps.find((step) => step.id === stepId);
  if (!retryStep) {
    return {
      status: 'ambiguous',
      failedItems: failures.map(({ stepId: failedStepId, itemKey, error }) => ({ stepId: failedStepId, itemKey, error })),
      message: `Current workflow no longer contains failed fan-out step "${stepId}"; no retry was queued.`,
    };
  }
  const mutationContract = workflowStepMutationReceiptContract(retryStep);
  if (mutationContract === 'unreceipted_mutation') {
    return {
      status: 'ambiguous',
      failedItems: failures.map(({ stepId: failedStepId, itemKey, error }) => ({ stepId: failedStepId, itemKey, error })),
      message:
        `Failed fan-out step "${stepId}" mutates external state without per-item structured direct-call receipts. `
        + 'Missing or unreadable external-write telemetry cannot prove that its failed items did not commit, so no retry was queued.',
    };
  }
  if (mutationContract === 'structured_call_receipt') {
    try {
      const retryKeys = new Set(failures.map((failure) => failure.itemKey));
      const receiptAssessment = assessWorkflowRunMutationRequeue({ workflowSlug, runId: originalRunId });
      const unsafeRetry = receiptAssessment.blocking.find((item) =>
        item.stepId === stepId && (item.itemKey === undefined || retryKeys.has(item.itemKey)));
      if (unsafeRetry) {
        return {
          status: 'ambiguous',
          failedItems: failures.map(({ stepId: failedStepId, itemKey, error }) => ({ stepId: failedStepId, itemKey, error })),
          message:
            `Failed item "${unsafeRetry.itemKey ?? '(unknown item)'}" in step "${stepId}" has a ${unsafeRetry.status} external mutation receipt. `
            + 'No retry was queued because the prior provider call may already have committed; verify the destination first.',
        };
      }
      const uncoveredItem = failures.find((failure) =>
        !workflowCallMutationSlotHasLedger({
          workflowSlug,
          runId: originalRunId,
          stepId,
          itemKey: failure.itemKey,
        }));
      const sourceSnapshot = isWorkflowMutationContractSnapshot(rec.mutationContractSnapshot)
        ? rec.mutationContractSnapshot
        : undefined;
      if (sourceSnapshot?.steps[stepId] === 'unreceipted_mutation') {
        return {
          status: 'ambiguous',
          failedItems: failures.map(({ stepId: failedStepId, itemKey, error }) => ({ stepId: failedStepId, itemKey, error })),
          message:
            `Run "${originalRunId}" executed failed-item step "${stepId}" as an unreceipted mutation. `
            + 'A later structured-call ledger cannot prove that the source agentic mutation never committed, so no retry was queued.',
        };
      }
      const matchingSourceContract =
        rec.mutationReceiptProtocolVersion === WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION
        && sourceSnapshot?.steps[stepId] === 'structured_call_receipt';
      if (uncoveredItem && !matchingSourceContract) {
        return {
          status: 'ambiguous',
          failedItems: failures.map(({ stepId: failedStepId, itemKey, error }) => ({ stepId: failedStepId, itemKey, error })),
          message:
            `Run "${originalRunId}" has no matching source mutation contract or exact ledger for failed item "${uncoveredItem.itemKey}" in step "${stepId}". `
            + 'Missing best-effort telemetry cannot prove that its prior call never dispatched, so no retry was queued.',
        };
      }
    } catch (err) {
      return {
        status: 'ambiguous',
        failedItems: failures.map(({ stepId: failedStepId, itemKey, error }) => ({ stepId: failedStepId, itemKey, error })),
        message: `Mutation receipt evidence for run "${originalRunId}" is unreadable; no failed-item retry was queued (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
  }
  const inputs = normalizeWorkflowRunInputs(
    rec.inputs && typeof rec.inputs === 'object' && !Array.isArray(rec.inputs)
      ? (rec.inputs as Record<string, string>)
      : {},
  );
  const originSessionIds = opts.originSessionId || opts.originSessionIds
    ? normalizeOriginSessionIds(opts.originSessionId, opts.originSessionIds)
    : normalizeOriginSessionIds(rec.originSessionId, rec.originSessionIds, readWorkflowRunOriginSessionIds(originalRunId));
  const queued = queueWorkflowRun(workflow, inputs, {
    originSessionId: originSessionIds[0],
    originSessionIds,
    source: opts.source,
    selfHealAttempt: opts.selfHealAttempt,
    goalAttempt: opts.goalAttempt,
    goalFeedback: opts.goalFeedback,
    excludeRunId: originalRunId,
    retryFailedItems: {
      fromRunId: originalRunId,
      stepId,
      itemKeys: failures.map((f) => f.itemKey),
    },
    recoveryIntent: opts.recoveryIntent ?? {
      kind: 'failed_items',
      sourceRunId: originalRunId,
      sourceStepId: stepId,
      requestedFrom: opts.source,
      reason: 'retry final failed forEach items',
    },
  });
  const failedItems = failures.map(({ stepId: failedStepId, itemKey, error }) => ({ stepId: failedStepId, itemKey, error }));
  return {
    status: queued.status,
    id: queued.id,
    failedItems,
    readiness: queued.readiness,
    message: queued.status === 'queued'
      ? `Queued failed-item retry for "${workflow}" step "${stepId}" (${failedItems.length} item${failedItems.length === 1 ? '' : 's'}) as run ${queued.id}. It will reuse completed upstream work and reprocess only the failed items.`
      : queued.message,
  };
}
