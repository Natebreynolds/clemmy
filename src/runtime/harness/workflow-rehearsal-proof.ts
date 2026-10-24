/** One exact completed rehearsal satisfies its test requirement only. It does
 * not prove workflow dispatch, business effects, activation or goal review. */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { WORKFLOWS_DIR } from '../../memory/vault.js';
import { readWorkflowDefinitionFile } from '../../memory/workflow-store.js';
import { readExactAcknowledgedCreationTest } from '../../execution/inline-creation-test-delivery.js';
import { parseWorkflowRunInputsJson, workflowSmokeInputs } from '../../execution/workflow-inputs.js';
import { resolveWorkflowRunDefinitionSnapshot, withBindingsRoutedDuringRun, workflowCodeRevisionMatchesSnapshot,
  workflowRehearsalKey } from '../../execution/workflow-run-definition.js';
import { loadHostCallCapabilityBinding } from './host-call-capability-binding.js';
import { durableLogicalCallRecoveryMaterial } from './logical-call-contract.js';
import type { NativeRevisionProofPorts, RevisionProofInput } from './native-revision-proof-core.js';

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export function proveWorkflowRehearsalWithPorts(input: RevisionProofInput, ports: NativeRevisionProofPorts):
  { status: 'verified'; runId: string; definitionKey: string } | { status: 'unverified'; reason: string } {
  const refuse = (reason: string) => ({ status: 'unverified' as const, reason });
  try {
    const contract = ports.loadContract(input), selected = ports.loadSelection(input);
    if (!contract || contract.contractId !== input.contractId || contract.acceptedTaskId !== input.acceptedTaskId
      || contract.identity.sessionId !== input.sessionId || contract.identity.sourceUserSeq !== input.sourceUserSeq
      || contract.operations.find(row => row.id === input.requirementId)?.effect !== 'local_write'
      || selected?.logicalToolName !== 'workflow_test' || selected.effect !== 'local_write') {
      return refuse('rehearsal has no exact selected test requirement');
    }
    const row = ports.db.prepare(`SELECT b.tool_name,b.argument_digest,s.settled_at FROM expected_work_call_bindings b
      JOIN logical_call_settlements s USING(session_id,source_user_seq,logical_tool_call_id)
      WHERE b.session_id=? AND b.source_user_seq=? AND b.accepted_task_id=? AND b.contract_id=?
        AND b.requirement_id=? AND b.logical_tool_call_id=? AND b.effect_kind='local_write'
        AND s.execution_kind='local_execution' AND s.outcome_kind='succeeded' AND s.mutating=1
        AND s.continues_requirement=0 AND s.requires_reconciliation=0`)
      .get(input.sessionId,input.sourceUserSeq,input.acceptedTaskId,input.contractId,input.requirementId,input.logicalToolCallId) as
      {tool_name:string;argument_digest:string;settled_at:string} | undefined;
    const host = loadHostCallCapabilityBinding({db:ports.db,...input});
    if (!row || row.tool_name !== 'workflow_test' || host.status !== 'ok'
      || host.binding.acceptedTaskId !== input.acceptedTaskId || host.binding.bindingKind !== 'local_envelope'
      || host.binding.effect !== 'local_write' || host.binding.toolName !== row.tool_name
      || host.binding.effectiveArgumentDigest !== row.argument_digest) return refuse('rehearsal host settlement is not exact');
    const redeemed = ports.redeem(input);
    if (redeemed.status !== 'ok' || redeemed.value.executionSite !== 'host'
      || redeemed.value.toolName !== row.tool_name || redeemed.value.outcomeKind !== 'succeeded') {
      return refuse('rehearsal result lacks successful host provenance');
    }
    const delivered = readExactAcknowledgedCreationTest({...input,result:redeemed.value.rawPayload});
    if (!delivered) return refuse('rehearsal delivery is not bound to this exact call');
    const material = durableLogicalCallRecoveryMaterial(input.acceptedTaskId,delivered.callTool,delivered.callArguments);
    if (!material || material.toolName !== row.tool_name || material.argumentDigest !== row.argument_digest) {
      return refuse('rehearsal returned arguments differ from the host binding');
    }
    const run = delivered.run, rehearsal = run.rehearsal, report = run.reportBack;
    if (run.status !== 'creation_test' || run.source !== 'workflow_test' || run.activateAfterCreationTest !== false
      || typeof run.id !== 'string'
      || typeof run.finishedAt !== 'string' || !Number.isFinite(Date.parse(run.finishedAt))
      || run.terminalOutcome !== 'succeeded' || !object(rehearsal) || rehearsal.passed !== true
      || !object(report) || report.version !== 1 || report.outcome !== 'done'
      || typeof report.detail !== 'string' || !report.detail.trim()) return refuse('rehearsal did not finish with an exact passing report');
    const createdAt = typeof run.createdAt === 'string' ? Date.parse(run.createdAt) : NaN;
    const intentCreatedAt = Date.parse(delivered.intentCreatedAt);
    const finishedAt = Date.parse(run.finishedAt), settledAt = Date.parse(row.settled_at);
    if (!Number.isFinite(createdAt) || !Number.isFinite(settledAt)
      || !Number.isFinite(intentCreatedAt) || Date.parse(delivered.calledAt) > createdAt
      || createdAt > intentCreatedAt || intentCreatedAt > finishedAt
      || finishedAt > settledAt || finishedAt > Date.parse(delivered.returnedAt)) {
      return refuse('rehearsal lifecycle chronology is invalid');
    }
    const resolution = resolveWorkflowRunDefinitionSnapshot(run.workflowDefinitionSnapshot);
    if (resolution.status !== 'valid' || resolution.snapshot.version !== 1
      || !resolution.snapshot.codeRevision || !resolution.snapshot.admissionHash) return refuse('rehearsal definition admission is unavailable');
    const snapshot = resolution.snapshot, slug = snapshot.workflowSlug;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(slug) || run.workflow !== slug
      || snapshot.admittedAt !== run.createdAt
      || report.workflowName !== snapshot.definition.name
      || (material.args.name !== slug && material.args.name !== snapshot.definition.name)) {
      return refuse('rehearsal workflow identity disagrees');
    }
    const rawInputs = material.args.test_inputs;
    if (rawInputs !== undefined && rawInputs !== null && typeof rawInputs !== 'string') {
      return refuse('rehearsal inputs are not the exact selected test inputs');
    }
    const expectedInputs = workflowSmokeInputs(snapshot.definition, parseWorkflowRunInputsJson(rawInputs));
    if (!isDeepStrictEqual(run.inputs, expectedInputs)) {
      return refuse('rehearsal inputs differ from the selected test and definition defaults');
    }
    // Pure exact-path reads: unlike catalog discovery these never create a
    // directory or scan unrelated workflows. Retain both supported layouts.
    const skillPath = path.join(WORKFLOWS_DIR,slug,'SKILL.md');
    const current = readWorkflowDefinitionFile(existsSync(skillPath) ? skillPath : path.join(WORKFLOWS_DIR,`${slug}.md`));
    const definitionKey = workflowRehearsalKey(current
      ? withBindingsRoutedDuringRun(snapshot.definition, current, snapshot.admittedAt, run.finishedAt)
      : snapshot.definition);
    if (rehearsal.definitionKey !== definitionKey) return refuse('rehearsal verdict belongs to another definition');
    if (!current || workflowRehearsalKey(current) !== definitionKey || !workflowCodeRevisionMatchesSnapshot(snapshot,current)) {
      return refuse('current workflow execution surface differs from the passed rehearsal');
    }
    return {status:'verified',runId:run.id,definitionKey};
  } catch { return refuse('rehearsal proof is unavailable or malformed'); }
}
