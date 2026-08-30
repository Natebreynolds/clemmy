/**
 * Durable provider-neutral authority for one sequential cursor chain.
 *
 * One activation is one workflow/run/node attempt. Pages are content-addressed
 * child calls under that activation and use the existing logical, physical,
 * settlement, immutable-port and retained-result machinery. Raw cursors remain
 * only in retained provider results and invocation arguments; authority tables
 * store their digests.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import {
  acceptedTurnCallAuthorityDigest,
  acceptedTurnCallSurfaceDigest,
  acceptedTurnSourceEventDigest,
  insertInternalEventInTransaction,
  openEventLog,
  publishCommittedInternalEvent,
  workflowPaginatedReadActivationDigest,
  workflowPaginatedReadActivationId,
  workflowPaginatedReadAuthorityRootId,
  type EventRow,
  type WorkflowPaginatedReadActivationDigestInput,
} from './eventlog.js';
import {
  WORKFLOW_PAGINATED_READ_AUTHORITY_ENGINE_VERSION,
  WORKFLOW_PAGINATED_READ_AUTHORITY_SURFACE_VERSION,
  WORKFLOW_READ_ONLY_EFFECT_CEILING,
  WORKFLOW_READ_ONLY_EFFECT_BOUNDS,
  consumeOneShotActivationAuthorizationInTransaction,
  poisonAcceptedTurnCallAuthorityInTransaction,
  readAcceptedTurnCallAuthorityInTransaction,
  type AcceptedTurnCallAuthority,
  type CallAdmissionEffect,
  type OneShotActivationAuthorization,
} from './accepted-turn-call-authority.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
} from './capability-manifest.js';
import {
  canonicalCatalogIdentityOf,
  peekHostCapabilityCatalogFactory,
} from './host-capability-catalog-factory.js';
import {
  independentlyObserveCapability,
  observationIsFresh,
} from './independent-capability-observation.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { resolveProductionPortsForManifest } from './production-capability-ports.js';
import {
  parseWorkflowNodeInvocationPlan,
  type WorkflowNodeInvocationPlanV1,
} from '../../memory/workflow-node-invocation-plan.js';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { projectProviderResultEvidenceView } from './result-facts.js';

const EFFECT_BOUNDS_JSON = JSON.stringify(WORKFLOW_READ_ONLY_EFFECT_BOUNDS);
const SHA256_RE = /^[a-f0-9]{64}$/;
const EXACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;

type HarnessDb = ReturnType<typeof openEventLog>;

export type WorkflowPaginatedAggregateState =
  | 'open'
  | 'complete'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'conflict';

export type WorkflowPageExhaustedTruth = 'true' | 'false' | 'unknown';
export type WorkflowPageContinuationState =
  | 'exhausted'
  | 'continue'
  | 'missing_cursor'
  | 'repeated_cursor'
  | 'unknown_exhaustion'
  | 'malformed_evidence';

interface ActivationRow {
  activation_id: string;
  authority_root_id: string;
  session_id: string;
  source_event_seq: number;
  source_event_id: string;
  source_event_digest: string;
  workflow_id: string;
  workflow_revision: number;
  workflow_digest: string;
  run_id: string;
  run_occurrence_id: string;
  node_id: string;
  node_attempt: number;
  invocation_plan_digest: string;
  binding_snapshot_digest: string;
  control_digest: string;
  max_pages: number;
  cursor_argument: string;
  next_cursor_path: string;
  exhausted_path: string;
  one_shot_authorization_approval_id: string | null;
  one_shot_authorization_resume_key: string | null;
  one_shot_authorization_decision_digest: string | null;
  activation_digest: string;
  aggregate_state: WorkflowPaginatedAggregateState;
  next_page_ordinal: number;
  latest_page_receipt_digest: string | null;
  terminal_aggregate_receipt_id: string | null;
  terminal_aggregate_receipt_digest: string | null;
  activated_at: string;
  closed_at: string | null;
  close_reason: string | null;
}

interface PageRow {
  activation_id: string;
  page_ordinal: number;
  prior_page_receipt_digest: string | null;
  input_cursor_digest: string | null;
  binding_identity_digest: string;
  argument_digest: string;
  logical_call_id: string;
  physical_dispatch_id: string;
  state: 'reserved' | 'settled' | 'failed' | 'uncertain' | 'cancelled' | 'conflict';
  page_receipt_id: string | null;
  page_receipt_digest: string | null;
  result_handle_id: string | null;
  settled_result_digest: string | null;
  next_cursor_digest: string | null;
  provider_exhausted_truth: WorkflowPageExhaustedTruth | null;
  item_count: number | null;
  evidence_digest: string | null;
  evidence_valid: number | null;
  continuation_state: WorkflowPageContinuationState | null;
  reserved_at: string;
  settled_at: string | null;
}

interface AggregateRow {
  aggregate_receipt_id: string;
  activation_id: string;
  activation_digest: string;
  authority_root_id: string;
  invocation_plan_digest: string;
  binding_snapshot_digest: string;
  control_digest: string;
  page_receipt_digests_json: string;
  page_result_handles_json: string;
  page_count: number;
  total_item_count: number;
  final_exhausted_truth: WorkflowPageExhaustedTruth | 'none';
  coverage_state: 'complete' | 'partial' | 'unknown';
  outcome: Exclude<WorkflowPaginatedAggregateState, 'open'>;
  reason: string;
  aggregate_receipt_digest: string;
  created_at: string;
}

export interface WorkflowPaginatedReadAuthorityRef {
  sessionId: string;
  sourceEventSeq: number;
  sourceEventId: string;
  sourceEventDigest: string;
  authorityRootId: string;
  activationId: string;
  activationDigest: string;
  workflowId: string;
  workflowRevision: number;
  workflowDigest: string;
  runId: string;
  runOccurrenceId: string;
  nodeId: string;
  nodeAttempt: number;
  invocationPlanDigest: string;
  bindingSnapshotDigest: string;
  controlDigest: string;
  maxPages: number;
  cursorArgument: string;
  nextCursorPath: string;
  exhaustedPath: string;
  aggregateState: WorkflowPaginatedAggregateState;
  nextPageOrdinal: number;
  latestPageReceiptDigest: string | null;
  terminalAggregateReceiptId: string | null;
  terminalAggregateReceiptDigest: string | null;
  authorityDigest: string;
  authorityRevision: number;
}

export interface WorkflowReadPageRef {
  activationId: string;
  activationDigest: string;
  authorityRootId: string;
  sessionId: string;
  sourceEventSeq: number;
  nodeId: string;
  pageOrdinal: number;
  priorPageReceiptDigest: string | null;
  inputCursorDigest: string | null;
  bindingIdentityDigest: string;
  argumentDigest: string;
  logicalCallId: string;
  physicalDispatchId: string;
  state: PageRow['state'];
  pageReceiptDigest: string | null;
  resultHandleId: string | null;
  authorityDigest: string;
  authorityRevision: number;
}

export interface WorkflowPaginatedAggregateReceipt {
  aggregateReceiptId: string;
  aggregateReceiptDigest: string;
  activationId: string;
  activationDigest: string;
  authorityRootId: string;
  invocationPlanDigest: string;
  bindingSnapshotDigest: string;
  controlDigest: string;
  pageReceiptDigests: string[];
  pageResultHandleIds: string[];
  pageCount: number;
  totalItemCount: number;
  finalExhaustedTruth: WorkflowPageExhaustedTruth | 'none';
  coverageState: 'complete' | 'partial' | 'unknown';
  outcome: Exclude<WorkflowPaginatedAggregateState, 'open'>;
  reason: string;
  createdAt: string;
}

export interface ArmWorkflowPaginatedReadAuthorityInput {
  sessionId: string;
  workflowId: string;
  workflowRevision: number;
  workflowDigest: string;
  runId: string;
  runOccurrenceId: string;
  nodeId: string;
  nodeAttempt: number;
  invocationPlan: unknown;
  bindingSnapshotDigest: string;
  controlDigest: string;
  oneShotActivationAuthorization?: OneShotActivationAuthorization;
}

export type ArmWorkflowPaginatedReadAuthorityResult =
  | {
      status: 'armed' | 'existing' | 'existing_closed';
      authority: AcceptedTurnCallAuthority;
      ref: WorkflowPaginatedReadAuthorityRef;
    }
  | { status: 'missing' | 'conflict' | 'storage_error'; reason: string };

export type ReadWorkflowPaginatedReadAuthorityResult =
  | { status: 'ok'; authority: AcceptedTurnCallAuthority; ref: WorkflowPaginatedReadAuthorityRef }
  | { status: 'missing' | 'conflict' | 'storage_error'; reason: string };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').trim().slice(0, 240);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function exactId(value: string): boolean {
  return value === value.trim() && EXACT_ID_RE.test(value);
}

function activationRow(db: HarnessDb, activationId: string): ActivationRow | undefined {
  return db.prepare(`SELECT * FROM workflow_paginated_read_activations WHERE activation_id = ?`)
    .get(activationId) as ActivationRow | undefined;
}

function pageRow(db: HarnessDb, activationId: string, pageOrdinal: number): PageRow | undefined {
  return db.prepare(`
    SELECT * FROM workflow_paginated_read_pages
     WHERE activation_id = ? AND page_ordinal = ?
  `).get(activationId, pageOrdinal) as PageRow | undefined;
}

function activationDigestInput(
  input: ArmWorkflowPaginatedReadAuthorityInput,
  plan: WorkflowNodeInvocationPlanV1,
): WorkflowPaginatedReadActivationDigestInput {
  if (plan.continuation.kind !== 'cursor') throw new Error('paginated plan lacks cursor continuation');
  return {
    workflowId: input.workflowId,
    workflowRevision: input.workflowRevision,
    workflowDigest: input.workflowDigest,
    runId: input.runId,
    runOccurrenceId: input.runOccurrenceId,
    nodeId: input.nodeId,
    nodeAttempt: input.nodeAttempt,
    invocationPlanDigest: plan.bindingDigest,
    bindingSnapshotDigest: input.bindingSnapshotDigest,
    controlDigest: input.controlDigest,
    maxPages: plan.continuation.maxPages,
    cursorArgument: plan.continuation.cursorArgument,
    nextCursorPath: plan.continuation.nextCursorPath,
    exhaustedPath: plan.continuation.exhaustedPath,
    ...(input.oneShotActivationAuthorization
      ? { oneShotActivationAuthorization: { ...input.oneShotActivationAuthorization } }
      : {}),
  };
}

function activationInputFromRow(row: ActivationRow): WorkflowPaginatedReadActivationDigestInput {
  return {
    workflowId: row.workflow_id,
    workflowRevision: row.workflow_revision,
    workflowDigest: row.workflow_digest,
    runId: row.run_id,
    runOccurrenceId: row.run_occurrence_id,
    nodeId: row.node_id,
    nodeAttempt: row.node_attempt,
    invocationPlanDigest: row.invocation_plan_digest,
    bindingSnapshotDigest: row.binding_snapshot_digest,
    controlDigest: row.control_digest,
    maxPages: row.max_pages,
    cursorArgument: row.cursor_argument,
    nextCursorPath: row.next_cursor_path,
    exhaustedPath: row.exhausted_path,
    ...(row.one_shot_authorization_approval_id
      && row.one_shot_authorization_resume_key
      && row.one_shot_authorization_decision_digest
      ? {
          oneShotActivationAuthorization: {
            approvalId: row.one_shot_authorization_approval_id,
            resumeKey: row.one_shot_authorization_resume_key,
            decisionDigest: row.one_shot_authorization_decision_digest,
          },
        }
      : {}),
  };
}

function validArmInput(
  input: ArmWorkflowPaginatedReadAuthorityInput,
): { ok: true; plan: WorkflowNodeInvocationPlanV1 } | { ok: false; reason: string } {
  const parsed = parseWorkflowNodeInvocationPlan(input.invocationPlan);
  if (!parsed.ok) return { ok: false, reason: 'paginated workflow invocation plan is malformed' };
  if (
    parsed.plan.binding.effect !== 'read'
    || parsed.plan.continuation.kind !== 'cursor'
    || parsed.plan.completeness.kind !== 'finite_exhaustive'
  ) return { ok: false, reason: 'paginated workflow authority requires an exact finite cursor read plan' };
  const authorization = input.oneShotActivationAuthorization;
  if (
    !exactId(input.sessionId)
    || !exactId(input.workflowId)
    || !Number.isSafeInteger(input.workflowRevision) || input.workflowRevision <= 0
    || !isSha256(input.workflowDigest)
    || !exactId(input.runId)
    || !exactId(input.runOccurrenceId)
    || !exactId(input.nodeId)
    || !Number.isSafeInteger(input.nodeAttempt) || input.nodeAttempt <= 0
    || !isSha256(input.bindingSnapshotDigest)
    || !isSha256(input.controlDigest)
    || (authorization !== undefined && (
      authorization.approvalId !== authorization.approvalId.trim()
      || authorization.approvalId.length < 1 || authorization.approvalId.length > 128
      || authorization.resumeKey !== authorization.resumeKey.trim()
      || authorization.resumeKey.length < 1 || authorization.resumeKey.length > 1024
      || !isSha256(authorization.decisionDigest)
    ))
  ) return { ok: false, reason: 'paginated workflow call-authority input is invalid' };
  return { ok: true, plan: parsed.plan };
}

function rowsMatchInput(
  row: ActivationRow,
  input: ArmWorkflowPaginatedReadAuthorityInput,
  plan: WorkflowNodeInvocationPlanV1,
  digest: string,
): boolean {
  if (plan.continuation.kind !== 'cursor') return false;
  return row.activation_id === workflowPaginatedReadActivationId(digest)
    && row.authority_root_id === workflowPaginatedReadAuthorityRootId(digest)
    && row.session_id === input.sessionId
    && row.workflow_id === input.workflowId
    && row.workflow_revision === input.workflowRevision
    && row.workflow_digest === input.workflowDigest
    && row.run_id === input.runId
    && row.run_occurrence_id === input.runOccurrenceId
    && row.node_id === input.nodeId
    && row.node_attempt === input.nodeAttempt
    && row.invocation_plan_digest === plan.bindingDigest
    && row.binding_snapshot_digest === input.bindingSnapshotDigest
    && row.control_digest === input.controlDigest
    && row.max_pages === plan.continuation.maxPages
    && row.cursor_argument === plan.continuation.cursorArgument
    && row.next_cursor_path === plan.continuation.nextCursorPath
    && row.exhausted_path === plan.continuation.exhaustedPath
    && row.one_shot_authorization_approval_id
      === (input.oneShotActivationAuthorization?.approvalId ?? null)
    && row.one_shot_authorization_resume_key
      === (input.oneShotActivationAuthorization?.resumeKey ?? null)
    && row.one_shot_authorization_decision_digest
      === (input.oneShotActivationAuthorization?.decisionDigest ?? null)
    && row.activation_digest === digest;
}

function refFrom(
  authority: AcceptedTurnCallAuthority,
  activation: ActivationRow,
): WorkflowPaginatedReadAuthorityRef | null {
  if (
    authority.authorityKind !== 'workflow_v2_paginated_read'
    || authority.identity.sessionId !== activation.session_id
    || authority.identity.sourceUserSeq !== activation.source_event_seq
    || authority.identity.acceptedTaskId !== activation.authority_root_id
    || authority.paginatedWorkflow?.activationId !== activation.activation_id
  ) return null;
  return {
    sessionId: activation.session_id,
    sourceEventSeq: activation.source_event_seq,
    sourceEventId: activation.source_event_id,
    sourceEventDigest: activation.source_event_digest,
    authorityRootId: activation.authority_root_id,
    activationId: activation.activation_id,
    activationDigest: activation.activation_digest,
    workflowId: activation.workflow_id,
    workflowRevision: activation.workflow_revision,
    workflowDigest: activation.workflow_digest,
    runId: activation.run_id,
    runOccurrenceId: activation.run_occurrence_id,
    nodeId: activation.node_id,
    nodeAttempt: activation.node_attempt,
    invocationPlanDigest: activation.invocation_plan_digest,
    bindingSnapshotDigest: activation.binding_snapshot_digest,
    controlDigest: activation.control_digest,
    maxPages: activation.max_pages,
    cursorArgument: activation.cursor_argument,
    nextCursorPath: activation.next_cursor_path,
    exhaustedPath: activation.exhausted_path,
    aggregateState: activation.aggregate_state,
    nextPageOrdinal: activation.next_page_ordinal,
    latestPageReceiptDigest: activation.latest_page_receipt_digest,
    terminalAggregateReceiptId: activation.terminal_aggregate_receipt_id,
    terminalAggregateReceiptDigest: activation.terminal_aggregate_receipt_digest,
    authorityDigest: authority.authorityDigest,
    authorityRevision: authority.revision,
  };
}

function readInTransaction(
  db: HarnessDb,
  activationId: string,
): ReadWorkflowPaginatedReadAuthorityResult {
  const activation = activationRow(db, activationId);
  if (!activation) return { status: 'missing', reason: 'paginated workflow activation is missing' };
  if (
    workflowPaginatedReadActivationDigest(activationInputFromRow(activation)) !== activation.activation_digest
    || workflowPaginatedReadActivationId(activation.activation_digest) !== activation.activation_id
    || workflowPaginatedReadAuthorityRootId(activation.activation_digest) !== activation.authority_root_id
  ) return { status: 'conflict', reason: 'paginated workflow activation digest does not recompute' };
  const loaded = readAcceptedTurnCallAuthorityInTransaction(
    db,
    activation.session_id,
    activation.source_event_seq,
  );
  if (loaded.status !== 'ok') return loaded;
  const ref = refFrom(loaded.authority, activation);
  if (!ref) return { status: 'conflict', reason: 'paginated activation has a different authority root' };
  return { status: 'ok', authority: loaded.authority, ref };
}

export function readWorkflowPaginatedReadAuthority(
  activationId: string,
): ReadWorkflowPaginatedReadAuthorityResult {
  if (!activationId.trim()) return { status: 'missing', reason: 'paginated workflow activation id is missing' };
  try {
    return readInTransaction(openEventLog(), activationId);
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export function armWorkflowPaginatedReadAuthority(
  input: ArmWorkflowPaginatedReadAuthorityInput,
): ArmWorkflowPaginatedReadAuthorityResult {
  const valid = validArmInput(input);
  if (!valid.ok) return { status: 'conflict', reason: valid.reason };
  const { plan } = valid;
  const digestInput = activationDigestInput(input, plan);
  const activationDigest = workflowPaginatedReadActivationDigest(digestInput);
  const activationId = workflowPaginatedReadActivationId(activationDigest);
  const authorityRootId = workflowPaginatedReadAuthorityRootId(activationDigest);
  const db = openEventLog();
  let activationEvent: EventRow | null = null;
  try {
    const transaction = db.transaction((): ArmWorkflowPaginatedReadAuthorityResult => {
      const session = db.prepare('SELECT kind FROM sessions WHERE id = ?').get(input.sessionId) as {
        kind: string;
      } | undefined;
      if (!session) return { status: 'missing', reason: 'paginated workflow activation session is missing' };
      if (session.kind !== 'workflow') {
        return { status: 'conflict', reason: 'paginated workflow activation requires a workflow session' };
      }
      const existing = activationRow(db, activationId);
      if (existing) {
        if (!rowsMatchInput(existing, input, plan, activationDigest)) {
          return { status: 'conflict', reason: 'paginated workflow content address conflicts with its identity' };
        }
        const loaded = readInTransaction(db, activationId);
        if (loaded.status !== 'ok') return loaded;
        return {
          status: existing.aggregate_state === 'open' ? 'existing' : 'existing_closed',
          authority: loaded.authority,
          ref: loaded.ref,
        };
      }
      const foreign = db.prepare(`
        SELECT activation_id FROM workflow_paginated_read_activations
         WHERE workflow_id = ? AND workflow_revision = ? AND run_id = ?
           AND run_occurrence_id = ? AND node_id = ? AND node_attempt = ?
        UNION ALL
        SELECT activation_id FROM workflow_node_invocation_activations
         WHERE workflow_id = ? AND workflow_revision = ? AND run_id = ?
           AND run_occurrence_id = ? AND node_id = ? AND node_attempt = ?
        LIMIT 1
      `).get(
        input.workflowId, input.workflowRevision, input.runId,
        input.runOccurrenceId, input.nodeId, input.nodeAttempt,
        input.workflowId, input.workflowRevision, input.runId,
        input.runOccurrenceId, input.nodeId, input.nodeAttempt,
      ) as { activation_id: string } | undefined;
      if (foreign) return { status: 'conflict', reason: 'workflow node attempt already has a different activation' };
      if (input.oneShotActivationAuthorization) {
        const consumed = consumeOneShotActivationAuthorizationInTransaction(
          db,
          input.oneShotActivationAuthorization,
        );
        if (!consumed.ok) return { status: 'conflict', reason: consumed.reason };
      }
      activationEvent = insertInternalEventInTransaction(db, {
        sessionId: input.sessionId,
        turn: 0,
        role: 'system',
        type: 'workflow_paginated_read_activated',
        data: {
          protocolVersion: 1,
          activationId,
          authorityRootId,
          activationDigest,
          workflowId: input.workflowId,
          workflowRevision: input.workflowRevision,
          workflowDigest: input.workflowDigest,
          runId: input.runId,
          runOccurrenceId: input.runOccurrenceId,
          nodeId: input.nodeId,
          nodeAttempt: input.nodeAttempt,
          invocationPlanDigest: plan.bindingDigest,
          bindingSnapshotDigest: input.bindingSnapshotDigest,
          controlDigest: input.controlDigest,
          maxPages: plan.continuation.kind === 'cursor' ? plan.continuation.maxPages : 0,
          cursorArgument: plan.continuation.kind === 'cursor' ? plan.continuation.cursorArgument : '',
          nextCursorPath: plan.continuation.kind === 'cursor' ? plan.continuation.nextCursorPath : '',
          exhaustedPath: plan.continuation.kind === 'cursor' ? plan.continuation.exhaustedPath : '',
          ...(input.oneShotActivationAuthorization
            ? { oneShotActivationAuthorization: { ...input.oneShotActivationAuthorization } }
            : {}),
        },
      });
      const sourceEventDigest = acceptedTurnSourceEventDigest({
        id: activationEvent.id,
        sessionId: activationEvent.sessionId,
        seq: activationEvent.seq,
        turn: activationEvent.turn,
        role: activationEvent.role,
        type: activationEvent.type,
        parentEventId: activationEvent.parentEventId,
        dataJson: JSON.stringify(activationEvent.data),
        createdAt: activationEvent.createdAt,
      });
      db.prepare(`
        INSERT INTO workflow_paginated_read_activations (
          activation_id, authority_root_id, session_id, source_event_seq,
          source_event_id, source_event_digest, workflow_id, workflow_revision,
          workflow_digest, run_id, run_occurrence_id, node_id, node_attempt,
          invocation_plan_digest, binding_snapshot_digest, control_digest,
          max_pages, cursor_argument, next_cursor_path, exhausted_path,
          one_shot_authorization_approval_id, one_shot_authorization_resume_key,
          one_shot_authorization_decision_digest, activation_digest, activated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        activationId, authorityRootId, input.sessionId, activationEvent.seq,
        activationEvent.id, sourceEventDigest, input.workflowId, input.workflowRevision,
        input.workflowDigest, input.runId, input.runOccurrenceId, input.nodeId,
        input.nodeAttempt, plan.bindingDigest, input.bindingSnapshotDigest,
        input.controlDigest, plan.continuation.kind === 'cursor' ? plan.continuation.maxPages : 0,
        plan.continuation.kind === 'cursor' ? plan.continuation.cursorArgument : '',
        plan.continuation.kind === 'cursor' ? plan.continuation.nextCursorPath : '',
        plan.continuation.kind === 'cursor' ? plan.continuation.exhaustedPath : '',
        input.oneShotActivationAuthorization?.approvalId ?? null,
        input.oneShotActivationAuthorization?.resumeKey ?? null,
        input.oneShotActivationAuthorization?.decisionDigest ?? null,
        activationDigest, activationEvent.createdAt,
      );
      const workflowFields = {
        workflowActivationId: null,
        workflowActivationDigest: activationDigest,
        workflowId: input.workflowId,
        workflowRevision: input.workflowRevision,
        workflowDigest: input.workflowDigest,
        runId: input.runId,
        runOccurrenceId: input.runOccurrenceId,
        workflowNodeId: input.nodeId,
        workflowNodeAttempt: input.nodeAttempt,
        invocationPlanDigest: plan.bindingDigest,
        bindingSnapshotDigest: input.bindingSnapshotDigest,
        controlDigest: input.controlDigest,
        workflowLogicalCallId: null,
      } as const;
      const maxPages = plan.continuation.kind === 'cursor' ? plan.continuation.maxPages : 0;
      const surfaceDigest = acceptedTurnCallSurfaceDigest({
        authorityKind: 'workflow_v2_paginated_read',
        engineVersion: WORKFLOW_PAGINATED_READ_AUTHORITY_ENGINE_VERSION,
        surfaceVersion: WORKFLOW_PAGINATED_READ_AUTHORITY_SURFACE_VERSION,
        effectCeiling: WORKFLOW_READ_ONLY_EFFECT_CEILING,
        effectBoundsJson: EFFECT_BOUNDS_JSON,
        maxLogicalCalls: maxPages,
        maxParallelCalls: 1,
        catalogRevisionDigest: input.bindingSnapshotDigest,
        bindingRevisionDigest: plan.bindingDigest,
        graphEventId: null,
        graphHash: null,
        ...workflowFields,
      });
      const authorityDigest = acceptedTurnCallAuthorityDigest({
        authorityKind: 'workflow_v2_paginated_read',
        sessionId: input.sessionId,
        sourceUserSeq: activationEvent.seq,
        acceptedTaskId: authorityRootId,
        sourceEventId: activationEvent.id,
        sourceEventDigest,
        sourceTurn: 0,
        engineVersion: WORKFLOW_PAGINATED_READ_AUTHORITY_ENGINE_VERSION,
        surfaceVersion: WORKFLOW_PAGINATED_READ_AUTHORITY_SURFACE_VERSION,
        surfaceDigest,
        effectCeiling: WORKFLOW_READ_ONLY_EFFECT_CEILING,
        effectBoundsJson: EFFECT_BOUNDS_JSON,
        maxLogicalCalls: maxPages,
        maxParallelCalls: 1,
        catalogRevisionDigest: input.bindingSnapshotDigest,
        bindingRevisionDigest: plan.bindingDigest,
        graphEventId: null,
        graphHash: null,
        ...workflowFields,
      });
      db.prepare(`
        INSERT INTO accepted_turn_call_authorities (
          session_id, source_user_seq, accepted_task_id, authority_protocol,
          authority_kind, source_event_id, source_event_digest, source_turn,
          engine_version, surface_version, surface_digest, effect_ceiling,
          effect_bounds_json, max_logical_calls, max_parallel_calls,
          catalog_revision_digest, binding_revision_digest, graph_event_id,
          graph_hash, workflow_activation_id, workflow_activation_digest,
          workflow_id, workflow_revision, workflow_digest, run_id,
          run_occurrence_id, workflow_node_id, workflow_node_attempt,
          invocation_plan_digest, binding_snapshot_digest, control_digest,
          workflow_logical_call_id, authority_digest, state, revision, opened_at
        ) VALUES (
          ?, ?, ?, 1, 'workflow_v2_paginated_read', ?, ?, 0,
          ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, NULL, ?, 'open', 0, ?
        )
      `).run(
        input.sessionId, activationEvent.seq, authorityRootId,
        activationEvent.id, sourceEventDigest,
        WORKFLOW_PAGINATED_READ_AUTHORITY_ENGINE_VERSION,
        WORKFLOW_PAGINATED_READ_AUTHORITY_SURFACE_VERSION,
        surfaceDigest, WORKFLOW_READ_ONLY_EFFECT_CEILING, EFFECT_BOUNDS_JSON,
        maxPages, input.bindingSnapshotDigest, plan.bindingDigest,
        activationDigest, input.workflowId, input.workflowRevision,
        input.workflowDigest, input.runId, input.runOccurrenceId,
        input.nodeId, input.nodeAttempt, plan.bindingDigest,
        input.bindingSnapshotDigest, input.controlDigest, authorityDigest,
        activationEvent.createdAt,
      );
      const loaded = readInTransaction(db, activationId);
      if (loaded.status !== 'ok') {
        throw new Error(`armed paginated workflow authority is ${loaded.status}: ${loaded.reason}`);
      }
      return { status: 'armed', authority: loaded.authority, ref: loaded.ref };
    });
    const result = transaction.immediate();
    if (result.status === 'armed' && activationEvent) publishCommittedInternalEvent(activationEvent);
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

function bindingIdentityDigest(plan: WorkflowNodeInvocationPlanV1): string {
  return sha256(closedCanonicalJson({
    capabilityId: plan.binding.capabilityId,
    manifestId: plan.binding.manifestId,
    manifestDigest: plan.binding.manifestDigest,
    operationId: plan.binding.operationId,
    operationVersion: plan.binding.operationVersion,
    schemaDigest: plan.binding.schemaDigest,
    providerVersion: plan.binding.providerVersion,
    liveFingerprint: plan.binding.liveFingerprint,
    accountId: plan.binding.accountId,
    effect: plan.binding.effect,
    invokePortId: plan.binding.invokePortId,
    argumentCompiler: plan.binding.argumentCompiler,
  }));
}

function cursorDigest(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim().length === 0) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (
    typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === 0
  ) return null;
  try {
    return sha256(closedCanonicalJson(value, {
      maxDepth: 16,
      maxNodes: 2_000,
      maxStringBytes: 16_384,
      maxTotalBytes: 64_000,
    }));
  } catch {
    return null;
  }
}

function pageIdentity(input: {
  activationDigest: string;
  pageOrdinal: number;
  priorPageReceiptDigest: string | null;
  inputCursorDigest: string | null;
  argumentDigest: string;
  bindingIdentityDigest: string;
}): { logicalCallId: string; physicalDispatchId: string } {
  const digest = sha256(closedCanonicalJson({ version: 1, ...input }));
  return {
    logicalCallId: `workflow-page:${digest}`,
    physicalDispatchId: `workflow-page-dispatch:${digest}`,
  };
}

function pageRef(
  authority: WorkflowPaginatedReadAuthorityRef,
  row: PageRow,
): WorkflowReadPageRef {
  return {
    activationId: authority.activationId,
    activationDigest: authority.activationDigest,
    authorityRootId: authority.authorityRootId,
    sessionId: authority.sessionId,
    sourceEventSeq: authority.sourceEventSeq,
    nodeId: authority.nodeId,
    pageOrdinal: row.page_ordinal,
    priorPageReceiptDigest: row.prior_page_receipt_digest,
    inputCursorDigest: row.input_cursor_digest,
    bindingIdentityDigest: row.binding_identity_digest,
    argumentDigest: row.argument_digest,
    logicalCallId: row.logical_call_id,
    physicalDispatchId: row.physical_dispatch_id,
    state: row.state,
    pageReceiptDigest: row.page_receipt_digest,
    resultHandleId: row.result_handle_id,
    authorityDigest: authority.authorityDigest,
    authorityRevision: authority.authorityRevision,
  };
}

export type ReserveWorkflowReadPageResult =
  | { status: 'reserved' | 'replayed'; ref: WorkflowReadPageRef }
  | {
      status: 'closed' | 'budget_exhausted' | 'repeated_cursor' | 'missing' | 'conflict' | 'storage_error';
      reason: string;
    };

/** Reserve exactly the next child call. A nonzero page's cursor must equal the
 * prior settled page's next-cursor digest; callers cannot invent a continuation. */
