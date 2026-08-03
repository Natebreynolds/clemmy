import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  deliverOutcomeWithAcknowledgement,
  type DeliverContext,
  type Outcome,
  type OutcomeDeliveryAcknowledgement,
} from '../runtime/outcome.js';
import {
  readWorkflowRunOriginRecords,
  readActiveWorkflowOriginGroupForRun,
  type ExactWorkflowRunOriginRecord,
} from '../tools/workflow-run-queue.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import {
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
  writeWorkflowRunRecordDurablyUnlocked,
} from './workflow-run-record.js';
import {
  isWorkflowTerminalOutcome,
  workflowTerminalOutcomeMatchesReport,
  type WorkflowTerminalOutcome,
} from './workflow-terminal-outcome.js';
import { updateLinkedFocusAction } from '../memory/focus.js';
import {
  addNotification,
  exactOriginDeliveryReceiptForTarget,
  exactOriginDeliveryMetadata,
  finalizeExactNotificationDeliveryReceiptSettlement,
  getNotification,
  hasExactOriginDeliveryReceipt,
  observeExactNotificationDeliveryReceipt,
} from '../runtime/notifications.js';
import {
  commitWorkflowOriginTerminal,
  renderWorkflowOriginTerminalText,
} from './workflow-origin-terminal.js';
import {
  compactSettledWorkflowOriginGroup,
  createWorkflowOriginGroupSettlementReceipt,
  readActiveWorkflowOriginGroup,
  readWorkflowRunChatDispatchPreparations,
  readWorkflowOriginGroupSettlement,
  recordWorkflowOriginGroupSettlement,
  workflowRunReportBackContentDigest,
  type WorkflowOriginGroupSettlementReceipt,
  type WorkflowOriginGroupMemberReportBackDigest,
  type WorkflowOriginGroupSettlementTerminalInput,
} from './workflow-origin-group.js';

export type WorkflowRunReportBackOutcome = 'done' | 'blocked' | 'failed';

export interface WorkflowRunOriginObserverSettlementProjection {
  settlementDigest: string;
  reportBackDigest: string;
}

