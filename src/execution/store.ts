import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type {
  ExecutionRecord,
  PlanRecord,
  ProjectGraphCompiledPlanSnapshot,
} from '../types.js';
import { isUserFacingExecution } from './scope.js';
import { actionBus } from '../runtime/action-bus.js';
import { addNotification } from '../runtime/notifications.js';
import { TASKS_FILE, ensureTasksFile } from '../tools/shared.js';
import {
  closeAndCompactTaskLedgerBody,
  reopenTaskLedgerBody,
} from '../tasks/task-ledger-hygiene.js';
// v0.5.19 Bug F — pause-aware sweep needs these. Static ESM imports
// (no circular dep: neither module imports from execution/store).
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import {
  listEvents as listHarnessEvents,
  type EventRow,
} from '../runtime/harness/eventlog.js';
import {
  freshExternalWriteEvidenceStatus,
  type FreshExternalWriteEvidenceStatus,
} from '../runtime/harness/tool-evidence.js';
import {
  canonicalExternalWriteActionKey,
  uncompensatedExternalWriteEvents,
} from '../runtime/harness/external-write-admission.js';
import { withFileLockSyncStrict } from '../runtime/atomic-json.js';
import { BoundaryError } from '../runtime/boundary-error.js';
import { workflowDefinitionHash } from './workflow-run-definition.js';

const STATE_DIR = path.join(BASE_DIR, 'state');
const EXECUTIONS_FILE = path.join(STATE_DIR, 'executions.json');
const EXTERNAL_WRITE_EVENT_TYPES = [
  'external_write',
  'external_write_succeeded',
  'external_write_failed',
  'external_write_orphaned',
] as const;
const EXTERNAL_WRITE_OWNERSHIP_EVENT_TYPES = [
  ...EXTERNAL_WRITE_EVENT_TYPES,
  'user_input_received',
] as const;

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function loadExecutionsUnlocked(): ExecutionRecord[] {
  ensureStateDir();
  if (!existsSync(EXECUTIONS_FILE)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(EXECUTIONS_FILE, 'utf-8'));
  } catch (cause) {
    throw new BoundaryError({
      kind: 'state.read_corrupted',
      retryable: false,
      userMessage: 'The execution ledger is unreadable. Restore or repair it before starting more work.',
      operatorMessage: `Execution state is corrupt at ${EXECUTIONS_FILE}; refusing to replace it or admit new project authority.`,
      context: { filePath: EXECUTIONS_FILE },
      cause,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new BoundaryError({
      kind: 'state.read_corrupted',
      retryable: false,
      userMessage: 'The execution ledger has an invalid shape. Restore or repair it before starting more work.',
      operatorMessage: `Execution state at ${EXECUTIONS_FILE} is corrupt; expected an array.`,
      context: { filePath: EXECUTIONS_FILE },
    });
  }
  return parsed as ExecutionRecord[];
}

/** Crash-safe replacement. Call only while holding executionsFileLock(). */
function saveExecutionsUnlocked(executions: ExecutionRecord[]): void {
  ensureStateDir();
  const temp = `${EXECUTIONS_FILE}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(executions, null, 2), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, EXECUTIONS_FILE);
    if (process.platform !== 'win32') {
      const dirFd = openSync(STATE_DIR, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort cleanup */ }
    }
    try { unlinkSync(temp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

function executionsFileLock<T>(work: () => T): T {
  // The lock file is a sibling of executions.json, so a truly fresh home must
  // create the state directory before attempting the atomic `wx` lock.
  ensureStateDir();
  return withFileLockSyncStrict(EXECUTIONS_FILE, work);
}

function sourceTurnKeyHash(sessionId: string, sourceUserSeq: number): string {
  return createHash('sha256')
    .update('clementine-project-source:v1', 'utf8')
    .update('\0')
    .update(sessionId, 'utf8')
    .update('\0')
    .update(String(sourceUserSeq), 'utf8')
    .digest('hex');
}

function deterministicSourceExecutionId(sessionId: string, sourceUserSeq: number): string {
  return `exec-project-${sourceTurnKeyHash(sessionId, sourceUserSeq).slice(0, 32)}`;
}

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Normalize untrusted compiler output to the exact JSON bytes that can be
 * persisted. Object keys are sorted, undefined object fields are omitted, and
 * non-JSON/cyclic values fail closed instead of changing underneath a hash. */
function canonicalJsonValue(
  value: unknown,
  seen = new Set<object>(),
  location = '$',
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Compiled project data at ${location} is not finite JSON.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`Compiled project data at ${location} is cyclic.`);
    seen.add(value);
    try {
      return value.map((entry, index) => {
        if (entry === undefined) {
          throw new Error(`Compiled project data at ${location}[${index}] contains undefined.`);
        }
        return canonicalJsonValue(entry, seen, `${location}[${index}]`);
      });
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error(`Compiled project data at ${location} is cyclic.`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Compiled project data at ${location} is not a plain JSON object.`);
    }
    seen.add(value);
    try {
      const record = value as Record<string, unknown>;
      const out: Record<string, JsonValue> = {};
      for (const key of Object.keys(record).sort()) {
        if (record[key] === undefined) continue;
        out[key] = canonicalJsonValue(record[key], seen, `${location}.${key}`);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  throw new Error(`Compiled project data at ${location} is not JSON-serializable.`);
}

function canonicalJsonHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(value)), 'utf8')
    .digest('hex');
}

export type ProjectGraphCompiledPlanInput = Omit<
  ProjectGraphCompiledPlanSnapshot,
  'snapshotHash'
>;

function prepareCompiledPlanSnapshot(
  input: ProjectGraphCompiledPlanInput,
): ProjectGraphCompiledPlanSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Execution admission requires a complete project compiler snapshot.');
  }
  if (input.version !== 1 || input.compilerId !== 'project_graph_v1') {
    throw new Error('Execution admission requires a supported project compiler snapshot.');
  }
  if (!/^[a-f0-9]{64}$/.test(input.planHash)) {
    throw new Error('Execution admission plan hash is invalid.');
  }
  if (!/^[a-f0-9]{64}$/.test(input.definitionHash)) {
    throw new Error('Execution admission workflow definition hash is invalid.');
  }

  const plan = canonicalJsonValue(input.plan);
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('Execution admission requires a normalized project-plan object.');
  }
  if (canonicalJsonHash(plan) !== input.planHash) {
    throw new Error('Execution admission project-plan bytes do not match their hash.');
  }

  const definition = canonicalJsonValue(input.definition);
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('Execution admission requires a compiled workflow definition object.');
  }
  if (workflowDefinitionHash(definition as unknown as typeof input.definition) !== input.definitionHash) {
    throw new Error('Execution admission workflow definition bytes do not match their hash.');
  }

  const inputs = canonicalJsonValue(input.inputs);
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new Error('Execution admission workflow inputs must be a string map.');
  }
  if (Object.values(inputs).some((value) => typeof value !== 'string')) {
    throw new Error('Execution admission workflow inputs must contain only strings.');
  }

  const payload: ProjectGraphCompiledPlanInput = {
    version: 1,
    compilerId: 'project_graph_v1',
    planHash: input.planHash,
    definitionHash: input.definitionHash,
    plan,
    definition: definition as unknown as typeof input.definition,
    inputs: inputs as Record<string, string>,
  };
  return {
    ...payload,
    snapshotHash: canonicalJsonHash(payload),
  };
}

