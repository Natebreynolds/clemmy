import {
  readWorkflowReadOnlyCallAuthority,
  type AcceptedTurnCallAuthority,
} from '../runtime/harness/accepted-turn-call-authority.js';
import { redeemDurableLogicalCallSettlementForHost } from '../runtime/harness/logical-call-settlement-store.js';
import {
  redeemClosedWorkflowPaginatedRead,
  redeemFailedWorkflowPaginatedRead,
} from '../runtime/harness/workflow-paginated-read-authority.js';
import { redeemSuccessfulSettlementResultForHost } from '../runtime/harness/result-handle.js';

export interface WorkflowReadResultLineageV1 {
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
}

export interface VerifiedWorkflowReadPageV1 {
  pageOrdinal: number;
  receiptKind: 'logical_settlement' | 'paginated_page';
  pageReceiptId: string;
  pageReceiptDigest: string;
  resultHandleId: string;
  settledResultDigest: string;
  logicalCallId: string;
  physicalDispatchId: string;
  inputCursorDigest: string | null;
  nextCursorDigest: string | null;
  exhausted: true | false;
  itemCount: number;
  settledAt: string;
  rawPayload: unknown;
  rawPayloadJson: string;
  rawByteCount: number;
}

export interface VerifiedClosedWorkflowReadResultV1 {
  version: 1;
  executionKind: 'single_read' | 'paginated_read';
  activationId: string;
  activationDigest: string;
  authorityRootId: string;
  aggregateReceiptId?: string;
  aggregateReceiptDigest?: string;
  pages: VerifiedWorkflowReadPageV1[];
  complete: true;
}

export interface VerifiedFailedWorkflowReadResultV1 extends Omit<
  VerifiedClosedWorkflowReadResultV1,
  'executionKind' | 'complete'
> {
  executionKind: 'paginated_read';
  complete: false;
  failure: {
    kind: 'page_execution_failed';
    aggregateReceiptId: string;
    aggregateReceiptDigest: string;
  };
}

export type RedeemVerifiedClosedWorkflowReadResultV1 =
  | { ok: true; value: VerifiedClosedWorkflowReadResultV1 }
  | { ok: false; code: 'missing' | 'conflict' | 'storage_error'; reason: string };

export type RedeemVerifiedFailedWorkflowReadResultV1 =
  | { ok: true; value: VerifiedFailedWorkflowReadResultV1 }
  | { ok: false; code: 'missing' | 'conflict' | 'storage_error'; reason: string };

function exactLineage(
  left: NonNullable<AcceptedTurnCallAuthority['workflow']>,
  right: WorkflowReadResultLineageV1,
): boolean {
  return left.workflowId === right.workflowId
    && left.workflowRevision === right.workflowRevision
    && left.workflowDigest === right.workflowDigest
    && left.runId === right.runId
    && left.runOccurrenceId === right.runOccurrenceId
    && left.nodeId === right.nodeId
    && left.nodeAttempt === right.nodeAttempt
    && left.invocationPlanDigest === right.invocationPlanDigest
    && left.bindingSnapshotDigest === right.bindingSnapshotDigest
    && left.controlDigest === right.controlDigest;
}

/**
 * Redeem only retained provider bytes named by a closed v51/v52 workflow read
 * authority. Callers cannot supply page bodies or reinterpret an open/partial
 * root. The returned order is the immutable page order.
 */
