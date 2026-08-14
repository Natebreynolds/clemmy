/**
 * Run: npx tsx --test src/runtime/harness/sibling-mutator-admission.red.test.ts
 *
 * INVARIANT — no sibling mutator until a dispatched mutation's fate is known.
 *
 * Once a mutating call under a frozen work contract has crossed the provider
 * boundary, a DIFFERENT tool may not be admitted for the same requirement
 * until the first dispatch is reconciled (or its settlement proves the work
 * done). A clean top-level provider ack whose deeper content is merely
 * uninspectable is not license to search for a sibling: today the bounded
 * envelope inspector calls the uninspectable ack contradicted, the settlement
 * rewrites the acknowledged send to ignored_requirement
 * (eliminates_candidate=1, requires_reconciliation=0), and the admission gate
 * then authorizes a second mutator for work that already landed — the exact
 * duplicate-send shape (live class, 2026-08-11).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-sibling-mutator-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-sibling-mutator\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const admissionModule = await import('./expected-work-admission.js');
const dispatch = await import('./dispatch-ledger.js');
const settlement = await import('./attempt-settlement.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

/** One contracted external send — the smallest mutating action topology. */
const ASK = 'Send the weekly follow-up message to the growth team Slack channel.';
const CARRIER_TOOL = 'composio_execute_tool';
const FIRST_SEND_ARGS = {
  tool_slug: 'SLACK_SEND_MESSAGE',
  arguments: { channel: 'C0925AL', text: 'Weekly follow-up: pipeline is on track.' },
};
const SIBLING_SEND_ARGS = {
  tool_slug: 'GMAIL_SEND_EMAIL',
  arguments: { to: 'growth-team@example.com', subject: 'Weekly follow-up', body: 'Pipeline is on track.' },
};

function proposal() {
  return {
    version: 1 as const,
    operations: [{
      id: 'send_update',
      effect: 'external_write' as const,
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' as const },
    }],
    universes: [],
  };
}

let serial = 0;

function acceptAction(label: string) {
  const id = ++serial;
  const session = eventlog.createSession({ id: `sibling-mutator-${label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }), 'fixture graph persisted');
  const activated = admissionModule.activateActionExpectedWork(task);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  return {
    ...task,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    label: `${label}-${id}`,
  };
}

function openCall(task: ReturnType<typeof acceptAction>, suffix: string, args: unknown): string {
  const logicalToolCallId = `logical:${task.label}:${suffix}`;
  const opened = dispatch.admitLogicalCall({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: task.turn,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId,
    },
    tool: CARRIER_TOOL,
    args,
  });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  return logicalToolCallId;
}

function bindFirstSend(task: ReturnType<typeof acceptAction>): string {
  const logicalToolCallId = openCall(task, 'first-send', FIRST_SEND_ARGS);
  const bound = admissionModule.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId,
    proposal: proposal(),
    requirementId: 'send_update',
    tool: CARRIER_TOOL,
    args: FIRST_SEND_ARGS,
  });
  assert.equal(bound.status, 'bound', JSON.stringify(bound));
  return logicalToolCallId;
}

function dispatchAndSettle(
  task: ReturnType<typeof acceptAction>,
  logicalToolCallId: string,
  result: unknown,
) {
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId,
      physicalDispatchId: `dispatch:${logicalToolCallId}`,
      ordinal: 0,
    },
    tool: CARRIER_TOOL,
    args: FIRST_SEND_ARGS,
  });
  assert.equal(started.status, 'inserted', JSON.stringify(started));
  if (started.status !== 'inserted') throw new Error('mutation fixture was not admitted');
  // The dispatch ledger stores the normalized INNER identity for a wrapped
  // carrier; the crossing settles under the name the ledger actually stored,
  // exactly as the production lanes do.
  const stored = eventlog.openEventLog().prepare(`
    SELECT tool_name FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
  `).get(
    task.sessionId,
    task.sourceUserSeq,
    started.identity.physicalDispatchId,
  ) as { tool_name: string } | undefined;
  assert.ok(stored, 'fixture crossing stored');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool: stored!.tool_name,
    outcome: 'returned',
  }).status, 'inserted', 'fixture crossing returned');
  return settlement.settleToolAttempt({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    lane: 'composio',
    toolName: CARRIER_TOOL,
    callId: logicalToolCallId,
    args: FIRST_SEND_ARGS,
    businessCall: true,
    mutating: true,
    result,
  });
}

function admitSibling(task: ReturnType<typeof acceptAction>) {
  const logicalToolCallId = openCall(task, 'sibling-send', SIBLING_SEND_ARGS);
  return admissionModule.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId,
    proposal: null,
    requirementId: 'send_update',
    tool: CARRIER_TOOL,
    args: SIBLING_SEND_ARGS,
  });
}

/**
 * A clean Slack-like send ack with block-kit nesting deeper than the 8-level
 * inspection bound. Bulk sits under `data.message.blocks` deliberately — the
 * inspector's result-array skip list spares `data.messages`/`records`/`items`,
 * so those keys would never reach the bound. Every inspectable field is clean.
 */
function deepCleanSendAck(): unknown {
  let block: Record<string, unknown> = { type: 'mrkdwn', text: 'Weekly follow-up: pipeline is on track.' };
  for (let i = 0; i < 9; i += 1) block = { type: 'rich_text_section', elements: [block] };
  return {
    successful: true,
    error: null,
    data: {
      ok: true,
      channel: 'C0925AL',
      ts: '1754899123.000200',
      message: { text: 'Weekly follow-up: pipeline is on track.', blocks: [block] },
    },
  };
}

test('a dispatched cleanly-acked mutation admits no sibling mutator for the same requirement', () => {
  const task = acceptAction('acked');
  const firstCall = bindFirstSend(task);
  const settled = dispatchAndSettle(task, firstCall, deepCleanSendAck());
  assert.ok(settled.outcome.kind, 'fixture: the first send settled durably');

  const sibling = admitSibling(task);
  // TARGET: today the rewritten ignored_requirement (eliminates_candidate=1,
  // requires_reconciliation=0) authorizes this different-tool admission and a
  // second mutator runs against work the provider already acknowledged. The
  // sibling must not be BOUND: either the requirement is already satisfied by
  // the acknowledged send, or admission is refused pending reconciliation.
  assert.notEqual(
    sibling.status,
    'bound',
    `a sibling mutator was admitted for an already-dispatched acknowledged send: ${JSON.stringify(sibling)}`,
  );
});

test('GUARD: an unacknowledged dispatched mutation blocks sibling admission until reconciliation', () => {
  const task = acceptAction('uncertain');
  const firstCall = bindFirstSend(task);
  // A returned failure on a dispatched mutation proves nothing about the
  // effect: the write may have landed. This settles uncertain_write.
  const settled = dispatchAndSettle(task, firstCall, { successful: false, error: 'internal_error' });
  assert.equal(settled.outcome.kind, 'uncertain_write', JSON.stringify(settled.outcome));

  const sibling = admitSibling(task);
  assert.equal(sibling.status, 'refused', JSON.stringify(sibling));
  if (sibling.status === 'refused') {
    assert.match(sibling.reason, /reconcil/i, 'the refusal routes through reconcile-first');
  }
});