function assertPersistedCompiledPlanSnapshot(
  value: ProjectGraphCompiledPlanSnapshot | undefined,
): ProjectGraphCompiledPlanSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Persisted project admission is missing its compiler snapshot.');
  }
  const prepared = prepareCompiledPlanSnapshot(value);
  if (value.snapshotHash !== prepared.snapshotHash) {
    throw new Error('Persisted project compiler snapshot failed its integrity check.');
  }
  return prepared;
}

function clean(value: string, maxChars = 220): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

export interface ExecutionExternalWriteTruth {
  status: FreshExternalWriteEvidenceStatus;
  /** Provider-neutral action families for confirmed, request-owned writes.
   * Completion callers use these to prevent an unrelated write from proving a
   * different delegated world effect. */
  confirmedActionKeys: string[];
  execution: ExecutionRecord;
}

function externalWriteActionKey(event: EventRow): string {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};
  const explicit = typeof data.actionKey === 'string' ? data.actionKey.trim().toLowerCase() : '';
  if (explicit.includes(':')) return explicit;
  const toolName = typeof data.toolName === 'string'
    ? data.toolName
    : typeof data.tool === 'string' ? data.tool : undefined;
  const shapeKey = typeof data.shapeKey === 'string'
    ? data.shapeKey
    : typeof data.slug === 'string'
      ? data.slug
      : explicit || undefined;
  return canonicalExternalWriteActionKey(toolName, shapeKey);
}

function executionSourceUserSeqs(execution: ExecutionRecord): number[] {
  return [...new Set([
    execution.sourceUserSeq,
    ...(execution.sourceUserSeqs ?? []),
  ].filter((seq): seq is number => Number.isSafeInteger(seq) && (seq ?? 0) > 0))]
    .sort((left, right) => left - right);
}

function executionExternalWriteStatus(
  execution: ExecutionRecord,
  prefetchedOwnershipEvents?: readonly EventRow[],
): {
  status: FreshExternalWriteEvidenceStatus;
  latestNegativeSeq?: number;
  confirmedActionKeys: string[];
} {
  const sourceUserSeqs = executionSourceUserSeqs(execution);
  if (sourceUserSeqs.length === 0) {
    return { status: 'missing', confirmedActionKeys: [] };
  }
  const firstSourceUserSeq = sourceUserSeqs[0] as number;
  const acceptedSources = new Set(sourceUserSeqs);
  try {
    const ownershipEvents = (
      prefetchedOwnershipEvents
        ?? listHarnessEvents(execution.sessionId, {
          sinceSeq: firstSourceUserSeq,
          types: [...EXTERNAL_WRITE_OWNERSHIP_EVENT_TYPES],
        })
    ).filter((event) => event.seq > firstSourceUserSeq);
    // `listEvents(..., { sinceSeq })` is exclusive, so the origin row itself is
    // not present in ownershipEvents. Seed every explicitly accepted source
    // boundary here; otherwise legacy untagged writes immediately after the
    // origin have no preceding owner and disappear from completion truth.
    const userBoundaries = [...new Set([
      ...sourceUserSeqs,
      ...ownershipEvents
        .filter((event) => event.type === 'user_input_received')
        .map((event) => event.seq),
    ])].sort((left, right) => left - right);
    const events = ownershipEvents.filter((event) => {
      if (event.type === 'user_input_received') return false;
      const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
        ? event.data as { sourceUserSeq?: unknown }
        : {};
      if (Number.isSafeInteger(data.sourceUserSeq)) {
        return acceptedSources.has(data.sourceUserSeq as number);
      }
      // Historical rows had no exact owner. Attribute them only to their
      // nearest preceding accepted user boundary; never let an unrelated
      // follow-up contaminate a long-lived execution.
      const precedingUserSeq = [...userBoundaries]
        .reverse()
        .find((seq) => seq < event.seq);
      return precedingUserSeq !== undefined && acceptedSources.has(precedingUserSeq);
    });
    const status = freshExternalWriteEvidenceStatus(events, sourceUserSeqs);
    const confirmedActionKeys = status === 'confirmed'
      ? [...new Set(
          uncompensatedExternalWriteEvents(events)
            .filter((event) => event.type === 'external_write')
            .map(externalWriteActionKey),
        )]
      : [];
    const latestNegativeSeq = events
      .filter((event) =>
        event.type === 'external_write_failed'
        || event.type === 'external_write_orphaned'
      )
      .reduce<number | undefined>(
        (latest, event) => latest === undefined || event.seq > latest ? event.seq : latest,
        undefined,
      );
    return { status, latestNegativeSeq, confirmedActionKeys };
  } catch {
    // Event storage is best-effort for legacy/non-harness executions. Missing
    // evidence must not invent a blocker for work that never performed a write.
    return { status: 'missing', confirmedActionKeys: [] };
  }
}

function externalWriteTruthCopy(
  status: Extract<FreshExternalWriteEvidenceStatus, 'failed' | 'ambiguous'>,
): { blocker: string; nextStep: string } {
  return status === 'ambiguous'
    ? {
        blocker: 'An external-write outcome remains ambiguous. The exact target requires read-only reconciliation before this execution can be called complete.',
        nextStep: 'Reconcile the ambiguous external write read-only; do not repeat it.',
      }
    : {
        blocker: 'At least one required external write failed. Repair that exact action before claiming this execution complete.',
        nextStep: 'Repair or safely retry the failed external write, then verify it.',
      };
}

function applyExternalWriteTruthBlock(
  execution: ExecutionRecord,
  status: Extract<FreshExternalWriteEvidenceStatus, 'failed' | 'ambiguous'>,
  latestNegativeSeq?: number,
): boolean {
  const copy = externalWriteTruthCopy(status);
  const activityKey = [
    'external-write-truth',
    executionSourceUserSeqs(execution).join(',') || 'unknown',
    status,
    latestNegativeSeq ?? 'unknown',
  ].join(':');
  const alreadyRecorded = (execution.activity ?? []).some((item) => item.key === activityKey);
  const alreadyBlocked = execution.status === 'blocked'
    && execution.blocker === copy.blocker
    && execution.nextStep === copy.nextStep;
  if (alreadyBlocked && alreadyRecorded) return false;

  const now = new Date().toISOString();
  reopenCompletionClosedTasks(execution, now);
  execution.status = 'blocked';
  execution.blocker = copy.blocker;
  execution.nextStep = copy.nextStep;
  execution.nextReviewAt = undefined;
  execution.updatedAt = now;
  execution.lastActivityAt = now;
  execution.lastAssistantSummary = execution.lastAssistantSummary
    ? clean(`${execution.lastAssistantSummary} | ${copy.blocker}`, 400)
    : copy.blocker;
  execution.activity = Array.isArray(execution.activity) ? execution.activity : [];
  if (!alreadyRecorded) {
    execution.activity.push({
      id: randomUUID(),
      key: activityKey,
      type: 'blocked',
      message: copy.blocker,
      createdAt: now,
      metadata: {
        source: 'deterministic_external_write_truth',
        status,
        sourceUserSeq: execution.sourceUserSeq,
        sourceUserSeqs: executionSourceUserSeqs(execution),
        latestNegativeSeq,
      },
    });
    execution.activity = execution.activity.slice(-60);
  }
  return true;
}

