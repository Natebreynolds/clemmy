/** Proof for one exact selected native revision dependency. This observes an
 * existing settled effect; it grants neither dispatch nor replay authority. */
import { openEventLog } from './eventlog.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { loadSealedNodeBinding } from './host-capability-catalog-factory.js';
import { loadHostCallCapabilityBinding } from './host-call-capability-binding.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { parseHostLocalWriteCommitFacts, readCommittedArtifactContent } from './host-local-write-commit.js';
import { proveHostLocalWorkspaceDerivation } from './host-local-workspace-derivation.js';
import { TOOL_REGISTRY } from '../../tools/tool-registry.js';

export function proveNativeRevisionCommit(input: {
  sessionId: string; sourceUserSeq: number; acceptedTaskId: string;
  contractId: string; requirementId: string; logicalToolCallId: string;
}): { status: 'verified'; handle: string; contentDigest: string }
  | { status: 'unverified'; reason: string } {
  const refuse = (reason: string) => ({ status: 'unverified' as const, reason });
  try {
    const db = openEventLog();
    const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
    if (loaded.status !== 'ok' || loaded.contract.contractId !== input.contractId
      || loaded.contract.acceptedTaskId !== input.acceptedTaskId) return refuse('native revision contract is not exact');
    const operation = loaded.contract.operations.find(row => row.id === input.requirementId);
    if (operation?.effect !== 'local_write') return refuse('native revision requirement is not a local write');
    const sealed = loadSealedNodeBinding(input.sessionId, input.sourceUserSeq, input.requirementId);
    if (!sealed || sealed.effect !== 'local_write') return refuse('native revision selection is not sealed');
    const work = db.prepare(`SELECT b.tool_name, b.argument_digest FROM expected_work_call_bindings b
      JOIN logical_call_settlements s USING(session_id,source_user_seq,logical_tool_call_id)
      WHERE b.session_id=? AND b.source_user_seq=? AND b.logical_tool_call_id=?
        AND b.accepted_task_id=? AND b.contract_id=? AND b.requirement_id=?
        AND b.effect_kind='local_write' AND s.outcome_kind='succeeded'
        AND s.mutating=1 AND s.continues_requirement=0`).get(input.sessionId,input.sourceUserSeq,
          input.logicalToolCallId,input.acceptedTaskId,input.contractId,input.requirementId) as {tool_name:string;argument_digest:string} | undefined;
    if (!work || work.tool_name !== sealed.logicalToolName) return refuse('native revision has no exact successful work binding');
    const host = loadHostCallCapabilityBinding({db,...input});
    if (host.status !== 'ok' || host.binding.acceptedTaskId !== input.acceptedTaskId
      || host.binding.bindingKind !== 'local_envelope' || host.binding.effect !== 'local_write'
      || host.binding.toolName !== work.tool_name || host.binding.effectiveArgumentDigest !== work.argument_digest) {
      return refuse('native revision has no exact local host envelope');
    }
    const declarations = TOOL_REGISTRY.filter(row => row.name === work.tool_name);
    if (declarations.length !== 1 || declarations[0]!.sideEffect !== 'write'
      || !declarations[0]!.localPlanning?.outputKind.endsWith('_revision')) {
      return refuse('operation does not declare a native revision receipt');
    }
    const redeemed = redeemSuccessfulSettlementResultForHost(input);
    if (redeemed.status !== 'ok') return refuse(`native revision result is ${redeemed.status}`);
    const evidence = redeemed.value;
    if (evidence.executionSite !== 'host' || evidence.outcomeKind !== 'succeeded'
      || evidence.toolName !== work.tool_name) return refuse('native revision result provenance disagrees');
    const facts = parseHostLocalWriteCommitFacts(evidence.rawPayload);
    if (!facts) return refuse('native revision receipt is missing or malformed');
    const content = readCommittedArtifactContent(facts);
    if (!content.verified || content.parts.length === 0) return refuse(content.unresolvedReason ?? 'native revision current bytes are unverified');
    // A commit proves the authored bytes landed, not that they descend from a
    // promised source. Retain the existing stronger proof whenever the graph
    // declares content lineage, including all canonical source result checks.
    if (operation.dataFrom.length > 0) {
      const derivation = proveHostLocalWorkspaceDerivation({db,...input,
        writeLogicalToolCallId:input.logicalToolCallId,
        resolveSuccessfulResult(logicalToolCallId) {
          const result = redeemSuccessfulSettlementResultForHost({...input,logicalToolCallId});
          return result.status === 'ok'
            ? {ok:true,rawPayload:result.value.rawPayload,toolName:result.value.toolName,executionSite:result.value.executionSite}
            : {ok:false,reason:result.reason};
        }});
      if (derivation.status !== 'verified') return refuse(`native revision source derivation is unverified: ${derivation.reason}`);
    }
    return {status:'verified',handle:facts.handle,contentDigest:facts.contentDigest};
  } catch { return refuse('native revision proof storage is unavailable'); }
}
