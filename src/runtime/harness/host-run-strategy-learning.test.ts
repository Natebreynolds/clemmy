/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-run-strategy-learning.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-strategy-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { createSession, appendEvent } = await import('./eventlog.js');
const { learnHostRunStrategyForAcceptedTask, selectLearnedStrategyTools, refusedToolsNotAmongUsed } = await import('./host-run-strategy-learning.js');
const { evaluateLearningCandidate } = await import('../../memory/learning-receipt.js');
const { renderRunStrategiesForContext } = await import('../../memory/run-strategy-store.js');

after(() => {
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('learned strategies drop kernel inspection tools when a business tool settled', () => {
  assert.deepEqual(
    selectLearnedStrategyTools(['workspace_roots', 'outlook_get_calendar_view', 'tool_search']),
    ['outlook_get_calendar_view'],
  );
  assert.deepEqual(
    selectLearnedStrategyTools(['read_file']),
    ['read_file'],
    'a local-read run still teaches the tool that did the work',
  );
});

test('a host done terminal without settlements does not invent a strategy', () => {
  const session = createSession({ kind: 'chat', channel: 'desktop', title: 'no-tools' });
  const user = appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Create a local fixture file' },
  });
  const result = learnHostRunStrategyForAcceptedTask({
    sessionId: session.id,
    sourceUserSeq: user.seq,
  });
  assert.equal(result.status, 'not_proven');
  assert.equal(renderRunStrategiesForContext('Create a local fixture file'), '');
});

test('configured host review is eligible strategy authority', () => {
  const decision = evaluateLearningCandidate({
    target: 'strategy',
    authority: 'configured_completion_review',
    sessionId: 'sess-host',
    sourceId: 'sess-host:12',
    terminalSuccess: true,
    ownerSelectedJudge: true,
    controllerValidation: true,
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.receipt?.authority, 'configured_completion_review');
});

test('fail-open host review is not eligible to teach a strategy', () => {
  const decision = evaluateLearningCandidate({
    target: 'strategy',
    authority: 'configured_completion_review',
    sessionId: 'sess-host',
    sourceId: 'sess-host:13',
    terminalSuccess: true,
    ownerSelectedJudge: true,
    failedOpen: true,
  });
  assert.equal(decision.eligible, false);
});

test('native product lifecycle tools teach a strategy while kernel controls do not', () => {
  assert.deepEqual(selectLearnedStrategyTools(['tool_search', 'plan_task', 'workflow_create',
    'workflow_get', 'workflow_set_enabled', 'workflow_run', 'workflow_run_status', 'workflow_get']),
  ['workflow_create', 'workflow_get', 'workflow_set_enabled', 'workflow_run', 'workflow_run_status']);
  assert.deepEqual(selectLearnedStrategyTools(['space_save', 'space_get', 'tool_search']), ['space_save', 'space_get']);
  assert.deepEqual(selectLearnedStrategyTools(['tool_search', 'plan_task', 'request_approval']), []);
});

test('a learned strategy carries the request shapes of the settled calls behind its tools, unwrapped from the carrier and with values elided', async () => {
  const shadow = await import('../graph/turn-graph-shadow.js');
  const dispatch = await import('./dispatch-ledger.js');
  const identities = await import('./attempt-identity.js');
  const outcomes = await import('./attempt-outcome.js');
  const store = await import('./logical-call-settlement-store.js');
  const { provenCallShapesForSource } = await import('./host-run-strategy-learning.js');
  const session = createSession({ id: 'shapes-learning', kind: 'chat' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'organic traffic value for weartriallaw.com over six months' } });
  assert.ok(shadow.recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 } }));
  const task = { sessionId: session.id, sourceUserSeq: source.seq, acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq) };
  const inner = { method: 'POST', path: '/v3/dataforseo_labs/google/historical_bulk_traffic_estimation/live', data: [{ targets: ['weartriallaw.com'], location_code: 2840, language_code: 'en' }] };
  const callId = 'call_shape_1';
  appendEvent({ sessionId: session.id, turn: 1, role: 'assistant', type: 'tool_called', data: {
    sourceUserSeq: source.seq, callId, tool: 'work_call', effectiveTool: 'dataforseo__api_request', effect: 'read',
    arguments: JSON.stringify({ requirement_id: 'dataforseo__api_request', name: 'dataforseo__api_request', args_json: JSON.stringify(inner) }),
  } });
  const started = dispatch.beginPhysicalDispatch({ identity: { ...task, logicalToolCallId: 'lc-shape-1', physicalDispatchId: 'lc-shape-1:1', ordinal: 0 }, tool: 'dataforseo__api_request', args: inner });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({ identity: started.identity, tool: 'dataforseo__api_request', outcome: 'returned' }).status, 'inserted');
  const committed = store.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: 'lc-shape-1' },
    contract: { toolName: 'dataforseo__api_request', args: inner },
    execution: { kind: 'provider_execution' },
    result: { payload: { status_code: 20000, tasks: [{ result: [{ items: [] }] }] } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'byo', callId, turn: 1 },
  });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  const shapes = provenCallShapesForSource({ sessionId: session.id, sourceUserSeq: source.seq }, ['dataforseo__api_request']);
  assert.deepEqual(shapes, [{ tool: 'dataforseo__api_request', shape: '{"method":"POST","path":"/v3/dataforseo_labs/google/historical_bulk_traffic_estimation/live","data":[{"targets":["string"],"location_code":"number","language_code":"string"}]}' }]);
  assert.deepEqual(provenCallShapesForSource({ sessionId: session.id, sourceUserSeq: source.seq }, ['other_tool']), [], 'only the learned tools contribute shapes');
});

