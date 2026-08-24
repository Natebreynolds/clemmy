import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import type { WorkflowEntry } from '../memory/workflow-store.js';
import { workflowDefinitionHash } from './workflow-run-definition.js';
import { getActiveAutomationRecurrenceForWorkflow } from './automation-recurrence-control-plane.js';
import { resolveCurrentAutomationRecurrenceAuthoritySnapshot } from './automation-recurrence-live-authority.js';
import type { AutomationRecurrenceAuthoritySnapshotV1 } from './automation-recurrence-control-plane.js';
import {
  workflowIntervalRevisionIdentity,
  workflowIntervalRevisionIdentityFromRun,
} from './workflow-interval-run-identity.js';
import {
  decideWorkflowIntervalAdmission,
  evaluateWorkflowInterval,
  parseWorkflowInterval,
  workflowIntervalDigest,
  workflowIntervalOccurrenceAtMs,
  workflowIntervalOccurrenceId,
  type WorkflowIntervalV1,
} from '../shared/workflow-interval.js';
import {
  queueWorkflowRun,
  readWorkflowTriggerReceiptAcceptance,
} from '../tools/workflow-run-queue.js';
import { CRON_RUNS_DIR, WORKFLOW_RUNS_DIR, ensureDir } from '../tools/shared.js';

const logger = pino({ name: 'clementine-next.workflow-interval-scheduler' });

const INTERVAL_STATE_VERSION = 1 as const;
const INTERVAL_STATE_FILE = path.join(
  path.dirname(CRON_RUNS_DIR),
  'workflow-interval-state.json',
);
const MAX_INTERVAL_RECOVERY_ENQUEUES_PER_TICK = 20;

let resolveCurrentRecurrenceAuthority = resolveCurrentAutomationRecurrenceAuthoritySnapshot;

function setCurrentRecurrenceAuthorityResolverForTests(
  resolver: typeof resolveCurrentAutomationRecurrenceAuthoritySnapshot | null,
): void {
  resolveCurrentRecurrenceAuthority = resolver ?? resolveCurrentAutomationRecurrenceAuthoritySnapshot;
}

interface PendingIntervalOccurrence {
  contractDigest: string;
  occurrenceId: string;
  ordinal: number;
  occurrenceAtMs: number;
  firstDueAtMs: number;
  missedBeforeOccurrence: number;
  catchUp: boolean;
}

interface WorkflowIntervalCursor {
  contractDigest: string;
  lastHandledOrdinal: number;
  pending?: PendingIntervalOccurrence;
}

interface WorkflowIntervalScheduleStateV1 {
  version: typeof INTERVAL_STATE_VERSION;
  byWorkflow: Record<string, WorkflowIntervalCursor>;
}

export interface WorkflowIntervalScheduledFireResult {
  fired: string[];
  held: string[];
  deferred: string[];
  deduped: string[];
}

interface IntervalRunPressure {
  activeRuns: number;
  pendingRuns: number;
  uncertain: boolean;
}

const TERMINAL_INTERVAL_RUN_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'blocked',
  'error',
  'failed',
  'cancelled',
]);

interface ConfiguredWorkflowInterval {
  dedupeKey: string;
  workflowName: string;
  workflowSlug: string;
  interval: WorkflowIntervalV1;
  contractDigest: string;
  revisionIdentity: string;
  activationId: string;
  authoritySnapshot: AutomationRecurrenceAuthoritySnapshotV1;
  workflowInputs: Record<string, string>;
}

interface IntervalCandidate extends ConfiguredWorkflowInterval {
  occurrence: PendingIntervalOccurrence;
}

function emptyIntervalState(): WorkflowIntervalScheduleStateV1 {
  return { version: INTERVAL_STATE_VERSION, byWorkflow: {} };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function decodePendingIntervalOccurrence(value: unknown): PendingIntervalOccurrence {
  if (!plainRecord(value)) throw new Error('Interval pending occurrence is not an object.');
  const exactKeys = new Set([
    'contractDigest',
    'occurrenceId',
    'ordinal',
    'occurrenceAtMs',
    'firstDueAtMs',
    'missedBeforeOccurrence',
    'catchUp',
  ]);
  if (Object.keys(value).some((key) => !exactKeys.has(key))) {
    throw new Error('Interval pending occurrence has unknown fields.');
  }
  if (
    typeof value.contractDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.contractDigest)
    || typeof value.occurrenceId !== 'string'
    || !value.occurrenceId.startsWith('workflow-interval:v1:')
    || !Number.isSafeInteger(value.ordinal)
    || (value.ordinal as number) <= 0
    || !safeNonNegativeInteger(value.occurrenceAtMs)
    || !safeNonNegativeInteger(value.firstDueAtMs)
    || !safeNonNegativeInteger(value.missedBeforeOccurrence)
    || typeof value.catchUp !== 'boolean'
  ) throw new Error('Interval pending occurrence is malformed.');
  return {
    contractDigest: value.contractDigest,
    occurrenceId: value.occurrenceId,
    ordinal: value.ordinal as number,
    occurrenceAtMs: value.occurrenceAtMs,
    firstDueAtMs: value.firstDueAtMs,
    missedBeforeOccurrence: value.missedBeforeOccurrence,
    catchUp: value.catchUp,
  };
}

