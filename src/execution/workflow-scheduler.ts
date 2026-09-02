import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { CRON_RUNS_DIR, WORKFLOW_RUNS_DIR, ensureDir } from '../tools/shared.js';
import { WORKFLOWS_DIR } from '../memory/vault.js';
import { listWorkflows } from '../memory/workflow-store.js';
import { reapRunEventDir } from './workflow-events.js';
import {
  deleteWorkflowGraphSnapshotByRunId,
  loadWorkflowGraphSnapshotByRunId,
} from './workflow-graph-store.js';
import {
  isCatalogWorkflowRunDefinitionSnapshot,
  isCompiledWorkflowRunDefinitionSnapshot,
  resolveWorkflowRunDefinitionSnapshot,
} from './workflow-run-definition.js';
import { validateCronExpression } from '../shared/cron.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import {
  prospectiveIntentionId,
  recordProspectiveCue,
  recordProspectiveOutcome,
} from '../runtime/prospective-intentions.js';
// Static import (2026-07-20): the old lazy `require('../runtime/notifications.js')`
// was DEAD CODE in this "type":"module" package — require is undefined in ESM,
// so the backpressure, catch-up, and enqueue-failure notices silently fell into
// their catch blocks and NEVER reached the user. No cycle: notifications
// imports nothing from execution/.
import {
  addNotification,
  getNotification,
  markNotificationRead,
} from '../runtime/notifications.js';
import {
  queueWorkflowRun,
  readWorkflowTriggerReceiptAcceptance,
  type QueueWorkflowRunResult,
} from '../tools/workflow-run-queue.js';
import {
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
  writeWorkflowRunRecordDurablyUnlocked,
} from './workflow-run-record.js';
import { readWorkflowRunCancellation } from './workflow-run-cancellation.js';
import {
  workflowRunReportBackNeedsRetry,
  type WorkflowRunReportBackRecord,
} from './workflow-run-report-back.js';
import { compiledProjectRootHasSettlementMarker } from './project-root-lifecycle.js';
import {
  cleanupSettledWorkflowRunChatDispatchPreparations,
  workflowRunHasPendingChatDispatchAdmission,
  workflowRunHasPendingInlineChatDispatchAdmission,
  workflowRunHasPendingChatDispatchPreparation,
  workflowRunsWithPendingChatDispatchAdmissions,
} from './workflow-origin-group.js';
import { processWorkflowIntervalSchedules } from './workflow-interval-scheduler.js';
import { WORKFLOW_RAW_SUBPROCESS_REFUSAL_CODE } from './workflow-raw-subprocess-policy.js';

/**
 * Workflow scheduling tick.
 *
 * Today's reality before this module: the daemon polled CRON.md and
 * ran one-off prompts via `runCronJob`, but workflows had
 * `trigger.schedule` declared in their type and NOTHING actually
 * matched that schedule against the wall clock. Scheduled workflows
 * never fired on their own.
 *
 * What this module does (clean lane — does not touch workflow-runner.ts):
 *   - Loads every workflow (via existing workflow-store)
 *   - For each one with `enabled && trigger.schedule` matching the
 *     current minute, queues a run record through the shared workflow queue
 *   - Dedupes by per-workflow minute-key so a daemon that ticks twice
 *     in the same minute doesn't double-fire
 *   - The existing `processWorkflowRuns` picks the queued run up on the
 *     next tick and executes it through the normal workflow runner
 *
 * Coordination contract: this module ONLY queues workflow runs. It
 * does not read or mutate any in-flight run state. Any concurrent work
 * happening inside workflow-runner.ts is decoupled.
 */

const logger = pino({ name: 'clementine-next.workflow-scheduler' });

// Keep schedule state next to the cron daemon state so backup/clean-up
// happens uniformly. Format mirrors the cron path but with a `wf:`
// prefix to namespace the keys.
const SCHEDULE_STATE_FILE = path.join(path.dirname(CRON_RUNS_DIR), 'workflow-schedule-state.json');
const SCHEDULE_RETENTION_DAYS = 7;

interface ScheduleState {
  lastRunByMinute: Record<string, string>; // key = "wf:<stable-slug>", value = "YYYY-MM-DDTHH:MM"
  /** Canonical occurrence identity. Unlike local minute strings, epoch minutes
   *  remain strictly ordered across DST fall-back and host clock rollback. */
  lastRunAtMs: Record<string, number>;
  /** Frozen, durable work discovered before the rolling catch-up window moves
   *  on. Pending occurrences are intentionally not retention-pruned. */
  pendingByWorkflow: Record<string, PendingScheduleOccurrence>;
  // Wall-clock minute (epoch ms, minute-floored) of the last scheduler tick.
  // Drives misfire CATCH-UP: a daemon asleep at a schedule's fire-minute (the
  // canonical laptop case) used to silently drop that run because cron was only
  // matched against `now`. We now backfill the missed window on the next tick.
  lastEvaluatedAtMs?: number;
}

interface PendingScheduleOccurrence {
  /** Age used only for fair admission; unlike atMs it never advances while
   * newer missed occurrences collapse into this pending unit. */
  firstDueAtMs: number;
  atMs: number;
  minuteKey: string;
  scheduleKey: string;
  missed: number;
}

function emptyScheduleState(): ScheduleState {
  return { lastRunByMinute: {}, lastRunAtMs: {}, pendingByWorkflow: {} };
}

function loadScheduleState(): ScheduleState {
  if (!existsSync(SCHEDULE_STATE_FILE)) return emptyScheduleState();
  try {
    const parsed = JSON.parse(readFileSync(SCHEDULE_STATE_FILE, 'utf-8')) as Partial<ScheduleState>;
    const lastRunByMinute: Record<string, string> =
      parsed.lastRunByMinute && typeof parsed.lastRunByMinute === 'object' && !Array.isArray(parsed.lastRunByMinute)
        ? Object.fromEntries(
          Object.entries(parsed.lastRunByMinute).filter((entry): entry is [string, string] =>
            typeof entry[1] === 'string'),
        )
        : {};
    const lastRunAtMs =
      parsed.lastRunAtMs && typeof parsed.lastRunAtMs === 'object' && !Array.isArray(parsed.lastRunAtMs)
        ? Object.fromEntries(
          Object.entries(parsed.lastRunAtMs).filter((entry): entry is [string, number] =>
            Number.isFinite(entry[1])),
        )
        : {};
    const pendingByWorkflow: Record<string, PendingScheduleOccurrence> = {};
    if (
      parsed.pendingByWorkflow
      && typeof parsed.pendingByWorkflow === 'object'
      && !Array.isArray(parsed.pendingByWorkflow)
    ) {
      for (const [key, value] of Object.entries(parsed.pendingByWorkflow)) {
        if (
          value
          && typeof value === 'object'
          && Number.isFinite(value.atMs)
          && typeof value.minuteKey === 'string'
          && typeof value.scheduleKey === 'string'
        ) {
          pendingByWorkflow[key] = {
            firstDueAtMs: Number.isFinite(value.firstDueAtMs)
              ? minuteFloor(value.firstDueAtMs)
              : minuteFloor(value.atMs),
            atMs: minuteFloor(value.atMs),
            minuteKey: value.minuteKey,
            scheduleKey: value.scheduleKey,
            missed: Number.isFinite(value.missed) && value.missed >= 0 ? Math.floor(value.missed) : 0,
          };
        }
      }
    }
    return {
      lastRunByMinute,
      lastRunAtMs,
      pendingByWorkflow,
      ...(Number.isFinite(parsed.lastEvaluatedAtMs)
        ? { lastEvaluatedAtMs: parsed.lastEvaluatedAtMs }
        : {}),
    };
  } catch (err) {
    const preserved = `${SCHEDULE_STATE_FILE}.corrupt-${Date.now()}`;
    try {
      renameSync(SCHEDULE_STATE_FILE, preserved);
      fsyncParentDirectory(SCHEDULE_STATE_FILE);
    } catch (preserveErr) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          preserveErr: preserveErr instanceof Error ? preserveErr.message : String(preserveErr),
        },
        'Workflow schedule state is corrupt and could not be preserved; scheduler is stopping fail-closed',
      );
      surfaceScheduleStateCorruption(err, undefined);
      throw preserveErr;
    }
    logger.error(
      { err: err instanceof Error ? err.message : String(err), preserved },
      'Workflow schedule state was corrupt; preserved the unreadable file and reset recovery state',
    );
    surfaceScheduleStateCorruption(err, preserved);
    return emptyScheduleState();
  }
}

function surfaceScheduleStateCorruption(err: unknown, preserved: string | undefined): void {
  try {
    const dayKey = new Date().toISOString().slice(0, 10);
    addNotification({
      id: `system-workflow-schedule-state-corrupt-${dayKey}`,
      kind: 'system',
      title: 'Workflow schedule recovery state was unreadable',
      body:
        'Clementine preserved the corrupt scheduler state and restarted schedule tracking. '
        + 'A previously discovered but not-yet-queued occurrence may need review.'
        + (preserved ? ` Preserved file: ${preserved}` : ''),
      createdAt: new Date().toISOString(),
      read: false,
      metadata: {
        errorCategory: 'workflow_schedule_state_corrupt',
        error: err instanceof Error ? err.message : String(err),
        ...(preserved ? { preservedFile: preserved } : {}),
      },
    });
  } catch {
    // The error log remains the backstop if notification storage is unavailable.
  }
}

