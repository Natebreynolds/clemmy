/** Terminal projection of an already authenticated single-invocation read.
 * This observes exact execution authority; it grants no new tool/effect scope.
 * Finite/member reads retain their existing structural-proof path. */
import { openEventLog } from './eventlog.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { loadSealedNodeBinding } from './host-capability-catalog-factory.js';
import { loadHostCallCapabilityBinding } from './host-call-capability-binding.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { refinePreDispatchReadEvidence } from './read-evidence-refinement.js';
import type { OperationEvidenceContract } from '../graph/operation-evidence-contract.js';
import type { ResolvedOperationFact } from './resolution-ledger.js';

/** The caller cannot nominate a weaker proof: both the accepted coverage and
 * the immutable pre-dispatch classification must agree for the exact settled
 * call. Missing or mismatched authority leaves the conservative fallback. */
export function boundOnceReadEvidenceContract(input: {
  sessionId: string;
  sourceUserSeq: number;
  operation: ResolvedOperationFact;
}): OperationEvidenceContract | null {
  const { operation } = input;
  if (operation.effectKind !== 'read' || operation.dispatchState !== 'dispatched'
    || !operation.physicalDispatchId) return null;
  try {
    const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
    if (loaded.status !== 'ok') return null;
    const contract = loaded.contract;
    const selected = contract.operations.find(row => row.id === operation.operationId);
    if (selected?.effect !== 'read' || selected.cardinality.kind !== 'once') return null;
    const refined = refinePreDispatchReadEvidence({ operation: selected,
      universes: contract.universes, inputSchema: null, args: null });
    if (refined.status !== 'authoritative') return null;
    const sealed = loadSealedNodeBinding(input.sessionId, input.sourceUserSeq, selected.id);
    if (!sealed || sealed.effect !== 'read' || sealed.logicalToolName !== operation.resolvedTool) return null;
    const db = openEventLog();
    const work = db.prepare(`
      SELECT b.argument_digest, b.evidence_mode, b.evidence_basis
        FROM expected_work_call_bindings b
        JOIN logical_call_settlements s USING(session_id, source_user_seq, logical_tool_call_id)
       WHERE b.session_id=? AND b.source_user_seq=? AND b.logical_tool_call_id=?
         AND b.accepted_task_id=? AND b.contract_id=? AND b.requirement_id=?
         AND b.tool_name=? AND b.effect_kind='read' AND b.cardinality_kind='once'
         AND s.outcome_kind IN ('succeeded','empty_result') AND s.mutating=0
         AND s.business_call=1 AND s.continues_requirement=0
    `).get(input.sessionId, input.sourceUserSeq, operation.logicalToolCallId,
      contract.acceptedTaskId, contract.contractId, selected.id, operation.resolvedTool) as {
      argument_digest: string; evidence_mode: string; evidence_basis: string;
    } | undefined;
    if (!work || work.evidence_mode !== refined.mode || work.evidence_basis !== refined.basis) return null;
    const host = loadHostCallCapabilityBinding({ db, sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq, logicalToolCallId: operation.logicalToolCallId });
    if (host.status !== 'ok' || host.binding.acceptedTaskId !== contract.acceptedTaskId
      || host.binding.effect !== 'read' || host.binding.toolName !== operation.resolvedTool
      || host.binding.effectiveArgumentDigest !== work.argument_digest) return null;
    const result = redeemSuccessfulSettlementResultForHost({ sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq, acceptedTaskId: contract.acceptedTaskId,
      logicalToolCallId: operation.logicalToolCallId });
    if (result.status !== 'ok' || result.value.toolName !== operation.resolvedTool
      || result.value.physicalDispatchId !== operation.physicalDispatchId
      || result.value.outcomeKind !== operation.outcomeKind) return null;
    return { mode: refined.mode, requiresExhaustion: refined.requiresExhaustion,
      requiresStaleReconciliation: false };
  } catch { return null; }
}
