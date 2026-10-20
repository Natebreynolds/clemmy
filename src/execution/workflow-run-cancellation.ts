import { isTerminalWorkflowRunStatus, TERMINAL_STATUSES, type WorkflowRunTerminalStatus } from './workflow-run-terminal-status.js';
export { isTerminalWorkflowRunStatus } from './workflow-run-terminal-status.js';
export type { WorkflowRunTerminalStatus } from './workflow-run-terminal-status.js';
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
import { markWorkflowCapabilityNotificationsSettled } from '../runtime/notifications.js';
import { syncExistingFileBytes } from '../runtime/sync-directory.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import {
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
  writeWorkflowRunRecordDurablyUnlocked,
} from './workflow-run-record.js';
import {
  settleCompiledProjectRootFromRun,
  stampCompiledProjectRootSettlement,
} from './project-root-lifecycle.js';

export interface WorkflowRunCancellationRequest {
  version: 1;
  runId: string;
  requestedAt: string;
  reason: string;
  source: string;
}

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
  | { status: 'workflow_mismatch'; run: WorkflowRunProjection }
  | { status: 'refused'; reason: 'ownership_unproved' | 'shared_child_requires_exact_run_stop'; run: WorkflowRunProjection };

const CANCELLATION_DIR = path.join(WORKFLOW_RUNS_DIR, '.cancellations');
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
  // The writer flushed the bytes through its own descriptor before linking.
  // Windows refuses a flush through a read-only handle; the shared helper owns
  // that platform rule.
  syncExistingFileBytes(file);
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