function fsyncParentDirectory(filePath: string): void {
  if (process.platform === 'win32') return;
  let directoryFd: number | undefined;
  try {
    directoryFd = openSync(path.dirname(filePath), 'r');
    fsyncSync(directoryFd);
  } finally {
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}

function pruneScheduleState(state: ScheduleState): ScheduleState {
  const referenceMs = Number.isFinite(state.lastEvaluatedAtMs) ? state.lastEvaluatedAtMs! : Date.now();
  const cutoffMs = referenceMs - SCHEDULE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const legacyCutoff = new Date(cutoffMs).toISOString().slice(0, 16);
  const nextMinute: Record<string, string> = {};
  const nextEpoch: Record<string, number> = {};
  for (const [key, minuteKey] of Object.entries(state.lastRunByMinute)) {
    const epoch = state.lastRunAtMs[key];
    if ((Number.isFinite(epoch) && epoch >= cutoffMs) || (!Number.isFinite(epoch) && minuteKey >= legacyCutoff)) {
      nextMinute[key] = minuteKey;
      if (Number.isFinite(epoch)) nextEpoch[key] = epoch;
    }
  }
  return {
    lastRunByMinute: nextMinute,
    lastRunAtMs: nextEpoch,
    pendingByWorkflow: state.pendingByWorkflow,
    lastEvaluatedAtMs: state.lastEvaluatedAtMs,
  };
}

function saveScheduleState(state: ScheduleState): void {
  ensureDir(path.dirname(SCHEDULE_STATE_FILE));
  const pruned = pruneScheduleState(state);
  const tempFile = `${SCHEDULE_STATE_FILE}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  let tempFd: number | undefined;
  try {
    tempFd = openSync(tempFile, 'wx', 0o600);
    writeFileSync(tempFd, JSON.stringify(pruned, null, 2), 'utf-8');
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = undefined;
    renameSync(tempFile, SCHEDULE_STATE_FILE);
    fsyncParentDirectory(SCHEDULE_STATE_FILE);
  } catch (err) {
    if (tempFd !== undefined) {
      try {
        closeSync(tempFd);
      } catch { /* best-effort descriptor cleanup */ }
    }
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    } catch { /* best-effort temp cleanup */ }
    throw err;
  }
  state.lastRunByMinute = pruned.lastRunByMinute;
  state.lastRunAtMs = pruned.lastRunAtMs;
  state.pendingByWorkflow = pruned.pendingByWorkflow;
}

/** Cap on how far back catch-up will scan (a daemon off for a week shouldn't
 *  replay 10k minutes — fire each missed schedule once within the last day). */
const MAX_CATCHUP_MINUTES = 24 * 60;

function minuteFloor(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

/**
 * The wall-clock minutes to evaluate this tick: just `now` on a normal tick, or
 * the backfilled window [lastEval+1 … now] (capped) after the daemon was asleep.
 * Pure + exported for tests. First-ever tick (no lastEvaluatedAtMs) returns only
 * `now` — never a spurious backfill on first boot.
 */
export function scheduleCatchupWindow(lastEvaluatedAtMs: number | undefined, nowMs: number): Date[] {
  const nowMin = minuteFloor(nowMs);
  if (lastEvaluatedAtMs === undefined) return [new Date(nowMin)];
  let startMin = minuteFloor(lastEvaluatedAtMs) + 60_000; // minute AFTER the last evaluated one
  const earliest = nowMin - MAX_CATCHUP_MINUTES * 60_000;
  if (startMin < earliest) startMin = earliest;
  if (startMin > nowMin) return [new Date(nowMin)]; // same minute as last tick → just now
  const out: Date[] = [];
  for (let t = startMin; t <= nowMin; t += 60_000) out.push(new Date(t));
  return out;
}

// ── Cron matching (intentionally identical semantics to the daemon's
// cron path so users can move expressions between them without
// surprises). ─────────────────────────────────────────────────────────


function fieldMatch(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return !Number.isNaN(step) && step > 0 && value % step === 0;
  }
  for (const part of field.split(',')) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (!Number.isNaN(a) && !Number.isNaN(b) && value >= a && value <= b) return true;
    } else if (parseInt(part, 10) === value) {
      return true;
    }
  }
  return false;
}

interface WallClock { minute: number; hour: number; dayOfMonth: number; month: number; dayOfWeek: number; }

/** The wall-clock fields of `at` in an IANA timezone (default = host local, so
 *  a schedule with no timezone is byte-identical to before). Never throws — an
 *  invalid/unknown tz falls back to host local rather than breaking the tick. */
export function wallClockInZone(at: Date, tz?: string): WallClock {
  const local = (): WallClock => ({
    minute: at.getMinutes(), hour: at.getHours(), dayOfMonth: at.getDate(),
    month: at.getMonth() + 1, dayOfWeek: at.getDay(),
  });
  if (!tz) return local();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      minute: '2-digit', hour: '2-digit', day: '2-digit', month: '2-digit', weekday: 'short',
    }).formatToParts(at);
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
    const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    let hour = Number.parseInt(get('hour'), 10);
    if (hour === 24) hour = 0; // some ICU builds render midnight as "24"
    return {
      minute: Number.parseInt(get('minute'), 10),
      hour,
      dayOfMonth: Number.parseInt(get('day'), 10),
      month: Number.parseInt(get('month'), 10),
      dayOfWeek: wd[get('weekday')] ?? at.getDay(),
    };
  } catch {
    return local();
  }
}

export function cronMatches(expr: string, at: Date, tz?: string): boolean {
  if (!validateCronExpression(expr)) return false;
  const [min, hour, dom, mon, dow] = expr.trim().split(/\s+/);
  const wc = wallClockInZone(at, tz);
  return (
    fieldMatch(min, wc.minute) &&
    fieldMatch(hour, wc.hour) &&
    fieldMatch(dom, wc.dayOfMonth) &&
    fieldMatch(mon, wc.month) &&
    fieldMatch(dow, wc.dayOfWeek)
  );
}

function currentMinuteKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

interface ScheduledFireResult {
  /** Names of workflows that matched and got enqueued this tick. */
  fired: string[];
  /** Names whose run the queue answered `held`: Clem is rewriting a legacy
   *  script step first (workflow-self-improvement.ts) and re-queues the run
   *  when the rewrite passes. No workflow step has run. A MISSED occurrence
   *  is never held for a human Resume/Skip any more: it fires, paced one
   *  catch-up lineage at a time by the runner's admission. */
  held: string[];
  /** Names whose exact occurrence was durably recorded as non-executable after
   *  a deterministic readiness refusal. These are not catch-up decisions and
   *  cannot be opened by Resume. */
  blocked: string[];
  /** Stale decisions left durably pending because this tick reached the
   * bounded control-plane materialization budget. */
  deferred: string[];
  /** Names that matched but were skipped because we already fired this minute. */
  deduped: string[];
}

interface ScheduledReadinessBlockerEvidence {
  kind?: string;
  name?: string;
  reason?: string;
  stepIds?: string[];
}

export interface ScheduledReadinessBlockClassification {
  kind: 'migration_required' | 'capability_required';
  code: typeof WORKFLOW_RAW_SUBPROCESS_REFUSAL_CODE | 'workflow_readiness_blocked';
  blockers: ScheduledReadinessBlockerEvidence[];
  detail: string;
}

/**
 * Pure scheduler policy: a typed queue readiness refusal is deterministic and
 * must become one durable no-effect occurrence. Thrown queue/storage failures
 * are deliberately outside this classifier and retain the existing retry path.
 */
export function classifyScheduledReadinessBlock(input: {
  status: string;
  message?: string;
  blockers?: ScheduledReadinessBlockerEvidence[];
}): ScheduledReadinessBlockClassification | null {
  if (input.status !== 'blocked_readiness') return null;
  const blockers = Array.isArray(input.blockers) ? input.blockers : [];
  const migrationBlockers = blockers.filter((blocker) =>
    typeof blocker.reason === 'string'
    && blocker.reason.includes(WORKFLOW_RAW_SUBPROCESS_REFUSAL_CODE));
  if (migrationBlockers.length > 0) {
    return {
      kind: 'migration_required',
      code: WORKFLOW_RAW_SUBPROCESS_REFUSAL_CODE,
      blockers,
      detail: migrationBlockers.map((blocker) => blocker.reason).filter(Boolean).join('\n'),
    };
  }
  return {
    kind: 'capability_required',
    code: 'workflow_readiness_blocked',
    blockers,
    detail: blockers.map((blocker) => blocker.reason).filter(Boolean).join('\n')
      || input.message?.trim()
      || 'The workflow readiness contract is not currently satisfied.',
  };
}

interface ScheduledReadinessRecordIdentity {
  runId: string;
  workflowName: string;
  workflowSlug: string;
  scheduledAtMs: number;
  createdAt: string;
  readiness: Record<string, unknown>;
  blockers: ScheduledReadinessBlockerEvidence[];
  detail: string;
  state: 'legacy_hold' | 'blocked_readiness';
}

export interface LegacyScheduledReadinessReconcileResult {
  inspected: number;
  migrated: number;
  recovered: number;
  noticesEnsured: number;
  notificationsRetired: number;
  rejected: number;
  failed: number;
  limitReached: boolean;
  migratedRunIds: string[];
}

function scheduledReadinessObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function scheduledReadinessString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function scheduledReadinessBlockers(value: unknown): ScheduledReadinessBlockerEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ScheduledReadinessBlockerEvidence[] => {
    const raw = scheduledReadinessObject(item);
    if (!raw) return [];
    return [{
      ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}),
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
      ...(Array.isArray(raw.stepIds)
        ? { stepIds: raw.stepIds.filter((step): step is string => typeof step === 'string') }
        : {}),
    }];
  });
}

function hasRawSubprocessReadinessRefusal(record: Record<string, unknown>): boolean {
  const readiness = scheduledReadinessObject(record.readiness);
  return readiness?.ok === false
    && scheduledReadinessBlockers(readiness.blockers).some((blocker) =>
      blocker.reason?.includes(WORKFLOW_RAW_SUBPROCESS_REFUSAL_CODE));
}

const SCHEDULED_READINESS_EXECUTION_PROJECTION_FIELDS = [
  'startedAt',
  'finishedAt',
  'cancelledAt',
  'originSessionId',
  'originSessionIds',
  'requeuedFromRunId',
  'retryFailedItemsFromRunId',
  'retryFailedItemsStepId',
  'retryFailedItemKeys',
  'targetStepId',
  'selfHealAttempt',
  'goalAttempt',
  'stepOutputs',
  'output',
  'error',
  'mutationContractSnapshot',
  'parked',
  'capabilityBlock',
  'mutationBlock',
  'workflowGraphFinalizingFingerprint',
  'reportBack',
  'recoveryIntent',
] as const;

/**
 * Authenticate one exact pre-fix hold (or an already-migrated generation that
 * still needs its notification repaired). The receipt, immutable definition,
 * empty scheduled inputs, and total absence of execution projections are all
 * required; a hand-authored status string cannot gain migration authority.
 */
function scheduledReadinessRecordIdentity(
  record: Record<string, unknown>,
  expectedRunId: string,
): ScheduledReadinessRecordIdentity | null {
  const runId = scheduledReadinessString(record.id);
  const workflowName = scheduledReadinessString(record.workflow);
  const workflowSlug = scheduledReadinessString(record.workflowSlug);
  const createdAt = scheduledReadinessString(record.createdAt);
  if (
    runId !== expectedRunId
    || !workflowName
    || !workflowSlug
    || workflowSlug.includes(':')
    || !createdAt
    || !Number.isFinite(Date.parse(createdAt))
    || record.source !== 'schedule'
  ) return null;

  const inputs = scheduledReadinessObject(record.inputs);
  if (!inputs || Object.keys(inputs).length !== 0) return null;
  if (SCHEDULED_READINESS_EXECUTION_PROJECTION_FIELDS.some((field) => record[field] !== undefined)) {
    return null;
  }
  if (readWorkflowRunCancellation(runId)) return null;

  const admitted = resolveWorkflowRunDefinitionSnapshot(record.workflowDefinitionSnapshot);
  if (
    admitted.status !== 'valid'
    || !isCatalogWorkflowRunDefinitionSnapshot(admitted.snapshot)
    || admitted.snapshot.workflowSlug !== workflowSlug
    || admitted.snapshot.definition.name.trim() !== workflowName
  ) return null;

  const triggerReceiptId = scheduledReadinessString(record.triggerReceiptId);
  const receipt = triggerReceiptId
    ? /^workflow-schedule:v1:([^:]+):(\d+)$/.exec(triggerReceiptId)
    : null;
  if (!receipt || receipt[1] !== workflowSlug) return null;
  const scheduledAtMs = Number(receipt[2]);
  if (!Number.isSafeInteger(scheduledAtMs) || scheduledAtMs < 0) return null;
  if (readWorkflowTriggerReceiptAcceptance(triggerReceiptId!) !== runId) return null;

  const recordedScheduledAtMs = record.catchupScheduledAtMs;
  if (
    recordedScheduledAtMs !== undefined
    && (!Number.isSafeInteger(recordedScheduledAtMs) || recordedScheduledAtMs !== scheduledAtMs)
  ) return null;
  if (
    existsSync(path.join(WORKFLOWS_DIR, workflowSlug, 'runs', runId))
    || loadWorkflowGraphSnapshotByRunId(runId)
  ) return null;

  const readiness = scheduledReadinessObject(record.readiness);
  if (!readiness || readiness.ok !== false) return null;
  const blockers = scheduledReadinessBlockers(readiness.blockers);
  const classification = classifyScheduledReadinessBlock({
    status: 'blocked_readiness',
    message: scheduledReadinessString(record.readinessMessage),
    blockers,
  });
  if (
    !classification
    || classification.kind !== 'migration_required'
    || classification.code !== WORKFLOW_RAW_SUBPROCESS_REFUSAL_CODE
  ) return null;

  let state: ScheduledReadinessRecordIdentity['state'];
  if (record.status === 'awaiting_catchup_decision') {
    const heldAt = scheduledReadinessString(record.catchupHeldAt);
    const occurrenceAtMs = record.catchupOccurrenceAtMs;
    const firstDueAtMs = record.catchupFirstDueAtMs;
    const missedCount = record.catchupMissedCount;
    if (
      record.catchupFire !== true
      || record.catchupDisposition !== 'held'
      || record.catchupDecidedAt !== undefined
      || record.scheduledReadinessBlock !== undefined
      || !heldAt
      || !Number.isFinite(Date.parse(heldAt))
      || !Number.isSafeInteger(occurrenceAtMs)
      || (occurrenceAtMs as number) < 0
      || (occurrenceAtMs as number) > scheduledAtMs
      || !Number.isSafeInteger(firstDueAtMs)
      || (firstDueAtMs as number) < 0
      || (firstDueAtMs as number) > scheduledAtMs
      || !Number.isSafeInteger(missedCount)
      || (missedCount as number) < 1
    ) return null;
    state = 'legacy_hold';
  } else if (record.status === 'blocked_readiness') {
    const marker = scheduledReadinessObject(record.scheduledReadinessBlock);
    if (
      !marker
      || marker.protocol !== 'workflow_schedule_readiness_block_v1'
      || marker.provenNoDispatch !== true
      || !scheduledReadinessString(marker.blockedAt)
      || record.catchupDisposition !== undefined
      || record.catchupHeldAt !== undefined
      || record.catchupDecidedAt !== undefined
    ) return null;
    state = 'blocked_readiness';
  } else {
    return null;
  }

  return {
    runId,
    workflowName,
    workflowSlug,
    scheduledAtMs,
    createdAt,
    readiness,
    blockers,
    detail: classification.detail,
    state,
  };
}

function scheduledReadinessNoticeMatches(
  notification: ReturnType<typeof getNotification>,
  identity: ScheduledReadinessRecordIdentity,
): boolean {
  if (!notification) return false;
  const metadata = notification.metadata;
  return notification.id === `system-workflow-readiness-blocked-${identity.runId}`
    && metadata?.errorCategory === 'workflow_schedule_migration_required'
    && metadata.workflow === identity.workflowName
    && metadata.workflowRunId === identity.runId
    && metadata.runId === identity.runId
    && metadata.status === 'blocked_readiness'
    && metadata.blockerCode === WORKFLOW_RAW_SUBPROCESS_REFUSAL_CODE
    && metadata.provenNoDispatch === true
    && metadata.needsAttention === true
    && metadata.migrationRequired === true
    && /not resumable/i.test(notification.body)
    && !/Resume or Skip/i.test(notification.body);
}

function matchingLegacyCatchupNotice(
  identity: ScheduledReadinessRecordIdentity,
): ReturnType<typeof getNotification> {
  const notification = getNotification(`system-workflow-catchup-held-${identity.runId}`);
  if (
    notification?.metadata?.errorCategory !== 'workflow_schedule_catchup_held'
    || notification.metadata.workflow !== identity.workflowName
    || notification.metadata.workflowRunId !== identity.runId
    || notification.metadata.runId !== identity.runId
    || notification.metadata.catchupHeld !== true
  ) return undefined;
  return notification;
}

function matchingLegacyEnqueueFailureNotice(
  identity: ScheduledReadinessRecordIdentity,
): ReturnType<typeof getNotification> {
  const dayKey = new Date(identity.scheduledAtMs).toISOString().slice(0, 10);
  const notification = getNotification(
    `system-workflow-enqueue-failed-${identity.workflowName}-${dayKey}`,
  );
  if (
    notification?.metadata?.errorCategory !== 'workflow_enqueue_failed'
    || notification.metadata.workflow !== identity.workflowName
    || !notification.body.includes(WORKFLOW_RAW_SUBPROCESS_REFUSAL_CODE)
  ) return undefined;
  return notification;
}

/**
 * One-time compatibility repair for schedule occurrences admitted immediately
 * before `persistScheduledReadinessBlock` shipped. It is state-only: no run is
 * queued, resumed, drained, or given execution authority.
 *
 * Crash order is deliberate: canonical run state first, replacement notice
 * second, stale carriers retired last. A later boot can finish either partial
 * generation without repeating workflow work or hiding the old warning early.
 */
export function reconcileLegacyScheduledReadinessHolds(
  options: { limit?: number } = {},
): LegacyScheduledReadinessReconcileResult {
  const requestedLimit = options.limit ?? 32;
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(256, requestedLimit))
    : 32;
  const result: LegacyScheduledReadinessReconcileResult = {
    inspected: 0,
    migrated: 0,
    recovered: 0,
    noticesEnsured: 0,
    notificationsRetired: 0,
    rejected: 0,
    failed: 0,
    limitReached: false,
    migratedRunIds: [],
  };
  if (!existsSync(WORKFLOW_RUNS_DIR)) return result;

  let files: string[];
  try {
    files = readdirSync(WORKFLOW_RUNS_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();
  } catch {
    result.failed += 1;
    return result;
  }

  for (const file of files) {
    let snapshot: Record<string, unknown>;
    try {
      const parsed = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as unknown;
      const object = scheduledReadinessObject(parsed);
      if (!object) continue;
      snapshot = object;
    } catch {
      continue;
    }
    if (
      snapshot.status !== 'awaiting_catchup_decision'
      && snapshot.status !== 'blocked_readiness'
    ) continue;
    if (!hasRawSubprocessReadinessRefusal(snapshot)) continue;
    if (result.inspected >= limit) {
      result.limitReached = true;
      break;
    }
    result.inspected += 1;

    const filePath = path.join(WORKFLOW_RUNS_DIR, file);
    let identity: ScheduledReadinessRecordIdentity | null = null;
    let migrated = false;
    try {
      identity = withWorkflowRunRecordLock(filePath, () => {
        const current = readWorkflowRunRecordUnlocked<Record<string, unknown>>(filePath);
        if (!current) return null;
        const authenticated = scheduledReadinessRecordIdentity(
          current,
          file.slice(0, -'.json'.length),
        );
        if (!authenticated) return null;
        if (authenticated.state === 'blocked_readiness') return authenticated;

        const {
          catchupDisposition: _catchupDisposition,
          catchupHeldAt: _catchupHeldAt,
          catchupDecidedAt: _catchupDecidedAt,
          ...preserved
        } = current;
        const next: Record<string, unknown> = {
          ...preserved,
          status: 'blocked_readiness',
          scheduledReadinessBlock: {
            protocol: 'workflow_schedule_readiness_block_v1',
            blockedAt: authenticated.createdAt,
            provenNoDispatch: true,
          },
          readinessMessage: authenticated.detail,
        };
        writeWorkflowRunRecordDurablyUnlocked(filePath, next);
        migrated = true;
        return { ...authenticated, state: 'blocked_readiness' };
      });
    } catch (err) {
      result.failed += 1;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), file },
        'Legacy scheduled readiness hold reconciliation failed closed',
      );
      continue;
    }
    if (!identity) {
      result.rejected += 1;
      continue;
    }
    if (migrated) {
      result.migrated += 1;
      result.migratedRunIds.push(identity.runId);
    } else {
      result.recovered += 1;
    }

    const oldCatchup = matchingLegacyCatchupNotice(identity);
    const scheduledMinuteKey = typeof oldCatchup?.metadata?.scheduledMinuteKey === 'string'
      ? oldCatchup.metadata.scheduledMinuteKey
      : currentMinuteKey(new Date(identity.scheduledAtMs));
    const classification = classifyScheduledReadinessBlock({
      status: 'blocked_readiness',
      message: identity.detail,
      blockers: identity.blockers,
    });
    if (
      !classification
      || classification.kind !== 'migration_required'
      || !emitScheduledReadinessBlockedNotice(
        identity.workflowName,
        identity.runId,
        scheduledMinuteKey,
        classification,
      )
      || !scheduledReadinessNoticeMatches(
        getNotification(`system-workflow-readiness-blocked-${identity.runId}`),
        identity,
      )
    ) {
      result.failed += 1;
      continue;
    }
    result.noticesEnsured += 1;

    for (const legacy of [oldCatchup, matchingLegacyEnqueueFailureNotice(identity)]) {
      if (!legacy || legacy.read) continue;
      const retired = markNotificationRead(legacy.id);
      if (retired?.read) result.notificationsRetired += 1;
    }
  }
  return result;
}

/**
 * Daemon entry point. Idempotent within a minute. Safe to call every
 * 15s — only the first match per workflow per minute writes a run.
 */
export async function processWorkflowSchedules(now: Date = new Date()): Promise<ScheduledFireResult> {
  const result: ScheduledFireResult = { fired: [], held: [], blocked: [], deferred: [], deduped: [] };
  const nowMinuteMs = minuteFloor(now.getTime());
  const minuteKey = currentMinuteKey(new Date(nowMinuteMs));

  let workflows;
  try {
    workflows = listWorkflows();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'listWorkflows failed in scheduler');
    return result;
  }

  const state = loadScheduleState();
  const window = scheduleCatchupWindow(state.lastEvaluatedAtMs, now.getTime());
  const configured = new Map<string, {
    workflowName: string;
    entryName: string;
    schedule: string;
    timezone?: string;
    scheduleKey: string;
  }>();

  // Discovery is a separate, checkpointed phase. Every due occurrence becomes
  // durable BEFORE any queue write or long-running work can interrupt the pass.
  // Advancing the rolling 24h watermark is therefore safe: held work no longer
  // depends on rewinding a scan window to remain discoverable.
  for (const entry of workflows) {
    const wf = entry.data;
    if (!wf.enabled) continue;
    const schedule = wf.trigger?.schedule;
    if (!schedule || typeof schedule !== 'string') continue;

    // The directory/entry slug is stable identity. Display names are mutable,
    // so migrate the pre-v3.0.2 display-name key before doing any discovery.
    const dedupeKey = `wf:${entry.name}`;
    migrateLegacyWorkflowScheduleKey(state, `wf:${wf.name}`, dedupeKey);
    const timezone = typeof wf.trigger?.timezone === 'string' ? wf.trigger.timezone : undefined;
    const scheduleKey = `${schedule}\u0000${timezone ?? ''}`;
    configured.set(dedupeKey, {
      workflowName: wf.name,
      entryName: entry.name,
      schedule,
      timezone,
      scheduleKey,
    });

    let pending: PendingScheduleOccurrence | undefined = state.pendingByWorkflow[dedupeKey];
    if (
      pending
      && (
        pending.scheduleKey !== scheduleKey
        || (Number.isFinite(state.lastRunAtMs[dedupeKey]) && pending.atMs <= state.lastRunAtMs[dedupeKey])
      )
    ) {
      delete state.pendingByWorkflow[dedupeKey];
      pending = undefined;
    }

    const lastFiredAtMs = state.lastRunAtMs[dedupeKey];
    const legacyLastKey = state.lastRunByMinute[dedupeKey];
    for (const m of window) {
      if (!cronMatches(schedule, m, timezone)) continue;
      const atMs = minuteFloor(m.getTime());
      const k = currentMinuteKey(m);
      // New-format records compare epoch minutes. Legacy records retain their
      // prior lexical rule until the first handled occurrence writes an epoch,
      // avoiding an upgrade-time replay while removing the rule thereafter.
      const handled = Number.isFinite(lastFiredAtMs)
        ? atMs <= lastFiredAtMs
        : legacyLastKey !== undefined && k <= legacyLastKey;
      if (handled || (pending && atMs <= pending.atMs)) continue;
      pending = {
        firstDueAtMs: pending?.firstDueAtMs ?? atMs,
        atMs,
        minuteKey: k,
        scheduleKey,
        missed: (pending?.missed ?? -1) + 1,
      };
      state.pendingByWorkflow[dedupeKey] = pending;
    }

    if (
      !pending
      && cronMatches(schedule, now, timezone)
      && (
        state.lastRunAtMs[dedupeKey] === nowMinuteMs
        || (!Number.isFinite(state.lastRunAtMs[dedupeKey]) && state.lastRunByMinute[dedupeKey] === minuteKey)
      )
    ) {
      result.deduped.push(wf.name);
      recordOperationalEvent({
        source: 'workflow',
        type: 'workflow_trigger_deduped',
        severity: 'warn',
        actor: 'workflow-scheduler',
        payload: { workflowName: wf.name, schedule, reason: 'already_fired_this_minute' },
      });
    }
  }

  // Deleted, disabled, or unscheduled workflows explicitly abandon their held
  // occurrence. A changed schedule gets a new scheduleKey and is reconciled in
  // the discovery loop above.
  for (const dedupeKey of Object.keys(state.pendingByWorkflow)) {
    if (!configured.has(dedupeKey)) delete state.pendingByWorkflow[dedupeKey];
  }
  state.lastEvaluatedAtMs = nowMinuteMs;
  saveScheduleState(state);

  const candidates = Array.from(configured.entries())
    .map(([dedupeKey, config]) => {
      const occurrence = state.pendingByWorkflow[dedupeKey];
      return occurrence ? { dedupeKey, config, occurrence } : undefined;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> =>
      candidate !== undefined && candidate.occurrence.atMs <= nowMinuteMs);

  // A live-minute commitment always goes first. Stale recovery is oldest-first
  // so a recurring early config entry cannot continually starve older siblings.
  candidates.sort((a, b) => {
    const aLive = a.occurrence.atMs === nowMinuteMs ? 0 : 1;
    const bLive = b.occurrence.atMs === nowMinuteMs ? 0 : 1;
    return aLive - bLive
      || a.occurrence.firstDueAtMs - b.occurrence.firstDueAtMs
      || a.occurrence.atMs - b.occurrence.atMs
      || a.dedupeKey.localeCompare(b.dedupeKey);
  });

  let catchupHoldAttempts = 0;
  for (const { dedupeKey, config, occurrence } of candidates) {
    const { workflowName, entryName, schedule } = config;
    const latestKey = occurrence.minuteKey;
    const missed = occurrence.missed;
    const isCatchupFire = occurrence.atMs < nowMinuteMs;
    const prospectiveId = prospectiveIntentionId('workflow_schedule', workflowName);
    const prospectiveCueKey = `cron:${latestKey}`;
    try {
      recordProspectiveCue(
        prospectiveId,
        prospectiveCueKey,
        { workflowName, schedule, matchedMinute: latestKey, matchedAtMs: occurrence.atMs, missed },
        now,
      );
    } catch { /* the workflow schedule store remains authoritative */ }

    // Each durable run snapshot costs file creation + fsync, and the runner
    // admits catch-up lineages one at a time anyway. Bound the per-tick burst
    // of missed-occurrence materializations; the rest remain in
    // pendingByWorkflow and materialize on later ticks.
    if (isCatchupFire && catchupHoldAttempts >= MAX_CATCHUP_HOLDS_PER_TICK) {
      result.deferred.push(workflowName);
      logger.info(
        { workflow: workflowName, occurrenceAtMs: occurrence.atMs },
        'Deferred catch-up run materialization to a later scheduler tick',
      );
      continue;
    }
    if (isCatchupFire) catchupHoldAttempts += 1;

    // Every occurrence, live or missed, goes through the same active-run
    // checks: a run awaiting mutation reconciliation, a capability hold, a
    // parked approval, or queue backpressure defers it exactly like a live
    // fire. (Until 2026-09-01 a missed occurrence skipped these because it was
    // only ever parked as a zero-work Resume/Skip card; now it is real work.)
    {
      const activeRuns = countActiveRunsFor(workflowName, entryName);
      if (activeRuns.mutationBlocked > 0) {
        result.deduped.push(workflowName);
        recordOperationalEvent({
          source: 'workflow',
          type: 'workflow_trigger_deduped',
          severity: 'warn',
          actor: 'workflow-scheduler',
          payload: {
            workflowName,
            schedule,
            reason: 'mutation_awaiting_reconciliation',
            mutationBlocked: activeRuns.mutationBlocked,
          },
        });
        try {
          recordProspectiveOutcome(
            prospectiveId,
            'blocked',
            {
              reason: 'mutation_awaiting_reconciliation',
              mutationBlocked: activeRuns.mutationBlocked,
              cueKey: prospectiveCueKey,
            },
            now,
          );
        } catch { /* best-effort control-plane receipt */ }
        // Do not mark the occurrence handled. Reconciliation releases this
        // same durable occurrence; a later tick must not synthesize a new one.
        continue;
      }
      if (activeRuns.capabilityBlocked > 0) {
        result.deduped.push(workflowName);
        recordOperationalEvent({
          source: 'workflow',
          type: 'workflow_trigger_deduped',
          severity: 'warn',
          actor: 'workflow-scheduler',
          payload: {
            workflowName,
            schedule,
            reason: 'capability_awaiting_recovery',
            capabilityBlocked: activeRuns.capabilityBlocked,
          },
        });
        try {
          recordProspectiveOutcome(
            prospectiveId,
            'blocked',
            {
              reason: 'capability_awaiting_recovery',
              capabilityBlocked: activeRuns.capabilityBlocked,
              cueKey: prospectiveCueKey,
            },
            now,
          );
        } catch { /* best-effort control-plane receipt */ }
        // Keep this occurrence pending while the same proven-no-dispatch run
        // heals. Once it finishes, ordinary stale-occurrence recovery presents
        // the missed occurrence for Resume/Skip instead of burst-sending it.
        continue;
      }
      if (activeRuns.parked > 0) {
        result.deduped.push(workflowName);
        recordOperationalEvent({
          source: 'workflow',
          type: 'workflow_trigger_deduped',
          severity: 'info',
          actor: 'workflow-scheduler',
          payload: { workflowName, schedule, reason: 'parked_awaiting_approval', parked: activeRuns.parked },
        });
        try {
          recordProspectiveOutcome(
            prospectiveId,
            'blocked',
            { reason: 'parked_awaiting_approval', parked: activeRuns.parked, cueKey: prospectiveCueKey },
            now,
          );
        } catch { /* best-effort control-plane receipt */ }
        continue;
      }

      // Pending-queue cap. A held stale occurrence never consumes it; resumed
      // work later enters through the ordinary bounded run lane.
      const pending = activeRuns.pending;
      if (pending >= MAX_PENDING_PER_WORKFLOW) {
        result.deduped.push(workflowName);
        emitQueueBackpressureNotice(workflowName, pending);
        recordOperationalEvent({
          source: 'workflow',
          type: 'workflow_trigger_deduped',
          severity: 'warn',
          actor: 'workflow-scheduler',
          payload: { workflowName, schedule, reason: 'backpressure', pending },
        });
        markWorkflowOccurrenceHandled(state, dedupeKey, occurrence);
        saveScheduleState(state);
        try {
          recordProspectiveOutcome(
            prospectiveId,
            'blocked',
            { reason: 'schedule_backpressure', pending, cueKey: prospectiveCueKey },
            now,
          );
        } catch { /* best-effort control-plane receipt */ }
        continue;
      }
    }

    try {
      const queued = enqueueScheduledRun(
        workflowName,
        entryName,
        occurrence.atMs,
        isCatchupFire,
        occurrence.firstDueAtMs,
        occurrence.missed + 1,
        now.getTime(),
      );
      if (queued.status === 'blocked_readiness') {
        const classification = scheduledReadinessBlockClassificationForRun(workflowName, queued);
        if (!classification) {
          throw new Error(
            `Scheduled workflow "${workflowName}" returned blocked_readiness without durable blocker evidence.`,
          );
        }
        // Notification durability precedes retiring the pending occurrence. If
        // storage fails, the exact trigger receipt reopens this same blocked
        // run on the next tick and retries only the notice—not workflow work.
        if (!emitScheduledReadinessBlockedNotice(
          workflowName,
          queued.id,
          latestKey,
          classification,
        )) {
          logger.warn(
            { workflow: workflowName, runId: queued.id },
            'Could not durably surface scheduled readiness block; occurrence remains pending',
          );
          continue;
        }
        markWorkflowOccurrenceHandled(state, dedupeKey, occurrence);
        saveScheduleState(state);
        result.blocked.push(workflowName);
        try {
          recordProspectiveOutcome(
            prospectiveId,
            'blocked',
            {
              reason: 'schedule_readiness_blocked',
              blockerKind: classification.kind,
              blockerCode: classification.code,
              runId: queued.id,
              cueKey: prospectiveCueKey,
              provenNoDispatch: true,
            },
            now,
          );
        } catch { /* durable run + notification remain authoritative */ }
        logger.warn(
          {
            workflow: workflowName,
            runId: queued.id,
            blockerKind: classification.kind,
            blockerCode: classification.code,
          },
          'Scheduled workflow occurrence recorded as readiness-blocked before execution',
        );
        continue;
      }
      markWorkflowOccurrenceHandled(state, dedupeKey, occurrence);
      saveScheduleState(state);
      if (queued.status === 'duplicate') {
        result.deduped.push(workflowName);
      } else if (queued.status === 'held') {
        result.held.push(workflowName);
      } else {
        result.fired.push(workflowName);
      }
      recordOperationalEvent(queued.status === 'duplicate'
        ? {
            source: 'workflow',
            type: 'workflow_trigger_deduped',
            severity: 'info',
            workflowRunId: queued.id,
            actor: 'workflow-scheduler',
            payload: {
              workflowName,
              schedule,
              source: 'schedule',
              reason: 'trigger_receipt_replayed',
              occurrenceAtMs: occurrence.atMs,
              catchupFire: isCatchupFire,
            },
          }
        : {
            source: 'workflow',
            type: 'workflow_trigger_fired',
            workflowRunId: queued.id,
            actor: 'workflow-scheduler',
            payload: {
              workflowName,
              schedule,
              missed,
              source: 'schedule',
              occurrenceAtMs: occurrence.atMs,
              queueStatus: queued.status,
              // A missed occurrence fires late, on the record: how late and
              // how many occurrences this one lineage stands for.
              ...(isCatchupFire
                ? {
                    catchupFire: true,
                    firstDueAtMs: occurrence.firstDueAtMs,
                    missedCount: occurrence.missed + 1,
                    lateMs: Math.max(0, now.getTime() - occurrence.atMs),
                  }
                : {}),
            },
          });
      try {
        recordProspectiveOutcome(
          prospectiveId,
          'rearmed',
          {
            runId: queued.id,
            cueKey: prospectiveCueKey,
            missed,
            queueAccepted: true,
            ...(isCatchupFire
              ? { catchupFire: true, lateMs: Math.max(0, now.getTime() - occurrence.atMs) }
              : {}),
          },
          now,
        );
      } catch { /* best-effort control-plane receipt */ }
      logger.info(
        {
          workflow: workflowName,
          schedule,
          minuteKey: latestKey,
          occurrenceAtMs: occurrence.atMs,
          missed,
          queueStatus: queued.status,
        },
        queued.status === 'duplicate'
          ? 'Scheduled workflow occurrence receipt replayed without creating another run'
          : isCatchupFire
          ? 'Scheduled workflow missed occurrence accepted late (it runs; catch-ups are paced one at a time)'
          : 'Scheduled workflow occurrence accepted',
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), workflow: workflowName },
        'Failed to enqueue scheduled workflow run',
      );
      // The durable pending occurrence stays intact and will be retried. The
      // notification remains useful, but it no longer truthfully says skipped.
      emitEnqueueFailureNotice(workflowName, err);
      try {
        recordProspectiveOutcome(
          prospectiveId,
          'blocked',
          {
            reason: 'schedule_enqueue_failed',
            cueKey: prospectiveCueKey,
            error: err instanceof Error ? err.message : String(err),
          },
          now,
        );
      } catch { /* best-effort control-plane receipt */ }
    }
  }
  const intervalResult = await processWorkflowIntervalSchedules(workflows, now);
  result.fired.push(...intervalResult.fired);
  result.held.push(...intervalResult.held);
  result.deferred.push(...intervalResult.deferred);
  result.deduped.push(...intervalResult.deduped);
  return result;
}

function markWorkflowOccurrenceHandled(
  state: ScheduleState,
  dedupeKey: string,
  occurrence: PendingScheduleOccurrence,
): void {
  state.lastRunByMinute[dedupeKey] = occurrence.minuteKey;
  state.lastRunAtMs[dedupeKey] = occurrence.atMs;
  if (state.pendingByWorkflow[dedupeKey]?.atMs === occurrence.atMs) {
    delete state.pendingByWorkflow[dedupeKey];
  }
}

/**
 * A user-triggered run of a scheduled workflow satisfies the next remaining
 * occurrence on the same local calendar day. Setting lastRunAtMs to now at
 * 07:27 would still leave a 09:00 slot pending; this writes the next slot's
 * epoch so today's cron does not fire again. Tomorrow is left untouched.
 */
export function satisfyNextScheduledWorkflowOccurrence(
  workflowSlug: string,
  now: Date = new Date(),
): { satisfied: boolean; atMs?: number } {
  const slug = workflowSlug.trim();
  if (!slug) return { satisfied: false };
  let entry;
  try {
    entry = listWorkflows().find((candidate) => candidate.name === slug);
  } catch {
    return { satisfied: false };
  }
  if (!entry || !entry.data.enabled) return { satisfied: false };
  const schedule = entry.data.trigger?.schedule;
  if (!schedule || typeof schedule !== 'string' || !validateCronExpression(schedule)) {
    return { satisfied: false };
  }
  const timezone = typeof entry.data.trigger?.timezone === 'string'
    ? entry.data.trigger.timezone
    : undefined;
  const state = loadScheduleState();
  const dedupeKey = `wf:${entry.name}`;
  migrateLegacyWorkflowScheduleKey(state, `wf:${entry.data.name}`, dedupeKey);

  const nowMs = minuteFloor(now.getTime());
  const today = wallClockInZone(new Date(nowMs), timezone);
  let nextAt: Date | undefined;
  for (let offset = 0; offset <= 24 * 60; offset += 1) {
    const candidate = new Date(nowMs + offset * 60_000);
    if (!cronMatches(schedule, candidate, timezone)) continue;
    const wall = wallClockInZone(candidate, timezone);
    if (wall.dayOfMonth !== today.dayOfMonth || wall.month !== today.month) continue;
    nextAt = candidate;
    break;
  }
  if (!nextAt) return { satisfied: false };

  const atMs = minuteFloor(nextAt.getTime());
  const lastFiredAtMs = state.lastRunAtMs[dedupeKey];
  if (Number.isFinite(lastFiredAtMs) && lastFiredAtMs >= atMs) {
    return { satisfied: false, atMs };
  }
  state.lastRunByMinute[dedupeKey] = currentMinuteKey(nextAt);
  state.lastRunAtMs[dedupeKey] = atMs;
  const pending = state.pendingByWorkflow[dedupeKey];
  if (pending && pending.atMs <= atMs) delete state.pendingByWorkflow[dedupeKey];
  saveScheduleState(state);
  return { satisfied: true, atMs };
}

function migrateLegacyWorkflowScheduleKey(
  state: ScheduleState,
  legacyKey: string,
  stableKey: string,
): void {
  if (legacyKey === stableKey) return;
  if (!(stableKey in state.lastRunByMinute) && legacyKey in state.lastRunByMinute) {
    state.lastRunByMinute[stableKey] = state.lastRunByMinute[legacyKey];
  }
  if (!(stableKey in state.lastRunAtMs) && legacyKey in state.lastRunAtMs) {
    state.lastRunAtMs[stableKey] = state.lastRunAtMs[legacyKey];
  }
  if (!(stableKey in state.pendingByWorkflow) && legacyKey in state.pendingByWorkflow) {
    state.pendingByWorkflow[stableKey] = state.pendingByWorkflow[legacyKey];
  }
  delete state.lastRunByMinute[legacyKey];
  delete state.lastRunAtMs[legacyKey];
  delete state.pendingByWorkflow[legacyKey];
}

/** Max queued+running/finalizing run records per workflow before the scheduler
 *  backs off. Three feels right: it absorbs short bursts of slow runs
 *  without letting a single misbehaving cron carpet the disk. */
const MAX_PENDING_PER_WORKFLOW = 3;
/** Control-plane fsync budget, not an execution budget. Held records run zero
 * steps; the runner independently serializes only the ones users Resume. */
const MAX_CATCHUP_HOLDS_PER_TICK = 20;
export const _testOnly_maxCatchupHoldsPerTick = MAX_CATCHUP_HOLDS_PER_TICK;

/** Walk WORKFLOW_RUNS_DIR once and split active work into executable records,
 * approval holds, recoverable capability pauses, and unresolved mutations.
 * Held classes are outside the execution queue but remain schedule backpressure. */
function countActiveRunsFor(workflowName: string, workflowSlug = workflowName): {
  pending: number;
  parked: number;
  capabilityBlocked: number;
  mutationBlocked: number;
} {
  if (!existsSync(WORKFLOW_RUNS_DIR)) {
    return { pending: 0, parked: 0, capabilityBlocked: 0, mutationBlocked: 0 };
  }
  let files: string[];
  try {
    files = readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return { pending: 0, parked: 0, capabilityBlocked: 0, mutationBlocked: 0 };
  }
  let pending = 0;
  let parked = 0;
  let capabilityBlocked = 0;
  let mutationBlocked = 0;
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as {
        workflow?: string;
        workflowSlug?: unknown;
        workflowDefinitionSnapshot?: { workflowSlug?: unknown };
        status?: string;
        capabilityBlock?: { state?: unknown; provenNoDispatch?: unknown };
      };
      const projectedSlug = typeof raw.workflowSlug === 'string'
        ? raw.workflowSlug.trim()
        : '';
      const snapshotSlug = typeof raw.workflowDefinitionSnapshot?.workflowSlug === 'string'
        ? raw.workflowDefinitionSnapshot.workflowSlug.trim()
        : '';
      const recordedWorkflowSlug = projectedSlug || snapshotSlug || undefined;
      if (recordedWorkflowSlug) {
        if (recordedWorkflowSlug !== workflowSlug) continue;
      } else if (raw.workflow !== workflowName && raw.workflow !== workflowSlug) continue;
      const capabilityRetryInFlight = (
        raw.status === 'running' || raw.status === 'finalizing'
      ) && raw.capabilityBlock?.provenNoDispatch === true
        && (
          raw.capabilityBlock.state === 'retrying'
          || raw.capabilityBlock.state === 'consumed'
        );
      if (raw.status === 'parked') parked += 1;
      else if (raw.status === 'blocked_capability' || capabilityRetryInFlight) capabilityBlocked += 1;
      else if (raw.status === 'blocked_mutation') mutationBlocked += 1;
      else if (
        !raw.status
        || raw.status === 'queued'
        || raw.status === 'running'
        || raw.status === 'finalizing'
      ) pending += 1;
    } catch {
      // Unreadable record — ignore. The reaper will sweep it eventually.
    }
  }
  return { pending, parked, capabilityBlocked, mutationBlocked };
}

/** Daily-bucketed system notification so the user knows their schedule
 *  is firing faster than the workflow can finish. We import lazily to
 *  avoid a runtime cycle (notifications → maintenance → scheduler). */
function scheduledReadinessBlockClassificationForRun(
  workflowName: string,
  queued: QueueWorkflowRunResult & { id: string },
): ScheduledReadinessBlockClassification | null {
  try {
    const record = JSON.parse(
      readFileSync(path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`), 'utf-8'),
    ) as Record<string, unknown>;
    const marker = record.scheduledReadinessBlock;
    const readiness = record.readiness;
    if (
      record.id !== queued.id
      || record.workflow !== workflowName
      || record.source !== 'schedule'
      || record.status !== 'blocked_readiness'
      || !marker
      || typeof marker !== 'object'
      || Array.isArray(marker)
      || (marker as Record<string, unknown>).protocol !== 'workflow_schedule_readiness_block_v1'
      || (marker as Record<string, unknown>).provenNoDispatch !== true
      || !readiness
      || typeof readiness !== 'object'
      || Array.isArray(readiness)
      || (readiness as Record<string, unknown>).ok !== false
    ) return null;
    const rawBlockers = (readiness as Record<string, unknown>).blockers;
    const blockers: ScheduledReadinessBlockerEvidence[] = Array.isArray(rawBlockers)
      ? rawBlockers.flatMap((value): ScheduledReadinessBlockerEvidence[] => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const raw = value as Record<string, unknown>;
          return [{
            ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}),
            ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
            ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
            ...(Array.isArray(raw.stepIds)
              ? { stepIds: raw.stepIds.filter((item): item is string => typeof item === 'string') }
              : {}),
          }];
        })
      : [];
    return classifyScheduledReadinessBlock({
      status: 'blocked_readiness',
      message: typeof record.readinessMessage === 'string'
        ? record.readinessMessage
        : queued.message,
      blockers,
    });
  } catch {
    return null;
  }
}

