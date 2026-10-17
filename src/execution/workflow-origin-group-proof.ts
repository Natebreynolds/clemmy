/** Exact workflow origin codecs and read-only directory proof.
 * No configuration, eventlog singleton, locks, recovery, or file mutations.
 * Runtime writers and explicit-home accounting share these same validators. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  exactOriginDeliveryReceiptForTarget, exactOriginDeliveryTargetDigest,
  normalizeExactOriginDeliveryTarget, sameExactOriginDeliveryTarget,
  type ExactOriginDeliveryTarget,
} from '../runtime/exact-origin-delivery.js';
import type { WorkflowParentTerminalIdentityInput } from './workflow-parent-terminal-proof-data.js';
import type {
  WorkflowRunOriginIdentity, WorkflowRunOriginObserver, WorkflowChatDispatchPreparationAuthority,
  WorkflowChatDispatchPreparedReceipt, WorkflowOriginGroupMember, WorkflowOriginGroupCloseAuthority,
  WorkflowOriginGroupClosedBatchReceipt, SealedWorkflowOriginGroup, WorkflowOriginGroupActivationReceipt,
  WorkflowOriginGroupPublicDispatch, ActiveWorkflowOriginGroup, WorkflowOriginGroupReportBackOutcome,
  WorkflowOriginGroupTerminalIdentity, WorkflowOriginGroupMemberReportBackDigest,
  WorkflowOriginGroupSettlementReceipt, WorkflowOriginGroupSettlementTerminalInput,
  WorkflowOriginGroupTombstone, ExactWorkflowRunOriginRecord,
} from './workflow-origin-group.js';

export const ORIGIN_GROUP_VERSION = 1 as const;
export const PREPARED_RECEIPT_VERSION = 1 as const;
export const EXACT_ORIGIN_RECORD_VERSION = 2 as const;
export interface WorkflowOriginGroupProofOptions {
  isWorkflowParentTerminalIdentity: (input: WorkflowParentTerminalIdentityInput) => boolean;
}

export function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function validRunId(value: unknown): string | undefined {
  const runId = nonEmptyString(value);
  return runId && runId === runId.replace(/[^a-zA-Z0-9_.:-]/g, '') ? runId : undefined;
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function hash(parts: readonly (string | number)[]): string {
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
  outcome: WorkflowOriginGroupReportBackOutcome;
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

export function decodePreparationAuthority(value: unknown): WorkflowChatDispatchPreparationAuthority {
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

export function sourceGroupDigest(input: {
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

export function sameMember(left: WorkflowOriginGroupMember, right: WorkflowOriginGroupMember): boolean {
  return left.runId === right.runId
    && left.queueRequestDigest === right.queueRequestDigest
    && left.preparationDigest === right.preparationDigest
    && left.preparedEventId === right.preparedEventId
    && left.preparedEventSeq === right.preparedEventSeq
    && left.preparedAt === right.preparedAt
    && left.receiptDigest === right.receiptDigest;
}

export function decodeGroupMembers(
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

export function workflowOriginGroupCloseDigest(input: {
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

export function decodeWorkflowOriginGroupCloseAuthority(value: unknown): WorkflowOriginGroupCloseAuthority {
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

export function decodeWorkflowOriginGroupClosedBatchReceipt(
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

export function decodeSealedGroup(value: unknown): SealedWorkflowOriginGroup {
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

export function sameSealedGroup(left: SealedWorkflowOriginGroup, right: SealedWorkflowOriginGroup): boolean {
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

export function decodeExactOriginRecord(value: unknown, expectedRunId?: string): ExactWorkflowRunOriginRecord {
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

export function sameExactOriginRecord(left: ExactWorkflowRunOriginRecord, right: ExactWorkflowRunOriginRecord): boolean {
  return left.runId === right.runId
    && left.observerId === right.observerId
    && left.originSessionId === right.originSessionId
    && left.sourceUserSeq === right.sourceUserSeq
    && left.replyTargetDigest === right.replyTargetDigest
    && left.sourceGroupId === right.sourceGroupId
    && left.sourceGroupDigest === right.sourceGroupDigest
    && sameExactOriginDeliveryTarget(left.replyTarget, right.replyTarget);
}

export function activationDigest(sealed: SealedWorkflowOriginGroup, activatedAt: string): string {
  return hash([
    'clementine-workflow-origin-group-activation:v1',
    sealed.sourceGroupId,
    sealed.sourceGroupDigest,
    ...sealed.members.map((member) => member.runId),
    activatedAt,
  ]);
}

export function decodeActivationReceipt(
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

export function publicDispatch(sealed: SealedWorkflowOriginGroup): WorkflowOriginGroupPublicDispatch {
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

export function workflowOriginGroupNotificationId(input: {
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

export function workflowOriginTerminalDigest(input: WorkflowOriginGroupSettlementTerminalInput): string {
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
    || (
      input.status !== 'done'
      && input.status !== 'blocked'
      && input.status !== 'failed'
      && input.status !== 'needs_input'
      && input.status !== 'cancelled'
    )
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

export function workflowOriginGroupSettlementDigest(
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

export function decodeWorkflowOriginGroupSettlementReceipt(
  value: unknown,
  options: WorkflowOriginGroupProofOptions,
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
    || (
      raw.terminalStatus !== 'done'
      && raw.terminalStatus !== 'blocked'
      && raw.terminalStatus !== 'failed'
      && raw.terminalStatus !== 'needs_input'
      && raw.terminalStatus !== 'cancelled'
    )
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
    || (terminalIdentity.runId !== (memberRunIds.length === 1 ? memberRunIds[0] : sourceGroupId)
      && !options.isWorkflowParentTerminalIdentity({ sourceGroupId, sourceGroupDigest: String(raw.sourceGroupDigest), terminal: terminalIdentity }))
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

export function sameWorkflowOriginGroupSettlement(
  left: WorkflowOriginGroupSettlementReceipt,
  right: WorkflowOriginGroupSettlementReceipt,
): boolean {
  return left.settlementDigest === right.settlementDigest
    && JSON.stringify(left) === JSON.stringify(right);
}

export function settlementMatchesActiveGroup(
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

export function workflowOriginGroupTombstoneDigest(
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

export function sealedFromTombstone(tombstone: WorkflowOriginGroupTombstone): SealedWorkflowOriginGroup {
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

export function activationFromTombstone(
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

export function closeReceiptFromTombstone(
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

export function preparedReceiptsFromTombstone(
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

export function activeFromTombstone(tombstone: WorkflowOriginGroupTombstone): ActiveWorkflowOriginGroup {
  const sealed = sealedFromTombstone(tombstone);
  return {
    sealed,
    activation: activationFromTombstone(tombstone, sealed),
    publicDispatch: publicDispatch(sealed),
  };
}

export function decodeWorkflowOriginGroupTombstone(value: unknown, options: WorkflowOriginGroupProofOptions): WorkflowOriginGroupTombstone {
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
    settlement: decodeWorkflowOriginGroupSettlementReceipt(raw.settlement, options),
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

export function sameWorkflowOriginGroupTombstone(
  left: WorkflowOriginGroupTombstone,
  right: WorkflowOriginGroupTombstone,
): boolean {
  return left.tombstoneDigest === right.tombstoneDigest
    && JSON.stringify(left) === JSON.stringify(right);
}

function readJson(file: string, label: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf-8')) as unknown; }
  catch (err) { throw new Error(`${label} is unreadable.`, { cause: err }); }
}

function groupDirectory(workflowRunsDir: string, sourceGroupId: string): string {
  return path.join(workflowRunsDir, '.origin-groups', createHash('sha256').update(sourceGroupId).digest('hex'));
}
function groupFile(workflowRunsDir: string, sourceGroupId: string, filename: string): string {
  return path.join(groupDirectory(workflowRunsDir, sourceGroupId), filename);
}
function runFile(workflowRunsDir: string, runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  if (!safe || safe !== runId) throw new Error(`Invalid workflow run id "${runId}".`);
  return path.join(workflowRunsDir, `${safe}.json`);
}

export function readWorkflowOriginGroupAtDirectory(workflowRunsDir: string,
  sourceGroupId: string, options: WorkflowOriginGroupProofOptions): SealedWorkflowOriginGroup | null {
  const id = nonEmptyString(sourceGroupId);
  if (!id) throw new Error('workflow origin group id is required');
  const file = groupFile(workflowRunsDir, id, 'sealed.json');
  const tombstone = readWorkflowOriginGroupTombstoneAtDirectory(workflowRunsDir, id, options);
  const compacted = tombstone ? sealedFromTombstone(tombstone) : null;
  if (!existsSync(file)) return compacted;
  const sealed = decodeSealedGroup(readJson(file, `Workflow origin group ${id}`));
  if (sealed.sourceGroupId !== id) throw new Error(`Workflow origin group ${id} has a mismatched identity.`);
  if (compacted && !sameSealedGroup(sealed, compacted)) {
    throw new Error(`Workflow origin group ${id} has conflicting sealed and compacted authority.`);
  }
  return sealed;
}

export function readWorkflowOriginGroupTombstoneAtDirectory(workflowRunsDir: string, sourceGroupId: string,
  options: WorkflowOriginGroupProofOptions): WorkflowOriginGroupTombstone | null {
  const id = nonEmptyString(sourceGroupId);
  if (!id) throw new Error('workflow origin group id is required for tombstone lookup');
  const file = groupFile(workflowRunsDir, id, 'tombstone.json');
  if (!existsSync(file)) return null;
  const tombstone = decodeWorkflowOriginGroupTombstone(readJson(file, `Workflow origin group ${id} tombstone`), options);
  if (tombstone.sourceGroupId !== id) throw new Error(`Workflow origin group ${id} tombstone has a mismatched identity.`);
  return tombstone;
}

export function readWorkflowOriginGroupSettlementAtDirectory(workflowRunsDir: string, sourceGroupId: string,
  options: WorkflowOriginGroupProofOptions): WorkflowOriginGroupSettlementReceipt | null {
  const id = nonEmptyString(sourceGroupId);
  if (!id) throw new Error('workflow origin group id is required for settlement lookup');
  const file = groupFile(workflowRunsDir, id, 'settlement.json');
  const direct = existsSync(file)
    ? decodeWorkflowOriginGroupSettlementReceipt(readJson(file, `Workflow origin group ${id} settlement`), options) : null;
  const tombstone = readWorkflowOriginGroupTombstoneAtDirectory(workflowRunsDir, id, options);
  if (direct && direct.sourceGroupId !== id) throw new Error(`Workflow origin group ${id} settlement has a mismatched identity.`);
  if (direct && tombstone && !sameWorkflowOriginGroupSettlement(direct, tombstone.settlement)) {
    throw new Error(`Workflow origin group ${id} has conflicting settlement authorities.`);
  }
  return direct ?? tombstone?.settlement ?? null;
}

export function readExactWorkflowRunOriginRecordAtDirectory(workflowRunsDir: string,
  sealed: SealedWorkflowOriginGroup, runId: string): ExactWorkflowRunOriginRecord {
  const prefix = 'workflow-origin-v2:';
  if (!sealed.observerId.startsWith(prefix) || !isDigest(sealed.observerId.slice(prefix.length))) {
    throw new Error('workflow origin observer id is invalid');
  }
  const markerFile = path.join(workflowRunsDir, '.run-origins', createHash('sha256').update(runId).digest('hex'),
    `${sealed.observerId.slice(prefix.length)}.json`);
  if (!existsSync(markerFile)) throw new Error(`Workflow origin group ${sealed.sourceGroupId} is missing member ${runId}'s exact observer.`);
  const record = decodeExactOriginRecord(readJson(markerFile, `Workflow run ${runId} exact origin marker`), runId);
  if (record.sourceGroupId !== sealed.sourceGroupId || record.sourceGroupDigest !== sealed.sourceGroupDigest
    || record.observerId !== sealed.observerId || record.replyTargetDigest !== sealed.replyTargetDigest) {
    throw new Error(`Workflow origin group ${sealed.sourceGroupId} has a mismatched member observer.`);
  }
  return record;
}

/** The full production retained-group proof, confined to an explicit directory.
 * Read-only: no recovery, activation, cleanup, lock acquisition or global home.
 * Parent terminal exceptions require the caller's exact immutable DB proof. */
