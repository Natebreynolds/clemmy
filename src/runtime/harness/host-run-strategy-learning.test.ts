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
const { learnHostRunStrategyForAcceptedTask, selectLearnedStrategyTools } = await import('./host-run-strategy-learning.js');
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
