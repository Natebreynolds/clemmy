/** Re-prove a reviewed collection's source-to-argument mapping. This evidence
 * reader only uses the caller's transaction and redeemed results; importing it
 * never initializes the runtime, discovery tools, or another database. */
import { createHash } from 'node:crypto';
import { proveHostLocalWorkspaceDerivation } from './host-local-workspace-derivation.js';
import { loadHostCallCapabilityBinding } from './host-call-capability-binding.js';
import { resolveReviewedStepArguments } from './reviewed-plan-bindings.js';
import { bindReviewedCollectionItem, reviewedCollectionMembers } from './reviewed-plan-collection.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { parseHostLocalWriteCommitFacts } from './host-local-write-commit.js';
import { closedCanonicalJson, SEALED_CALL_CANONICAL_LIMITS } from '../../shared/closed-canonical-json.js';
import { deriveResultHandleFactsFromRaw, recordsAtRecordPath } from './result-facts.js';
import { inspectProviderEnvelope } from './provider-read-evidence.js';

type Input = Parameters<typeof proveHostLocalWorkspaceDerivation>[0];
type Proof = { status: 'verified'; bundleDigest: string } | { status: 'unavailable'; reason: string };
const canonical = (value: unknown) => closedCanonicalJson(value, SEALED_CALL_CANONICAL_LIMITS);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const planDigest = (kind: string, value: unknown) => createHash('sha256').update(`clementine:${kind}:v1\0`).update(canonical(value)).digest('hex');