function emitScheduledReadinessBlockedNotice(
  workflowName: string,
  runId: string,
  scheduledMinuteKey: string,
  classification: ScheduledReadinessBlockClassification,
): boolean {
  const id = `system-workflow-readiness-blocked-${runId}`;
  try {
    if (getNotification(id)) return true;
    const blockerNames = Array.from(new Set(
      classification.blockers
        .map((blocker) => blocker.name?.trim())
        .filter((name): name is string => Boolean(name)),
    ));
    const target = blockerNames.length > 0 ? ` (${blockerNames.join(', ')})` : '';
    const migration = classification.kind === 'migration_required';
    addNotification({
      id,
      kind: 'workflow',
      title: migration
        ? `Workflow update required: "${workflowName}" did not start`
        : `Workflow needs attention: "${workflowName}" did not start`,
      body: migration
        ? `The scheduled occurrence was stopped before any workflow step or provider call because this workflow still uses a retired raw script runner${target}. `
          + `Open "${workflowName}" in Workflows—or ask Clem to inspect it with workflow_get—and replace external work with exact call steps plus bounded transform or a reviewed in-process host primitive using workflow_update. `
          + 'This saved occurrence is not resumable and will not retry automatically; after the migration, run the updated workflow once or let its next schedule fire.'
        : `The scheduled occurrence was stopped before any workflow step or provider call because required workflow readiness is not satisfied${target}. `
          + `Open "${workflowName}" in Workflows, fix the listed definition or capability, then run the updated workflow once or let its next schedule fire. `
          + 'This saved occurrence is not resumable and will not retry automatically.',
      createdAt: new Date().toISOString(),
      read: false,
      metadata: {
        errorCategory: migration
          ? 'workflow_schedule_migration_required'
          : 'workflow_schedule_readiness_blocked',
        workflow: workflowName,
        workflowRunId: runId,
        runId,
        status: 'blocked_readiness',
        blockerKind: classification.kind,
        blockerCode: classification.code,
        blockerNames,
        scheduledMinuteKey,
        provenNoDispatch: true,
        needsAttention: true,
        migrationRequired: migration,
      },
    });
    return getNotification(id) !== undefined;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), workflow: workflowName, runId },
      'Failed to emit scheduled readiness-block notice',
    );
    return false;
  }
}

