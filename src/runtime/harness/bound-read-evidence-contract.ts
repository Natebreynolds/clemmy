/** Terminal projection of an already authenticated read invocation.
 * This observes exact execution authority; it grants no new tool/effect scope.
 * Reviewed member reads retain their exact pre-dispatch member proof. */
import { openEventLog } from './eventlog.js';
import { acceptedPlanExecution } from './accepted-plan-execution.js';
import { PlanCollectionSchema, reviewedCollectionMembers } from './reviewed-plan-collection.js';
import { resolveReviewedPlanCollectionRecords } from './reviewed-plan-results.js';
import { canonicalExpectedWorkJson, expectedWorkDigest } from './expected-work-contract.js';
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
    const db = openEventLog();
    const work = db.prepare(`
      SELECT b.argument_digest, b.evidence_mode, b.evidence_basis, b.requirement_id,
             b.cardinality_kind, b.universe_id, b.universe_item_id,
             b.universe_member_count, b.universe_member_digest
        FROM expected_work_call_bindings b
        JOIN logical_call_settlements s USING(session_id, source_user_seq, logical_tool_call_id)
       WHERE b.session_id=? AND b.source_user_seq=? AND b.logical_tool_call_id=?
         AND b.accepted_task_id=? AND b.contract_id=?
         AND b.tool_name=? AND b.effect_kind='read'
         AND s.outcome_kind IN ('succeeded','empty_result') AND s.mutating=0
         AND s.business_call=1 AND s.continues_requirement=0
    `).get(input.sessionId, input.sourceUserSeq, operation.logicalToolCallId,
      contract.acceptedTaskId, contract.contractId, operation.resolvedTool) as {
      argument_digest: string; evidence_mode: string; evidence_basis: string;
      requirement_id: string; cardinality_kind: string; universe_id: string;
      universe_item_id: string; universe_member_count: number; universe_member_digest: string;
    } | undefined;
    if (!work) return null;
    const selected = contract.operations.find(row => row.id === work.requirement_id);
    if (selected?.effect !== 'read' || selected.cardinality.kind !== work.cardinality_kind) return null;
    let refined: OperationEvidenceContract & { basis: string };
    if (selected.cardinality.kind === 'once') {
      // Later actual observations have their own operation id. The immutable
      // call binding above identifies the requirement; a suffixed readback
      // must not fall back to an unrelated collection/exhaustion contract.
      if (!db.prepare(`SELECT 1 FROM accepted_task_operations WHERE session_id=? AND source_user_seq=?
        AND operation_id=? AND logical_tool_call_id=?`).get(input.sessionId, input.sourceUserSeq,
        operation.operationId, operation.logicalToolCallId)) return null;
      const once = refinePreDispatchReadEvidence({ operation: selected,
        universes: contract.universes, inputSchema: null, args: null });
      if (once.status !== 'authoritative') return null;
      refined = { ...once, requiresStaleReconciliation: false };
    } else if (selected.cardinality.kind === 'each' && selected.coverage === 'single') {
      // Admission proved the approved member-to-argument mapping before the
      // call. Reopen that exact plan and member; an arbitrary finite read or
      // an exhaustive collection cannot borrow this point-read contract.
      const execution = acceptedPlanExecution(input.sessionId, input.sourceUserSeq);
      const steps = execution?.artifact.structuredPlan?.steps;
      const step = Array.isArray(steps) ? steps.find(row => row && typeof row === 'object' && !Array.isArray(row) && row.id === selected.id) : null;
      if (!step || typeof step !== 'object' || Array.isArray(step) || !step.forEach || step.effect !== 'read') return null;
      const collection = PlanCollectionSchema.parse(step.forEach);
      if (work.universe_id !== selected.cardinality.universeId
        || work.universe_member_count !== 1
        || work.universe_member_digest !== expectedWorkDigest(canonicalExpectedWorkJson([work.universe_item_id]))
        || !reviewedCollectionMembers(collection, resolveReviewedPlanCollectionRecords(input, collection))
          .some(member => member.id === work.universe_item_id)) return null;
      refined = { mode: 'point_read', requiresExhaustion: false,
        requiresStaleReconciliation: false, basis: 'reviewed_plan_member' };
    } else return null;
    if (work.evidence_mode !== refined.mode || work.evidence_basis !== refined.basis) return null;
    const sealed = loadSealedNodeBinding(input.sessionId, input.sourceUserSeq, selected.id);
    if (!sealed || sealed.effect !== 'read' || sealed.logicalToolName !== operation.resolvedTool) return null;
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