test('a provider carrier\'s own arguments, serialized once more inside the envelope, still yield the request roles', async () => {
  const shadow = await import('../graph/turn-graph-shadow.js');
  const dispatch = await import('./dispatch-ledger.js');
  const identities = await import('./attempt-identity.js');
  const outcomes = await import('./attempt-outcome.js');
  const store = await import('./logical-call-settlement-store.js');
  const { provenCallShapesForSource } = await import('./host-run-strategy-learning.js');
  const session = createSession({ id: 'carrier-shapes-learning', kind: 'chat' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'find the thread from Dana Lee about the plan' } });
  assert.ok(shadow.recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 } }));
  const task = { sessionId: session.id, sourceUserSeq: source.seq, acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq) };
  const operationArgs = { query: 'Dana Lee', top: 10 };
  const callId = 'call_carrier_shape_1';
  appendEvent({ sessionId: session.id, turn: 1, role: 'assistant', type: 'tool_called', data: {
    sourceUserSeq: source.seq, callId, tool: 'work_call', effectiveTool: 'SAMPLEMAIL_SEARCH_MESSAGES', effect: 'read',
    arguments: JSON.stringify({ requirement_id: 'cap:resolved:samplemail_search_messages', name: 'composio_execute_tool',
      args_json: JSON.stringify({ tool_slug: 'SAMPLEMAIL_SEARCH_MESSAGES', arguments: JSON.stringify(operationArgs) }) }),
  } });
  const started = dispatch.beginPhysicalDispatch({ identity: { ...task, logicalToolCallId: 'lc-carrier-1', physicalDispatchId: 'lc-carrier-1:1', ordinal: 0 }, tool: 'samplemail_search_messages', args: operationArgs });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({ identity: started.identity, tool: 'samplemail_search_messages', outcome: 'returned' }).status, 'inserted');
  const committed = store.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: 'lc-carrier-1' },
    contract: { toolName: 'samplemail_search_messages', args: operationArgs },
    execution: { kind: 'provider_execution' },
    result: { payload: { messages: [] } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'byo', callId, turn: 1 },
  });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  const shapes = provenCallShapesForSource({ sessionId: session.id, sourceUserSeq: source.seq }, ['samplemail_search_messages']);
  assert.deepEqual(shapes, [{ tool: 'samplemail_search_messages', shape: '{"tool_slug":"SAMPLEMAIL_SEARCH_MESSAGES","arguments":{"query":"string","top":"number"}}' }]);
  assert.doesNotMatch(JSON.stringify(shapes), /Dana Lee/, 'the person\'s name is a value, not a role');
});

