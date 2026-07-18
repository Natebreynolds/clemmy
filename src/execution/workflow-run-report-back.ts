import { existsSync, writeFileSync } from 'node:fs';
import {
  deliverOutcomeWithAcknowledgement,
  type DeliverContext,
  type Outcome,
  type OutcomeDeliveryAcknowledgement,
} from '../runtime/outcome.js';
import { readWorkflowRunOriginSessionIds } from '../tools/workflow-run-queue.js';
import {
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
  writeWorkflowRunRecordDurablyUnlocked,
} from './workflow-run-record.js';

export type WorkflowRunReportBackOutcome = 'done' | 'blocked' | 'failed';

export interface WorkflowRunReportBackEnvelope {
  version: 1;
  workflowName: string;
  outcome: WorkflowRunReportBackOutcome;
  detail: string;
  /** Origins whose passive outcome turn is durably present. A late observer
   * sidecar is absent here until the watchdog/drain verifies or delivers it. */
  acknowledgedOriginSessionIds: string[];
}

export interface WorkflowRunReportBackRetryState {
  version: 1;
  kind: 'delivery' | 'corrupt_evidence';
  failureCount: number;
  lastFailureAt: string;
  lastError: string;
  nextAttemptAt?: string;
  quarantinedAt?: string;
}

export interface WorkflowRunReportBackRecord {
  id: string;
  workflow?: string;
  originSessionId?: string;
  originSessionIds?: string[];
  status?: string;
  finishedAt?: string;
  notifiedAt?: string;
  /** Aggregate origin-chat acknowledgement. Kept separate from notifiedAt,
   * which proves the dashboard/global notification was persisted. */
  reportBackAcknowledgedAt?: string;
  reportBack?: WorkflowRunReportBackEnvelope;
  reportBackRetry?: WorkflowRunReportBackRetryState;
}

type DeliverOutcomeImpl = (
  outcome: Outcome,
  ctx: DeliverContext,
) => OutcomeDeliveryAcknowledgement;

let deliverOutcomeImpl: DeliverOutcomeImpl = deliverOutcomeWithAcknowledgement;
let beforeCheckpointLockForTests: (() => void) | undefined;

/** Narrow deterministic failure seam for the report-back acknowledgement tests. */
export function _setWorkflowRunReportBackDeliveryForTests(
  impl?: DeliverOutcomeImpl,
): void {
  deliverOutcomeImpl = impl ?? deliverOutcomeWithAcknowledgement;
}

/** Deterministic seam for a cancellation/terminal transition immediately
 * before checkpoint reaches the shared record lock. */
export function _setWorkflowRunReportBackBeforeCheckpointLockForTests(
  hook?: () => void,
): void {
  beforeCheckpointLockForTests = hook;
}

