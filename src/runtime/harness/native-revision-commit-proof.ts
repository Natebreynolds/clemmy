import { proveWorkflowDispatchCommitWithPorts } from './workflow-dispatch-commit.js';
/** Runtime store adapters for the shared native revision verifier. */
import { openEventLog } from './eventlog.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { loadSealedNodeBinding } from './host-capability-catalog-factory.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { proveNativeRevisionCommitWithPorts, type RevisionProofInput } from './native-revision-proof-core.js';
function runtimePorts() {
  return {
    db: openEventLog(),
    loadContract(identity) {
      const result = loadExpectedWorkContract(identity.sessionId, identity.sourceUserSeq);
      return result.status === 'ok' ? result.contract : null;
    },
    loadSelection(identity) { return loadSealedNodeBinding(identity.sessionId, identity.sourceUserSeq, identity.requirementId); },
    redeem(identity) {
      const result = redeemSuccessfulSettlementResultForHost(identity);
      return result.status === 'ok' ? result : { status: 'unavailable', reason: result.reason };
    },
  } satisfies import('./native-revision-proof-core.js').NativeRevisionProofPorts;
}
export function proveNativeRevisionCommit(input: RevisionProofInput) {
  return proveNativeRevisionCommitWithPorts(input, runtimePorts());
}
export function proveWorkflowDispatchCommit(input: RevisionProofInput) {
  return proveWorkflowDispatchCommitWithPorts(input, runtimePorts());
}

/** Reuse the execution proof for artifact identity dependencies. Content
 * derivation and structured deliverables retain their existing evidence path. */
export function verifiedNativeIdentityDerivation(input: {
  sessionId: string; sourceUserSeq: number; acceptedTaskId: string;
  logicalToolCallId: string; operationId: string;
}): boolean {
  const binding = openEventLog().prepare(`SELECT contract_id, requirement_id FROM expected_work_call_bindings
    WHERE session_id=? AND source_user_seq=? AND accepted_task_id=? AND logical_tool_call_id=?`)
    .get(input.sessionId, input.sourceUserSeq, input.acceptedTaskId, input.logicalToolCallId) as
    { contract_id: string; requirement_id: string } | undefined;
  if (!binding || binding.requirement_id !== input.operationId) return false;
  const proof = proveNativeRevisionCommit({ ...input, contractId: binding.contract_id, requirementId: binding.requirement_id });
  return proof.status === 'verified' && proof.identityLineageVerified;
}
