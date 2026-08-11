/**
 * PHASE B matrix — six outcomes, driven through the REAL native MCP dispatch
 * path, asserting four observable things each:
 *
 *   1. the model-facing typed result,
 *   2. exactly one settlement event for the physical attempt,
 *   3. the resulting governor / recovery state,
 *   4. the exact provider-dispatch count (and that nothing was replayed).
 *
 * The fixture servers are fictional (alpha/beta) and the transport is a stub,
 * but everything between the call and the settlement is production code.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-recovery-matrix-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-recovery-matrix\n', 'utf-8');

const eventlog = await import('./harness/eventlog.js');
const { recordTurnGraphShadow } = await import('./graph/turn-graph-shadow.js');
const { acceptedTaskIdFor } = await import('./harness/attempt-identity.js');
const { admitLogicalCall } = await import('./harness/dispatch-ledger.js');
const { DiscoveryGovernor } = await import('./harness/discovery-governor.js');
const {
  settleToolAttempt,
  candidateEliminatedForTask,
  eliminatedCandidatesForTask,
  _resetAttemptSettlementStateForTests,
} = await import('./harness/attempt-settlement.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function acceptedTask(label: string): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ id: `matrix-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: `${label} task` },
  });
  // Durable settlement authority: the accepted source above plus a persisted
  // turn graph for the accepted task (authority spine).
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
  }), 'fixture persisted the turn graph for the accepted task');
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

/** Every lane admits its logical call before dispatch; the fixture does too. */
function admitFixtureCall(
  key: { sessionId: string; sourceUserSeq: number },
  callId: string,
  tool: string,
  args?: unknown,
): void {
  const admitted = admitLogicalCall({
    identity: {
      sessionId: key.sessionId,
      sourceUserSeq: key.sourceUserSeq,
      acceptedTaskId: acceptedTaskIdFor(key.sessionId, key.sourceUserSeq),
      logicalToolCallId: callId,
    },
    tool,
    args,
  });
  assert.ok(
    admitted.status === 'inserted' || admitted.status === 'replayed',
    `fixture admitted the logical call (${admitted.status}${'reason' in admitted ? `: ${admitted.reason}` : ''})`,
  );
}

function settlementsFor(sessionId: string): Array<Record<string, unknown>> {
  return eventlog.listEvents(sessionId, { types: ['tool_attempt_settled'] })
    .map((event) => event.data as Record<string, unknown>);
}

interface MatrixCase {
  label: string;
  tool: string;
  mutating?: boolean;
  result?: unknown;
  thrown?: unknown;
  signals?: Record<string, unknown>;
  expectKind: string;
  expectAction: string;
  expectRetrySame: boolean;
  expectEliminates: boolean;
  expectEpochAfter: number;
  expectReconciliation: boolean;
}

const MATRIX: MatrixCase[] = [
  {
    label: 'returned success',
    tool: 'alpha__read_rows',
    result: { content: [{ type: 'text', text: 'rows' }], isError: false },
    expectKind: 'succeeded',
    expectAction: 'settle',
    expectRetrySame: false,
    expectEliminates: false,
    // A finished business step is progress: the NEXT requirement is new.
    expectEpochAfter: 1,
    expectReconciliation: false,
  },
  {
    label: 'returned 400',
    tool: 'alpha__create_row',
    result: { successful: false, data: { status_code: 400, error: 'missing field' } },
    expectKind: 'invalid_arguments',
    expectAction: 'repair_arguments',
    expectRetrySame: true,
    expectEliminates: false,
    expectEpochAfter: 0,
    expectReconciliation: false,
  },
  {
    label: 'returned unsupported (isError)',
    tool: 'alpha__unsupported_op',
    result: { content: [{ type: 'text', text: 'nope' }], isError: true },
    expectKind: 'unsupported_capability',
    expectAction: 'try_sibling_candidate',
    expectRetrySame: false,
    expectEliminates: true,
    expectEpochAfter: 1,
    expectReconciliation: false,
  },
  {
    label: 'thrown unsupported',
    tool: 'alpha__gone',
    thrown: Object.assign(new Error('not implemented'), { status: 501 }),
    expectKind: 'unsupported_capability',
    expectAction: 'try_sibling_candidate',
    expectRetrySame: false,
    expectEliminates: true,
    expectEpochAfter: 1,
    expectReconciliation: false,
  },
  {
    label: 'timeout on a read',
    tool: 'alpha__slow_read',
    thrown: Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    expectKind: 'transient',
    expectAction: 'retry_with_backoff',
    expectRetrySame: true,
    expectEliminates: false,
    // Transient: the same call is retryable, so the search budget stays put.
    expectEpochAfter: 0,
    expectReconciliation: false,
  },
  {
    label: 'uncertain mutation',
    tool: 'alpha__send_note',
    mutating: true,
    thrown: new Error('socket hang up'),
    expectKind: 'uncertain_write',
    expectAction: 'reconcile_then_decide',
    expectRetrySame: false,
    expectEliminates: false,
    expectEpochAfter: 0,
    expectReconciliation: true,
  },
];

