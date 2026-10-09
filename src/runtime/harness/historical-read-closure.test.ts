import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import type { AgentInputItem } from '@openai/agents';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-historical-read-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'historical-read-fixture\n');
const events = await import('./eventlog.js');
const authority = await import('./accepted-turn-call-authority.js');
const bindings = await import('./host-call-capability-binding.js');
const { durableLogicalCallContract } = await import('./logical-call-contract.js');
const dispatch = await import('./dispatch-ledger.js');
const settlements = await import('./logical-call-settlement-store.js');
const { classifyAttemptOutcome } = await import('./attempt-outcome.js');
const { acceptedTaskIdFor } = await import('./attempt-identity.js');
const { historicalReadCompletionEvidence, historicalReadClosureIsAuthentic, sourceAttemptedWrites } = await import('./host-completion-work.js');
const { historicalReadPacketIsCurrent, closeHistoricalReadSelection, historicalEvidenceDigest } = await import('./historical-completion-evidence.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('./brackets.js');
const { judgeObjectiveComplete, _setCompletionJudgeForTests } = await import('./objective-judge.js');
const { tryJevCompletionVerdict, _resetCompletionSizeGateForTests } = await import('../jev/control-plane.js');
const { _setSystemOneFetchForTests, _setTypesafeKeyForTests } = await import('../jev/client.js');
const { completionVerdictForAcceptedSource } = await import('./host-turn-runner.js');
const modelBatches = await import('./accepted-model-batch-checkpoint.js');
const hostResults = await import('./host-model-result-receipt.js');

let serial = 0;
const objective = 'What did the earlier status read show? Report the old observation, without checking again.';
const reply = 'The earlier status read showed ready. I have not checked it again.';
function accepted(text: string, sessionId?: string, taskMode?: unknown) {
  const session = sessionId ?? events.createSession({ id: `historical-read-${++serial}`, kind: 'chat' }).id;
  const source = events.appendEvent({ sessionId: session, turn: 1, role: 'user', type: 'user_input_received',
    data: { text, ...(taskMode ? { taskMode } : {}) } });
  const identity = { sessionId: session, sourceUserSeq: source.seq, acceptedTaskId: acceptedTaskIdFor(session, source.seq) };
  assert.equal(authority.armHostCallAuthority({ ...identity, catalogRevisionDigest: 'a'.repeat(64),
    bindingRevisionDigest: 'a'.repeat(64), maxLogicalCalls: 20, maxParallelCalls: 8 }).status, 'armed');
  return identity;
}
function retained(identity: ReturnType<typeof accepted>, payload: unknown, input: { mutating?: boolean; outcome?: 'failed' | 'unknown'; args?: Record<string, unknown> } = {}) {
  const callId = `historical-call-${++serial}`, tool = input.mutating ? 'run_shell_command' : 'read_file';
  const args = input.args ?? (input.mutating ? { command: 'synthetic append' } : { path: '/synthetic/status' });
  const root = authority.acceptedTurnCallAuthorityFor(identity.sessionId, identity.sourceUserSeq);
  assert.equal(root.status, 'ok'); if (root.status !== 'ok') throw new Error('fixture root unavailable');
  const contract = durableLogicalCallContract(identity.acceptedTaskId, tool, args)!;
  const base = { ...identity, sourceEventId: root.authority.sourceEventId, sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: callId, toolName: tool, argumentDigest: contract.argumentDigest,
    effect: input.mutating ? 'local_write' as const : 'read' as const, bindingKind: 'local_envelope' as const,
    capabilityId: tool, schemaFingerprint: 'a'.repeat(64), accountId: '', invokePortId: 'fixture:read', operationId: tool,
    manifestId: '', manifestDigest: '', engineVersion: root.authority.engineVersion, surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest, authorityRevision: root.authority.revision, surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest: root.authority.catalogRevisionDigest!, bindingRevisionDigest: root.authority.bindingRevisionDigest! };
  const opened = authority.withHostCallAttestation({ ...base, bindingDigest: bindings.hostCallAttestationBindingDigest(base) },
    () => dispatch.beginPhysicalDispatch({ identity: { ...identity, logicalToolCallId: callId, physicalDispatchId: `dispatch:${callId}`, ordinal: 0 }, tool, args, executionSite: 'host' }));
  assert.equal(opened.status, 'inserted'); if (opened.status !== 'inserted') throw new Error('fixture dispatch failed');
  dispatch.settlePhysicalDispatch({ identity: opened.identity, tool, outcome: 'returned' });
  const outcome = classifyAttemptOutcome(input.outcome === 'failed' ? { argumentValidationFailed: true }
    : input.outcome === 'unknown' ? {} : { envelopeSuccessful: true });
  const committed = settlements.commitLogicalCallSettlement({ identity: { ...identity, logicalToolCallId: callId },
    contract: { toolName: tool, args }, execution: { kind: 'local_execution' }, result: { payload }, outcome,
    recovery: { businessCall: true, mutating: input.mutating === true }, observer: { lane: 'byo', turn: 1 } });
  assert.equal(committed.status, 'committed');
  return callId;
}
function fixture(input: { payload?: unknown; unknownWrite?: boolean; oldFailed?: boolean; taskMode?: unknown; request?: string; response?: string } = {}) {
  const old = accepted('Read the synthetic status.');
  const mutation = input.unknownWrite ? retained(old, 'append may have run', { mutating: true, outcome: 'unknown' }) : undefined;
  const callId = retained(old, input.payload ?? 'ready', { ...(input.oldFailed ? { outcome: 'failed' as const } : {}) });
  const current = accepted(input.request ?? objective, old.sessionId, input.taskMode);
  const attempt = events.beginRunAttempt(current.sessionId, { attemptId: `attempt:historical:${++serial}` });
  events.bindRunAttemptSourceUserEvent(attempt, current.sourceUserSeq);
  const run = <T>(fn: () => T, signal?: AbortSignal): T | Promise<T> => withHarnessRunContext({ sessionId: current.sessionId,
    sourceUserSeq: current.sourceUserSeq, runAttemptId: attempt.attemptId, interactiveForeground: true,
    counter: new ToolCallsCounter(20), ...(signal ? { callerCancelSignal: signal } : {}) }, fn);
  const packet = () => historicalReadCompletionEvidence({ ...current, objective: input.request ?? objective,
    reply: input.response ?? reply, excluded: false });
  return { old, current, attempt, run, packet, callId, mutation };
}
function answers(input: { choice?: string; historical?: number; unsupported?: number; computed?: number; omit?: string } = {}) {
  return async (_url: string, wire: { body: string }) => {
    const body = JSON.parse(wire.body);
    const selected = input.choice ?? Object.keys(body.questions.historicalGroup.criteria).find(key => key.startsWith('historical_source_'));
    assert.ok(selected);
    const values: Record<string, unknown> = Object.fromEntries(Object.entries({ delivered: .95, unaddressed: .03,
      unsupported: input.unsupported ?? .03, computed: input.computed ?? .03, asksUser: .03, cannotFinish: .03,
      historicalOnly: input.historical ?? .95 }).map(([id, noul]) => [id, { type: 'noul', noul }]));
    values.historicalGroup = { type: 'choice', choice: selected, confidence: .95, probabilities: { [selected]: .95 } };
    if (input.omit) delete values[input.omit];
    return { status: 200, ok: true, text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: values,
      usage: { input_tokens: 100, output_tokens: 20 } }) };
  };
}
function setup() {
  _setTypesafeKeyForTests('ts_historical_fixture'); _resetCompletionSizeGateForTests();
  let reviewCalls = 0;
  _setCompletionJudgeForTests(async () => { reviewCalls++; return { verdict: { done: false, reason: 'The full reviewer retained the missing proof.' }, failure: null }; });
  return { reviewCalls: () => reviewCalls };
}
afterEach(() => { _setTypesafeKeyForTests(null); _setSystemOneFetchForTests(undefined); _setCompletionJudgeForTests(null); _resetCompletionSizeGateForTests(); });
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('real old read redemption closes only the separate historical namespace, with no current effects or extra call', async () => {
  const state = setup(), f = fixture(); let posts = 0;
  _setSystemOneFetchForTests(async (url, wire) => { posts++; const body = JSON.parse(wire.body);
    assert.equal(body.state.receiptsComplete, false); assert.deepEqual(body.state.receipts, []);
    assert.equal(body.state.historicalEvidence.groups[0].observations[0].content, 'ready');
    assert.equal(body.state.evidence, undefined, 'the older prose is not duplicated or used as current coverage');
    return answers()(url, wire); });
  await f.run(async () => {
    const packet = f.packet(); assert.ok(packet);
    const verdict = await judgeObjectiveComplete(objective, reply, { sessionId: f.current.sessionId, skills: [],
      toolCallSummary: 'No current effects.', verifiedReadResults: [], reviewStakes: 'read', historicalEvidence: packet });
    assert.equal(verdict.done, true); assert.equal(verdict.jevAttempt?.coverageComplete, false);
    assert.equal(verdict.jevAttempt?.historicalOnly, true); assert.equal(verdict.historicalEvidence?.evidenceMode, 'historical_only');
    assert.equal(verdict.historicalEvidence?.source.sourceUserSeq, f.old.sourceUserSeq);
    assert.equal(historicalReadClosureIsAuthentic({ ...f.current, objectiveDigest: packet.consumer.objectiveDigest,
      replyDigest: packet.consumer.replyDigest }, verdict.historicalEvidence), true);
    assert.equal(state.reviewCalls(), 0); assert.equal(posts, 1); assert.equal(sourceAttemptedWrites(f.current), 0);
    const attempted = events.openEventLog().prepare('SELECT COUNT(*) AS n FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ?')
      .get(f.current.sessionId, f.current.sourceUserSeq) as { n: number };
    assert.equal(attempted.n, 0);
  });
});