function reopenCompletionClosedTasks(execution: ExecutionRecord, now: string): number {
  const taskIds = new Set<string>();
  for (const item of execution.activity ?? []) {
    if (!item.key.startsWith('task-bindings:closed:')) continue;
    const ids = item.metadata?.taskIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === 'string' && id.trim()) taskIds.add(id);
    }
  }
  if (taskIds.size === 0) return 0;

  const completedBindings = (execution.taskBindings ?? [])
    .filter((binding) => taskIds.has(binding.taskId) && binding.status === 'completed');
  if (completedBindings.length === 0) return 0;
  let reopenedVaultRows = 0;
  try {
    ensureTasksFile();
    const reopened = reopenTaskLedgerBody(readFileSync(TASKS_FILE, 'utf-8'), taskIds);
    reopenedVaultRows = reopened.reopenedTaskRows;
    if (reopenedVaultRows > 0) writeFileSync(TASKS_FILE, reopened.body, 'utf-8');
  } catch {
    // The execution record remains the dashboard source of truth even if the
    // optional Markdown task mirror cannot be repaired.
  }

  execution.taskBindings = (execution.taskBindings ?? []).map((binding) =>
    taskIds.has(binding.taskId) && binding.status === 'completed'
      ? { ...binding, status: 'pending', completedAt: undefined }
      : binding,
  );
  execution.activity = Array.isArray(execution.activity) ? execution.activity : [];
  const key = `task-bindings:reopened:${now}`;
  execution.activity.push({
    id: randomUUID(),
    key,
    type: 'status',
    message: clean(
      `Reopened ${completedBindings.length} linked task row${completedBindings.length === 1 ? '' : 's'} because late external-write evidence invalidated clean completion.`,
      500,
    ),
    createdAt: now,
    metadata: {
      taskIds: [...taskIds],
      reopenedVaultRows,
      source: 'deterministic_external_write_truth',
    },
  });
  execution.activity = execution.activity.slice(-60);
  return completedBindings.length;
}

function reconcileCompletedExternalWriteTruth(executions: ExecutionRecord[]): boolean {
  const candidates = executions.filter((execution) =>
    execution.status === 'completed' && !execution.blocker
  );
  const eventsBySession = new Map<string, EventRow[]>();
  for (const execution of candidates) {
    if (eventsBySession.has(execution.sessionId)) continue;
    const sessionCandidates = candidates.filter((candidate) => candidate.sessionId === execution.sessionId);
    const firstSource = sessionCandidates.reduce(
      (lowest, candidate) => {
        const candidateFirst = executionSourceUserSeqs(candidate)[0];
        return candidateFirst !== undefined
          && (lowest === undefined || candidateFirst < lowest)
          ? candidateFirst
          : lowest;
      },
      undefined as number | undefined,
    );
    if (firstSource === undefined) {
      eventsBySession.set(execution.sessionId, []);
      continue;
    }
    try {
      eventsBySession.set(
        execution.sessionId,
        listHarnessEvents(execution.sessionId, {
          sinceSeq: firstSource,
          types: [...EXTERNAL_WRITE_OWNERSHIP_EVENT_TYPES],
        }),
      );
    } catch {
      eventsBySession.set(execution.sessionId, []);
    }
  }

  let changed = false;
  for (const execution of candidates) {
    const evidence = executionExternalWriteStatus(
      execution,
      eventsBySession.get(execution.sessionId),
    );
    if (evidence.status !== 'failed' && evidence.status !== 'ambiguous') continue;
    changed = applyExternalWriteTruthBlock(
      execution,
      evidence.status,
      evidence.latestNegativeSeq,
    ) || changed;
  }
  return changed;
}

function persistReconciledExecutions(
  allExecutions: ExecutionRecord[],
  candidates: ExecutionRecord[],
): boolean {
  const changed = reconcileCompletedExternalWriteTruth(candidates);
  if (!changed) return false;
  try {
    saveExecutionsUnlocked(allExecutions);
  } catch {
    // Preserve the parsed truth-reconciled view for this read. A transient
    // persistence failure must not turn explicit negative evidence green.
  }
  return true;
}

function closeLinkedVaultTasks(execution: ExecutionRecord, now: string): number {
  const pendingBindings = (execution.taskBindings ?? []).filter((binding) => binding.status === 'pending');
  if (pendingBindings.length === 0) return 0;

  const taskIds = new Set(pendingBindings.map((binding) => binding.taskId));
  let closedRows = 0;
  try {
    ensureTasksFile();
    const compacted = closeAndCompactTaskLedgerBody(readFileSync(TASKS_FILE, 'utf-8'), taskIds);
    closedRows = compacted.checkedTaskRows;
    if (closedRows > 0 || compacted.compactedTaskRows > 0) {
      writeFileSync(TASKS_FILE, compacted.body, 'utf-8');
    }
  } catch {
    // Execution persistence is the source of truth. If the vault ledger is
    // unavailable, still close the bindings so summaries stop treating the
    // terminal execution as live work.
  }

  execution.taskBindings = (execution.taskBindings ?? []).map((binding) =>
    taskIds.has(binding.taskId)
      ? { ...binding, status: 'completed', completedAt: binding.completedAt ?? now }
      : binding,
  );
  execution.activity = Array.isArray(execution.activity) ? execution.activity : [];
  execution.activity.push({
    id: randomUUID(),
    key: `task-bindings:closed:${now}`,
    type: 'status',
    message: clean(`Closed ${pendingBindings.length} linked task row${pendingBindings.length === 1 ? '' : 's'} because the execution completed.`, 500),
    createdAt: now,
    metadata: {
      taskIds: pendingBindings.map((binding) => binding.taskId),
      closedVaultRows: closedRows,
    },
  });
  execution.activity = execution.activity.slice(-60);
  return pendingBindings.length;
}

export interface CreateExecutionInput {
  sessionId: string;
  sourceUserSeq?: number;
  userId?: string;
  channel?: string;
  title: string;
  objective: string;
  reason: string;
  startedFromMessage: string;
  confidence: number;
  reasons: string[];
  planId?: string;
  nextStep?: string;
  successCriteria?: string;
  lastAssistantSummary?: string;
  nextReviewAt?: string;
  blocker?: string;
  autoAdvance?: boolean;
}

export interface GraphExecutionAdmissionInput {
  turnGraphId: string;
  turnGraphHash: string;
  compiledPlan: ProjectGraphCompiledPlanInput;
}

export interface CreateOrGetExecutionForSourceInput extends Omit<CreateExecutionInput, 'sourceUserSeq'> {
  sourceUserSeq: number;
  admission: GraphExecutionAdmissionInput;
}

export interface CreateOrGetExecutionForSourceResult {
  execution: ExecutionRecord;
  created: boolean;
  /** A competing planner proposed different bytes after another process had
   * already admitted the immutable winner. Callers must dispatch `execution`'s
   * persisted compiledPlan, never their losing input. */
  plannerConflict: boolean;
  /** Stable queue receipt for the one root workflow occurrence. */
  rootWorkflowReceiptId: string;
}

export interface UnboundProjectGraphSource {
  executionId: string;
  sessionId: string;
  sourceUserSeq: number;
}

export interface UnboundProjectGraphSourceScan {
  sources: UnboundProjectGraphSource[];
  /** Active graph records whose persisted provenance failed validation. They
   * are never returned as candidates and therefore remain non-executable. */
  rejected: number;
}

function exactAcceptedHumanSource(sessionId: string, sourceUserSeq: number): EventRow | null {
  if (!sessionId || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) return null;
  try {
    return listHarnessEvents(sessionId, {
      sinceSeq: sourceUserSeq - 1,
      types: ['user_input_received'],
      limit: 1,
    }).find((event) =>
      event.seq === sourceUserSeq
      && event.sessionId === sessionId
      && event.role === 'user'
      && event.data.synthetic !== true
    ) ?? null;
  } catch {
    return null;
  }
}