/** Surface an occurrence whose durable retry is blocked at enqueue time
 *  (daily-bucketed per workflow). */
function emitEnqueueFailureNotice(workflowName: string, err: unknown): void {
  try {
    const dayKey = new Date().toISOString().slice(0, 10);
    const id = `system-workflow-enqueue-failed-${workflowName}-${dayKey}`;
    if (getNotification(id)) return;
    addNotification({
      id,
      kind: 'workflow',
      title: `Scheduled run of "${workflowName}" could not start`,
      body: `The schedule fired but the run failed to enqueue: ${err instanceof Error ? err.message : String(err)}. This occurrence is saved and will retry after the cause is fixed — open the workflow in Console to check it.`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { errorCategory: 'workflow_enqueue_failed', workflow: workflowName },
    });
  } catch (noticeErr) {
    logger.warn(
      { err: noticeErr instanceof Error ? noticeErr.message : String(noticeErr), workflow: workflowName },
      'Failed to emit enqueue-failure notice (best-effort, ignored)',
    );
  }
}

function emitQueueBackpressureNotice(workflowName: string, pending: number): void {
  try {
    const dayKey = new Date().toISOString().slice(0, 10);
    const id = `system-workflow-backpressure-${workflowName}-${dayKey}`;
    if (getNotification(id)) return;
    addNotification({
      id,
      kind: 'system',
      title: `Workflow "${workflowName}" can't keep up with its schedule`,
      body: `${pending} pending runs of this workflow are already queued; the schedule kept firing faster than the workflow finishes. The scheduler is now backing off — new fires will be skipped until the queue drains. Check workflow performance or lower the cron frequency.`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { errorCategory: 'workflow_backpressure', workflow: workflowName, pending },
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), workflow: workflowName },
      'Failed to emit backpressure notice (best-effort, ignored)',
    );
  }
}

