/** Isolated exact shell evidence and the production completion-review handoff.
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/source-produced-output.test.ts
 * Only the real local arithmetic command runs; all model transports are inert. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-no-output-shell-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true',
  HARNESS_TOOL_BRACKETS: 'on', CLEMMY_UNIFIED_RECALL: 'off', CLEMMY_UNIFIED_TURN_PRIMER: 'off',
  CLEMMY_COMPLETION_REVIEW: 'on' });
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'no-output-shell-fixture\n');

const events = await import('./eventlog.js');
const identities = await import('./attempt-identity.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const ledger = await import('./dispatch-ledger.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');
const results = await import('./result-handle.js');
const crossingAuthority = await import('./settlement-crossing-authority.js');
const completion = await import('./host-completion-work.js');
const host = await import('./host-turn-runner.js');
const loop = await import('./loop.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const { getComputerTools } = await import('../../tools/computer-tools.js');
const semanticPorts = await import('../semantic-boundary/turn-semantic-port-registry.js');
const judge = await import('./objective-judge.js');
const jev = await import('../jev/client.js');
const { modelUsageAttributionStorage } = await import('../usage-log.js');
semanticPorts.installTurnSemanticModelPort(null);

afterEach(() => {
  loop._setReviewBeforeDeliveryForTests(false);
  host._setHostObjectiveJudgeForTests(null);
  judge._setCompletionJudgeForTests(async () => ({ verdict: null, failure: 'error' }));
  jev._setTypesafeKeyForTests(undefined);
  jev._setSystemOneFetchForTests(undefined);
});
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

let serial = 0;
function accepted(label: string, anchor = true) {
  const session = events.createSession({ id: `sess-no-output-${++serial}-${label}`, kind: 'chat' });
  const text = 'Read the controlled arithmetic result and report the value. Do not create or change any file.';
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  if (anchor) assert.ok(shadow.recordTurnGraphShadow({ identity }));
  return { ...identity, text };
}

/** Real ledger writers, retained request cipher, settlement, result and mirrors;
 * no hand-authored SQL is used to manufacture a positive proof. */
function settled(identity: ReturnType<typeof accepted>, input: {
  tool?: string; payload?: unknown; mutating?: boolean; saved?: boolean; provider?: boolean; failed?: boolean;
  refused?: boolean; uncertain?: boolean; noResult?: boolean; args?: Record<string, unknown>;
} = {}) {
  const toolName = input.tool ?? 'run_shell_command';
  const callId = `logical:${++serial}`;
  const task = { ...identity, acceptedTaskId: identities.acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq) };
  const args = input.args ?? { command: 'node -p "17*19"', cwd: home, timeout_ms: 10_000 };
  if (!input.refused) {
    const opened = ledger.beginPhysicalDispatch({ identity: { ...task, logicalToolCallId: callId,
      physicalDispatchId: `dispatch:${callId}`, ordinal: 0 }, tool: toolName, args,
      ...(input.provider ? {} : { executionSite: 'host' as const }) });
    assert.equal(opened.status, 'inserted', JSON.stringify(opened));
    if (opened.status !== 'inserted') throw new Error('fixture crossing was not admitted');
    assert.equal(ledger.settlePhysicalDispatch({ identity: opened.identity, tool: toolName, outcome: 'returned' }).status, 'inserted');
  } else {
    const admitted = ledger.admitLogicalCall({ identity: { ...task, logicalToolCallId: callId }, tool: toolName, args });
    assert.ok(admitted.status === 'inserted' || admitted.status === 'replayed', JSON.stringify(admitted));
  }
  const outcome = outcomes.classifyAttemptOutcome(input.refused ? { argumentValidationFailed: true }
    : input.uncertain ? { cancelled: true, mutating: true }
      : input.failed ? { argumentValidationFailed: true }
        : { hostExecuted: true, mutating: input.mutating ?? false, hostSavedLocalFiles: input.saved === true });
  const committed = settlements.commitLogicalCallSettlement({ identity: { ...task, logicalToolCallId: callId },
    contract: { toolName, args }, execution: { kind: input.refused ? 'refused_pre_dispatch'
      : input.provider ? 'provider_execution' : 'local_execution' },
    ...(input.noResult ? {} : { result: { payload: input.payload ?? '323\n' } }), outcome,
    recovery: { businessCall: true, mutating: input.mutating ?? false }, observer: { lane: 'byo', turn: identity.turn } });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  if (committed.status !== 'committed') throw new Error('fixture settlement was not committed');
  return { ...task, logicalToolCallId: callId, settlement: committed.settlement };
}