function uniqueStrings(...values: unknown[]): string[] {
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

export function workflowRunReportBackOrigins(
  run: Pick<WorkflowRunReportBackRecord, 'id' | 'originSessionId' | 'originSessionIds'>,
): { originSessionIds: string[]; complete: boolean; error?: string } {
  const inline = uniqueStrings(run.originSessionId, run.originSessionIds);
  try {
    return {
      originSessionIds: uniqueStrings(inline, readWorkflowRunOriginSessionIds(run.id)),
      complete: true,
    };
  } catch (err) {
    // Corrupt observer evidence leaves the required recipient set unknowable.
    // Inline origins can still be attempted, but the occurrence stays pending
    // and enters bounded quarantine rather than being fsync-rewritten per tick.
    return {
      originSessionIds: inline,
      complete: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function deliveryContext(
  runId: string,
  workflowName: string,
  originSessionId: string,
): DeliverContext {
  return {
    originSessionId,
    sourceLabel: 'workflow run',
    sourceId: runId,
    title: workflowName,
    statusHint: `workflow_run_status run_id="${runId}"`,
    headWord: { blocked: 'needs attention' },
    maxDetailChars: 4000,
    proactiveTurn: true,
  };
}

function validEnvelope(value: unknown): value is WorkflowRunReportBackEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Partial<WorkflowRunReportBackEnvelope>;
  return envelope.version === 1
    && typeof envelope.workflowName === 'string'
    && (envelope.outcome === 'done' || envelope.outcome === 'blocked' || envelope.outcome === 'failed')
    && typeof envelope.detail === 'string'
    && Array.isArray(envelope.acknowledgedOriginSessionIds)
    && envelope.acknowledgedOriginSessionIds.every((id) => typeof id === 'string');
}

function validRetryState(value: unknown): value is WorkflowRunReportBackRetryState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const retry = value as Partial<WorkflowRunReportBackRetryState>;
  return retry.version === 1
    && (retry.kind === 'delivery' || retry.kind === 'corrupt_evidence')
    && typeof retry.failureCount === 'number'
    && Number.isSafeInteger(retry.failureCount)
    && retry.failureCount > 0
    && typeof retry.lastFailureAt === 'string'
    && typeof retry.lastError === 'string'
    && (retry.nextAttemptAt === undefined || typeof retry.nextAttemptAt === 'string')
    && (retry.quarantinedAt === undefined || typeof retry.quarantinedAt === 'string');
}

function readRunRecordUnlocked(filePath: string): WorkflowRunReportBackRecord | null {
  const value = readWorkflowRunRecordUnlocked<Record<string, unknown>>(filePath);
  return value && typeof value.id === 'string' ? value as unknown as WorkflowRunReportBackRecord : null;
}

function sameReportBack(
  envelope: WorkflowRunReportBackEnvelope,
  requested: Omit<WorkflowRunReportBackEnvelope, 'version' | 'acknowledgedOriginSessionIds'>,
): boolean {
  return envelope.workflowName === requested.workflowName
    && envelope.outcome === requested.outcome
    && envelope.detail === requested.detail;
}

function outcomeMatchesCanonicalStatus(
  run: Pick<WorkflowRunReportBackRecord, 'status' | 'finishedAt'>,
  outcome: WorkflowRunReportBackOutcome,
): boolean {
  switch (run.status) {
    case 'cancelled':
      return outcome === 'failed';
    case 'error':
    case 'failed':
      // Preflight/readiness errors intentionally use the blocked lane; a done
      // envelope can never describe a failed canonical terminal state.
      return outcome === 'failed' || outcome === 'blocked';
    case 'completed':
    case 'completed_with_errors':
      return outcome === 'done' || outcome === 'blocked';
    case 'dry_run':
    case 'creation_test':
      return typeof run.finishedAt === 'string' && (outcome === 'done' || outcome === 'blocked');
    default:
      return false;
  }
}

const CORRUPT_EVIDENCE_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 5 * 60_000;

function nextRetryState(
  current: WorkflowRunReportBackRecord,
  kind: WorkflowRunReportBackRetryState['kind'],
  error: string,
  now: number,
): WorkflowRunReportBackRetryState {
  const previous = validRetryState(current.reportBackRetry) && current.reportBackRetry.kind === kind
    ? current.reportBackRetry
    : undefined;
  const failureCount = (previous?.failureCount ?? 0) + 1;
  const nowIso = new Date(now).toISOString();
  if (kind === 'corrupt_evidence' && failureCount >= CORRUPT_EVIDENCE_MAX_ATTEMPTS) {
    return {
      version: 1,
      kind,
      failureCount,
      lastFailureAt: nowIso,
      lastError: error.slice(0, 500),
      quarantinedAt: nowIso,
    };
  }
  // Let one ordinary delivery failure retry on the independent watchdog in the
  // same tick. Repeated failures back off exponentially; corrupt evidence
  // always waits before its next validation attempt.
  const delay = kind === 'delivery' && failureCount === 1
    ? 0
    : Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** Math.max(0, failureCount - 1)));
  return {
    version: 1,
    kind,
    failureCount,
    lastFailureAt: nowIso,
    lastError: error.slice(0, 500),
    nextAttemptAt: new Date(now + delay).toISOString(),
  };
}

function waitBeforeAttemptCommitForTest(): void {
  const ready = process.env.CLEMENTINE_TEST_REPORT_BACK_LOCK_READY;
  const release = process.env.CLEMENTINE_TEST_REPORT_BACK_LOCK_RELEASE;
  if (!ready || !release) return;
  writeFileSync(ready, 'ready', 'utf-8');
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) Atomics.wait(wait, 0, 0, 10);
}

