import type { DurableLogicalCallSettlementRedemption } from './logical-call-settlement-store.js';

/** Presentation only. These values are neither execution authority nor a new
 * receipt: the caller reopens the existing immutable settlement verifier. */
export interface IncompleteReviewSource { sessionId: string; sourceUserSeq: number }
export interface IncompleteReviewCall extends IncompleteReviewSource {
  acceptedTaskId: string; logicalToolCallId: string; toolName: string; outcome: string;
}
const nonnegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const recordedId = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 240
  && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ? value : null;

/** Common unknowns are explicit once, rather than repeated for each row.
 * Source-local logical calls must not become cross-successor effect IDs. */
export function incompleteReviewScope(input: IncompleteReviewSource) {
  return { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq,
    scope: 'this_accepted_source_only', crossSourceLogicalEffect: null,
    provider: null, account: null, providerOperation: null, target: null,
    currentExecutionAuthority: null } as const;
}

export function incompleteSettlementReviewFacts(expected: IncompleteReviewCall,
  redeemed: DurableLogicalCallSettlementRedemption) {
  const unavailable = { kind: 'write_settlement', proof: 'unavailable',
    noDispatchEvidence: 'not_established', physicalAttemptId: null } as const;
  if (redeemed.status !== 'ok') return unavailable;
  const settled = redeemed.settlement;
  if (settled.identity.sessionId !== expected.sessionId || settled.identity.sourceUserSeq !== expected.sourceUserSeq
    || settled.identity.acceptedTaskId !== expected.acceptedTaskId
    || settled.identity.logicalToolCallId !== expected.logicalToolCallId || settled.toolName !== expected.toolName
    || settled.outcome.kind !== expected.outcome
    || !nonnegativeInteger(settled.physicalCrossingCount) || !nonnegativeInteger(settled.hostCrossingCount)
    || typeof settled.outcome.directive.requiresReconciliation !== 'boolean') return unavailable;
  // A frame refusal and zero/missing rows are not this proof. Only the exact
  // verified call's refused execution with both crossing counts known zero is.
  // Conflicting uncertain/reconciliation state never becomes no-dispatch.
  const noDispatch = settled.executionKind === 'refused_pre_dispatch'
    && settled.physicalCrossingCount === 0 && settled.hostCrossingCount === 0
    && settled.outcome.kind !== 'uncertain_write' && !settled.outcome.directive.requiresReconciliation;
  return { kind: 'write_settlement', proof: 'exact_settlement_verified',
    acceptedTaskId: settled.identity.acceptedTaskId, logicalToolCallId: settled.identity.logicalToolCallId,
    settlementEventId: settled.settlementEventId,
    argumentDigest: settled.argumentDigest, executionKind: settled.executionKind,
    outcome: settled.outcome.kind, requiresReconciliation: settled.outcome.directive.requiresReconciliation,
    crossings: { external: settled.physicalCrossingCount, host: settled.hostCrossingCount },
    noDispatchEvidence: noDispatch ? 'this_exact_call_zero_crossings' : 'not_established',
    physicalAttemptId: null } as const;
}

/** A host journal entry identifies one admission observation. Its free-text
 * stage, recovery names and arguments never prove an operation did not run. */
export function incompleteFrameRefusalReviewFacts(expected: IncompleteReviewSource, row: {
  id: string; seq: number; sessionId: string; role: string; data: Record<string, unknown>;
}) {
  const scoped = row.sessionId === expected.sessionId && row.role === 'system' && row.data.kind === 'refused_pre_dispatch'
    && row.data.sourceUserSeq === expected.sourceUserSeq && Boolean(recordedId(row.id)) && nonnegativeInteger(row.seq);
  return { kind: 'frame_admission_observation', eventId: row.id, eventSeq: row.seq,
    sourceBinding: scoped ? 'recorded_exact_source' : 'unavailable',
    recordedAttemptId: scoped ? recordedId(row.data.runAttemptId ?? row.data.attemptId) : null,
    recordedRunId: scoped ? recordedId(row.data.runId) : null,
    noDispatchEvidence: 'not_established' } as const;
}