test('the part each operation played is read from the order and effect of its settled calls', async () => {
  const shadow = await import('../graph/turn-graph-shadow.js');
  const dispatch = await import('./dispatch-ledger.js');
  const identities = await import('./attempt-identity.js');
  const outcomes = await import('./attempt-outcome.js');
  const store = await import('./logical-call-settlement-store.js');
  const { provenStepsForSource } = await import('./host-run-strategy-learning.js');
  const session = createSession({ id: 'steps-learning', kind: 'chat' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'post the digest and confirm it landed' } });
  assert.ok(shadow.recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 } }));
  const task = { sessionId: session.id, sourceUserSeq: source.seq, acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq) };
  const settle = (id: string, tool: string, mutating: boolean, failed = false) => {
    const started = dispatch.beginPhysicalDispatch({ identity: { ...task, logicalToolCallId: id, physicalDispatchId: `${id}:1`, ordinal: 0 }, tool, args: { id } });
    assert.equal(started.status, 'inserted');
    if (started.status !== 'inserted') return;
    assert.equal(dispatch.settlePhysicalDispatch({ identity: started.identity, tool, outcome: 'returned' }).status, 'inserted');
    assert.equal(store.commitLogicalCallSettlement({
      identity: { ...task, logicalToolCallId: id }, contract: { toolName: tool, args: { id } },
      execution: { kind: 'provider_execution' }, result: { payload: { ok: !failed } },
      outcome: outcomes.classifyAttemptOutcome(failed ? { argumentValidationFailed: true } : { envelopeSuccessful: true }),
      recovery: { businessCall: true, mutating }, observer: { lane: 'byo', turn: 1 },
    }).status, 'committed');
  };
  settle('lc-1', 'deskscope__find_channel', false);
  settle('lc-2', 'deskscope__read_channel', false);
  settle('lc-3', 'deskscope__post_message', true, true);   // refused: not a change that happened
  settle('lc-4', 'deskscope__post_message', true);
  settle('lc-5', 'deskscope__read_channel', false);
  const tools = ['deskscope__find_channel', 'deskscope__read_channel', 'deskscope__post_message'];
  assert.deepEqual(provenStepsForSource({ sessionId: session.id, sourceUserSeq: source.seq }, tools), [
    { tool: 'deskscope__find_channel', role: 'prepare' },
    { tool: 'deskscope__read_channel', role: 'prepare' },
    { tool: 'deskscope__post_message', role: 'effect' },
    { tool: 'deskscope__read_channel', role: 'verify' },
  ], 'the same read before and after the change played two parts; a refused change is not a change');
  assert.deepEqual(provenStepsForSource({ sessionId: session.id, sourceUserSeq: source.seq }, ['deskscope__find_channel']), [],
    'with no change among the learned tools there are no parts to tell apart');
});

test('a route found by going around a refusal is not a proven route', () => {
  // Live 2026-10-21: write_file was refused and the edit was finished through
  // the shell; that run must not teach "shell" for the request.
  const session = createSession({ kind: 'chat', channel: 'desktop', title: 'around-a-refusal' });
  const user = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Change the first bullet of the digest file' } });
  appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'guardrail_tripped', data: {
    kind: 'refused_pre_dispatch', sourceUserSeq: user.seq, tool: 'write_file', callId: 'call-1', refusalDetail: 'outside_accepted_scope: …',
  } });
  assert.deepEqual(refusedToolsNotAmongUsed({ sessionId: session.id, sourceUserSeq: user.seq }, ['run_shell_command']), ['write_file']);
  assert.deepEqual(refusedToolsNotAmongUsed({ sessionId: session.id, sourceUserSeq: user.seq }, ['write_file']), ['write_file'],
    'a tool name is not evidence that this refused work was repaired');
  // A refusal of the carrier itself names no tool.
  const other = appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'x' } });
  appendEvent({ sessionId: session.id, turn: 2, role: 'system', type: 'guardrail_tripped', data: {
    kind: 'refused_pre_dispatch', sourceUserSeq: other.seq, tool: 'work_call', callId: 'call-2',
  } });
  assert.deepEqual(refusedToolsNotAmongUsed({ sessionId: session.id, sourceUserSeq: other.seq }, ['run_shell_command']), []);
});