/** Persist the exact terminal report before its first origin-delivery attempt. */
export function checkpointWorkflowRunReportBack(
  filePath: string,
  requested: Omit<WorkflowRunReportBackEnvelope, 'version' | 'acknowledgedOriginSessionIds'>,
): boolean {
  try {
    beforeCheckpointLockForTests?.();
    return withWorkflowRunRecordLock(filePath, () => {
      const current = readRunRecordUnlocked(filePath);
      if (!current) return false;
      // This check lives inside the same lock as cancellation/terminal publish.
      // A stale success caller cannot checkpoint a done/blocked envelope after
      // cancellation won between its post-write read and this RMW.
      if (!outcomeMatchesCanonicalStatus(current, requested.outcome)) return false;
      // The first exact terminal envelope is immutable. A later compatible but
      // different body/lane must not split recipients across two messages, and
      // invalid durable evidence must not be silently healed by replacement.
      if (current.reportBack !== undefined && !validEnvelope(current.reportBack)) return false;
      if (
        current.reportBack !== undefined
        && validEnvelope(current.reportBack)
        && !sameReportBack(current.reportBack, requested)
      ) return false;
      const existing = validEnvelope(current.reportBack) ? current.reportBack : null;
      const next: WorkflowRunReportBackRecord = {
        ...current,
        reportBack: {
          version: 1,
          ...requested,
          acknowledgedOriginSessionIds: existing
            ? uniqueStrings(existing.acknowledgedOriginSessionIds)
            : [],
        },
      };
      if (!existing) {
        delete next.notifiedAt;
        delete next.reportBackAcknowledgedAt;
        delete next.reportBackRetry;
      }
      writeWorkflowRunRecordDurablyUnlocked(filePath, next);
      return true;
    });
  } catch {
    return false;
  }
}