export function reserveWorkflowReadPage(input: {
  activationId: string;
  pageOrdinal: number;
  priorPageReceiptDigest: string | null;
  invocationPlan: unknown;
  args: Record<string, unknown>;
}): ReserveWorkflowReadPageResult {
  const parsed = parseWorkflowNodeInvocationPlan(input.invocationPlan);
  if (!parsed.ok || parsed.plan.continuation.kind !== 'cursor') {
    return { status: 'conflict', reason: 'paginated page reservation requires an exact cursor plan' };
  }
  const continuation = parsed.plan.continuation;
  if (!Number.isSafeInteger(input.pageOrdinal) || input.pageOrdinal < 0 || input.pageOrdinal > 9_999) {
    return { status: 'conflict', reason: 'paginated page ordinal is invalid' };
  }
  try {
    const db = openEventLog();
    return db.transaction((): ReserveWorkflowReadPageResult => {
      const loaded = readInTransaction(db, input.activationId);
      if (loaded.status !== 'ok') return loaded;
      const { ref } = loaded;
      if (loaded.authority.state !== 'open' || ref.aggregateState !== 'open') {
        return { status: 'closed', reason: 'paginated workflow authority is closed' };
      }
      if (
        parsed.plan.bindingDigest !== ref.invocationPlanDigest
        || parsed.plan.binding.effect !== 'read'
        || continuation.maxPages !== ref.maxPages
        || continuation.cursorArgument !== ref.cursorArgument
        || continuation.nextCursorPath !== ref.nextCursorPath
        || continuation.exhaustedPath !== ref.exhaustedPath
      ) return { status: 'conflict', reason: 'paginated page plan differs from its activation' };
      if (Object.getOwnPropertySymbols(input.args).length > 0) {
        return { status: 'conflict', reason: 'paginated page arguments are not closed JSON' };
      }
      const ownsCursor = Object.prototype.hasOwnProperty.call(input.args, ref.cursorArgument);
      const inputCursorDigest = ownsCursor ? cursorDigest(input.args[ref.cursorArgument]) : null;
      if ((input.pageOrdinal === 0 && ownsCursor) || (input.pageOrdinal > 0 && !inputCursorDigest)) {
        return { status: 'conflict', reason: 'paginated cursor overlay does not match the page ordinal' };
      }
      const contract = durableLogicalCallContract(
        ref.authorityRootId,
        parsed.plan.binding.operationId,
        input.args,
      );
      if (!contract) return { status: 'conflict', reason: 'paginated page arguments are not canonical' };
      const bindingDigest = bindingIdentityDigest(parsed.plan);
      const ids = pageIdentity({
        activationDigest: ref.activationDigest,
        pageOrdinal: input.pageOrdinal,
        priorPageReceiptDigest: input.priorPageReceiptDigest,
        inputCursorDigest,
        argumentDigest: contract.argumentDigest,
        bindingIdentityDigest: bindingDigest,
      });
      const existing = pageRow(db, input.activationId, input.pageOrdinal);
      if (existing) {
        const exact = existing.prior_page_receipt_digest === input.priorPageReceiptDigest
          && existing.input_cursor_digest === inputCursorDigest
          && existing.binding_identity_digest === bindingDigest
          && existing.argument_digest === contract.argumentDigest
          && existing.logical_call_id === ids.logicalCallId
          && existing.physical_dispatch_id === ids.physicalDispatchId;
        return exact
          ? { status: 'replayed', ref: pageRef(ref, existing) }
          : { status: 'conflict', reason: 'paginated page ordinal already has a different child authority' };
      }
      if (input.pageOrdinal >= ref.maxPages) {
        return { status: 'budget_exhausted', reason: 'paginated workflow page budget is exhausted' };
      }
      if (input.pageOrdinal !== ref.nextPageOrdinal) {
        return { status: 'conflict', reason: 'paginated page reservation is not the exact next ordinal' };
      }
      if (input.pageOrdinal === 0) {
        if (input.priorPageReceiptDigest !== null || ref.latestPageReceiptDigest !== null) {
          return { status: 'conflict', reason: 'paginated first page cannot name prior receipt authority' };
        }
      } else {
        const prior = pageRow(db, input.activationId, input.pageOrdinal - 1);
        if (
          !prior
          || prior.state !== 'settled'
          || prior.page_receipt_digest !== input.priorPageReceiptDigest
          || prior.page_receipt_digest !== ref.latestPageReceiptDigest
          || prior.next_cursor_digest !== inputCursorDigest
          || prior.continuation_state !== 'continue'
        ) return { status: 'conflict', reason: 'paginated page does not continue its exact settled predecessor' };
        const visited = db.prepare(`
          SELECT first_page_ordinal FROM workflow_paginated_cursor_visits
           WHERE activation_id = ? AND cursor_digest = ?
        `).get(input.activationId, inputCursorDigest) as { first_page_ordinal: number } | undefined;
        if (visited) {
          return { status: 'repeated_cursor', reason: 'paginated cursor was already visited' };
        }
      }
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO workflow_paginated_read_pages (
          activation_id, page_ordinal, prior_page_receipt_digest,
          input_cursor_digest, binding_identity_digest, argument_digest,
          logical_call_id, physical_dispatch_id, reserved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.activationId, input.pageOrdinal, input.priorPageReceiptDigest,
        inputCursorDigest, bindingDigest, contract.argumentDigest,
        ids.logicalCallId, ids.physicalDispatchId, now,
      );
      if (input.pageOrdinal > 0 && inputCursorDigest) {
        db.prepare(`
          INSERT INTO workflow_paginated_cursor_visits (
            activation_id, cursor_digest, first_page_ordinal, visited_at
          ) VALUES (?, ?, ?, ?)
        `).run(input.activationId, inputCursorDigest, input.pageOrdinal, now);
      }
      const advanced = db.prepare(`
        UPDATE workflow_paginated_read_activations
           SET next_page_ordinal = next_page_ordinal + 1
         WHERE activation_id = ? AND aggregate_state = 'open'
           AND next_page_ordinal = ?
      `).run(input.activationId, input.pageOrdinal).changes;
      if (advanced !== 1) throw new Error('paginated page reservation lost its activation CAS');
      const row = pageRow(db, input.activationId, input.pageOrdinal);
      if (!row) throw new Error('reserved paginated page disappeared');
      return { status: 'reserved', ref: pageRef({ ...ref, nextPageOrdinal: ref.nextPageOrdinal + 1 }, row) };
    }).immediate();
  } catch (error) {
    const reason = boundedReason(error);
    return reason.includes('UNIQUE constraint failed: workflow_paginated_cursor_visits')
      ? { status: 'repeated_cursor', reason: 'paginated cursor was already visited' }
      : { status: 'storage_error', reason };
  }
}