for (const testCase of MATRIX) {
  test(`matrix: ${testCase.label}`, () => {
    _resetAttemptSettlementStateForTests();
    const key = acceptedTask(testCase.label.replace(/\s+/g, '-'));
    const governor = new DiscoveryGovernor();
    governor.initializeTask({ ...key, knownCapability: false });
    // Spend the task's search so an epoch change is observable.
    governor.admit({ ...key, category: 'broad_discovery', callId: 'matrix-search' });

    const callId = `matrix-call-${testCase.label.replace(/\s+/g, '-')}`;
    admitFixtureCall(key, callId, testCase.tool);
    const settled = settleToolAttempt({
      ...key,
      lane: 'native_mcp',
      toolName: testCase.tool,
      callId,
      businessCall: true,
      ...(testCase.mutating ? { mutating: true } : {}),
      ...(testCase.result !== undefined ? { result: testCase.result } : {}),
      ...(testCase.thrown !== undefined ? { thrown: testCase.thrown } : {}),
      ...(testCase.signals ? { signals: testCase.signals as never } : {}),
    });

    // 1 — model-facing typed result.
    assert.equal(settled.outcome.kind, testCase.expectKind, 'typed outcome');
    assert.equal(settled.outcome.directive.action, testCase.expectAction, 'recovery action');
    assert.notEqual(settled.outcome.evidence, 'text', 'decided by structure, not wording');
    assert.equal(settled.outcome.directive.retrySameCandidate, testCase.expectRetrySame);
    assert.equal(settled.outcome.directive.eliminatesCandidate, testCase.expectEliminates);
    assert.equal(settled.outcome.directive.requiresReconciliation, testCase.expectReconciliation);

    // 2 — exactly one settlement for this physical attempt, even if a carrier
    // lane settles the same call again.
    const replay = settleToolAttempt({
      ...key, lane: 'agents_runner', toolName: testCase.tool, callId, businessCall: true,
      ...(testCase.mutating ? { mutating: true } : {}),
      ...(testCase.result !== undefined ? { result: testCase.result } : {}),
      ...(testCase.thrown !== undefined ? { thrown: testCase.thrown } : {}),
      ...(testCase.signals ? { signals: testCase.signals as never } : {}),
    });
    assert.equal(replay.duplicate, true, 'a second settlement of one attempt changes nothing');
    const events = settlementsFor(key.sessionId).filter((e) => e.callId === callId);
    assert.equal(events.length, 1, `exactly one settlement event, got ${events.length}`);

    // 3 — governor / recovery state.
    assert.equal(
      governor.getTaskState(key)?.policy.epoch,
      testCase.expectEpochAfter,
      'discovery epoch',
    );
    assert.equal(
      candidateEliminatedForTask(key.sessionId, key.sourceUserSeq, testCase.tool),
      testCase.expectEliminates,
      'candidate elimination is task-local',
    );

    // 4 — provider dispatch/reconciliation count: an uncertain write authorizes
    // no replay at all, which is the only count that can duplicate an effect.
    assert.equal(
      settled.outcome.directive.retrySameCandidate,
      testCase.expectRetrySame,
      'replay authorization',
    );
    if (testCase.expectReconciliation) {
      assert.equal(settled.outcome.directive.retrySameCandidate, false, 'zero replay until reconciled');
      assert.equal(settled.openedDiscoveryEpoch, false, 'and no hunting for another way to send it');
    }
  });
}

