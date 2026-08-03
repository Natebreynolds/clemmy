import { createHash, randomUUID } from 'node:crypto';
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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  exactOriginDeliveryReceiptForTarget,
  exactOriginDeliveryTargetDigest,
  normalizeExactOriginDeliveryTarget,
  sameExactOriginDeliveryTarget,
  type ExactOriginDeliveryTarget,
} from '../runtime/exact-origin-delivery.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { withWorkflowRunRecordLock } from './workflow-run-record.js';
import {
  isWorkflowTerminalOutcome,
  workflowTerminalOutcomeMatchesReport,
} from './workflow-terminal-outcome.js';

const ORIGIN_GROUP_VERSION = 1 as const;
const PREPARED_RECEIPT_VERSION = 1 as const;
const EXACT_ORIGIN_RECORD_VERSION = 2 as const;
const WORKFLOW_RUN_ORIGINS_DIR = path.join(WORKFLOW_RUNS_DIR, '.run-origins');
const WORKFLOW_ORIGIN_GROUPS_DIR = path.join(WORKFLOW_RUNS_DIR, '.origin-groups');
const WORKFLOW_ORIGIN_PREPARATION_PINS_DIR = path.join(WORKFLOW_RUNS_DIR, '.origin-preparation-pins');
const TERMINAL_WORKFLOW_RUN_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'error',
  'failed',
  'cancelled',
]);

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function validRunId(value: unknown): string | undefined {
  const runId = nonEmptyString(value);
  return runId && runId === runId.replace(/[^a-zA-Z0-9_.:-]/g, '') ? runId : undefined;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function hash(parts: readonly (string | number)[]): string {
  const h = createHash('sha256');
  for (const part of parts) h.update(String(part)).update('\0');
  return h.digest('hex');
}

/** Content identity for one member's immutable terminal checkpoint. This is
 * deliberately independent of the aggregate terminal bytes: it lets a
 * surviving member validate its local settlement projection after an older
 * sibling run has been reaped. */
export function workflowRunReportBackContentDigest(input: {
  workflowName: string;
  outcome: WorkflowOriginGroupTerminalStatus;
  detail: string;
}): string {
  if (
    typeof input.workflowName !== 'string'
    || (input.outcome !== 'done' && input.outcome !== 'blocked' && input.outcome !== 'failed')
    || typeof input.detail !== 'string'
  ) {
    throw new Error('workflow report-back content is invalid for digesting');
  }
  return createHash('sha256')
    .update('clementine.workflow-run-report-back-content.v1\0')
    .update(JSON.stringify({
      workflowName: input.workflowName,
      outcome: input.outcome,
      detail: input.detail,
    }))
    .digest('hex');
}

function ensureDirectoryDurably(dir: string): void {
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
  // Persist each directory's own contents and every newly-created entry in
  // its parent. In particular, a first group may create both `.origin-groups`
  // and its digest child in one recursive mkdir.
  const syncPaths = missing.length > 0 ? [...missing, cursor] : [dir];
  for (const syncPath of new Set(syncPaths)) {
    const fd = openSync(syncPath, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

function createJsonDurably(file: string, value: unknown): boolean {
  const dir = path.dirname(file);
  ensureDirectoryDurably(dir);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.new`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      unlinkSync(temp);
      if (process.platform !== 'win32') {
        const dirFd = openSync(dir, 'r');
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      }
      return false;
    }
    unlinkSync(temp);
    if (process.platform !== 'win32') {
      const dirFd = openSync(dir, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
    return true;
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw err;
  }
}

function replaceJsonDurably(file: string, value: unknown): void {
  const dir = path.dirname(file);
  ensureDirectoryDurably(dir);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
    if (process.platform !== 'win32') {
      const dirFd = openSync(dir, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw err;
  }
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as unknown;
  } catch (err) {
    throw new Error(`${label} is unreadable.`, { cause: err });
  }
}

function groupDir(groupId: string): string {
  return path.join(WORKFLOW_ORIGIN_GROUPS_DIR, createHash('sha256').update(groupId).digest('hex'));
}

function sealedGroupFile(groupId: string): string {
  return path.join(groupDir(groupId), 'sealed.json');
}

function activatedGroupFile(groupId: string): string {
  return path.join(groupDir(groupId), 'activated.json');
}

function closedGroupFile(groupId: string): string {
  return path.join(groupDir(groupId), 'closed.json');
}

function closingGroupFile(groupId: string): string {
  return path.join(groupDir(groupId), 'closing.json');
}

function settledGroupFile(groupId: string): string {
  return path.join(groupDir(groupId), 'settlement.json');
}

function compactedGroupFile(groupId: string): string {
  return path.join(groupDir(groupId), 'tombstone.json');
}

function groupPreparedDir(groupId: string): string {
  return path.join(groupDir(groupId), 'prepared');
}

function groupAdmissionsDir(groupId: string): string {
  return path.join(groupDir(groupId), 'admissions');
}

function groupAuthorityLockFile(groupId: string): string {
  return path.join(groupDir(groupId), 'authority');
}

function runPreparationPinDir(runId: string): string {
  return path.join(
    WORKFLOW_ORIGIN_PREPARATION_PINS_DIR,
    createHash('sha256').update(runId).digest('hex'),
  );
}

function runOriginDir(runId: string): string {
  return path.join(WORKFLOW_RUN_ORIGINS_DIR, createHash('sha256').update(runId).digest('hex'));
}

function runFile(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  if (!safe || safe !== runId) throw new Error(`Invalid workflow run id "${runId}".`);
  return path.join(WORKFLOW_RUNS_DIR, `${safe}.json`);
}

export interface WorkflowRunOriginIdentity {
  sessionId: string;
  sourceUserSeq: number;
}

export interface WorkflowRunOriginObserver extends WorkflowRunOriginIdentity {
  replyTarget: ExactOriginDeliveryTarget;
}

export interface WorkflowChatDispatchPreparationAuthority {
  version: 1;
  sourceGroupId: string;
  observerId: string;
  originSessionId: string;
  sourceUserSeq: number;
  runId: string;
  queueRequestDigest: string;
  replyTarget: ExactOriginDeliveryTarget;
  replyTargetDigest: string;
  preparationDigest: string;
}

export interface WorkflowChatDispatchPreparedReceipt extends WorkflowChatDispatchPreparationAuthority {
  receiptVersion: 1;
  preparedEventId: string;
  preparedEventSeq: number;
  preparedAt: string;
  receiptDigest: string;
}

/** Create-only queue-side ownership written before the trusted preparation
 * callback. The preparation authority is already a complete canonical binding
 * of source + request + target to one run, so no mutable staging fields are
 * needed. */
export type WorkflowChatDispatchAdmission = WorkflowChatDispatchPreparationAuthority;

export interface WorkflowChatDispatchAdmissionLookup {
  runId: string;
  queueRequestDigest: string;
  preparedReceipt?: WorkflowChatDispatchPreparedReceipt;
  phase: 'admitted' | 'prepared' | 'closing' | 'closed';
}

export interface WorkflowOriginGroupMember {
  runId: string;
  queueRequestDigest: string;
  preparationDigest: string;
  preparedEventId: string;
  preparedEventSeq: number;
  preparedAt: string;
  receiptDigest: string;
}

export interface WorkflowOriginGroupCloseAuthority {
  version: 1;
  sourceGroupId: string;
  observerId: string;
  originSessionId: string;
  sourceUserSeq: number;
  replyTarget: ExactOriginDeliveryTarget;
  replyTargetDigest: string;
  members: WorkflowOriginGroupMember[];
  closeDigest: string;
}

export interface WorkflowOriginGroupClosedBatchReceipt extends WorkflowOriginGroupCloseAuthority {
  receiptVersion: 1;
  closedEventId: string;
  closedEventSeq: number;
  closedAt: string;
  closeReceiptDigest: string;
}

/** Filesystem recovery record. The event receipt proves the graph close; the
 * full prepared receipts let boot recovery seal without asking the model or
 * inferring mutable event state. */
export interface DurableWorkflowOriginGroupClosedBatch {
  version: 1;
  receipt: WorkflowOriginGroupClosedBatchReceipt;
  preparedReceipts: WorkflowChatDispatchPreparedReceipt[];
  recordedAt: string;
}

export interface SealedWorkflowOriginGroup {
  version: 1;
  sourceGroupId: string;
  sourceGroupDigest: string;
  observerId: string;
  originSessionId: string;
  sourceUserSeq: number;
  replyTarget: ExactOriginDeliveryTarget;
  replyTargetDigest: string;
  members: WorkflowOriginGroupMember[];
  sealedAt: string;
}

export interface WorkflowOriginGroupActivationReceipt {
  version: 1;
  sourceGroupId: string;
  sourceGroupDigest: string;
  memberRunIds: string[];
  activatedAt: string;
  activationDigest: string;
}

export interface WorkflowOriginGroupPublicDispatch {
  version: 2;
  kind: 'workflow_run_group';
  status: 'dispatched';
  sourceUserSeq: number;
  sourceGroupId: string;
  sourceGroupDigest: string;
  runIds: string[];
  dispatchKey: string;
  replyTargetDigest: string;
}

export interface ActiveWorkflowOriginGroup {
  sealed: SealedWorkflowOriginGroup;
  activation: WorkflowOriginGroupActivationReceipt;
  publicDispatch: WorkflowOriginGroupPublicDispatch;
}

export interface WorkflowOriginGroupTerminalIdentity {
  eventId: string;
  outcomeId: string;
  sessionId: string;
  turn: number;
  sourceUserSeq: number;
  runId: string;
}

export type WorkflowOriginGroupTerminalStatus = 'done' | 'blocked' | 'failed';

export interface WorkflowOriginGroupMemberReportBackDigest {
  runId: string;
  reportBackDigest: string;
}

/** Immutable proof that the one precise provider/origin-chat destination has
 * acknowledged the aggregate terminal owned by this source group. Per-run ack
 * arrays are projections of this authority, never substitutes for it. */
export interface WorkflowOriginGroupSettlementReceipt {
  version: 1;
  sourceGroupId: string;
  sourceGroupDigest: string;
  observerId: string;
  replyTargetDigest: string;
  exactDeliveryReceipt: string;
  notificationId: string;
  terminalIdentity: WorkflowOriginGroupTerminalIdentity;
  terminalStatus: WorkflowOriginGroupTerminalStatus;
  terminalDigest: string;
  memberRunIds: string[];
  /** Ordered immutable member checkpoints that produced the reducer terminal. */
  memberReportBackDigests: WorkflowOriginGroupMemberReportBackDigest[];
  settledAt: string;
  settlementDigest: string;
}

export interface WorkflowOriginGroupSettlementTerminalInput
  extends WorkflowOriginGroupTerminalIdentity {
  status: WorkflowOriginGroupTerminalStatus;
  text: string;
}

/** One-file replay tombstone. It deliberately retains the exact close,
 * activation, membership, target, and settlement authority while removing
 * duplicated prepared receipts and lifecycle projections. */
export interface WorkflowOriginGroupTombstone {
  version: 1;
  kind: 'settled_workflow_origin_group';
  sourceGroupId: string;
  sourceGroupDigest: string;
  observerId: string;
  originSessionId: string;
  sourceUserSeq: number;
  replyTarget: ExactOriginDeliveryTarget;
  replyTargetDigest: string;
  members: WorkflowOriginGroupMember[];
  closeDigest: string;
  closedEventId: string;
  closedEventSeq: number;
  closedAt: string;
  closeReceiptDigest: string;
  closedRecordedAt: string;
  sealedAt: string;
  activatedAt: string;
  activationDigest: string;
  settlement: WorkflowOriginGroupSettlementReceipt;
  compactedAt: string;
  tombstoneDigest: string;
}

export interface ExactWorkflowRunOriginRecord {
  version: 2;
  runId: string;
  observerId: string;
  originSessionId: string;
  sourceUserSeq: number;
  replyTarget: ExactOriginDeliveryTarget;
  replyTargetDigest: string;
  sourceGroupId: string;
  sourceGroupDigest: string;
  recordedAt: string;
}

export function normalizeWorkflowRunOriginObserver(
  value: WorkflowRunOriginObserver | undefined,
): WorkflowRunOriginObserver | undefined {
  if (value === undefined) return undefined;
  const sessionId = nonEmptyString(value.sessionId);
  const replyTarget = normalizeExactOriginDeliveryTarget(value.replyTarget);
  if (!sessionId || !Number.isSafeInteger(value.sourceUserSeq) || value.sourceUserSeq <= 0 || !replyTarget) {
    throw new Error('workflow origin observer requires a sessionId, positive sourceUserSeq, and immutable exact replyTarget');
  }
  return { sessionId, sourceUserSeq: value.sourceUserSeq, replyTarget };
}

export function workflowRunOriginObserverId(identity: WorkflowRunOriginIdentity): string {
  const sessionId = nonEmptyString(identity.sessionId);
  if (!sessionId || !Number.isSafeInteger(identity.sourceUserSeq) || identity.sourceUserSeq <= 0) {
    throw new Error('workflow origin observer identity is required');
  }
  return `workflow-origin-v2:${hash(['clementine-workflow-origin:v2', sessionId, identity.sourceUserSeq])}`;
}

/** One accepted human source owns one immutable group. The target belongs in
 * the sealed digest, rather than the id, so a retry cannot fork the source by
 * changing channels after admission. */
export function workflowOriginSourceGroupId(identity: WorkflowRunOriginIdentity): string {
  const sessionId = nonEmptyString(identity.sessionId);
  if (!sessionId || !Number.isSafeInteger(identity.sourceUserSeq) || identity.sourceUserSeq <= 0) {
    throw new Error('workflow origin source group requires an exact source identity');
  }
  return `workflow-origin-group-v1:${hash(['clementine-workflow-origin-group:v1', sessionId, identity.sourceUserSeq])}`;
}

export function workflowChatDispatchQueueRequestDigest(input: {
  workflowName: string;
  normalizedInputs: Record<string, string>;
  targetStepId?: string;
  retryFailedItemsKey?: string;
}): string {
  const workflowName = nonEmptyString(input.workflowName);
  if (!workflowName) throw new Error('workflow chat dispatch request requires a workflow name');
  const inputs = Object.fromEntries(Object.entries(input.normalizedInputs).sort(([a], [b]) => a.localeCompare(b)));
  return hash([
    'clementine-workflow-chat-queue-request:v1',
    workflowName,
    JSON.stringify(inputs),
    nonEmptyString(input.targetStepId) ?? '',
    nonEmptyString(input.retryFailedItemsKey) ?? '',
  ]);
}

export function createWorkflowChatDispatchPreparationAuthority(input: {
  runId: string;
  observer: WorkflowRunOriginObserver;
  queueRequestDigest: string;
}): WorkflowChatDispatchPreparationAuthority {
  const runId = validRunId(input.runId);
  const observer = normalizeWorkflowRunOriginObserver(input.observer);
  if (!runId || !observer || !isDigest(input.queueRequestDigest)) {
    throw new Error('workflow chat dispatch preparation requires canonical run, source, target, and request digest authority');
  }
  const sourceGroupId = workflowOriginSourceGroupId(observer);
  const observerId = workflowRunOriginObserverId(observer);
  const replyTargetDigest = exactOriginDeliveryTargetDigest(observer.replyTarget);
  const preparationDigest = hash([
    'clementine-workflow-chat-dispatch-preparation:v1',
    sourceGroupId,
    observerId,
    observer.sessionId,
    observer.sourceUserSeq,
    runId,
    input.queueRequestDigest,
    replyTargetDigest,
  ]);
  return {
    version: PREPARED_RECEIPT_VERSION,
    sourceGroupId,
    observerId,
    originSessionId: observer.sessionId,
    sourceUserSeq: observer.sourceUserSeq,
    runId,
    queueRequestDigest: input.queueRequestDigest,
    replyTarget: observer.replyTarget,
    replyTargetDigest,
    preparationDigest,
  };
}

export function createWorkflowChatDispatchPreparedReceipt(
  authority: WorkflowChatDispatchPreparationAuthority,
  evidence: { eventId: string; eventSeq: number; preparedAt: string },
): WorkflowChatDispatchPreparedReceipt {
  const canonical = decodePreparationAuthority(authority);
  const preparedEventId = nonEmptyString(evidence.eventId);
  if (!preparedEventId || !Number.isSafeInteger(evidence.eventSeq) || evidence.eventSeq <= 0 || !isIsoTimestamp(evidence.preparedAt)) {
    throw new Error('workflow chat dispatch preparation receipt requires durable event identity evidence');
  }
  const receiptDigest = hash([
    'clementine-workflow-chat-dispatch-prepared-receipt:v1',
    canonical.preparationDigest,
    preparedEventId,
    evidence.eventSeq,
    evidence.preparedAt,
  ]);
  return {
    ...canonical,
    receiptVersion: PREPARED_RECEIPT_VERSION,
    preparedEventId,
    preparedEventSeq: evidence.eventSeq,
    preparedAt: evidence.preparedAt,
    receiptDigest,
  };
}

function decodePreparationAuthority(value: unknown): WorkflowChatDispatchPreparationAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow chat dispatch preparation authority is invalid');
  }
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.sourceUserSeq) || Number(raw.sourceUserSeq) <= 0) {
    throw new Error('workflow chat dispatch preparation authority is invalid');
  }
  const observer = normalizeWorkflowRunOriginObserver({
    sessionId: String(raw.originSessionId ?? ''),
    sourceUserSeq: raw.sourceUserSeq as number,
    replyTarget: raw.replyTarget as ExactOriginDeliveryTarget,
  });
  const runId = validRunId(raw.runId);
  if (raw.version !== PREPARED_RECEIPT_VERSION || !observer || !runId || !isDigest(raw.queueRequestDigest)) {
    throw new Error('workflow chat dispatch preparation authority is invalid');
  }
  const canonical = createWorkflowChatDispatchPreparationAuthority({
    runId,
    observer,
    queueRequestDigest: raw.queueRequestDigest,
  });
  if (
    raw.sourceGroupId !== canonical.sourceGroupId
    || raw.observerId !== canonical.observerId
    || raw.replyTargetDigest !== canonical.replyTargetDigest
    || raw.preparationDigest !== canonical.preparationDigest
  ) {
    throw new Error('workflow chat dispatch preparation authority digest does not match its canonical bytes');
  }
  return canonical;
}

export function decodeWorkflowChatDispatchPreparedReceipt(value: unknown): WorkflowChatDispatchPreparedReceipt {
  const authority = decodePreparationAuthority(value);
  const raw = value as Record<string, unknown>;
  const preparedEventId = nonEmptyString(raw.preparedEventId);
  if (
    raw.receiptVersion !== PREPARED_RECEIPT_VERSION
    || !preparedEventId
    || !Number.isSafeInteger(raw.preparedEventSeq)
    || Number(raw.preparedEventSeq) <= 0
    || !isIsoTimestamp(raw.preparedAt)
    || !isDigest(raw.receiptDigest)
  ) {
    throw new Error('workflow chat dispatch prepared receipt is invalid');
  }
  const canonical = createWorkflowChatDispatchPreparedReceipt(authority, {
    eventId: preparedEventId,
    eventSeq: Number(raw.preparedEventSeq),
    preparedAt: String(raw.preparedAt),
  });
  if (canonical.receiptDigest !== raw.receiptDigest) {
    throw new Error('workflow chat dispatch prepared receipt digest does not match its durable event evidence');
  }
  return canonical;
}

function samePreparedReceipt(
  left: WorkflowChatDispatchPreparedReceipt,
  right: WorkflowChatDispatchPreparedReceipt,
): boolean {
  return left.sourceGroupId === right.sourceGroupId
    && left.observerId === right.observerId
    && left.originSessionId === right.originSessionId
    && left.sourceUserSeq === right.sourceUserSeq
    && left.runId === right.runId
    && left.queueRequestDigest === right.queueRequestDigest
    && left.replyTargetDigest === right.replyTargetDigest
    && sameExactOriginDeliveryTarget(left.replyTarget, right.replyTarget)
    && left.preparationDigest === right.preparationDigest
    && left.preparedEventId === right.preparedEventId
    && left.preparedEventSeq === right.preparedEventSeq
    && left.preparedAt === right.preparedAt
    && left.receiptDigest === right.receiptDigest;
}

function samePreparationAuthority(
  left: WorkflowChatDispatchPreparationAuthority,
  right: WorkflowChatDispatchPreparationAuthority,
): boolean {
  return left.sourceGroupId === right.sourceGroupId
    && left.observerId === right.observerId
    && left.originSessionId === right.originSessionId
    && left.sourceUserSeq === right.sourceUserSeq
    && left.runId === right.runId
    && left.queueRequestDigest === right.queueRequestDigest
    && left.replyTargetDigest === right.replyTargetDigest
    && sameExactOriginDeliveryTarget(left.replyTarget, right.replyTarget)
    && left.preparationDigest === right.preparationDigest;
}

function admissionFile(sourceGroupId: string, queueRequestDigest: string): string {
  if (!isDigest(queueRequestDigest)) {
    throw new Error('workflow chat dispatch admission request digest is invalid');
  }
  return path.join(groupAdmissionsDir(sourceGroupId), `${queueRequestDigest}.json`);
}

/** Read the create-only pre-callback queue ownership for one source group.
 * Unknown names and malformed records are corruption, not permission to close
 * or reap around evidence that may still own a canonical run. */
export function readWorkflowChatDispatchAdmissions(
  sourceGroupId: string,
): WorkflowChatDispatchAdmission[] {
  const id = nonEmptyString(sourceGroupId);
  if (!id) throw new Error('workflow origin group id is required for admission lookup');
  const dir = groupAdmissionsDir(id);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).sort();
  if (entries.some((entry) => !/^[a-f0-9]{64}\.json$/.test(entry))) {
    throw new Error(`Workflow origin group ${id} admission index contains unknown evidence.`);
  }
  return entries.map((entry) => {
    const admission = decodePreparationAuthority(
      readJson(path.join(dir, entry), `Workflow origin group ${id} admission`),
    );
    if (
      admission.sourceGroupId !== id
      || entry !== `${admission.queueRequestDigest}.json`
    ) {
      throw new Error(`Workflow origin group ${id} has a mismatched admission index.`);
    }
    return admission;
  });
}

interface LegacyInlineWorkflowChatDispatchAdmission {
  runId: string;
  queueRequestDigest: string;
}

/** Compatibility authority for bytes created before the create-only admission
 * index. Only records that explicitly name this group participate. */
function readLegacyInlineWorkflowChatDispatchAdmissions(
  sourceGroupId: string,
): LegacyInlineWorkflowChatDispatchAdmission[] {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  const admissions: LegacyInlineWorkflowChatDispatchAdmission[] = [];
  for (const entry of readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json')).sort()) {
    let value: unknown;
    try {
      value = readJson(path.join(WORKFLOW_RUNS_DIR, entry), `Workflow run ${entry}`);
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const raw = value as Record<string, unknown>;
    if (raw.chatDispatchSourceGroupId !== sourceGroupId) continue;
    const runId = validRunId(raw.id);
    if (
      !runId
      || entry !== `${runId}.json`
      || !isDigest(raw.chatDispatchQueueRequestDigest)
    ) {
      throw new Error(`Workflow origin group ${sourceGroupId} has invalid inline admission authority.`);
    }
    admissions.push({
      runId,
      queueRequestDigest: raw.chatDispatchQueueRequestDigest,
    });
  }
  return admissions;
}

function preparedReceiptFile(dir: string, receiptDigest: string): string {
  if (!isDigest(receiptDigest)) throw new Error('workflow preparation receipt digest is invalid');
  return path.join(dir, `${receiptDigest}.json`);
}

function installPreparedReceipt(file: string, receipt: WorkflowChatDispatchPreparedReceipt): void {
  if (createJsonDurably(file, receipt)) return;
  const winner = decodeWorkflowChatDispatchPreparedReceipt(
    readJson(file, `Workflow chat dispatch preparation ${receipt.receiptDigest}`),
  );
  if (!samePreparedReceipt(winner, receipt)) {
    throw new Error('workflow chat dispatch preparation has a conflicting durable winner');
  }
}

export function readIndexedWorkflowChatDispatchPreparations(
  sourceGroupId: string,
): WorkflowChatDispatchPreparedReceipt[] {
  const id = nonEmptyString(sourceGroupId);
  if (!id) throw new Error('workflow origin group id is required');
  const dir = groupPreparedDir(id);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).sort();
  if (entries.some((entry) => !/^[a-f0-9]{64}\.json$/.test(entry))) {
    throw new Error(`Workflow origin group ${id} prepared index contains unknown evidence.`);
  }
  const receipts: WorkflowChatDispatchPreparedReceipt[] = [];
  for (const file of entries) {
    const receipt = decodeWorkflowChatDispatchPreparedReceipt(
      readJson(path.join(dir, file), `Workflow origin group ${id} preparation`),
    );
    if (receipt.sourceGroupId !== id || file !== `${receipt.receiptDigest}.json`) {
      throw new Error(`Workflow origin group ${id} has a mismatched prepared receipt index.`);
    }
    receipts.push(receipt);
  }
  return receipts.sort((left, right) => left.preparedEventSeq - right.preparedEventSeq
    || left.preparedEventId.localeCompare(right.preparedEventId));
}

/** One durable authority serializes source-group admission with membership
 * close. Queue callers acquire a run lock first; close/recovery callers hold
 * only this group lock and must release it before activation touches runs. */
export function withWorkflowOriginGroupAuthorityLock<T>(
  sourceGroupId: string,
  work: () => T,
): T {
  const id = nonEmptyString(sourceGroupId);
  if (!id) throw new Error('workflow origin group id is required for authority locking');
  return withWorkflowRunRecordLock(groupAuthorityLockFile(id), work);
}

function preparedReceiptForMember(
  sourceGroupId: string,
  member: WorkflowOriginGroupMember,
): WorkflowChatDispatchPreparedReceipt {
  const closed = readWorkflowOriginGroupClosedBatch(sourceGroupId);
  const prepared = (closed?.preparedReceipts ?? readIndexedWorkflowChatDispatchPreparations(sourceGroupId))
    .find((candidate) => candidate.receiptDigest === member.receiptDigest);
  if (
    !prepared
    || prepared.runId !== member.runId
    || prepared.queueRequestDigest !== member.queueRequestDigest
  ) {
    throw new Error(`Workflow origin group ${sourceGroupId} lost a member's durable preparation.`);
  }
  return prepared;
}

/** Resolve every durable generation of queue admission, including legacy
 * inline pre-pin records. Closed membership wins, then the close fence, then
 * open staging/preparation evidence. Conflicting owners fail closed. */
export function workflowOriginGroupAdmissionForRequest(
  sourceGroupId: string,
  queueRequestDigest: string,
  replyTarget: ExactOriginDeliveryTarget,
): WorkflowChatDispatchAdmissionLookup | null {
  const id = nonEmptyString(sourceGroupId);
  const target = normalizeExactOriginDeliveryTarget(replyTarget);
  if (!id || !isDigest(queueRequestDigest) || !target) {
    throw new Error('workflow origin group admission lookup requires source, request, and reply target');
  }
  return withWorkflowOriginGroupAuthorityLock(id, () => {
    const sealed = readWorkflowOriginGroup(id);
    const closed = sealed ? null : readWorkflowOriginGroupClosedBatch(id);
    const immutable = sealed ?? closed?.receipt;
    if (immutable) {
      if (!sameExactOriginDeliveryTarget(immutable.replyTarget, target)) {
        throw new Error('workflow origin group is closed to a different immutable reply target');
      }
      const member = immutable.members.find(
        (candidate) => candidate.queueRequestDigest === queueRequestDigest,
      );
      if (!member) {
        throw new Error('workflow origin group membership is already closed and cannot be widened');
      }
      return {
        runId: member.runId,
        queueRequestDigest,
        preparedReceipt: preparedReceiptForMember(id, member),
        phase: 'closed',
      };
    }

    const closing = readWorkflowOriginGroupCloseIntent(id);
    if (closing) {
      if (!sameExactOriginDeliveryTarget(closing.replyTarget, target)) {
        throw new Error('workflow origin group is closing to a different immutable reply target');
      }
      const member = closing.members.find(
        (candidate) => candidate.queueRequestDigest === queueRequestDigest,
      );
      if (!member) {
        throw new Error('workflow origin group membership is already closing and cannot be widened');
      }
      return {
        runId: member.runId,
        queueRequestDigest,
        preparedReceipt: preparedReceiptForMember(id, member),
        phase: 'closing',
      };
    }

    const admissions = readWorkflowChatDispatchAdmissions(id);
    const prepared = readIndexedWorkflowChatDispatchPreparations(id);
    for (const authority of [...admissions, ...prepared]) {
      if (!sameExactOriginDeliveryTarget(authority.replyTarget, target)) {
        throw new Error('workflow origin group has a different immutable reply target');
      }
    }
    const ownerRunIds = new Set<string>();
    for (const authority of admissions) {
      if (authority.queueRequestDigest === queueRequestDigest) ownerRunIds.add(authority.runId);
    }
    for (const receipt of prepared) {
      if (receipt.queueRequestDigest === queueRequestDigest) ownerRunIds.add(receipt.runId);
    }
    // The global legacy scan is only needed when the indexed protocol has no
    // owner. New/retried admissions stay O(group evidence), while old
    // callback-crash bytes remain recoverable.
    if (ownerRunIds.size === 0) {
      for (const authority of readLegacyInlineWorkflowChatDispatchAdmissions(id)) {
        if (authority.queueRequestDigest === queueRequestDigest) ownerRunIds.add(authority.runId);
      }
    }
    if (ownerRunIds.size > 1) {
      throw new Error('workflow origin group request digest is bound to conflicting admitted runs');
    }
    const runId = [...ownerRunIds][0];
    if (!runId) return null;
    const receipts = prepared.filter(
      (candidate) => candidate.runId === runId
        && candidate.queueRequestDigest === queueRequestDigest,
    );
    if (
      receipts.length > 1
      && receipts.some((candidate) => !samePreparedReceipt(candidate, receipts[0]))
    ) {
      throw new Error('workflow origin group request has conflicting prepared receipts');
    }
    return {
      runId,
      queueRequestDigest,
      ...(receipts[0] ? { preparedReceipt: receipts[0] } : {}),
      phase: receipts[0] ? 'prepared' : 'admitted',
    };
  });
}

/** Install the canonical source/request→run binding before invoking any
 * external preparation callback. Failure after this point is recovered by
 * retrying the same run, never by allocating a sibling. */
export function recordWorkflowChatDispatchAdmission(
  authorityInput: WorkflowChatDispatchPreparationAuthority,
): WorkflowChatDispatchAdmission {
  const authority = decodePreparationAuthority(authorityInput);
  return withWorkflowRunRecordLock(runFile(authority.runId), () => (
    withWorkflowOriginGroupAuthorityLock(authority.sourceGroupId, () => {
      const runRecordFile = runFile(authority.runId);
      if (!existsSync(runRecordFile)) {
        throw new Error(`Workflow run ${authority.runId} disappeared before chat-dispatch admission.`);
      }
      const rawRun = readJson(runRecordFile, `Workflow run ${authority.runId}`);
      if (!rawRun || typeof rawRun !== 'object' || Array.isArray(rawRun)
        || (rawRun as Record<string, unknown>).id !== authority.runId) {
        throw new Error(`Workflow run ${authority.runId} changed identity before chat-dispatch admission.`);
      }
      const existing = workflowOriginGroupAdmissionForRequest(
        authority.sourceGroupId,
        authority.queueRequestDigest,
        authority.replyTarget,
      );
      if (existing) {
        if (existing.runId !== authority.runId) {
          throw new Error('workflow chat dispatch admission has a different canonical run owner');
        }
        const staged = readWorkflowChatDispatchAdmissions(authority.sourceGroupId)
          .find((candidate) => candidate.queueRequestDigest === authority.queueRequestDigest);
        if (staged && !samePreparationAuthority(staged, authority)) {
          throw new Error('workflow chat dispatch admission has conflicting canonical authority');
        }
        if (staged) return staged;
        // A close fence is already the stronger immutable owner. Open
        // inline-only compatibility evidence is deliberately promoted below
        // so all new retries gain the dedicated staging + reaper protocol.
        if (existing.phase === 'closing' || existing.phase === 'closed') return authority;
      }
      const file = admissionFile(authority.sourceGroupId, authority.queueRequestDigest);
      if (createJsonDurably(file, authority)) return authority;
      const winner = decodePreparationAuthority(
        readJson(file, `Workflow origin group ${authority.sourceGroupId} admission`),
      );
      if (!samePreparationAuthority(winner, authority)) {
        throw new Error('workflow chat dispatch admission has a conflicting durable winner');
      }
      return winner;
    })
  ));
}

/** Queue-side durable index and retention pin. This runs only after the trusted
 * event callback returned a verified receipt. The earlier admission record
 * remains the recovery/retention owner if the callback fails. */
export function recordWorkflowChatDispatchPreparation(
  receiptInput: WorkflowChatDispatchPreparedReceipt,
): WorkflowChatDispatchPreparedReceipt {
  const receipt = decodeWorkflowChatDispatchPreparedReceipt(receiptInput);
  // Keep the run→group lock order shared with queue admission and settled-pin
  // cleanup. That makes the event receipt + pin/index publication linearizable
  // against retention even when this primitive is called outside the queue.
  return withWorkflowRunRecordLock(runFile(receipt.runId), () => (
    withWorkflowRunRecordLock(groupAuthorityLockFile(receipt.sourceGroupId), () => {
      const tombstone = readWorkflowOriginGroupTombstone(receipt.sourceGroupId);
      if (tombstone) {
        const admitted = preparedReceiptsFromTombstone(tombstone).find(
          (candidate) => candidate.receiptDigest === receipt.receiptDigest,
        );
        if (!admitted || !samePreparedReceipt(admitted, receipt)) {
          throw new Error('workflow origin group tombstone cannot admit a later preparation');
        }
        return admitted;
      }
      const closed = readWorkflowOriginGroupClosedBatch(receipt.sourceGroupId);
      if (closed) {
        const admitted = closed.preparedReceipts.find(
          (candidate) => candidate.receiptDigest === receipt.receiptDigest,
        );
        if (!admitted || !samePreparedReceipt(admitted, receipt)) {
          throw new Error('workflow origin group batch is closed and cannot admit a later preparation');
        }
      }
      const closing = readWorkflowOriginGroupCloseIntent(receipt.sourceGroupId);
      if (closing) {
        const member = closing.members.find(
          (candidate) => candidate.receiptDigest === receipt.receiptDigest,
        );
        if (
          !member
          || member.runId !== receipt.runId
          || member.queueRequestDigest !== receipt.queueRequestDigest
        ) {
          throw new Error('workflow origin group is closing and cannot admit a later preparation');
        }
      }
      // Pin first: a process crash may omit the group index until replay, but a
      // terminal duplicate cannot be reaped in that recovery window.
      installPreparedReceipt(
        preparedReceiptFile(runPreparationPinDir(receipt.runId), receipt.receiptDigest),
        receipt,
      );
      installPreparedReceipt(
        preparedReceiptFile(groupPreparedDir(receipt.sourceGroupId), receipt.receiptDigest),
        receipt,
      );
      return receipt;
    })
  ));
}

function sourceGroupDigest(input: {
  sourceGroupId: string;
  observerId: string;
  originSessionId: string;
  sourceUserSeq: number;
  replyTargetDigest: string;
  members: readonly WorkflowOriginGroupMember[];
}): string {
  return hash([
    'clementine-workflow-origin-group-seal:v1',
    input.sourceGroupId,
    input.observerId,
    input.originSessionId,
    input.sourceUserSeq,
    input.replyTargetDigest,
    ...input.members.flatMap((member) => [
      member.runId,
      member.queueRequestDigest,
      member.preparationDigest,
      member.preparedEventId,
      member.preparedEventSeq,
      member.preparedAt,
      member.receiptDigest,
    ]),
  ]);
}

function sameMember(left: WorkflowOriginGroupMember, right: WorkflowOriginGroupMember): boolean {
  return left.runId === right.runId
    && left.queueRequestDigest === right.queueRequestDigest
    && left.preparationDigest === right.preparationDigest
    && left.preparedEventId === right.preparedEventId
    && left.preparedEventSeq === right.preparedEventSeq
    && left.preparedAt === right.preparedAt
    && left.receiptDigest === right.receiptDigest;
}

interface NormalizedPreparedGroup {
  receipts: WorkflowChatDispatchPreparedReceipt[];
  first: WorkflowChatDispatchPreparedReceipt;
  members: WorkflowOriginGroupMember[];
}

function normalizePreparedGroup(
  preparedReceipts: readonly WorkflowChatDispatchPreparedReceipt[],
): NormalizedPreparedGroup {
  if (preparedReceipts.length === 0) throw new Error('cannot close an empty workflow origin group');
  const receipts = preparedReceipts.map(decodeWorkflowChatDispatchPreparedReceipt);
  const first = receipts[0];
  for (const receipt of receipts) {
    if (
      receipt.sourceGroupId !== first.sourceGroupId
      || receipt.observerId !== first.observerId
      || receipt.originSessionId !== first.originSessionId
      || receipt.sourceUserSeq !== first.sourceUserSeq
      || receipt.replyTargetDigest !== first.replyTargetDigest
      || !sameExactOriginDeliveryTarget(receipt.replyTarget, first.replyTarget)
    ) {
      throw new Error('workflow origin group receipts disagree on source or immutable reply target');
    }
  }
  const members: WorkflowOriginGroupMember[] = [];
  const byRun = new Map<string, WorkflowOriginGroupMember>();
  const byRequest = new Map<string, string>();
  for (const receipt of receipts) {
    const member: WorkflowOriginGroupMember = {
      runId: receipt.runId,
      queueRequestDigest: receipt.queueRequestDigest,
      preparationDigest: receipt.preparationDigest,
      preparedEventId: receipt.preparedEventId,
      preparedEventSeq: receipt.preparedEventSeq,
      preparedAt: receipt.preparedAt,
      receiptDigest: receipt.receiptDigest,
    };
    const requestOwner = byRequest.get(member.queueRequestDigest);
    if (requestOwner && requestOwner !== member.runId) {
      throw new Error('workflow origin group request digest is bound to conflicting runs');
    }
    byRequest.set(member.queueRequestDigest, member.runId);
    const existing = byRun.get(member.runId);
    if (existing) {
      if (!sameMember(existing, member)) {
        throw new Error('workflow origin group contains conflicting receipts for one run');
      }
      continue;
    }
    byRun.set(member.runId, member);
    members.push(member);
  }
  return { receipts, first, members };
}

function decodeGroupMembers(
  value: unknown,
  observer: WorkflowRunOriginObserver,
): WorkflowOriginGroupMember[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('workflow origin group has no valid members');
  }
  const members: WorkflowOriginGroupMember[] = [];
  const runIds = new Set<string>();
  const requestDigests = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('workflow origin group has an invalid member');
    }
    const member = item as Record<string, unknown>;
    const runId = validRunId(member.runId);
    if (
      !runId
      || !isDigest(member.queueRequestDigest)
      || !isDigest(member.preparationDigest)
      || !nonEmptyString(member.preparedEventId)
      || !Number.isSafeInteger(member.preparedEventSeq)
      || Number(member.preparedEventSeq) <= 0
      || !isIsoTimestamp(member.preparedAt)
      || !isDigest(member.receiptDigest)
      || runIds.has(runId)
      || requestDigests.has(member.queueRequestDigest)
    ) {
      throw new Error('workflow origin group has conflicting or invalid membership');
    }
    runIds.add(runId);
    requestDigests.add(member.queueRequestDigest);
    const decoded: WorkflowOriginGroupMember = {
      runId,
      queueRequestDigest: member.queueRequestDigest,
      preparationDigest: member.preparationDigest,
      preparedEventId: String(member.preparedEventId),
      preparedEventSeq: Number(member.preparedEventSeq),
      preparedAt: String(member.preparedAt),
      receiptDigest: member.receiptDigest,
    };
    const authority = createWorkflowChatDispatchPreparationAuthority({
      runId: decoded.runId,
      observer,
      queueRequestDigest: decoded.queueRequestDigest,
    });
    if (authority.preparationDigest !== decoded.preparationDigest) {
      throw new Error('workflow origin group member preparation digest does not match its source authority');
    }
    const receipt = createWorkflowChatDispatchPreparedReceipt(authority, {
      eventId: decoded.preparedEventId,
      eventSeq: decoded.preparedEventSeq,
      preparedAt: decoded.preparedAt,
    });
    if (receipt.receiptDigest !== decoded.receiptDigest) {
      throw new Error('workflow origin group member receipt digest does not match its event evidence');
    }
    members.push(decoded);
  }
  return members;
}

