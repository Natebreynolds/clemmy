/**
 * RED: harness-control calls are not work evidence.
 *
 * Focus, recall, memory and execution bookkeeping keep the harness oriented;
 * they never complete anything the user asked for. Today the settlement lane
 * flags every non-discovery call as a business call and the terminal
 * work-evidence query counts ANY settlement row — so one focus_set can flip
 * the "durable work evidence exists" done door and publish a completion that
 * never happened (live 2026-08-11).
 *
 * Invariant: a settled control-role call never manufactures completed work at
 * terminal preparation.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-control-work-evidence-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-control-work-evidence\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const admission = await import('./expected-work-admission.js');
const dispatch = await import('./dispatch-ledger.js');
const attempts = await import('./attempt-settlement.js');
const preparation = await import('./accepted-task-terminal-preparation.js');
const registry = await import('../../tools/tool-registry.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function acceptActivatedAction(text: string) {
  const session = eventlog.createSession({ id: `control-work-evidence-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  const activated = admission.activateActionExpectedWork({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  // Under the unified typed decision a read/ping ask may stop being an act
  // turn; the fixture tolerates that so only the target assertion can fail.
  assert.ok(
    activated.status === 'activated'
    || activated.status === 'replayed'
    || activated.status === 'not_action',
    JSON.stringify(activated),
  );
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

/** Settle one harness-control call exactly the way the shared wrapper does:
 * logical admission, then settleToolAttempt with businessCall computed as
 * "not discovery" (brackets' predicate), local execution, successful result. */
function settleControlCall(task: { sessionId: string; sourceUserSeq: number }): void {
  const toolName = 'focus_set';
  assert.equal(registry.actionTopologyRoleFor(toolName), 'control',
    'fixture uses a registry-control tool');
  const logicalToolCallId = `toolu-control-${serial}`;
  const args = { title: 'Plate check', detail: 'reviewing today' };
  const admitted = dispatch.admitLogicalCall({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq),
      logicalToolCallId,
    },
    tool: toolName,
    args,
  });
  assert.ok(
    admitted.status === 'inserted' || admitted.status === 'replayed',
    JSON.stringify(admitted),
  );
  const settled = attempts.settleToolAttempt({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: 1,
    lane: 'agents_runner',
    toolName,
    callId: logicalToolCallId,
    args,
    mutating: false,
    // brackets.ts: businessCall = (discovery classification == null) — a
    // focus write is not discovery, so the wrapper flags it business today.
    businessCall: true,
    result: { successful: true, data: { focused: true } },
  });
  assert.equal(settled.outcome.kind, 'succeeded', JSON.stringify(settled.outcome));
}

test('a control-only settlement cannot publish done for an action-intent ask', () => {
  const task = acceptActivatedAction('Email alex@example.com the update for every record.');
  settleControlCall(task);
  const prepared = preparation.prepareAcceptedTaskTerminal({
    ...task,
    proposedReply: 'Done.',
  });
  assert.equal(
    prepared.status,
    'needs_verification',
    'one focus_set bookkeeping call is not completed work — a zero-business-work '
    + 'action claim must keep its verification gap: '
    + JSON.stringify(prepared),
  );
});

test('a control-only settlement never becomes the "durable work evidence" done fact on a read ask', () => {
  const task = acceptActivatedAction("what's on my plate today?");
  settleControlCall(task);
  const prepared = preparation.prepareAcceptedTaskTerminal({
    ...task,
    proposedReply: 'Done — synced your plate.',
  });
  // The turn may publish (a read ask can legitimately end in conversation) or
  // hold — but its verdict must never CLAIM durable work evidence when the
  // only settlement is harness bookkeeping.
  assert.doesNotMatch(
    prepared.status === 'ready' ? prepared.verdict.facts.join('; ') : '',
    /durable work evidence/,
    'harness bookkeeping (focus_set) stood in for completed work: '
    + JSON.stringify(prepared),
  );
});