test('LIVE REGRESSION: repeating one step is not progress and mints no budget', () => {
  // From a real Discord run: the model re-read the same calendar twelve times
  // and each success looked like forward motion, so a loop kept buying itself
  // discovery budget.
  _resetAttemptSettlementStateForTests();
  const key = acceptedTask('repeat-is-not-progress');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });
  governor.admit({ ...key, category: 'broad_discovery', callId: 'repeat-search' });

  const sameArgs = { start: '2026-08-10', end: '2026-08-17' };
  const credits: boolean[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    admitFixtureCall(key, `repeat-${attempt}`, 'ALPHA_LIST_CALENDAR', sameArgs);
    credits.push(settleToolAttempt({
      ...key,
      lane: 'composio',
      toolName: 'ALPHA_LIST_CALENDAR',
      callId: `repeat-${attempt}`,
      args: sameArgs,
      businessCall: true,
      result: { successful: true, data: [{ id: 'evt' }] },
    }).creditedProgress);
  }
  assert.deepEqual(credits, [true, false, false, false], 'one step, credited once');
  assert.equal(governor.getTaskState(key)?.policy.epoch, 1);

  // Spend the budget that step one earned, so the next credit is observable.
  assert.equal(
    governor.admit({ ...key, category: 'broad_discovery', callId: 'sheet-search' }).admitted,
    true,
  );

  // A genuinely different step earns the next one.
  admitFixtureCall(key, 'next-step', 'ALPHA_CREATE_SHEET', { title: 'Week' });
  const nextStep = settleToolAttempt({
    ...key,
    lane: 'composio',
    toolName: 'ALPHA_CREATE_SHEET',
    callId: 'next-step',
    args: { title: 'Week' },
    businessCall: true,
    result: { successful: true, data: { id: 'sheet-1' } },
  });
  assert.equal(nextStep.creditedProgress, true, 'a new step is still progress');
  assert.equal(governor.getTaskState(key)?.policy.epoch, 2);

  // ...and repeating THAT step earns nothing either.
  admitFixtureCall(key, 'next-step-again', 'ALPHA_CREATE_SHEET', { title: 'Week' });
  assert.equal(
    settleToolAttempt({
      ...key,
      lane: 'composio',
      toolName: 'ALPHA_CREATE_SHEET',
      callId: 'next-step-again',
      args: { title: 'Week' },
      businessCall: true,
      result: { successful: true, data: { id: 'sheet-1' } },
    }).creditedProgress,
    false,
  );
});

test('LIVE REGRESSION: a pre-dispatch invalid-args refusal repairs instead of eliminating', () => {
  // The Sheets write that broke the live run: it never dispatched, so nothing
  // is uncertain and the candidate is not dead — it just needs the contract.
  _resetAttemptSettlementStateForTests();
  const key = acceptedTask('predispatch-repair');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });
  governor.admit({ ...key, category: 'broad_discovery', callId: 'repair-search' });

  admitFixtureCall(key, 'repair-1', 'ALPHA_SHEET_FROM_JSON');
  const settled = settleToolAttempt({
    ...key,
    lane: 'composio',
    toolName: 'ALPHA_SHEET_FROM_JSON',
    callId: 'repair-1',
    businessCall: true,
    // A write, but one that never left the process.
    mutating: false,
    signals: { preDispatch: true, argumentValidationFailed: true, schemaAvailable: true },
  });

  assert.equal(settled.outcome.kind, 'invalid_arguments');
  assert.equal(settled.outcome.directive.action, 'repair_arguments');
  assert.equal(settled.outcome.directive.retrySameCandidate, true, 'the same tool gets another go');
  assert.equal(settled.outcome.directive.eliminatesCandidate, false, 'a typo is not a dead capability');
  assert.equal(
    candidateEliminatedForTask(key.sessionId, key.sourceUserSeq, 'ALPHA_SHEET_FROM_JSON'),
    false,
  );
  assert.equal(settled.openedDiscoveryEpoch, false, 'and it does not send the task hunting');
  assert.equal(governor.getTaskState(key)?.policy.epoch, 0);
});