function assertGraphAdmissionInput(
  sessionId: string,
  sourceUserSeq: number,
  admission: GraphExecutionAdmissionInput,
): ProjectGraphCompiledPlanSnapshot {
  if (!exactAcceptedHumanSource(sessionId, sourceUserSeq)) {
    throw new Error('A durable execution must be bound to the exact accepted human user turn.');
  }
  if (admission.turnGraphId !== `turn-graph:v1:${sourceUserSeq}`) {
    throw new Error('Execution admission graph id does not match its accepted source.');
  }
  if (!/^[a-f0-9]{64}$/.test(admission.turnGraphHash)) {
    throw new Error('Execution admission requires a valid turn graph hash.');
  }
  return prepareCompiledPlanSnapshot(admission.compiledPlan);
}

function buildExecutionRecord(
  input: CreateExecutionInput,
  id: string = randomUUID(),
  graphAdmission?: ExecutionRecord['graphAdmission'],
): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id,
    sessionId: input.sessionId,
    ...(Number.isSafeInteger(input.sourceUserSeq) && (input.sourceUserSeq ?? 0) > 0
      ? { sourceUserSeq: input.sourceUserSeq }
      : {}),
    ...(graphAdmission ? { graphAdmission } : {}),
    userId: input.userId,
    channel: input.channel,
    title: clean(input.title, 120),
    objective: clean(input.objective, 600),
    reason: clean(input.reason, 400),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    startedFromMessage: clean(input.startedFromMessage, 500),
    planId: input.planId,
    nextStep: input.nextStep ? clean(input.nextStep, 220) : undefined,
    successCriteria: input.successCriteria ? clean(input.successCriteria, 800) : undefined,
    lastAssistantSummary: input.lastAssistantSummary ? clean(input.lastAssistantSummary, 400) : undefined,
    nextReviewAt: graphAdmission ? undefined : input.nextReviewAt,
    blocker: input.blocker ? clean(input.blocker, 220) : undefined,
    // A project graph is owned by its durable workflow runner. It must never
    // race the legacy execution controller, including in the crash window
    // between compiler admission and root-run queue reconciliation.
    autoAdvance: graphAdmission ? false : input.autoAdvance !== false,
    taskBindings: [],
    workflowBindings: [],
    delegationBindings: [],
    activity: [],
    confidence: Math.max(0, Math.min(1, input.confidence)),
    reasons: input.reasons.map((item) => clean(item, 140)).filter(Boolean).slice(0, 8),
  };
}

export function rootWorkflowReceiptForSource(sessionId: string, sourceUserSeq: number): string {
  if (!sessionId || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) {
    throw new Error('A root workflow receipt requires an exact accepted source.');
  }
  return `project-turn:v1:${sourceTurnKeyHash(sessionId, sourceUserSeq)}`;
}

function assertExecutionGraphAdmissionIntegrity(execution: ExecutionRecord): void {
  const admission = execution.graphAdmission;
  if (!admission) return;
  const sourceUserSeq = execution.sourceUserSeq;
  if (!Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) {
    throw new Error('Persisted project admission has no exact accepted source.');
  }
  const expectedSourceHash = sourceTurnKeyHash(execution.sessionId, sourceUserSeq as number);
  const expectedReceipt = rootWorkflowReceiptForSource(execution.sessionId, sourceUserSeq as number);
  if (
    admission.version !== 1
    || admission.kind !== 'project_graph'
    || admission.sourceTurnKeyHash !== expectedSourceHash
    || admission.turnGraphId !== `turn-graph:v1:${sourceUserSeq}`
    || !/^[a-f0-9]{64}$/.test(admission.turnGraphHash)
    || admission.rootWorkflowReceiptId !== expectedReceipt
    || typeof admission.admittedAt !== 'string'
    || !Number.isFinite(Date.parse(admission.admittedAt))
  ) {
    throw new Error('Persisted project admission failed its source integrity check.');
  }
  const compiledPlan = assertPersistedCompiledPlanSnapshot(admission.compiledPlan);
  if (admission.planHash !== compiledPlan.planHash) {
    throw new Error('Persisted project admission plan hash does not match its compiler snapshot.');
  }
  if (
    admission.rootWorkflowRunId !== undefined
    && (typeof admission.rootWorkflowRunId !== 'string' || !admission.rootWorkflowRunId.trim())
  ) {
    throw new Error('Persisted project admission has an invalid root workflow run id.');
  }
}

export type ExecutionUpdatePatch = Partial<Omit<
  ExecutionRecord,
  'id' | 'createdAt' | 'sessionId' | 'sourceUserSeq' | 'sourceUserSeqs' | 'graphAdmission'
>>;

/** Apply a normal mutable-field patch to a record already loaded under the
 * execution file lock. Exact identity and graph authority are stripped again
 * at runtime so JavaScript/legacy callers cannot bypass the TypeScript shape. */
function applyExecutionUpdate(
  execution: ExecutionRecord,
  patch: ExecutionUpdatePatch,
): ExecutionRecord {
  const now = new Date().toISOString();
  const {
    id: _ignoredId,
    sessionId: _ignoredSessionId,
    createdAt: _ignoredCreatedAt,
    sourceUserSeq: _ignoredSourceUserSeq,
    sourceUserSeqs: _ignoredSourceUserSeqs,
    graphAdmission: _ignoredGraphAdmission,
    ...safePatch
  } = patch as Partial<ExecutionRecord>;
  Object.assign(execution, safePatch, {
    updatedAt: now,
    lastActivityAt: patch.lastActivityAt ?? now,
  });
  if (patch.status === 'completed') {
    const evidence = executionExternalWriteStatus(execution);
    if (
      !execution.blocker
      && (evidence.status === 'failed' || evidence.status === 'ambiguous')
    ) {
      applyExternalWriteTruthBlock(execution, evidence.status, evidence.latestNegativeSeq);
    } else if (execution.status === 'completed') {
      execution.completedAt = now;
      closeLinkedVaultTasks(execution, now);
    }
  }
  return execution;
}