interface WorkflowReadPageAttestation {
  sessionId: string;
  sourceEventSeq: number;
  authorityRootId: string;
  activationId: string;
  activationDigest: string;
  authorityDigest: string;
  authorityRevision: number;
  pageOrdinal: number;
  priorPageReceiptDigest: string | null;
  inputCursorDigest: string | null;
  bindingIdentityDigest: string;
  logicalCallId: string;
  physicalDispatchId: string;
  toolName: string;
  operationId: string;
  argumentDigest: string;
  capabilityId: string;
  manifestId: string;
  manifestDigest: string;
  operationVersion: string;
  schemaDigest: string;
  providerVersion: string;
  liveFingerprint: string;
  accountId: string;
  invokePortId: string;
  argumentCompilerId: string;
  argumentCompilerVersion: string;
}

export interface WorkflowReadPageAttestationProof {
  readonly kind: 'workflow_v2_paginated_read_page_attestation';
  readonly activationId: string;
  readonly pageOrdinal: number;
  readonly logicalCallId: string;
}

const pageProofs = new WeakMap<object, Readonly<WorkflowReadPageAttestation>>();
const pageAttestationStorage = new AsyncLocalStorage<Readonly<WorkflowReadPageAttestation>>();

export function withWorkflowReadPageAttestation<T>(
  proof: WorkflowReadPageAttestationProof,
  work: () => T,
): T {
  const attestation = pageProofs.get(proof as object);
  if (!attestation) throw new Error('paginated workflow page attestation proof is not authentic');
  if (
    proof.kind !== 'workflow_v2_paginated_read_page_attestation'
    || proof.activationId !== attestation.activationId
    || proof.pageOrdinal !== attestation.pageOrdinal
    || proof.logicalCallId !== attestation.logicalCallId
  ) throw new Error('paginated workflow page attestation proof was altered');
  return pageAttestationStorage.run(attestation, work);
}