for (const variant of [
  { name: 'foreign offered choice', choice: 'historical_source_forged' },
  { name: 'historical applicability rejected', historical: .05 },
  { name: 'unsupported causal or once-only claim', unsupported: .9 },
  { name: 'computed octal conversion', computed: .95 },
  { name: 'missing selection answer', omit: 'historicalGroup' },
]) test(`${variant.name} uses the configured full reviewer, without another Jev call`, async () => {
  const state = setup(), f = fixture(); let posts = 0;
  _setSystemOneFetchForTests(async (url, wire) => { posts++; return answers(variant)(url, wire); });
  await f.run(async () => {
    const verdict = await judgeObjectiveComplete(objective, reply, { sessionId: f.current.sessionId, skills: [],
      toolCallSummary: '', verifiedReadResults: [], reviewStakes: 'read', historicalEvidence: f.packet() });
    assert.equal(verdict.done, false); assert.equal(verdict.fast, undefined); assert.equal(state.reviewCalls(), 1); assert.equal(posts, 1);
  });
});

test('same old bytes with a fresh accepted ask depend on historical applicability, never a keyword bypass', async () => {
  const request = 'Check the status now.', response = 'The status is currently ready.';
  const state = setup(), f = fixture({ request, response });
  _setSystemOneFetchForTests(async (url, wire) => {
    const body = JSON.parse(wire.body); assert.equal(body.state.request, request); assert.equal(body.state.response, response);
    return answers({ historical: .01 })(url, wire);
  });
  await f.run(async () => {
    assert.ok(f.packet(), 'host admission does not guess meaning from words');
    const verdict = await judgeObjectiveComplete(request, response, { sessionId: f.current.sessionId, skills: [],
      toolCallSummary: '', reviewStakes: 'read', historicalEvidence: f.packet() });
    assert.equal(verdict.done, false); assert.equal(state.reviewCalls(), 1);
  });
});

