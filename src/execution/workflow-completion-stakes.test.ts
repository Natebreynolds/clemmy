import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentInputItem } from '@openai/agents';
import type { HostAdmissibleEffect } from '../runtime/harness/accepted-turn-call-authority.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-review-stakes-'));
process.env.CLEMENTINE_HOME = home;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(home, 'state'), { recursive: true });
const events = await import('../runtime/harness/eventlog.js');
const dispatch = await import('../runtime/harness/dispatch-ledger.js');
const settlements = await import('../runtime/harness/logical-call-settlement-store.js');
const outcomes = await import('../runtime/harness/attempt-outcome.js');
const identity = await import('../runtime/harness/attempt-identity.js');
const authority = await import('../runtime/harness/accepted-turn-call-authority.js');
const contracts = await import('../runtime/harness/logical-call-contract.js');
const hostBindings = await import('../runtime/harness/host-call-capability-binding.js');
const { admitAcceptedModelBatch } = await import('../runtime/harness/accepted-model-batch-checkpoint.js');
const { settleAdmittedLogicalCallPreDispatchDisposition } = await import('../runtime/harness/attempt-settlement.js');
const { withHostLocalWriteCommitFromFile } = await import('../runtime/harness/host-local-write-commit.js');
const { readWorkflowTargetEvidence } = await import('./workflow-target-evidence.js');
const { readWorkflowCompletionStakes, workflowEvidenceCallKey } = await import('./workflow-completion-stakes.js');
const { workflowDefinitionHash } = await import('./workflow-run-definition.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { judgeWorkflowTarget } = await import('./workflow-objective-judge.js');
const { _setCompletionJudgeForTests } = await import('../runtime/harness/objective-judge.js');
const { _setSystemOneFetchForTests, _setTypesafeKeyForTests } = await import('../runtime/jev/client.js');
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });
afterEach(() => { _setCompletionJudgeForTests(null); _setSystemOneFetchForTests(undefined); _setTypesafeKeyForTests(null); });

let serial = 0;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(options: { prefix?: boolean; wrongRun?: boolean } = {}) {
  const runId = `stakes-run-${++serial}`, stepId = 'work';
  const session = events.createSession({ id: options.prefix === false ? `parked-fixture-${serial}` : `workflow:${runId}:${stepId}`,
    kind: 'workflow', metadata: { workflowRunId: options.wrongRun ? 'another-run' : runId, stepId } });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Perform the synthetic workflow step.', workflowRunId: runId, stepId } });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1,
    acceptedTaskId: identity.acceptedTaskIdFor(session.id, source.seq) };
  assert.equal(authority.armHostCallAuthority({ sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
    catalogRevisionDigest: digest(`catalog:${serial}`), bindingRevisionDigest: digest(`binding:${serial}`),
    maxLogicalCalls: 16, maxParallelCalls: 4 }).status, 'armed');
  const def = { name: runId, enabled: true, description: 'Return the fixture result.', trigger: { manual: true },
    steps: [{ id: stepId, prompt: 'Return the fixture result.' }] };
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({ id: runId,
    workflowDefinitionSnapshot: { version: 1, workflowSlug: runId, admittedAt: new Date().toISOString(),
      definition: def, definitionHash: workflowDefinitionHash(def as never) } }));
  return { runId, task, def };
}

function attested<T>(f: ReturnType<typeof fixture>, callId: string, tool: string, args: unknown,
  effect: HostAdmissibleEffect, run: () => T): T {
  const root = authority.acceptedTurnCallAuthorityFor(f.task.sessionId, f.task.sourceUserSeq);
  assert.equal(root.status, 'ok');
  const contract = contracts.durableLogicalCallContract(f.task.acceptedTaskId, tool, args)!;
  const schema = digest(`schema:${tool}`);
  const base = { ...f.task, logicalToolCallId: callId, sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest, toolName: contract.toolName, argumentDigest: contract.argumentDigest,
    effect, bindingKind: 'local_envelope' as const, capabilityId: tool, schemaFingerprint: schema,
    accountId: '', invokePortId: `configured-wrapper:${schema}`, operationId: tool, manifestId: '', manifestDigest: '',
    engineVersion: root.authority.engineVersion, surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest, authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest, catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest! };
  return authority.withHostCallAttestation({ ...base, bindingDigest: hostBindings.hostCallAttestationBindingDigest(base) }, run);
}