function attestationMatches(input: {
  authority: AcceptedTurnCallAuthority;
  logicalCallId: string;
  toolName: string;
  argumentDigest: string;
}): boolean {
  const attested = pageAttestationStorage.getStore();
  const paginated = input.authority.paginatedWorkflow;
  return Boolean(
    attested && paginated
    && input.authority.authorityKind === 'workflow_v2_paginated_read'
    && attested.sessionId === input.authority.identity.sessionId
    && attested.sourceEventSeq === input.authority.identity.sourceUserSeq
    && attested.authorityRootId === input.authority.identity.acceptedTaskId
    && attested.activationId === paginated.activationId
    && attested.activationDigest === paginated.activationDigest
    && attested.authorityDigest === input.authority.authorityDigest
    && attested.authorityRevision === input.authority.revision
    && attested.logicalCallId === input.logicalCallId
    && attested.toolName === input.toolName
    && attested.argumentDigest === input.argumentDigest
  );
}

export function workflowReadPagePhysicalClaimAttestationMatches(input: {
  sessionId: string;
  sourceEventSeq: number;
  authorityRootId: string;
  activationId: string;
  activationDigest: string;
  authorityDigest: string;
  authorityRevision: number;
  pageOrdinal: number;
  logicalCallId: string;
  physicalDispatchId: string;
  toolName: string;
}): boolean {
  const attested = pageAttestationStorage.getStore();
  return Boolean(
    attested
    && attested.sessionId === input.sessionId
    && attested.sourceEventSeq === input.sourceEventSeq
    && attested.authorityRootId === input.authorityRootId
    && attested.activationId === input.activationId
    && attested.activationDigest === input.activationDigest
    && attested.authorityDigest === input.authorityDigest
    && attested.authorityRevision === input.authorityRevision
    && attested.pageOrdinal === input.pageOrdinal
    && attested.logicalCallId === input.logicalCallId
    && attested.physicalDispatchId === input.physicalDispatchId
    && attested.toolName === input.toolName
  );
}

export function workflowReadPagePreparationPhysicalDispatchId(input: {
  activationDigest: string;
  pageOrdinal: number;
  logicalCallId: string;
  toolName: string;
  argumentDigest: string;
}): string {
  return `workflow-page-preparation-dispatch:${sha256(closedCanonicalJson({
    domain: 'workflow-paginated-read-page-preparation',
    version: 1,
    ...input,
  }))}`;
}

/** Opaque page-attestation check for the separate live-definition probe that
 * precedes a prepared paginated business call. The probe id is derived from
 * the exact attested page bytes; copyable lineage cannot mint another probe. */
export function workflowReadPagePreparationClaimAttestationMatches(input: {
  sessionId: string;
  sourceEventSeq: number;
  authorityRootId: string;
  activationId: string;
  activationDigest: string;
  authorityDigest: string;
  authorityRevision: number;
  pageOrdinal: number;
  logicalCallId: string;
  physicalDispatchId: string;
  toolName: string;
}): boolean {
  const attested = pageAttestationStorage.getStore();
  return Boolean(
    attested
    && attested.sessionId === input.sessionId
    && attested.sourceEventSeq === input.sourceEventSeq
    && attested.authorityRootId === input.authorityRootId
    && attested.activationId === input.activationId
    && attested.activationDigest === input.activationDigest
    && attested.authorityDigest === input.authorityDigest
    && attested.authorityRevision === input.authorityRevision
    && attested.pageOrdinal === input.pageOrdinal
    && attested.logicalCallId === input.logicalCallId
    && attested.toolName === input.toolName
    && input.physicalDispatchId === workflowReadPagePreparationPhysicalDispatchId({
      activationDigest: attested.activationDigest,
      pageOrdinal: attested.pageOrdinal,
      logicalCallId: attested.logicalCallId,
      toolName: attested.toolName,
      argumentDigest: attested.argumentDigest,
    })
  );
}

export type MintWorkflowReadPageAttestationResult =
  | {
      status: 'minted';
      proof: WorkflowReadPageAttestationProof;
      ref: WorkflowReadPageRef;
      toolName: string;
      operationId: string;
      argumentDigest: string;
    }
  | { status: 'missing' | 'closed' | 'conflict' | 'storage_error'; reason: string };