test('an unknown original append stays unknown beside successful historical readback', async () => {
  setup(); const f = fixture({ unknownWrite: true }); _setSystemOneFetchForTests(answers());
  await f.run(async () => {
    const packet = f.packet(); assert.ok(packet); assert.equal(packet.groups[0].warnings[0].outcome, 'unknown');
    const verdict = await tryJevCompletionVerdict(objective, reply, { sessionId: f.current.sessionId, historicalEvidence: packet,
      coverage: { complete: false, outcomeEvidence: [] }, screening: true });
    assert.ok(verdict?.historicalEvidence); assert.equal(verdict.historicalEvidence.warnings[0].outcome, 'unknown');
    const original = events.openEventLog().prepare('SELECT outcome_kind FROM logical_call_settlements WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?')
      .get(f.old.sessionId, f.old.sourceUserSeq, f.mutation) as { outcome_kind: string };
    assert.equal(original.outcome_kind, 'unknown');
  });
});

test('a real admitted refused model frame excludes historical closure without a logical or physical tool start', () => {
  const f = fixture(); f.run(() => {
    const packet = f.packet(); assert.ok(packet);
    const closure = closeHistoricalReadSelection(packet, packet.groups[0].ref,
      { sessionId: f.current.sessionId, objective, reply }); assert.ok(closure);
    const input = { ...f.current, objectiveDigest: packet.consumer.objectiveDigest, replyDigest: packet.consumer.replyDigest };
    assert.equal(historicalReadClosureIsAuthentic(input, closure), true);
    const callId = `refused-model-frame-${++serial}`;
    const frame: AgentInputItem[] = [{ type: 'function_call', callId, name: 'read_file',
      arguments: JSON.stringify({ mode: 'invented' }), status: 'completed' }];
    const admitted = modelBatches.admitAcceptedModelBatch({ ...f.current,
      preHistory: [{ role: 'user', content: objective }], frameHistory: frame,
      providerResponseId: `response:${callId}` });
    assert.equal(admitted.status, 'admitted');
    if (admitted.status !== 'admitted') throw new Error('fixture admission failed');
    const refused = hostResults.buildHostToolDispositionResult({ callId, toolName: 'read_file',
      disposition: 'refused_pre_dispatch', frameDigest: historicalEvidenceDigest(JSON.stringify(frame)),
      frameIndex: 0, frameSize: 1, countsRefusal: true });
    const receipts = hostResults.recordHostModelResultReceipts({ admission: admitted.admission, resultItems: [refused] });
    assert.equal(receipts.length, 1); assert.equal(receipts[0].disposition, 'refused_pre_dispatch');
    const finalized = modelBatches.finalizeAcceptedModelBatch(admitted.admission, { committedResultItems: [refused] });
    assert.ok(finalized.status === 'committed' || finalized.status === 'existing');
    const db = events.openEventLog();
    const started = db.prepare(`SELECT 1 AS attempted FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ?
      UNION ALL SELECT 1 FROM physical_dispatches WHERE session_id = ? AND source_user_seq = ?
      UNION ALL SELECT 1 FROM events WHERE session_id = ? AND type = 'tool_called'
        AND json_extract(data_json, '$.sourceUserSeq') = ? LIMIT 1`)
      .get(f.current.sessionId, f.current.sourceUserSeq, f.current.sessionId, f.current.sourceUserSeq,
        f.current.sessionId, f.current.sourceUserSeq);
    assert.equal(started, undefined, 'the refusal is owned only by model-batch admission and host-result receipts');
    assert.equal(sourceAttemptedWrites(f.current), 0);
    assert.equal(f.packet(), undefined, 'new admission excludes initial packet minting');
    assert.equal(historicalReadPacketIsCurrent(packet, { sessionId: f.current.sessionId, objective, reply }), false,
      'an already admitted historical packet is invalidated');
    assert.equal(historicalReadClosureIsAuthentic(input, closure), false, 'durable reopen preserves the same exclusion');
  });
});

