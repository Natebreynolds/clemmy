/**
 * RED — workflow-controller sessions at the delivery committer's `done` gate.
 *
 * Run: npx tsx --test src/runtime/harness/delivery-committer-workflow-settlement-truth.red.test.ts
 *
 * Invariant under pin: a terminal `done` may not be published for an accepted
 * source whose own durable settlement ledger contradicts it. A session owned by
 * a workflow controller is currently exempted from act expected-work
 * (kind === 'workflow' → actionExpectedWorkState 'not_action' → terminal
 * preparation 'unstaged' → the committer publishes `done` unchanged), so a step
 * whose ONLY settled logical call is `unsupported_capability` — or whose only
 * logical call is still OPEN — still commits a clean `done` presentation.
 *
 * These tests fail until workflow sessions get accepted-task/evidence ownership
 * or an equivalent audited contract at this boundary (no blanket exemption).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-committer-workflow-truth-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-committer-workflow-truth\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
type TurnOutcome = import('./turn-outcome.js').TurnOutcome;

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

/** A workflow-controller step session with one accepted source, exactly like
 * runStepViaHarness mints it (session kind 'workflow', accepted user event,
 * persisted turn graph with the workflow surface). */
function acceptWorkflowStepSource(label: string) {
  serial += 1;
  const sessionId = `workflow:red-truth-run-${serial}:${label}`;
  eventlog.createSession({ id: sessionId, kind: 'workflow', title: `step ${label}` });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Workflow step ${label}: send the account update to the team.` },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: source.seq, turn: 1 },
    surface: 'workflow',
  }), 'fixture precondition: the step source has its persisted turn graph');
  return {
    sessionId,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(sessionId, source.seq),
  };
}

function doneOutcome(task: ReturnType<typeof acceptWorkflowStepSource>, text: string): TurnOutcome {
  const identity = { sessionId: task.sessionId, turn: task.turn, sourceUserSeq: task.sourceUserSeq };
  return {
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text },
  };
}

test('a workflow session whose only settlement is unsupported_capability cannot publish done', () => {
  const task = acceptWorkflowStepSource('send_update');
  const logicalToolCallId = `logical:workflow-truth:${serial}`;
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId,
      physicalDispatchId: `dispatch:workflow-truth:${serial}`,
      ordinal: 0,
    },
    tool: 'alpha_send_update',
    args: { channel: 'team-updates' },
  });
  assert.equal(begun.status, 'inserted', `fixture precondition: ${JSON.stringify(begun)}`);
  if (begun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: 'alpha_send_update',
    outcome: 'returned',
  }).status, 'inserted', 'fixture precondition: the paid crossing settles');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName: 'alpha_send_update', args: { channel: 'team-updates' } },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: false, error: 'this operation is not implemented' } },
    // http 501 → 'unsupported_capability' via the structured classifier.
    outcome: outcomes.classifyAttemptOutcome({ httpStatus: 501 }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', `fixture precondition: ${JSON.stringify(settled)}`);

  // FIXTURE PROOF — the durable runtime truth for this source says unsupported.
  const row = eventlog.openEventLog().prepare(`
    SELECT state, outcome_kind FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as { state: string; outcome_kind: string };
  assert.deepEqual(row, { state: 'settled', outcome_kind: 'unsupported_capability' });

  const committed = commitTurnOutcome(doneOutcome(task, 'Update sent to the team.'));

  // TARGET — the committed presentation may not say done while the source's own
  // settlement ledger says the one attempted call was unsupported.
  assert.notEqual(
    committed.presentation.status,
    'done',
    'a workflow-controller session published a clean done terminal while its only '
    + 'logical settlement is unsupported_capability — the workflow exemption lets the '
    + 'caller boolean outrank runtime truth (blanket kind===workflow exemption)',
  );
});

test('a workflow session with an OPEN logical call cannot publish done', () => {
  const task = acceptWorkflowStepSource('sync_records');
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId: `logical:workflow-open:${serial}`,
      physicalDispatchId: `dispatch:workflow-open:${serial}`,
      ordinal: 0,
    },
    tool: 'alpha_records_sync',
    args: { query: 'all' },
  });
  assert.equal(begun.status, 'inserted', `fixture precondition: ${JSON.stringify(begun)}`);

  // FIXTURE PROOF — an in-flight paid crossing: logical call open, dispatch started.
  const open = eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ? AND state = 'open') AS openCalls,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ? AND state = 'started') AS startedDispatches
  `).get(task.sessionId, task.sourceUserSeq, task.sessionId, task.sourceUserSeq) as {
    openCalls: number;
    startedDispatches: number;
  };
  assert.deepEqual(open, { openCalls: 1, startedDispatches: 1 });

  const committed = commitTurnOutcome(doneOutcome(task, 'All records are synced.'));

  // TARGET — zero open calls/dispatches is a terminal precondition; publishing
  // done over an in-flight crossing erases the only restart handle for it.
  assert.notEqual(
    committed.presentation.status,
    'done',
    'a workflow-controller session published done while a logical call is still OPEN '
    + '(physical dispatch state started) — the terminal must reconcile open work first',
  );
});