function decodeIntervalState(value: unknown): WorkflowIntervalScheduleStateV1 {
  if (!plainRecord(value) || value.version !== INTERVAL_STATE_VERSION || !plainRecord(value.byWorkflow)) {
    throw new Error('Workflow interval scheduler state is malformed.');
  }
  if (Object.keys(value).some((key) => key !== 'version' && key !== 'byWorkflow')) {
    throw new Error('Workflow interval scheduler state has unknown fields.');
  }
  const byWorkflow: Record<string, WorkflowIntervalCursor> = {};
  for (const [key, rawCursor] of Object.entries(value.byWorkflow)) {
    if (!key.startsWith('wf:') || !plainRecord(rawCursor)) {
      throw new Error('Workflow interval scheduler cursor is malformed.');
    }
    if (Object.keys(rawCursor).some((field) => (
      field !== 'contractDigest' && field !== 'lastHandledOrdinal' && field !== 'pending'
    ))) throw new Error('Workflow interval scheduler cursor has unknown fields.');
    if (
      typeof rawCursor.contractDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(rawCursor.contractDigest)
      || !safeNonNegativeInteger(rawCursor.lastHandledOrdinal)
    ) throw new Error('Workflow interval scheduler cursor is invalid.');
    byWorkflow[key] = {
      contractDigest: rawCursor.contractDigest,
      lastHandledOrdinal: rawCursor.lastHandledOrdinal,
      ...(rawCursor.pending !== undefined
        ? { pending: decodePendingIntervalOccurrence(rawCursor.pending) }
        : {}),
    };
  }
  return { version: INTERVAL_STATE_VERSION, byWorkflow };
}

function fsyncParentDirectory(filePath: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path.dirname(filePath), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function loadIntervalState(): WorkflowIntervalScheduleStateV1 {
  if (!existsSync(INTERVAL_STATE_FILE)) return emptyIntervalState();
  try {
    return decodeIntervalState(JSON.parse(readFileSync(INTERVAL_STATE_FILE, 'utf8')));
  } catch (error) {
    const preserved = `${INTERVAL_STATE_FILE}.corrupt-${Date.now()}`;
    try {
      renameSync(INTERVAL_STATE_FILE, preserved);
      fsyncParentDirectory(INTERVAL_STATE_FILE);
    } catch (preserveError) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          preserveError: preserveError instanceof Error ? preserveError.message : String(preserveError),
        },
        'Workflow interval state is corrupt and could not be preserved; interval scheduling is closed',
      );
      throw preserveError;
    }
    logger.error(
      { error: error instanceof Error ? error.message : String(error), preserved },
      'Workflow interval state was corrupt; preserved it before resetting bounded recovery state',
    );
    return emptyIntervalState();
  }
}