/** Tell the user a stale occurrence is waiting BEFORE any workflow step runs.
 * The run-id-stable notification survives restart without nagging every boot. */
/** Queue with an occurrence-stable receipt. If the process dies after queue
 *  acceptance but before scheduler state commits, replay resolves to the same
 *  run instead of creating a second execution. */
function enqueueScheduledRun(
  workflowName: string,
  workflowSlug: string,
  occurrenceAtMs: number,
  catchupFire = false,
  catchupAdmissionAtMs = occurrenceAtMs,
  catchupMissedCount = 1,
  decidedAtMs: number = Date.now(),
): QueueWorkflowRunResult & { id: string } {
  const queued = queueWorkflowRun(workflowName, {}, {
    source: 'schedule',
    idPrefix: 'sched',
    dedupe: false,
    triggerReceiptId: `workflow-schedule:v1:${workflowSlug}:${occurrenceAtMs}`,
    // Persist the immutable catalog identity separately from the mutable
    // display name. Exact-send authority and its receipt ledger bind this slug.
    workflowSlug,
    // Only this exact schedule receipt may turn a deterministic readiness red
    // into a durable non-executable occurrence. Other callers still receive an
    // unbound blocked_readiness response and can retry after their own repair.
    persistScheduledReadinessBlock: true,
    ...(catchupFire
      ? {
          catchupFire: true,
          catchupOccurrenceAtMs: catchupAdmissionAtMs,
          catchupFirstDueAtMs: catchupAdmissionAtMs,
          catchupScheduledAtMs: occurrenceAtMs,
          catchupMissedCount,
          // A missed occurrence RUNS. The runner admits catch-up lineages one
          // at a time (the v3.0.1 anti-stampede is that pacing, not a human
          // gate) and `resumed` is the disposition it executes — decided here
          // by the scheduler instead of a Resume tap. Live 2026-09-01: the
          // 16:00 review of a laptop that slept through 16:00 sat "waiting for
          // Resume/Skip" for an hour with nothing wrong.
          catchupDisposition: 'resumed' as const,
          catchupDecidedAt: new Date(decidedAtMs).toISOString(),
        }
      : {}),
  });
  if (!queued.id) throw new Error(queued.message || `Scheduled workflow "${workflowName}" did not return a run id.`);
  if (
    queued.status !== 'queued'
    && queued.status !== 'held'
    && queued.status !== 'duplicate'
    && queued.status !== 'blocked_readiness'
  ) {
    throw new Error(queued.message || `Scheduled workflow "${workflowName}" was not accepted.`);
  }
  return { ...queued, id: queued.id };
}

