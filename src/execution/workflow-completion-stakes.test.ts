import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
const { withHostLocalWriteCommitFromFile } = await import('../runtime/harness/host-local-write-commit.js');
const { readWorkflowTargetEvidence } = await import('./workflow-target-evidence.js');
const { readWorkflowCompletionStakes } = await import('./workflow-completion-stakes.js');
const { workflowDefinitionHash } = await import('./workflow-run-definition.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { judgeWorkflowTarget } = await import('./workflow-objective-judge.js');
const { _setCompletionJudgeForTests } = await import('../runtime/harness/objective-judge.js');
const { _resetCompletionSizeGateForTests } = await import('../runtime/jev/control-plane.js');
const { _setSystemOneFetchForTests, _setTypesafeKeyForTests } = await import('../runtime/jev/client.js');
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });
afterEach(() => { _setCompletionJudgeForTests(null); _setSystemOneFetchForTests(undefined); _setTypesafeKeyForTests(null); _resetCompletionSizeGateForTests(); });

let serial = 0;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(options: { prefix?: boolean; wrongRun?: boolean; kind?: string } = {}) {
  const runId = `stakes-run-${++serial}`, stepId = 'work';
  const session = events.createSession({ id: options.prefix === false ? `parked-fixture-${serial}` : `workflow:${runId}:${stepId}`,
    kind: (options.kind ?? 'workflow') as never, metadata: { workflowRunId: options.wrongRun ? 'another-run' : runId, stepId } });
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
  const tool = input.tool ?? 'FIXTURE_READ', callId = `logical:stakes-${++serial}`;
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
  return callId;
}

const classify = (f: ReturnType<typeof fixture>) => readWorkflowCompletionStakes({ runId: f.runId });

/** A System One answer that reads the reply as delivered, complete and
 * supported: Jev's confident DONE. */
const jevDone = async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ model: 'jev-fixture',
  answers: Object.fromEntries(Object.entries({ delivered: .95, unaddressed: .03, unsupported: .03, computed: .03, asksUser: .03,
    cannotFinish: .03 }).map(([id, noul]) => [id, { type: 'noul', noul }])),
  usage: { input_tokens: 100, output_tokens: 20 } }) });

test('a run that only read takes the fast review; an external mutation takes the full one', () => {
  const read = fixture(); settle(read);
  assert.equal(classify(read).reviewStakes, 'read');
  const write = fixture(); settle(write, { mutating: true });
  assert.equal(classify(write).reviewStakes, 'write');
  const mixed = fixture(); settle(mixed); settle(mixed, { mutating: true }); settle(mixed);
  assert.equal(classify(mixed).reviewStakes, 'write', 'one write among reads is still a write');
});

test('a run with no settled work has nothing at stake', () => {
  const f = fixture();
  assert.equal(classify(f).reviewStakes, 'read');
  assert.equal(readWorkflowTargetEvidence('missing-exact-run').reviewStakes, 'read');
});

test('a parked UUID workflow source is inventoried by host owner metadata', () => {
  const read = fixture({ prefix: false }); settle(read);
  assert.equal(classify(read).reviewStakes, 'read');
  const write = fixture({ prefix: false }); settle(write, { mutating: true });
  assert.equal(classify(write).reviewStakes, 'write', 'a parked step\'s write is not hidden by its session name');
});

test('a local artifact write the owner can get back takes the fast review; destructive or failed ones do not', () => {
  const replace = fixture(); settle(replace, { tool: 'write_file', local: true, mutating: true, requirementId: 'cap:local:write_file:replace' });
  assert.equal(classify(replace).reviewStakes, 'read');
  const destructive = fixture(); settle(destructive, { tool: 'delete_file', local: true, mutating: true });
  assert.equal(classify(destructive).reviewStakes, 'write');
  const failed = fixture(); settle(failed, { succeeded: false, local: true, tool: 'write_file', mutating: true });
  assert.equal(classify(failed).reviewStakes, 'write', 'a failed write is at stake: the answer must not claim it happened');
});

test('inventory the run cannot own is read as a write', () => {
  const wrong = fixture({ wrongRun: true }); settle(wrong);
  assert.equal(classify(wrong).reviewStakes, 'write', 'a session named for this run but owned by another');
  const foreign = fixture({ kind: 'chat' }); settle(foreign);
  assert.equal(classify(foreign).reviewStakes, 'write', 'a session of a kind the runner never activates');
});

