/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/binderless-engine-conversation-arming.test.ts
 *
 * Arm only what the lane can discharge. Typed expected-work requirements are
 * discharged only by a binder that writes call bindings: the interactive host
 * engine's carrier admission, or the typed construct run behind a
 * participated source. A binder-less engine settles every call without ever
 * writing a binding, so a binding-requiring deterministic contract armed
 * there matched "no observed operation is bound" and held delivered work
 * forever (live 2026-08-25: workflow …09b41f held with 2 ops / 0 bindings;
 * the conversation-shaped control …55e374 delivered with 0 ops).
 *
 * The pin: a binder-less session arms conversation-shaped and its settled
 * work finalizes; a bindable engine and a participated source keep the full
 * binding demand byte-identically.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-binderless-arming-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-binderless-arming\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./expected-work-contract.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const resolution = await import('./resolution-ledger.js');
const disposition = await import('../semantic-boundary/semantic-disposition.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

/** The exact live shape: act + collect-then-construct compiles a deterministic
 * contract of one complete_set read and one external write — operations that
 * can only be discharged through explicit call bindings. */
const BINDING_REQUIRING_TEXT =
  'Find the top 5 widgets based on ratings and add them to a new workbook for me.';

interface Task {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
}

function accept(kind: 'chat' | 'workflow', participation?: 'participated'): Task {
  const session = eventlog.createSession({ id: `binderless-arming-${kind}-${++serial}`, kind });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: BINDING_REQUIRING_TEXT },
  });
  if (participation) {
    disposition.recordSemanticParticipation(session.id, source.seq, participation);
  }
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

/** One settled unbound business read — the lane's real work: it settles
 * per-call, and no binding row is ever written. */
function settleUnboundRead(task: Task): void {
  const logicalToolCallId = `logical:read:${serial}`;
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId,
      physicalDispatchId: `dispatch:read:${serial}`,
      ordinal: 0,
    },
    tool: 'alpha_records_search',
    args: {},
  });
  assert.equal(begun.status, 'inserted');
  if (begun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: 'alpha_records_search',
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName: 'alpha_records_search', args: {} },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: true, data: { records: [{ id: 'a' }] }, meta: { complete: true } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
}

test('a binder-less engine arms conversation-shaped and settled work finalizes', () => {
  const task = accept('workflow');
  const expected = resolution.expectedTaskFor(task.sessionId, task.sourceUserSeq);
  assert.equal(expected.status, 'ok', JSON.stringify(expected).slice(0, 200));
  if (expected.status !== 'ok') return;
  assert.equal(expected.graph.classification.route, 'act');
  assert.equal(expected.graph.classification.multiItem.collectThenConstruct, true);
  assert.equal(
    expected.expectation.workKind,
    'conversation',
    'no binder runs for this engine, so no typed work node may be projected into authority',
  );
  assert.equal(expected.expectation.workNodeId, undefined);

  const frozen = contracts.requireKnownExpectedWorkContract(task);
  assert.equal(frozen.status, 'bound');
  settleUnboundRead(task);
  const finalized = resolution.finalizeResolutionAgainstExpectedWork(task);
  assert.equal(
    finalized.status,
    'finalized',
    `settled work must not hold on bindings no writer exists for: ${JSON.stringify(finalized).slice(0, 300)}`,
  );
  const frozenState = resolution.frozenResolutionFor(task.sessionId, task.sourceUserSeq);
  assert.equal(frozenState.status, 'ok', JSON.stringify(frozenState).slice(0, 300));
  assert.equal(
    frozenState.status === 'ok' && frozenState.resolution.expectationsSatisfied,
    true,
    'the frozen verdict must recompute byte-for-byte from durable rows',
  );
});

test('the interactive engine keeps the full binding-requiring contract (chat byte-identical)', () => {
  const task = accept('chat');
  const expected = resolution.expectedTaskFor(task.sessionId, task.sourceUserSeq);
  assert.equal(expected.status, 'ok');
  if (expected.status !== 'ok') return;
  assert.notEqual(expected.expectation.workKind, 'conversation');
  assert.ok(expected.expectation.workNodeId);

  const frozen = contracts.requireKnownExpectedWorkContract(task);
  assert.equal(frozen.status, 'bound');
  assert.equal(frozen.status === 'bound' && frozen.contract.operations.length, 2);
  settleUnboundRead(task);
  const finalized = resolution.finalizeResolutionAgainstExpectedWork(task);
  assert.equal(finalized.status, 'incomplete', 'a bindable lane keeps the binding demand');
  assert.ok(
    finalized.status === 'incomplete'
      && finalized.match.gaps.some((gap) => gap.kind === 'requirement_unobserved'),
    'the unbound write requirement stays owed where a binder can discharge it',
  );
});

test('a participated source keeps the demand even on a non-interactive session', () => {
  // Capability, not surface name: participation means the typed construct
  // run — a real binding writer — owns discharge, so the demand stands.
  const task = accept('workflow', 'participated');
  const expected = resolution.expectedTaskFor(task.sessionId, task.sourceUserSeq);
  assert.equal(expected.status, 'ok');
  if (expected.status !== 'ok') return;
  assert.notEqual(expected.expectation.workKind, 'conversation');

  const frozen = contracts.requireKnownExpectedWorkContract(task);
  assert.equal(frozen.status, 'bound');
  settleUnboundRead(task);
  assert.equal(resolution.finalizeResolutionAgainstExpectedWork(task).status, 'incomplete');
});