export function mintWorkflowReadPageAttestation(input: {
  activationId: string;
  pageOrdinal: number;
  invocationPlan: unknown;
  args: Record<string, unknown>;
}): MintWorkflowReadPageAttestationResult {
  try {
    const loaded = readWorkflowPaginatedReadAuthority(input.activationId);
    if (loaded.status !== 'ok') return loaded;
    if (loaded.authority.state !== 'open' || loaded.ref.aggregateState !== 'open') {
      return { status: 'closed', reason: 'paginated workflow authority is closed' };
    }
    const parsed = parseWorkflowNodeInvocationPlan(input.invocationPlan);
    if (
      !parsed.ok
      || parsed.plan.bindingDigest !== loaded.ref.invocationPlanDigest
      || parsed.plan.binding.effect !== 'read'
      || parsed.plan.continuation.kind !== 'cursor'
    ) return { status: 'conflict', reason: 'paginated page plan differs from its activation' };
    const row = pageRow(openEventLog(), input.activationId, input.pageOrdinal);
    if (!row) return { status: 'missing', reason: 'paginated page authority is missing' };
    if (row.state !== 'reserved') return { status: 'closed', reason: `paginated page is ${row.state}` };
    const contract = durableLogicalCallContract(
      loaded.ref.authorityRootId,
      parsed.plan.binding.operationId,
      input.args,
    );
    const inputCursorDigest = Object.prototype.hasOwnProperty.call(input.args, loaded.ref.cursorArgument)
      ? cursorDigest(input.args[loaded.ref.cursorArgument])
      : null;
    const expectedIds = contract ? pageIdentity({
      activationDigest: loaded.ref.activationDigest,
      pageOrdinal: input.pageOrdinal,
      priorPageReceiptDigest: row.prior_page_receipt_digest,
      inputCursorDigest,
      argumentDigest: contract.argumentDigest,
      bindingIdentityDigest: bindingIdentityDigest(parsed.plan),
    }) : null;
    if (
      !contract || !expectedIds
      || row.input_cursor_digest !== inputCursorDigest
      || row.binding_identity_digest !== bindingIdentityDigest(parsed.plan)
      || row.argument_digest !== contract.argumentDigest
      || row.logical_call_id !== expectedIds.logicalCallId
      || row.physical_dispatch_id !== expectedIds.physicalDispatchId
    ) return { status: 'conflict', reason: 'paginated page arguments differ from its child authority' };
    const capability = peekHostCapabilityCatalogFactory()?.get(parsed.plan.binding.capabilityId);
    const live = capability ? canonicalCatalogIdentityOf(capability) : null;
    const binding = parsed.plan.binding;
    if (
      !capability || !live || !capability.manifest
      || !currentCapabilityManifest(capability.manifest)
      || capabilityManifestDigest(capability.manifest) !== binding.manifestDigest
      || live.capabilityId !== binding.capabilityId
      || live.manifestId !== binding.manifestId
      || live.manifestDigest !== binding.manifestDigest
      || live.operationId !== binding.operationId
      || live.schemaVersion !== binding.operationVersion
      || live.schemaDigest !== binding.schemaDigest
      || live.providerVersion !== binding.providerVersion
      || live.liveFingerprint !== binding.liveFingerprint
      || live.account !== binding.accountId
      || live.effect !== 'read'
      || live.invokePortId !== binding.invokePortId
      || live.argumentCompiler.id !== binding.argumentCompiler.id
      || live.argumentCompiler.version !== binding.argumentCompiler.version
      || !resolveProductionPortsForManifest(capability.manifest)
    ) return { status: 'conflict', reason: 'paginated page live binding differs from its exact plan' };
    const observation = independentlyObserveCapability(binding.operationId, binding.accountId);
    if (
      !observation
      || observation.origin !== 'independent'
      || !observationIsFresh(observation)
      || observation.operationId !== binding.operationId
      || observation.operationVersion !== binding.operationVersion
      || observation.providerVersion !== binding.providerVersion
      || observation.definitionFingerprint !== binding.liveFingerprint
      || observation.accountId !== binding.accountId
    ) return { status: 'conflict', reason: 'paginated page independent observation differs from its plan' };
    const attestation = Object.freeze<WorkflowReadPageAttestation>({
      sessionId: loaded.ref.sessionId,
      sourceEventSeq: loaded.ref.sourceEventSeq,
      authorityRootId: loaded.ref.authorityRootId,
      activationId: loaded.ref.activationId,
      activationDigest: loaded.ref.activationDigest,
      authorityDigest: loaded.ref.authorityDigest,
      authorityRevision: loaded.ref.authorityRevision,
      pageOrdinal: input.pageOrdinal,
      priorPageReceiptDigest: row.prior_page_receipt_digest,
      inputCursorDigest: row.input_cursor_digest,
      bindingIdentityDigest: row.binding_identity_digest,
      logicalCallId: row.logical_call_id,
      physicalDispatchId: row.physical_dispatch_id,
      toolName: contract.toolName,
      operationId: binding.operationId,
      argumentDigest: contract.argumentDigest,
      capabilityId: binding.capabilityId,
      manifestId: binding.manifestId,
      manifestDigest: binding.manifestDigest,
      operationVersion: binding.operationVersion,
      schemaDigest: binding.schemaDigest,
      providerVersion: binding.providerVersion,
      liveFingerprint: binding.liveFingerprint,
      accountId: binding.accountId,
      invokePortId: binding.invokePortId,
      argumentCompilerId: binding.argumentCompiler.id,
      argumentCompilerVersion: binding.argumentCompiler.version,
    });
    const proof = Object.freeze<WorkflowReadPageAttestationProof>({
      kind: 'workflow_v2_paginated_read_page_attestation',
      activationId: loaded.ref.activationId,
      pageOrdinal: input.pageOrdinal,
      logicalCallId: row.logical_call_id,
    });
    pageProofs.set(proof as object, attestation);
    return {
      status: 'minted',
      proof,
      ref: pageRef(loaded.ref, row),
      toolName: contract.toolName,
      operationId: binding.operationId,
      argumentDigest: contract.argumentDigest,
    };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export type WorkflowPaginatedLogicalAdmissionResult =
  | { status: 'ok'; authority: AcceptedTurnCallAuthority }
  | { status: 'closed' | 'missing' | 'conflict'; reason: string };

export function admitWorkflowPaginatedLogicalCallInTransaction(
  db: HarnessDb,
  input: {
    sessionId: string;
    sourceEventSeq: number;
    authorityRootId: string;
    logicalToolCallId: string;
    toolName: string;
    argumentDigest: string;
    effect: CallAdmissionEffect;
    isNew: boolean;
  },
): WorkflowPaginatedLogicalAdmissionResult {
  const loaded = readAcceptedTurnCallAuthorityInTransaction(db, input.sessionId, input.sourceEventSeq);
  if (loaded.status !== 'ok') {
    return { status: loaded.status === 'missing' ? 'missing' : 'conflict', reason: loaded.reason };
  }
  const authority = loaded.authority;
  if (
    authority.authorityKind !== 'workflow_v2_paginated_read'
    || authority.identity.acceptedTaskId !== input.authorityRootId
  ) return { status: 'conflict', reason: 'logical call does not belong to paginated workflow authority' };
  if (authority.state !== 'open') return { status: 'closed', reason: 'paginated workflow authority is closed' };
  // Runtime name heuristics are intentionally not authority for generated
  // provider operations. The opaque proof below seals an independently
  // observed live binding whose manifest effect was exactly `read`.
  if (!attestationMatches({
    authority,
    logicalCallId: input.logicalToolCallId,
    toolName: input.toolName,
    argumentDigest: input.argumentDigest,
  })) {
    poisonAcceptedTurnCallAuthorityInTransaction(db, {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceEventSeq,
      reason: 'paginated workflow call lacks exact page/live-binding attestation',
    });
    return { status: 'conflict', reason: 'paginated workflow call lacks exact page/live-binding attestation' };
  }
  const attested = pageAttestationStorage.getStore();
  const page = attested ? pageRow(db, attested.activationId, attested.pageOrdinal) : undefined;
  if (
    !attested || !page || page.state !== 'reserved'
    || page.logical_call_id !== input.logicalToolCallId
    || page.argument_digest !== input.argumentDigest
    || page.physical_dispatch_id !== attested.physicalDispatchId
  ) return { status: 'conflict', reason: 'paginated workflow page authority is not reserved and exact' };
  if (!input.isNew) return { status: 'ok', authority };
  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open_count
      FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceEventSeq) as { total: number; open_count: number | null };
  if (counts.total >= (authority.maxLogicalCalls ?? 0)) {
    return { status: 'closed', reason: 'paginated workflow logical-call ceiling reached' };
  }
  if ((counts.open_count ?? 0) >= 1) {
    return { status: 'closed', reason: 'paginated workflow pages are sequential' };
  }
  return { status: 'ok', authority };
}

function pathSegments(path: string): Array<string | number> | null {
  const segments: Array<string | number> = [];
  let cursor = 0;
  while (cursor < path.length) {
    const field = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(path.slice(cursor));
    if (!field) return null;
    segments.push(field[0]);
    cursor += field[0].length;
    while (path[cursor] === '[') {
      const index = /^\[(0|[1-9]\d*)\]/.exec(path.slice(cursor));
      if (!index) return null;
      segments.push(Number(index[1]));
      cursor += index[0].length;
    }
    if (cursor === path.length) break;
    if (path[cursor] !== '.') return null;
    cursor += 1;
  }
  return segments;
}

function valueAtPath(value: unknown, path: string): unknown {
  const segments = pathSegments(path);
  if (!segments) return undefined;
  let current: unknown = value;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) return undefined;
      current = current[segment];
    } else {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

const STREAMING_EVIDENCE_RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Hash the same sorted-key closed JSON bytes without materializing the whole
 * encoding. This is used only after the legacy bounded encoder refuses a page
 * that carries an independently reviewed result projection. Its byte ceiling
 * comes from that projection, so a provider cannot turn page evidence into an
 * unbounded traversal merely by returning a large object.
 */
function streamingClosedCanonicalDigest(value: unknown, maxTotalBytes: number): string {
  const hash = createHash('sha256');
  const seen = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const token = (text: string): void => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > maxTotalBytes) throw new Error('streamed canonical evidence exceeds reviewed bytes');
    hash.update(text, 'utf8');
  };
  const string = (text: string): void => {
    if (Buffer.byteLength(text, 'utf8') > 64_000) {
      throw new Error('streamed canonical evidence contains an oversized string');
    }
    token(JSON.stringify(text));
  };
  const visit = (input: unknown, depth: number): void => {
    nodes += 1;
    // Every JSON node consumes at least one encoded byte. This secondary
    // guard bounds traversal even before punctuation is emitted.
    if (nodes > maxTotalBytes * 2) throw new Error('streamed canonical evidence has too many nodes');
    if (depth > 24) throw new Error('streamed canonical evidence is too deep');
    if (input === null) { token('null'); return; }
    if (typeof input === 'string') { string(input); return; }
    if (typeof input === 'boolean') { token(input ? 'true' : 'false'); return; }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('streamed canonical evidence has a non-finite number');
      token(JSON.stringify(input));
      return;
    }
    if (typeof input !== 'object') throw new Error('streamed evidence is outside closed JSON');
    if (seen.has(input)) throw new Error('streamed canonical evidence is cyclic');
    if (Object.getOwnPropertySymbols(input).length > 0) {
      throw new Error('streamed canonical evidence has symbol keys');
    }
    const prototype = Object.getPrototypeOf(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Array.isArray(input)) {
      if (prototype !== Array.prototype) throw new Error('streamed evidence array has a foreign prototype');
      for (const name of Object.getOwnPropertyNames(input)) {
        if (name === 'length') continue;
        if (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= input.length) {
          throw new Error('streamed evidence array has an extra property');
        }
      }
      seen.add(input);
      try {
        token('[');
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor) throw new Error('streamed evidence array is sparse');
          if ('get' in descriptor || 'set' in descriptor) {
            throw new Error('streamed evidence array has an accessor');
          }
          if (index > 0) token(',');
          visit(descriptor.value, depth + 1);
        }
        token(']');
      } finally {
        seen.delete(input);
      }
      return;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('streamed evidence object has a foreign prototype');
    }
    const keys = Object.getOwnPropertyNames(input).sort();
    seen.add(input);
    try {
      token('{');
      for (const [index, key] of keys.entries()) {
        if (STREAMING_EVIDENCE_RESERVED_KEYS.has(key)) {
          throw new Error('streamed evidence contains a reserved key');
        }
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) {
          throw new Error('streamed evidence object has a hidden or accessor property');
        }
        if (index > 0) token(',');
        string(key);
        token(':');
        visit(descriptor.value, depth + 1);
      }
      token('}');
    } finally {
      seen.delete(input);
    }
  };
  visit(value, 0);
  return hash.digest('hex');
}

function evidenceOf(plan: WorkflowNodeInvocationPlanV1, result: unknown): {
  valid: boolean;
  digest: string;
  itemCount: number;
} {
  const observed: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const paths = new Set([
    ...plan.evidence.requiredPaths,
    ...plan.evidence.nonEmptyPaths,
    ...Object.keys(plan.evidence.minItems),
    ...(plan.completeness.kind === 'finite_exhaustive' ? plan.completeness.evidencePaths : []),
  ]);
  let valid = true;
  let itemCount = 0;
  for (const path of [...paths].sort()) {
    const value = valueAtPath(result, path);
    observed[path] = value === undefined ? { missing: true } : value;
    if (plan.evidence.requiredPaths.includes(path) && value === undefined) valid = false;
    if (plan.evidence.nonEmptyPaths.includes(path) && !nonEmpty(value)) valid = false;
    const minimum = plan.evidence.minItems[path];
    if (minimum !== undefined && (!Array.isArray(value) || value.length < minimum)) valid = false;
    if (Array.isArray(value)) itemCount = Math.max(itemCount, value.length);
  }
  let digest: string;
  try {
    const bytes = closedCanonicalJson({ contract: plan.evidence, observed }, {
      maxDepth: 24,
      maxNodes: 20_000,
      maxStringBytes: 64_000,
      maxTotalBytes: 512_000,
    });
    digest = sha256(bytes);
  } catch {
    try {
      if (!plan.resultProjection) throw new Error('large evidence lacks a reviewed result projection');
      digest = streamingClosedCanonicalDigest(
        { contract: plan.evidence, observed },
        plan.resultProjection.bounds.maxPageBytes + 512_000,
      );
    } catch {
      valid = false;
      digest = sha256(closedCanonicalJson({ contract: plan.evidence, malformed: true }));
    }
  }
  return { valid, digest, itemCount };
}

function pageReceiptDigest(input: {
  activationDigest: string;
  page: PageRow;
  resultHandleId: string;
  settledResultDigest: string;
  nextCursorDigest: string | null;
  exhaustedTruth: WorkflowPageExhaustedTruth;
  itemCount: number;
  evidenceDigest: string;
  evidenceValid: boolean;
  continuationState: WorkflowPageContinuationState;
}): string {
  return sha256(closedCanonicalJson({
    protocolVersion: 1,
    activationDigest: input.activationDigest,
    pageOrdinal: input.page.page_ordinal,
    priorPageReceiptDigest: input.page.prior_page_receipt_digest,
    inputCursorDigest: input.page.input_cursor_digest,
    bindingIdentityDigest: input.page.binding_identity_digest,
    argumentDigest: input.page.argument_digest,
    logicalCallId: input.page.logical_call_id,
    physicalDispatchId: input.page.physical_dispatch_id,
    resultHandleId: input.resultHandleId,
    settledResultDigest: input.settledResultDigest,
    nextCursorDigest: input.nextCursorDigest,
    exhaustedTruth: input.exhaustedTruth,
    itemCount: input.itemCount,
    evidenceDigest: input.evidenceDigest,
    evidenceValid: input.evidenceValid,
    continuationState: input.continuationState,
  }));
}

export interface SettledWorkflowReadPage {
  ref: WorkflowReadPageRef;
  pageReceiptId: string;
  pageReceiptDigest: string;
  resultHandleId: string;
  settledResultDigest: string;
  nextCursorDigest: string | null;
  exhaustedTruth: WorkflowPageExhaustedTruth;
  itemCount: number;
  evidenceDigest: string;
  evidenceValid: boolean;
  continuationState: WorkflowPageContinuationState;
}

export type SettleWorkflowReadPageResult =
  | { status: 'settled' | 'replayed'; page: SettledWorkflowReadPage; result: unknown }
  | { status: 'not_ready' | 'missing' | 'conflict' | 'storage_error'; reason: string };

function settledPageProjection(
  ref: WorkflowPaginatedReadAuthorityRef,
  row: PageRow,
): SettledWorkflowReadPage | null {
  if (
    row.state !== 'settled' || !row.page_receipt_id || !row.page_receipt_digest
    || !row.result_handle_id || !row.settled_result_digest
    || !row.provider_exhausted_truth || row.item_count === null
    || !row.evidence_digest || row.evidence_valid === null || !row.continuation_state
  ) return null;
  return {
    ref: pageRef(ref, row),
    pageReceiptId: row.page_receipt_id,
    pageReceiptDigest: row.page_receipt_digest,
    resultHandleId: row.result_handle_id,
    settledResultDigest: row.settled_result_digest,
    nextCursorDigest: row.next_cursor_digest,
    exhaustedTruth: row.provider_exhausted_truth,
    itemCount: row.item_count,
    evidenceDigest: row.evidence_digest,
    evidenceValid: row.evidence_valid === 1,
    continuationState: row.continuation_state,
  };
}