function deliverToOrigins(
  run: WorkflowRunReportBackRecord,
  envelope: WorkflowRunReportBackEnvelope,
  onlyOrigins?: ReadonlySet<string>,
): { acknowledged: string[]; complete: boolean; errors: string[] } {
  const resolved = workflowRunReportBackOrigins(run);
  const acknowledged = new Set(uniqueStrings(envelope.acknowledgedOriginSessionIds));
  const errors = resolved.error ? [resolved.error] : [];
  for (const originSessionId of resolved.originSessionIds) {
    if (acknowledged.has(originSessionId)) continue;
    if (onlyOrigins && !onlyOrigins.has(originSessionId)) continue;
    try {
      const result = deliverOutcomeImpl(
        { status: envelope.outcome, detail: envelope.detail },
        deliveryContext(run.id, envelope.workflowName, originSessionId),
      );
      if (result.acknowledged) acknowledged.add(originSessionId);
      else errors.push(`Origin ${originSessionId} delivery was not acknowledged (${result.disposition}).`);
    } catch (err) {
      errors.push(`Origin ${originSessionId} delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { acknowledged: [...acknowledged], complete: resolved.complete, errors };
}

/**
 * Attempt every currently-required origin and durably merge partial acks. The
 * entire read/deliver/merge/write is serialized with checkpoint replacement,
 * so an older attempt can never overwrite a newer exact envelope.
 */
export function attemptWorkflowRunReportBack(filePath: string, now: number = Date.now()): boolean {
  try {
    return withWorkflowRunRecordLock(filePath, () => {
      const current = readRunRecordUnlocked(filePath);
      if (!current || current.reportBack === undefined) return false;
      if (!workflowRunReportBackRetryDue(current, now)) return false;
      if (!validEnvelope(current.reportBack)) {
        const next = {
          ...current,
          reportBackRetry: nextRetryState(current, 'corrupt_evidence', 'Durable report-back envelope is invalid.', now),
        };
        delete next.reportBackAcknowledgedAt;
        writeWorkflowRunRecordDurablyUnlocked(filePath, next);
        return false;
      }
      if (!outcomeMatchesCanonicalStatus(current, current.reportBack.outcome)) {
        const next = {
          ...current,
          reportBackRetry: nextRetryState(
            current,
            'corrupt_evidence',
            `Report-back outcome ${current.reportBack.outcome} conflicts with canonical status ${current.status ?? 'unknown'}.`,
            now,
          ),
        };
        delete next.reportBackAcknowledgedAt;
        writeWorkflowRunRecordDurablyUnlocked(filePath, next);
        return false;
      }

      const delivered = deliverToOrigins(current, current.reportBack);
      const acknowledged = uniqueStrings(
        current.reportBack.acknowledgedOriginSessionIds,
        delivered.acknowledged,
      );
      const finalOrigins = workflowRunReportBackOrigins(current);
      const allAcknowledged = delivered.complete
        && finalOrigins.complete
        && finalOrigins.originSessionIds.every((id) => acknowledged.includes(id));
      const next: WorkflowRunReportBackRecord = {
        ...current,
        reportBack: {
          ...current.reportBack,
          acknowledgedOriginSessionIds: acknowledged,
        },
      };
      if (allAcknowledged) {
        next.reportBackAcknowledgedAt = current.reportBackAcknowledgedAt ?? new Date(now).toISOString();
        delete next.reportBackRetry;
      } else {
        delete next.reportBackAcknowledgedAt;
        const corruptError = delivered.complete && finalOrigins.complete
          ? null
          : [...delivered.errors, finalOrigins.error].filter((value): value is string => Boolean(value)).join(' ')
            || 'Workflow origin observer evidence is incomplete.';
        next.reportBackRetry = nextRetryState(
          current,
          corruptError ? 'corrupt_evidence' : 'delivery',
          corruptError ?? (delivered.errors.join(' ') || 'One or more workflow report-back origins were not acknowledged.'),
          now,
        );
      }
      waitBeforeAttemptCommitForTest();
      writeWorkflowRunRecordDurablyUnlocked(filePath, next);
      return allAcknowledged;
    });
  } catch {
    return false;
  }
}

export function recordAndAttemptWorkflowRunReportBack(
  filePath: string,
  input: Omit<WorkflowRunReportBackEnvelope, 'version' | 'acknowledgedOriginSessionIds'>,
): boolean {
  return checkpointWorkflowRunReportBack(filePath, input)
    && attemptWorkflowRunReportBack(filePath);
}

/** True when delivery failed, its aggregate marker is missing, or a late
 * observer sidecar is newer than the persisted acknowledgement generation. */
export function workflowRunReportBackNeedsRetry(run: WorkflowRunReportBackRecord): boolean {
  if (!validEnvelope(run.reportBack)) return run.reportBack !== undefined;
  if (!outcomeMatchesCanonicalStatus(run, run.reportBack.outcome)) return true;
  const origins = workflowRunReportBackOrigins(run);
  if (!origins.complete || !(run.reportBackAcknowledgedAt ?? run.notifiedAt)) return true;
  const acknowledged = new Set(uniqueStrings(run.reportBack.acknowledgedOriginSessionIds));
  return origins.originSessionIds.some((id) => !acknowledged.has(id));
}

/** Retry scheduling is separate from pending truth: a quarantined corrupt
 * envelope remains pending/fail-closed but does no I/O on every timer tick. */
export function workflowRunReportBackRetryDue(
  run: WorkflowRunReportBackRecord,
  now: number = Date.now(),
): boolean {
  if (!workflowRunReportBackNeedsRetry(run)) return false;
  if (run.reportBackRetry === undefined) return true;
  if (!validRetryState(run.reportBackRetry)) return false;
  if (run.reportBackRetry.quarantinedAt) return false;
  const nextAttempt = Date.parse(run.reportBackRetry.nextAttemptAt ?? '');
  return !Number.isFinite(nextAttempt) || nextAttempt <= now;
}

/** Compatibility helper for the runner's exported enqueue API. Duplicate
 * turns are acknowledgements; only a genuine origin write/read failure is not. */
export function deliverWorkflowRunOutcome(
  run: WorkflowRunReportBackRecord,
  workflowName: string,
  outcome: WorkflowRunReportBackOutcome,
  detail: string,
): boolean {
  const envelope: WorkflowRunReportBackEnvelope = {
    version: 1,
    workflowName,
    outcome,
    detail,
    acknowledgedOriginSessionIds: [],
  };
  const delivered = deliverToOrigins(run, envelope);
  const required = workflowRunReportBackOrigins(run);
  return delivered.complete
    && required.complete
    && required.originSessionIds.every((id) => delivered.acknowledged.includes(id));
}
