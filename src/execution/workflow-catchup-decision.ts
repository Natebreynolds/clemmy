import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { listWorkflows } from '../memory/workflow-store.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import {
  cancelWorkflowRunAtBoundary,
  readWorkflowRunCancellation,
} from './workflow-run-cancellation.js';
import {
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
  writeWorkflowRunRecordDurablyUnlocked,
} from './workflow-run-record.js';
import {
  checkWorkflowRunReadiness,
  type WorkflowRunReadinessCheck,
} from './workflow-run-readiness.js';
import {
  isCatalogWorkflowRunDefinitionSnapshot,
  resolveWorkflowRunDefinitionSnapshot,
  workflowCodeRevisionMatchesSnapshot,
  workflowDefinitionMatchesScheduledCatchupSnapshot,
} from './workflow-run-definition.js';

export const WORKFLOW_CATCHUP_DECISION_STATUS = 'awaiting_catchup_decision' as const;
export type WorkflowCatchupDisposition = 'held' | 'resumed' | 'skipped';

interface WorkflowCatchupRunRecord extends Record<string, unknown> {
  id?: unknown;
  workflow?: unknown;
  workflowSlug?: unknown;
  status?: unknown;
  source?: unknown;
  catchupFire?: unknown;
  catchupOccurrenceAtMs?: unknown;
  catchupFirstDueAtMs?: unknown;
  catchupScheduledAtMs?: unknown;
  catchupMissedCount?: unknown;
  catchupDisposition?: unknown;
  catchupDecidedAt?: unknown;
  catchupHeldAt?: unknown;
  triggerReceiptId?: unknown;
  createdAt?: unknown;
  readiness?: unknown;
  workflowDefinitionSnapshot?: unknown;
}

export interface HeldWorkflowCatchupRun {
  runId: string;
  workflowName: string;
  workflowSlug: string;
  status: typeof WORKFLOW_CATCHUP_DECISION_STATUS;
  createdAt: string;
  heldAt: string;
  scheduledAtMs: number;
  scheduledAt: string;
  firstDueAtMs: number;
  firstDueAt: string;
  /** Total missed occurrences collapsed into this one decision. */
  missedCount: number;
  readiness?: Record<string, unknown>;
}

interface CatchupDecisionInput {
  runId: string;
  /** May be either the stable workflow slug or its current display name. */
  expectedWorkflow: string;
}

type CatchupDecisionFailureStatus =
  | 'not_found'
  | 'workflow_mismatch'
  | 'not_held';

export type WorkflowCatchupResumeResult =
  | { status: 'resumed' | 'already_resumed'; runId: string; message: string; run: WorkflowCatchupRunRecord }
  | { status: 'blocked_readiness'; runId: string; message: string; readiness: WorkflowRunReadinessCheck }
  | { status: 'workflow_not_found' | 'disabled' | 'definition_conflict' | 'already_skipped'; runId: string; message: string; run?: WorkflowCatchupRunRecord }
  | { status: CatchupDecisionFailureStatus; runId: string; message: string; run?: WorkflowCatchupRunRecord };

export type WorkflowCatchupSkipResult =
  | { status: 'skipped' | 'already_skipped'; runId: string; message: string; run: WorkflowCatchupRunRecord }
  | { status: 'already_resumed'; runId: string; message: string; run: WorkflowCatchupRunRecord }
  | { status: CatchupDecisionFailureStatus; runId: string; message: string; run?: WorkflowCatchupRunRecord };

function runFile(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  if (!safe || safe !== runId) throw new Error('Invalid workflow run id.');
  return path.join(WORKFLOW_RUNS_DIR, `${safe}.json`);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.floor(value)
    : undefined;
}