function settle(f: ReturnType<typeof fixture>, input: { tool?: string; local?: boolean; mutating?: boolean;
  succeeded?: boolean; payload?: unknown; requirementId?: string; args?: unknown } = {}) {
  const tool = input.tool ?? 'FIXTURE_READ', callId = `logical:stakes-${serial}`;
  const args = input.args ?? { fixture: serial };
  const opened = attested(f, callId, tool, args, input.mutating ? input.local ? 'local_write' : 'external_write' : 'read',
    () => dispatch.beginPhysicalDispatch({ identity: { ...f.task, logicalToolCallId: callId,
    physicalDispatchId: `dispatch:stakes-${serial}`, ordinal: 0 }, tool, args,
    ...(input.local ? { executionSite: 'host' as const } : {}) }));
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  if (opened.status !== 'inserted') throw new Error('no fixture dispatch');
  dispatch.settlePhysicalDispatch({ identity: opened.identity, tool, outcome: 'returned' });
  const success = input.succeeded !== false;
  const result = settlements.commitLogicalCallSettlement({ identity: { ...f.task, logicalToolCallId: callId },
    contract: { toolName: tool, args }, execution: { kind: input.local ? 'local_execution' : 'provider_execution' },
    result: { payload: input.payload ?? { successful: success, data: { value: 323 } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: success }),
    recovery: { businessCall: true, mutating: input.mutating === true, ...(input.requirementId ? { requirementId: input.requirementId } : {}) },
    observer: { lane: input.local ? 'byo' : 'composio', turn: 1 } });
  assert.equal(result.status, 'committed');
  return workflowEvidenceCallKey(f.task.sessionId, f.task.sourceUserSeq, callId);
}

function classify(f: ReturnType<typeof fixture>, key: string, overrides: Partial<Parameters<typeof readWorkflowCompletionStakes>[0]> = {}) {
  return readWorkflowCompletionStakes({ runId: f.runId, available: true, definitionVerified: true,
    verifiedCalls: new Set([key]), recoverableCalls: new Set(), verifiedTransforms: [], ...overrides });
}

test('exact authenticated successful read gets read; external mutation retains full review', () => {
  const read = fixture(), readKey = settle(read);
  assert.equal(classify(read, readKey).reviewStakes, 'read');
  const write = fixture(), writeKey = settle(write, { mutating: true });
  assert.equal(classify(write, writeKey).reviewStakes, 'write');
});

test('a parked UUID workflow source is inventoried by host owner metadata', () => {
  const f = fixture({ prefix: false }), key = settle(f);
  assert.equal(classify(f, key).reviewStakes, 'read');
  assert.equal(classify(f, key, { verifiedCalls: new Set() }).reviewStakes, 'write');
});

test('recoverable local exemption needs succeeded exact capability and current commit proof', () => {
  const f = fixture(), key = settle(f, { tool: 'write_file', local: true, mutating: true,
    requirementId: 'cap:local:write_file:replace' });
  assert.equal(classify(f, key).reviewStakes, 'write');
  assert.equal(classify(f, key, { recoverableCalls: new Set([key]) }).reviewStakes, 'read');
  const destructive = fixture(), destructiveKey = settle(destructive, { tool: 'delete_file', local: true, mutating: true });
  assert.equal(classify(destructive, destructiveKey, { recoverableCalls: new Set([destructiveKey]) }).reviewStakes, 'write');
});

test('failed/refused, wrong-run, unavailable and missing admitted definition remain full', () => {
  const failed = fixture(), key = settle(failed, { succeeded: false, local: true, tool: 'write_file', mutating: true });
  assert.equal(classify(failed, key, { recoverableCalls: new Set([key]) }).reviewStakes, 'write');
  const wrong = fixture({ wrongRun: true }), wrongKey = settle(wrong);
  assert.equal(classify(wrong, wrongKey).reviewStakes, 'write');
  const read = fixture(), readKey = settle(read);
  assert.equal(classify(read, readKey, { available: false }).reviewStakes, 'write');
  assert.equal(classify(read, readKey, { definitionVerified: false }).reviewStakes, 'write');
  assert.equal(readWorkflowTargetEvidence('missing-exact-run').reviewStakes, 'write');
});