function workflowOriginGroupCloseDigest(input: {
  sourceGroupId: string;
  observerId: string;
  originSessionId: string;
  sourceUserSeq: number;
  replyTargetDigest: string;
  members: readonly WorkflowOriginGroupMember[];
}): string {
  return hash([
    'clementine-workflow-origin-group-close:v1',
    input.sourceGroupId,
    input.observerId,
    input.originSessionId,
    input.sourceUserSeq,
    input.replyTargetDigest,
    ...input.members.flatMap((member) => [
      member.runId,
      member.preparedEventId,
      member.receiptDigest,
    ]),
  ]);
}

export function createWorkflowOriginGroupCloseAuthority(
  preparedReceipts: readonly WorkflowChatDispatchPreparedReceipt[],
): WorkflowOriginGroupCloseAuthority {
  const { first, members } = normalizePreparedGroup(preparedReceipts);
  return {
    version: ORIGIN_GROUP_VERSION,
    sourceGroupId: first.sourceGroupId,
    observerId: first.observerId,
    originSessionId: first.originSessionId,
    sourceUserSeq: first.sourceUserSeq,
    replyTarget: first.replyTarget,
    replyTargetDigest: first.replyTargetDigest,
    members,
    closeDigest: workflowOriginGroupCloseDigest({
      sourceGroupId: first.sourceGroupId,
      observerId: first.observerId,
      originSessionId: first.originSessionId,
      sourceUserSeq: first.sourceUserSeq,
      replyTargetDigest: first.replyTargetDigest,
      members,
    }),
  };
}