export interface WorkflowRunReportBackEnvelope {
  version: 1;
  workflowName: string;
  outcome: WorkflowRunReportBackOutcome;
  detail: string;
  /** Origins whose passive outcome turn is durably present. A late observer
   * sidecar is absent here until the watchdog/drain verifies or delivers it. */
  acknowledgedOriginSessionIds: string[];
  /** Exact accepted chat intents whose terminal was committed and delivered to
   * their precise origin target. Optional for v1 session-only compatibility. */
  acknowledgedOriginObserverIds?: string[];
  /** Per-observer projection of immutable group settlement authority onto this
   * member's exact checkpoint bytes. This survives sibling-run retention while
   * still detecting any later mutation of the local report. */
  acknowledgedOriginObserverSettlements?: Record<
    string,
    WorkflowRunOriginObserverSettlementProjection
  >;
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
  terminalOutcome?: WorkflowTerminalOutcome;
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
let afterExactReceiptObservationForTests: (() => void) | undefined;

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

/** Crash seam after provider-receipt observation is durable but before the
 * immutable group settlement is recorded. */
export function _setWorkflowRunReportBackAfterExactReceiptObservationForTests(
  hook?: () => void,
): void {
  afterExactReceiptObservationForTests = hook;
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
  const resolved = workflowRunReportBackRecipients(run);
  return {
    originSessionIds: uniqueStrings(
      resolved.legacyOriginSessionIds,
      resolved.exactObservers.map((observer) => observer.originSessionId),
    ),
    complete: resolved.complete,
    ...(resolved.error ? { error: resolved.error } : {}),
  };
}

interface WorkflowRunReportBackRecipients {
  legacyOriginSessionIds: string[];
  exactObservers: ExactWorkflowRunOriginRecord[];
  complete: boolean;
  evidenceState: 'ready' | 'pending' | 'corrupt';
  error?: string;
}

function samePreparationMember(
  receipt: ReturnType<typeof readWorkflowRunChatDispatchPreparations>[number],
  member: {
    runId: string;
    queueRequestDigest: string;
    preparationDigest: string;
    preparedEventId: string;
    preparedEventSeq: number;
    preparedAt: string;
    receiptDigest: string;
  },
): boolean {
  return member.runId === receipt.runId
    && member.queueRequestDigest === receipt.queueRequestDigest
    && member.preparationDigest === receipt.preparationDigest
    && member.preparedEventId === receipt.preparedEventId
    && member.preparedEventSeq === receipt.preparedEventSeq
    && member.preparedAt === receipt.preparedAt
    && member.receiptDigest === receipt.receiptDigest;
}

function exactPreparationCoverage(
  runId: string,
  exactObservers: readonly ExactWorkflowRunOriginRecord[],
): { state: 'ready' | 'pending' | 'corrupt'; error?: string } {
  let preparations;
  try {
    preparations = readWorkflowRunChatDispatchPreparations(runId);
  } catch (err) {
    return {
      state: 'corrupt',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  // Settled cleanup removes this redundant index only after every member owns
  // its projection. The remaining active sidecars/tombstone are then enough for
  // replay, so an empty index is not evidence loss by itself.
  if (preparations.length === 0) return { state: 'ready' };

  let pendingGroupId: string | undefined;
  for (const preparation of preparations) {
    let active;
    try {
      active = readActiveWorkflowOriginGroup(preparation.sourceGroupId);
    } catch (err) {
      return {
        state: 'corrupt',
        error: `Workflow source group ${preparation.sourceGroupId} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!active) {
      pendingGroupId ??= preparation.sourceGroupId;
      continue;
    }
    const member = active.sealed.members.find((candidate) => candidate.runId === runId);
    const observer = exactObservers.find(
      (candidate) => candidate.sourceGroupId === preparation.sourceGroupId,
    );
    if (
      active.sealed.observerId !== preparation.observerId
      || active.sealed.originSessionId !== preparation.originSessionId
      || active.sealed.sourceUserSeq !== preparation.sourceUserSeq
      || active.sealed.replyTargetDigest !== preparation.replyTargetDigest
      || !member
      || !samePreparationMember(preparation, member)
      || !observer
      || observer.runId !== runId
      || observer.observerId !== active.sealed.observerId
      || observer.sourceGroupDigest !== active.sealed.sourceGroupDigest
      || observer.replyTargetDigest !== active.sealed.replyTargetDigest
    ) {
      return {
        state: 'corrupt',
        error: `Workflow run ${runId} is missing the exact observer for active source group ${preparation.sourceGroupId}.`,
      };
    }
  }
  return pendingGroupId
    ? {
        state: 'pending',
        error: `Workflow run ${runId} is waiting for source group ${pendingGroupId} to activate.`,
      }
    : { state: 'ready' };
}

function workflowRunReportBackRecipients(
  run: Pick<WorkflowRunReportBackRecord, 'id' | 'originSessionId' | 'originSessionIds'>,
): WorkflowRunReportBackRecipients {
  const inline = uniqueStrings(run.originSessionId, run.originSessionIds);
  try {
    const records = readWorkflowRunOriginRecords(run.id);
    const exactObservers = records.filter(
      (record): record is ExactWorkflowRunOriginRecord => record.version === 2,
    );
    const coverage = exactPreparationCoverage(run.id, exactObservers);
    if (coverage.state !== 'ready') {
      return {
        legacyOriginSessionIds: [],
        exactObservers: [],
        complete: false,
        evidenceState: coverage.state,
        ...(coverage.error ? { error: coverage.error } : {}),
      };
    }
    const exactSessions = new Set(exactObservers.map((observer) => observer.originSessionId));
    return {
      // A v2 observer supersedes the session-only route for its session. Running
      // both would stage a synthetic outcome and then commit the exact terminal.
      legacyOriginSessionIds: uniqueStrings(
        inline,
        records.filter((record) => record.version === 1).map((record) => record.originSessionId),
      ).filter((sessionId) => !exactSessions.has(sessionId)),
      exactObservers,
      complete: true,
      evidenceState: 'ready',
    };
  } catch (err) {
    // Corrupt observer evidence leaves the required recipient set unknowable.
    // An inline session may have been superseded by an exact observer, so a
    // legacy delivery here would be a fail-open fallback to the wrong route.
    return {
      legacyOriginSessionIds: [],
      exactObservers: [],
      complete: false,
      evidenceState: 'corrupt',
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

function validObserverSettlementProjections(
  value: unknown,
): value is Record<string, WorkflowRunOriginObserverSettlementProjection> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([observerId, candidate]) => {
    if (!/^workflow-origin-v2:[a-f0-9]{64}$/.test(observerId)) return false;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const projection = candidate as Record<string, unknown>;
    return Object.keys(projection).length === 2
      && typeof projection.settlementDigest === 'string'
      && /^[a-f0-9]{64}$/.test(projection.settlementDigest)
      && typeof projection.reportBackDigest === 'string'
      && /^[a-f0-9]{64}$/.test(projection.reportBackDigest);
  });
}

function validEnvelope(value: unknown): value is WorkflowRunReportBackEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Partial<WorkflowRunReportBackEnvelope>;
  return envelope.version === 1
    && typeof envelope.workflowName === 'string'
    && (envelope.outcome === 'done' || envelope.outcome === 'blocked' || envelope.outcome === 'failed')
    && typeof envelope.detail === 'string'
    && Array.isArray(envelope.acknowledgedOriginSessionIds)
    && envelope.acknowledgedOriginSessionIds.every((id) => typeof id === 'string')
    && (
      envelope.acknowledgedOriginObserverIds === undefined
      || (
        Array.isArray(envelope.acknowledgedOriginObserverIds)
        && envelope.acknowledgedOriginObserverIds.every((id) => typeof id === 'string')
      )
    )
    && (
      envelope.acknowledgedOriginObserverSettlements === undefined
      || validObserverSettlementProjections(envelope.acknowledgedOriginObserverSettlements)
    );
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

function workflowRunRecordPathOwnsId(filePath: string, runId: string): boolean {
  const basename = path.basename(filePath);
  if (!basename.endsWith('.json')) return false;
  const expected = basename.slice(0, -'.json'.length);
  return Boolean(expected)
    && expected === expected.replace(/[^a-zA-Z0-9_.:-]/g, '')
    && runId === expected;
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
  run: Pick<WorkflowRunReportBackRecord, 'status' | 'finishedAt' | 'terminalOutcome'>,
  outcome: WorkflowRunReportBackOutcome,
): boolean {
  if (isWorkflowTerminalOutcome(run.terminalOutcome)) {
    return workflowTerminalOutcomeMatchesReport(run.terminalOutcome, outcome);
  }
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

interface WorkflowOriginGroupReportProjection {
  sourceGroupId: string;
  sourceGroupDigest: string;
  identityRunId: string;
  primaryRunId: string;
  memberRunIds: string[];
  memberReportBackDigests: WorkflowOriginGroupMemberReportBackDigest[];
  workflowName: string;
  outcome: WorkflowRunReportBackOutcome;
  detail: string;
}

type WorkflowOriginGroupReportResolution =
  | { status: 'ready'; projection: WorkflowOriginGroupReportProjection }
  | { status: 'pending' | 'corrupt'; error: string };

function reportBackOutcomeRank(outcome: WorkflowRunReportBackOutcome): number {
  return outcome === 'failed' ? 3 : outcome === 'blocked' ? 2 : 1;
}

function workflowRunRecordFile(runId: string): string | null {
  const safe = runId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  return safe && safe === runId ? path.join(WORKFLOW_RUNS_DIR, `${safe}.json`) : null;
}

/** Reduce every run admitted for one accepted source into one deterministic
 * public report. A fast member may checkpoint first, but it cannot publish
 * until every immutable group member owns a valid terminal envelope. */
function resolveWorkflowOriginGroupReport(
  currentRun: WorkflowRunReportBackRecord,
  currentEnvelope: WorkflowRunReportBackEnvelope,
  observer: ExactWorkflowRunOriginRecord,
): WorkflowOriginGroupReportResolution {
  let active;
  try {
    active = readActiveWorkflowOriginGroupForRun(
      currentRun.id,
      observer.sourceGroupId,
      observer.sourceGroupDigest,
    );
  } catch (err) {
    return {
      status: 'corrupt',
      error: `Workflow source group ${observer.sourceGroupId} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (
    !active
    || active.sealed.observerId !== observer.observerId
    || active.sealed.originSessionId !== observer.originSessionId
    || active.sealed.sourceUserSeq !== observer.sourceUserSeq
    || active.sealed.replyTargetDigest !== observer.replyTargetDigest
  ) {
    return {
      status: 'corrupt',
      error: `Workflow run ${currentRun.id} has no matching active source-group authority.`,
    };
  }

  const reports: Array<{
    runId: string;
    workflowName: string;
    outcome: WorkflowRunReportBackOutcome;
    detail: string;
  }> = [];
  for (const member of active.sealed.members) {
    let record: WorkflowRunReportBackRecord | null;
    if (member.runId === currentRun.id) {
      record = { ...currentRun, reportBack: currentEnvelope };
    } else {
      const file = workflowRunRecordFile(member.runId);
      if (!file) {
        return { status: 'corrupt', error: `Workflow source group contains invalid run id ${member.runId}.` };
      }
      record = readRunRecordUnlocked(file);
    }
    if (!record) {
      return {
        status: 'corrupt',
        error: `Workflow source group member ${member.runId} is missing.`,
      };
    }
    if (record.id !== member.runId) {
      return {
        status: 'corrupt',
        error: `Workflow source group member ${member.runId} has mismatched canonical identity ${record.id}.`,
      };
    }
    if (record.reportBack === undefined) {
      return {
        status: 'pending',
        error: `Workflow source group is waiting for member ${member.runId} to checkpoint its terminal result.`,
      };
    }
    if (!validEnvelope(record.reportBack)) {
      return {
        status: 'corrupt',
        error: `Workflow source group member ${member.runId} has invalid report-back evidence.`,
      };
    }
    if (!outcomeMatchesCanonicalStatus(record, record.reportBack.outcome)) {
      return {
        status: 'corrupt',
        error: `Workflow source group member ${member.runId} report-back conflicts with its canonical status.`,
      };
    }
    reports.push({
      runId: member.runId,
      workflowName: record.reportBack.workflowName,
      outcome: record.reportBack.outcome,
      detail: record.reportBack.detail,
    });
  }

  const outcome = reports.reduce<WorkflowRunReportBackOutcome>(
    (winner, report) => reportBackOutcomeRank(report.outcome) > reportBackOutcomeRank(winner)
      ? report.outcome
      : winner,
    'done',
  );
  const detail = reports.length === 1
    ? reports[0].detail
    : [
        `${reports.length} workflows finished for this request:`,
        ...reports.map((report) => {
          const label = report.workflowName.replace(/\s+/g, ' ').trim().slice(0, 120) || report.runId;
          const rendered = renderWorkflowOriginTerminalText(report.detail, report.runId);
          return `• ${label} — ${report.outcome}\n${rendered}`;
        }),
      ].join('\n\n');
  const memberRunIds = reports.map((report) => report.runId);
  const memberReportBackDigests = reports.map((report) => ({
    runId: report.runId,
    reportBackDigest: workflowRunReportBackContentDigest(report),
  }));
  return {
    status: 'ready',
    projection: {
      sourceGroupId: active.sealed.sourceGroupId,
      sourceGroupDigest: active.sealed.sourceGroupDigest,
      identityRunId: memberRunIds.length === 1 ? memberRunIds[0] : active.sealed.sourceGroupId,
      primaryRunId: memberRunIds[0],
      memberRunIds,
      memberReportBackDigests,
      workflowName: reports.length === 1 ? reports[0].workflowName : `${reports.length} workflows`,
      outcome,
      detail,
    },
  };
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
  requested: Omit<
    WorkflowRunReportBackEnvelope,
    | 'version'
    | 'acknowledgedOriginSessionIds'
    | 'acknowledgedOriginObserverIds'
    | 'acknowledgedOriginObserverSettlements'
  >,
): boolean {
  try {
    beforeCheckpointLockForTests?.();
    return withWorkflowRunRecordLock(filePath, () => {
      const current = readRunRecordUnlocked(filePath);
      if (!current || !workflowRunRecordPathOwnsId(filePath, current.id)) return false;
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
          workflowName: requested.workflowName,
          outcome: requested.outcome,
          detail: requested.detail,
          acknowledgedOriginSessionIds: existing
            ? uniqueStrings(existing.acknowledgedOriginSessionIds)
            : [],
          ...(existing?.acknowledgedOriginObserverIds
            ? { acknowledgedOriginObserverIds: uniqueStrings(existing.acknowledgedOriginObserverIds) }
            : {}),
          ...(existing?.acknowledgedOriginObserverSettlements
            ? {
                acknowledgedOriginObserverSettlements: Object.fromEntries(
                  Object.entries(existing.acknowledgedOriginObserverSettlements).map(
                    ([observerId, projection]) => [observerId, { ...projection }],
                  ),
                ),
              }
            : {}),
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
): {
  acknowledgedSessions: string[];
  acknowledgedObservers: string[];
  acknowledgedObserverSettlements: Record<string, WorkflowRunOriginObserverSettlementProjection>;
  complete: boolean;
  corruptEvidence: boolean;
  errors: string[];
} {
  const resolved = workflowRunReportBackRecipients(run);
  const acknowledgedSessions = new Set(uniqueStrings(envelope.acknowledgedOriginSessionIds));
  // Per-run observer ids are only projections. Rebuild this set from the
  // immutable, target-bound group settlement on every attempt so forged or
  // stale strings can never close report-back by themselves.
  const acknowledgedObservers = new Set<string>();
  const acknowledgedObserverSettlements: Record<
    string,
    WorkflowRunOriginObserverSettlementProjection
  > = {};
  const errors = resolved.error ? [resolved.error] : [];
  let exactEvidenceComplete = resolved.evidenceState === 'ready';
  let corruptEvidence = resolved.evidenceState === 'corrupt';

  for (const observer of resolved.exactObservers) {
    try {
      const groupReport = resolveWorkflowOriginGroupReport(run, envelope, observer);
      if (groupReport.status !== 'ready') {
        if (groupReport.status === 'corrupt') {
          exactEvidenceComplete = false;
          corruptEvidence = true;
        }
        errors.push(groupReport.error);
        continue;
      }
      const projection = groupReport.projection;
      const committed = commitWorkflowOriginTerminal({
        observer,
        runId: projection.primaryRunId,
        identityRunId: projection.identityRunId,
        evidenceRunIds: projection.memberRunIds,
        outcome: projection.outcome,
        detail: projection.detail,
      });
      if (!committed) {
        exactEvidenceComplete = false;
        corruptEvidence = true;
        errors.push(`Origin observer ${observer.observerId} no longer names an accepted user source.`);
        continue;
      }
      const expectedText = renderWorkflowOriginTerminalText(projection.detail, projection.primaryRunId);
      if (
        committed.presentation.identity.runId !== projection.identityRunId
        || committed.presentation.identity.sourceUserSeq !== observer.sourceUserSeq
        || committed.presentation.status !== projection.outcome
        || committed.presentation.text !== expectedText
      ) {
        exactEvidenceComplete = false;
        corruptEvidence = true;
        errors.push(`Origin observer ${observer.observerId} has a conflicting terminal winner.`);
        continue;
      }
      const target = observer.replyTarget;
      const notificationId = projection.memberRunIds.length === 1
        ? `workflow-${projection.primaryRunId}-origin-${observer.observerId.replace(/^workflow-origin-v2:/, '')}`
        : `workflow-origin-group-${projection.sourceGroupDigest}`;
      const exactDeliveryReceipt = exactOriginDeliveryReceiptForTarget(target);
      if (!exactDeliveryReceipt) {
        exactEvidenceComplete = false;
        corruptEvidence = true;
        errors.push(`Origin observer ${observer.observerId} has no exact delivery receipt identity.`);
        continue;
      }
      const terminal: WorkflowOriginGroupSettlementTerminalInput = {
        eventId: committed.event.id,
        outcomeId: committed.presentation.outcomeId,
        sessionId: committed.presentation.identity.sessionId,
        turn: committed.presentation.identity.turn,
        sourceUserSeq: committed.presentation.identity.sourceUserSeq,
        runId: committed.presentation.identity.runId ?? '',
        status: projection.outcome,
        text: committed.presentation.text,
      };

      let existingSettlement: WorkflowOriginGroupSettlementReceipt | null;
      try {
        existingSettlement = readWorkflowOriginGroupSettlement(projection.sourceGroupId);
      } catch (err) {
        exactEvidenceComplete = false;
        corruptEvidence = true;
        errors.push(
          `Origin observer ${observer.observerId} has unreadable settlement evidence: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (existingSettlement) {
        try {
          const expectedSettlement = createWorkflowOriginGroupSettlementReceipt({
            sourceGroupId: projection.sourceGroupId,
            exactDeliveryReceipt,
            notificationId,
            terminal,
            memberReportBackDigests: projection.memberReportBackDigests,
            settledAt: existingSettlement.settledAt,
          });
          if (
            expectedSettlement.settlementDigest !== existingSettlement.settlementDigest
            || JSON.stringify(expectedSettlement) !== JSON.stringify(existingSettlement)
          ) {
            exactEvidenceComplete = false;
            corruptEvidence = true;
            errors.push(`Origin observer ${observer.observerId} has conflicting settlement authority.`);
            continue;
          }
          const carrier = getNotification(notificationId);
          if (carrier) {
            const finalized = finalizeExactNotificationDeliveryReceiptSettlement(
              notificationId,
              exactDeliveryReceipt,
              existingSettlement.sourceGroupId,
              existingSettlement.settlementDigest,
            );
            if (
              !finalized
              || finalized.exactDeliveryReceiptSettlementDigest !== existingSettlement.settlementDigest
            ) {
              const conflictingSettlement = (
                typeof carrier.exactDeliveryReceiptSettlementDigest === 'string'
                && carrier.exactDeliveryReceiptSettlementDigest !== existingSettlement.settlementDigest
              ) || (
                typeof carrier.exactDeliveryReceiptSettlementSourceGroupId === 'string'
                && carrier.exactDeliveryReceiptSettlementSourceGroupId !== existingSettlement.sourceGroupId
              );
              if (conflictingSettlement) exactEvidenceComplete = false;
              if (conflictingSettlement) corruptEvidence = true;
              errors.push(conflictingSettlement
                ? `Origin observer ${observer.observerId} has conflicting carrier settlement authority.`
                : `Origin observer ${observer.observerId} settlement receipt retention is pending.`);
              continue;
            }
          }
          acknowledgedObservers.add(observer.observerId);
          acknowledgedObserverSettlements[observer.observerId] = {
            settlementDigest: existingSettlement.settlementDigest,
            reportBackDigest: workflowRunReportBackContentDigest(envelope),
          };
          continue;
        } catch (err) {
          exactEvidenceComplete = false;
          corruptEvidence = true;
          errors.push(
            `Origin observer ${observer.observerId} settlement conflicts with its terminal: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
      }

      if (onlyOrigins && !onlyOrigins.has(observer.originSessionId)) continue;
      addNotification({
        id: notificationId,
        kind: 'workflow',
        title: `Workflow ${projection.outcome === 'done' ? 'completed' : projection.outcome}: ${projection.workflowName}`,
        body: committed.presentation.text,
        createdAt: new Date().toISOString(),
        read: false,
        // Local chat surfaces already receive the committed public terminal.
        // Keep the receipt carrier in Activity without creating a second toast.
        silent: target.type === 'origin_chat',
        metadata: {
          workflow: projection.workflowName,
          runId: projection.primaryRunId,
          runIds: projection.memberRunIds,
          sourceGroupId: projection.sourceGroupId,
          sourceGroupDigest: projection.sourceGroupDigest,
          source: 'workflow_origin_terminal',
          originObserverId: observer.observerId,
          sourceUserSeq: observer.sourceUserSeq,
          terminalReportBack: true,
          ...exactOriginDeliveryMetadata(target),
        },
      });
      const durableNotification = getNotification(notificationId);
      const notificationMatches = Boolean(
        durableNotification
        && durableNotification.kind === 'workflow'
        && durableNotification.body === committed.presentation.text
        && durableNotification.metadata?.workflow === projection.workflowName
        && durableNotification.metadata?.runId === projection.primaryRunId
        && durableNotification.metadata?.sourceGroupId === projection.sourceGroupId
        && durableNotification.metadata?.sourceGroupDigest === projection.sourceGroupDigest
        && Array.isArray(durableNotification.metadata?.runIds)
        && durableNotification.metadata.runIds.length === projection.memberRunIds.length
        && durableNotification.metadata.runIds.every(
          (memberRunId, index) => memberRunId === projection.memberRunIds[index],
        )
        && durableNotification.metadata?.source === 'workflow_origin_terminal'
        && durableNotification.metadata?.originObserverId === observer.observerId
        && durableNotification.metadata?.sourceUserSeq === observer.sourceUserSeq
        && durableNotification.metadata?.terminalReportBack === true,
      );
      if (
        durableNotification
        && notificationMatches
        && hasExactOriginDeliveryReceipt(durableNotification, target)
      ) {
        const observed = observeExactNotificationDeliveryReceipt(notificationId, exactDeliveryReceipt);
        const settledAt = observed?.exactDeliveryReceiptObservedAt;
        if (!settledAt) {
          errors.push(`Origin observer ${observer.observerId} exact delivery observation is pending.`);
          continue;
        }
        afterExactReceiptObservationForTests?.();
        const settlement = createWorkflowOriginGroupSettlementReceipt({
          sourceGroupId: projection.sourceGroupId,
          exactDeliveryReceipt,
          notificationId,
          terminal,
          memberReportBackDigests: projection.memberReportBackDigests,
          settledAt,
        });
        const winner = recordWorkflowOriginGroupSettlement(settlement);
        if (
          winner.settlementDigest !== settlement.settlementDigest
          || JSON.stringify(winner) !== JSON.stringify(settlement)
        ) {
          exactEvidenceComplete = false;
          corruptEvidence = true;
          errors.push(`Origin observer ${observer.observerId} lost a conflicting settlement race.`);
          continue;
        }
        const finalized = finalizeExactNotificationDeliveryReceiptSettlement(
          notificationId,
          exactDeliveryReceipt,
          winner.sourceGroupId,
          winner.settlementDigest,
        );
        if (
          !finalized
          || finalized.exactDeliveryReceiptSettlementDigest !== winner.settlementDigest
        ) {
          const carrierAfterFinalize = finalized ?? getNotification(notificationId);
          const conflictingSettlement = (
            typeof carrierAfterFinalize?.exactDeliveryReceiptSettlementDigest === 'string'
            && carrierAfterFinalize.exactDeliveryReceiptSettlementDigest !== winner.settlementDigest
          ) || (
            typeof carrierAfterFinalize?.exactDeliveryReceiptSettlementSourceGroupId === 'string'
            && carrierAfterFinalize.exactDeliveryReceiptSettlementSourceGroupId !== winner.sourceGroupId
          );
          if (conflictingSettlement) exactEvidenceComplete = false;
          if (conflictingSettlement) corruptEvidence = true;
          errors.push(conflictingSettlement
            ? `Origin observer ${observer.observerId} has conflicting carrier settlement authority.`
            : `Origin observer ${observer.observerId} settlement receipt retention is pending.`);
          continue;
        }
        // The settlement is durable before this per-run projection is merged
        // into the checkpoint below. A crash in between simply re-projects it.
        acknowledgedObservers.add(observer.observerId);
        acknowledgedObserverSettlements[observer.observerId] = {
          settlementDigest: winner.settlementDigest,
          reportBackDigest: workflowRunReportBackContentDigest(envelope),
        };
      } else {
        if (durableNotification && !notificationMatches) {
          exactEvidenceComplete = false;
          corruptEvidence = true;
        }
        errors.push(
          notificationMatches
            ? `Origin observer ${observer.observerId} exact delivery is pending.`
            : `Origin observer ${observer.observerId} has conflicting notification evidence.`,
        );
      }
    } catch (err) {
      errors.push(`Origin observer ${observer.observerId} delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const originSessionId of resolved.legacyOriginSessionIds) {
    if (acknowledgedSessions.has(originSessionId)) continue;
    if (onlyOrigins && !onlyOrigins.has(originSessionId)) continue;
    try {
      const result = deliverOutcomeImpl(
        { status: envelope.outcome, detail: envelope.detail },
        deliveryContext(run.id, envelope.workflowName, originSessionId),
      );
      if (result.acknowledged) acknowledgedSessions.add(originSessionId);
      else errors.push(`Origin ${originSessionId} delivery was not acknowledged (${result.disposition}).`);
    } catch (err) {
      errors.push(`Origin ${originSessionId} delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    acknowledgedSessions: [...acknowledgedSessions],
    acknowledgedObservers: [...acknowledgedObservers],
    acknowledgedObserverSettlements,
    complete: resolved.complete && exactEvidenceComplete,
    corruptEvidence,
    errors,
  };
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
      if (
        !current
        || !workflowRunRecordPathOwnsId(filePath, current.id)
        || current.reportBack === undefined
      ) return false;
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
      const acknowledgedSessions = uniqueStrings(
        current.reportBack.acknowledgedOriginSessionIds,
        delivered.acknowledgedSessions,
      );
      const acknowledgedObservers = uniqueStrings(
        delivered.acknowledgedObservers,
      );
      const acknowledgedObserverSettlements = Object.fromEntries(
        Object.entries(delivered.acknowledgedObserverSettlements).map(
          ([observerId, projection]) => [observerId, { ...projection }],
        ),
      );
      const finalOrigins = workflowRunReportBackRecipients(current);
      const allAcknowledged = delivered.complete
        && finalOrigins.complete
        && finalOrigins.legacyOriginSessionIds.every((id) => acknowledgedSessions.includes(id))
        && finalOrigins.exactObservers.every(
          (observer) => acknowledgedObservers.includes(observer.observerId)
            && acknowledgedObserverSettlements[observer.observerId] !== undefined,
        );
      const next: WorkflowRunReportBackRecord = {
        ...current,
        reportBack: {
          ...current.reportBack,
          acknowledgedOriginSessionIds: acknowledgedSessions,
          // Always overwrite the projection, including with an empty array.
          // Omitting the property here would preserve a forged/stale value from
          // the spread above even though no settlement re-established it.
          acknowledgedOriginObserverIds: acknowledgedObservers,
          acknowledgedOriginObserverSettlements: acknowledgedObserverSettlements,
        },
      };
      if (allAcknowledged) {
        next.reportBackAcknowledgedAt = current.reportBackAcknowledgedAt ?? new Date(now).toISOString();
        delete next.reportBackRetry;
      } else {
        delete next.reportBackAcknowledgedAt;
        const corruptError = !delivered.corruptEvidence && finalOrigins.evidenceState !== 'corrupt'
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
      if (allAcknowledged) {
        try {
          updateLinkedFocusAction(current.id, {
            status: current.reportBack.outcome === 'done' ? 'done' : 'blocked',
            note: current.reportBack.outcome === 'done'
              ? 'Completed and reported back.'
              : current.reportBack.detail.replace(/\s+/g, ' ').trim().slice(0, 240),
          });
        } catch { /* workstate projection never invalidates the durable receipt */ }
        // Compact only after this member's acknowledgement projection is
        // durable. Multi-member groups compact when the final member converges;
        // a failed early attempt is harmless and the scheduler retains a
        // tombstone-safe cleanup path.
        for (const sourceGroupId of new Set(finalOrigins.exactObservers.map(
          (observer) => observer.sourceGroupId,
        ))) {
          try { compactSettledWorkflowOriginGroup(sourceGroupId); } catch { /* later member/reaper retries */ }
        }
      }
      return allAcknowledged;
    });
  } catch {
    return false;
  }
}

export function recordAndAttemptWorkflowRunReportBack(
  filePath: string,
  input: Omit<
    WorkflowRunReportBackEnvelope,
    | 'version'
    | 'acknowledgedOriginSessionIds'
    | 'acknowledgedOriginObserverIds'
    | 'acknowledgedOriginObserverSettlements'
  >,
): boolean {
  const checkpointed = checkpointWorkflowRunReportBack(filePath, input);
  if (!checkpointed) return false;
  const run = readRunRecordUnlocked(filePath);
  if (run) {
    updateLinkedFocusAction(run.id, {
      status: input.outcome === 'done' ? 'done' : 'blocked',
      note: input.outcome === 'done'
        ? 'Completed; result delivery pending.'
        : input.detail.replace(/\s+/g, ' ').trim().slice(0, 240),
    });
  }
  return attemptWorkflowRunReportBack(filePath);
}

/** True when delivery failed, its aggregate marker is missing, or a late
 * observer sidecar is newer than the persisted acknowledgement generation. */
export function workflowRunReportBackNeedsRetry(run: WorkflowRunReportBackRecord): boolean {
  if (!validEnvelope(run.reportBack)) return run.reportBack !== undefined;
  if (!outcomeMatchesCanonicalStatus(run, run.reportBack.outcome)) return true;
  const origins = workflowRunReportBackRecipients(run);
  if (!origins.complete || !(run.reportBackAcknowledgedAt ?? run.notifiedAt)) return true;
  // Dashboard notification evidence (`notifiedAt`) predates exact observers and
  // is never a substitute for their channel receipt.
  if (origins.exactObservers.length > 0 && !run.reportBackAcknowledgedAt) return true;
  const acknowledgedSessions = new Set(uniqueStrings(run.reportBack.acknowledgedOriginSessionIds));
  const acknowledgedObservers = new Set(uniqueStrings(run.reportBack.acknowledgedOriginObserverIds));
  const acknowledgedObserverSettlements = run.reportBack.acknowledgedOriginObserverSettlements;
  return origins.legacyOriginSessionIds.some((id) => !acknowledgedSessions.has(id))
    || origins.exactObservers.some((observer) => {
      if (!acknowledgedObservers.has(observer.observerId)) return true;
      const projection = acknowledgedObserverSettlements?.[observer.observerId];
      if (!projection) return true;
      try {
        const settlement = readWorkflowOriginGroupSettlement(observer.sourceGroupId);
        const exactDeliveryReceipt = exactOriginDeliveryReceiptForTarget(observer.replyTarget);
        const settledMember = settlement?.memberReportBackDigests.find(
          (member) => member.runId === observer.runId,
        );
        const localReportBackDigest = workflowRunReportBackContentDigest(run.reportBack!);
        return !settlement
          || !exactDeliveryReceipt
          || !settledMember
          || settlement.sourceGroupId !== observer.sourceGroupId
          || settlement.sourceGroupDigest !== observer.sourceGroupDigest
          || settlement.observerId !== observer.observerId
          || settlement.replyTargetDigest !== observer.replyTargetDigest
          || settlement.exactDeliveryReceipt !== exactDeliveryReceipt
          || !settlement.memberRunIds.includes(observer.runId)
          || projection.settlementDigest !== settlement.settlementDigest
          || projection.reportBackDigest !== localReportBackDigest
          || settledMember.reportBackDigest !== localReportBackDigest;
      } catch {
        return true;
      }
    });
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
  const acknowledged = delivered.complete
    && required.complete
    && workflowRunReportBackRecipients(run).legacyOriginSessionIds.every(
      (id) => delivered.acknowledgedSessions.includes(id),
    )
    && workflowRunReportBackRecipients(run).exactObservers.every(
      (observer) => delivered.acknowledgedObservers.includes(observer.observerId),
    );
  updateLinkedFocusAction(run.id, {
    status: outcome === 'done' ? 'done' : 'blocked',
    note: outcome === 'done'
      ? acknowledged ? 'Completed and reported back.' : 'Completed; result delivery pending.'
      : detail.replace(/\s+/g, ' ').trim().slice(0, 240),
  });
  return acknowledged;
}
