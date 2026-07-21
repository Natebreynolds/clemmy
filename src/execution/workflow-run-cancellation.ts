import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import {
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
  writeWorkflowRunRecordDurablyUnlocked,
} from './workflow-run-record.js';

export interface WorkflowRunCancellationRequest {
  version: 1;
  runId: string;
  requestedAt: string;
  reason: string;
  source: string;
}

export type WorkflowRunTerminalStatus =
  | 'completed'
  | 'completed_with_errors'
  | 'error'
  | 'failed'
  | 'cancelled'
  | 'dry_run'
  | 'creation_test';

type WorkflowRunProjection = Record<string, unknown> & {
  id?: unknown;
  workflow?: unknown;
  status?: unknown;
  cancelledAt?: unknown;
  finishedAt?: unknown;
  error?: unknown;
};

export type CancelWorkflowRunResult =
  | { status: 'cancelled'; request: WorkflowRunCancellationRequest; run: WorkflowRunProjection }
  | { status: 'already_cancelled'; request?: WorkflowRunCancellationRequest; run: WorkflowRunProjection }
  | { status: 'already_terminal'; terminalStatus: Exclude<WorkflowRunTerminalStatus, 'cancelled'>; run: WorkflowRunProjection }
  | { status: 'not_found' }
  | { status: 'workflow_mismatch'; run: WorkflowRunProjection };

const CANCELLATION_DIR = path.join(WORKFLOW_RUNS_DIR, '.cancellations');
const TERMINAL_STATUSES = new Set<WorkflowRunTerminalStatus>([
  'completed',
  'completed_with_errors',
  'error',
  'failed',
  'cancelled',
  'dry_run',
  'creation_test',
]);

/** A run in one of the terminal states — nothing to cancel/cleanup. Exported
 *  for the workflow-lifecycle cleanup (delete/disable) and tests. */
export function isTerminalWorkflowRunStatus(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_STATUSES.has(status as WorkflowRunTerminalStatus);
}

let beforeCancellationLockForTests: (() => void) | undefined;

/** Deterministic seam: runs after the optimistic route read and before the
 * shared terminal/cancellation lock is acquired. */
export function _setWorkflowRunCancellationBeforeLockForTests(hook?: () => void): void {
  beforeCancellationLockForTests = hook;
}

function runFile(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  if (!safe || safe !== runId) throw new Error('Invalid workflow run id.');
  return path.join(WORKFLOW_RUNS_DIR, `${safe}.json`);
}

function cancellationFile(runId: string): string {
  return path.join(CANCELLATION_DIR, `${createHash('sha256').update(runId).digest('hex')}.json`);
}