function decodeWorkflowOriginGroupCloseAuthority(value: unknown): WorkflowOriginGroupCloseAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow origin group close authority is invalid');
  }
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.sourceUserSeq) || Number(raw.sourceUserSeq) <= 0) {
    throw new Error('workflow origin group close authority is invalid');
  }
  const observer = normalizeWorkflowRunOriginObserver({
    sessionId: String(raw.originSessionId ?? ''),
    sourceUserSeq: raw.sourceUserSeq as number,
    replyTarget: raw.replyTarget as ExactOriginDeliveryTarget,
  });
  if (
    raw.version !== ORIGIN_GROUP_VERSION
    || !observer
    || raw.sourceGroupId !== workflowOriginSourceGroupId(observer)
    || raw.observerId !== workflowRunOriginObserverId(observer)
    || raw.replyTargetDigest !== exactOriginDeliveryTargetDigest(observer.replyTarget)
    || !isDigest(raw.closeDigest)
  ) {
    throw new Error('workflow origin group close authority is invalid');
  }
  const members = decodeGroupMembers(raw.members, observer);
  const expected = workflowOriginGroupCloseDigest({
    sourceGroupId: String(raw.sourceGroupId),
    observerId: String(raw.observerId),
    originSessionId: observer.sessionId,
    sourceUserSeq: observer.sourceUserSeq,
    replyTargetDigest: String(raw.replyTargetDigest),
    members,
  });
  if (raw.closeDigest !== expected) {
    throw new Error('workflow origin group close digest does not match its ordered membership');
  }
  return {
    version: ORIGIN_GROUP_VERSION,
    sourceGroupId: String(raw.sourceGroupId),
    observerId: String(raw.observerId),
    originSessionId: observer.sessionId,
    sourceUserSeq: observer.sourceUserSeq,
    replyTarget: observer.replyTarget,
    replyTargetDigest: String(raw.replyTargetDigest),
    members,
    closeDigest: expected,
  };
}

export function createWorkflowOriginGroupClosedBatchReceipt(
  authorityInput: WorkflowOriginGroupCloseAuthority,
  evidence: { eventId: string; eventSeq: number; closedAt: string },
): WorkflowOriginGroupClosedBatchReceipt {
  const authority = decodeWorkflowOriginGroupCloseAuthority(authorityInput);
  const closedEventId = nonEmptyString(evidence.eventId);
  if (!closedEventId || !Number.isSafeInteger(evidence.eventSeq) || evidence.eventSeq <= 0 || !isIsoTimestamp(evidence.closedAt)) {
    throw new Error('workflow origin group close receipt requires durable event identity evidence');
  }
  const closeReceiptDigest = hash([
    'clementine-workflow-origin-group-close-receipt:v1',
    authority.closeDigest,
    closedEventId,
    evidence.eventSeq,
    evidence.closedAt,
  ]);
  return {
    ...authority,
    receiptVersion: ORIGIN_GROUP_VERSION,
    closedEventId,
    closedEventSeq: evidence.eventSeq,
    closedAt: evidence.closedAt,
    closeReceiptDigest,
  };
}

function decodeWorkflowOriginGroupClosedBatchReceipt(
  value: unknown,
): WorkflowOriginGroupClosedBatchReceipt {
  const authority = decodeWorkflowOriginGroupCloseAuthority(value);
  const raw = value as Record<string, unknown>;
  const closedEventId = nonEmptyString(raw.closedEventId);
  if (
    raw.receiptVersion !== ORIGIN_GROUP_VERSION
    || !closedEventId
    || !Number.isSafeInteger(raw.closedEventSeq)
    || Number(raw.closedEventSeq) <= 0
    || !isIsoTimestamp(raw.closedAt)
    || !isDigest(raw.closeReceiptDigest)
  ) {
    throw new Error('workflow origin group closed-batch receipt is invalid');
  }
  const canonical = createWorkflowOriginGroupClosedBatchReceipt(authority, {
    eventId: closedEventId,
    eventSeq: Number(raw.closedEventSeq),
    closedAt: String(raw.closedAt),
  });
  if (raw.closeReceiptDigest !== canonical.closeReceiptDigest) {
    throw new Error('workflow origin group close receipt digest does not match its event evidence');
  }
  return canonical;
}

function sameCloseReceipt(
  left: WorkflowOriginGroupClosedBatchReceipt,
  right: WorkflowOriginGroupClosedBatchReceipt,
): boolean {
  return left.sourceGroupId === right.sourceGroupId
    && left.observerId === right.observerId
    && left.originSessionId === right.originSessionId
    && left.sourceUserSeq === right.sourceUserSeq
    && left.replyTargetDigest === right.replyTargetDigest
    && sameExactOriginDeliveryTarget(left.replyTarget, right.replyTarget)
    && left.closeDigest === right.closeDigest
    && left.members.length === right.members.length
    && left.members.every((member, index) => sameMember(member, right.members[index]))
    && left.closedEventId === right.closedEventId
    && left.closedEventSeq === right.closedEventSeq
    && left.closedAt === right.closedAt
    && left.closeReceiptDigest === right.closeReceiptDigest;
}

function sameCloseAuthority(
  left: WorkflowOriginGroupCloseAuthority,
  right: WorkflowOriginGroupCloseAuthority,
): boolean {
  return left.sourceGroupId === right.sourceGroupId
    && left.observerId === right.observerId
    && left.originSessionId === right.originSessionId
    && left.sourceUserSeq === right.sourceUserSeq
    && left.replyTargetDigest === right.replyTargetDigest
    && sameExactOriginDeliveryTarget(left.replyTarget, right.replyTarget)
    && left.closeDigest === right.closeDigest
    && left.members.length === right.members.length
    && left.members.every((member, index) => sameMember(member, right.members[index]));
}

function validateCloseAgainstAdmissionEvidence(
  authority: WorkflowOriginGroupCloseAuthority,
): WorkflowChatDispatchPreparedReceipt[] {
  const indexed = readIndexedWorkflowChatDispatchPreparations(authority.sourceGroupId);
  const indexedGroup = normalizePreparedGroup(indexed);
  if (
    indexedGroup.members.length !== authority.members.length
    || !indexedGroup.members.every((member, index) => sameMember(member, authority.members[index]))
  ) {
    throw new Error('workflow origin group cannot close until its complete ordered preparation index matches');
  }
  const memberByRequest = new Map(
    authority.members.map((member) => [member.queueRequestDigest, member]),
  );
  for (const admission of readWorkflowChatDispatchAdmissions(authority.sourceGroupId)) {
    const member = memberByRequest.get(admission.queueRequestDigest);
    if (
      !member
      || member.runId !== admission.runId
      || member.preparationDigest !== admission.preparationDigest
      || admission.observerId !== authority.observerId
      || admission.replyTargetDigest !== authority.replyTargetDigest
      || !sameExactOriginDeliveryTarget(admission.replyTarget, authority.replyTarget)
    ) {
      throw new Error('workflow origin group close excludes or conflicts with a staged admission');
    }
    const prepared = indexed.find(
      (candidate) => candidate.receiptDigest === member.receiptDigest,
    );
    if (!prepared || prepared.runId !== admission.runId) {
      throw new Error('workflow origin group cannot close while an admission lacks exact preparation evidence');
    }
  }
  for (const admission of readLegacyInlineWorkflowChatDispatchAdmissions(authority.sourceGroupId)) {
    const member = memberByRequest.get(admission.queueRequestDigest);
    if (!member || member.runId !== admission.runId) {
      throw new Error('workflow origin group close excludes or conflicts with inline admission authority');
    }
  }
  return authority.members.map((member) => {
    const prepared = indexed.find((candidate) => candidate.receiptDigest === member.receiptDigest);
    if (!prepared) throw new Error('workflow origin group close lost an indexed preparation');
    return prepared;
  });
}

function validateCompactedAdmissionEvidence(
  tombstone: WorkflowOriginGroupTombstone,
): void {
  const authority = decodeWorkflowOriginGroupCloseAuthority(closeReceiptFromTombstone(tombstone));
  const memberByRequest = new Map(
    authority.members.map((member) => [member.queueRequestDigest, member]),
  );
  for (const admission of readWorkflowChatDispatchAdmissions(authority.sourceGroupId)) {
    const member = memberByRequest.get(admission.queueRequestDigest);
    if (
      !member
      || member.runId !== admission.runId
      || member.preparationDigest !== admission.preparationDigest
      || admission.observerId !== authority.observerId
      || admission.replyTargetDigest !== authority.replyTargetDigest
      || !sameExactOriginDeliveryTarget(admission.replyTarget, authority.replyTarget)
    ) {
      throw new Error('workflow origin group tombstone cannot erase conflicting admission evidence');
    }
  }
  for (const admission of readLegacyInlineWorkflowChatDispatchAdmissions(authority.sourceGroupId)) {
    const member = memberByRequest.get(admission.queueRequestDigest);
    if (!member || member.runId !== admission.runId) {
      throw new Error('workflow origin group tombstone conflicts with inline admission authority');
    }
  }
}

/** Read the durable membership fence installed before the event-ledger close
 * append. A direct fence may coexist with later closed/tombstone projections,
 * but its canonical bytes must continue to agree. */
export function readWorkflowOriginGroupCloseIntent(
  sourceGroupId: string,
): WorkflowOriginGroupCloseAuthority | null {
  const id = nonEmptyString(sourceGroupId);
  if (!id) throw new Error('workflow origin group id is required for close-intent lookup');
  const file = closingGroupFile(id);
  if (!existsSync(file)) return null;
  const intent = decodeWorkflowOriginGroupCloseAuthority(
    readJson(file, `Workflow origin group ${id} close intent`),
  );
  if (intent.sourceGroupId !== id) {
    throw new Error(`Workflow origin group ${id} close intent has a mismatched identity.`);
  }
  const tombstone = readWorkflowOriginGroupTombstone(id);
  if (tombstone) {
    const compacted = decodeWorkflowOriginGroupCloseAuthority(closeReceiptFromTombstone(tombstone));
    if (!sameCloseAuthority(intent, compacted)) {
      throw new Error(`Workflow origin group ${id} has conflicting close-intent and compacted authority.`);
    }
  }
  return intent;
}