for (const kind of ['discovery', 'failed_read', 'local_write', 'plan', 'execute', 'partial', 'failed_old_read', 'oversized_old_read'] as const)
  test(`${kind} cannot enter historical closure`, () => {
    const f = fixture({ ...(kind === 'plan' ? { taskMode: { version: 1, kind: 'plan' } } : {}),
      ...(kind === 'execute' ? { taskMode: { version: 1, kind: 'execute', executeRef: { planId: 'plan-fixture', revision: 1, digest: 'a'.repeat(64) } } } : {}),
      ...(kind === 'partial' ? { payload: { items: ['ready'], next_cursor: 'more' } } : {}),
      ...(kind === 'failed_old_read' ? { oldFailed: true } : {}),
      ...(kind === 'oversized_old_read' ? { payload: 'ready'.repeat(2500) } : {}) });
    if (kind === 'discovery') events.appendEvent({ ...f.current, turn: 1, role: 'Clem', type: 'tool_called', data: { sourceUserSeq: f.current.sourceUserSeq, tool: 'tool_search' } });
    if (kind === 'failed_read') retained(f.current, 'no read', { outcome: 'failed' });
    if (kind === 'local_write') retained(f.current, 'saved', { mutating: true });
    f.run(() => assert.equal(f.packet(), undefined));
  });