const authority = await import('./accepted-turn-call-authority.js');
const hostBindings = await import('./host-call-capability-binding.js');
const dispatch = await import('./dispatch-ledger.js');
const contracts = await import('./logical-call-contract.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');
const eventlog = await import('./eventlog.js');

let correlationSerial = 0;
function correlationSource(sessionId?: string) {
  const session = sessionId ?? createSession({ id: `strategy-correlation-${++correlationSerial}`, kind: 'chat' }).id;
  const source = appendEvent({ sessionId: session, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Send the final synthetic report to the fixture destination.' } });
  const armed = authority.armHostCallAuthority({ sessionId: session, sourceUserSeq: source.seq,
    catalogRevisionDigest: 'a'.repeat(64), bindingRevisionDigest: 'b'.repeat(64), maxLogicalCalls: 20, maxParallelCalls: 8 });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  if (armed.status !== 'armed') throw new Error('fixture host authority missing');
  const identity = { sessionId: session, sourceUserSeq: source.seq, acceptedTaskId: armed.authority.identity.acceptedTaskId };
  return identity;
}

function correlationCall(task: ReturnType<typeof correlationSource>, input: {
  id: string; args: Record<string, unknown>; refused?: boolean; tool?: string; account?: string;
  bindCapability?: boolean; repairAuthority?: boolean; eventSourceUserSeq?: number;
}) {
  const tool = input.tool ?? 'write_file';
  const effect = input.account ? 'external_write' as const : 'local_write' as const;
  const contract = contracts.durableLogicalCallContract(task.acceptedTaskId, tool, input.args)!;
  const root = authority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error('fixture root missing');
  const identity = { ...task, logicalToolCallId: input.id };
  const base = { ...identity, sourceEventId: root.authority.sourceEventId, sourceEventDigest: root.authority.sourceEventDigest,
    toolName: contract.toolName, argumentDigest: contract.argumentDigest, effect,
    bindingKind: input.account ? 'catalog_manifest' as const : 'local_envelope' as const,
    capabilityId: tool, schemaFingerprint: 'c'.repeat(64), accountId: input.account ?? '', invokePortId: 'fixture:invoke', operationId: tool,
    manifestId: input.account ? 'fixture:manifest' : '', manifestDigest: input.account ? 'd'.repeat(64) : '',
    engineVersion: root.authority.engineVersion, surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest, authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest, catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest! };
  const attestation = { ...base, bindingDigest: hostBindings.hostCallAttestationBindingDigest(base) };
  authority.withHostCallAttestation(attestation, () => {
    assert.equal(dispatch.admitLogicalCall({ identity, tool, args: input.args }).status, 'inserted');
    if (input.bindCapability !== false) {
      const bound = hostBindings.persistHostCallCapabilityBinding({ db: eventlog.openEventLog(), attestation,
        ...identity, toolName: contract.toolName, argumentDigest: contract.argumentDigest, effect });
      assert.equal(bound.status, 'bound', JSON.stringify(bound));
    }
    if (input.repairAuthority) appendEvent({ sessionId: task.sessionId, turn: 1, role: 'assistant', type: 'tool_called', data: {
      sourceUserSeq: input.eventSourceUserSeq ?? task.sourceUserSeq, tool: 'composio_execute_tool',
      effectiveTool: tool, callId: input.id, canonicalCallId: input.id, effect,
      arguments: JSON.stringify({ tool_slug: tool.toUpperCase(), arguments: JSON.stringify(input.args) }),
      recoverySemantics: { version: 1, operationId: tool, manifestDigest: base.manifestDigest,
        basis: 'exact_artifact_reconciliation' },
    } });
    if (!input.refused) {
      const opened = dispatch.beginPhysicalDispatch({ identity: { ...identity, physicalDispatchId: `physical:${input.id}`, ordinal: 0 },
        tool, args: input.args, ...(input.account ? {} : { executionSite: 'host' as const }) });
      assert.equal(opened.status, 'inserted', JSON.stringify(opened));
      if (opened.status !== 'inserted') throw new Error('fixture crossing missing');
      assert.equal(dispatch.settlePhysicalDispatch({ identity: opened.identity, tool, outcome: 'returned' }).status, 'inserted');
    }
    const settled = settlements.commitLogicalCallSettlement({ identity, contract: { toolName: tool, args: input.args },
      execution: { kind: input.refused ? 'refused_pre_dispatch' : input.account ? 'provider_execution' : 'local_execution' },
      ...(input.refused ? {} : { result: { payload: { ok: true, id: 'synthetic-result' } } }),
      outcome: outcomes.classifyAttemptOutcome(input.refused
        ? { preDispatch: true, argumentValidationFailed: true, schemaAvailable: true } : { envelopeSuccessful: true }),
      recovery: { businessCall: true, mutating: true }, observer: { lane: 'byo', callId: input.id, turn: 1 } });
    assert.equal(settled.status, 'committed', JSON.stringify(settled));
  });
}

test('success on A cannot erase a same-tool refusal on B before a shell workaround', () => {
  const task = correlationSource();
  correlationCall(task, { id: 'write-a', args: { path: '/synthetic/a', content: 'A' } });
  correlationCall(task, { id: 'refused-b', args: { path: '/synthetic/b', content: 'B' }, refused: true });
  correlationCall(task, { id: 'shell-b', tool: 'run_shell_command', args: { command: 'synthetic B' } });
  assert.deepEqual(refusedToolsNotAmongUsed(task, ['write_file', 'run_shell_command']), ['write_file']);
  assert.deepEqual(learnHostRunStrategyForAcceptedTask(task), { status: 'not_proven', reason: 'route_found_around_a_refusal:write_file' });
});

test('a later canonical exact-contract repair clears only its own refusal', () => {
  const task = correlationSource(), args = { path: '/synthetic/b', content: 'B' };
  correlationCall(task, { id: 'refused', args, refused: true });
  correlationCall(task, { id: 'repaired', args });
  assert.deepEqual(refusedToolsNotAmongUsed(task, ['write_file']), []);
});

test('an earlier success is not a repair of a later refusal, even with identical arguments', () => {
  const task = correlationSource(), args = { path: '/synthetic/b', content: 'B' };
  correlationCall(task, { id: 'earlier', args });
  correlationCall(task, { id: 'later-refused', args, refused: true });
  assert.deepEqual(refusedToolsNotAmongUsed(task, ['write_file']), ['write_file']);
});

test('another accepted source cannot repair the refused source through a reused call id', () => {
  const task = correlationSource(), args = { path: '/synthetic/b', content: 'B' };
  correlationCall(task, { id: 'shared-call-id', args, refused: true });
  const sibling = correlationSource(task.sessionId);
  correlationCall(sibling, { id: 'shared-call-id', args });
  assert.deepEqual(refusedToolsNotAmongUsed(task, ['write_file']), ['write_file']);
  assert.deepEqual(refusedToolsNotAmongUsed(sibling, ['write_file']), []);
});

test('same arguments on a different capability account do not repair the refused work', () => {
  const task = correlationSource(), args = { destination: 'fixture-target', body: 'Synthetic body' };
  correlationCall(task, { id: 'account-a', tool: 'fixture_send', account: 'fixture-account-a', args, refused: true });
  correlationCall(task, { id: 'account-b', tool: 'fixture_send', account: 'fixture-account-b', args });
  assert.deepEqual(refusedToolsNotAmongUsed(task, ['fixture_send']), ['fixture_send']);
});

test('changed arguments without canonical work and target proof remain unproven', () => {
  const task = correlationSource();
  correlationCall(task, { id: 'bad-format', args: { path: '/synthetic/b', content: 'B', format: 'invalid' }, refused: true });
  correlationCall(task, { id: 'fixed-format', args: { path: '/synthetic/b', content: 'B', format: 'plain' } });
  assert.deepEqual(refusedToolsNotAmongUsed(task, ['write_file']), ['write_file']);
});

test('a missing capability identity cannot be filled in by a later success', () => {
  const task = correlationSource(), args = { path: '/synthetic/b', content: 'B' };
  correlationCall(task, { id: 'unbound-refusal', args, refused: true, bindCapability: false });
  correlationCall(task, { id: 'bound-success', args });
  assert.deepEqual(refusedToolsNotAmongUsed(task, ['write_file']), ['write_file']);
});

for (const variant of ['changed-format', 'different-target', 'different-account', 'foreign-event-source', 'different-cell', 'different-sheet'] as const) {
  test(`coarse host repair semantics cannot prove changed work for learning: ${variant}`, () => {
    const task = correlationSource();
    const common = { tool: 'googlesheets_batch_update', account: 'fixture-account', repairAuthority: true };
    correlationCall(task, { ...common, id: 'bad-range', refused: true,
      args: { spreadsheet_id: 'fixture-sheet', sheet_name: 'Fixture A', first_cell_location: 'A1', format: 'invalid', values: [['Synthetic']] } });
    correlationCall(task, { ...common, id: 'fixed-range',
      ...(variant === 'different-account' ? { account: 'other-account' } : {}),
      ...(variant === 'foreign-event-source' ? { eventSourceUserSeq: task.sourceUserSeq + 1 } : {}),
      args: { spreadsheet_id: variant === 'different-target' ? 'other-sheet' : 'fixture-sheet',
        sheet_name: variant === 'different-sheet' ? 'Fixture B' : 'Fixture A',
        first_cell_location: variant === 'different-cell' ? 'B2' : 'A1', format: 'plain', values: [['Synthetic']] } });
    assert.deepEqual(refusedToolsNotAmongUsed(task, [common.tool]), [common.tool]);
  });
}

test('unavailable refusal evidence suppresses learning instead of becoming no refusals', t => {
  const task = correlationSource();
  correlationCall(task, { id: 'readable-success', args: { path: '/synthetic/a', content: 'A' } });
  const statement = eventlog.openEventLog().prepare('SELECT * FROM events WHERE session_id = ? AND type IN (?,?) ORDER BY seq ASC');
  const prototype = Object.getPrototypeOf(statement), original = prototype.all;
  t.mock.method(prototype, 'all', function (this: { source: string }, ...args: unknown[]) {
    if (this.source === statement.source) throw new Error('synthetic refusal read unavailable');
    return original.apply(this, args);
  });
  assert.deepEqual(learnHostRunStrategyForAcceptedTask(task), { status: 'not_proven', reason: 'refusal_evidence_unavailable' });
});

test('unavailable correlation evidence cannot make a refused route learnable', t => {
  const task = correlationSource(), args = { path: '/synthetic/b', content: 'B' };
  correlationCall(task, { id: 'correlation-refusal', args, refused: true });
  correlationCall(task, { id: 'correlation-success', args });
  const db = eventlog.openEventLog(), original = db.prepare;
  t.mock.method(db, 'prepare', function (sql: string) {
    if (sql.includes('SELECT s.logical_tool_call_id AS logicalToolCallId')) throw new Error('synthetic correlation unavailable');
    return original.call(db, sql);
  });
  assert.deepEqual(learnHostRunStrategyForAcceptedTask(task), { status: 'not_proven', reason: 'refusal_evidence_unavailable' });
});

test('a readable source without refusals does not scan settlement or capability history', t => {
  const task = correlationSource();
  const db = eventlog.openEventLog(), original = db.prepare;
  t.mock.method(db, 'prepare', function (sql: string) {
    assert.doesNotMatch(sql, /logical_call_settlements|host_call_capability_bindings/);
    return original.call(db, sql);
  });
  assert.deepEqual(refusedToolsNotAmongUsed(task, ['write_file']), []);
});