/** Corruption negatives temporarily remove only this fixture table's update
 * guard and restore its exact original SQL. No damaged row is reused. */
function damage(table: string, mutate: () => void) {
  assert.ok(['logical_call_settlements', 'logical_call_settlement_crossings', 'durable_result_handles', 'events'].includes(table));
  const db = events.openEventLog();
  const triggers = db.prepare('SELECT name, sql FROM sqlite_master WHERE type = ? AND tbl_name = ?')
    .all('trigger', table) as Array<{ name: string; sql: string }>;
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
  try { mutate(); } finally { for (const trigger of triggers) db.exec(trigger.sql); }
}

test('only exact successful non-mutating shell proof removes the static output label, including after reopen', () => {
  const identity = accepted('sound');
  const call = settled(identity);
  assert.equal(ledger.loadPhysicalRequestEvidence({ ...call,
    physicalDispatchId: call.settlement.crossings[0]!.physicalDispatchId })?.args !== undefined, true);
  assert.equal(results.redeemSuccessfulSettlementResultForHost(call).status, 'ok');
  assert.equal(completion.sourceAttemptedWrites(identity), 0);
  assert.equal(completion.sourceWritesAtStake(identity), 0);
  assert.equal(completion.sourceProducedOutput(identity), false);
  events.closeEventLog();
  assert.equal(completion.sourceProducedOutput(identity), false, 'qualification survives reopening from exact retained proof');
  assert.equal(completion.sourceProducedOutput(accepted('foreign-source')), false, 'another empty source receives no call evidence');
});

for (const [label, input] of [
  ['mutation', { mutating: true }], ['saved-under-compute', { saved: true }],
  ['failed', { failed: true }], ['refused', { refused: true }],
  ['uncertain', { uncertain: true, mutating: true }], ['provider', { provider: true }],
  ['missing-result', { noResult: true }], ['large-result', { payload: 'x'.repeat(65_536) }],
  ['large-request', { args: { command: 'x'.repeat(65_536), cwd: home, timeout_ms: 10_000 } }],
  ['host-only-creation', { tool: 'workflow_create', mutating: false }],
] as const) test(`${label} keeps the existing output/reviewer selection`, () => {
  const identity = accepted(label);
  settled(identity, input);
  assert.equal(completion.sourceProducedOutput(identity), true);
});

test('a saved command file revision and a failed sibling cannot be covered by one sound shell read', () => {
  const revised = accepted('revision');
  const call = settled(revised);
  events.appendEvent({ ...revised, role: 'system', type: 'guardrail_tripped', data: {
    kind: 'own_file_revision_after_command', sourceUserSeq: revised.sourceUserSeq,
    tool: 'run_shell_command', callId: call.logicalToolCallId, receipt: 'controlled revision marker' } });
  assert.equal(completion.sourceProducedOutput(revised), true);
  const siblings = accepted('siblings');
  settled(siblings); settled(siblings, { failed: true });
  assert.equal(completion.sourceProducedOutput(siblings), true);
  const unfinished = accepted('unfinished'); settled(unfinished);
  assert.equal(ledger.admitLogicalCall({ identity: { ...unfinished,
    acceptedTaskId: identities.acceptedTaskIdFor(unfinished.sessionId, unfinished.sourceUserSeq),
    logicalToolCallId: 'unfinished-shell' }, tool: 'run_shell_command', args: { command: 'node --version' } }).status, 'inserted');
  assert.equal(completion.sourceProducedOutput(unfinished), true);
});