export class ExecutionStore {
  list(limit = 20, status?: ExecutionRecord['status']): ExecutionRecord[] {
    return executionsFileLock(() => {
      const executions = loadExecutionsUnlocked();
      const select = () => executions
        .filter((execution) => !status || execution.status === status)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit);
      // Reconcile only records that can actually be returned. If a selected
      // completion reopens, select again to backfill a status-filtered page.
      for (let pass = 0; pass <= executions.length; pass += 1) {
        const selected = select();
        if (!persistReconciledExecutions(executions, selected)) return selected;
      }
      return select();
    });
  }

  get(id: string): ExecutionRecord | undefined {
    return executionsFileLock(() => {
      const executions = loadExecutionsUnlocked();
      const execution = executions.find((entry) => entry.id === id);
      if (execution) persistReconciledExecutions(executions, [execution]);
      return execution;
    });
  }

  getActiveForSession(sessionId: string): ExecutionRecord | undefined {
    return executionsFileLock(() => {
      const executions = loadExecutionsUnlocked();
      const sessionExecutions = executions.filter((execution) => execution.sessionId === sessionId);
      persistReconciledExecutions(executions, sessionExecutions);
      return sessionExecutions
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .find((execution) => execution.status === 'active' || execution.status === 'blocked');
    });
  }

  create(input: CreateExecutionInput): ExecutionRecord {
    return executionsFileLock(() => {
      const executions = loadExecutionsUnlocked();
      const execution = buildExecutionRecord(input);
      executions.push(execution);
      saveExecutionsUnlocked(executions);
      return execution;
    });
  }

  /**
   * Linearizable project admission for one exact accepted human turn. Every
   * process derives the same id and queue receipt; the first persisted graph
   * and plan digests are immutable on replay.
   */
  createOrGetForSource(
    input: CreateOrGetExecutionForSourceInput,
  ): CreateOrGetExecutionForSourceResult {
    const compiledPlan = assertGraphAdmissionInput(
      input.sessionId,
      input.sourceUserSeq,
      input.admission,
    );
    const keyHash = sourceTurnKeyHash(input.sessionId, input.sourceUserSeq);
    const deterministicId = deterministicSourceExecutionId(input.sessionId, input.sourceUserSeq);
    const receiptId = rootWorkflowReceiptForSource(input.sessionId, input.sourceUserSeq);
    return executionsFileLock(() => {
      const executions = loadExecutionsUnlocked();
      const exact = executions.filter((entry) =>
        entry.sessionId === input.sessionId && entry.sourceUserSeq === input.sourceUserSeq
      );
      if (exact.length > 1) {
        throw new Error('Multiple executions already claim the same accepted source; project admission failed closed.');
      }
      const idOwner = executions.find((entry) => entry.id === deterministicId);
      if (idOwner && !exact.includes(idOwner)) {
        throw new Error('Deterministic execution id is already owned by another accepted source.');
      }

      const existing = exact[0];
      if (existing) {
        const admitted = existing.graphAdmission;
        if (admitted) {
          if (
            admitted.version !== 1
            || admitted.kind !== 'project_graph'
            || admitted.sourceTurnKeyHash !== keyHash
            || admitted.turnGraphId !== input.admission.turnGraphId
            || admitted.turnGraphHash !== input.admission.turnGraphHash
            || admitted.rootWorkflowReceiptId !== receiptId
          ) {
            throw new Error('Accepted source already has a different immutable project admission.');
          }
          const persistedPlan = assertPersistedCompiledPlanSnapshot(admitted.compiledPlan);
          if (admitted.planHash !== persistedPlan.planHash) {
            throw new Error('Persisted project admission plan hash does not match its compiler snapshot.');
          }
          const plannerConflict = persistedPlan.snapshotHash !== compiledPlan.snapshotHash;
          let repairedControllerOwnership = false;
          if (existing.autoAdvance !== false || existing.nextReviewAt !== undefined) {
            existing.autoAdvance = false;
            existing.nextReviewAt = undefined;
            repairedControllerOwnership = true;
          }
          if (repairedControllerOwnership) {
            existing.updatedAt = new Date().toISOString();
            saveExecutionsUnlocked(executions);
          }
          return {
            execution: existing,
            created: false,
            plannerConflict,
            rootWorkflowReceiptId: admitted.rootWorkflowReceiptId,
          };
        }

        const now = new Date().toISOString();
        existing.graphAdmission = {
          version: 1,
          kind: 'project_graph',
          sourceTurnKeyHash: keyHash,
          turnGraphId: input.admission.turnGraphId,
          turnGraphHash: input.admission.turnGraphHash,
          planHash: compiledPlan.planHash,
          compiledPlan,
          rootWorkflowReceiptId: receiptId,
          admittedAt: now,
        };
        existing.autoAdvance = false;
        existing.nextReviewAt = undefined;
        existing.activity = Array.isArray(existing.activity) ? existing.activity : [];
        existing.activity.push({
          id: randomUUID(),
          key: `project-admitted:${keyHash}`,
          type: 'status',
          message: 'Bound this execution to the exact accepted project turn.',
          createdAt: now,
          metadata: {
            source: 'project_graph',
            sourceUserSeq: input.sourceUserSeq,
            turnGraphId: input.admission.turnGraphId,
            turnGraphHash: input.admission.turnGraphHash,
            planHash: compiledPlan.planHash,
            compiledPlanHash: compiledPlan.snapshotHash,
          },
        });
        existing.activity = existing.activity.slice(-60);
        existing.updatedAt = now;
        existing.lastActivityAt = now;
        saveExecutionsUnlocked(executions);
        return {
          execution: existing,
          created: false,
          plannerConflict: false,
          rootWorkflowReceiptId: receiptId,
        };
      }

      const admittedAt = new Date().toISOString();
      const execution = buildExecutionRecord({ ...input, sourceUserSeq: input.sourceUserSeq }, deterministicId, {
        version: 1,
        kind: 'project_graph',
        sourceTurnKeyHash: keyHash,
        turnGraphId: input.admission.turnGraphId,
        turnGraphHash: input.admission.turnGraphHash,
        planHash: compiledPlan.planHash,
        compiledPlan,
        rootWorkflowReceiptId: receiptId,
        admittedAt,
      });
      execution.activity = [{
        id: randomUUID(),
        key: `project-admitted:${keyHash}`,
        type: 'status',
        message: 'Admitted a durable project execution for this accepted turn.',
        createdAt: admittedAt,
        metadata: {
          source: 'project_graph',
          sourceUserSeq: input.sourceUserSeq,
          turnGraphId: input.admission.turnGraphId,
          turnGraphHash: input.admission.turnGraphHash,
          planHash: compiledPlan.planHash,
          compiledPlanHash: compiledPlan.snapshotHash,
        },
      }];
      executions.push(execution);
      saveExecutionsUnlocked(executions);
      return {
        execution,
        created: true,
        plannerConflict: false,
        rootWorkflowReceiptId: receiptId,
      };
    });
  }

  getForSource(sessionId: string, sourceUserSeq: number): ExecutionRecord | undefined {
    if (!sessionId || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) return undefined;
    return executionsFileLock(() => {
      const matches = loadExecutionsUnlocked().filter((entry) =>
        entry.sessionId === sessionId && entry.sourceUserSeq === sourceUserSeq
      );
      if (matches.length > 1) {
        throw new Error('Multiple executions claim the same accepted source; project lookup failed closed.');
      }
      const execution = matches[0];
      if (execution) assertExecutionGraphAdmissionIntegrity(execution);
      return execution;
    });
  }

  /**
   * Find durable project admissions that have not installed their one root
   * run yet. This is the pre-run half of crash/readiness recovery: unlike the
   * legacy due-execution controller, it returns only exact, integrity-checked
   * graph sources and never advances them itself.
   */
  listUnboundProjectGraphSources(): UnboundProjectGraphSourceScan {
    return executionsFileLock(() => {
      const sources: UnboundProjectGraphSource[] = [];
      let rejected = 0;
      for (const execution of loadExecutionsUnlocked()) {
        if (!execution.graphAdmission) continue;
        // Paused or terminal executions are an explicit stop boundary. A
        // restart reconciler may not silently revive them merely because their
        // root was never installed.
        if (execution.status !== 'active' && execution.status !== 'blocked') continue;
        try {
          assertExecutionGraphAdmissionIntegrity(execution);
        } catch {
          rejected += 1;
          continue;
        }
        if (execution.graphAdmission.rootWorkflowRunId) continue;
        if (!Number.isSafeInteger(execution.sourceUserSeq) || (execution.sourceUserSeq ?? 0) <= 0) {
          rejected += 1;
          continue;
        }
        sources.push({
          executionId: execution.id,
          sessionId: execution.sessionId,
          sourceUserSeq: execution.sourceUserSeq as number,
        });
      }
      sources.sort((left, right) => (
        left.sessionId.localeCompare(right.sessionId)
        || left.sourceUserSeq - right.sourceUserSeq
        || left.executionId.localeCompare(right.executionId)
      ));
      return { sources, rejected };
    });
  }

  /** Bind the one root workflow occurrence without allowing a retry to swap it. */
  bindRootWorkflowRunForSource(input: {
    sessionId: string;
    sourceUserSeq: number;
    rootWorkflowReceiptId: string;
    runId: string;
    workflow: string;
  }): ExecutionRecord {
    const expectedReceiptId = rootWorkflowReceiptForSource(input.sessionId, input.sourceUserSeq);
    if (input.rootWorkflowReceiptId !== expectedReceiptId) {
      throw new Error('Root workflow binding receipt does not match its exact accepted source.');
    }
    const runId = input.runId.trim();
    const workflow = input.workflow.trim();
    if (!runId || !workflow) throw new Error('Root workflow binding requires a run id and workflow name.');
    return executionsFileLock(() => {
      const executions = loadExecutionsUnlocked();
      const matches = executions.filter((entry) =>
        entry.sessionId === input.sessionId && entry.sourceUserSeq === input.sourceUserSeq
      );
      if (matches.length > 1) {
        throw new Error('Multiple executions claim the same accepted source; root workflow binding failed closed.');
      }
      const execution = matches[0];
      if (!execution?.graphAdmission) {
        throw new Error('Root workflow binding requires an admitted project execution.');
      }
      assertExecutionGraphAdmissionIntegrity(execution);
      if (execution.graphAdmission.rootWorkflowReceiptId !== expectedReceiptId) {
        throw new Error('Persisted project admission has a different root workflow receipt.');
      }
      const persistedPlan = assertPersistedCompiledPlanSnapshot(execution.graphAdmission.compiledPlan);
      if (
        execution.graphAdmission.planHash !== persistedPlan.planHash
        || workflow !== persistedPlan.definition.name
      ) {
        throw new Error('Root workflow binding does not match the immutable compiled project plan.');
      }
      if (execution.graphAdmission.rootWorkflowRunId && execution.graphAdmission.rootWorkflowRunId !== runId) {
        throw new Error('Accepted project source is already bound to a different root workflow run.');
      }
      const existingBinding = (execution.workflowBindings ?? []).find((binding) => binding.runId === runId);
      if (existingBinding && existingBinding.workflow !== workflow) {
        throw new Error('Root workflow run is already bound under a different workflow identity.');
      }
      const now = new Date().toISOString();
      execution.graphAdmission.rootWorkflowRunId = runId;
      execution.workflowBindings = existingBinding
        ? execution.workflowBindings
        : [
            ...(execution.workflowBindings ?? []),
            { runId, workflow, status: 'queued', createdAt: now, updatedAt: now },
          ];
      execution.autoAdvance = false;
      execution.nextReviewAt = undefined;
      execution.nextStep = 'Durable workflow is executing the admitted project graph.';
      execution.lastAssistantSummary = `Queued durable workflow run ${runId}.`;
      execution.updatedAt = now;
      execution.lastActivityAt = now;
      execution.activity = Array.isArray(execution.activity) ? execution.activity : [];
      const activityKey = `workflow:${runId}:queued`;
      if (!execution.activity.some((item) => item.key === activityKey)) {
        execution.activity.push({
          id: randomUUID(),
          key: activityKey,
          type: 'workflow_queued',
          message: `Queued durable root workflow "${clean(workflow, 120)}".`,
          createdAt: now,
          metadata: { source: 'project_graph', runId, workflow },
        });
        execution.activity = execution.activity.slice(-60);
      }
      saveExecutionsUnlocked(executions);
      return execution;
    });
  }

  /**
   * Attach one exact follow-up user request to an existing execution. This is
   * deliberately explicit: ambient "latest user" state and generic continue
   * prose must never lend an unrelated turn's write receipts to an execution.
   */
  bindSourceUserSeq(
    id: string,
    sessionId: string,
    sourceUserSeq: number,
    sourceTool: string,
  ): ExecutionRecord | undefined {
    if (
      !sessionId
      || !Number.isSafeInteger(sourceUserSeq)
      || sourceUserSeq <= 0
    ) return undefined;
    // Event rows are append-only. Resolve this outside the execution lock so
    // event-log and execution-ledger locks never acquire one another in the
    // opposite order.
    if (!exactAcceptedHumanSource(sessionId, sourceUserSeq)) return undefined;

    return executionsFileLock(() => {
      const executions = loadExecutionsUnlocked();
      const execution = executions.find((entry) => entry.id === id);
      if (!execution || execution.sessionId !== sessionId) return undefined;

      if (!execution.sourceUserSeq) {
        execution.sourceUserSeq = sourceUserSeq;
      } else if (execution.sourceUserSeq !== sourceUserSeq) {
        execution.sourceUserSeqs = [...new Set([
          ...(execution.sourceUserSeqs ?? []),
          sourceUserSeq,
        ])].sort((left, right) => left - right);
      }

      execution.activity = Array.isArray(execution.activity) ? execution.activity : [];
      const activityKey = `source-user-bound:${sourceUserSeq}`;
      if (!execution.activity.some((item) => item.key === activityKey)) {
        const now = new Date().toISOString();
        execution.activity.push({
          id: randomUUID(),
          key: activityKey,
          type: 'status',
          message: clean('Linked this exact follow-up request to the execution audit trail.', 500),
          createdAt: now,
          metadata: {
            source: 'explicit_execution_tool',
            sourceTool: clean(sourceTool, 80),
            sourceUserSeq,
          },
        });
        execution.activity = execution.activity.slice(-60);
        execution.updatedAt = now;
        execution.lastActivityAt = now;
      }
      saveExecutionsUnlocked(executions);
      return execution;
    });
  }

  addActivity(input: {
    executionId: string;
    key: string;
    type: NonNullable<ExecutionRecord['activity']>[number]['type'];
    message: string;
    metadata?: Record<string, unknown>;
  }): ExecutionRecord | undefined {
    return executionsFileLock(() => {
      const executions = loadExecutionsUnlocked();
      const execution = executions.find((entry) => entry.id === input.executionId);
      if (!execution) return undefined;

      execution.activity = Array.isArray(execution.activity) ? execution.activity : [];
      if (execution.activity.some((item) => item.key === input.key)) {
        return execution;
      }

      const now = new Date().toISOString();
      execution.activity.push({
        id: randomUUID(),
        key: input.key,
        type: input.type,
        message: clean(input.message, 500),
        createdAt: now,
        metadata: input.metadata,
      });
      execution.activity = execution.activity.slice(-60);
      execution.updatedAt = now;
      execution.lastActivityAt = now;
      saveExecutionsUnlocked(executions);
      return execution;
    });
  }

  recentActivity(executionId: string, limit = 10): NonNullable<ExecutionRecord['activity']> {
    const execution = this.get(executionId);
    return [...(execution?.activity ?? [])]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  update(
    id: string,
    patch: ExecutionUpdatePatch,
  ): ExecutionRecord | undefined {
    return executionsFileLock(() => {
      const executions = loadExecutionsUnlocked();
      const execution = executions.find((entry) => entry.id === id);
      if (!execution) return undefined;

      applyExecutionUpdate(execution, patch);
      saveExecutionsUnlocked(executions);
      return execution;
    });
  }

  /**
   * Persist the exact accepted request boundary (for legacy records that
   * predate it) and deterministically block unresolved failed/ambiguous writes.
   * No model or completion judge participates in this decision.
   */
  reconcileExternalWriteTruth(id: string): ExecutionExternalWriteTruth | undefined {
    return executionsFileLock(() => {
      const executions = loadExecutionsUnlocked();
      const execution = executions.find((entry) => entry.id === id);
      if (!execution) return undefined;
      let changed = false;
      const evidence = executionExternalWriteStatus(execution);
      if (evidence.status === 'failed' || evidence.status === 'ambiguous') {
        changed = applyExternalWriteTruthBlock(
          execution,
          evidence.status,
          evidence.latestNegativeSeq,
        ) || changed;
      }
      if (changed) saveExecutionsUnlocked(executions);
      return {
        status: evidence.status,
        confirmedActionKeys: evidence.confirmedActionKeys,
        execution,
      };
    });
  }

  listDue(now = new Date(), limit = 20): ExecutionRecord[] {
    return executionsFileLock(() => loadExecutionsUnlocked().filter((execution) => {
        if (execution.graphAdmission) return false;
        if (execution.autoAdvance === false) return false;
        if (!isUserFacingExecution(execution)) return false;
        if (execution.status !== 'active' && execution.status !== 'blocked') return false;
        if (!execution.nextReviewAt) return true;
        return new Date(execution.nextReviewAt).getTime() <= now.getTime();
      })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit));
  }

  syncWithPlan(executionId: string, plan?: PlanRecord): ExecutionRecord | undefined {
    return executionsFileLock(() => {
      const executions = loadExecutionsUnlocked();
      const execution = executions.find((entry) => entry.id === executionId);
      if (!execution) return undefined;
      persistReconciledExecutions(executions, [execution]);
      if (!plan) return execution;

      const activeStep = plan.steps.find((step) => step.status === 'in_progress');
      const allDone = plan.steps.length > 0 && plan.steps.every((step) => step.status === 'done');
      applyExecutionUpdate(execution, {
        planId: plan.id,
        nextStep: activeStep?.text ?? execution.nextStep,
        status: execution.status,
        blocker: execution.blocker,
        lastAssistantSummary: execution.lastAssistantSummary,
        ...(allDone && execution.status !== 'completed'
          ? {
              nextStep: 'Validate completion evidence for the finished plan.',
              nextReviewAt: new Date().toISOString(),
            }
          : {}),
      });
      saveExecutionsUnlocked(executions);
      return execution;
    });
  }
}