/** Bounded restart driver input for the crash seam where the filesystem fence
 * won but the SQLite close event did not. */
export function listWorkflowOriginGroupCloseIntents(
  limit = 200,
): WorkflowOriginGroupCloseAuthority[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('workflow origin group close-intent limit must be positive');
  }
  if (!existsSync(WORKFLOW_ORIGIN_GROUPS_DIR)) return [];
  const intents: WorkflowOriginGroupCloseAuthority[] = [];
  for (const entry of readdirSync(WORKFLOW_ORIGIN_GROUPS_DIR).sort()) {
    if (intents.length >= limit) break;
    const file = path.join(WORKFLOW_ORIGIN_GROUPS_DIR, entry, 'closing.json');
    if (!existsSync(file)) continue;
    const intent = decodeWorkflowOriginGroupCloseAuthority(
      readJson(file, `Workflow origin group ${entry} close intent`),
    );
    if (groupDir(intent.sourceGroupId) !== path.dirname(file)) {
      throw new Error('workflow origin group close intent is stored under a mismatched group directory');
    }
    const tombstone = readWorkflowOriginGroupTombstone(intent.sourceGroupId);
    if (tombstone) {
      const compacted = decodeWorkflowOriginGroupCloseAuthority(closeReceiptFromTombstone(tombstone));
      if (!sameCloseAuthority(intent, compacted)) {
        throw new Error('workflow origin group close intent conflicts with its compacted authority');
      }
      continue;
    }
    const closedFile = closedGroupFile(intent.sourceGroupId);
    if (existsSync(closedFile)) {
      const closed = decodeDurableClosedBatch(
        readJson(closedFile, `Workflow origin group ${intent.sourceGroupId} closed batch`),
      );
      if (!sameCloseAuthority(intent, closed.receipt)) {
        throw new Error('workflow origin group close intent conflicts with its closed batch');
      }
      continue;
    }
    intents.push(intent);
  }
  return intents;
}

/** Install a create-only close fence after revalidating that every staged or
 * legacy inline owner has an exact prepared receipt inside the winning set. */
export function recordWorkflowOriginGroupCloseIntent(
  authorityInput: WorkflowOriginGroupCloseAuthority,
): WorkflowOriginGroupCloseAuthority {
  const authority = decodeWorkflowOriginGroupCloseAuthority(authorityInput);
  return withWorkflowOriginGroupAuthorityLock(authority.sourceGroupId, () => {
    const existingIntent = readWorkflowOriginGroupCloseIntent(authority.sourceGroupId);
    if (existingIntent && !sameCloseAuthority(existingIntent, authority)) {
      throw new Error('workflow origin group already has a conflicting immutable close intent');
    }
    const tombstone = readWorkflowOriginGroupTombstone(authority.sourceGroupId);
    if (tombstone) {
      const compacted = decodeWorkflowOriginGroupCloseAuthority(closeReceiptFromTombstone(tombstone));
      if (!sameCloseAuthority(compacted, authority)) {
        throw new Error('workflow origin group already has a conflicting compacted close authority');
      }
      return compacted;
    }
    const closedFile = closedGroupFile(authority.sourceGroupId);
    if (existsSync(closedFile)) {
      const closed = decodeDurableClosedBatch(
        readJson(closedFile, `Workflow origin group ${authority.sourceGroupId} closed batch`),
      );
      if (!sameCloseAuthority(closed.receipt, authority)) {
        throw new Error('workflow origin group already has a conflicting immutable closed batch');
      }
      return decodeWorkflowOriginGroupCloseAuthority(closed.receipt);
    }
    validateCloseAgainstAdmissionEvidence(authority);
    if (existingIntent) return existingIntent;
    const file = closingGroupFile(authority.sourceGroupId);
    if (createJsonDurably(file, authority)) return authority;
    const winner = decodeWorkflowOriginGroupCloseAuthority(
      readJson(file, `Workflow origin group ${authority.sourceGroupId} close intent`),
    );
    if (!sameCloseAuthority(winner, authority)) {
      throw new Error('workflow origin group already has a conflicting immutable close intent');
    }
    return winner;
  });
}

function decodeDurableClosedBatch(value: unknown): DurableWorkflowOriginGroupClosedBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('durable workflow origin group closed batch is invalid');
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== ORIGIN_GROUP_VERSION || !isIsoTimestamp(raw.recordedAt) || !Array.isArray(raw.preparedReceipts)) {
    throw new Error('durable workflow origin group closed batch is invalid');
  }
  const receipt = decodeWorkflowOriginGroupClosedBatchReceipt(raw.receipt);
  const normalized = normalizePreparedGroup(
    raw.preparedReceipts as WorkflowChatDispatchPreparedReceipt[],
  );
  if (
    normalized.first.sourceGroupId !== receipt.sourceGroupId
    || normalized.members.length !== receipt.members.length
    || !normalized.members.every((member, index) => sameMember(member, receipt.members[index]))
  ) {
    throw new Error('durable workflow origin group closed batch does not match its prepared receipts');
  }
  const preparedReceipts = receipt.members.map((member) => {
    const prepared = normalized.receipts.find((candidate) => candidate.receiptDigest === member.receiptDigest);
    if (!prepared) throw new Error('durable workflow origin group closed batch lost a prepared receipt');
    return prepared;
  });
  return {
    version: ORIGIN_GROUP_VERSION,
    receipt,
    preparedReceipts,
    recordedAt: String(raw.recordedAt),
  };
}

function sameDurableClosedBatch(
  left: DurableWorkflowOriginGroupClosedBatch,
  right: DurableWorkflowOriginGroupClosedBatch,
): boolean {
  return sameCloseReceipt(left.receipt, right.receipt)
    && left.preparedReceipts.length === right.preparedReceipts.length
    && left.preparedReceipts.every((prepared, index) => samePreparedReceipt(prepared, right.preparedReceipts[index]));
}

export function readWorkflowOriginGroupClosedBatch(
  sourceGroupId: string,
): DurableWorkflowOriginGroupClosedBatch | null {
  const id = nonEmptyString(sourceGroupId);
  if (!id) throw new Error('workflow origin group id is required');
  const file = closedGroupFile(id);
  const tombstone = readWorkflowOriginGroupTombstone(id);
  const compacted = tombstone
    ? decodeDurableClosedBatch({
        version: ORIGIN_GROUP_VERSION,
        receipt: closeReceiptFromTombstone(tombstone),
        preparedReceipts: preparedReceiptsFromTombstone(tombstone),
        recordedAt: tombstone.closedRecordedAt,
      })
    : null;
  if (!existsSync(file)) return compacted;
  const closed = decodeDurableClosedBatch(readJson(file, `Workflow origin group ${id} closed batch`));
  if (closed.receipt.sourceGroupId !== id) {
    throw new Error(`Workflow origin group ${id} closed batch has a mismatched identity.`);
  }
  if (compacted && !sameDurableClosedBatch(closed, compacted)) {
    throw new Error(`Workflow origin group ${id} has conflicting closed and compacted authority.`);
  }
  return closed;
}

export function recordWorkflowOriginGroupClosedBatch(input: {
  receipt: WorkflowOriginGroupClosedBatchReceipt;
  preparedReceipts: readonly WorkflowChatDispatchPreparedReceipt[];
}): DurableWorkflowOriginGroupClosedBatch {
  const receipt = decodeWorkflowOriginGroupClosedBatchReceipt(input.receipt);
  const supplied = normalizePreparedGroup(input.preparedReceipts);
  if (
    supplied.first.sourceGroupId !== receipt.sourceGroupId
    || supplied.members.length !== receipt.members.length
    || !supplied.members.every((member, index) => sameMember(member, receipt.members[index]))
  ) {
    throw new Error('workflow origin group close receipt does not match its supplied prepared receipts');
  }
  return withWorkflowRunRecordLock(groupAuthorityLockFile(receipt.sourceGroupId), () => {
    const intent = recordWorkflowOriginGroupCloseIntent(receipt);
    if (!sameCloseAuthority(intent, receipt)) {
      throw new Error('workflow origin group close receipt conflicts with its durable close intent');
    }
    const tombstone = readWorkflowOriginGroupTombstone(receipt.sourceGroupId);
    if (tombstone) {
      const compacted = readWorkflowOriginGroupClosedBatch(receipt.sourceGroupId);
      if (!compacted || !sameCloseReceipt(compacted.receipt, receipt)) {
        throw new Error('workflow origin group already has a conflicting immutable closed batch');
      }
      const compactedPrepared = compacted.preparedReceipts;
      if (
        compactedPrepared.length !== supplied.receipts.length
        || !compactedPrepared.every((prepared, index) => samePreparedReceipt(prepared, supplied.receipts[index]))
      ) {
        throw new Error('workflow origin group compacted batch rejects conflicting prepared receipts');
      }
      return compacted;
    }
    const preparedReceipts = validateCloseAgainstAdmissionEvidence(receipt);
    if (
      preparedReceipts.length !== supplied.receipts.length
      || !preparedReceipts.every((prepared, index) => samePreparedReceipt(prepared, supplied.receipts[index]))
    ) {
      throw new Error('workflow origin group close supplied receipts conflict with its durable preparation index');
    }
    const candidate: DurableWorkflowOriginGroupClosedBatch = {
      version: ORIGIN_GROUP_VERSION,
      receipt,
      preparedReceipts,
      recordedAt: new Date().toISOString(),
    };
    const file = closedGroupFile(receipt.sourceGroupId);
    if (createJsonDurably(file, candidate)) return candidate;
    const winner = decodeDurableClosedBatch(
      readJson(file, `Workflow origin group ${receipt.sourceGroupId} closed batch`),
    );
    if (!sameDurableClosedBatch(winner, candidate)) {
      throw new Error('workflow origin group already has a conflicting immutable closed batch');
    }
    return winner;
  });
}

function decodeSealedGroup(value: unknown): SealedWorkflowOriginGroup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow origin group seal is invalid');
  }
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.sourceUserSeq) || Number(raw.sourceUserSeq) <= 0) {
    throw new Error('workflow origin group seal is invalid');
  }
  const observer = normalizeWorkflowRunOriginObserver({
    sessionId: String(raw.originSessionId ?? ''),
    sourceUserSeq: raw.sourceUserSeq as number,
    replyTarget: raw.replyTarget as ExactOriginDeliveryTarget,
  });
  if (
    raw.version !== ORIGIN_GROUP_VERSION
    || !observer
    || raw.sourceGroupId !== workflowOriginSourceGroupId(observer)
    || raw.observerId !== workflowRunOriginObserverId(observer)
    || raw.replyTargetDigest !== exactOriginDeliveryTargetDigest(observer.replyTarget)
    || !Array.isArray(raw.members)
    || raw.members.length === 0
    || !isDigest(raw.sourceGroupDigest)
    || !isIsoTimestamp(raw.sealedAt)
  ) {
    throw new Error('workflow origin group seal is invalid');
  }
  const members: WorkflowOriginGroupMember[] = [];
  const runIds = new Set<string>();
  const requestDigests = new Set<string>();
  for (const value of raw.members) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('workflow origin group has an invalid member');
    }
    const member = value as Record<string, unknown>;
    const runId = validRunId(member.runId);
    if (
      !runId
      || !isDigest(member.queueRequestDigest)
      || !isDigest(member.preparationDigest)
      || !nonEmptyString(member.preparedEventId)
      || !Number.isSafeInteger(member.preparedEventSeq)
      || Number(member.preparedEventSeq) <= 0
      || !isIsoTimestamp(member.preparedAt)
      || !isDigest(member.receiptDigest)
      || runIds.has(runId)
      || requestDigests.has(member.queueRequestDigest)
    ) {
      throw new Error('workflow origin group has conflicting or invalid membership');
    }
    runIds.add(runId);
    requestDigests.add(member.queueRequestDigest);
    members.push({
      runId,
      queueRequestDigest: member.queueRequestDigest,
      preparationDigest: member.preparationDigest,
      preparedEventId: String(member.preparedEventId),
      preparedEventSeq: Number(member.preparedEventSeq),
      preparedAt: String(member.preparedAt),
      receiptDigest: member.receiptDigest,
    });
  }
  for (const member of members) {
    const authority = createWorkflowChatDispatchPreparationAuthority({
      runId: member.runId,
      observer,
      queueRequestDigest: member.queueRequestDigest,
    });
    if (authority.preparationDigest !== member.preparationDigest) {
      throw new Error('workflow origin group member preparation digest does not match its source authority');
    }
    const receipt = createWorkflowChatDispatchPreparedReceipt(authority, {
      eventId: member.preparedEventId,
      eventSeq: member.preparedEventSeq,
      preparedAt: member.preparedAt,
    });
    if (receipt.receiptDigest !== member.receiptDigest) {
      throw new Error('workflow origin group member receipt digest does not match its event evidence');
    }
  }
  const expectedDigest = sourceGroupDigest({
    sourceGroupId: String(raw.sourceGroupId),
    observerId: String(raw.observerId),
    originSessionId: observer.sessionId,
    sourceUserSeq: observer.sourceUserSeq,
    replyTargetDigest: String(raw.replyTargetDigest),
    members,
  });
  if (raw.sourceGroupDigest !== expectedDigest) {
    throw new Error('workflow origin group digest does not match its canonical membership');
  }
  return {
    version: ORIGIN_GROUP_VERSION,
    sourceGroupId: String(raw.sourceGroupId),
    sourceGroupDigest: expectedDigest,
    observerId: String(raw.observerId),
    originSessionId: observer.sessionId,
    sourceUserSeq: observer.sourceUserSeq,
    replyTarget: observer.replyTarget,
    replyTargetDigest: String(raw.replyTargetDigest),
    members,
    sealedAt: String(raw.sealedAt),
  };
}

function sameSealedGroup(left: SealedWorkflowOriginGroup, right: SealedWorkflowOriginGroup): boolean {
  return left.sourceGroupId === right.sourceGroupId
    && left.sourceGroupDigest === right.sourceGroupDigest
    && left.observerId === right.observerId
    && left.originSessionId === right.originSessionId
    && left.sourceUserSeq === right.sourceUserSeq
    && left.replyTargetDigest === right.replyTargetDigest
    && sameExactOriginDeliveryTarget(left.replyTarget, right.replyTarget)
    && left.members.length === right.members.length
    && left.members.every((member, index) => sameMember(member, right.members[index]));
}

/** Freeze the complete ordered run set for one source. Duplicate receipts for
 * the same run are collapsed only when every canonical byte agrees. */
export function sealWorkflowOriginGroup(
  preparedReceipts: readonly WorkflowChatDispatchPreparedReceipt[],
): SealedWorkflowOriginGroup {
  const { first, members } = normalizePreparedGroup(preparedReceipts);
  const tombstone = readWorkflowOriginGroupTombstone(first.sourceGroupId);
  if (tombstone) {
    const sealed = sealedFromTombstone(tombstone);
    if (
      sealed.members.length !== members.length
      || !sealed.members.every((member, index) => sameMember(member, members[index]))
    ) {
      throw new Error('workflow origin group tombstone rejects a conflicting seal');
    }
    return sealed;
  }
  const closed = readWorkflowOriginGroupClosedBatch(first.sourceGroupId);
  if (
    !closed
    || closed.receipt.members.length !== members.length
    || !closed.receipt.members.every((member, index) => sameMember(member, members[index]))
  ) {
    throw new Error('workflow origin group must have a matching durable closed-batch receipt before sealing');
  }
  const sealedAt = new Date().toISOString();
  const sourceGroupDigestValue = sourceGroupDigest({
    sourceGroupId: first.sourceGroupId,
    observerId: first.observerId,
    originSessionId: first.originSessionId,
    sourceUserSeq: first.sourceUserSeq,
    replyTargetDigest: first.replyTargetDigest,
    members,
  });
  const candidate: SealedWorkflowOriginGroup = {
    version: ORIGIN_GROUP_VERSION,
    sourceGroupId: first.sourceGroupId,
    sourceGroupDigest: sourceGroupDigestValue,
    observerId: first.observerId,
    originSessionId: first.originSessionId,
    sourceUserSeq: first.sourceUserSeq,
    replyTarget: first.replyTarget,
    replyTargetDigest: first.replyTargetDigest,
    members,
    sealedAt,
  };
  const file = sealedGroupFile(candidate.sourceGroupId);
  if (createJsonDurably(file, candidate)) return candidate;
  const winner = decodeSealedGroup(readJson(file, `Workflow origin group ${candidate.sourceGroupId}`));
  if (!sameSealedGroup(winner, candidate)) {
    throw new Error('workflow origin group already has a conflicting immutable seal');
  }
  return winner;
}

export function readWorkflowOriginGroup(sourceGroupId: string): SealedWorkflowOriginGroup | null {
  const id = nonEmptyString(sourceGroupId);
  if (!id) throw new Error('workflow origin group id is required');
  const file = sealedGroupFile(id);
  const tombstone = readWorkflowOriginGroupTombstone(id);
  const compacted = tombstone ? sealedFromTombstone(tombstone) : null;
  if (!existsSync(file)) return compacted;
  const sealed = decodeSealedGroup(readJson(file, `Workflow origin group ${id}`));
  if (sealed.sourceGroupId !== id) throw new Error(`Workflow origin group ${id} has a mismatched identity.`);
  if (compacted && !sameSealedGroup(sealed, compacted)) {
    throw new Error(`Workflow origin group ${id} has conflicting sealed and compacted authority.`);
  }
  return sealed;
}