test('the frontier digest moves when the run\'s settled work moves, without changing what reads cost', () => {
  const f = fixture(); settle(f);
  const before = classify(f);
  assert.equal(before.reviewStakes, 'read');
  const extra = attested(f, 'logical:unfinished', 'FIXTURE_READ', { other: true }, 'read',
    () => dispatch.admitLogicalCall({ identity: { ...f.task, logicalToolCallId: 'logical:unfinished' },
      tool: 'FIXTURE_READ', args: { other: true } }));
  assert.equal(extra.status, 'inserted');
  const admitted = classify(f);
  assert.equal(admitted.reviewStakes, 'read');
  assert.notEqual(admitted.reviewStakesDigest, before.reviewStakesDigest);
  settle(f, { mutating: true });
  const written = classify(f);
  assert.equal(written.reviewStakes, 'write');
  assert.notEqual(written.reviewStakesDigest, admitted.reviewStakesDigest);
});

test('the evidence reader verifies host commit content and carries the run\'s stakes', () => {
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
  const tampered = readWorkflowTargetEvidence(f.runId);
  assert.equal(tampered.available, false, 'changed bytes are a verification failure, which the review reports as unverified');
  assert.equal(tampered.reviewStakes, 'read', 'what the run did is unchanged: a restorable local write');
});

test('a host transform alone puts nothing at stake', async () => {
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
  assert.equal(evidence.results?.[0]?.toolName, 'workflow_transform');
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

test('legacy target review forwards captured selection and refuses stale consequence frontier', async () => {
  const f = fixture(); settle(f, { mutating: true });
  const proof = classify(f);
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

// The owner's rule, held for workflows as for chat turns: a run that only
// read closes on Jev's confident reading with complete receipts, and the
// configured reviewer is never started.
test('a run that only read closes on Jev without starting the configured reviewer', async () => {
  let jevCalls = 0, reviewerCalls = 0;
  _setTypesafeKeyForTests('fixture-key');
  _setSystemOneFetchForTests(async () => { jevCalls++; return jevDone(); });
  _setCompletionJudgeForTests(async () => { reviewerCalls++; throw new Error('a read must not start the configured reviewer'); });
  const f = fixture(); settle(f);
  const verdict = await judgeWorkflowTarget({ workflow: f.def as never, inputs: {}, finalOutput: 'The fixture result is 323.',
    executionEvidence: () => readWorkflowTargetEvidence(f.runId) });
  assert.equal(verdict.judged, true, verdict.gap);
  assert.equal(verdict.reached, true);
  assert.equal(verdict.reviewer?.judgeModelId, 'jev-fixture');
  assert.equal(jevCalls, 1);
  assert.equal(reviewerCalls, 0);
});

test('a run that wrote, sent or created takes the full configured review and never a Jev-only completion', async () => {
  let jevCalls = 0, reviewerCalls = 0;
  _setTypesafeKeyForTests('fixture-key');
  _setSystemOneFetchForTests(async () => { jevCalls++; throw new Error('a write must not ask Jev'); });
  _setCompletionJudgeForTests(async (_objective, _reply, context) => {
    assert.equal(context?.reviewStakes, 'write'); reviewerCalls++;
    return { verdict: { done: true, reason: 'Configured fixture reviewer.' }, failure: null };
  });
  const external = fixture(); settle(external); settle(external, { mutating: true });
  const result = await judgeWorkflowTarget({ workflow: external.def as never, inputs: {}, finalOutput: 'Saved 323.',
    executionEvidence: () => readWorkflowTargetEvidence(external.runId) });
  assert.equal(result.judged, true);
  // Unknown work never acquires the read shortcut either.
  const unknown = fixture();
  const evidence = { available: true, summary: 'Settled external fixture result.',
    results: [{ toolName: 'FIXTURE_WRITE', outcome: 'succeeded', status: 'verified', contentComplete: true }] };
  const unknownResult = await judgeWorkflowTarget({ workflow: unknown.def as never, inputs: {}, finalOutput: 'Saved 323.',
    executionEvidence: () => evidence });
  assert.equal(unknownResult.judged, true);
  assert.equal(reviewerCalls, 2);
  assert.equal(jevCalls, 0);
});