/**
 * Reaper for terminal workflow run records older than RETENTION days.
 * Called by the daemon on a slow tick (every ~hour) — prevents the
 * unbounded-growth scenario the audit flagged: a star-slash-1 cron over 24h would
 * leave 1440 completed run JSON files in WORKFLOW_RUNS_DIR, and
 * processWorkflowRuns re-reads every file every tick.
 *
 * Conservative: only deletes canonical terminal records older than RETENTION
 * days after their report-back evidence is fully acknowledged. Non-terminal or
 * pending-report records are never touched.
 */
const RUN_RETENTION_DAYS = 7;
// creation_test / dry_run retain the same status from admission through finish,
// so finishedAt (checked below) is their terminal discriminator.
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'completed_with_errors',
  'error',
  'failed',
  'cancelled',
]);

interface ReapableWorkflowRunRecord extends WorkflowRunReportBackRecord {
  status?: string;
  finishedAt?: string;
  workflow?: string;
  workflowDefinitionSnapshot?: unknown;
}

let beforeRunRecordReapLockForTests: ((filePath: string) => void) | undefined;
let afterCanonicalRunUnlinkForTests: ((filePath: string) => void) | undefined;

/** Deterministic race seam: runs after directory enumeration and immediately
 * before the authoritative per-record lock/read. */