/**
 * Force-close executions that have been sitting in `active`/`blocked`/`paused`
 * with no activity for longer than `staleAfterMs`. The model is supposed to
 * call `execution_complete` when its work is done; when it forgets (turn cap,
 * compaction, crash mid-run), the record stays "active" forever and the
 * dashboard reports phantom in-flight work. Returns the number swept.
 */
export function sweepStaleExecutions(staleAfterMs = 60 * 60 * 1000): number {
  return executionsFileLock(() => {
    const cutoff = Date.now() - staleAfterMs;
    const executions = loadExecutionsUnlocked();
    const now = new Date().toISOString();
    let swept = 0;
    for (const execution of executions) {
      if (execution.status !== 'active' && execution.status !== 'blocked' && execution.status !== 'paused') continue;
      const updated = Date.parse(execution.lastActivityAt || execution.updatedAt || execution.createdAt);
      if (Number.isFinite(updated) && updated > cutoff) continue;
      const note = `Auto-closed: no activity for ${Math.round(staleAfterMs / 60000)}m (stale-execution sweep).`;
      execution.status = 'completed';
      execution.updatedAt = now;
      execution.lastActivityAt = now;
      execution.blocker = note;
      execution.lastAssistantSummary = execution.lastAssistantSummary
        ? `${execution.lastAssistantSummary} | ${note}`
        : note;
      execution.activity = Array.isArray(execution.activity) ? execution.activity : [];
      execution.activity.push({
        id: randomUUID(),
        key: `sweep-${Date.now()}`,
        type: 'status',
        message: note,
        createdAt: now,
      });
      execution.activity = execution.activity.slice(-60);
      swept += 1;
    }
    if (swept > 0) saveExecutionsUnlocked(executions);
    return swept;
  });
}