test('qualification has bounded call and cumulative byte budgets', () => {
  const many = accepted('too-many');
  for (let index = 0; index < 17; index++) settled(many);
  assert.equal(completion.sourceProducedOutput(many), true);
  const bytes = accepted('source-byte-cap');
  for (let index = 0; index < 5; index++) settled(bytes, { payload: 'x'.repeat(60_000) });
  assert.equal(completion.sourceProducedOutput(bytes), true);
});

test('a readable historical v1 settlement keeps the static output label', () => {
  const identity = accepted('historical-v1');
  const call = settled(identity);
  const digest = crossingAuthority.settlementCrossingAuthorityDigest(call.settlement.crossings, 1);
  const db = events.openEventLog();
  damage('logical_call_settlements', () => db.prepare(`UPDATE logical_call_settlements
    SET crossing_authority_version = 1, physical_crossings_digest = ?
    WHERE session_id = ? AND logical_tool_call_id = ?`).run(digest, identity.sessionId, call.logicalToolCallId));
  const mirror = db.prepare('SELECT data_json FROM events WHERE id = ?').get(call.settlement.settlementEventId) as { data_json: string };
  const data = JSON.parse(mirror.data_json);
  delete data.crossingAuthorityVersion;
  data.physicalCrossingsDigest = digest;
  damage('events', () => db.prepare('UPDATE events SET data_json = ? WHERE id = ?')
    .run(JSON.stringify(data), call.settlement.settlementEventId));
  assert.equal(settlements.redeemDurableLogicalCallSettlementForHost(call).status, 'ok', 'historical proof is not merely corrupt');
  assert.equal(results.redeemSuccessfulSettlementResultForHost(call).status, 'ok');
  assert.equal(completion.sourceProducedOutput(identity), true, 'older crossing semantics are outside the new exception');
});

for (const kind of ['semantic', 'payload', 'missing-crossing', 'corrupt-crossing', 'missing-request', 'foreign-request'] as const) test(`${kind} damaged proof keeps review`, () => {
  const identity = accepted(kind);
  const call = settled(identity);
  const db = events.openEventLog();
  if (kind === 'semantic') damage('logical_call_settlements', () => {
    db.prepare('UPDATE logical_call_settlements SET semantic_digest = ? WHERE session_id = ? AND logical_tool_call_id = ?')
      .run('0'.repeat(64), identity.sessionId, call.logicalToolCallId);
  });
  else if (kind === 'payload') damage('durable_result_handles', () => {
    db.prepare('UPDATE durable_result_handles SET raw_payload_json = ? WHERE handle_id = ?')
      .run('"999\\n"', call.settlement.resultHandleId);
  });
  else if (kind === 'missing-crossing' || kind === 'corrupt-crossing') damage('logical_call_settlement_crossings', () => {
    const sql = kind === 'missing-crossing'
      ? 'DELETE FROM logical_call_settlement_crossings WHERE session_id = ? AND logical_tool_call_id = ?'
      : `UPDATE logical_call_settlement_crossings SET argument_digest = '${'0'.repeat(64)}' WHERE session_id = ? AND logical_tool_call_id = ?`;
    db.prepare(sql).run(identity.sessionId, call.logicalToolCallId);
  });
  else {
    const start = db.prepare('SELECT start_event_id FROM physical_dispatches WHERE session_id = ? AND logical_tool_call_id = ?')
      .get(identity.sessionId, call.logicalToolCallId) as { start_event_id: string };
    const event = db.prepare('SELECT data_json FROM events WHERE id = ?').get(start.start_event_id) as { data_json: string };
    const data = JSON.parse(event.data_json);
    if (kind === 'foreign-request') {
      const foreign = settled(accepted('foreign'));
      const other = db.prepare('SELECT e.data_json FROM events e JOIN physical_dispatches p ON p.start_event_id = e.id WHERE p.session_id = ? AND p.logical_tool_call_id = ?')
        .get(foreign.sessionId, foreign.logicalToolCallId) as { data_json: string };
      data.requestEvidenceCipher = JSON.parse(other.data_json).requestEvidenceCipher;
    } else delete data.requestEvidenceCipher;
    damage('events', () => db.prepare('UPDATE events SET data_json = ? WHERE id = ?').run(JSON.stringify(data), start.start_event_id));
  }
  assert.equal(completion.sourceProducedOutput(identity), true);
});