function unresolvedMutationCancellationReason(reason: string): string {
  const requestedReason = reason.trim().slice(0, 180) || 'Workflow run cancelled.';
  const unresolvedTruth = 'Cancellation stopped this local run only. The earlier external mutation remains unresolved and may already have committed; cancellation does not undo it or prove it did not happen. Verify the destination or provider receipt before retrying.';
  return `${requestedReason} ${unresolvedTruth}`.slice(0, 500);
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

export class WorkflowRunIdentityMismatchError extends Error {
  constructor() {
    super('The saved workflow run identity cannot be verified; no cancellation was recorded.');
    this.name = 'WorkflowRunIdentityMismatchError';
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
    // A pre-admission Stop may legitimately precede the run file. Once a file
    // exists, its exact retained identity must agree before installing authority.
    if (current && current.id !== runId) throw new WorkflowRunIdentityMismatchError();
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
  /** Trusted control-plane reads only. It shares the terminal lock so exact
   * ownership cannot change between the proof and cancellation authority. */
  precondition?: (run: Readonly<WorkflowRunProjection>) => 'allow' | 'ownership_unproved' | 'shared_child_requires_exact_run_stop';
}): CancelWorkflowRunResult {
  const file = runFile(input.runId);
  // Preserve the exact old race window in a deterministic seam: a completion
  // may land after a route has observed a live record but before cancellation
  // reaches its linearization point.
  try { if (existsSync(file)) readFileSync(file, 'utf-8'); } catch { /* authoritative read below */ }
  beforeCancellationLockForTests?.();

  // The cards the run was parked on, read under the lock before the park is
  // cleared: a stopped run cannot use them, so they leave Needs you with it.
  let parkedApprovals: Array<{ approvalId: string; sessionId: string }> = [];
  const result = withWorkflowRunRecordLock<CancelWorkflowRunResult>(file, () => {
    const current = readWorkflowRunRecordUnlocked<WorkflowRunProjection>(file);
    if (!current) return { status: 'not_found' };
    // Check under the terminal lock, before treating even a finished record as
    // ours: a stale route/preflight must not cancel or settle replacement bytes.
    if (current.id !== input.runId) return { status: 'refused', reason: 'ownership_unproved', run: current };
    if (input.expectedWorkflow !== undefined && current.workflow !== input.expectedWorkflow) {
      return { status: 'workflow_mismatch', run: current };
    }

    const currentStatus = terminalStatus(current);
    if (currentStatus && currentStatus !== 'cancelled') {
      return { status: 'already_terminal', terminalStatus: currentStatus, run: current };
    }

    if (input.precondition && currentStatus !== 'cancelled') {
      let proof: ReturnType<NonNullable<typeof input.precondition>>;
      try { proof = input.precondition(current); } catch { proof = 'ownership_unproved'; }
      if (proof !== 'allow') {
        return { status: 'refused', reason: proof === 'shared_child_requires_exact_run_stop'
          ? proof : 'ownership_unproved', run: current };
      }
    }

    const wasCancelled = currentStatus === 'cancelled';
    const hasUnresolvedMutation = current.status === 'blocked_mutation';
    const existingMutationBlock = current.mutationBlock !== null
      && typeof current.mutationBlock === 'object'
      && !Array.isArray(current.mutationBlock)
      ? current.mutationBlock as Record<string, unknown>
      : {};
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
        : hasUnresolvedMutation
          ? unresolvedMutationCancellationReason(input.reason)
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
      terminalOutcome: 'cancelled',
    };
    if (hasUnresolvedMutation) {
      next.mutationBlock = {
        ...existingMutationBlock,
        state: 'cancelled_unreconciled',
        cancelledAt: request.requestedAt,
      };
    }
    parkedApprovals = parkedStepApprovals(current.parked);
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
  // The run lock is released before the execution ledger is touched. This
  // preserves one lock order for completion-vs-cancel races and lets an exact
  // replay heal a crash between the two durable commits.
  if (
    result.status === 'cancelled'
    || result.status === 'already_cancelled'
    || result.status === 'already_terminal'
  ) {
    try {
      markWorkflowCapabilityNotificationsSettled(input.runId, {
        capabilityResolutionStatus: 'run_terminal',
        terminalStatus: result.status === 'already_terminal'
          ? result.terminalStatus
          : 'cancelled',
      });
    } catch { /* terminal run truth is authoritative; a later replay can settle presentation */ }
    if (result.status === 'cancelled') retireParkedApprovals(input.runId, parkedApprovals);
    const settlement = settleCompiledProjectRootFromRun(file, result.run);
    if (settlement.kind === 'settled' || settlement.kind === 'already_settled') {
      stampCompiledProjectRootSettlement(file, settlement);
    }
  }
  return result;
}

function parkedStepApprovals(parked: unknown): Array<{ approvalId: string; sessionId: string }> {
  const steps = (parked as { parkedSteps?: unknown } | null | undefined)?.parkedSteps;
  if (!Array.isArray(steps)) return [];
  const out: Array<{ approvalId: string; sessionId: string }> = [];
  for (const step of steps) {
    const sessionId = (step as { sessionId?: unknown })?.sessionId;
    const ids = (step as { approvalIds?: unknown })?.approvalIds;
    if (typeof sessionId !== 'string' || !Array.isArray(ids)) continue;
    for (const id of ids) if (typeof id === 'string' && id) out.push({ approvalId: id, sessionId: sessionId as string });
  }
  return out;
}

/** Live 2026-10-16: a cancelled fixture run left "Approve exact local_write
 * call space_set_data" pending in Needs you, since the dead-session reaper
 * skips durable product approvals. Only a still-pending card of this run's
 * own parked step session is retired. */
function retireParkedApprovals(runId: string, parked: ReadonlyArray<{ approvalId: string; sessionId: string }>): void {
  for (const { approvalId, sessionId } of parked) {
    try {
      const row = approvalRegistry.get(approvalId);
      if (!row || row.status !== 'pending' || row.sessionId !== sessionId) continue;
      if (sessionId !== `workflow:${runId}` && !sessionId.startsWith(`workflow:${runId}:`)) continue;
      approvalRegistry.resolve(approvalId, 'cancelled_by_system', 'workflow-run-cancelled');
    } catch { /* the cancelled run is authoritative; the reaper can still settle the card */ }
  }
}

/**
 * Cards whose workflow run has already ended. A step's call session is never
 * marked finished when its run ends, so the dead-session reaper never sees
 * these; a run that ended before its cards were retired with it (or ended
 * some other way) left them in Needs you for good. Only a still-pending card
 * of a `workflow:<runId>:<stepId>` session whose own run record is terminal
 * is retired, quietly: the run already reported how it ended.
 */
export function retireCardsOfEndedWorkflowRuns(): string[] {
  const retired: string[] = [];
  for (const row of approvalRegistry.listPending({ status: 'pending' })) {
    const match = /^workflow:([A-Za-z0-9][A-Za-z0-9_.-]*):[^:]+$/.exec(row.sessionId);
    if (!match || match[1] === 'partition') continue;
    const runId = match[1]!;
    let record: { id?: unknown; status?: unknown };
    try {
      record = JSON.parse(readFileSync(runFile(runId), 'utf-8')) as { id?: unknown; status?: unknown };
    } catch {
      continue; // no readable run record proves nothing about the card
    }
    if (record.id !== runId || !isTerminalWorkflowRunStatus(record.status)) continue;
    try {
      const result = approvalRegistry.resolve(row.approvalId, 'cancelled_by_system', 'workflow-run-ended');
      if (result.ok) retired.push(row.approvalId);
    } catch { /* the next sweep tries again */ }
  }
  return retired;
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