export function renderExecutionSummary(execution: ExecutionRecord): string {
  const parts = [
    `[${execution.status}] ${execution.title}`,
    execution.nextStep ? `Next: ${execution.nextStep}` : '',
    execution.blocker ? `Blocker: ${execution.blocker}` : '',
    execution.successCriteria ? `Done when: ${execution.successCriteria}` : '',
  ].filter(Boolean);
  return parts.join(' | ');
}

interface FailedExecutionTransitionNotice {
  executionId: string;
  title: string;
  previousStatus: ExecutionRecord['status'];
  reason: string;
  activityKey: string;
  createdAt: string;
  userFacing: boolean;
}

function transitionToFailed(
  execution: ExecutionRecord,
  reason: string,
  activityKey: string,
): FailedExecutionTransitionNotice {
  const now = new Date().toISOString();
  const previousStatus = execution.status;
  execution.status = 'completed'; // ExecutionRecord status doesn't have 'failed' — keep 'completed' semantically + use blocker for reason
  execution.updatedAt = now;
  execution.lastActivityAt = now;
  execution.blocker = reason;
  execution.lastAssistantSummary = execution.lastAssistantSummary
    ? `${execution.lastAssistantSummary} | ${reason}`
    : reason;
  execution.activity = Array.isArray(execution.activity) ? execution.activity : [];
  execution.activity.push({
    id: randomUUID(),
    key: activityKey,
    type: 'status',
    message: reason,
    createdAt: now,
  });
  execution.activity = execution.activity.slice(-60);

  return {
    executionId: execution.id,
    title: execution.title,
    previousStatus,
    reason,
    activityKey,
    createdAt: now,
    userFacing: isUserFacingExecution(execution),
  };
}

/** Publish only after the failed transition is durable and the execution-file
 * lock has been released. Synchronous listeners may safely write the store. */
function publishFailedExecutionTransition(notice: FailedExecutionTransitionNotice): void {
  actionBus.emit({
    kind: 'execution.transitioned',
    executionId: notice.executionId,
    title: notice.title,
    previousState: notice.previousStatus,
    nextState: 'completed',
    summary: notice.reason,
  });

  if (notice.userFacing) {
    addNotification({
      id: `${Date.now()}-execution-${notice.executionId}-${notice.activityKey}`,
      kind: 'execution',
      title: `Execution stopped: ${notice.title}`,
      body: notice.reason,
      createdAt: notice.createdAt,
      read: false,
      metadata: { executionId: notice.executionId, sweepKey: notice.activityKey },
    });
  }
}

/**
 * Reaper #1 — controller-crash detector. Active executions that haven't
 * had a heartbeat in `staleAfterMs` (default 5 min) are presumed to have
 * crashed mid-cycle: the controller process died, the daemon was
 * SIGSTOP'd, or `advanceExecution` is wedged. We can't recover the run
 * automatically (the model context is gone), but we can stop silently
 * pretending it's still working — flip to a stopped state, fire a
 * notification, and let the user retry if they care.
 *
 * Only kicks in for executions that have *ever* had a heartbeat
 * written (`lastHeartbeatAt` set). Executions created before this
 * field existed, or created very recently, are left alone — the
 * activity-based sweep (`sweepStaleExecutions`, 60 min) is the
 * fallback for those.
 */
