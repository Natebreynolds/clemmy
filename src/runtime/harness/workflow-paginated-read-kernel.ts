/** Canonical one-chain executor for workflow_v2_paginated_read. */
import {
  beginPhysicalDispatch,
  settlePhysicalDispatch,
  type PhysicalCrossingIdentity,
} from './dispatch-ledger.js';
import { claimWorkflowPaginatedPhysicalIo } from './physical-io-claim.js';
import { commitLogicalCallSettlement } from './logical-call-settlement-store.js';
import { classifyAttemptOutcome } from './attempt-outcome.js';
import {
  closeWorkflowPaginatedReadAuthority,
  markWorkflowReadPageFailed,
  mintWorkflowReadPageAttestation,
  readWorkflowPaginatedReadAuthority,
  redeemWorkflowPaginatedAggregate,
  reserveWorkflowReadPage,
  settleWorkflowReadPage,
  withWorkflowReadPageAttestation,
  type WorkflowPaginatedAggregateReceipt,
  type WorkflowPageContinuationState,
} from './workflow-paginated-read-authority.js';
import {
  peekHostCapabilityCatalogFactory,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import { resolveProductionPortsForManifest } from './production-capability-ports.js';
import {
  parseWorkflowNodeInvocationPlan,
  type WorkflowNodeInvocationPlanV1,
} from '../../memory/workflow-node-invocation-plan.js';

export type ExecuteWorkflowPaginatedReadResult =
  | {
      status: 'completed' | 'replayed';
      activationId: string;
      aggregate: WorkflowPaginatedAggregateReceipt;
    }
  | {
      status: 'partial';
      activationId: string;
      reason: string;
      aggregate: WorkflowPaginatedAggregateReceipt;
    }
  | {
      status: 'blocked' | 'failed';
      activationId: string;
      reason: string;
      zeroBody: boolean;
      aggregate?: WorkflowPaginatedAggregateReceipt;
    };

type PageExecutionResult =
  | { status: 'settled'; result: unknown; continuationState: WorkflowPageContinuationState }
  | { status: 'blocked' | 'failed'; reason: string; zeroBody: boolean };

function refusalReason(value: object, fallback: string): string {
  return 'reason' in value && typeof value.reason === 'string' ? value.reason : fallback;
}

function exactPortBinding(
  plan: WorkflowNodeInvocationPlanV1,
): { capability: RegisteredHostCapability; invoke: RegisteredHostCapability['invoke'] } | null {
  const capability = peekHostCapabilityCatalogFactory()?.get(plan.binding.capabilityId);
  if (!capability?.manifest) return null;
  const port = resolveProductionPortsForManifest(capability.manifest);
  return port ? { capability, invoke: port.invoke } : null;
}

function valueAtPath(value: unknown, path: string): unknown {
  const tokens = path.match(/[A-Za-z_][A-Za-z0-9_-]*|\[(?:0|[1-9]\d*)\]/g);
  if (!tokens || tokens.join('.').replace(/\.\[/g, '[') !== path) return undefined;
  let current: unknown = value;
  for (const token of tokens) {
    if (token.startsWith('[')) {
      const index = Number(token.slice(1, -1));
      if (!Array.isArray(current) || index >= current.length) return undefined;
      current = current[index];
    } else {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
      if (!Object.prototype.hasOwnProperty.call(current, token)) return undefined;
      current = (current as Record<string, unknown>)[token];
    }
  }
  return current;
}

function closePartial(
  activationId: string,
  reason: string,
  outcome: 'partial' | 'cancelled' | 'failed' = 'partial',
): ExecuteWorkflowPaginatedReadResult {
  const closed = closeWorkflowPaginatedReadAuthority({ activationId, outcome, reason });
  if (closed.status === 'closed' || closed.status === 'replayed') {
    return outcome === 'failed'
      ? { status: 'failed', activationId, reason, zeroBody: false, aggregate: closed.receipt }
      : { status: 'partial', activationId, reason, aggregate: closed.receipt };
  }
  return {
    status: outcome === 'failed' ? 'failed' : 'blocked',
    activationId,
    reason: `${reason}; aggregate close ${closed.status}: ${refusalReason(closed, 'unknown close refusal')}`,
    zeroBody: outcome !== 'failed',
  };
}

async function executePage(input: {
  activationId: string;
  pageOrdinal: number;
  plan: WorkflowNodeInvocationPlanV1;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<PageExecutionResult> {
  const alreadySettled = settleWorkflowReadPage({
    activationId: input.activationId,
    pageOrdinal: input.pageOrdinal,
    invocationPlan: input.plan,
  });
  if (alreadySettled.status === 'settled' || alreadySettled.status === 'replayed') {
    return {
      status: 'settled',
      result: alreadySettled.result,
      continuationState: alreadySettled.page.continuationState,
    };
  }
  if (alreadySettled.status !== 'not_ready') {
    return { status: 'blocked', reason: refusalReason(alreadySettled, 'page settlement refused'), zeroBody: true };
  }
  if (input.signal?.aborted) {
    markWorkflowReadPageFailed({
      activationId: input.activationId,
      pageOrdinal: input.pageOrdinal,
      state: 'cancelled',
    });
    return { status: 'blocked', reason: 'paginated workflow read cancelled before page admission', zeroBody: true };
  }
  const minted = mintWorkflowReadPageAttestation({
    activationId: input.activationId,
    pageOrdinal: input.pageOrdinal,
    invocationPlan: input.plan,
    args: input.args,
  });
  if (minted.status !== 'minted') {
    return { status: 'blocked', reason: minted.reason, zeroBody: true };
  }
  const exactPort = exactPortBinding(input.plan);
  if (!exactPort) return { status: 'blocked', reason: 'paginated exact immutable invoke port is unavailable', zeroBody: true };
  const identity: PhysicalCrossingIdentity = {
    sessionId: minted.ref.sessionId,
    sourceUserSeq: minted.ref.sourceEventSeq,
    acceptedTaskId: minted.ref.authorityRootId,
    logicalToolCallId: minted.ref.logicalCallId,
    physicalDispatchId: minted.ref.physicalDispatchId,
    ordinal: 0,
  };
  if (input.signal?.aborted) {
    markWorkflowReadPageFailed({
      activationId: input.activationId,
      pageOrdinal: input.pageOrdinal,
      state: 'cancelled',
    });
    return { status: 'blocked', reason: 'paginated workflow read cancelled before physical reservation', zeroBody: true };
  }
  return withWorkflowReadPageAttestation(minted.proof, async (): Promise<PageExecutionResult> => {
    const begun = beginPhysicalDispatch({ identity, tool: minted.toolName, args: input.args });
    if (begun.status !== 'inserted' && begun.status !== 'replayed') {
      return { status: 'blocked', reason: begun.reason, zeroBody: true };
    }
    const claim = claimWorkflowPaginatedPhysicalIo({
      identity: {
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        physicalDispatchId: identity.physicalDispatchId,
        authorityRootId: identity.acceptedTaskId,
        logicalCallId: identity.logicalToolCallId,
      },
      activationId: minted.ref.activationId,
      activationDigest: minted.ref.activationDigest,
      authorityDigest: minted.ref.authorityDigest,
      authorityRevision: minted.ref.authorityRevision,
      pageOrdinal: minted.ref.pageOrdinal,
      toolName: minted.toolName,
    });
    if (!claim.claimed) {
      return {
        status: 'blocked',
        reason: claim.reason === 'already_claimed'
          ? 'prior_crossing_unknown_no_redispatch'
          : `paginated physical I/O claim refused: ${claim.reason}`,
        zeroBody: claim.reason !== 'already_claimed',
      };
    }
    let result: unknown;
    try {
      result = await exactPort.invoke({
        nodeId: minted.ref.nodeId,
        role: input.plan.requirementId,
        payload: structuredClone(input.args),
        identity: {
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          acceptedTaskId: identity.acceptedTaskId,
        },
        binding: {
          capabilityId: exactPort.capability.capabilityId,
          toolName: exactPort.capability.toolName,
          schemaVersion: exactPort.capability.schemaVersion,
          schemaDigest: exactPort.capability.schemaDigest,
          args: structuredClone(input.args),
          account: exactPort.capability.account,
          effect: exactPort.capability.effect,
          destination: exactPort.capability.destination,
          manifestDigest: exactPort.capability.manifestDigest,
          providerKind: exactPort.capability.providerKind,
          liveFingerprint: exactPort.capability.liveFingerprint,
          delegatedFrom: exactPort.capability.delegatedFrom,
          manifest: exactPort.capability.manifest,
          reconcile: exactPort.capability.reconcile,
          invoke: exactPort.invoke,
        },
      });
    } catch (error) {
      const physical = settlePhysicalDispatch({
        identity: begun.identity,
        tool: minted.toolName,
        outcome: 'threw',
        turn: 0,
      });
      const logical = physical.status === 'inserted' || physical.status === 'replayed'
        ? commitLogicalCallSettlement({
            identity: {
              sessionId: identity.sessionId,
              sourceUserSeq: identity.sourceUserSeq,
              acceptedTaskId: identity.acceptedTaskId,
              logicalToolCallId: identity.logicalToolCallId,
            },
            contract: { toolName: minted.toolName, args: input.args },
            execution: { kind: 'provider_execution' },
            outcome: classifyAttemptOutcome({ executionFailed: true }),
            recovery: { businessCall: true, mutating: false, requirementId: input.plan.requirementId },
            observer: { lane: 'agents_runner', callId: identity.logicalToolCallId, turn: 0 },
          })
        : null;
      markWorkflowReadPageFailed({
        activationId: input.activationId,
        pageOrdinal: input.pageOrdinal,
        state: 'failed',
      });
      const reason = logical && (logical.status === 'committed' || logical.status === 'replayed')
        ? boundedError(error)
        : `paginated failed-call settlement refused: ${logical && 'reason' in logical ? logical.reason : 'physical settlement failed'}`;
      return { status: 'failed', reason, zeroBody: false };
    }
    const physical = settlePhysicalDispatch({
      identity: begun.identity,
      tool: minted.toolName,
      outcome: 'returned',
      turn: 0,
    });
    if (physical.status !== 'inserted' && physical.status !== 'replayed') {
      markWorkflowReadPageFailed({ activationId: input.activationId, pageOrdinal: input.pageOrdinal, state: 'uncertain' });
      return { status: 'failed', reason: physical.reason, zeroBody: false };
    }
    const logical = commitLogicalCallSettlement({
      identity: {
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedTaskId: identity.acceptedTaskId,
        logicalToolCallId: identity.logicalToolCallId,
      },
      contract: { toolName: minted.toolName, args: input.args },
      execution: { kind: 'provider_execution' },
      result: { payload: result },
      outcome: classifyAttemptOutcome({ envelopeSuccessful: true }),
      recovery: { businessCall: true, mutating: false, requirementId: input.plan.requirementId },
      observer: { lane: 'agents_runner', callId: identity.logicalToolCallId, turn: 0 },
    });
    if (logical.status !== 'committed' && logical.status !== 'replayed') {
      markWorkflowReadPageFailed({ activationId: input.activationId, pageOrdinal: input.pageOrdinal, state: 'uncertain' });
      return { status: 'failed', reason: logical.reason, zeroBody: false };
    }
    const settled = settleWorkflowReadPage({
      activationId: input.activationId,
      pageOrdinal: input.pageOrdinal,
      invocationPlan: input.plan,
    });
    if (settled.status !== 'settled' && settled.status !== 'replayed') {
      return { status: 'failed', reason: refusalReason(settled, 'page settlement refused'), zeroBody: false };
    }
    return {
      status: 'settled',
      result: settled.result,
      continuationState: settled.page.continuationState,
    };
  });
}

function boundedError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').trim().slice(0, 160)
    || 'paginated workflow provider read failed';
}

/** Execute or replay the entire cursor chain. There is no model/legacy fallback. */
export async function executeWorkflowPaginatedRead(input: {
  activationId: string;
  invocationPlan: unknown;
  baseArgs: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ExecuteWorkflowPaginatedReadResult> {
  const loaded = readWorkflowPaginatedReadAuthority(input.activationId);
  if (loaded.status !== 'ok') {
    return { status: 'blocked', activationId: input.activationId, reason: loaded.reason, zeroBody: true };
  }
  if (loaded.ref.aggregateState !== 'open' || loaded.authority.state !== 'open') {
    const replay = redeemWorkflowPaginatedAggregate(input.activationId);
    if (replay.status !== 'ok') {
      return { status: 'blocked', activationId: input.activationId, reason: replay.reason, zeroBody: true };
    }
    if (replay.receipt.outcome === 'complete') {
      return { status: 'replayed', activationId: input.activationId, aggregate: replay.receipt };
    }
    if (replay.receipt.outcome === 'partial' || replay.receipt.outcome === 'cancelled') {
      return {
        status: 'partial',
        activationId: input.activationId,
        reason: replay.receipt.reason,
        aggregate: replay.receipt,
      };
    }
    return {
      status: 'failed',
      activationId: input.activationId,
      reason: replay.receipt.reason,
      zeroBody: false,
      aggregate: replay.receipt,
    };
  }
  const parsed = parseWorkflowNodeInvocationPlan(input.invocationPlan);
  if (
    !parsed.ok
    || parsed.plan.bindingDigest !== loaded.ref.invocationPlanDigest
    || parsed.plan.binding.effect !== 'read'
    || parsed.plan.continuation.kind !== 'cursor'
    || parsed.plan.completeness.kind !== 'finite_exhaustive'
  ) return { status: 'blocked', activationId: input.activationId, reason: 'paginated execution plan is not exact', zeroBody: true };
  const plan = parsed.plan;
  if (plan.continuation.kind !== 'cursor') {
    return { status: 'blocked', activationId: input.activationId, reason: 'paginated execution lacks cursor continuation', zeroBody: true };
  }
  const continuation = plan.continuation;
  if (Object.prototype.hasOwnProperty.call(input.baseArgs, continuation.cursorArgument)) {
    return { status: 'blocked', activationId: input.activationId, reason: 'base arguments cannot supply the host-owned cursor', zeroBody: true };
  }
  let priorReceiptDigest: string | null = null;
  let cursor: unknown;
  for (let ordinal = 0; ordinal < continuation.maxPages; ordinal += 1) {
    const args = structuredClone(input.baseArgs);
    if (ordinal > 0) args[continuation.cursorArgument] = structuredClone(cursor);
    const reserved = reserveWorkflowReadPage({
      activationId: input.activationId,
      pageOrdinal: ordinal,
      priorPageReceiptDigest: priorReceiptDigest,
      invocationPlan: plan,
      args,
    });
    if (reserved.status === 'budget_exhausted') {
      return closePartial(input.activationId, 'maximum_page_budget_reached');
    }
    if (reserved.status === 'repeated_cursor') {
      return closePartial(input.activationId, 'repeated_cursor');
    }
    if (reserved.status !== 'reserved' && reserved.status !== 'replayed') {
      return {
        status: 'blocked',
        activationId: input.activationId,
        reason: refusalReason(reserved, 'page reservation refused'),
        zeroBody: true,
      };
    }
    const page = await executePage({
      activationId: input.activationId,
      pageOrdinal: ordinal,
      plan,
      args,
      signal: input.signal,
    });
    if (page.status === 'blocked') {
      if (page.reason.includes('cancelled before')) {
        return closePartial(input.activationId, 'cancelled_before_page_crossing', 'cancelled');
      }
      if (
        page.zeroBody
        && (
          page.reason.includes('live binding')
          || page.reason.includes('independent observation')
          || page.reason.includes('immutable invoke port')
        )
      ) return closePartial(input.activationId, 'live_binding_drift');
      return { status: 'blocked', activationId: input.activationId, reason: page.reason, zeroBody: page.zeroBody };
    }
    if (page.status === 'failed') {
      return closePartial(input.activationId, 'page_execution_failed', 'failed');
    }
    const settled = settleWorkflowReadPage({
      activationId: input.activationId,
      pageOrdinal: ordinal,
      invocationPlan: plan,
    });
    if (settled.status !== 'settled' && settled.status !== 'replayed') {
      return {
        status: 'failed',
        activationId: input.activationId,
        reason: refusalReason(settled, 'page settlement refused'),
        zeroBody: false,
      };
    }
    priorReceiptDigest = settled.page.pageReceiptDigest;
    if (input.signal?.aborted) {
      return closePartial(input.activationId, 'cancelled_after_settled_page', 'cancelled');
    }
    if (settled.page.continuationState === 'exhausted') {
      const closed = closeWorkflowPaginatedReadAuthority({
        activationId: input.activationId,
        outcome: 'complete',
        reason: 'provider_declared_exhausted',
      });
      return closed.status === 'closed' || closed.status === 'replayed'
        ? { status: 'completed', activationId: input.activationId, aggregate: closed.receipt }
        : {
            status: 'failed',
            activationId: input.activationId,
            reason: refusalReason(closed, 'aggregate close refused'),
            zeroBody: false,
          };
    }
    if (settled.page.continuationState !== 'continue') {
      return closePartial(input.activationId, settled.page.continuationState);
    }
    if (ordinal + 1 >= continuation.maxPages) {
      return closePartial(input.activationId, 'maximum_page_budget_reached');
    }
    cursor = valueAtPath(settled.result, continuation.nextCursorPath);
  }
  return closePartial(input.activationId, 'maximum_page_budget_reached');
}