test('pre-write observations and identical bytes under different request scope are never substituted', () => {
  const f = fixture(); retained(f.old, 'changed', { mutating: true });
  f.run(() => assert.equal(f.packet(), undefined, 'a read preceding a later mutation stays full review'));
  const other = fixture(); other.run(() => {
    const packet = other.packet(); assert.ok(packet);
    const forged = structuredClone(packet); forged.groups[0].observations[0].request = { path: '/other/status' };
    assert.equal(historicalReadPacketIsCurrent(forged, { sessionId: other.current.sessionId, objective, reply }), false);
    assert.equal(historicalReadPacketIsCurrent(packet, { sessionId: f.current.sessionId, objective, reply }), false);
    assert.equal(historicalReadPacketIsCurrent(packet, { sessionId: other.current.sessionId, objective: 'Different ask', reply }), false);
  });
});

test('corrupt original digest, wrong original source and duplicate selected refs fail reopen validation', () => {
  const f = fixture(); retained(f.old, 'second-ready', { args: { path: '/synthetic/second-status' } });
  f.run(() => {
    const packet = f.packet(); assert.ok(packet); const closure = closeHistoricalReadSelection(packet, packet.groups[0].ref,
      { sessionId: f.current.sessionId, objective, reply }); assert.ok(closure);
    const input = { ...f.current, objectiveDigest: packet.consumer.objectiveDigest, replyDigest: packet.consumer.replyDigest };
    const forged = structuredClone(closure); forged.source.sourceUserSeq = f.current.sourceUserSeq;
    assert.equal(historicalReadClosureIsAuthentic(input, forged), false);
    const wrongAsk = structuredClone(closure); wrongAsk.consumer.objectiveDigest = 'b'.repeat(64);
    assert.equal(historicalReadClosureIsAuthentic({ ...input, objectiveDigest: wrongAsk.consumer.objectiveDigest }, wrongAsk), false);
    const duplicate = structuredClone(closure); duplicate.observations[1] = duplicate.observations[0];
    assert.equal(historicalReadClosureIsAuthentic(input, duplicate), false);
    const db = events.openEventLog();
    const corrupt = () => db.prepare('UPDATE durable_result_handles SET raw_payload_json = ? WHERE handle_id = ?')
      .run(JSON.stringify('corrupt'), closure.observations[0].resultHandleId);
    assert.throws(corrupt, /immutable/);
    // Exercise fail-closed redemption after simulated storage corruption only
    // in this disposable home; restore the existing immutable-row guard.
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_durable_result_identity_immutable'")
      .get() as { sql: string };
    db.exec('DROP TRIGGER trg_durable_result_identity_immutable');
    try { corrupt(); } finally { db.exec(trigger.sql); }
    assert.equal(historicalReadClosureIsAuthentic(input, closure), false);
    assert.equal(historicalReadPacketIsCurrent(packet, { sessionId: f.current.sessionId, objective, reply }), false);
  });
});