export function readActiveWorkflowOriginGroupAtDirectory(workflowRunsDir: string, sourceGroupId: string,
  options: WorkflowOriginGroupProofOptions): ActiveWorkflowOriginGroup | null {
  const id = nonEmptyString(sourceGroupId);
  if (!id) throw new Error('workflow origin group id is required');
  const tombstone = readWorkflowOriginGroupTombstoneAtDirectory(workflowRunsDir, id, options);
  if (tombstone) {
    const compacted = activeFromTombstone(tombstone);
    const sealFile = groupFile(workflowRunsDir, id, 'sealed.json');
    const activationFile = groupFile(workflowRunsDir, id, 'activated.json');
    if (existsSync(sealFile)) {
      const directSealed = decodeSealedGroup(readJson(sealFile, `Workflow origin group ${id}`));
      if (!sameSealedGroup(directSealed, compacted.sealed)) {
        throw new Error(`Workflow origin group ${id} has conflicting active and compacted seals.`);
      }
    }
    if (existsSync(activationFile)) {
      const directActivation = decodeActivationReceipt(readJson(activationFile, `Workflow origin group ${id} activation receipt`), compacted.sealed);
      if (directActivation.activationDigest !== compacted.activation.activationDigest) {
        throw new Error(`Workflow origin group ${id} has conflicting active and compacted receipts.`);
      }
    }
    // Strengthening: a residual direct settlement cannot contradict the
    // tombstone simply because the compacted active branch was selected first.
    readWorkflowOriginGroupSettlementAtDirectory(workflowRunsDir, id, options);
    for (const member of compacted.sealed.members) {
      if (existsSync(runFile(workflowRunsDir, member.runId))) {
        readExactWorkflowRunOriginRecordAtDirectory(workflowRunsDir, compacted.sealed, member.runId);
      }
    }
    return compacted;
  }
  const sealed = readWorkflowOriginGroupAtDirectory(workflowRunsDir, id, options);
  if (!sealed) return null;
  const activationFile = groupFile(workflowRunsDir, sealed.sourceGroupId, 'activated.json');
  if (!existsSync(activationFile)) return null;
  const activation = decodeActivationReceipt(readJson(activationFile, `Workflow origin group ${sealed.sourceGroupId} activation receipt`), sealed);
  const active = { sealed, activation, publicDispatch: publicDispatch(sealed) };
  const settlement = readWorkflowOriginGroupSettlementAtDirectory(workflowRunsDir, sealed.sourceGroupId, options);
  // Strengthening: same-source settlement syntax alone cannot waive a reaped
  // member. Its exact seal, target and complete ordered member set must agree.
  if (settlement && !settlementMatchesActiveGroup(settlement, active)) {
    throw new Error(`Workflow origin group ${id} settlement does not match its active authority.`);
  }
  for (const member of sealed.members) {
    if (!existsSync(runFile(workflowRunsDir, member.runId)) && settlement) continue;
    readExactWorkflowRunOriginRecordAtDirectory(workflowRunsDir, sealed, member.runId);
  }
  return active;
}