test('an unsettled raw logical call is not hidden by the settled result projection', () => {
  const f = fixture(), key = settle(f), before = classify(f, key);
  assert.equal(before.reviewStakes, 'read');
  const extra = attested(f, 'logical:unfinished', 'FIXTURE_READ', { other: true }, 'read',
    () => dispatch.admitLogicalCall({ identity: { ...f.task, logicalToolCallId: 'logical:unfinished' },
      tool: 'FIXTURE_READ', args: { other: true } }));
  assert.equal(extra.status, 'inserted');
  const after = classify(f, key);
  assert.equal(after.reviewStakes, 'write');
  assert.notEqual(after.reviewStakesDigest, before.reviewStakesDigest);
});

test('actual target facade verifies host commit content and carries stakes', () => {
  const f = fixture();
  const committedPath = path.join(home, 'artifacts', f.runId, 'fixture.txt');
  mkdirSync(path.dirname(committedPath), { recursive: true });
  writeFileSync(committedPath, 'exact authored fixture bytes\n');
  const payload = withHostLocalWriteCommitFromFile({ createdId: f.runId, committedPath, result: 'Wrote the fixture artifact.' });
  settle(f, { tool: 'write_file', local: true, mutating: true, payload,
    requirementId: 'cap:local:write_file:create', args: { path: committedPath, content: 'exact authored fixture bytes\n' } });
  const evidence = readWorkflowTargetEvidence(f.runId);
  assert.equal(evidence.available, true, evidence.summary);
  assert.equal(evidence.reviewStakes, 'read');
  writeFileSync(committedPath, 'tampered');
  assert.equal(readWorkflowTargetEvidence(f.runId).reviewStakes, 'write');
});

test('a positive admitted frame without corresponding logical work stays full, including refused work', () => {
  const f = fixture(), key = settle(f), before = classify(f, key);
  const callId = 'call:refused-frame', tool = 'FIXTURE_READ', args = { denied: true };
  const admission = admitAcceptedModelBatch({ ...f.task,
    preHistory: [{ role: 'user', content: 'Perform the synthetic workflow step.' } as AgentInputItem],
    frameHistory: [{ type: 'function_call', callId, name: tool, arguments: JSON.stringify(args), status: 'completed' } as AgentInputItem] });
  assert.equal(admission.status, 'admitted', JSON.stringify(admission));
  assert.equal(classify(f, key).reviewStakes, 'write');
  assert.notEqual(classify(f, key).reviewStakesDigest, before.reviewStakesDigest);
  const opened = attested(f, callId, tool, args, 'read', () => dispatch.admitLogicalCall({
    identity: { ...f.task, logicalToolCallId: callId }, tool, args }));
  assert.equal(opened.status, 'inserted');
  settleAdmittedLogicalCallPreDispatchDisposition({ ...f.task, logicalToolCallId: callId, toolName: tool,
    args, lane: 'byo', reason: 'Controlled policy refusal.', disposition: 'policy_refusal' });
  const refusedKey = workflowEvidenceCallKey(f.task.sessionId, f.task.sourceUserSeq, callId);
  assert.equal(classify(f, key, { verifiedCalls: new Set([key, refusedKey]) }).reviewStakes, 'write');
});

test('corrupt physical task identity cannot inherit its logical parent\'s lean proof', () => {
  const f = fixture(), key = settle(f);
  const db = events.openEventLog();
  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'trg_physical_dispatch_identity_immutable'").get() as { sql: string };
  db.exec('DROP TRIGGER trg_physical_dispatch_identity_immutable');
  try {
    db.prepare('UPDATE physical_dispatches SET accepted_task_id = ? WHERE session_id = ?').run('another-exact-task', f.task.sessionId);
    assert.equal(classify(f, key).reviewStakes, 'write');
  } finally { db.exec(trigger.sql); }
});

test('successful actual read reaches the legacy judge at read depth with the captured reviewer', async () => {
  const f = fixture(); settle(f);
  const selection = { fixtureSavedModel: 'owner-chosen-reviewer', fixtureSavedAccount: 'exact-account' };
  const evidence = readWorkflowTargetEvidence(f.runId);
  assert.equal(evidence.available, true);
  assert.equal(evidence.reviewStakes, 'read');
  const result = await judgeWorkflowTarget({ workflow: f.def as never, inputs: {}, finalOutput: '323',
    executionEvidence: () => readWorkflowTargetEvidence(f.runId),
    reviewPolicy: { status: 'captured', enabled: true, judgeSelection: selection } as never,
    judgeFn: async (_objective, _reply, context) => {
      assert.equal(context?.reviewStakes, 'read');
      assert.equal(context?.boundaryJudgeSelection, selection);
      assert.equal(context?.verifiedReadResults?.[0]?.status, 'verified');
      return { done: true, reason: 'Exact read receipt reviewed.' };
    } });
  assert.equal(result.judged, true);
});