export function workflowOriginGroupMemberForRequest(
  sourceGroupId: string,
  queueRequestDigest: string,
  replyTarget: ExactOriginDeliveryTarget,
): WorkflowOriginGroupMember | null {
  const sealed = readWorkflowOriginGroup(sourceGroupId);
  const closed = sealed ? null : readWorkflowOriginGroupClosedBatch(sourceGroupId);
  const closing = sealed || closed ? null : readWorkflowOriginGroupCloseIntent(sourceGroupId);
  const authority = sealed ?? closed?.receipt ?? closing;
  if (!authority) return null;
  const target = normalizeExactOriginDeliveryTarget(replyTarget);
  if (!target || !sameExactOriginDeliveryTarget(authority.replyTarget, target)) {
    throw new Error('workflow origin group is closed to a different immutable reply target');
  }
  const member = authority.members.find((candidate) => candidate.queueRequestDigest === queueRequestDigest);
  if (!member) throw new Error('workflow origin group membership is already closed and cannot be widened');
  return member;
}

function decodeExactOriginRecord(value: unknown, expectedRunId?: string): ExactWorkflowRunOriginRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow run has an invalid exact origin marker');
  }
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.sourceUserSeq) || Number(raw.sourceUserSeq) <= 0) {
    throw new Error(`Workflow run ${expectedRunId ?? '<unknown>'} has an invalid exact origin marker.`);
  }
  const runId = validRunId(raw.runId);
  const observer = normalizeWorkflowRunOriginObserver({
    sessionId: String(raw.originSessionId ?? ''),
    sourceUserSeq: raw.sourceUserSeq as number,
    replyTarget: raw.replyTarget as ExactOriginDeliveryTarget,
  });
  if (
    raw.version !== EXACT_ORIGIN_RECORD_VERSION
    || !runId
    || (expectedRunId !== undefined && runId !== expectedRunId)
    || !observer
    || raw.observerId !== workflowRunOriginObserverId(observer)
    || raw.replyTargetDigest !== exactOriginDeliveryTargetDigest(observer.replyTarget)
    || raw.sourceGroupId !== workflowOriginSourceGroupId(observer)
    || !isDigest(raw.sourceGroupDigest)
    || !isIsoTimestamp(raw.recordedAt)
  ) {
    throw new Error(`Workflow run ${expectedRunId ?? runId ?? '<unknown>'} has an invalid exact origin marker.`);
  }
  return {
    version: EXACT_ORIGIN_RECORD_VERSION,
    runId,
    observerId: String(raw.observerId),
    originSessionId: observer.sessionId,
    sourceUserSeq: observer.sourceUserSeq,
    replyTarget: observer.replyTarget,
    replyTargetDigest: String(raw.replyTargetDigest),
    sourceGroupId: String(raw.sourceGroupId),
    sourceGroupDigest: String(raw.sourceGroupDigest),
    recordedAt: String(raw.recordedAt),
  };
}

function exactOriginRecordFile(runId: string, observerId: string): string {
  const prefix = 'workflow-origin-v2:';
  if (!observerId.startsWith(prefix) || !isDigest(observerId.slice(prefix.length))) {
    throw new Error('workflow origin observer id is invalid');
  }
  return path.join(runOriginDir(runId), `${observerId.slice(prefix.length)}.json`);
}

function sameExactOriginRecord(left: ExactWorkflowRunOriginRecord, right: ExactWorkflowRunOriginRecord): boolean {
  return left.runId === right.runId
    && left.observerId === right.observerId
    && left.originSessionId === right.originSessionId
    && left.sourceUserSeq === right.sourceUserSeq
    && left.replyTargetDigest === right.replyTargetDigest
    && left.sourceGroupId === right.sourceGroupId
    && left.sourceGroupDigest === right.sourceGroupDigest
    && sameExactOriginDeliveryTarget(left.replyTarget, right.replyTarget);
}

function installMemberObserver(sealed: SealedWorkflowOriginGroup, member: WorkflowOriginGroupMember): void {
  const file = runFile(member.runId);
  withWorkflowRunRecordLock(file, () => {
    if (!existsSync(file)) {
      throw new Error(`Workflow run ${member.runId} disappeared before source-group activation.`);
    }
    const raw = readJson(file, `Workflow run ${member.runId}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Workflow run ${member.runId} has an invalid record during source-group activation.`);
    }
    const run = raw as Record<string, unknown>;
    if (run.id !== member.runId || !nonEmptyString(run.workflow)) {
      throw new Error(`Workflow run ${member.runId} changed identity before source-group activation.`);
    }
    const record: ExactWorkflowRunOriginRecord = {
      version: EXACT_ORIGIN_RECORD_VERSION,
      runId: member.runId,
      observerId: sealed.observerId,
      originSessionId: sealed.originSessionId,
      sourceUserSeq: sealed.sourceUserSeq,
      replyTarget: sealed.replyTarget,
      replyTargetDigest: sealed.replyTargetDigest,
      sourceGroupId: sealed.sourceGroupId,
      sourceGroupDigest: sealed.sourceGroupDigest,
      recordedAt: new Date().toISOString(),
    };
    const markerFile = exactOriginRecordFile(member.runId, sealed.observerId);
    if (!createJsonDurably(markerFile, record)) {
      const winner = decodeExactOriginRecord(
        readJson(markerFile, `Workflow run ${member.runId} exact origin marker`),
        member.runId,
      );
      if (!sameExactOriginRecord(winner, record)) {
        throw new Error(`Workflow run ${member.runId} has a conflicting exact origin marker.`);
      }
    }
    if (typeof run.status !== 'string') {
      throw new Error(`Workflow run ${member.runId} has no valid status during source-group activation.`);
    }
    // Duplicate membership may attach to any already-admitted lifecycle state,
    // including parked, running, finalizing, or terminal. It never rewrites it.
    if (run.status === 'awaiting_catchup_decision' || run.status === 'awaiting_project_bind') {
      throw new Error(`Workflow run ${member.runId} is held by a different admission protocol.`);
    }
  });
}

function releaseMemberAfterActivationReceipt(
  sealed: SealedWorkflowOriginGroup,
  member: WorkflowOriginGroupMember,
  activation: WorkflowOriginGroupActivationReceipt,
): void {
  const file = runFile(member.runId);
  withWorkflowRunRecordLock(file, () => {
    if (!existsSync(file)) {
      throw new Error(`Workflow run ${member.runId} disappeared before source-group release.`);
    }
    const raw = readJson(file, `Workflow run ${member.runId}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Workflow run ${member.runId} has an invalid record during source-group release.`);
    }
    const run = raw as Record<string, unknown>;
    if (run.id !== member.runId) {
      throw new Error(`Workflow run ${member.runId} changed identity before source-group release.`);
    }
    // Re-verify both the complete activation receipt and this member's exact
    // marker inside the same run lock that changes executability.
    const durableActive = readActiveWorkflowOriginGroup(sealed.sourceGroupId);
    if (
      !durableActive
      || durableActive.activation.activationDigest !== activation.activationDigest
      || !durableActive.sealed.members.some((candidate) => candidate.runId === member.runId)
    ) {
      throw new Error(`Workflow run ${member.runId} has no complete source-group activation authority.`);
    }
    exactRecordForMember(durableActive.sealed, member.runId);
    if (run.status === 'awaiting_chat_dispatch_seal') {
      replaceJsonDurably(file, {
        ...run,
        status: 'queued',
        chatDispatchActivatedAt: activation.activatedAt,
        chatDispatchActivationDigest: activation.activationDigest,
      });
      return;
    }
    if (typeof run.status !== 'string') {
      throw new Error(`Workflow run ${member.runId} has no valid status during source-group release.`);
    }
    if (run.status === 'awaiting_catchup_decision' || run.status === 'awaiting_project_bind') {
      throw new Error(`Workflow run ${member.runId} is held by a different admission protocol.`);
    }
  });
}

function activationDigest(sealed: SealedWorkflowOriginGroup, activatedAt: string): string {
  return hash([
    'clementine-workflow-origin-group-activation:v1',
    sealed.sourceGroupId,
    sealed.sourceGroupDigest,
    ...sealed.members.map((member) => member.runId),
    activatedAt,
  ]);
}

function decodeActivationReceipt(
  value: unknown,
  sealed: SealedWorkflowOriginGroup,
): WorkflowOriginGroupActivationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow origin group activation receipt is invalid');
  }
  const raw = value as Record<string, unknown>;
  const memberRunIds = Array.isArray(raw.memberRunIds)
    ? raw.memberRunIds.map(nonEmptyString)
    : [];
  if (
    raw.version !== ORIGIN_GROUP_VERSION
    || raw.sourceGroupId !== sealed.sourceGroupId
    || raw.sourceGroupDigest !== sealed.sourceGroupDigest
    || memberRunIds.some((id) => !id)
    || memberRunIds.length !== sealed.members.length
    || memberRunIds.some((id, index) => id !== sealed.members[index].runId)
    || !isIsoTimestamp(raw.activatedAt)
    || !isDigest(raw.activationDigest)
  ) {
    throw new Error('workflow origin group activation receipt is invalid');
  }
  const expectedDigest = activationDigest(sealed, String(raw.activatedAt));
  if (raw.activationDigest !== expectedDigest) {
    throw new Error('workflow origin group activation receipt digest does not match its members');
  }
  return {
    version: ORIGIN_GROUP_VERSION,
    sourceGroupId: sealed.sourceGroupId,
    sourceGroupDigest: sealed.sourceGroupDigest,
    memberRunIds: memberRunIds as string[],
    activatedAt: String(raw.activatedAt),
    activationDigest: expectedDigest,
  };
}

function publicDispatch(sealed: SealedWorkflowOriginGroup): WorkflowOriginGroupPublicDispatch {
  return {
    version: 2,
    kind: 'workflow_run_group',
    status: 'dispatched',
    sourceUserSeq: sealed.sourceUserSeq,
    sourceGroupId: sealed.sourceGroupId,
    sourceGroupDigest: sealed.sourceGroupDigest,
    runIds: sealed.members.map((member) => member.runId),
    dispatchKey: `workflow_source_group:${sealed.sourceGroupId}:${sealed.sourceGroupDigest}`,
    replyTargetDigest: sealed.replyTargetDigest,
  };
}

function workflowOriginGroupNotificationId(input: {
  sourceGroupDigest: string;
  observerId: string;
  memberRunIds: readonly string[];
}): string {
  if (input.memberRunIds.length === 1) {
    const observerDigest = input.observerId.replace(/^workflow-origin-v2:/, '');
    if (!isDigest(observerDigest)) throw new Error('workflow origin group settlement observer id is invalid');
    return `workflow-${input.memberRunIds[0]}-origin-${observerDigest}`;
  }
  return `workflow-origin-group-${input.sourceGroupDigest}`;
}

function workflowOriginTerminalDigest(input: WorkflowOriginGroupSettlementTerminalInput): string {
  const eventId = nonEmptyString(input.eventId);
  const outcomeId = nonEmptyString(input.outcomeId);
  const sessionId = nonEmptyString(input.sessionId);
  const runId = nonEmptyString(input.runId);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (
    !eventId
    || !outcomeId
    || !sessionId
    || !runId
    || !Number.isSafeInteger(input.turn)
    || input.turn <= 0
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || (input.status !== 'done' && input.status !== 'blocked' && input.status !== 'failed')
    || !text
  ) {
    throw new Error('workflow origin group settlement terminal evidence is invalid');
  }
  return hash([
    'clementine-workflow-origin-group-terminal:v1',
    eventId,
    outcomeId,
    sessionId,
    input.turn,
    input.sourceUserSeq,
    runId,
    input.status,
    text,
  ]);
}

function workflowOriginGroupSettlementDigest(
  input: Omit<WorkflowOriginGroupSettlementReceipt, 'version' | 'settlementDigest'>,
): string {
  return hash([
    'clementine-workflow-origin-group-settlement:v2',
    input.sourceGroupId,
    input.sourceGroupDigest,
    input.observerId,
    input.replyTargetDigest,
    input.exactDeliveryReceipt,
    input.notificationId,
    input.terminalIdentity.eventId,
    input.terminalIdentity.outcomeId,
    input.terminalIdentity.sessionId,
    input.terminalIdentity.turn,
    input.terminalIdentity.sourceUserSeq,
    input.terminalIdentity.runId,
    input.terminalStatus,
    input.terminalDigest,
    ...input.memberRunIds,
    ...input.memberReportBackDigests.flatMap((member) => [
      member.runId,
      member.reportBackDigest,
    ]),
    input.settledAt,
  ]);
}

function decodeWorkflowOriginGroupSettlementReceipt(
  value: unknown,
): WorkflowOriginGroupSettlementReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow origin group settlement receipt is invalid');
  }
  const raw = value as Record<string, unknown>;
  const identityRaw = raw.terminalIdentity;
  if (!identityRaw || typeof identityRaw !== 'object' || Array.isArray(identityRaw)) {
    throw new Error('workflow origin group settlement terminal identity is invalid');
  }
  const identity = identityRaw as Record<string, unknown>;
  const sourceGroupId = nonEmptyString(raw.sourceGroupId);
  const observerId = nonEmptyString(raw.observerId);
  const notificationId = nonEmptyString(raw.notificationId);
  const exactDeliveryReceipt = nonEmptyString(raw.exactDeliveryReceipt);
  const terminalIdentity: WorkflowOriginGroupTerminalIdentity = {
    eventId: nonEmptyString(identity.eventId) ?? '',
    outcomeId: nonEmptyString(identity.outcomeId) ?? '',
    sessionId: nonEmptyString(identity.sessionId) ?? '',
    turn: Number(identity.turn),
    sourceUserSeq: Number(identity.sourceUserSeq),
    runId: nonEmptyString(identity.runId) ?? '',
  };
  const memberRunIds = Array.isArray(raw.memberRunIds)
    ? raw.memberRunIds.map(validRunId)
    : [];
  const memberReportBackDigests = Array.isArray(raw.memberReportBackDigests)
    ? raw.memberReportBackDigests.map((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
        const entry = candidate as Record<string, unknown>;
        const runId = validRunId(entry.runId);
        if (
          Object.keys(entry).length !== 2
          || !runId
          || !isDigest(entry.reportBackDigest)
        ) return null;
        return { runId, reportBackDigest: entry.reportBackDigest };
      })
    : [];
  if (
    raw.version !== ORIGIN_GROUP_VERSION
    || !sourceGroupId
    || !observerId
    || !isDigest(raw.sourceGroupDigest)
    || !isDigest(raw.replyTargetDigest)
    || !exactDeliveryReceipt
    || !notificationId
    || !terminalIdentity.eventId
    || !terminalIdentity.outcomeId
    || !terminalIdentity.sessionId
    || !validRunId(terminalIdentity.runId)
    || !Number.isSafeInteger(terminalIdentity.turn)
    || terminalIdentity.turn <= 0
    || !Number.isSafeInteger(terminalIdentity.sourceUserSeq)
    || terminalIdentity.sourceUserSeq <= 0
    || (raw.terminalStatus !== 'done' && raw.terminalStatus !== 'blocked' && raw.terminalStatus !== 'failed')
    || !isDigest(raw.terminalDigest)
    || memberRunIds.length === 0
    || memberRunIds.some((runId) => !runId)
    || new Set(memberRunIds).size !== memberRunIds.length
    || memberReportBackDigests.length !== memberRunIds.length
    || memberReportBackDigests.some((entry) => entry === null)
    || memberReportBackDigests.some((entry, index) => entry?.runId !== memberRunIds[index])
    || !isIsoTimestamp(raw.settledAt)
    || !isDigest(raw.settlementDigest)
  ) {
    throw new Error('workflow origin group settlement receipt is invalid');
  }
  if (
    sourceGroupId !== workflowOriginSourceGroupId({
      sessionId: terminalIdentity.sessionId,
      sourceUserSeq: terminalIdentity.sourceUserSeq,
    })
    || observerId !== workflowRunOriginObserverId({
      sessionId: terminalIdentity.sessionId,
      sourceUserSeq: terminalIdentity.sourceUserSeq,
    })
    || terminalIdentity.outcomeId !== `turn:${terminalIdentity.sourceUserSeq}`
    || terminalIdentity.runId !== (memberRunIds.length === 1 ? memberRunIds[0] : sourceGroupId)
  ) {
    throw new Error('workflow origin group settlement terminal identity does not match its source');
  }
  const canonicalWithoutDigest: Omit<WorkflowOriginGroupSettlementReceipt, 'version' | 'settlementDigest'> = {
    sourceGroupId,
    sourceGroupDigest: String(raw.sourceGroupDigest),
    observerId,
    replyTargetDigest: String(raw.replyTargetDigest),
    exactDeliveryReceipt,
    notificationId,
    terminalIdentity,
    terminalStatus: raw.terminalStatus,
    terminalDigest: String(raw.terminalDigest),
    memberRunIds: memberRunIds as string[],
    memberReportBackDigests: memberReportBackDigests as WorkflowOriginGroupMemberReportBackDigest[],
    settledAt: String(raw.settledAt),
  };
  if (
    notificationId !== workflowOriginGroupNotificationId(canonicalWithoutDigest)
    || raw.settlementDigest !== workflowOriginGroupSettlementDigest(canonicalWithoutDigest)
  ) {
    throw new Error('workflow origin group settlement digest or notification identity is invalid');
  }
  return {
    version: ORIGIN_GROUP_VERSION,
    ...canonicalWithoutDigest,
    settlementDigest: String(raw.settlementDigest),
  };
}

function sameWorkflowOriginGroupSettlement(
  left: WorkflowOriginGroupSettlementReceipt,
  right: WorkflowOriginGroupSettlementReceipt,
): boolean {
  return left.settlementDigest === right.settlementDigest
    && JSON.stringify(left) === JSON.stringify(right);
}