test('the durable verdict reopens only the same historical selection and published reply', () => {
  const f = fixture(); f.run(() => {
    const packet = f.packet(); assert.ok(packet); const closure = closeHistoricalReadSelection(packet, packet.groups[0].ref,
      { sessionId: f.current.sessionId, objective, reply }); assert.ok(closure);
    const event = events.appendEvent({ sessionId: f.current.sessionId, turn: 1, role: 'system', type: 'goal_alignment_judged',
      data: { lane: 'host_v1', kind: 'completion', sourceUserSeq: f.current.sourceUserSeq, fulfills: true, fast: true,
        judgeModelId: 'jev-1.13.0', settledEffectCount: 0, settledEvidenceAvailable: true,
        objectiveDigest: packet.consumer.objectiveDigest, replyDigest: packet.consumer.replyDigest,
        judgedHistoricalReadResults: closure } });
    events.closeEventLog(); assert.equal(completionVerdictForAcceptedSource(f.current)?.fulfills, true);
    const bad = { ...event.data, replyDigest: 'b'.repeat(64) };
    events.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?').run(JSON.stringify(bad), event.id);
    assert.equal(completionVerdictForAcceptedSource(f.current), null);
  });
});

test('surrounding whitespace uses the exact host objective and published reply digests on durable reopen', async () => {
  setup(); const request = ` \n${objective}\n `, response = ` \n${reply}\n `;
  const f = fixture({ request, response }); _setSystemOneFetchForTests(answers());
  await f.run(async () => {
    const packet = f.packet(); assert.ok(packet);
    assert.equal(packet.consumer.objectiveDigest, historicalEvidenceDigest(request));
    assert.equal(packet.consumer.replyDigest, historicalEvidenceDigest(response));
    assert.equal(historicalReadPacketIsCurrent(packet, { sessionId: f.current.sessionId, objective: request.trim(), reply: response }), false);
    assert.equal(historicalReadPacketIsCurrent(packet, { sessionId: f.current.sessionId, objective: request, reply: response.trim() }), false);
    const verdict = await judgeObjectiveComplete(request, response, { sessionId: f.current.sessionId, skills: [],
      toolCallSummary: '', historicalEvidence: packet });
    assert.equal(verdict.done, true); assert.ok(verdict.historicalEvidence);
    events.appendEvent({ sessionId: f.current.sessionId, turn: 1, role: 'system', type: 'goal_alignment_judged',
      data: { lane: 'host_v1', kind: 'completion', sourceUserSeq: f.current.sourceUserSeq, fulfills: true, fast: true,
        judgeModelId: 'jev-1.13.0', settledEffectCount: 0, settledEvidenceAvailable: true,
        objectiveDigest: historicalEvidenceDigest(request), replyDigest: historicalEvidenceDigest(response),
        judgedHistoricalReadResults: verdict.historicalEvidence } });
    events.closeEventLog(); assert.equal(completionVerdictForAcceptedSource(f.current)?.fulfills, true);
  });
});

test('Stop while historical Jev is pending cannot qualify a terminal or start a reviewer', async () => {
  const state = setup(), f = fixture(), controller = new AbortController();
  let release!: (value: Awaited<ReturnType<ReturnType<typeof answers>>>) => void;
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  _setSystemOneFetchForTests(async (url, wire) => { started(); return new Promise(resolve => { release = resolve; }); });
  await f.run(async () => {
    const packet = f.packet(); assert.ok(packet);
    const pending = judgeObjectiveComplete(objective, reply, { sessionId: f.current.sessionId, skills: [], toolCallSummary: '', historicalEvidence: packet });
    await ready; controller.abort();
    release(await answers()('', { body: JSON.stringify({ questions: { historicalGroup: { criteria: { [packet.groups[0].ref]: 'exact' } } } }) }));
    await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
    assert.equal(state.reviewCalls(), 0); assert.equal(sourceAttemptedWrites(f.current), 0);
  }, controller.signal);
});