export function _setWorkflowRunReaperBeforeLockForTests(
  hook?: (filePath: string) => void,
): void {
  beforeRunRecordReapLockForTests = hook;
}

/** Deterministic crash seam after the canonical pathname removal is durable but
 * before best-effort sidecar/preparation hygiene runs. */
export function _setWorkflowRunReaperAfterCanonicalUnlinkForTests(
  hook?: (filePath: string) => void,
): void {
  afterCanonicalRunUnlinkForTests = hook;
}

function isTerminalWorkflowRunRecord(record: ReapableWorkflowRunRecord): boolean {
  if (record.status === 'dry_run' || record.status === 'creation_test') {
    return typeof record.finishedAt === 'string';
  }
  return typeof record.status === 'string' && TERMINAL_STATUSES.has(record.status);
}

function hasOutstandingWorkflowRunReportBack(record: ReapableWorkflowRunRecord): boolean {
  // A retry/quarantine marker is durable evidence that report-back did not
  // cleanly close. Preserve it even if the envelope is malformed or internally
  // inconsistent so retention never turns an evidence problem into data loss.
  if (record.reportBackRetry !== undefined) return true;
  if (record.reportBack === undefined) return false;
  try {
    return workflowRunReportBackNeedsRetry(record);
  } catch {
    return true;
  }
}