export function createWorkflowOriginGroupSettlementReceipt(input: {
  sourceGroupId: string;
  exactDeliveryReceipt: string;
  notificationId: string;
  terminal: WorkflowOriginGroupSettlementTerminalInput;
  memberReportBackDigests: readonly WorkflowOriginGroupMemberReportBackDigest[];
  settledAt: string;
}): WorkflowOriginGroupSettlementReceipt {
  const active = readActiveWorkflowOriginGroup(input.sourceGroupId);
  if (!active) throw new Error(`Workflow origin group ${input.sourceGroupId} has no active authority to settle.`);
  const expectedReceipt = exactOriginDeliveryReceiptForTarget(active.sealed.replyTarget);
  const exactDeliveryReceipt = nonEmptyString(input.exactDeliveryReceipt);
  const notificationId = nonEmptyString(input.notificationId);
  const terminalDigest = workflowOriginTerminalDigest(input.terminal);
  const terminalIdentity: WorkflowOriginGroupTerminalIdentity = {
    eventId: input.terminal.eventId.trim(),
    outcomeId: input.terminal.outcomeId.trim(),
    sessionId: input.terminal.sessionId.trim(),
    turn: input.terminal.turn,
    sourceUserSeq: input.terminal.sourceUserSeq,
    runId: input.terminal.runId.trim(),
  };
  const memberRunIds = active.sealed.members.map((member) => member.runId);
  const memberReportBackDigests = input.memberReportBackDigests.map((member) => ({
    runId: member.runId,
    reportBackDigest: member.reportBackDigest,
  }));
  const canonicalNotificationId = workflowOriginGroupNotificationId({
    sourceGroupDigest: active.sealed.sourceGroupDigest,
    observerId: active.sealed.observerId,
    memberRunIds,
  });
  if (!expectedReceipt || exactDeliveryReceipt !== expectedReceipt) {
    throw new Error('workflow origin group settlement exact target receipt does not match admission authority');
  }
  if (notificationId !== canonicalNotificationId) {
    throw new Error('workflow origin group settlement notification id is not canonical');
  }
  if (
    terminalIdentity.sessionId !== active.sealed.originSessionId
    || terminalIdentity.sourceUserSeq !== active.sealed.sourceUserSeq
    || terminalIdentity.outcomeId !== `turn:${active.sealed.sourceUserSeq}`
    || terminalIdentity.runId !== (memberRunIds.length === 1 ? memberRunIds[0] : active.sealed.sourceGroupId)
    || memberReportBackDigests.length !== memberRunIds.length
    || memberReportBackDigests.some(
      (member, index) => member.runId !== memberRunIds[index] || !isDigest(member.reportBackDigest),
    )
    || !isIsoTimestamp(input.settledAt)
  ) {
    throw new Error('workflow origin group settlement terminal does not match active source authority');
  }
  const withoutDigest: Omit<WorkflowOriginGroupSettlementReceipt, 'version' | 'settlementDigest'> = {
    sourceGroupId: active.sealed.sourceGroupId,
    sourceGroupDigest: active.sealed.sourceGroupDigest,
    observerId: active.sealed.observerId,
    replyTargetDigest: active.sealed.replyTargetDigest,
    exactDeliveryReceipt,
    notificationId,
    terminalIdentity,
    terminalStatus: input.terminal.status,
    terminalDigest,
    memberRunIds,
    memberReportBackDigests,
    settledAt: input.settledAt,
  };
  return decodeWorkflowOriginGroupSettlementReceipt({
    version: ORIGIN_GROUP_VERSION,
    ...withoutDigest,
    settlementDigest: workflowOriginGroupSettlementDigest(withoutDigest),
  });
}

function settlementMatchesActiveGroup(
  settlement: WorkflowOriginGroupSettlementReceipt,
  active: ActiveWorkflowOriginGroup,
): boolean {
  const memberRunIds = active.sealed.members.map((member) => member.runId);
  return settlement.sourceGroupId === active.sealed.sourceGroupId
    && settlement.sourceGroupDigest === active.sealed.sourceGroupDigest
    && settlement.observerId === active.sealed.observerId
    && settlement.replyTargetDigest === active.sealed.replyTargetDigest
    && settlement.exactDeliveryReceipt === exactOriginDeliveryReceiptForTarget(active.sealed.replyTarget)
    && settlement.notificationId === workflowOriginGroupNotificationId({
      sourceGroupDigest: active.sealed.sourceGroupDigest,
      observerId: active.sealed.observerId,
      memberRunIds,
    })
    && settlement.memberRunIds.length === memberRunIds.length
    && settlement.memberRunIds.every((runId, index) => runId === memberRunIds[index])
    && settlement.memberReportBackDigests.length === memberRunIds.length
    && settlement.memberReportBackDigests.every(
      (member, index) => member.runId === memberRunIds[index],
    );
}

export function readWorkflowOriginGroupSettlement(
  sourceGroupId: string,
): WorkflowOriginGroupSettlementReceipt | null {
  const id = nonEmptyString(sourceGroupId);
  if (!id) throw new Error('workflow origin group id is required for settlement lookup');
  const file = settledGroupFile(id);
  const direct = existsSync(file)
    ? decodeWorkflowOriginGroupSettlementReceipt(
        readJson(file, `Workflow origin group ${id} settlement`),
      )
    : null;
  const tombstone = readWorkflowOriginGroupTombstone(id);
  if (direct && direct.sourceGroupId !== id) {
    throw new Error(`Workflow origin group ${id} settlement has a mismatched identity.`);
  }
  if (direct && tombstone && !sameWorkflowOriginGroupSettlement(direct, tombstone.settlement)) {
    throw new Error(`Workflow origin group ${id} has conflicting settlement authorities.`);
  }
  return direct ?? tombstone?.settlement ?? null;
}

export function recordWorkflowOriginGroupSettlement(
  receiptInput: WorkflowOriginGroupSettlementReceipt,
): WorkflowOriginGroupSettlementReceipt {
  const receipt = decodeWorkflowOriginGroupSettlementReceipt(receiptInput);
  return withWorkflowRunRecordLock(groupAuthorityLockFile(receipt.sourceGroupId), () => {
    const active = readActiveWorkflowOriginGroup(receipt.sourceGroupId);
    if (!active || !settlementMatchesActiveGroup(receipt, active)) {
      throw new Error('workflow origin group settlement does not match durable active authority');
    }
    const tombstone = readWorkflowOriginGroupTombstone(receipt.sourceGroupId);
    if (tombstone) {
      if (!sameWorkflowOriginGroupSettlement(tombstone.settlement, receipt)) {
        throw new Error('workflow origin group already has a conflicting immutable settlement');
      }
      return tombstone.settlement;
    }
    const file = settledGroupFile(receipt.sourceGroupId);
    if (createJsonDurably(file, receipt)) return receipt;
    const winner = decodeWorkflowOriginGroupSettlementReceipt(
      readJson(file, `Workflow origin group ${receipt.sourceGroupId} settlement`),
    );
    if (!sameWorkflowOriginGroupSettlement(winner, receipt)) {
      throw new Error('workflow origin group already has a conflicting immutable settlement');
    }
    return winner;
  });
}

function workflowOriginGroupTombstoneDigest(
  input: Omit<WorkflowOriginGroupTombstone, 'version' | 'kind' | 'tombstoneDigest'>,
): string {
  return hash([
    'clementine-workflow-origin-group-tombstone:v1',
    input.sourceGroupId,
    input.sourceGroupDigest,
    input.observerId,
    input.originSessionId,
    input.sourceUserSeq,
    input.replyTargetDigest,
    input.closeDigest,
    input.closeReceiptDigest,
    input.closedRecordedAt,
    input.sealedAt,
    input.activationDigest,
    input.settlement.settlementDigest,
    ...input.members.flatMap((member) => [
      member.runId,
      member.queueRequestDigest,
      member.preparationDigest,
      member.preparedEventId,
      member.preparedEventSeq,
      member.preparedAt,
      member.receiptDigest,
    ]),
    input.compactedAt,
  ]);
}

function sealedFromTombstone(tombstone: WorkflowOriginGroupTombstone): SealedWorkflowOriginGroup {
  return decodeSealedGroup({
    version: ORIGIN_GROUP_VERSION,
    sourceGroupId: tombstone.sourceGroupId,
    sourceGroupDigest: tombstone.sourceGroupDigest,
    observerId: tombstone.observerId,
    originSessionId: tombstone.originSessionId,
    sourceUserSeq: tombstone.sourceUserSeq,
    replyTarget: tombstone.replyTarget,
    replyTargetDigest: tombstone.replyTargetDigest,
    members: tombstone.members,
    sealedAt: tombstone.sealedAt,
  });
}

function activationFromTombstone(
  tombstone: WorkflowOriginGroupTombstone,
  sealed: SealedWorkflowOriginGroup = sealedFromTombstone(tombstone),
): WorkflowOriginGroupActivationReceipt {
  return decodeActivationReceipt({
    version: ORIGIN_GROUP_VERSION,
    sourceGroupId: tombstone.sourceGroupId,
    sourceGroupDigest: tombstone.sourceGroupDigest,
    memberRunIds: tombstone.members.map((member) => member.runId),
    activatedAt: tombstone.activatedAt,
    activationDigest: tombstone.activationDigest,
  }, sealed);
}

function closeReceiptFromTombstone(
  tombstone: WorkflowOriginGroupTombstone,
): WorkflowOriginGroupClosedBatchReceipt {
  return decodeWorkflowOriginGroupClosedBatchReceipt({
    version: ORIGIN_GROUP_VERSION,
    sourceGroupId: tombstone.sourceGroupId,
    observerId: tombstone.observerId,
    originSessionId: tombstone.originSessionId,
    sourceUserSeq: tombstone.sourceUserSeq,
    replyTarget: tombstone.replyTarget,
    replyTargetDigest: tombstone.replyTargetDigest,
    members: tombstone.members,
    closeDigest: tombstone.closeDigest,
    receiptVersion: ORIGIN_GROUP_VERSION,
    closedEventId: tombstone.closedEventId,
    closedEventSeq: tombstone.closedEventSeq,
    closedAt: tombstone.closedAt,
    closeReceiptDigest: tombstone.closeReceiptDigest,
  });
}

function preparedReceiptsFromTombstone(
  tombstone: WorkflowOriginGroupTombstone,
): WorkflowChatDispatchPreparedReceipt[] {
  const observer: WorkflowRunOriginObserver = {
    sessionId: tombstone.originSessionId,
    sourceUserSeq: tombstone.sourceUserSeq,
    replyTarget: tombstone.replyTarget,
  };
  return tombstone.members.map((member) => {
    const authority = createWorkflowChatDispatchPreparationAuthority({
      runId: member.runId,
      observer,
      queueRequestDigest: member.queueRequestDigest,
    });
    return createWorkflowChatDispatchPreparedReceipt(authority, {
      eventId: member.preparedEventId,
      eventSeq: member.preparedEventSeq,
      preparedAt: member.preparedAt,
    });
  });
}

function activeFromTombstone(tombstone: WorkflowOriginGroupTombstone): ActiveWorkflowOriginGroup {
  const sealed = sealedFromTombstone(tombstone);
  return {
    sealed,
    activation: activationFromTombstone(tombstone, sealed),
    publicDispatch: publicDispatch(sealed),
  };
}

function decodeWorkflowOriginGroupTombstone(value: unknown): WorkflowOriginGroupTombstone {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow origin group tombstone is invalid');
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== ORIGIN_GROUP_VERSION
    || raw.kind !== 'settled_workflow_origin_group'
    || !Number.isSafeInteger(raw.sourceUserSeq)
    || Number(raw.sourceUserSeq) <= 0
    || !isIsoTimestamp(raw.closedRecordedAt)
    || !isIsoTimestamp(raw.sealedAt)
    || !isIsoTimestamp(raw.compactedAt)
    || !isDigest(raw.tombstoneDigest)
  ) {
    throw new Error('workflow origin group tombstone is invalid');
  }
  const observer = normalizeWorkflowRunOriginObserver({
    sessionId: String(raw.originSessionId ?? ''),
    sourceUserSeq: Number(raw.sourceUserSeq),
    replyTarget: raw.replyTarget as ExactOriginDeliveryTarget,
  });
  if (!observer) throw new Error('workflow origin group tombstone source authority is invalid');
  const members = decodeGroupMembers(raw.members, observer);
  const canonicalWithoutDigest: Omit<WorkflowOriginGroupTombstone, 'version' | 'kind' | 'tombstoneDigest'> = {
    sourceGroupId: String(raw.sourceGroupId ?? ''),
    sourceGroupDigest: String(raw.sourceGroupDigest ?? ''),
    observerId: String(raw.observerId ?? ''),
    originSessionId: observer.sessionId,
    sourceUserSeq: observer.sourceUserSeq,
    replyTarget: observer.replyTarget,
    replyTargetDigest: String(raw.replyTargetDigest ?? ''),
    members,
    closeDigest: String(raw.closeDigest ?? ''),
    closedEventId: String(raw.closedEventId ?? ''),
    closedEventSeq: Number(raw.closedEventSeq),
    closedAt: String(raw.closedAt ?? ''),
    closeReceiptDigest: String(raw.closeReceiptDigest ?? ''),
    closedRecordedAt: String(raw.closedRecordedAt),
    sealedAt: String(raw.sealedAt),
    activatedAt: String(raw.activatedAt ?? ''),
    activationDigest: String(raw.activationDigest ?? ''),
    settlement: decodeWorkflowOriginGroupSettlementReceipt(raw.settlement),
    compactedAt: String(raw.compactedAt),
  };
  const candidate: WorkflowOriginGroupTombstone = {
    version: ORIGIN_GROUP_VERSION,
    kind: 'settled_workflow_origin_group',
    ...canonicalWithoutDigest,
    tombstoneDigest: String(raw.tombstoneDigest),
  };
  const sealed = sealedFromTombstone(candidate);
  const activation = activationFromTombstone(candidate, sealed);
  const closeReceipt = closeReceiptFromTombstone(candidate);
  if (
    candidate.sourceGroupId !== workflowOriginSourceGroupId(observer)
    || candidate.observerId !== workflowRunOriginObserverId(observer)
    || candidate.replyTargetDigest !== exactOriginDeliveryTargetDigest(observer.replyTarget)
    || closeReceipt.sourceGroupId !== candidate.sourceGroupId
    || activation.sourceGroupDigest !== candidate.sourceGroupDigest
    || !settlementMatchesActiveGroup(candidate.settlement, {
      sealed,
      activation,
      publicDispatch: publicDispatch(sealed),
    })
    || candidate.tombstoneDigest !== workflowOriginGroupTombstoneDigest(canonicalWithoutDigest)
  ) {
    throw new Error('workflow origin group tombstone does not match its immutable authority');
  }
  return candidate;
}

export function readWorkflowOriginGroupTombstone(
  sourceGroupId: string,
): WorkflowOriginGroupTombstone | null {
  const id = nonEmptyString(sourceGroupId);
  if (!id) throw new Error('workflow origin group id is required for tombstone lookup');
  const file = compactedGroupFile(id);
  if (!existsSync(file)) return null;
  const tombstone = decodeWorkflowOriginGroupTombstone(
    readJson(file, `Workflow origin group ${id} tombstone`),
  );
  if (tombstone.sourceGroupId !== id) {
    throw new Error(`Workflow origin group ${id} tombstone has a mismatched identity.`);
  }
  return tombstone;
}

function sameWorkflowOriginGroupTombstone(
  left: WorkflowOriginGroupTombstone,
  right: WorkflowOriginGroupTombstone,
): boolean {
  return left.tombstoneDigest === right.tombstoneDigest
    && JSON.stringify(left) === JSON.stringify(right);
}

