/** Model-authored intermediate results for an approved plan. These are durable
 * work products, not independent verification and never business authority. */
import { createHash } from 'node:crypto';
import { acceptedPlanExecution } from './accepted-plan-execution.js';
import { openEventLog } from './eventlog.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { closedCanonicalJson, SEALED_CALL_CANONICAL_LIMITS } from '../../shared/closed-canonical-json.js';
import { resolveWorkTopologyJsonPointer } from '../graph/work-topology.js';
import { sourceRecordsFor } from './expected-work-universe-seal.js';
import { reviewedCollectionMembers, type PlanCollection } from './reviewed-plan-collection.js';
import { isRegisteredActionControl } from '../../tools/tool-registry.js';
import { canReviseReviewedFileStep, supersededReviewedFileCalls, staleReviewedReadCalls } from './reviewed-file-correction.js';

type Identity = { sessionId: string; sourceUserSeq: number };
const object = (v: unknown): v is Record<string, any> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const canonical = (v: unknown) => closedCanonicalJson(v, SEALED_CALL_CANONICAL_LIMITS);
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
function store() {
  const db = openEventLog();
  db.exec(`CREATE TABLE IF NOT EXISTS reviewed_plan_step_results_v1 (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL, source_user_seq INTEGER NOT NULL REFERENCES events(seq),
    plan_digest TEXT NOT NULL, step_id TEXT NOT NULL, result_digest TEXT NOT NULL,
    result_json TEXT NOT NULL, inputs_json TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS reviewed_plan_step_results_scope_v1
    ON reviewed_plan_step_results_v1(session_id, source_user_seq, plan_digest, step_id)`);
  return db;
}
function outline(identity: Identity) {
  const execution = acceptedPlanExecution(identity.sessionId, identity.sourceUserSeq);
  if (!execution || !Array.isArray(execution.artifact.structuredPlan?.steps)) throw new Error('A selected ready plan is required.');
  return { execution, steps: execution.artifact.structuredPlan.steps.filter(object) };
}
function toolResults(identity: Identity, stepId: string) {
  const loaded = loadExpectedWorkContract(identity.sessionId, identity.sourceUserSeq);
  if (loaded.status !== 'ok') throw new Error('Activate the reviewed execution draft before recording research results.');
  const rows = openEventLog().prepare('SELECT logical_tool_call_id, universe_item_id FROM expected_work_call_bindings WHERE session_id = ? AND source_user_seq = ? AND requirement_id = ? AND contract_id = ?')
    .all(identity.sessionId, identity.sourceUserSeq, stepId, loaded.contract.contractId) as Array<{ logical_tool_call_id: string; universe_item_id: string | null }>;
  const superseded = supersededReviewedFileCalls(identity, stepId);
  for (const call of staleReviewedReadCalls(identity, stepId)) superseded.add(call);
  const results = rows.filter(row => !superseded.has(row.logical_tool_call_id)).flatMap(row => {
    const result = redeemSuccessfulSettlementResultForHost({ ...identity, acceptedTaskId: loaded.contract.acceptedTaskId, logicalToolCallId: row.logical_tool_call_id });
    return result.status === 'ok' ? [{ memberId: row.universe_item_id, evidence: result.value }] : [];
  });
  return results;
}
function toolResult(identity: Identity, stepId: string): unknown {
  const results = toolResults(identity, stepId);
  if (results.length !== 1) throw new Error(`Reviewed producer ${stepId} requires one exact settled result.`);
  return results[0]!.evidence.rawPayload;
}

export function resolveReviewedPlanCollectionRecords(identity: Identity, collection: PlanCollection): unknown[] {
  if (collection.items) return collection.items;
  if (!collection.producerStepId) throw new Error('Reviewed collection has no source.');
  const producer = outline(identity).steps.find(step => step.id === collection.producerStepId);
  if (producer?.forEach) {
    const aggregate = resolveReviewedPlanStepResult(identity, producer.id) as { items: unknown[] };
    return aggregate.items;
  }
  const results = toolResults(identity, collection.producerStepId);
  if (results.length !== 1) throw new Error('Collection requires one complete settled producer.');
  const evidence = results[0]!.evidence;
  const records = sourceRecordsFor(evidence);
  if (!records.ok) throw new Error('Collection producer did not retain a readable record set.');
  return records.records;
}