function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function promoteExistingCancellationDurability(file: string): void {
  const fd = openSync(file, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(CANCELLATION_DIR);
  syncDirectory(WORKFLOW_RUNS_DIR);
}

function normalizeCancellationRequest(
  runId: string,
  reason: string,
  source: string,
): WorkflowRunCancellationRequest {
  return {
    version: 1,
    runId,
    requestedAt: new Date().toISOString(),
    reason: reason.trim().slice(0, 500) || 'Workflow run cancelled.',
    source: source.trim().slice(0, 100) || 'unknown',
  };
}

function installCancellationReceiptUnlocked(
  runId: string,
  reason: string,
  source: string,
): WorkflowRunCancellationRequest {
  const existing = readWorkflowRunCancellation(runId);
  if (existing) {
    promoteExistingCancellationDurability(cancellationFile(runId));
    return existing;
  }

  mkdirSync(CANCELLATION_DIR, { recursive: true });
  const request = normalizeCancellationRequest(runId, reason, source);
  const file = cancellationFile(runId);
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.new`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(request, null, 2), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      // The fully-written inode becomes visible atomically, and only the first
      // cancellation request can install the immutable authority.
      linkSync(temp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      unlinkSync(temp);
      promoteExistingCancellationDurability(file);
      return readWorkflowRunCancellation(runId) ?? request;
    }
    unlinkSync(temp);
    syncDirectory(CANCELLATION_DIR);
    syncDirectory(WORKFLOW_RUNS_DIR);
    return request;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(temp); } catch { /* installed or best-effort cleanup */ }
  }
}

function terminalStatus(run: WorkflowRunProjection | null): WorkflowRunTerminalStatus | null {
  const value = run?.status;
  if (value === 'dry_run' || value === 'creation_test') {
    return typeof run?.finishedAt === 'string' ? value : null;
  }
  return typeof value === 'string' && TERMINAL_STATUSES.has(value as WorkflowRunTerminalStatus)
    ? value as WorkflowRunTerminalStatus
    : null;
}

export class WorkflowRunAlreadyTerminalError extends Error {
  readonly status: Exclude<WorkflowRunTerminalStatus, 'cancelled'>;

  constructor(status: Exclude<WorkflowRunTerminalStatus, 'cancelled'>) {
    super(`Workflow run is already terminal (${status}) and cannot be cancelled.`);
    this.name = 'WorkflowRunAlreadyTerminalError';
    this.status = status;
  }
}

/**
 * Install immutable cancellation authority. If a canonical run record exists,
 * the terminal-state check and receipt install share the same lock as runner
 * terminal publication, so a completed occurrence can never be retroactively
 * cancelled by a stale reader.
 */
export function requestWorkflowRunCancellation(
  runId: string,
  reason: string,
  source: string,
): WorkflowRunCancellationRequest {
  const file = runFile(runId);
  return withWorkflowRunRecordLock(file, () => {
    const current = readWorkflowRunRecordUnlocked<WorkflowRunProjection>(file);
    const currentStatus = terminalStatus(current);
    if (currentStatus && currentStatus !== 'cancelled') {
      throw new WorkflowRunAlreadyTerminalError(currentStatus);
    }
    return installCancellationReceiptUnlocked(runId, reason, source);
  });
}

/**
 * Shared dashboard cancellation transition. The pre-lock snapshot is only an
 * optimization/test seam; every decision is made from a fresh read under the
 * same lock used by the runner and report-back RMWs.
 */
export function cancelWorkflowRunAtBoundary(input: {
  runId: string;
  reason: string;
  source: string;
  expectedWorkflow?: string;
}): CancelWorkflowRunResult {
  const file = runFile(input.runId);
  // Preserve the exact old race window in a deterministic seam: a completion
  // may land after a route has observed a live record but before cancellation
  // reaches its linearization point.
  try { if (existsSync(file)) readFileSync(file, 'utf-8'); } catch { /* authoritative read below */ }
  beforeCancellationLockForTests?.();

  return withWorkflowRunRecordLock(file, () => {
    const current = readWorkflowRunRecordUnlocked<WorkflowRunProjection>(file);
    if (!current) return { status: 'not_found' };
    if (input.expectedWorkflow !== undefined && current.workflow !== input.expectedWorkflow) {
      return { status: 'workflow_mismatch', run: current };
    }

    const currentStatus = terminalStatus(current);
    if (currentStatus && currentStatus !== 'cancelled') {
      return { status: 'already_terminal', terminalStatus: currentStatus, run: current };
    }

    const wasCancelled = currentStatus === 'cancelled';
    const workflowName = typeof current.workflow === 'string' ? current.workflow : 'Workflow';
    const existingReport = current.reportBack as {
      version?: unknown;
      workflowName?: unknown;
      outcome?: unknown;
      detail?: unknown;
      acknowledgedOriginSessionIds?: unknown;
    } | undefined;
    const validExistingReport = existingReport !== undefined
      && existingReport.version === 1
      && existingReport.workflowName === workflowName
      && existingReport.outcome === 'failed'
      && typeof existingReport.detail === 'string'
      && Array.isArray(existingReport.acknowledgedOriginSessionIds);

    let request = readWorkflowRunCancellation(input.runId);
    if (wasCancelled && existingReport !== undefined && !validExistingReport) {
      // Legacy/corrupt cancelled truth is already terminal. Never install a
      // fresh requester reason that would conflict with its immutable envelope;
      // leave it unchanged for explicit repair/watchdog surfacing.
      return { status: 'already_cancelled', ...(request ? { request } : {}), run: current };
    }
    if (!request) {
      const adoptedReason = wasCancelled
        ? (validExistingReport
            ? existingReport.detail as string
            : typeof current.error === 'string' && current.error
              ? current.error
              : 'Workflow run cancelled.')
        : input.reason;
      request = installCancellationReceiptUnlocked(
        input.runId,
        adoptedReason,
        wasCancelled ? 'legacy-cancelled-run-adoption' : input.source,
      );
    }

    if (validExistingReport && existingReport.detail !== request.reason) {
      // The first durable truths disagree. A later dashboard request has no
      // authority to rewrite either one, and throwing after installing another
      // reason would make the split worse. Preserve the already-cancelled run.
      return { status: 'already_cancelled', request, run: current };
    }
    const next: WorkflowRunProjection = {
      ...current,
      status: 'cancelled',
      cancelledAt: request.requestedAt,
      finishedAt: request.requestedAt,
      error: request.reason,
    };
    delete next.parked;
    const reportBack = {
      version: 1 as const,
      workflowName,
      outcome: 'failed' as const,
      detail: request.reason,
      acknowledgedOriginSessionIds: [] as string[],
    };
    if (validExistingReport) {
      next.reportBack = current.reportBack;
    } else {
      next.reportBack = reportBack;
      delete next.notifiedAt;
      delete next.reportBackAcknowledgedAt;
      delete next.reportBackRetry;
    }
    writeWorkflowRunRecordDurablyUnlocked(file, next);
    return { status: wasCancelled ? 'already_cancelled' : 'cancelled', request, run: next };
  });
}

export function workflowRunCancellationRequested(runId: string): boolean {
  return existsSync(cancellationFile(runId));
}

export function readWorkflowRunCancellation(runId: string): WorkflowRunCancellationRequest | null {
  const file = cancellationFile(runId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<WorkflowRunCancellationRequest>;
    if (
      parsed.version === 1
      && parsed.runId === runId
      && typeof parsed.requestedAt === 'string'
      && typeof parsed.reason === 'string'
      && typeof parsed.source === 'string'
    ) return parsed as WorkflowRunCancellationRequest;
  } catch { /* existence remains fail-closed cancellation authority */ }
  return {
    version: 1,
    runId,
    requestedAt: new Date().toISOString(),
    reason: 'Workflow cancellation was requested; its diagnostic receipt is unreadable.',
    source: 'durable-cancellation-receipt',
  };
}