function removeCompactedWorkflowOriginGroupFiles(sourceGroupId: string): void {
  const tombstone = readWorkflowOriginGroupTombstone(sourceGroupId);
  if (!tombstone) {
    throw new Error(`Workflow origin group ${sourceGroupId} cannot remove authority before its tombstone.`);
  }
  validateCompactedAdmissionEvidence(tombstone);
  for (const [dir, label] of [
    [groupPreparedDir(sourceGroupId), 'prepared'],
    [groupAdmissionsDir(sourceGroupId), 'admission'],
  ] as const) {
    if (existsSync(dir)) {
      const entries = readdirSync(dir).sort();
      if (entries.some((entry) => !/^[a-f0-9]{64}\.json$/.test(entry))) {
        throw new Error(`Workflow origin group ${sourceGroupId} ${label} index contains unknown evidence.`);
      }
      for (const entry of entries) unlinkSync(path.join(dir, entry));
      if (process.platform !== 'win32') {
        const fd = openSync(dir, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      rmdirSync(dir);
    }
  }
  for (const file of [
    closingGroupFile(sourceGroupId),
    closedGroupFile(sourceGroupId),
    sealedGroupFile(sourceGroupId),
    activatedGroupFile(sourceGroupId),
    settledGroupFile(sourceGroupId),
  ]) {
    if (existsSync(file)) unlinkSync(file);
  }
  if (process.platform !== 'win32') {
    const fd = openSync(groupDir(sourceGroupId), 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

export interface CompactWorkflowOriginGroupOptions {
  /** Crash seam after the tombstone wins but before bulky records are removed. */
  failAfterTombstoneForTest?: boolean;
}

/** Compact one settled group without reopening its source. A tombstone is
 * installed before any lifecycle file is removed. Still-present members must
 * each own their local report-back projection; an absent canonical run record
 * is treated as already reaped. */
export function compactSettledWorkflowOriginGroup(
  sourceGroupId: string,
  options: CompactWorkflowOriginGroupOptions = {},
): WorkflowOriginGroupTombstone {
  const id = nonEmptyString(sourceGroupId);
  if (!id) throw new Error('workflow origin group id is required for compaction');
  return withWorkflowRunRecordLock(groupAuthorityLockFile(id), () => {
    const existing = readWorkflowOriginGroupTombstone(id);
    if (existing) {
      // A crash after tombstone installation may leave the original fence.
      // Decode/compare it before any cleanup; malformed or conflicting bytes
      // are never silently erased by replay compaction.
      readWorkflowOriginGroupCloseIntent(id);
      if (options.failAfterTombstoneForTest) {
        throw new Error('Injected workflow origin group compaction crash after durable tombstone.');
      }
      removeCompactedWorkflowOriginGroupFiles(id);
      return existing;
    }
    const closeFile = closedGroupFile(id);
    const sealFile = sealedGroupFile(id);
    const activationFile = activatedGroupFile(id);
    const settlementFile = settledGroupFile(id);
    if (!existsSync(closeFile) || !existsSync(sealFile) || !existsSync(activationFile) || !existsSync(settlementFile)) {
      throw new Error(`Workflow origin group ${id} lacks complete lifecycle authority for compaction.`);
    }
    const closed = decodeDurableClosedBatch(readJson(closeFile, `Workflow origin group ${id} closed batch`));
    const sealed = decodeSealedGroup(readJson(sealFile, `Workflow origin group ${id}`));
    const activation = decodeActivationReceipt(
      readJson(activationFile, `Workflow origin group ${id} activation receipt`),
      sealed,
    );
    const settlement = decodeWorkflowOriginGroupSettlementReceipt(
      readJson(settlementFile, `Workflow origin group ${id} settlement`),
    );
    const closeIntent = recordWorkflowOriginGroupCloseIntent(closed.receipt);
    if (!sameCloseAuthority(closeIntent, closed.receipt)) {
      throw new Error(`Workflow origin group ${id} has conflicting close-fence authority for compaction.`);
    }
    validateCloseAgainstAdmissionEvidence(closed.receipt);
    const active: ActiveWorkflowOriginGroup = {
      sealed,
      activation,
      publicDispatch: publicDispatch(sealed),
    };
    if (
      closed.receipt.sourceGroupId !== id
      || sealed.sourceGroupId !== id
      || closed.receipt.observerId !== sealed.observerId
      || closed.receipt.originSessionId !== sealed.originSessionId
      || closed.receipt.sourceUserSeq !== sealed.sourceUserSeq
      || closed.receipt.replyTargetDigest !== sealed.replyTargetDigest
      || !sameExactOriginDeliveryTarget(closed.receipt.replyTarget, sealed.replyTarget)
      || closed.receipt.members.length !== sealed.members.length
      || !closed.receipt.members.every((member, index) => sameMember(member, sealed.members[index]))
      || !settlementMatchesActiveGroup(settlement, active)
    ) {
      throw new Error(`Workflow origin group ${id} has conflicting lifecycle authority for compaction.`);
    }
    for (const member of sealed.members) {
      const file = runFile(member.runId);
      if (!existsSync(file)) continue;
      if (!runRecordAcknowledgesOriginObserver(
        member.runId,
        sealed.observerId,
        settlement,
      )) {
        throw new Error(`Workflow origin group ${id} member ${member.runId} has not acknowledged settlement.`);
      }
      exactRecordForMember(sealed, member.runId);
    }
    const compactedAt = new Date().toISOString();
    const withoutDigest: Omit<WorkflowOriginGroupTombstone, 'version' | 'kind' | 'tombstoneDigest'> = {
      sourceGroupId: sealed.sourceGroupId,
      sourceGroupDigest: sealed.sourceGroupDigest,
      observerId: sealed.observerId,
      originSessionId: sealed.originSessionId,
      sourceUserSeq: sealed.sourceUserSeq,
      replyTarget: sealed.replyTarget,
      replyTargetDigest: sealed.replyTargetDigest,
      members: sealed.members,
      closeDigest: closed.receipt.closeDigest,
      closedEventId: closed.receipt.closedEventId,
      closedEventSeq: closed.receipt.closedEventSeq,
      closedAt: closed.receipt.closedAt,
      closeReceiptDigest: closed.receipt.closeReceiptDigest,
      closedRecordedAt: closed.recordedAt,
      sealedAt: sealed.sealedAt,
      activatedAt: activation.activatedAt,
      activationDigest: activation.activationDigest,
      settlement,
      compactedAt,
    };
    const candidate = decodeWorkflowOriginGroupTombstone({
      version: ORIGIN_GROUP_VERSION,
      kind: 'settled_workflow_origin_group',
      ...withoutDigest,
      tombstoneDigest: workflowOriginGroupTombstoneDigest(withoutDigest),
    });
    const file = compactedGroupFile(id);
    let winner = candidate;
    if (!createJsonDurably(file, candidate)) {
      winner = decodeWorkflowOriginGroupTombstone(
        readJson(file, `Workflow origin group ${id} tombstone`),
      );
      if (!sameWorkflowOriginGroupTombstone(winner, candidate)) {
        throw new Error(`Workflow origin group ${id} already has a conflicting tombstone.`);
      }
    }
    if (options.failAfterTombstoneForTest) {
      throw new Error('Injected workflow origin group compaction crash after durable tombstone.');
    }
    removeCompactedWorkflowOriginGroupFiles(id);
    return winner;
  });
}

export interface ActivateWorkflowOriginGroupOptions {
  /** Persist or verify the exact source-visible dispatch edge before any member
   * becomes executable. This is a required graph barrier, not an optional
   * behavior gate. */
  beforeMemberRelease: (active: ActiveWorkflowOriginGroup) => void;
  /** Deterministic crash seam. Production callers must omit it. */
  failAfterMemberCountForTest?: number;
  /** Simulate a crash after complete authority wins but before held members are released. */
  failAfterActivationReceiptForTest?: boolean;
}

export type WorkflowRunDrainKick = (runIds: readonly string[]) => void;
let workflowRunDrainKick: WorkflowRunDrainKick | undefined;

/** Daemon latency hook. Durability never depends on this callback: the normal
 * drain timer remains the recovery path, and callback failure is ignored. */
export function registerWorkflowRunDrainKick(
  callback?: WorkflowRunDrainKick | null,
): () => void {
  workflowRunDrainKick = callback ?? undefined;
  return () => {
    if (workflowRunDrainKick === callback) workflowRunDrainKick = undefined;
  };
}

/** Activation is restart-safe: member sidecars and held→queued transitions are
 * individually idempotent; the create-only receipt owns complete activation,
 * while the pre-release callback enforces publish-before-execute. */
export function activateWorkflowOriginGroup(
  sealedInput: SealedWorkflowOriginGroup,
  options: ActivateWorkflowOriginGroupOptions,
): ActiveWorkflowOriginGroup {
  const sealed = decodeSealedGroup(sealedInput);
  const tombstone = readWorkflowOriginGroupTombstone(sealed.sourceGroupId);
  if (tombstone) {
    const active = activeFromTombstone(tombstone);
    if (!sameSealedGroup(active.sealed, sealed)) {
      throw new Error('workflow origin group tombstone rejects a conflicting activation');
    }
    return active;
  }
  const durable = readWorkflowOriginGroup(sealed.sourceGroupId);
  if (!durable || !sameSealedGroup(durable, sealed)) {
    throw new Error('workflow origin group must have a matching durable seal before activation');
  }
  let activatedCount = 0;
  for (const member of sealed.members) {
    // This phase never changes run executability. A crash may leave private
    // sidecars, but readers ignore them until the full activation receipt.
    installMemberObserver(sealed, member);
    activatedCount += 1;
    if (options.failAfterMemberCountForTest === activatedCount) {
      throw new Error(`Injected workflow origin group activation crash after ${activatedCount} member(s).`);
    }
  }
  const activatedAt = new Date().toISOString();
  const candidate: WorkflowOriginGroupActivationReceipt = {
    version: ORIGIN_GROUP_VERSION,
    sourceGroupId: sealed.sourceGroupId,
    sourceGroupDigest: sealed.sourceGroupDigest,
    memberRunIds: sealed.members.map((member) => member.runId),
    activatedAt,
    activationDigest: activationDigest(sealed, activatedAt),
  };
  const file = activatedGroupFile(sealed.sourceGroupId);
  let activation = candidate;
  if (!createJsonDurably(file, candidate)) {
    activation = decodeActivationReceipt(
      readJson(file, `Workflow origin group ${sealed.sourceGroupId} activation receipt`),
      sealed,
    );
  }
  if (options.failAfterActivationReceiptForTest) {
    throw new Error('Injected workflow origin group activation crash after durable activation receipt.');
  }
  const activeAuthority = readActiveWorkflowOriginGroup(sealed.sourceGroupId);
  if (
    !activeAuthority
    || activeAuthority.activation.activationDigest !== activation.activationDigest
  ) {
    throw new Error('workflow origin group activation did not become durable and complete');
  }
  // Publication must commit before executability. Retries invoke this callback
  // again; its event append is idempotent against the immutable group identity.
  options.beforeMemberRelease(activeAuthority);
  // Release every fresh held member only after the public edge exists. A crash
  // part-way through is recovered by replaying this pass.
  for (const member of sealed.members) {
    releaseMemberAfterActivationReceipt(sealed, member, activation);
  }
  const active = readActiveWorkflowOriginGroup(sealed.sourceGroupId);
  if (!active || active.activation.activationDigest !== activation.activationDigest) {
    throw new Error('workflow origin group activation did not become durable and complete');
  }
  try { workflowRunDrainKick?.(active.activation.memberRunIds); } catch { /* timer is recovery */ }
  return active;
}

/** The only production close→seal→activate reducer. It reloads the immutable
 * batch rather than trusting a caller-supplied member list. */
export function finalizeWorkflowOriginGroupClosedBatch(
  sourceGroupId: string,
  options: ActivateWorkflowOriginGroupOptions,
): ActiveWorkflowOriginGroup {
  const closed = readWorkflowOriginGroupClosedBatch(sourceGroupId);
  if (!closed) throw new Error(`Workflow origin group ${sourceGroupId} has no durable closed batch.`);
  const sealed = sealWorkflowOriginGroup(closed.preparedReceipts);
  if (sealed.sourceGroupDigest !== sourceGroupDigest({
    sourceGroupId: closed.receipt.sourceGroupId,
    observerId: closed.receipt.observerId,
    originSessionId: closed.receipt.originSessionId,
    sourceUserSeq: closed.receipt.sourceUserSeq,
    replyTargetDigest: closed.receipt.replyTargetDigest,
    members: closed.receipt.members,
  })) {
    throw new Error('workflow origin group seal does not match its durable closed batch');
  }
  return activateWorkflowOriginGroup(sealed, options);
}

export interface RecoverClosedWorkflowOriginGroupsResult {
  groupsExamined: number;
  groupsFinalized: number;
  rejected: number;
}

/** Boot recovery for a crash after the close event/index won but before seal
 * or activation. Active groups are left to the partial-release reconciler so
 * settled groups do not continually kick another drain. */
export function recoverClosedWorkflowOriginGroups(
  options: ActivateWorkflowOriginGroupOptions,
): RecoverClosedWorkflowOriginGroupsResult {
  const result: RecoverClosedWorkflowOriginGroupsResult = {
    groupsExamined: 0,
    groupsFinalized: 0,
    rejected: 0,
  };
  if (!existsSync(WORKFLOW_ORIGIN_GROUPS_DIR)) return result;
  for (const entry of readdirSync(WORKFLOW_ORIGIN_GROUPS_DIR).sort()) {
    const dir = path.join(WORKFLOW_ORIGIN_GROUPS_DIR, entry);
    const closeFile = path.join(dir, 'closed.json');
    if (!existsSync(closeFile)) continue;
    result.groupsExamined += 1;
    try {
      const closed = decodeDurableClosedBatch(
        readJson(closeFile, `Workflow origin group ${entry} closed batch`),
      );
      if (groupDir(closed.receipt.sourceGroupId) !== dir) {
        throw new Error(`Workflow origin group ${closed.receipt.sourceGroupId} is stored under the wrong identity.`);
      }
      if (readActiveWorkflowOriginGroup(closed.receipt.sourceGroupId)) continue;
      finalizeWorkflowOriginGroupClosedBatch(closed.receipt.sourceGroupId, options);
      result.groupsFinalized += 1;
    } catch {
      result.rejected += 1;
    }
  }
  return result;
}

export interface ReconcileActivatedWorkflowOriginGroupsResult {
  groupsExamined: number;
  groupsRecovered: number;
  membersReleased: number;
  rejected: number;
}

/** Boot/timer recovery for the one legal partial-release window: the complete
 * activation receipt is durable, but the process died before every held run
 * changed to queued. Groups without that receipt remain deliberately held. */
export function reconcileActivatedWorkflowOriginGroups(
  options: Pick<ActivateWorkflowOriginGroupOptions, 'beforeMemberRelease'>,
): ReconcileActivatedWorkflowOriginGroupsResult {
  const result: ReconcileActivatedWorkflowOriginGroupsResult = {
    groupsExamined: 0,
    groupsRecovered: 0,
    membersReleased: 0,
    rejected: 0,
  };
  if (!existsSync(WORKFLOW_ORIGIN_GROUPS_DIR)) return result;
  for (const entry of readdirSync(WORKFLOW_ORIGIN_GROUPS_DIR).sort()) {
    const dir = path.join(WORKFLOW_ORIGIN_GROUPS_DIR, entry);
    const sealFile = path.join(dir, 'sealed.json');
    const activationFile = path.join(dir, 'activated.json');
    if (!existsSync(sealFile) || !existsSync(activationFile)) continue;
    result.groupsExamined += 1;
    try {
      const sealed = decodeSealedGroup(readJson(sealFile, `Workflow origin group ${entry}`));
      if (groupDir(sealed.sourceGroupId) !== dir) {
        throw new Error(`Workflow origin group ${sealed.sourceGroupId} is stored under the wrong identity.`);
      }
      const activation = decodeActivationReceipt(
        readJson(activationFile, `Workflow origin group ${sealed.sourceGroupId} activation receipt`),
        sealed,
      );
      const active = readActiveWorkflowOriginGroup(sealed.sourceGroupId);
      if (!active || active.activation.activationDigest !== activation.activationDigest) {
        throw new Error(`Workflow origin group ${sealed.sourceGroupId} lost activation authority during recovery.`);
      }
      const heldRunIds = new Set<string>();
      for (const member of sealed.members) {
        const file = runFile(member.runId);
        if (!existsSync(file)) continue;
        const before = readJson(file, `Workflow run ${member.runId}`) as { status?: unknown };
        if (before?.status === 'awaiting_chat_dispatch_seal') heldRunIds.add(member.runId);
      }
      // This timer scans historical active groups too. Revalidating their
      // already-published source edge every 15 seconds would add cross-store
      // reads forever and could backfill a late ACK for a legacy group. The
      // publication barrier is required exactly when executability can still
      // change: once per recovery pass that has at least one held member.
      if (heldRunIds.size === 0) continue;
      options.beforeMemberRelease(active);
      let released = 0;
      for (const member of sealed.members) {
        releaseMemberAfterActivationReceipt(sealed, member, activation);
        if (heldRunIds.has(member.runId)) released += 1;
      }
      result.membersReleased += released;
      if (released > 0) {
        result.groupsRecovered += 1;
        try { workflowRunDrainKick?.(activation.memberRunIds); } catch { /* timer is recovery */ }
      }
    } catch {
      result.rejected += 1;
    }
  }
  return result;
}

function exactRecordForMember(sealed: SealedWorkflowOriginGroup, runId: string): ExactWorkflowRunOriginRecord {
  const markerFile = exactOriginRecordFile(runId, sealed.observerId);
  if (!existsSync(markerFile)) {
    throw new Error(`Workflow origin group ${sealed.sourceGroupId} is missing member ${runId}'s exact observer.`);
  }
  const record = decodeExactOriginRecord(
    readJson(markerFile, `Workflow run ${runId} exact origin marker`),
    runId,
  );
  if (
    record.sourceGroupId !== sealed.sourceGroupId
    || record.sourceGroupDigest !== sealed.sourceGroupDigest
    || record.observerId !== sealed.observerId
    || record.replyTargetDigest !== sealed.replyTargetDigest
  ) {
    throw new Error(`Workflow origin group ${sealed.sourceGroupId} has a mismatched member observer.`);
  }
  return record;
}

export function readActiveWorkflowOriginGroup(sourceGroupId: string): ActiveWorkflowOriginGroup | null {
  const id = nonEmptyString(sourceGroupId);
  if (!id) throw new Error('workflow origin group id is required');
  const tombstone = readWorkflowOriginGroupTombstone(id);
  if (tombstone) {
    const compacted = activeFromTombstone(tombstone);
    const sealFile = sealedGroupFile(id);
    const activationFile = activatedGroupFile(id);
    if (existsSync(sealFile)) {
      const directSealed = decodeSealedGroup(readJson(sealFile, `Workflow origin group ${id}`));
      if (!sameSealedGroup(directSealed, compacted.sealed)) {
        throw new Error(`Workflow origin group ${id} has conflicting active and compacted seals.`);
      }
    }
    if (existsSync(activationFile)) {
      const directActivation = decodeActivationReceipt(
        readJson(activationFile, `Workflow origin group ${id} activation receipt`),
        compacted.sealed,
      );
      if (directActivation.activationDigest !== compacted.activation.activationDigest) {
        throw new Error(`Workflow origin group ${id} has conflicting active and compacted receipts.`);
      }
    }
    // Reaped members have no remaining marker to verify. Every member whose
    // canonical run record still exists must retain its exact sidecar.
    for (const member of compacted.sealed.members) {
      if (existsSync(runFile(member.runId))) exactRecordForMember(compacted.sealed, member.runId);
    }
    return compacted;
  }
  const sealed = readWorkflowOriginGroup(id);
  if (!sealed) return null;
  const activationFile = activatedGroupFile(sealed.sourceGroupId);
  if (!existsSync(activationFile)) return null;
  const activation = decodeActivationReceipt(
    readJson(activationFile, `Workflow origin group ${sealed.sourceGroupId} activation receipt`),
    sealed,
  );
  const settlement = readWorkflowOriginGroupSettlement(sealed.sourceGroupId);
  for (const member of sealed.members) {
    // After shared settlement, scheduler retention may already have reaped a
    // sibling. Missing canonical runs are accepted only with that durable
    // group-level proof; present members must always retain their sidecar.
    if (!existsSync(runFile(member.runId)) && settlement) continue;
    exactRecordForMember(sealed, member.runId);
  }
  return { sealed, activation, publicDispatch: publicDispatch(sealed) };
}

export function verifyActiveWorkflowOriginMembership(record: ExactWorkflowRunOriginRecord): boolean {
  const decoded = decodeExactOriginRecord(record, record.runId);
  const active = readActiveWorkflowOriginGroup(decoded.sourceGroupId);
  if (!active || active.sealed.sourceGroupDigest !== decoded.sourceGroupDigest) return false;
  if (!active.sealed.members.some((member) => member.runId === decoded.runId)) return false;
  const durable = exactRecordForMember(active.sealed, decoded.runId);
  return sameExactOriginRecord(durable, decoded);
}

export function readActiveWorkflowOriginGroupForRun(
  runId: string,
  sourceGroupId: string,
  sourceGroupDigestValue: string,
): ActiveWorkflowOriginGroup | null {
  const active = readActiveWorkflowOriginGroup(sourceGroupId);
  if (!active || active.sealed.sourceGroupDigest !== sourceGroupDigestValue) return null;
  return active.sealed.members.some((member) => member.runId === runId) ? active : null;
}

/** Only fully activated groups are visible as exact report-back authority.
 * Sidecars from a partial activation stay private until the group receipt wins. */
export function readActiveExactWorkflowRunOriginRecords(runId: string): ExactWorkflowRunOriginRecord[] {
  const dir = runOriginDir(runId);
  if (!existsSync(dir)) return [];
  const records: ExactWorkflowRunOriginRecord[] = [];
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    const value = readJson(path.join(dir, file), `Workflow run ${runId} origin observer marker`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Workflow run ${runId} has an invalid origin observer marker.`);
    }
    const version = (value as Record<string, unknown>).version;
    if (version === 1) continue;
    if (version !== EXACT_ORIGIN_RECORD_VERSION) {
      throw new Error(`Workflow run ${runId} has an unknown origin observer marker version.`);
    }
    const record = decodeExactOriginRecord(value, runId);
    if (verifyActiveWorkflowOriginMembership(record)) records.push(record);
  }
  return records;
}

function runRecordAcknowledgesOriginObserver(
  runId: string,
  observerId: string,
  settlement: WorkflowOriginGroupSettlementReceipt,
): boolean {
  const file = runFile(runId);
  if (!existsSync(file)) return false;
  const value = readJson(file, `Workflow run ${runId}`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  if (run.id !== runId || !workflowRunIsTerminalForOriginGroup(run.status)) return false;
  const reportBack = run.reportBack;
  if (!reportBack || typeof reportBack !== 'object' || Array.isArray(reportBack)) return false;
  const envelope = reportBack as Record<string, unknown>;
  const outcome = envelope.outcome;
  const observerSettlements = envelope.acknowledgedOriginObserverSettlements;
  const observerProjection = observerSettlements
    && typeof observerSettlements === 'object'
    && !Array.isArray(observerSettlements)
    ? (observerSettlements as Record<string, unknown>)[observerId]
    : undefined;
  const projection = observerProjection
    && typeof observerProjection === 'object'
    && !Array.isArray(observerProjection)
    ? observerProjection as Record<string, unknown>
    : null;
  const settledMember = settlement.memberReportBackDigests.find(
    (member) => member.runId === runId,
  );
  const outcomeMatches = isWorkflowTerminalOutcome(run.terminalOutcome)
    ? (outcome === 'done' || outcome === 'blocked' || outcome === 'failed')
      && workflowTerminalOutcomeMatchesReport(run.terminalOutcome, outcome)
    : (
        (run.status === 'cancelled' && outcome === 'failed')
        || ((run.status === 'error' || run.status === 'failed') && (outcome === 'failed' || outcome === 'blocked'))
        || ((run.status === 'completed' || run.status === 'completed_with_errors') && (outcome === 'done' || outcome === 'blocked'))
      );
  return envelope.version === 1
    && Boolean(nonEmptyString(envelope.workflowName))
    && outcomeMatches
    && typeof envelope.detail === 'string'
    && Array.isArray(envelope.acknowledgedOriginSessionIds)
    && envelope.acknowledgedOriginSessionIds.every((sessionId) => typeof sessionId === 'string')
    && Array.isArray(envelope.acknowledgedOriginObserverIds)
    && envelope.acknowledgedOriginObserverIds.every((id) => typeof id === 'string')
    && envelope.acknowledgedOriginObserverIds.includes(observerId)
    && projection !== null
    && projection.settlementDigest === settlement.settlementDigest
    && settledMember !== undefined
    && (() => {
      const localDigest = workflowRunReportBackContentDigest({
        workflowName: String(envelope.workflowName),
        outcome: outcome as WorkflowOriginGroupTerminalStatus,
        detail: envelope.detail,
      });
      return projection.reportBackDigest === localDigest
        && settledMember.reportBackDigest === localDigest;
    })()
    && isIsoTimestamp(run.reportBackAcknowledgedAt)
    && run.reportBackRetry === undefined;
}

/** Retention guard for the preparation→close→activation window. Corrupt or
 * conflicting pins throw so callers fail closed instead of reaping evidence.
 * Active authority remains pending until the target-bound group settlement is
 * compacted into its replay tombstone. Settlement alone is insufficient: a
 * sibling may not yet own its per-run projection. */
export function workflowRunsWithPendingChatDispatchAdmissions(): ReadonlySet<string> {
  const pending = new Set<string>();
  if (!existsSync(WORKFLOW_ORIGIN_GROUPS_DIR)) return pending;
  for (const groupEntry of readdirSync(WORKFLOW_ORIGIN_GROUPS_DIR).sort()) {
    const dir = path.join(WORKFLOW_ORIGIN_GROUPS_DIR, groupEntry, 'admissions');
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir).sort();
    if (entries.some((entry) => !/^[a-f0-9]{64}\.json$/.test(entry))) {
      throw new Error('workflow chat dispatch admission index contains unknown evidence');
    }
    for (const entry of entries) {
      const admission = decodePreparationAuthority(
        readJson(path.join(dir, entry), 'Workflow chat dispatch admission retention evidence'),
      );
      if (
        groupDir(admission.sourceGroupId) !== path.dirname(dir)
        || entry !== `${admission.queueRequestDigest}.json`
      ) {
        throw new Error('workflow chat dispatch admission retention evidence has a mismatched identity');
      }
      const active = readActiveWorkflowOriginGroup(admission.sourceGroupId);
      if (active) {
        const member = active.sealed.members.find(
          (candidate) => candidate.queueRequestDigest === admission.queueRequestDigest,
        );
        if (
          !member
          || member.runId !== admission.runId
          || member.preparationDigest !== admission.preparationDigest
        ) {
          throw new Error('workflow chat dispatch admission is outside its active source group');
        }
        if (!workflowRunHasRecordedChatDispatchPreparation(admission.runId, member.receiptDigest)) {
          throw new Error('active workflow chat dispatch admission lost its preparation pin');
        }
        continue;
      }
      pending.add(admission.runId);
    }
  }
  return pending;
}

/** Destructive callers invoke this while holding the canonical run lock. It is
 * intentionally a fresh read rather than relying on an optimistic pass-wide
 * snapshot: queue admission uses the same run lock before staging. */
export function workflowRunHasPendingChatDispatchAdmission(runId: string): boolean {
  const id = validRunId(runId);
  if (!id) throw new Error('workflow run id is invalid for admission retention lookup');
  return workflowRunsWithPendingChatDispatchAdmissions().has(id);
}

/** Compatibility hold for canonical run records created before the dedicated
 * admission index. An active exact membership resolves the inline owner;
 * otherwise the record is the only restart path and cannot be reaped. */
export function workflowRunHasPendingInlineChatDispatchAdmission(
  runId: string,
  runRecord: Record<string, unknown>,
): boolean {
  const id = validRunId(runId);
  if (!id || runRecord.id !== id) {
    throw new Error('workflow run identity is invalid for inline admission lookup');
  }
  const sourceGroup = runRecord.chatDispatchSourceGroupId;
  const requestDigest = runRecord.chatDispatchQueueRequestDigest;
  if (sourceGroup === undefined && requestDigest === undefined) return false;
  const sourceGroupId = nonEmptyString(sourceGroup);
  if (!sourceGroupId || !isDigest(requestDigest)) {
    throw new Error(`Workflow run ${id} has invalid inline chat dispatch admission authority.`);
  }
  const active = readActiveWorkflowOriginGroup(sourceGroupId);
  if (!active) return true;
  const member = active.sealed.members.find(
    (candidate) => candidate.queueRequestDigest === requestDigest,
  );
  if (!member || member.runId !== id) {
    throw new Error(`Workflow run ${id} has inline admission outside its active source group.`);
  }
  return false;
}

export function workflowRunHasPendingChatDispatchPreparation(runId: string): boolean {
  const id = validRunId(runId);
  if (!id) throw new Error('workflow run id is invalid for pending preparation lookup');
  const dir = runPreparationPinDir(id);
  if (!existsSync(dir)) return false;
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    const receipt = decodeWorkflowChatDispatchPreparedReceipt(
      readJson(path.join(dir, file), `Workflow run ${id} preparation pin`),
    );
    if (receipt.runId !== id || file !== `${receipt.receiptDigest}.json`) {
      throw new Error(`Workflow run ${id} has a mismatched preparation pin.`);
    }
    const closed = readWorkflowOriginGroupClosedBatch(receipt.sourceGroupId);
    if (closed) {
      const member = closed.receipt.members.find(
        (candidate) => candidate.receiptDigest === receipt.receiptDigest,
      );
      if (!member || member.runId !== id) {
        throw new Error(`Workflow run ${id} has a preparation outside its immutable closed batch.`);
      }
    }
    const active = readActiveWorkflowOriginGroup(receipt.sourceGroupId);
    if (!active) return true;
    const activeMember = active.sealed.members.find(
      (candidate) => candidate.receiptDigest === receipt.receiptDigest,
    );
    if (!activeMember || activeMember.runId !== id) {
      throw new Error(`Workflow run ${id} has a preparation outside its active source group.`);
    }
    const settlement = readWorkflowOriginGroupSettlement(receipt.sourceGroupId);
    if (!settlement) return true;
    if (
      !settlementMatchesActiveGroup(settlement, active)
      || !settlement.memberRunIds.includes(id)
    ) {
      throw new Error(`Workflow run ${id} has a settlement outside its active source group.`);
    }
    // Compaction is the durable all-members-ack barrier and also recovers a
    // crash after the final per-run projection write. Until it succeeds, every
    // preparation pin remains a retention hold so an early member cannot be
    // reaped out from under a sibling that still needs the reducer inputs.
    try {
      const tombstone = compactSettledWorkflowOriginGroup(receipt.sourceGroupId);
      if (
        tombstone.settlement.settlementDigest !== settlement.settlementDigest
        || !tombstone.members.some((member) => member.runId === id)
      ) {
        throw new Error(`Workflow run ${id} has conflicting compacted settlement authority.`);
      }
    } catch {
      return true;
    }
  }
  return false;
}

/** Permanent authority-presence check used before any legacy report-back
 * fallback. Unlike the pending predicate, a settled group's pin still returns
 * true: while the canonical run exists, losing its exact v2 observer must be
 * treated as corruption rather than permission to reroute through mutable
 * session metadata. */
export function workflowRunHasChatDispatchPreparationAuthority(runId: string): boolean {
  const id = validRunId(runId);
  if (!id) throw new Error('workflow run id is invalid for preparation authority lookup');
  const dir = runPreparationPinDir(id);
  if (!existsSync(dir)) return false;
  const entries = readdirSync(dir).sort();
  const receiptFiles = entries.filter((entry) => entry.endsWith('.json'));
  if (entries.length !== receiptFiles.length) {
    throw new Error(`Workflow run ${id} preparation pin directory contains unknown evidence.`);
  }
  for (const entry of receiptFiles) {
    const receipt = decodeWorkflowChatDispatchPreparedReceipt(
      readJson(path.join(dir, entry), `Workflow run ${id} preparation pin`),
    );
    if (receipt.runId !== id || entry !== `${receipt.receiptDigest}.json`) {
      throw new Error(`Workflow run ${id} has a mismatched preparation pin.`);
    }
  }
  return receiptFiles.length > 0;
}

/** Read every durable preparation authority retained for one canonical run.
 * Report-back uses this index to prove that a surviving exact observer is not
 * merely a proper subset of the accepted sources that still own the run. The
 * index is intentionally empty after settled cleanup; at that point the group
 * settlement and per-run observer projections own replay instead. */
export function readWorkflowRunChatDispatchPreparations(
  runId: string,
): WorkflowChatDispatchPreparedReceipt[] {
  const id = validRunId(runId);
  if (!id) throw new Error('workflow run id is invalid for preparation authority lookup');
  const dir = runPreparationPinDir(id);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).sort();
  const receiptFiles = entries.filter((entry) => entry.endsWith('.json'));
  if (entries.length !== receiptFiles.length) {
    throw new Error(`Workflow run ${id} preparation pin directory contains unknown evidence.`);
  }
  return receiptFiles.map((entry) => {
    const receipt = decodeWorkflowChatDispatchPreparedReceipt(
      readJson(path.join(dir, entry), `Workflow run ${id} preparation pin`),
    );
    if (receipt.runId !== id || entry !== `${receipt.receiptDigest}.json`) {
      throw new Error(`Workflow run ${id} has a mismatched preparation pin.`);
    }
    return receipt;
  });
}

/** Remove only a run's preparation pins whose immutable source groups already
 * have a durable report-back acknowledgement. The run lock serializes this
 * with queue admission; malformed, unknown, or still-pending evidence is left
 * untouched. Returning zero is therefore safe for both "nothing to clean" and
 * "not settled yet" scheduler passes. */
export function cleanupSettledWorkflowRunChatDispatchPreparations(runId: string): number {
  const id = validRunId(runId);
  if (!id) throw new Error('workflow run id is invalid for settled preparation cleanup');
  return withWorkflowRunRecordLock(runFile(id), () => {
    const dir = runPreparationPinDir(id);
    if (!existsSync(dir)) return 0;
    const entries = readdirSync(dir).sort();
    const receiptFiles = entries.filter((entry) => entry.endsWith('.json'));
    if (entries.length !== receiptFiles.length) {
      throw new Error(`Workflow run ${id} preparation pin directory contains unknown evidence.`);
    }
    // This performs the complete receipt/group/ack validation. Any corruption
    // throws, while any unacknowledged group leaves every pin in place.
    if (workflowRunHasPendingChatDispatchPreparation(id)) return 0;
    for (const entry of receiptFiles) {
      const file = path.join(dir, entry);
      const receipt = decodeWorkflowChatDispatchPreparedReceipt(
        readJson(file, `Workflow run ${id} preparation pin`),
      );
      if (receipt.runId !== id || entry !== `${receipt.receiptDigest}.json`) {
        throw new Error(`Workflow run ${id} has a mismatched preparation pin.`);
      }
    }
    for (const entry of receiptFiles) unlinkSync(path.join(dir, entry));
    if (process.platform !== 'win32') {
      const dirFd = openSync(dir, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
    rmdirSync(dir);
    if (process.platform !== 'win32' && existsSync(WORKFLOW_ORIGIN_PREPARATION_PINS_DIR)) {
      const parentFd = openSync(WORKFLOW_ORIGIN_PREPARATION_PINS_DIR, 'r');
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    }
    return receiptFiles.length;
  });
}

export function workflowRunHasRecordedChatDispatchPreparation(
  runId: string,
  receiptDigest: string,
): boolean {
  const id = validRunId(runId);
  if (!id || !isDigest(receiptDigest)) {
    throw new Error('workflow run preparation identity is invalid');
  }
  const file = preparedReceiptFile(runPreparationPinDir(id), receiptDigest);
  if (!existsSync(file)) return false;
  const receipt = decodeWorkflowChatDispatchPreparedReceipt(
    readJson(file, `Workflow run ${id} preparation pin`),
  );
  if (receipt.runId !== id || receipt.receiptDigest !== receiptDigest) {
    throw new Error(`Workflow run ${id} has a mismatched preparation pin.`);
  }
  return true;
}

export function workflowRunIsTerminalForOriginGroup(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_WORKFLOW_RUN_STATUSES.has(status);
}