export function resolveReviewedPlanStepResult(identity: Identity, stepId: string, chain = new Set<string>()): unknown {
  const { execution, steps } = outline(identity);
  const step = steps.find(s => s.id === stepId);
  if (!step || chain.has(stepId)) throw new Error(`Reviewed producer ${stepId} is missing or cyclic.`);
  if (step.capabilityRef) {
    if (!step.forEach) return toolResult(identity, stepId);
    const members = reviewedCollectionMembers(step.forEach, resolveReviewedPlanCollectionRecords(identity, step.forEach));
    const results = toolResults(identity, stepId);
    const gaps = members.filter(member => results.filter(result => result.memberId === member.id).length !== 1);
    if (gaps.length || results.length !== members.length) {
      const observed = openEventLog().prepare(`SELECT b.universe_item_id AS memberId,
          s.outcome_kind AS outcome, s.outcome_detail AS detail
        FROM expected_work_call_bindings b LEFT JOIN logical_call_settlements s
          USING (session_id, source_user_seq, logical_tool_call_id)
        WHERE b.session_id = ? AND b.source_user_seq = ? AND b.requirement_id = ?
        ORDER BY s.rowid DESC`).all(identity.sessionId, identity.sourceUserSeq, stepId) as
        Array<{ memberId: string | null; outcome: string | null; detail: string | null }>;
      const missing = gaps.map(member => {
        const count = results.filter(result => result.memberId === member.id).length;
        const latest = observed.find(row => row.memberId === member.id);
        return { memberId: member.id, usableResults: count,
          outcome: latest?.outcome ?? 'not_settled', detail: latest?.detail ?? null };
      });
      throw new Error(`Reviewed collection ${stepId} is not complete. Member evidence: ${JSON.stringify(missing)}. Resolve these upstream results before resubmitting synthesis; changing synthesis content cannot repair a missing input. Preserve completed members and reconcile any uncertain write before repeating it.`);
    }
    return { items: members.map(member => {
      const matches = results.filter(result => result.memberId === member.id);
      if (matches.length !== 1) throw new Error(`Reviewed member ${member.id} needs one settled result.`);
      return { memberId: member.id, result: matches[0]!.evidence.rawPayload };
    }) };
  }
  if (step.effect !== 'compute') throw new Error(`Reviewed producer ${stepId} is not result-producing.`);
  const row = store().prepare(`SELECT result_json, result_digest, inputs_json FROM reviewed_plan_step_results_v1
    WHERE session_id = ? AND source_user_seq = ? AND plan_digest = ? AND step_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(identity.sessionId, identity.sourceUserSeq, execution.artifact.digest, stepId) as { result_json: string; result_digest: string; inputs_json: string } | undefined;
  if (!row) throw new Error(`Record the synthesized result for ${stepId} with plan_step_result before using it.`);
  const value: unknown = JSON.parse(row.result_json);
  const inputs = stampedInputs(identity, step, new Set([...chain, stepId]), supplementalCallIds(row.inputs_json));
  if (digest(value) !== row.result_digest || canonical(inputs) !== row.inputs_json) throw new Error(`Reviewed producer ${stepId} changed or lost its source evidence.`);
  return value;
}
function resultInputs(identity: Identity, step: Record<string, any>, chain: Set<string>) {
  const { steps } = outline(identity);
  const inputs: Record<string, string> = {};
  for (const id of step.dependsOn as string[]) {
    const dependency = steps.find(s => s.id === id);
    if (dependency?.effect === 'none' && !dependency.capabilityRef) {
      if (chain.has(id)) throw new Error('Reviewed dependencies are cyclic.');
      Object.assign(inputs, resultInputs(identity, dependency, new Set([...chain, id])));
    } else inputs[id] = digest(resolveReviewedPlanStepResult(identity, id, chain));
  }
  return inputs;
}

// Older records contain only dependency digests. New records also retain the
// unbound observations available when the model formed this synthesis. These
// are provenance, not a claim that the model used every observation or that a
// supplemental read satisfied one of the approved graph's requirements.
function supplementalCallIds(inputsJson: string): string[] | undefined {
  const stored: unknown = JSON.parse(inputsJson);
  if (!object(stored) || stored.version !== 2) return undefined;
  if (!Array.isArray(stored.supplementalReads) || !stored.supplementalReads.every(
    row => object(row) && typeof row.callId === 'string' && typeof row.digest === 'string',
  )) throw new Error('The retained synthesis read evidence is malformed.');
  return stored.supplementalReads.map(row => row.callId);
}
function supplementalReads(identity: Identity) {
  const loaded = loadExpectedWorkContract(identity.sessionId, identity.sourceUserSeq);
  if (loaded.status !== 'ok') throw new Error('Activate the reviewed execution draft before recording research results.');
  const rows = openEventLog().prepare(`SELECT s.logical_tool_call_id AS callId, l.tool_name AS toolName FROM logical_call_settlements s
    JOIN logical_tool_calls l USING (session_id, source_user_seq, logical_tool_call_id)
    WHERE s.session_id = ? AND s.source_user_seq = ? AND s.mutating = 0
      AND s.outcome_kind IN ('succeeded', 'empty_result') AND l.tool_name != 'tool_search'
      AND NOT EXISTS (SELECT 1 FROM expected_work_call_bindings b WHERE b.session_id = s.session_id
        AND b.source_user_seq = s.source_user_seq AND b.logical_tool_call_id = s.logical_tool_call_id)
    ORDER BY s.rowid`).all(identity.sessionId, identity.sourceUserSeq) as Array<{ callId: string; toolName: string }>;
  return rows.filter(row => !isRegisteredActionControl(row.toolName) && redeemSuccessfulSettlementResultForHost({ ...identity,
    acceptedTaskId: loaded.contract.acceptedTaskId, logicalToolCallId: row.callId }).status === 'ok').map(row => row.callId);
}
function stampedInputs(identity: Identity, step: Record<string, any>, chain: Set<string>, readIds?: string[], dependencies = resultInputs(identity, step, chain)) {
  if (readIds === undefined) return dependencies;
  const loaded = loadExpectedWorkContract(identity.sessionId, identity.sourceUserSeq);
  if (loaded.status !== 'ok') throw new Error('The reviewed work contract is unavailable.');
  return { version: 2, dependencies, supplementalReads: readIds.map(callId => {
    const evidence = redeemSuccessfulSettlementResultForHost({ ...identity,
      acceptedTaskId: loaded.contract.acceptedTaskId, logicalToolCallId: callId });
    if (evidence.status !== 'ok') throw new Error(`Retained supplemental observation ${callId} is unavailable.`);
    return { callId, digest: evidence.value.rawPayloadSha256 };
  }) };
}

export function recordReviewedPlanStepResult(identity: Identity, stepId: string, value: unknown) {
  const { execution, steps } = outline(identity);
  const step = steps.find(s => s.id === stepId);
  if (!step || step.capabilityRef || step.effect !== 'compute') throw new Error('Only a reviewed compute step can record model-authored content.');
  // A whole-result binding may consume text, a list or a scalar. Validate the
  // JSON domain here, then enforce the actual reviewed paths and types below.
  const resultJson = canonical(value), resultDigest = digest(value);
  const dependencies = resultInputs(identity, step, new Set([stepId]));
  // Each consuming binding states exactly which field and type will be used.
  for (const consumer of steps) for (const binding of consumer.dynamicBindings ?? []) {
    if (binding.producerStepId !== stepId) continue;
    const result = resolveWorkTopologyJsonPointer(value, binding.outputPath);
    const type = result.ok ? Array.isArray(result.value) ? 'array' : result.value === null ? 'null' : typeof result.value : 'missing';
    if (type === 'missing' || (binding.expectedType && binding.expectedType !== 'json' && type !== binding.expectedType)) throw new Error(`Result ${stepId}${binding.outputPath} must be ${binding.expectedType ?? 'JSON'}.`);
  }
  const db = store();
  return db.transaction(() => {
    const prior = db.prepare(`SELECT result_digest, inputs_json FROM reviewed_plan_step_results_v1
      WHERE session_id = ? AND source_user_seq = ? AND plan_digest = ? AND step_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(identity.sessionId, identity.sourceUserSeq, execution.artifact.digest, stepId) as { result_digest: string; inputs_json: string } | undefined;
    // Replaying the same synthesis retains its original observation snapshot;
    // a later readback must not retroactively change an already written result.
    const readIds = prior?.result_digest === resultDigest ? supplementalCallIds(prior.inputs_json) : supplementalReads(identity);
    const inputs = stampedInputs(identity, step, new Set([stepId]), readIds, dependencies);
    const replayed = prior?.result_digest === resultDigest && prior.inputs_json === canonical(inputs);
    if (prior && !replayed) {
      // Never rewrite the provenance of an effect that has already happened.
      // A correction can be composed before the write, but not retroactively.
      const consumers = new Set([stepId]);
      for (let changed = true; changed;) {
        changed = false;
        for (const candidate of steps) if (!consumers.has(candidate.id)
          && candidate.dependsOn.some((id: string) => consumers.has(id))) {
          consumers.add(candidate.id); changed = true;
        }
      }
      const writes = db.prepare(`SELECT b.requirement_id FROM logical_call_settlements s
        JOIN expected_work_call_bindings b ON b.session_id = s.session_id
          AND b.source_user_seq = s.source_user_seq AND b.logical_tool_call_id = s.logical_tool_call_id
        WHERE s.session_id = ? AND s.source_user_seq = ? AND s.mutating = 1 AND s.outcome_kind = 'succeeded'`)
        .all(identity.sessionId, identity.sourceUserSeq) as Array<{ requirement_id: string }>;
      if (writes.some(write => consumers.has(write.requirement_id)
        && !canReviseReviewedFileStep(identity, write.requirement_id, stepId))) throw new Error('The prior synthesis has already accompanied a successful write that cannot be safely revised as this request\'s own local file. Keep its evidence and revise the remaining work explicitly.');
    }
    if (!replayed) db.prepare(`INSERT INTO reviewed_plan_step_results_v1
      (session_id, source_user_seq, plan_digest, step_id, result_digest, result_json, inputs_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(identity.sessionId, identity.sourceUserSeq, execution.artifact.digest, stepId, resultDigest, resultJson, canonical(inputs));
    return { ok: true, stepId, resultDigest, authorship: 'model', replayed };
  })();
}