test('only a verified uninvalidated host transform can use the no-tool lean path', async () => {
  const { recordStepOutput } = await import('./workflow-run-workspace.js');
  const { appendWorkflowEvent } = await import('./workflow-events.js');
  const f = fixture(), value = { product: 323 };
  const definition = { ...f.def, steps: [{ id: 'work', prompt: '', transform: {
    version: 1, expression: { op: 'literal', value } } }] };
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${f.runId}.json`), JSON.stringify({ id: f.runId,
    workflowDefinitionSnapshot: { version: 1, workflowSlug: f.runId, admittedAt: new Date().toISOString(),
      definition, definitionHash: workflowDefinitionHash(definition as never) } }));
  const artifact = recordStepOutput({ workflowName: f.runId, runId: f.runId, stepId: 'work', output: value, nowIso: new Date().toISOString() });
  appendWorkflowEvent(f.runId, f.runId, { kind: 'step_completed', stepId: 'work', output: value,
    meta: { mode: 'transform', stepOutputArtifact: artifact } });
  const evidence = readWorkflowTargetEvidence(f.runId);
  assert.equal(evidence.reviewStakes, 'read');
  appendWorkflowEvent(f.runId, f.runId, { kind: 'step_invalidated', stepId: 'work' });
  assert.equal(readWorkflowTargetEvidence(f.runId).reviewStakes, 'write');
});

test('legacy target review forwards captured selection and refuses stale consequence frontier', async () => {
  const f = fixture(), key = settle(f, { mutating: true });
  const proof = classify(f, key);
  const selection = { fixtureSavedModel: 'owner-chosen-reviewer', fixtureSavedAccount: 'exact-account' };
  const evidence = { available: true, summary: 'Exact authenticated result.', ...proof,
    results: [{ toolName: 'FIXTURE_WRITE', outcome: 'succeeded', status: 'verified', contentComplete: true }] };
  let calls = 0;
  const verdict = await judgeWorkflowTarget({ workflow: f.def as never, inputs: {}, finalOutput: 'Saved 323.',
    reviewPolicy: { status: 'captured', enabled: true, judgeSelection: selection } as never,
    executionEvidence: () => ({ ...evidence, ...(calls ? { reviewStakesDigest: 'changed-exact-frontier' } : {}) }),
    judgeFn: async (_objective, _reply, context) => {
      assert.equal(context?.reviewStakes, 'write');
      assert.equal(context?.boundaryJudgeSelection, selection);
      calls++;
      return { done: true, reason: 'Fixture reviewer.' };
    } });
  assert.equal(verdict.judged, false);
  assert.equal(verdict.unavailable, true);
});

test('external or unknown legacy effects cannot accept a Jev-only completion', async () => {
  let jevCalls = 0, reviewerCalls = 0;
  _setTypesafeKeyForTests('fixture-key');
  _setSystemOneFetchForTests(async () => { jevCalls++; throw new Error('write must not ask Jev'); });
  _setCompletionJudgeForTests(async (_objective, _reply, context) => {
    assert.equal(context?.reviewStakes, 'write'); reviewerCalls++;
    return { verdict: { done: true, reason: 'Configured fixture reviewer.' }, failure: null };
  });
  const f = fixture();
  for (const stakes of ['write', undefined] as const) {
    const evidence = { available: true, summary: 'Settled external fixture result.', reviewStakes: stakes,
      results: [{ toolName: 'FIXTURE_WRITE', outcome: 'succeeded', status: 'verified', contentComplete: true }] };
    const result = await judgeWorkflowTarget({ workflow: f.def as never, inputs: {}, finalOutput: 'Saved 323.',
      executionEvidence: () => evidence });
    assert.equal(result.judged, true);
  }
  assert.equal(reviewerCalls, 2);
  assert.equal(jevCalls, 0);
});