function saveIntervalState(state: WorkflowIntervalScheduleStateV1): void {
  ensureDir(path.dirname(INTERVAL_STATE_FILE));
  const tempFile = `${INTERVAL_STATE_FILE}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempFile, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(state, null, 2), 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempFile, INTERVAL_STATE_FILE);
    fsyncParentDirectory(INTERVAL_STATE_FILE);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort descriptor cleanup */ }
    }
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    } catch { /* best-effort temporary-file cleanup */ }
    throw error;
  }
}

function intervalRunPressure(revisionIdentity: string): IntervalRunPressure {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return { activeRuns: 0, pendingRuns: 0, uncertain: false };
  let files: string[];
  try {
    files = readdirSync(WORKFLOW_RUNS_DIR).filter((file) => file.endsWith('.json'));
  } catch {
    return { activeRuns: 1, pendingRuns: 1, uncertain: true };
  }
  let activeRuns = 0;
  let pendingRuns = 0;
  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf8')) as {
        triggerReceiptId?: unknown;
        workflowDefinitionSnapshot?: unknown;
        status?: unknown;
        finishedAt?: unknown;
      };
      if (workflowIntervalRevisionIdentityFromRun(record) !== revisionIdentity) continue;
      const status = typeof record.status === 'string' ? record.status : '';
      if (status === 'queued' || !status) {
        pendingRuns += 1;
      } else if (
        !TERMINAL_INTERVAL_RUN_STATUSES.has(status)
        && !(
          (status === 'dry_run' || status === 'creation_test')
          && typeof record.finishedAt === 'string'
        )
      ) {
        // Any recognized or future non-terminal state is overlap pressure.
        // This includes running/finalizing, parked/held, awaiting input or
        // approval, and every blocked-but-resumable state. An unknown state
        // cannot license a second occurrence.
        activeRuns += 1;
      }
    } catch {
      // An unreadable run might be the active occurrence for any revision. It
      // cannot license a second scheduled read, so pressure fails closed until
      // the run-record reaper repairs or preserves it.
      return { activeRuns: Math.max(activeRuns, 1), pendingRuns: Math.max(pendingRuns, 1), uncertain: true };
    }
  }
  return { activeRuns, pendingRuns, uncertain: false };
}

function pendingOccurrence(input: {
  workflowSlug: string;
  interval: WorkflowIntervalV1;
  contractDigest: string;
  ordinal: number;
  occurrenceAtMs: number;
  firstDueAtMs: number;
  missedBeforeOccurrence: number;
  catchUp: boolean;
}): PendingIntervalOccurrence {
  return {
    contractDigest: input.contractDigest,
    occurrenceId: workflowIntervalOccurrenceId({
      workflowKey: input.workflowSlug,
      interval: input.interval,
      ordinal: input.ordinal,
    }),
    ordinal: input.ordinal,
    occurrenceAtMs: input.occurrenceAtMs,
    firstDueAtMs: input.firstDueAtMs,
    missedBeforeOccurrence: input.missedBeforeOccurrence,
    catchUp: input.catchUp,
  };
}

function pendingMatchesContract(
  pending: PendingIntervalOccurrence,
  config: ConfiguredWorkflowInterval,
): boolean {
  if (pending.contractDigest !== config.contractDigest) return false;
  try {
    return (
      workflowIntervalOccurrenceAtMs(config.interval, pending.ordinal) === pending.occurrenceAtMs
      && workflowIntervalOccurrenceId({
        workflowKey: config.workflowSlug,
        interval: config.interval,
        ordinal: pending.ordinal,
      }) === pending.occurrenceId
    );
  } catch {
    return false;
  }
}

function markIntervalOccurrenceHandled(
  state: WorkflowIntervalScheduleStateV1,
  candidate: IntervalCandidate,
): void {
  const cursor = state.byWorkflow[candidate.dedupeKey];
  if (!cursor || cursor.contractDigest !== candidate.contractDigest) return;
  cursor.lastHandledOrdinal = Math.max(cursor.lastHandledOrdinal, candidate.occurrence.ordinal);
  if (cursor.pending?.occurrenceId === candidate.occurrence.occurrenceId) delete cursor.pending;
}

function enqueueIntervalOccurrence(candidate: IntervalCandidate): {
  id: string;
  status: 'queued' | 'duplicate';
} {
  const queued = queueWorkflowRun(candidate.workflowName, candidate.workflowInputs, {
    source: 'schedule',
    idPrefix: 'interval',
    dedupe: false,
    triggerReceiptId: candidate.occurrence.occurrenceId,
    workflowSlug: candidate.workflowSlug,
    workflowRecurringReadAdmission: {
      activationId: candidate.activationId,
      occurrenceOrdinal: candidate.occurrence.ordinal,
      nodeAttempt: 1,
      currentAuthoritySnapshot: candidate.authoritySnapshot,
    },
  });
  if (!queued.id || (queued.status !== 'queued' && queued.status !== 'duplicate')) {
    throw new Error(
      queued.message || `Interval occurrence for workflow "${candidate.workflowName}" was not accepted.`,
    );
  }
  return { id: queued.id, status: queued.status };
}

/**
 * Provider-neutral fixed-duration recurrence lane. The cron scheduler calls it
 * only after its existing discovery/admission pass is complete. Interval state
 * is separate so enabling this lane cannot reinterpret cron watermarks.
 */
export async function processWorkflowIntervalSchedules(
  workflows: readonly WorkflowEntry[],
  now: Date = new Date(),
): Promise<WorkflowIntervalScheduledFireResult> {
  const result: WorkflowIntervalScheduledFireResult = {
    fired: [],
    held: [],
    deferred: [],
    deduped: [],
  };
  const nowMs = now.getTime();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return result;
  const nowMinuteMs = Math.floor(nowMs / 60_000) * 60_000;

  const configured = new Map<string, ConfiguredWorkflowInterval>();
  const authorityHeldKeys = new Set<string>();
  for (const entry of workflows) {
    const workflow = entry.data;
    if (!workflow.enabled || workflow.trigger?.interval === undefined) continue;
    // A workflow with two time authorities is invalid. The validator reports
    // the authoring error; runtime keeps cron as the legacy owner and refuses
    // to silently add a second firing lane.
    if (workflow.trigger.schedule !== undefined) continue;
    const parsed = parseWorkflowInterval(workflow.trigger.interval);
    if (!parsed.ok) {
      logger.warn(
        { workflow: workflow.name, errors: parsed.errors },
        'Invalid workflow interval stayed inert',
      );
      continue;
    }
    const dedupeKey = `wf:${entry.name}`;
    let active;
    try {
      active = getActiveAutomationRecurrenceForWorkflow(entry.name);
    } catch (error) {
      logger.warn(
        { workflow: entry.name, error: error instanceof Error ? error.message : String(error) },
        'Corrupt or ambiguous standing recurrence authority stayed inert',
      );
      authorityHeldKeys.add(dedupeKey);
      result.held.push(workflow.name);
      continue;
    }
    const currentDefinitionHash = workflowDefinitionHash(workflow);
    if (
      !active
      || active.receipt.workflowId !== entry.name
      || active.receipt.authorizedEnabledDefinitionHash !== currentDefinitionHash
      || active.receipt.intervalDigest !== workflowIntervalDigest(parsed.value)
    ) {
      authorityHeldKeys.add(dedupeKey);
      result.held.push(workflow.name);
      continue;
    }
    const liveAuthority = resolveCurrentRecurrenceAuthority(
      active.activation.activationId,
    );
    if (!liveAuthority.ok) {
      authorityHeldKeys.add(dedupeKey);
      result.held.push(workflow.name);
      logger.warn(
        { workflow: entry.name, reason: liveAuthority.reason },
        'Recurring workflow current authority drifted and stayed inert',
      );
      continue;
    }
    configured.set(dedupeKey, {
      dedupeKey,
      workflowName: workflow.name,
      workflowSlug: entry.name,
      interval: parsed.value,
      contractDigest: workflowIntervalDigest(parsed.value),
      revisionIdentity: workflowIntervalRevisionIdentity({
        workflowSlug: entry.name,
        definitionHash: workflowDefinitionHash(workflow),
        interval: parsed.value,
      }),
      activationId: active.activation.activationId,
      authoritySnapshot: liveAuthority.snapshot,
      workflowInputs: structuredClone(active.receipt.workflowInputs),
    });
  }

  if (configured.size === 0 && !existsSync(INTERVAL_STATE_FILE)) return result;
  const state = loadIntervalState();

  for (const [dedupeKey, config] of configured) {
    let cursor = state.byWorkflow[dedupeKey];
    if (!cursor || cursor.contractDigest !== config.contractDigest) {
      // Every contract field, including activation anchor and both policies, is
      // identity. A change begins a fresh cursor and cannot inherit authority
      // or a pending occurrence from the old bytes.
      cursor = { contractDigest: config.contractDigest, lastHandledOrdinal: 0 };
      state.byWorkflow[dedupeKey] = cursor;
    }
    if (cursor.pending && !pendingMatchesContract(cursor.pending, config)) {
      delete cursor.pending;
    }
    if (cursor.pending) continue;

    const evaluation = evaluateWorkflowInterval({
      interval: config.interval,
      nowMs,
      lastHandledOrdinal: cursor.lastHandledOrdinal,
    });
    if (evaluation.status === 'not_due') continue;
    if (evaluation.status === 'skipped') {
      cursor.lastHandledOrdinal = evaluation.handledThroughOrdinal;
      result.deduped.push(config.workflowName);
      continue;
    }
    cursor.pending = pendingOccurrence({
      workflowSlug: config.workflowSlug,
      interval: config.interval,
      contractDigest: config.contractDigest,
      ordinal: evaluation.occurrenceOrdinal,
      occurrenceAtMs: evaluation.occurrenceAtMs,
      firstDueAtMs: workflowIntervalOccurrenceAtMs(
        config.interval,
        cursor.lastHandledOrdinal + 1,
      ),
      missedBeforeOccurrence: evaluation.missedBeforeOccurrence,
      catchUp: evaluation.catchUp,
    });
  }

  for (const key of Object.keys(state.byWorkflow)) {
    if (!configured.has(key) && !authorityHeldKeys.has(key)) delete state.byWorkflow[key];
  }
  // Discovery is checkpointed before queue admission. If the process dies
  // after the queue write, the occurrence receipt converges the replay onto the
  // already accepted run; if it dies before, this exact pending unit retries.
  saveIntervalState(state);

  const candidates: IntervalCandidate[] = [];
  for (const config of configured.values()) {
    const occurrence = state.byWorkflow[config.dedupeKey]?.pending;
    if (occurrence) candidates.push({ ...config, occurrence });
  }
  candidates.sort((left, right) => {
    const leftLive = left.occurrence.occurrenceAtMs === nowMinuteMs ? 0 : 1;
    const rightLive = right.occurrence.occurrenceAtMs === nowMinuteMs ? 0 : 1;
    return leftLive - rightLive
      || left.occurrence.firstDueAtMs - right.occurrence.firstDueAtMs
      || left.occurrence.occurrenceAtMs - right.occurrence.occurrenceAtMs
      || left.dedupeKey.localeCompare(right.dedupeKey);
  });

  let recoveryEnqueues = 0;
  for (const candidate of candidates) {
    const { occurrence } = candidate;
    if (readWorkflowTriggerReceiptAcceptance(occurrence.occurrenceId)) {
      markIntervalOccurrenceHandled(state, candidate);
      saveIntervalState(state);
      result.deduped.push(candidate.workflowName);
      continue;
    }

    const pressure = intervalRunPressure(candidate.revisionIdentity);
    if (pressure.uncertain) {
      result.deferred.push(candidate.workflowName);
      continue;
    }
    const decision = decideWorkflowIntervalAdmission({
      interval: candidate.interval,
      activeRuns: pressure.activeRuns,
      pendingRuns: pressure.pendingRuns,
    });
    if (decision.action === 'dedupe' || decision.action === 'skip') {
      // A queued occurrence already occupies queue_one's sole waiting slot; a
      // later occurrence is coalesced. `skip` deliberately drops overlap.
      markIntervalOccurrenceHandled(state, candidate);
      saveIntervalState(state);
      result.deduped.push(candidate.workflowName);
      continue;
    }
    if (decision.reason === 'queue_one') {
      // The scheduler's fsynced pending occurrence *is* the one queued slot.
      // Do not materialize an executable run until the active run settles: the
      // global drain can be configured above one and must never start the two
      // occurrences concurrently.
      result.deferred.push(candidate.workflowName);
      continue;
    }

    const isRecovery = occurrence.catchUp || occurrence.occurrenceAtMs < nowMinuteMs;
    if (isRecovery && recoveryEnqueues >= MAX_INTERVAL_RECOVERY_ENQUEUES_PER_TICK) {
      result.deferred.push(candidate.workflowName);
      continue;
    }
    if (isRecovery) recoveryEnqueues += 1;

    try {
      const queued = enqueueIntervalOccurrence(candidate);
      markIntervalOccurrenceHandled(state, candidate);
      saveIntervalState(state);
      if (queued.status === 'duplicate') result.deduped.push(candidate.workflowName);
      else result.fired.push(candidate.workflowName);
    } catch (error) {
      result.deferred.push(candidate.workflowName);
      logger.warn(
        {
          workflow: candidate.workflowName,
          workflowSlug: candidate.workflowSlug,
          occurrenceId: occurrence.occurrenceId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to enqueue durable workflow interval occurrence; exact pending unit will retry',
      );
    }
  }
  return result;
}

export const workflowIntervalSchedulerInternalsForTest = {
  intervalStateFile: INTERVAL_STATE_FILE,
  loadIntervalState,
  intervalRunPressure,
  setCurrentRecurrenceAuthorityResolverForTests,
  maxRecoveryEnqueuesPerTick: MAX_INTERVAL_RECOVERY_ENQUEUES_PER_TICK,
};