function jevReading(done: boolean) {
  return { model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries({ computed: 0.03,
    asksUser: 0.03, cannotFinish: 0.03, deadEnd: 0.03, delivered: done ? 0.93 : 0.1, unaddressed: done ? 0.05 : 0.9, unsupported: 0.05 })
    .map(([id, noul]) => [id, { type: 'noul', noul }])), usage: { input_tokens: 36, output_tokens: 5 } };
}

test('actual default wrapped shell host turn derives Jev-only completion without injecting the no-output flag', async () => {
  const identity = accepted('actual-host', false);
  const original = getComputerTools().find(candidate => candidate.name === 'run_shell_command');
  assert.ok(original);
  const shell = brackets.wrapToolForHarness(original);
  let mainCalls = 0; let reviewerCalls = 0; let hostReviewCalls = 0; let derivedNoOutput: boolean | undefined;
  const jevPurposes: string[] = [];
  jev._setTypesafeKeyForTests('ts_controlled_fixture');
  jev._setSystemOneFetchForTests(async () => { jevPurposes.push(modelUsageAttributionStorage.getStore()?.channel ?? 'unknown');
    return { ok: true, status: 200,
    text: async () => JSON.stringify(jevReading(true)) }; });
  judge._setCompletionJudgeForTests(async () => { reviewerCalls++; return { verdict: { done: true }, failure: null }; });
  host._setHostObjectiveJudgeForTests((objective, reply, context) => {
    hostReviewCalls++;
    derivedNoOutput = context?.producedNoOutput;
    return judge.judgeObjectiveComplete(objective, reply, context);
  });
  const model = { async getResponse() { return { responseId: `no-output-host-${++mainCalls}`,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output: mainCalls === 1
      ? [{ type: 'function_call', callId: 'actual-shell-read', name: 'run_shell_command',
        arguments: JSON.stringify({ command: 'node -p "17*19"', cwd: home, timeout_ms: 10_000 }) }]
      : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The arithmetic result is 323.' }] }] }; },
    async *getStreamedResponse() { const response = await this.getResponse(); yield { type: 'response_started' };
      yield { type: 'model', event: { type: 'finish', finishReason: response.output.some(item => item.type === 'function_call') ? 'tool_calls' : 'stop' } };
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } }; } };
  const agent = { model, tools: [shell] };
  const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: identity.sessionId, universeTools: [shell],
    activeToolNames: ['run_shell_command'], policyHash: 'no-output-shell-fixture',
    budget: { maxUncachedTokens: 100_000, maxModelCalls: 3, maxToolCalls: 3, maxElapsedMs: 60_000 } });
  assert.ok(sealed.ok); if (!sealed.ok) throw new Error('fixture capability surface did not seal');
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  host.captureEffectiveCompletionPolicyOnce({ ...identity, enabled: true });
  const runner = Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute'); } });
  // Exercise the real entry point's lifecycle writers; a bare host runner
  // intentionally has no conversation listener to journal tool_called.
  loop._setReviewBeforeDeliveryForTests(true);
  const outcome = await loop.runConversation({ sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq,
    input: identity.text, reuseRecordedUserInput: true, turnEngine: 'host_v1', maxSteps: 1, maxTurns: 3,
    toolCallsPerTurn: 3, judgeCompletion: true, buildAgent: async () => agent as never,
    makeRunner: () => runner as never });
  assert.equal(outcome.publicPresentation?.text, 'The arithmetic result is 323.');
  assert.equal(outcome.publicPresentation?.status, 'done');
  assert.equal(mainCalls, 2, 'one actual shell request and one answer, no recovery model loop');
  const exactRows = events.openEventLog().prepare(`SELECT l.tool_name, l.state, s.execution_kind, s.outcome_kind,
    s.outcome_detail, s.mutating, s.result_handle_id IS NOT NULL AS has_result
    FROM logical_tool_calls l LEFT JOIN logical_call_settlements s ON s.session_id=l.session_id
      AND s.source_user_seq=l.source_user_seq AND s.logical_tool_call_id=l.logical_tool_call_id
    WHERE l.session_id=? AND l.source_user_seq=?`).all(identity.sessionId, identity.sourceUserSeq);
  const sourceLog = events.listEvents(identity.sessionId);
  const diagnostics = { mainCalls, hostReviewCalls, jevPurposes, reviewerCalls,
    sourceProducedOutput: completion.sourceProducedOutput(identity),
    exactRows, policy: host.readCapturedCompletionPolicy(identity),
    skipped: sourceLog.filter(row => row.type === 'completion_review_skipped').map(row => row.data.reason),
    guards: sourceLog.filter(row => row.type === 'guardrail_tripped').map(row => ({ kind: row.data.kind, code: row.data.code })),
    retained: results.redeemSuccessfulSettlementResultForHost({ ...identity,
      acceptedTaskId: completion.evidenceAcceptedTaskId(identity.sessionId, identity.sourceUserSeq), logicalToolCallId: 'actual-shell-read' }).status };
  assert.equal(derivedNoOutput, true, `the production host derives the flag from actual shell receipts: ${JSON.stringify(diagnostics)}`);
  assert.equal(jevPurposes.filter(purpose => purpose === 'jev-completion').length, 1,
    `one mocked Jev completion transport; auxiliary purposes are separate: ${JSON.stringify(jevPurposes)}`);
  assert.equal(reviewerCalls, 0, 'no configured completion reviewer is started');
  assert.equal(completion.sourceProducedOutput(identity), false);
  const retained = results.redeemSuccessfulSettlementResultForHost({ ...identity,
    acceptedTaskId: completion.evidenceAcceptedTaskId(identity.sessionId, identity.sourceUserSeq), logicalToolCallId: 'actual-shell-read' });
  assert.equal(retained.status, 'ok');
  if (retained.status === 'ok') assert.match(String(retained.value.rawPayload), /323/);
});