/** Resolve the storage owner before deleting any of the evidence that can tell
 * us that owner. New runs have both a graph owner and an immutable admitted
 * definition; the current workflow catalog is only a legacy fallback for
 * display-name run records. */
function canonicalWorkflowSlugForReap(
  record: ReapableWorkflowRunRecord,
  runId: string,
): string | null {
  const graphOwner = loadWorkflowGraphSnapshotByRunId(runId)?.workflowName.trim();
  if (graphOwner) return graphOwner;

  const admitted = resolveWorkflowRunDefinitionSnapshot(record.workflowDefinitionSnapshot);
  if (admitted.status === 'valid') return admitted.snapshot.workflowSlug;
  if (admitted.status === 'invalid') return null;

  const reference = record.workflow?.trim();
  if (!reference) return null;
  const current = listWorkflows().find(
    (entry) => entry.name === reference || entry.data.name === reference,
  );
  return current?.name ?? reference;
}

const WORKFLOW_RUN_ORIGINS_DIR = path.join(WORKFLOW_RUNS_DIR, '.run-origins');
const WORKFLOW_RUN_CANCELLATIONS_DIR = path.join(WORKFLOW_RUNS_DIR, '.cancellations');

function workflowRunSidecarKey(runId: string): string {
  return createHash('sha256').update(runId).digest('hex');
}

/** Remove immutable observer/cancellation evidence only after the canonical
 * terminal record has passed the acknowledged-report-back retention gate.
 * Trigger acceptance receipts live under a different, deliberately untouched
 * root (`.trigger-receipts`). */
function reapWorkflowRunSidecars(runId: string): boolean {
  const key = workflowRunSidecarKey(runId);
  try {
    rmSync(path.join(WORKFLOW_RUN_ORIGINS_DIR, key), { recursive: true, force: true });
    rmSync(path.join(WORKFLOW_RUN_CANCELLATIONS_DIR, `${key}.json`), { force: true });
    return true;
  } catch {
    return false;
  }
}

function workflowCatalogMarkerExists(workflowSlug: string): boolean {
  return existsSync(path.join(WORKFLOWS_DIR, workflowSlug, 'SKILL.md'))
    || existsSync(path.join(WORKFLOWS_DIR, `${workflowSlug}.md`))
    || existsSync(path.join(WORKFLOWS_DIR, `${workflowSlug}.md.bak`));
}

/** Remove one directory only when it is empty. A concurrent creator winning
 * the check/rmdir race is preservation, not a retention failure. */
function removeDirectoryIfEmpty(dir: string): boolean {
  try {
    if (readdirSync(dir).length > 0) return true;
    rmdirSync(dir);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTEMPTY';
  }
}

/** Catalogless compiled workflows have no SKILL.md to own their run tree.
 * Once their last retention-bound run is gone, remove only empty `runs/` and
 * owner directories. A surviving run directory means reapRunEventDir retained
 * correctness-critical call-mutation receipts, so the owner must remain. */
function pruneEmptyCataloglessCompiledOwner(
  record: ReapableWorkflowRunRecord,
  workflowSlug: string,
  runId: string,
): boolean {
  const admitted = resolveWorkflowRunDefinitionSnapshot(record.workflowDefinitionSnapshot);
  if (
    admitted.status !== 'valid'
    || !isCompiledWorkflowRunDefinitionSnapshot(admitted.snapshot)
    || admitted.snapshot.workflowSlug !== workflowSlug
  ) return true;

  if (workflowCatalogMarkerExists(workflowSlug)) return true;

  const ownerDir = path.join(WORKFLOWS_DIR, workflowSlug);
  const runsDir = path.join(ownerDir, 'runs');
  const runDir = path.join(runsDir, runId);

  // `reapRunEventDir` leaves the run directory behind only to preserve the
  // call-mutations ledger. Never collapse its parents while it remains.
  if (existsSync(path.join(runDir, 'call-mutations'))) return true;
  if (existsSync(runDir) && !removeDirectoryIfEmpty(runDir)) return false;
  if (existsSync(runDir)) return true;

  if (!removeDirectoryIfEmpty(runsDir)) return false;
  // Recheck catalog evidence at the final owner-removal boundary. A catalog
  // file created concurrently always wins over hygiene.
  if (workflowCatalogMarkerExists(workflowSlug)) return true;
  return removeDirectoryIfEmpty(ownerDir);
}

export function reapStaleWorkflowRuns(): { scanned: number; deleted: number } {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return { scanned: 0, deleted: 0 };
  let files: string[];
  try {
    files = readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return { scanned: 0, deleted: 0 };
  }
  let pendingAdmissionRunIds: ReadonlySet<string>;
  try {
    pendingAdmissionRunIds = workflowRunsWithPendingChatDispatchAdmissions();
  } catch {
    // Unknown or corrupt staging can own any terminal canonical run. Refuse
    // the entire destructive pass until that durable evidence is repaired.
    return { scanned: files.length, deleted: 0 };
  }
  const cutoffMs = Date.now() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const file of files) {
    const full = path.join(WORKFLOW_RUNS_DIR, file);
    try {
      beforeRunRecordReapLockForTests?.(full);
      const reaped = withWorkflowRunRecordLock(full, () => {
        // Every deletion decision is made from a fresh snapshot after acquiring
        // the same lock used by terminal publication, cancellation, and report
        // acknowledgement. An optimistic scan can never delete their successor.
        const raw = readWorkflowRunRecordUnlocked<ReapableWorkflowRunRecord>(full);
        if (!raw || !isTerminalWorkflowRunRecord(raw)) return false;
        const runId = file.replace(/\.json$/, '');
        // A chat turn may attach fresh exact-origin authority to an old
        // terminal duplicate. Preparation installs its retention pin while
        // this same record lock is held, so deletion must consult that pin
        // before removing any evidence needed to close the dispatch batch.
        // Corrupt pins throw and fail closed through the outer catch.
        if (
          pendingAdmissionRunIds.has(runId)
          || workflowRunHasPendingChatDispatchAdmission(runId)
          || workflowRunHasPendingInlineChatDispatchAdmission(
            runId,
            raw as unknown as Record<string, unknown>,
          )
          || workflowRunHasPendingChatDispatchPreparation(runId)
        ) return false;
        if (hasOutstandingWorkflowRunReportBack(raw)) return false;
        // A compiled root is the restart journal for a second durable ledger.
        // Never delete it until an exact marker proves ExecutionStore observed
        // the same immutable terminal digest.
        if (!compiledProjectRootHasSettlementMarker(full, raw as unknown as Record<string, unknown>)) return false;

        // Prefer finishedAt; fall back to file mtime for legacy terminal records.
        const finishedMs = raw.finishedAt ? Date.parse(raw.finishedAt) : Number.NaN;
        const ageRef = Number.isFinite(finishedMs) ? finishedMs : statSync(full).mtimeMs;
        if (ageRef >= cutoffMs) return false;

        const workflowSlug = canonicalWorkflowSlugForReap(raw, runId);
        if (!workflowSlug) return false;

        // Resolve and remove run-owned graph/event state while the canonical
        // record still owns its storage identity. Exact routing sidecars and
        // preparation pins deliberately survive this phase.
        if (!reapRunEventDir(workflowSlug, runId)) return false;
        if (!pruneEmptyCataloglessCompiledOwner(raw, workflowSlug, runId)) return false;
        deleteWorkflowGraphSnapshotByRunId(runId);

        // The canonical pathname must be durably absent before either exact
        // authority form can be removed. A crash before this fsync leaves a
        // live run with its sidecar/pin; a crash after it leaves only harmless
        // orphaned hygiene evidence, never a live run eligible for legacy
        // report-back fallback.
        unlinkSync(full);
        fsyncParentDirectory(full);
        return true;
      });
      if (!reaped) continue;

      deleted += 1;
      const runId = file.replace(/\.json$/, '');
      try {
        afterCanonicalRunUnlinkForTests?.(full);
      } catch (err) {
        // Models a process death at the durable-unlink boundary. The canonical
        // deletion already won, so retained sidecars/pins are safe orphaned
        // evidence and must not make the deletion appear to have failed.
        logger.warn(
          { runId, err: err instanceof Error ? err.message : String(err) },
          'Workflow run was reaped; deferred post-unlink authority hygiene',
        );
        continue;
      }

      if (!reapWorkflowRunSidecars(runId)) {
        logger.warn({ runId }, 'Workflow run was reaped; exact-origin sidecar hygiene will need a later sweep');
      }
      try {
        // This helper owns its run-record lock, so it intentionally runs only
        // after the canonical reaper critical section has released.
        cleanupSettledWorkflowRunChatDispatchPreparations(runId);
      } catch (err) {
        logger.warn(
          { runId, err: err instanceof Error ? err.message : String(err) },
          'Workflow run was reaped; preparation-pin hygiene will need a later sweep',
        );
      }
    } catch {
      // Unreadable / disappeared — skip.
    }
  }
  if (deleted > 0) {
    logger.info({ deleted, scanned: files.length, retentionDays: RUN_RETENTION_DAYS }, 'Reaped stale workflow run records');
  }
  return { scanned: files.length, deleted };
}

export const workflowSchedulerInternalsForTest = {
  countActiveRunsFor,
};