export function proveHostLocalWriteDerivation(input: Input): Proof {
  try {
    const source = input.db.prepare("SELECT id,data_json FROM events WHERE session_id=? AND seq=? AND type='user_input_received'")
      .get(input.sessionId, input.sourceUserSeq) as { id: string; data_json: string } | undefined;
    const mode = source ? JSON.parse(source.data_json).taskMode : null;
    if (mode?.kind !== 'execute') return proveHostLocalWorkspaceDerivation(input);
    const ref = mode.executeRef;
    const row = input.db.prepare('SELECT artifact_json,digest FROM reviewed_plan_revisions_v1 WHERE plan_id=? AND revision=?')
      .get(ref?.planId, ref?.revision) as { artifact_json: string; digest: string } | undefined;
    if (!row) throw new Error('Reviewed plan is missing.');
    const artifact = JSON.parse(row.artifact_json);
    const { digest: storedDigest, ...artifactBody } = artifact;
    if (storedDigest !== ref.digest || row.digest !== ref.digest || artifact.planId !== ref.planId
      || artifact.revision !== ref.revision || planDigest('reviewed-plan-artifact', artifactBody) !== storedDigest
      || artifact.readiness !== 'ready' || artifact.missingPrerequisites.length) throw new Error('Reviewed plan bytes changed.');
    const claimRow = input.db.prepare('SELECT claim_json FROM reviewed_plan_execution_claims_v1 WHERE session_id=? AND source_user_seq=?')
      .get(input.sessionId, input.sourceUserSeq) as { claim_json: string } | undefined;
    const claim = claimRow && JSON.parse(claimRow.claim_json);
    const { digest: claimDigest, ...claimBody } = claim ?? {};
    if (!claim || planDigest('reviewed-plan-execution', claimBody) !== claimDigest || canonical(claim.ref) !== canonical(ref)
      || claim.sourceEventId !== source!.id || claim.sourceUserSeq !== input.sourceUserSeq || claim.sessionId !== input.sessionId
      || claim.principalId !== artifact.principalId || claim.acceptedTaskId !== input.acceptedTaskId) throw new Error('Reviewed execution identity changed.');
    const bound = input.db.prepare('SELECT * FROM expected_work_call_bindings WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?')
      .get(input.sessionId, input.sourceUserSeq, input.writeLogicalToolCallId) as Record<string, any> | undefined;
    const outline = artifact.structuredPlan;
    const step = outline.steps.find((value: any) => value.id === bound?.requirement_id);
    if (!step?.forEach?.producerStepId) return proveHostLocalWorkspaceDerivation(input);
    const contractRow = input.db.prepare('SELECT contract_json FROM accepted_task_work_contracts WHERE session_id=? AND source_user_seq=?')
      .get(input.sessionId, input.sourceUserSeq) as { contract_json: string } | undefined;
    const contract = contractRow && JSON.parse(contractRow.contract_json);
    const { contractId, ...contractBody } = contract ?? {};
    if (!bound || !contract || contractId !== `expected-work:v1:${digest(contractBody)}`
      || contractId !== bound.contract_id || contract.acceptedTaskId !== input.acceptedTaskId || bound.accepted_task_id !== input.acceptedTaskId
      || bound.effect_kind !== 'local_write' || bound.cardinality_kind !== 'each') throw new Error('Reviewed member contract changed.');
    const operation = contract.operations.find((value: any) => value.id === step.id);
    const universe = contract.universes.find((value: any) => value.id === bound.universe_id);
    const planned = outline.executionDraft?.topology;
    const plannedOperation = planned?.operations?.find((value: any) => value.id === step.id);
    const plannedUniverse = planned?.universes?.find((value: any) => value.id === universe?.id);
    if (operation?.cardinality.kind !== 'each' || operation.cardinality.universeId !== universe?.id
      || !plannedOperation || canonical(plannedOperation.cardinality) !== canonical(operation.cardinality)
      || !plannedUniverse || canonical(plannedUniverse) !== canonical(universe)
      || !operation.dataFrom.includes(step.forEach.producerStepId)) throw new Error('Reviewed source lineage changed.');
    const settledRows = (stepId: string) => {
      const calls = input.db.prepare(`SELECT b.logical_tool_call_id,b.tool_name,b.universe_item_id FROM expected_work_call_bindings b
        JOIN logical_call_settlements s USING(session_id,source_user_seq,logical_tool_call_id)
        WHERE b.session_id=? AND b.source_user_seq=? AND b.contract_id=? AND b.requirement_id=?
          AND b.accepted_task_id=? AND s.outcome_kind='succeeded' AND s.continues_requirement=0`)
        .all(input.sessionId, input.sourceUserSeq, contractId, stepId, input.acceptedTaskId) as Array<{ logical_tool_call_id: string; tool_name: string; universe_item_id: string | null }>;
      return calls.map(call => {
        const result = input.resolveSuccessfulResult(call.logical_tool_call_id);
        if (!result.ok || result.toolName !== call.tool_name || inspectProviderEnvelope(result.rawPayload).verdict !== 'clean') throw new Error('Reviewed producer is unreadable or failed.');
        return { ...result, callId: call.logical_tool_call_id, memberId: call.universe_item_id };
      });
    };
    const settled = (stepId: string) => {
      const results = settledRows(stepId);
      if (results.length !== 1) throw new Error('Reviewed producer needs one exact successful result.');
      return results[0]!;
    };
    const collectionRecords = (collection: any, chain: Set<string>): unknown[] => {
      if (collection.items) return collection.items;
      const producer = outline.steps.find((value: any) => value.id === collection.producerStepId);
      if (!producer) throw new Error('Reviewed collection producer is missing.');
      if (producer.forEach) return (resolve(producer.id, chain) as { items: unknown[] }).items;
      if (producer.effect !== 'read') throw new Error('A new member collection requires a read.');
      const result = settled(producer.id);
      const parsed = result.executionSite === 'host' && typeof result.rawPayload === 'string' ? JSON.parse(result.rawPayload) : result.rawPayload;
      const facts = deriveResultHandleFactsFromRaw(parsed);
      const records = recordsAtRecordPath(parsed, facts.recordPath);
      if (!records || records.length !== facts.recordCount || !facts.success || facts.completeness === 'partial' || facts.cursor
        || inspectProviderEnvelope(parsed).verdict !== 'clean') throw new Error('Reviewed collection source is incomplete or changed.');
      return records;
    };
    const resolve = (id: string, chain = new Set<string>()): unknown => {
      if (chain.has(id)) throw new Error('Reviewed result dependency is cyclic.');
      const next = new Set([...chain, id]);
      const candidate = outline.steps.find((value: any) => value.id === id);
      if (candidate?.capabilityRef) {
        if (!candidate.forEach) return settled(id).rawPayload;
        const members = reviewedCollectionMembers(candidate.forEach, collectionRecords(candidate.forEach, next));
        const results = settledRows(id);
        if (results.length !== members.length) throw new Error('Reviewed repeated producer is incomplete.');
        return { items: members.map(member => {
          const matches = results.filter(result => result.memberId === member.id);
          if (matches.length !== 1) throw new Error('Reviewed producer member is missing or duplicated.');
          return { memberId: member.id, result: matches[0]!.rawPayload };
        }) };
      }
      if (candidate?.effect !== 'compute') throw new Error('Reviewed result producer is missing.');
      const saved = input.db.prepare(`SELECT result_json,result_digest,inputs_json FROM reviewed_plan_step_results_v1
        WHERE session_id=? AND source_user_seq=? AND plan_digest=? AND step_id=? ORDER BY rowid DESC LIMIT 1`)
        .get(input.sessionId, input.sourceUserSeq, artifact.digest, id) as { result_json: string; result_digest: string; inputs_json: string } | undefined;
      if (!saved) throw new Error('Reviewed synthesis is missing.');
      const value = JSON.parse(saved.result_json);
      const inputs = Object.fromEntries(candidate.dependsOn.map((dependency: string) => [dependency, digest(resolve(dependency, next))]));
      if (digest(value) !== saved.result_digest || canonical(inputs) !== saved.inputs_json) throw new Error('Reviewed synthesis evidence changed.');
      return value;
    };
    if (universe.seal === 'complete_source_receipt') {
      if (bound.input_source_ref !== settled(universe.producedBy).callId) throw new Error('Reviewed collection source binding changed.');
    } else if (universe.seal !== 'accepted_input' || bound.input_source_ref !== source!.id) throw new Error('Reviewed member universe lost its accepted source.');
    const member = reviewedCollectionMembers(step.forEach, collectionRecords(step.forEach, new Set([step.id]))).find(value => value.id === bound.universe_item_id);
    if (!member || bound.universe_member_count !== 1 || bound.universe_member_digest !== digest([member.id])) throw new Error('Reviewed source member changed.');
    const args = bindReviewedCollectionItem(resolveReviewedStepArguments(step, resolve), step.forEach, member.record);
    const host = loadHostCallCapabilityBinding({ ...input, logicalToolCallId: input.writeLogicalToolCallId });
    const prepared = outline.preparedBindings.find((value: any) => value.stepId === step.id);
    if (host.status !== 'ok' || prepared?.identity.kind !== 'local_registry' || host.binding.effect !== 'local_write'
      || host.binding.acceptedTaskId !== input.acceptedTaskId || (host.binding.rootGraphHash !== undefined && host.binding.rootGraphHash !== contract.graphHash)
      || prepared.identity.definition.name !== host.binding.toolName) throw new Error('Reviewed local tool binding changed.');
    const exact = durableLogicalCallContract(input.acceptedTaskId, host.binding.toolName, args);
    // Registered local schemas may supply defaults after the reviewed call.
    // The host binding authenticates that monotonic raw → effective refinement.
    if (!exact || (exact.argumentDigest !== host.binding.effectiveArgumentDigest
      && exact.argumentDigest !== host.binding.logicalRawArgumentDigest)) throw new Error('Written arguments differ from the reviewed current member.');
    const write = input.resolveSuccessfulResult(input.writeLogicalToolCallId);
    if (!write.ok || write.executionSite !== 'host' || write.toolName !== host.binding.toolName) throw new Error('Reviewed member has no successful local write.');
    const commit = parseHostLocalWriteCommitFacts(write.rawPayload);
    if (!commit) throw new Error('Reviewed member has no local commit receipt.');
    return { status: 'verified', bundleDigest: commit.contentDigest };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : 'Reviewed member derivation is unavailable.' };
  }
}