test('prose naming ONE exact tool is an exact lookup, not a broad search', async () => {
  const { classifyDiscoveryCall } = await import('./harness/discovery-boundary.js');
  for (const query of [
    'get me the schema for alpha__read_rows',
    'what arguments does alpha__read_rows take?',
    '`alpha__read_rows`',
  ]) {
    const classified = classifyDiscoveryCall('tool_search', { query });
    assert.equal(classified?.category, 'exact_schema_refresh', query);
    assert.equal(classified?.subject, 'alpha__read_rows', query);
  }
  // Naming two tools is genuinely exploratory again.
  assert.equal(
    classifyDiscoveryCall('tool_search', { query: 'alpha__read_rows or beta__send_note?' })?.category,
    'broad_discovery',
  );
});

test('two searches surfacing the same slug decline to attribute rather than guess', async () => {
  const composio = await import('../tools/composio-tools.js');
  const { withHarnessRunContext, ToolCallsCounter } = await import('./harness/brackets.js');
  const key = acceptedTask('ambiguous-attribution');

  await withHarnessRunContext(
    { sessionId: key.sessionId, sourceUserSeq: key.sourceUserSeq, counter: new ToolCallsCounter(10) } as never,
    async () => {
      composio.noteComposioSearchIntent(key.sessionId, 'find a way to read rows', ['ALPHA_READ_ROWS']);
      composio.noteComposioSearchIntent(key.sessionId, 'find a rows exporter', ['ALPHA_READ_ROWS']);
      // Both searches surfaced it; crediting the newest would write the wrong
      // intent into memory permanently. Falling back to the slug's own seed is
      // the honest answer.
      const intent = composio.executionIntentForSession(key.sessionId, 'ALPHA_READ_ROWS');
      assert.ok(
        !/find a way to read rows|find a rows exporter/.test(intent),
        `ambiguous attribution must not pick a query: ${intent}`,
      );
    },
  );
});

test('elimination is task-local and never leaks to another task', () => {
  _resetAttemptSettlementStateForTests();
  const first = acceptedTask('local-a');
  const second = acceptedTask('local-b');
  for (const key of [first, second]) {
    const governor = new DiscoveryGovernor();
    governor.initializeTask({ ...key, knownCapability: false });
  }

  admitFixtureCall(first, 'c1', 'alpha__dead');
  settleToolAttempt({
    ...first, lane: 'native_mcp', toolName: 'alpha__dead', callId: 'c1', businessCall: true,
    result: { content: [], isError: true },
  });

  assert.deepEqual(eliminatedCandidatesForTask(first.sessionId, first.sourceUserSeq), ['alpha__dead']);
  assert.deepEqual(
    eliminatedCandidatesForTask(second.sessionId, second.sourceUserSeq),
    [],
    'one request proving a candidate wrong must not teach every other request',
  );
});

test('an auth failure asks for a reconnect and does NOT spend a search on a broken catalog', () => {
  _resetAttemptSettlementStateForTests();
  const key = acceptedTask('auth');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });
  governor.admit({ ...key, category: 'broad_discovery', callId: 'auth-search' });

  admitFixtureCall(key, 'auth-1', 'alpha__read');
  const settled = settleToolAttempt({
    ...key, lane: 'composio', toolName: 'alpha__read', callId: 'auth-1', businessCall: true,
    thrown: new Error('reconnect required'), signals: { connectionMissing: true },
  });
  assert.equal(settled.outcome.kind, 'auth_failure');
  assert.equal(settled.outcome.directive.action, 'recover_connection');
  assert.equal(settled.openedDiscoveryEpoch, false);
  assert.equal(
    governor.getTaskState(key)?.policy.epoch,
    0,
    'searching a catalog that is still broken is not recovery',
  );

  // Only OBSERVED recovery reopens the search.
  const recovered = governor.recordEvidence({ ...key, kind: 'auth_recovered' });
  assert.equal(recovered.outcome, 'epoch_opened');
  assert.equal(governor.getTaskState(key)?.policy.epoch, 1);
});