test('derived no-output evidence preserves Jev NOT-DONE, unknown review, and protected obligations', async () => {
  const identity = accepted('judge-controls'); settled(identity);
  const noOutput = !completion.sourceProducedOutput(identity);
  assert.equal(noOutput, true);
  let jevCalls = 0; let reviewerCalls = 0;
  jev._setTypesafeKeyForTests('ts_controlled_fixture');
  jev._setSystemOneFetchForTests(async () => { jevCalls++; return { ok: true, status: 200,
    text: async () => JSON.stringify(jevReading(false)) }; });
  judge._setCompletionJudgeForTests(async () => { reviewerCalls++; return { verdict: { done: false, blocked: true }, failure: null }; });
  const context = { sessionId: identity.sessionId, skills: [], reviewStakes: 'read' as const, producedNoOutput: noOutput,
    toolCallSummary: completion.sourceSettledReadEvidence(identity).summary };
  const notDone = await judge.judgeObjectiveComplete(identity.text, 'The requested answer is not present.', context);
  assert.equal(notDone.done, false); assert.notEqual(notDone.failedOpen, true);
  assert.equal(jevCalls, 1); assert.equal(reviewerCalls, 0);
  jev._setSystemOneFetchForTests(async () => { throw new Error('controlled unavailable transport'); });
  const unknown = await judge.judgeObjectiveComplete(identity.text, 'The arithmetic result is 323.', context);
  assert.equal(unknown.failedOpen, true); assert.equal(unknown.reviewFailure, 'unavailable');
  assert.equal(reviewerCalls, 0, 'unknown Jev remains unreviewed rather than inventing a passed review');
  for (const protectedContext of [{ reviewsPlan: true }, { reviewStakes: 'write' as const },
    { memoryRequirementContext: 'An exact durable memory correction is still required.' },
    { inheritedReadCoverage: [] }]) {
    const before = reviewerCalls;
    await judge.judgeObjectiveComplete(identity.text, 'The arithmetic result is 323.', { ...context, ...protectedContext } as never);
    assert.ok(reviewerCalls > before, 'independent protected obligations retain the configured reviewer');
  }
});