export function redeemVerifiedClosedWorkflowReadResult(input: {
  executionKind: 'single_read' | 'paginated_read';
  activationId: string;
  lineage: WorkflowReadResultLineageV1;
}): RedeemVerifiedClosedWorkflowReadResultV1 {
  if (input.executionKind === 'paginated_read') {
    const redeemed = redeemClosedWorkflowPaginatedRead({
      activationId: input.activationId,
      ...input.lineage,
    });
    if (redeemed.status !== 'ok') {
      return { ok: false, code: redeemed.status, reason: redeemed.reason };
    }
    return {
      ok: true,
      value: {
        version: 1,
        executionKind: 'paginated_read',
        activationId: redeemed.value.authority.activationId,
        activationDigest: redeemed.value.authority.activationDigest,
        authorityRootId: redeemed.value.authority.authorityRootId,
        aggregateReceiptId: redeemed.value.aggregate.aggregateReceiptId,
        aggregateReceiptDigest: redeemed.value.aggregate.aggregateReceiptDigest,
        pages: redeemed.value.pages.map((page) => ({
          pageOrdinal: page.pageOrdinal,
          receiptKind: 'paginated_page',
          pageReceiptId: page.pageReceiptId,
          pageReceiptDigest: page.pageReceiptDigest,
          resultHandleId: page.resultHandleId,
          settledResultDigest: page.settledResultDigest,
          logicalCallId: page.logicalCallId,
          physicalDispatchId: page.physicalDispatchId,
          inputCursorDigest: page.inputCursorDigest,
          nextCursorDigest: page.nextCursorDigest,
          exhausted: page.exhaustedTruth === 'true',
          itemCount: page.itemCount,
          settledAt: page.settledAt,
          rawPayload: page.rawPayload,
          rawPayloadJson: page.rawPayloadJson,
          rawByteCount: page.rawByteCount,
        })),
        complete: true,
      },
    };
  }

  const loaded = readWorkflowReadOnlyCallAuthority(input.activationId);
  if (loaded.status !== 'ok') {
    return { ok: false, code: loaded.status, reason: loaded.reason };
  }
  const workflow = loaded.authority.workflow;
  if (
    loaded.authority.authorityKind !== 'workflow_v1_read_only'
    || loaded.authority.state !== 'closed'
    || loaded.authority.closeReason !== 'workflow_completed'
    || !loaded.authority.closedAt
    || !workflow
    || workflow.activationId !== input.activationId
    || !exactLineage(workflow, input.lineage)
  ) return { ok: false, code: 'conflict', reason: 'single-read authority is not the exact successful closed workflow root' };
  const settlement = redeemDurableLogicalCallSettlementForHost({
    sessionId: loaded.authority.identity.sessionId,
    sourceUserSeq: loaded.authority.identity.sourceUserSeq,
    acceptedTaskId: loaded.authority.identity.acceptedTaskId,
    logicalToolCallId: workflow.logicalCallId,
  });
  if (settlement.status !== 'ok') {
    return {
      ok: false,
      code: settlement.status === 'corrupt' ? 'conflict' : settlement.status,
      reason: settlement.reason,
    };
  }
  if (
    !['succeeded', 'empty_result'].includes(settlement.settlement.outcome.kind)
    || !settlement.settlement.resultHandleId
  ) return { ok: false, code: 'conflict', reason: 'single-read logical settlement is not a successful retained result' };
  const result = redeemSuccessfulSettlementResultForHost({
    sessionId: loaded.authority.identity.sessionId,
    sourceUserSeq: loaded.authority.identity.sourceUserSeq,
    acceptedTaskId: loaded.authority.identity.acceptedTaskId,
    logicalToolCallId: workflow.logicalCallId,
  });
  if (result.status !== 'ok') return {
    ok: false,
    code: result.status === 'missing' || result.status === 'storage_error'
      ? result.status
      : 'conflict',
    reason: result.reason,
  };
  if (result.value.resultHandleId !== settlement.settlement.resultHandleId) {
    return { ok: false, code: 'conflict', reason: 'single-read logical settlement and retained result handle disagree' };
  }
  return {
    ok: true,
    value: {
      version: 1,
      executionKind: 'single_read',
      activationId: workflow.activationId,
      activationDigest: workflow.activationDigest,
      authorityRootId: workflow.authorityRootId,
      pages: [{
        pageOrdinal: 0,
        receiptKind: 'logical_settlement',
        pageReceiptId: settlement.settlement.settlementEventId,
        pageReceiptDigest: settlement.settlement.semanticDigest,
        resultHandleId: result.value.resultHandleId,
        settledResultDigest: result.value.rawPayloadSha256,
        logicalCallId: workflow.logicalCallId,
        physicalDispatchId: result.value.physicalDispatchId,
        inputCursorDigest: null,
        nextCursorDigest: null,
        exhausted: true,
        itemCount: result.value.handle.recordCount,
        settledAt: settlement.settlement.settledAt,
        rawPayload: result.value.rawPayload,
        rawPayloadJson: result.value.rawPayloadJson,
        rawByteCount: result.value.rawByteCount,
      }],
      complete: true,
    },
  };
}

/** Redeem a digest-bound settled prefix plus its exact failed successor. */
export function redeemVerifiedFailedWorkflowReadResult(input: {
  executionKind: 'single_read' | 'paginated_read';
  activationId: string;
  lineage: WorkflowReadResultLineageV1;
}): RedeemVerifiedFailedWorkflowReadResultV1 {
  if (input.executionKind !== 'paginated_read') {
    return { ok: false, code: 'conflict', reason: 'failed partition projection requires paginated workflow-read authority' };
  }
  const redeemed = redeemFailedWorkflowPaginatedRead({
    activationId: input.activationId,
    ...input.lineage,
  });
  if (redeemed.status !== 'ok') {
    return { ok: false, code: redeemed.status, reason: redeemed.reason };
  }
  return {
    ok: true,
    value: {
      version: 1,
      executionKind: 'paginated_read',
      activationId: redeemed.value.authority.activationId,
      activationDigest: redeemed.value.authority.activationDigest,
      authorityRootId: redeemed.value.authority.authorityRootId,
      aggregateReceiptId: redeemed.value.aggregate.aggregateReceiptId,
      aggregateReceiptDigest: redeemed.value.aggregate.aggregateReceiptDigest,
      pages: redeemed.value.pages.map((page) => ({
        pageOrdinal: page.pageOrdinal,
        receiptKind: 'paginated_page',
        pageReceiptId: page.pageReceiptId,
        pageReceiptDigest: page.pageReceiptDigest,
        resultHandleId: page.resultHandleId,
        settledResultDigest: page.settledResultDigest,
        logicalCallId: page.logicalCallId,
        physicalDispatchId: page.physicalDispatchId,
        inputCursorDigest: page.inputCursorDigest,
        nextCursorDigest: page.nextCursorDigest,
        exhausted: false,
        itemCount: page.itemCount,
        settledAt: page.settledAt,
        rawPayload: page.rawPayload,
        rawPayloadJson: page.rawPayloadJson,
        rawByteCount: page.rawByteCount,
      })),
      complete: false,
      failure: {
        kind: 'page_execution_failed',
        aggregateReceiptId: redeemed.value.aggregate.aggregateReceiptId,
        aggregateReceiptDigest: redeemed.value.aggregate.aggregateReceiptDigest,
      },
    },
  };
}
