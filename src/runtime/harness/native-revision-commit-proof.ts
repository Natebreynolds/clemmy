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

type RevisionProofInput = {
  sessionId: string; sourceUserSeq: number; acceptedTaskId: string;
  contractId: string; requirementId: string; logicalToolCallId: string;
};

type RevisionProof = { status: 'verified'; handle: string; contentDigest: string; createdId: string;
  boundAt: string; settledAt: string; outputKind: string } | { status: 'unverified'; reason: string };

export function proveNativeRevisionCommit(input: RevisionProofInput):
  { status: 'verified'; handle: string; contentDigest: string } | { status: 'unverified'; reason: string } {
  const proof = proveRevision(input, 'current', new Set(), new Map());
  return proof.status === 'verified'
    ? { status: 'verified', handle: proof.handle, contentDigest: proof.contentDigest } : proof;
}

function proveRevision(input: RevisionProofInput, mode: 'current' | 'historical', visiting: Set<string>, verifiedProofs: Map<string, RevisionProof>): RevisionProof {
  const refuse = (reason: string) => ({ status: 'unverified' as const, reason });
  const key = `${mode}:${input.logicalToolCallId}`;
  const cached = verifiedProofs.get(key);
  if (cached) return cached;
  const accept = (proof: RevisionProof): RevisionProof => { verifiedProofs.set(key, proof); return proof; };
  if (visiting.has(key)) return refuse('native revision lineage is cyclic');
  visiting.add(key);
  try {
    const db = openEventLog();
    const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
    if (loaded.status !== 'ok' || loaded.contract.contractId !== input.contractId
      || loaded.contract.acceptedTaskId !== input.acceptedTaskId) return refuse('native revision contract is not exact');
    const operation = loaded.contract.operations.find(row => row.id === input.requirementId);
    if (operation?.effect !== 'local_write') return refuse('native revision requirement is not a local write');
    const sealed = loadSealedNodeBinding(input.sessionId, input.sourceUserSeq, input.requirementId);
    if (!sealed || sealed.effect !== 'local_write') return refuse('native revision selection is not sealed');
    const work = db.prepare(`SELECT b.tool_name, b.argument_digest, b.bound_at, s.settled_at FROM expected_work_call_bindings b
      JOIN logical_call_settlements s USING(session_id,source_user_seq,logical_tool_call_id)
      WHERE b.session_id=? AND b.source_user_seq=? AND b.logical_tool_call_id=?
        AND b.accepted_task_id=? AND b.contract_id=? AND b.requirement_id=?
        AND b.effect_kind='local_write' AND s.outcome_kind='succeeded'
        AND s.mutating=1 AND s.continues_requirement=0`).get(input.sessionId,input.sourceUserSeq,
          input.logicalToolCallId,input.acceptedTaskId,input.contractId,input.requirementId) as {tool_name:string;argument_digest:string;bound_at:string;settled_at:string} | undefined;
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
    const outputKind = declarations[0]!.localPlanning!.outputKind;
    const verified = { status: 'verified' as const, handle: facts.handle, contentDigest: facts.contentDigest,
      createdId: facts.createdId, boundAt: work.bound_at, settledAt: work.settled_at, outputKind };
    const sourceCalls = (requirementId: string) => db.prepare(`SELECT logical_tool_call_id FROM expected_work_call_bindings
      WHERE session_id=? AND source_user_seq=? AND accepted_task_id=? AND contract_id=? AND requirement_id=?`)
      .all(input.sessionId, input.sourceUserSeq, input.acceptedTaskId, input.contractId, requirementId) as Array<{ logical_tool_call_id: string }>;
    // A commit proves the authored bytes landed, not that they descend from a
    // promised source. Retain the existing stronger proof whenever the graph
    // declares content lineage, including all canonical source result checks.
    const artifactIdentityLineage = operation.dataFrom.length > 0 && operation.dataFrom.every(id => {
      const source = loaded.contract.operations.find(row => row.id === id);
      if (source?.effect !== 'local_write' || !operation.dependsOn.includes(id)) return false;
      const calls = sourceCalls(id);
      if (calls.length !== 1) return false;
      const prior = proveRevision({ ...input, requirementId: id, logicalToolCallId: calls[0]!.logical_tool_call_id }, 'historical', visiting, verifiedProofs);
      return prior.status === 'verified' && prior.handle === facts.handle && prior.createdId === facts.createdId
        && prior.outputKind === outputKind && prior.settledAt <= work.bound_at;
    });
    if (operation.dataFrom.length > 0 && !artifactIdentityLineage) {
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
    // Historical proof is private and only usable by a same-artifact successor.
    // It validates the exact retained settlement, never claims current bytes.
    if (mode === 'historical') return accept(verified);
    const content = readCommittedArtifactContent(facts);
    if (content.verified && content.parts.length > 0) return accept(verified);
    // A later selected revision may supersede these bytes, but only along an
    // explicit data edge in this exact contract, with current bytes verified
    // at the end of the chain. An ambient edit or mere order edge cannot count.
    const ancestors = (id: string, edge: 'dataFrom' | 'dependsOn', seen = new Set<string>()): Set<string> => {
      if (seen.has(id)) return seen;
      seen.add(id);
      const node = loaded.contract.operations.find(row => row.id === id);
      for (const parent of node?.[edge] ?? []) ancestors(parent, edge, seen);
      return seen;
    };
    const artifactAncestors = ancestors(operation.id, 'dataFrom');
    for (const successor of loaded.contract.operations) {
      if (successor.id === operation.id || successor.effect !== 'local_write' || successor.dataFrom.length === 0
        || !ancestors(successor.id, 'dependsOn').has(operation.id)
        || ![...ancestors(successor.id, 'dataFrom')].some(id => artifactAncestors.has(id))) continue;
      const calls = sourceCalls(successor.id);
      if (calls.length !== 1) continue;
      const next = proveRevision({ ...input, requirementId: successor.id, logicalToolCallId: calls[0]!.logical_tool_call_id }, 'current', visiting, verifiedProofs);
      if (next.status === 'verified' && next.handle === facts.handle && next.createdId === facts.createdId
        && next.outputKind === outputKind && work.settled_at <= next.boundAt) return accept(verified);
    }
    return refuse(content.unresolvedReason ?? 'native revision current bytes are unverified');
  } catch { return refuse('native revision proof storage is unavailable'); }
  finally { visiting.delete(key); }
}