function isoAt(ms: number): string | undefined {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function workflowSlugFromRecord(record: WorkflowCatchupRunRecord): string | undefined {
  const direct = nonEmptyString(record.workflowSlug);
  if (direct) return direct;
  const resolved = resolveWorkflowRunDefinitionSnapshot(record.workflowDefinitionSnapshot);
  return resolved.status === 'valid' && isCatalogWorkflowRunDefinitionSnapshot(resolved.snapshot)
    ? resolved.snapshot.workflowSlug
    : undefined;
}

function recordMatchesExpectedWorkflow(
  record: WorkflowCatchupRunRecord,
  expectedWorkflow: string,
): boolean {
  const expected = expectedWorkflow.trim();
  return Boolean(
    expected
    && (
      nonEmptyString(record.workflow) === expected
      || workflowSlugFromRecord(record) === expected
    )
  );
}

function validHeldCatchup(record: WorkflowCatchupRunRecord): boolean {
  return record.status === WORKFLOW_CATCHUP_DECISION_STATUS
    && record.source === 'schedule'
    && record.catchupFire === true
    && record.catchupDisposition === 'held';
}

function readinessSnapshot(readiness: WorkflowRunReadinessCheck): Record<string, unknown> {
  return {
    ok: readiness.ok,
    checkedAt: new Date().toISOString(),
    scope: 'run',
    blockers: readiness.blockers,
    warnings: readiness.warnings,
    toolReadiness: readiness.plan.toolReadiness,
  };
}

function idempotentSkipped(record: WorkflowCatchupRunRecord, runId: string): boolean {
  return record.catchupDisposition === 'skipped'
    || (
      record.status === 'cancelled'
      && readWorkflowRunCancellation(runId)?.source === 'workflow-catchup-skip'
    );
}

/**
 * Authoritative list for Tasks. Held runs have intentionally not emitted
 * execution events, so event-backed pending-run scans cannot discover them.
 */
export function listHeldWorkflowCatchupRuns(): HeldWorkflowCatchupRun[] {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  const out: HeldWorkflowCatchupRun[] = [];
  let files: string[];
  try {
    files = readdirSync(WORKFLOW_RUNS_DIR).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  for (const file of files) {
    let record: WorkflowCatchupRunRecord;
    try {
      record = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as WorkflowCatchupRunRecord;
    } catch {
      continue;
    }
    if (!validHeldCatchup(record)) continue;
    const runId = nonEmptyString(record.id);
    const workflowName = nonEmptyString(record.workflow);
    const workflowSlug = workflowSlugFromRecord(record);
    const scheduledAtMs = finiteInteger(record.catchupScheduledAtMs);
    const firstDueAtMs = finiteInteger(record.catchupFirstDueAtMs)
      ?? finiteInteger(record.catchupOccurrenceAtMs);
    const scheduledAt = scheduledAtMs === undefined ? undefined : isoAt(scheduledAtMs);
    const firstDueAt = firstDueAtMs === undefined ? undefined : isoAt(firstDueAtMs);
    if (!runId || !workflowName || !workflowSlug || scheduledAtMs === undefined || firstDueAtMs === undefined) continue;
    if (!scheduledAt || !firstDueAt || firstDueAtMs > scheduledAtMs) continue;
    const missedCount = finiteInteger(record.catchupMissedCount);
    if (missedCount === undefined || missedCount < 1) continue;
    const createdAt = nonEmptyString(record.createdAt) ?? scheduledAt;
    const heldAt = nonEmptyString(record.catchupHeldAt) ?? createdAt;
    out.push({
      runId,
      workflowName,
      workflowSlug,
      status: WORKFLOW_CATCHUP_DECISION_STATUS,
      createdAt,
      heldAt,
      scheduledAtMs,
      scheduledAt,
      firstDueAtMs,
      firstDueAt,
      missedCount,
      ...(record.readiness && typeof record.readiness === 'object' && !Array.isArray(record.readiness)
        ? { readiness: record.readiness as Record<string, unknown> }
        : {}),
    });
  }
  return out.sort((a, b) =>
    a.firstDueAtMs - b.firstDueAtMs
    || a.scheduledAtMs - b.scheduledAtMs
    || a.runId.localeCompare(b.runId));
}

/**
 * User Resume is a compare-and-set on the same occurrence. Readiness is
 * re-evaluated against the current enabled workflow, but the admitted
 * definition snapshot remains immutable for execution truth.
 */
export function resumeWorkflowCatchupRun(
  input: CatchupDecisionInput,
): WorkflowCatchupResumeResult {
  const file = runFile(input.runId);
  return withWorkflowRunRecordLock(file, () => {
    const record = readWorkflowRunRecordUnlocked<WorkflowCatchupRunRecord>(file);
    if (!record) {
      return { status: 'not_found', runId: input.runId, message: 'Held workflow catch-up was not found.' };
    }
    if (!recordMatchesExpectedWorkflow(record, input.expectedWorkflow)) {
      return {
        status: 'workflow_mismatch',
        runId: input.runId,
        message: 'Held catch-up does not belong to the requested workflow.',
        run: record,
      };
    }
    if (record.catchupDisposition === 'resumed') {
      return {
        status: 'already_resumed',
        runId: input.runId,
        message: 'This missed workflow occurrence was already resumed.',
        run: record,
      };
    }
    if (idempotentSkipped(record, input.runId)) {
      return {
        status: 'already_skipped',
        runId: input.runId,
        message: 'This missed workflow occurrence was already skipped.',
        run: record,
      };
    }
    const cancellation = readWorkflowRunCancellation(input.runId);
    if (cancellation) {
      return {
        status: 'not_held',
        runId: input.runId,
        message: 'This workflow occurrence already has a cancellation request and cannot be resumed.',
        run: record,
      };
    }
    if (!validHeldCatchup(record)) {
      return {
        status: 'not_held',
        runId: input.runId,
        message: `Workflow occurrence is ${String(record.status ?? 'unknown')}, not waiting for a catch-up decision.`,
        run: record,
      };
    }

    const slug = workflowSlugFromRecord(record);
    const displayName = nonEmptyString(record.workflow);
    const workflow = listWorkflows().find((entry) =>
      (slug !== undefined && entry.name === slug)
      || (displayName !== undefined && entry.data.name === displayName));
    if (!workflow) {
      return {
        status: 'workflow_not_found',
        runId: input.runId,
        message: 'The workflow was deleted. Skip this held occurrence to clear it.',
        run: record,
      };
    }
    if (!workflow.data.enabled) {
      return {
        status: 'disabled',
        runId: input.runId,
        message: `Workflow "${workflow.data.name}" is disabled. Enable it before resuming, or Skip this occurrence.`,
        run: record,
      };
    }
    const admitted = resolveWorkflowRunDefinitionSnapshot(record.workflowDefinitionSnapshot);
    if (
      admitted.status !== 'valid'
      || !isCatalogWorkflowRunDefinitionSnapshot(admitted.snapshot)
    ) {
      return {
        status: 'definition_conflict',
        runId: input.runId,
        message:
          'This held occurrence has no valid admitted workflow snapshot. Start a fresh run or Skip it; '
          + 'Clementine will not guess which definition to execute.',
        run: record,
      };
    }
    if (!workflowDefinitionMatchesScheduledCatchupSnapshot(admitted.snapshot, workflow.data)) {
      return {
        status: 'definition_conflict',
        runId: input.runId,
        message:
          'The workflow definition changed after this missed occurrence was held. '
          + 'Start a fresh run to use the new definition, or Skip this old occurrence.',
        run: record,
      };
    }
    if (!workflowCodeRevisionMatchesSnapshot(admitted.snapshot)) {
      return {
        status: 'definition_conflict',
        runId: input.runId,
        message:
          'Authored workflow code changed after this missed occurrence was held. '
          + 'Start a fresh run to use the new code, or Skip this old occurrence.',
        run: record,
      };
    }
    // Execution remains pinned to the immutable admitted definition. Checking
    // only today's edited workflow could green-light an old snapshot whose
    // required script/skill/project is still missing.
    const readiness = checkWorkflowRunReadiness(
      admitted.snapshot.definition,
      admitted.snapshot.workflowSlug,
    );
    if (!readiness.ok) {
      return {
        status: 'blocked_readiness',
        runId: input.runId,
        message: readiness.message,
        readiness,
      };
    }
    const decidedAt = new Date().toISOString();
    const next: WorkflowCatchupRunRecord = {
      ...record,
      status: 'queued',
      catchupDisposition: 'resumed',
      catchupDecidedAt: decidedAt,
      readiness: readinessSnapshot(readiness),
    };
    writeWorkflowRunRecordDurablyUnlocked(file, next);
    return {
      status: 'resumed',
      runId: input.runId,
      message: `Resumed missed workflow occurrence for "${workflow.data.name}".`,
      run: next,
    };
  });
}

/**
 * Skip is cancellation with a stronger admission precondition: only a record
 * that is still held can truthfully claim that no workflow step ran.
 */
export function skipWorkflowCatchupRun(
  input: CatchupDecisionInput,
): WorkflowCatchupSkipResult {
  const file = runFile(input.runId);
  return withWorkflowRunRecordLock(file, () => {
    let record = readWorkflowRunRecordUnlocked<WorkflowCatchupRunRecord>(file);
    if (!record) {
      return { status: 'not_found', runId: input.runId, message: 'Held workflow catch-up was not found.' };
    }
    if (!recordMatchesExpectedWorkflow(record, input.expectedWorkflow)) {
      return {
        status: 'workflow_mismatch',
        runId: input.runId,
        message: 'Held catch-up does not belong to the requested workflow.',
        run: record,
      };
    }
    if (idempotentSkipped(record, input.runId)) {
      if (record.catchupDisposition !== 'skipped') {
        record = {
          ...record,
          catchupDisposition: 'skipped',
          catchupDecidedAt: nonEmptyString(record.catchupDecidedAt)
            ?? readWorkflowRunCancellation(input.runId)?.requestedAt
            ?? new Date().toISOString(),
        };
        writeWorkflowRunRecordDurablyUnlocked(file, record);
      }
      return {
        status: 'already_skipped',
        runId: input.runId,
        message: 'This missed workflow occurrence was already skipped.',
        run: record,
      };
    }
    if (record.catchupDisposition === 'resumed') {
      return {
        status: 'already_resumed',
        runId: input.runId,
        message: 'This missed workflow occurrence was already resumed; use normal run cancellation if it still needs to stop.',
        run: record,
      };
    }
    if (!validHeldCatchup(record)) {
      return {
        status: 'not_held',
        runId: input.runId,
        message: `Workflow occurrence is ${String(record.status ?? 'unknown')}, so Skip cannot claim that no work ran.`,
        run: record,
      };
    }

    const cancelled = cancelWorkflowRunAtBoundary({
      runId: input.runId,
      reason: 'Skipped missed scheduled workflow before any workflow step ran.',
      source: 'workflow-catchup-skip',
      expectedWorkflow: nonEmptyString(record.workflow),
    });
    if (cancelled.status !== 'cancelled' && cancelled.status !== 'already_cancelled') {
      const latest = readWorkflowRunRecordUnlocked<WorkflowCatchupRunRecord>(file) ?? record;
      return {
        status: 'not_held',
        runId: input.runId,
        message: 'The workflow occurrence changed before Skip could be committed.',
        run: latest,
      };
    }
    const decidedAt = cancelled.request?.requestedAt ?? new Date().toISOString();
    const next: WorkflowCatchupRunRecord = {
      ...(cancelled.run as WorkflowCatchupRunRecord),
      catchupDisposition: 'skipped',
      catchupDecidedAt: decidedAt,
    };
    writeWorkflowRunRecordDurablyUnlocked(file, next);
    return {
      status: 'skipped',
      runId: input.runId,
      message: 'Skipped the missed workflow occurrence. No workflow step ran.',
      run: next,
    };
  });
}

/** A missed occurrence gets this long of user attention (from heldAt — a hold
 *  discovered late still gets its full window) before the moment is judged
 *  passed and the occurrence auto-skips. Future schedules are untouched. */
export const CATCHUP_AUTO_SKIP_AGE_MS = 24 * 60 * 60 * 1000;

export interface CatchupReapOutcome {
  runId: string;
  workflowSlug: string;
  status: WorkflowCatchupSkipResult['status'];
}

/**
 * Auto-expire stale held catch-ups (2026-07-30 declutter): held occurrences
 * were excluded from the run reaper's terminal statuses, so nothing ever
 * expired them — three "Waiting on you" cards sat 12h+ on every surface. A
 * missed occurrence older than the window auto-skips through the SAME
 * idempotent, lock-taking primitive the user's Skip button uses (it can never
 * touch a run that started), and the paired held-notification is marked read
 * so the notice doesn't outlive the card. Runs on the daemon's hourly reaper
 * tick; failures are per-record and never throw out of the sweep.
 */
export function reapStaleWorkflowCatchups(now = Date.now()): CatchupReapOutcome[] {
  const out: CatchupReapOutcome[] = [];
  for (const held of listHeldWorkflowCatchupRuns()) {
    const heldAtMs = Date.parse(held.heldAt);
    if (!Number.isFinite(heldAtMs) || now - heldAtMs <= CATCHUP_AUTO_SKIP_AGE_MS) continue;
    try {
      const result = skipWorkflowCatchupRun({ runId: held.runId, expectedWorkflow: held.workflowSlug });
      out.push({ runId: held.runId, workflowSlug: held.workflowSlug, status: result.status });
      if (result.status === 'skipped' || result.status === 'already_skipped') {
        void import('../runtime/notifications.js')
          .then(({ markNotificationRead }) => markNotificationRead(`system-workflow-catchup-held-${held.runId}`))
          .catch(() => { /* the notification reaper is the backstop */ });
      }
    } catch {
      // One bad record must not stop the sweep; the next tick retries.
    }
  }
  return out;
}