/** Freeze page interpretation only after the shared logical settlement has
 * retained the exact provider result. Re-entry redeems and recomputes the same
 * cursor/evidence receipt; it never trusts caller-supplied result bytes. */
export function settleWorkflowReadPage(input: {
  activationId: string;
  pageOrdinal: number;
  invocationPlan: unknown;
}): SettleWorkflowReadPageResult {
  const parsed = parseWorkflowNodeInvocationPlan(input.invocationPlan);
  if (!parsed.ok || parsed.plan.continuation.kind !== 'cursor') {
    return { status: 'conflict', reason: 'paginated page settlement requires an exact cursor plan' };
  }
  try {
    const db = openEventLog();
    return db.transaction((): SettleWorkflowReadPageResult => {
      const loaded = readInTransaction(db, input.activationId);
      if (loaded.status !== 'ok') return loaded;
      if (parsed.plan.bindingDigest !== loaded.ref.invocationPlanDigest) {
        return { status: 'conflict', reason: 'paginated page settlement plan differs from activation' };
      }
      const row = pageRow(db, input.activationId, input.pageOrdinal);
      if (!row) return { status: 'missing', reason: 'paginated page authority is missing' };
      const redeemed = redeemSuccessfulSettlementResultForHost({
        sessionId: loaded.ref.sessionId,
        sourceUserSeq: loaded.ref.sourceEventSeq,
        acceptedTaskId: loaded.ref.authorityRootId,
        logicalToolCallId: row.logical_call_id,
      });
      if (redeemed.status !== 'ok') {
        return redeemed.status === 'missing'
          ? { status: 'not_ready', reason: 'paginated page logical result is not settled' }
          : { status: 'conflict', reason: `paginated page result is not redeemable: ${redeemed.reason}` };
      }
      if (redeemed.value.physicalDispatchId !== row.physical_dispatch_id) {
        return { status: 'conflict', reason: 'paginated page retained result belongs to another physical child' };
      }
      const result = redeemed.value.rawPayload;
      const evidenceView = projectProviderResultEvidenceView(result);
      const evidenceResult = evidenceView.kind === 'provider_payload'
        ? evidenceView.payload
        : undefined;
      const exhaustedValue = valueAtPath(evidenceResult, loaded.ref.exhaustedPath);
      const exhaustedTruth: WorkflowPageExhaustedTruth = exhaustedValue === true
        ? 'true' : exhaustedValue === false ? 'false' : 'unknown';
      const nextCursor = valueAtPath(evidenceResult, loaded.ref.nextCursorPath);
      const nextDigest = cursorDigest(nextCursor);
      const evidence = evidenceOf(parsed.plan, evidenceResult);
      const priorVisit = nextDigest ? db.prepare(`
        SELECT first_page_ordinal FROM workflow_paginated_cursor_visits
         WHERE activation_id = ? AND cursor_digest = ?
      `).get(input.activationId, nextDigest) as { first_page_ordinal: number } | undefined : undefined;
      // A successful advance records page N's output cursor as the input of
      // page N+1. That future visit must not retroactively turn page N's
      // immutable receipt into a cycle during replay. It is repeated only when
      // the same cursor was already assigned to this or an earlier page.
      const repeated = Boolean(
        priorVisit && priorVisit.first_page_ordinal <= row.page_ordinal,
      );
      let continuationState: WorkflowPageContinuationState;
      if (!evidence.valid) continuationState = 'malformed_evidence';
      else if (exhaustedTruth === 'true') continuationState = 'exhausted';
      else if (!nextDigest) continuationState = exhaustedTruth === 'unknown'
        ? 'unknown_exhaustion' : 'missing_cursor';
      else if (repeated) continuationState = 'repeated_cursor';
      else continuationState = 'continue';
      const digest = pageReceiptDigest({
        activationDigest: loaded.ref.activationDigest,
        page: row,
        resultHandleId: redeemed.value.resultHandleId,
        settledResultDigest: redeemed.value.rawPayloadSha256,
        nextCursorDigest: nextDigest,
        exhaustedTruth,
        itemCount: evidence.itemCount,
        evidenceDigest: evidence.digest,
        evidenceValid: evidence.valid,
        continuationState,
      });
      const receiptId = `workflow-page-receipt:${digest}`;
      if (row.state === 'settled') {
        const projection = settledPageProjection(loaded.ref, row);
        if (
          !projection
          || projection.pageReceiptId !== receiptId
          || projection.pageReceiptDigest !== digest
          || projection.resultHandleId !== redeemed.value.resultHandleId
          || projection.settledResultDigest !== redeemed.value.rawPayloadSha256
          || projection.nextCursorDigest !== nextDigest
          || projection.exhaustedTruth !== exhaustedTruth
          || projection.itemCount !== evidence.itemCount
          || projection.evidenceDigest !== evidence.digest
          || projection.evidenceValid !== evidence.valid
          || projection.continuationState !== continuationState
        ) return { status: 'conflict', reason: 'settled paginated page receipt does not replay exactly' };
        return { status: 'replayed', page: projection, result };
      }
      if (row.state !== 'reserved') {
        return { status: 'conflict', reason: `paginated page cannot settle from ${row.state}` };
      }
      const now = new Date().toISOString();
      const updated = db.prepare(`
        UPDATE workflow_paginated_read_pages
           SET state = 'settled', page_receipt_id = ?, page_receipt_digest = ?,
               result_handle_id = ?, settled_result_digest = ?, next_cursor_digest = ?,
               provider_exhausted_truth = ?, item_count = ?, evidence_digest = ?,
               evidence_valid = ?, continuation_state = ?, settled_at = ?
         WHERE activation_id = ? AND page_ordinal = ? AND state = 'reserved'
      `).run(
        receiptId, digest, redeemed.value.resultHandleId, redeemed.value.rawPayloadSha256,
        nextDigest, exhaustedTruth, evidence.itemCount, evidence.digest,
        evidence.valid ? 1 : 0, continuationState, now,
        input.activationId, input.pageOrdinal,
      ).changes;
      if (updated !== 1) throw new Error('paginated page settlement lost its CAS');
      const advanced = db.prepare(`
        UPDATE workflow_paginated_read_activations
           SET latest_page_receipt_digest = ?
         WHERE activation_id = ? AND aggregate_state = 'open'
           AND next_page_ordinal = ?
           AND latest_page_receipt_digest IS ?
      `).run(
        digest, input.activationId, input.pageOrdinal + 1,
        row.prior_page_receipt_digest,
      ).changes;
      if (advanced !== 1) throw new Error('paginated page receipt lost its activation CAS');
      const settled = pageRow(db, input.activationId, input.pageOrdinal);
      const projection = settled ? settledPageProjection(loaded.ref, settled) : null;
      if (!projection) throw new Error('settled paginated page disappeared');
      return { status: 'settled', page: projection, result };
    }).immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export function markWorkflowReadPageFailed(input: {
  activationId: string;
  pageOrdinal: number;
  state: 'failed' | 'uncertain' | 'cancelled' | 'conflict';
}): { status: 'marked' | 'replayed' | 'missing' | 'conflict' | 'storage_error'; reason?: string } {
  try {
    const db = openEventLog();
    return db.transaction(() => {
      const row = pageRow(db, input.activationId, input.pageOrdinal);
      if (!row) return { status: 'missing' as const, reason: 'paginated page is missing' };
      if (row.state === input.state) return { status: 'replayed' as const };
      if (row.state !== 'reserved') {
        return { status: 'conflict' as const, reason: `paginated page is already ${row.state}` };
      }
      const updated = db.prepare(`
        UPDATE workflow_paginated_read_pages SET state = ?, settled_at = ?
         WHERE activation_id = ? AND page_ordinal = ? AND state = 'reserved'
      `).run(input.state, new Date().toISOString(), input.activationId, input.pageOrdinal).changes;
      return updated === 1
        ? { status: 'marked' as const }
        : { status: 'conflict' as const, reason: 'paginated page failure mark lost its CAS' };
    }).immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

function aggregateDigestInput(row: AggregateRow): Record<string, unknown> {
  return {
    protocolVersion: 1,
    activationId: row.activation_id,
    activationDigest: row.activation_digest,
    authorityRootId: row.authority_root_id,
    invocationPlanDigest: row.invocation_plan_digest,
    bindingSnapshotDigest: row.binding_snapshot_digest,
    controlDigest: row.control_digest,
    pageReceiptDigests: JSON.parse(row.page_receipt_digests_json) as unknown,
    pageResultHandleIds: JSON.parse(row.page_result_handles_json) as unknown,
    pageCount: row.page_count,
    totalItemCount: row.total_item_count,
    finalExhaustedTruth: row.final_exhausted_truth,
    coverageState: row.coverage_state,
    outcome: row.outcome,
    reason: row.reason,
  };
}

function projectAggregate(row: AggregateRow): WorkflowPaginatedAggregateReceipt | null {
  let pageReceiptDigests: unknown;
  let pageResultHandleIds: unknown;
  try {
    pageReceiptDigests = JSON.parse(row.page_receipt_digests_json) as unknown;
    pageResultHandleIds = JSON.parse(row.page_result_handles_json) as unknown;
  } catch {
    return null;
  }
  if (
    !Array.isArray(pageReceiptDigests)
    || pageReceiptDigests.some((entry) => !isSha256(entry))
    || !Array.isArray(pageResultHandleIds)
    || pageResultHandleIds.some((entry) => typeof entry !== 'string' || !entry.trim())
    || pageReceiptDigests.length !== row.page_count
    || pageResultHandleIds.length !== row.page_count
    || sha256(closedCanonicalJson(aggregateDigestInput(row))) !== row.aggregate_receipt_digest
    || row.aggregate_receipt_id !== `workflow-aggregate-receipt:${row.aggregate_receipt_digest}`
  ) return null;
  return {
    aggregateReceiptId: row.aggregate_receipt_id,
    aggregateReceiptDigest: row.aggregate_receipt_digest,
    activationId: row.activation_id,
    activationDigest: row.activation_digest,
    authorityRootId: row.authority_root_id,
    invocationPlanDigest: row.invocation_plan_digest,
    bindingSnapshotDigest: row.binding_snapshot_digest,
    controlDigest: row.control_digest,
    pageReceiptDigests: pageReceiptDigests as string[],
    pageResultHandleIds: pageResultHandleIds as string[],
    pageCount: row.page_count,
    totalItemCount: row.total_item_count,
    finalExhaustedTruth: row.final_exhausted_truth,
    coverageState: row.coverage_state,
    outcome: row.outcome,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function aggregateRow(db: HarnessDb, activationId: string): AggregateRow | undefined {
  return db.prepare(`
    SELECT * FROM workflow_paginated_aggregate_receipts WHERE activation_id = ?
  `).get(activationId) as AggregateRow | undefined;
}

export type RedeemWorkflowPaginatedAggregateResult =
  | { status: 'ok'; receipt: WorkflowPaginatedAggregateReceipt }
  | { status: 'missing' | 'conflict' | 'storage_error'; reason: string };

export function redeemWorkflowPaginatedAggregate(
  activationId: string,
): RedeemWorkflowPaginatedAggregateResult {
  try {
    const db = openEventLog();
    const loaded = readInTransaction(db, activationId);
    if (loaded.status !== 'ok') return loaded;
    const row = aggregateRow(db, activationId);
    if (!row) return { status: 'missing', reason: 'paginated aggregate receipt is missing' };
    const receipt = projectAggregate(row);
    if (
      !receipt
      || loaded.ref.aggregateState === 'open'
      || loaded.ref.terminalAggregateReceiptId !== receipt.aggregateReceiptId
      || loaded.ref.terminalAggregateReceiptDigest !== receipt.aggregateReceiptDigest
      || loaded.authority.state === 'open'
    ) return { status: 'conflict', reason: 'paginated aggregate receipt disagrees with its closed root' };
    const pages = db.prepare(`
      SELECT page_ordinal, page_receipt_digest, result_handle_id
        FROM workflow_paginated_read_pages
       WHERE activation_id = ? AND state = 'settled' ORDER BY page_ordinal
    `).all(activationId) as Array<{
      page_ordinal: number;
      page_receipt_digest: string | null;
      result_handle_id: string | null;
    }>;
    if (
      pages.length !== receipt.pageCount
      || pages.some((page, index) => (
        page.page_ordinal !== index
        || page.page_receipt_digest !== receipt.pageReceiptDigests[index]
        || page.result_handle_id !== receipt.pageResultHandleIds[index]
      ))
    ) return { status: 'conflict', reason: 'paginated aggregate ordered page chain does not replay' };
    return { status: 'ok', receipt };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export interface RedeemedClosedWorkflowReadPageV1 {
  pageOrdinal: number;
  pageReceiptId: string;
  pageReceiptDigest: string;
  resultHandleId: string;
  settledResultDigest: string;
  logicalCallId: string;
  physicalDispatchId: string;
  priorPageReceiptDigest: string | null;
  inputCursorDigest: string | null;
  nextCursorDigest: string | null;
  exhaustedTruth: WorkflowPageExhaustedTruth;
  continuationState: WorkflowPageContinuationState;
  itemCount: number;
  settledAt: string;
  rawPayload: unknown;
  rawPayloadJson: string;
  rawByteCount: number;
}

export interface RedeemedClosedWorkflowPaginatedReadV1 {
  authority: WorkflowPaginatedReadAuthorityRef;
  aggregate: WorkflowPaginatedAggregateReceipt;
  pages: RedeemedClosedWorkflowReadPageV1[];
}

export type RedeemClosedWorkflowPaginatedReadResultV1 =
  | { status: 'ok'; value: RedeemedClosedWorkflowPaginatedReadV1 }
  | { status: 'missing' | 'conflict' | 'storage_error'; reason: string };

/**
 * Redeem a terminal v52 collection from retained logical-result authority.
 * The caller supplies only exact workflow/run lineage; page bodies are loaded
 * from immutable result handles and every receipt/digest/dispatch edge is
 * recomputed. A partial, unknown, cyclic, corrupt, or foreign root is never a
 * successful redemption.
 */
export function redeemClosedWorkflowPaginatedRead(input: {
  activationId: string;
  workflowId: string;
  workflowRevision: number;
  workflowDigest: string;
  runId: string;
  runOccurrenceId: string;
  nodeId: string;
  nodeAttempt: number;
  invocationPlanDigest: string;
  bindingSnapshotDigest: string;
  controlDigest: string;
}): RedeemClosedWorkflowPaginatedReadResultV1 {
  try {
    const loaded = readWorkflowPaginatedReadAuthority(input.activationId);
    if (loaded.status !== 'ok') return loaded;
    const ref = loaded.ref;
    if (
      loaded.authority.state !== 'closed'
      || ref.aggregateState !== 'complete'
      || ref.workflowId !== input.workflowId
      || ref.workflowRevision !== input.workflowRevision
      || ref.workflowDigest !== input.workflowDigest
      || ref.runId !== input.runId
      || ref.runOccurrenceId !== input.runOccurrenceId
      || ref.nodeId !== input.nodeId
      || ref.nodeAttempt !== input.nodeAttempt
      || ref.invocationPlanDigest !== input.invocationPlanDigest
      || ref.bindingSnapshotDigest !== input.bindingSnapshotDigest
      || ref.controlDigest !== input.controlDigest
    ) return { status: 'conflict', reason: 'closed paginated authority does not match the exact workflow/run lineage' };
    const aggregateResult = redeemWorkflowPaginatedAggregate(input.activationId);
    if (aggregateResult.status !== 'ok') return aggregateResult;
    const aggregate = aggregateResult.receipt;
    if (
      aggregate.outcome !== 'complete'
      || aggregate.coverageState !== 'complete'
      || aggregate.finalExhaustedTruth !== 'true'
      || aggregate.activationId !== ref.activationId
      || aggregate.activationDigest !== ref.activationDigest
      || aggregate.authorityRootId !== ref.authorityRootId
      || aggregate.invocationPlanDigest !== ref.invocationPlanDigest
      || aggregate.bindingSnapshotDigest !== ref.bindingSnapshotDigest
      || aggregate.controlDigest !== ref.controlDigest
    ) return { status: 'conflict', reason: 'paginated aggregate lacks exact exhaustive closed authority' };

    const db = openEventLog();
    const rows = db.prepare(`
      SELECT * FROM workflow_paginated_read_pages
       WHERE activation_id = ? ORDER BY page_ordinal
    `).all(input.activationId) as PageRow[];
    if (rows.length !== aggregate.pageCount) {
      return { status: 'conflict', reason: 'paginated aggregate page count differs from retained pages' };
    }
    const pages: RedeemedClosedWorkflowReadPageV1[] = [];
    for (const [index, row] of rows.entries()) {
      const projection = settledPageProjection(ref, row);
      if (!projection || !row.settled_at || row.page_ordinal !== index) {
        return { status: 'conflict', reason: 'paginated page chain is not exactly settled and ordered' };
      }
      const recomputed = pageReceiptDigest({
        activationDigest: ref.activationDigest,
        page: row,
        resultHandleId: projection.resultHandleId,
        settledResultDigest: projection.settledResultDigest,
        nextCursorDigest: projection.nextCursorDigest,
        exhaustedTruth: projection.exhaustedTruth,
        itemCount: projection.itemCount,
        evidenceDigest: projection.evidenceDigest,
        evidenceValid: projection.evidenceValid,
        continuationState: projection.continuationState,
      });
      if (
        !projection.evidenceValid
        || recomputed !== projection.pageReceiptDigest
        || projection.pageReceiptId !== `workflow-page-receipt:${recomputed}`
        || projection.pageReceiptDigest !== aggregate.pageReceiptDigests[index]
        || projection.resultHandleId !== aggregate.pageResultHandleIds[index]
        || (index === rows.length - 1
          ? projection.continuationState !== 'exhausted' || projection.exhaustedTruth !== 'true'
          : projection.continuationState !== 'continue' || projection.exhaustedTruth !== 'false')
      ) return { status: 'conflict', reason: 'paginated page receipt or continuation truth does not recompute' };
      const redeemed = redeemSuccessfulSettlementResultForHost({
        sessionId: ref.sessionId,
        sourceUserSeq: ref.sourceEventSeq,
        acceptedTaskId: ref.authorityRootId,
        logicalToolCallId: row.logical_call_id,
      });
      if (redeemed.status !== 'ok') {
        return redeemed.status === 'missing'
          ? { status: 'missing', reason: 'paginated page retained result is missing' }
          : { status: 'conflict', reason: `paginated page retained result is not redeemable: ${redeemed.reason}` };
      }
      if (
        redeemed.value.physicalDispatchId !== row.physical_dispatch_id
        || redeemed.value.resultHandleId !== projection.resultHandleId
        || redeemed.value.rawPayloadSha256 !== projection.settledResultDigest
      ) return { status: 'conflict', reason: 'paginated page logical handle disagrees with its receipt' };
      pages.push({
        pageOrdinal: row.page_ordinal,
        pageReceiptId: projection.pageReceiptId,
        pageReceiptDigest: projection.pageReceiptDigest,
        resultHandleId: projection.resultHandleId,
        settledResultDigest: projection.settledResultDigest,
        logicalCallId: row.logical_call_id,
        physicalDispatchId: row.physical_dispatch_id,
        priorPageReceiptDigest: row.prior_page_receipt_digest,
        inputCursorDigest: row.input_cursor_digest,
        nextCursorDigest: projection.nextCursorDigest,
        exhaustedTruth: projection.exhaustedTruth,
        continuationState: projection.continuationState,
        itemCount: projection.itemCount,
        settledAt: row.settled_at,
        rawPayload: redeemed.value.rawPayload,
        rawPayloadJson: redeemed.value.rawPayloadJson,
        rawByteCount: redeemed.value.rawByteCount,
      });
    }
    if (pages.reduce((total, page) => total + page.itemCount, 0) !== aggregate.totalItemCount) {
      return { status: 'conflict', reason: 'paginated aggregate item total differs from redeemed page receipts' };
    }
    return { status: 'ok', value: { authority: ref, aggregate, pages } };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/**
 * Redeem the one failure shape that can still carry trustworthy partial data:
 * at least one ordered page settled, then the immediately following provider
 * page failed and the durable aggregate closed as `page_execution_failed`.
 * Missing/repeated cursors and budget stops remain partial, not failures, and
 * are deliberately excluded from this authority.
 */
export function redeemFailedWorkflowPaginatedRead(input: {
  activationId: string;
  workflowId: string;
  workflowRevision: number;
  workflowDigest: string;
  runId: string;
  runOccurrenceId: string;
  nodeId: string;
  nodeAttempt: number;
  invocationPlanDigest: string;
  bindingSnapshotDigest: string;
  controlDigest: string;
}): RedeemClosedWorkflowPaginatedReadResultV1 {
  try {
    const loaded = readWorkflowPaginatedReadAuthority(input.activationId);
    if (loaded.status !== 'ok') return loaded;
    const ref = loaded.ref;
    if (
      loaded.authority.state !== 'closed'
      || ref.aggregateState !== 'failed'
      || ref.workflowId !== input.workflowId
      || ref.workflowRevision !== input.workflowRevision
      || ref.workflowDigest !== input.workflowDigest
      || ref.runId !== input.runId
      || ref.runOccurrenceId !== input.runOccurrenceId
      || ref.nodeId !== input.nodeId
      || ref.nodeAttempt !== input.nodeAttempt
      || ref.invocationPlanDigest !== input.invocationPlanDigest
      || ref.bindingSnapshotDigest !== input.bindingSnapshotDigest
      || ref.controlDigest !== input.controlDigest
    ) return { status: 'conflict', reason: 'failed paginated authority does not match the exact workflow/run lineage' };
    const aggregateResult = redeemWorkflowPaginatedAggregate(input.activationId);
    if (aggregateResult.status !== 'ok') return aggregateResult;
    const aggregate = aggregateResult.receipt;
    if (
      aggregate.outcome !== 'failed'
      || aggregate.reason !== 'page_execution_failed'
      || aggregate.coverageState !== 'partial'
      || aggregate.finalExhaustedTruth !== 'false'
      || aggregate.pageCount < 1
      || aggregate.activationId !== ref.activationId
      || aggregate.activationDigest !== ref.activationDigest
      || aggregate.authorityRootId !== ref.authorityRootId
      || aggregate.invocationPlanDigest !== ref.invocationPlanDigest
      || aggregate.bindingSnapshotDigest !== ref.bindingSnapshotDigest
      || aggregate.controlDigest !== ref.controlDigest
    ) return { status: 'conflict', reason: 'paginated aggregate lacks exact failed-page authority' };

    const db = openEventLog();
    const rows = db.prepare(`
      SELECT * FROM workflow_paginated_read_pages
       WHERE activation_id = ? ORDER BY page_ordinal
    `).all(input.activationId) as PageRow[];
    const failedRow = rows.at(-1);
    if (
      rows.length !== aggregate.pageCount + 1
      || !failedRow
      || failedRow.page_ordinal !== aggregate.pageCount
      || failedRow.state !== 'failed'
      || failedRow.page_receipt_id !== null
      || failedRow.page_receipt_digest !== null
      || failedRow.result_handle_id !== null
      || rows.slice(0, -1).some((row, index) => row.page_ordinal !== index || row.state !== 'settled')
    ) return { status: 'conflict', reason: 'failed paginated page is not the exact successor of its settled prefix' };
    const pages: RedeemedClosedWorkflowReadPageV1[] = [];
    for (const [index, row] of rows.slice(0, -1).entries()) {
      const projection = settledPageProjection(ref, row);
      if (!projection || !row.settled_at || row.page_ordinal !== index) {
        return { status: 'conflict', reason: 'failed paginated settled prefix is not exactly ordered' };
      }
      const recomputed = pageReceiptDigest({
        activationDigest: ref.activationDigest,
        page: row,
        resultHandleId: projection.resultHandleId,
        settledResultDigest: projection.settledResultDigest,
        nextCursorDigest: projection.nextCursorDigest,
        exhaustedTruth: projection.exhaustedTruth,
        itemCount: projection.itemCount,
        evidenceDigest: projection.evidenceDigest,
        evidenceValid: projection.evidenceValid,
        continuationState: projection.continuationState,
      });
      if (
        !projection.evidenceValid
        || recomputed !== projection.pageReceiptDigest
        || projection.pageReceiptId !== `workflow-page-receipt:${recomputed}`
        || projection.pageReceiptDigest !== aggregate.pageReceiptDigests[index]
        || projection.resultHandleId !== aggregate.pageResultHandleIds[index]
        || projection.continuationState !== 'continue'
        || projection.exhaustedTruth !== 'false'
        || projection.nextCursorDigest === null
      ) return { status: 'conflict', reason: 'failed paginated prefix receipt does not recompute' };
      const redeemed = redeemSuccessfulSettlementResultForHost({
        sessionId: ref.sessionId,
        sourceUserSeq: ref.sourceEventSeq,
        acceptedTaskId: ref.authorityRootId,
        logicalToolCallId: row.logical_call_id,
      });
      if (redeemed.status !== 'ok') {
        return redeemed.status === 'missing'
          ? { status: 'missing', reason: 'failed paginated prefix result is missing' }
          : { status: 'conflict', reason: `failed paginated prefix result is not redeemable: ${redeemed.reason}` };
      }
      if (
        redeemed.value.physicalDispatchId !== row.physical_dispatch_id
        || redeemed.value.resultHandleId !== projection.resultHandleId
        || redeemed.value.rawPayloadSha256 !== projection.settledResultDigest
      ) return { status: 'conflict', reason: 'failed paginated prefix handle disagrees with its receipt' };
      pages.push({
        pageOrdinal: row.page_ordinal,
        pageReceiptId: projection.pageReceiptId,
        pageReceiptDigest: projection.pageReceiptDigest,
        resultHandleId: projection.resultHandleId,
        settledResultDigest: projection.settledResultDigest,
        logicalCallId: row.logical_call_id,
        physicalDispatchId: row.physical_dispatch_id,
        priorPageReceiptDigest: row.prior_page_receipt_digest,
        inputCursorDigest: row.input_cursor_digest,
        nextCursorDigest: projection.nextCursorDigest,
        exhaustedTruth: projection.exhaustedTruth,
        continuationState: projection.continuationState,
        itemCount: projection.itemCount,
        settledAt: row.settled_at,
        rawPayload: redeemed.value.rawPayload,
        rawPayloadJson: redeemed.value.rawPayloadJson,
        rawByteCount: redeemed.value.rawByteCount,
      });
    }
    if (pages.reduce((total, page) => total + page.itemCount, 0) !== aggregate.totalItemCount) {
      return { status: 'conflict', reason: 'failed paginated aggregate item total differs from its settled prefix' };
    }
    return { status: 'ok', value: { authority: ref, aggregate, pages } };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export type CloseWorkflowPaginatedReadAuthorityResult =
  | { status: 'closed' | 'replayed'; receipt: WorkflowPaginatedAggregateReceipt }
  | { status: 'not_ready' | 'missing' | 'conflict' | 'storage_error'; reason: string };

export function closeWorkflowPaginatedReadAuthority(input: {
  activationId: string;
  outcome: Exclude<WorkflowPaginatedAggregateState, 'open'>;
  reason: string;
}): CloseWorkflowPaginatedReadAuthorityResult {
  if (
    !['complete', 'partial', 'failed', 'cancelled', 'conflict'].includes(input.outcome)
    || !input.reason.trim()
  ) return { status: 'conflict', reason: 'paginated workflow terminal outcome is invalid' };
  const reason = input.reason.replace(/\s+/g, ' ').trim().slice(0, 160);
  try {
    const db = openEventLog();
    return db.transaction((): CloseWorkflowPaginatedReadAuthorityResult => {
      const existing = aggregateRow(db, input.activationId);
      if (existing) {
        const receipt = projectAggregate(existing);
        return receipt && existing.outcome === input.outcome && existing.reason === reason
          ? { status: 'replayed', receipt }
          : { status: 'conflict', reason: 'paginated workflow already closed with a different aggregate' };
      }
      const loaded = readInTransaction(db, input.activationId);
      if (loaded.status !== 'ok') return loaded;
      if (loaded.ref.aggregateState !== 'open' || loaded.authority.state !== 'open') {
        return { status: 'conflict', reason: 'paginated workflow root closed without its aggregate receipt' };
      }
      const pages = db.prepare(`
        SELECT * FROM workflow_paginated_read_pages
         WHERE activation_id = ? ORDER BY page_ordinal
      `).all(input.activationId) as PageRow[];
      const settledPages = pages.filter((page) => page.state === 'settled');
      const cursorVisits = db.prepare(`
        SELECT cursor_digest, first_page_ordinal
          FROM workflow_paginated_cursor_visits
         WHERE activation_id = ? ORDER BY first_page_ordinal
      `).all(input.activationId) as Array<{ cursor_digest: string; first_page_ordinal: number }>;
      const openWork = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM logical_tool_calls
            WHERE session_id = ? AND source_user_seq = ? AND state = 'open') AS logical_open,
          (SELECT COUNT(*) FROM physical_dispatches
            WHERE session_id = ? AND source_user_seq = ? AND state = 'started') AS physical_open
      `).get(
        loaded.ref.sessionId, loaded.ref.sourceEventSeq,
        loaded.ref.sessionId, loaded.ref.sourceEventSeq,
      ) as { logical_open: number; physical_open: number };
      if (openWork.logical_open > 0 || openWork.physical_open > 0) {
        return { status: 'not_ready', reason: 'paginated workflow still owns unsettled call work' };
      }
      const pageReceiptDigests: string[] = [];
      const pageResultHandleIds: string[] = [];
      let totalItemCount = 0;
      let chainComplete = pages.length > 0;
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index];
        const previous = pages[index - 1];
        const recomputedPageReceipt = page.result_handle_id
          && page.settled_result_digest
          && page.provider_exhausted_truth
          && page.item_count !== null
          && page.evidence_digest
          && page.evidence_valid !== null
          && page.continuation_state
          ? pageReceiptDigest({
              activationDigest: loaded.ref.activationDigest,
              page,
              resultHandleId: page.result_handle_id,
              settledResultDigest: page.settled_result_digest,
              nextCursorDigest: page.next_cursor_digest,
              exhaustedTruth: page.provider_exhausted_truth,
              itemCount: page.item_count,
              evidenceDigest: page.evidence_digest,
              evidenceValid: page.evidence_valid === 1,
              continuationState: page.continuation_state,
            })
          : null;
        const childTruth = db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM logical_tool_calls l
              WHERE l.session_id = ? AND l.source_user_seq = ?
                AND l.logical_tool_call_id = ? AND l.state = 'settled') AS logical_settled,
            (SELECT COUNT(*) FROM physical_dispatches p
              WHERE p.session_id = ? AND p.source_user_seq = ?
                AND p.physical_dispatch_id = ? AND p.logical_tool_call_id = ?
                AND p.state = 'returned' AND p.io_claimed_at IS NOT NULL) AS physical_settled,
            (SELECT COUNT(*) FROM logical_call_settlements s
              WHERE s.session_id = ? AND s.source_user_seq = ?
                AND s.logical_tool_call_id = ? AND s.result_handle_id = ?) AS settlement_bound
        `).get(
          loaded.ref.sessionId, loaded.ref.sourceEventSeq, page.logical_call_id,
          loaded.ref.sessionId, loaded.ref.sourceEventSeq,
          page.physical_dispatch_id, page.logical_call_id,
          loaded.ref.sessionId, loaded.ref.sourceEventSeq,
          page.logical_call_id, page.result_handle_id,
        ) as { logical_settled: number; physical_settled: number; settlement_bound: number };
        chainComplete = chainComplete
          && page.page_ordinal === index
          && page.state === 'settled'
          && Boolean(page.page_receipt_digest && page.result_handle_id)
          && page.page_receipt_digest === recomputedPageReceipt
          && page.page_receipt_id === `workflow-page-receipt:${recomputedPageReceipt}`
          && (index === 0
            ? page.prior_page_receipt_digest === null && page.input_cursor_digest === null
            : page.prior_page_receipt_digest === previous?.page_receipt_digest
              && page.input_cursor_digest === previous?.next_cursor_digest)
          && childTruth.logical_settled === 1
          && childTruth.physical_settled === 1
          && childTruth.settlement_bound === 1;
        if (page.page_receipt_digest) pageReceiptDigests.push(page.page_receipt_digest);
        if (page.result_handle_id) pageResultHandleIds.push(page.result_handle_id);
        if (page.state === 'settled') totalItemCount += page.item_count ?? 0;
      }
      const final = settledPages.at(-1);
      const complete = chainComplete
        && pageReceiptDigests.length === pages.length
        && pageResultHandleIds.length === pages.length
        && pages.every((page, index) => (
          page.evidence_valid === 1
          && (index === pages.length - 1
            ? page.continuation_state === 'exhausted'
            : page.continuation_state === 'continue')
        ))
        && final?.provider_exhausted_truth === 'true'
        && cursorVisits.length === Math.max(0, pages.length - 1)
        && cursorVisits.every((visit, index) => (
          visit.first_page_ordinal === index + 1
          && visit.cursor_digest === pages[index + 1]?.input_cursor_digest
        ))
        && pages.length <= loaded.ref.maxPages;
      if (input.outcome === 'complete' && !complete) {
        return { status: 'not_ready', reason: 'paginated workflow lacks exact exhaustive aggregate truth' };
      }
      const coverageState: AggregateRow['coverage_state'] = input.outcome === 'complete'
        ? 'complete'
        : pages.some((page) => page.state === 'uncertain') ? 'unknown' : 'partial';
      const finalTruth = final?.provider_exhausted_truth ?? 'none';
      const createdAt = new Date().toISOString();
      const digestInput = {
        protocolVersion: 1,
        activationId: loaded.ref.activationId,
        activationDigest: loaded.ref.activationDigest,
        authorityRootId: loaded.ref.authorityRootId,
        invocationPlanDigest: loaded.ref.invocationPlanDigest,
        bindingSnapshotDigest: loaded.ref.bindingSnapshotDigest,
        controlDigest: loaded.ref.controlDigest,
        pageReceiptDigests,
        pageResultHandleIds,
        pageCount: settledPages.length,
        totalItemCount,
        finalExhaustedTruth: finalTruth,
        coverageState,
        outcome: input.outcome,
        reason,
      };
      const aggregateReceiptDigest = sha256(closedCanonicalJson(digestInput));
      const aggregateReceiptId = `workflow-aggregate-receipt:${aggregateReceiptDigest}`;
      db.prepare(`
        INSERT INTO workflow_paginated_aggregate_receipts (
          aggregate_receipt_id, activation_id, activation_digest,
          authority_root_id, invocation_plan_digest, binding_snapshot_digest,
          control_digest, page_receipt_digests_json, page_result_handles_json,
          page_count, total_item_count, final_exhausted_truth, coverage_state,
          outcome, reason, aggregate_receipt_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        aggregateReceiptId, loaded.ref.activationId, loaded.ref.activationDigest,
        loaded.ref.authorityRootId, loaded.ref.invocationPlanDigest,
        loaded.ref.bindingSnapshotDigest, loaded.ref.controlDigest,
        JSON.stringify(pageReceiptDigests), JSON.stringify(pageResultHandleIds),
        settledPages.length, totalItemCount, finalTruth, coverageState,
        input.outcome, reason, aggregateReceiptDigest, createdAt,
      );
      const activationUpdated = db.prepare(`
        UPDATE workflow_paginated_read_activations
           SET aggregate_state = ?, terminal_aggregate_receipt_id = ?,
               terminal_aggregate_receipt_digest = ?, closed_at = ?, close_reason = ?
         WHERE activation_id = ? AND aggregate_state = 'open'
      `).run(
        input.outcome, aggregateReceiptId, aggregateReceiptDigest,
        createdAt, reason, input.activationId,
      ).changes;
      if (activationUpdated !== 1) throw new Error('paginated aggregate close lost its activation CAS');
      // A receipt-supported provider failure is a known terminal outcome, not
      // an authority-integrity conflict. Keep only contradictory roots in the
      // conflict state so the exact failed aggregate remains redeemable.
      const rootState = input.outcome === 'conflict' ? 'conflict' : 'closed';
      const rootUpdated = db.prepare(`
        UPDATE accepted_turn_call_authorities
           SET state = ?, revision = revision + 1, closed_at = ?, close_reason = ?
         WHERE session_id = ? AND source_user_seq = ?
           AND authority_kind = 'workflow_v2_paginated_read' AND state = 'open'
      `).run(
        rootState, createdAt, `workflow_paginated_${input.outcome}`,
        loaded.ref.sessionId, loaded.ref.sourceEventSeq,
      ).changes;
      if (rootUpdated !== 1) throw new Error('paginated aggregate close lost its root CAS');
      const row = aggregateRow(db, input.activationId);
      const receipt = row ? projectAggregate(row) : null;
      if (!receipt) throw new Error('closed paginated aggregate receipt disappeared');
      return { status: 'closed', receipt };
    }).immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}