export function sweepCrashedExecutions(staleAfterMs = 5 * 60 * 1000): number {
  const notices: FailedExecutionTransitionNotice[] = [];
  const swept = executionsFileLock(() => {
    const cutoff = Date.now() - staleAfterMs;
    const executions = loadExecutionsUnlocked();
    let swept = 0;
    for (const execution of executions) {
      if (execution.status !== 'active') continue;
      if (!execution.lastHeartbeatAt) continue;
      const heartbeatTime = Date.parse(execution.lastHeartbeatAt);
      if (!Number.isFinite(heartbeatTime) || heartbeatTime > cutoff) continue;
      const recordActivityTimes = [execution.lastActivityAt, execution.updatedAt]
        .map((value) => Date.parse(value || ''))
        .filter(Number.isFinite);
      const recentRecordActivity = recordActivityTimes.length > 0 ? Math.max(...recordActivityTimes) : NaN;
      if (Number.isFinite(recentRecordActivity) && recentRecordActivity > cutoff) continue;
      if (hasRecentHarnessActivity(execution.sessionId, cutoff)) continue;
    // v0.5.19 Bug F fix — pause-aware sweep. If the execution's session
    // is legitimately parked on a user prompt (pending approval, recent
    // awaiting_user_input event from F4/Bug C), the heartbeat going
    // stale is EXPECTED — the controller has nothing to do until the
    // user replies. Auto-failing here kills the execution lane so when
    // the user does reply, EXECUTION_WRAP_REQUIRED has no active lane
    // and the next mutating call fails or requires a fresh wrap.
    // Same architecture pattern as P0-2 (per-tool timeout during
    // approval wait, fixed v0.5.5 via withTimeout's isPaused check).
    // Honors CLEMMY_SWEEP_AWARE_OF_PAUSES=off to revert.
      if (isExecutionLegitimatelyIdle(execution)) {
        continue;
      }
    // v0.5.64 — schedule-aware sweep. The controller schedules the NEXT review
    // up to 15-60 min out (controller.ts `nextReviewAt: plusMinutes(30/60)`),
    // and the heartbeat only ticks when an execution actually RUNS a cycle. So
    // an execution legitimately waiting for a future-scheduled review has a
    // stale heartbeat BY DESIGN — it is not crashed. Only sweep executions that
    // are OVERDUE for review (nextReviewAt has passed) AND heartbeat-stale —
    // that is the real "should have run but the controller didn't tick it"
    // crash/starvation signal. Without this, every execution that scheduled a
    // review more than `staleAfterMs` (5m) out was false-swept as "heartbeat
    // stalled" (observed 2026-06-03: a send-emails execution scheduled
    // nextReviewAt=+30m, swept at +7m, so the send never ran).
    // Honors CLEMMY_SWEEP_HONOR_NEXT_REVIEW=off to revert.
      if ((process.env.CLEMMY_SWEEP_HONOR_NEXT_REVIEW ?? 'on').toLowerCase() !== 'off' && execution.nextReviewAt) {
        const nextReview = Date.parse(execution.nextReviewAt);
        if (Number.isFinite(nextReview) && nextReview > Date.now()) continue;
      }
      const ageMinutes = Math.round((Date.now() - heartbeatTime) / 60000);
      notices.push(transitionToFailed(
        execution,
      // Honest framing: a stale heartbeat could be (a) the daemon
      // actually crashed, or (b) the daemon was alive but didn't tick
      // this execution's controller for too long (busy with a long
      // user-facing turn, blocked sub-process, etc.). The earlier
      // "daemon likely crashed mid-cycle" wording was misleading in
      // case (b) — sent users hunting for a crash that wasn't there.
      // Observed 2026-05-24 with a synthesis execution that starved
      // while the daemon was alive and processing Discord.
        `Controller heartbeat stalled for ${ageMinutes}m — the execution stopped getting controller cycles (the daemon may have been busy on other work or restarted).`,
        `sweep-crashed-${Date.now()}`,
      ));
      swept += 1;
    }
    if (swept > 0) saveExecutionsUnlocked(executions);
    return swept;
  });
  for (const notice of notices) publishFailedExecutionTransition(notice);
  return swept;
}

/**
 * v0.5.19 Bug F — pause-aware sweep helper. Returns true when the
 * execution's session is in a state where the controller is RIGHT
 * NOT to be ticking — pending approval, recent awaiting_user_input
 * from F4/Bug C ask-user routing. The sweep should skip these.
 *
 * v0.5.19 follow-up: initial implementation used CommonJS require()
 * which throws ReferenceError in this ESM package — the try/catch
 * silently swallowed it and the function returned false for every
 * call, defeating the fix. Now uses static ESM imports (no circular
 * dep risk: neither eventlog nor approval-registry imports from
 * execution/store).
 *
 * Honors CLEMMY_SWEEP_AWARE_OF_PAUSES=off to revert.
 */
function isExecutionLegitimatelyIdle(execution: { sessionId: string }): boolean {
  if ((process.env.CLEMMY_SWEEP_AWARE_OF_PAUSES ?? 'on').toLowerCase() === 'off') {
    return false;
  }
  try {
    if (approvalRegistry.hasPending(execution.sessionId)) return true;
  } catch {
    // best-effort; better to sweep a real crash than to never reap
  }
  try {
    const recent = listHarnessEvents(execution.sessionId, { types: ['awaiting_user_input'], limit: 1 });
    if (recent.length > 0) {
      // Treat any awaiting_user_input event in the LAST 24h as
      // legitimate idle. After 24h the session is probably abandoned
      // and the sweep should reap.
      const evt = recent[0] as { type: string; createdAt?: string; ts?: string };
      const ts = evt.createdAt ?? evt.ts;
      if (ts) {
        const evtTime = Date.parse(ts);
        if (Number.isFinite(evtTime) && Date.now() - evtTime < 24 * 60 * 60 * 1000) {
          return true;
        }
      } else {
        // No timestamp — be generous and treat as idle.
        return true;
      }
    }
  } catch {
    // best-effort
  }
  return false;
}

function hasRecentHarnessActivity(sessionId: string, cutoff: number): boolean {
  try {
    const recent = listHarnessEvents(sessionId, { limit: 1, desc: true });
    const latest = recent[0];
    if (!latest) return false;
    const eventTime = Date.parse(latest.createdAt);
    return Number.isFinite(eventTime) && eventTime > cutoff;
  } catch {
    return false;
  }
}

/**
 * Reaper #2 — perpetually-blocked execution detector. An execution
 * sits in `blocked` because the controller decided synthesis can't
 * proceed (waiting on a user reply, an external integration, etc.).
 * The existing `sweepStaleExecutions` runs at 60 min on `lastActivityAt`
 * which also fires controller-tick activity — so a blocked execution
 * that the controller checks on every 30 min indefinitely never trips
 * that sweep. This one looks at `updatedAt` (when state last actually
 * CHANGED) so a stuck blocker actually times out. Default 6 hours.
 */
export function sweepStaleBlockedExecutions(staleAfterMs = 6 * 60 * 60 * 1000): number {
  const notices: FailedExecutionTransitionNotice[] = [];
  const swept = executionsFileLock(() => {
    const cutoff = Date.now() - staleAfterMs;
    const executions = loadExecutionsUnlocked();
    let swept = 0;
    for (const execution of executions) {
      if (execution.status !== 'blocked') continue;
      const updated = Date.parse(execution.updatedAt || execution.createdAt);
      if (!Number.isFinite(updated) || updated > cutoff) continue;
      const ageHours = Math.round((Date.now() - updated) / 3600000);
      notices.push(transitionToFailed(
        execution,
        `Blocked for ${ageHours}h with no resolution — auto-failed; retry from the dashboard if still relevant.`,
        `sweep-blocked-${Date.now()}`,
      ));
      swept += 1;
    }
    if (swept > 0) saveExecutionsUnlocked(executions);
    return swept;
  });
  for (const notice of notices) publishFailedExecutionTransition(notice);
  return swept;
}
