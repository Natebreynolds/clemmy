/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/turn-steer.test.ts
 *
 * The mid-turn steer channel. Live 2026-09-11,
 * sess-desktop-e61923acbde9196a013a147c: a Plan turn read the owner's document
 * at 54 seconds, had its capability refs staged by minute one, then spent
 * THIRTY-TWO MORE MINUTES re-reading what it already held — 56
 * `recall_tool_result` calls against 4 distinct searches and one business read
 * for the whole turn. It published a real plan at minute 33.
 *
 * Plan mode's own instruction already told it to bind what it ALREADY has and
 * publish or ask rather than gather. That instruction is correct and arrives at
 * turn start, thousands of tokens before the moment it applies. The measured
 * difference this session: a static tool description saying "CALL THIS FIRST"
 * earned 3 calls against 813 searches, while the same kind of sentence placed
 * in a tool RESULT was followed on its first live run.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-turn-steer-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const eventlog = await import('./eventlog.js');
const {
  nextTurnSteer, recordTurnSteer, appendSteerToResultText, PUBLISH_OR_ASK_STEER,
} = await import('./turn-steer.js');

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** A Plan turn, unless another mode is asked for. */
function planTurn(kind: string | null = 'plan') {
  const session = eventlog.createSession({ kind: 'chat', userId: 'fixture-owner' });
  const event = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: {
      text: 'Read this doc and build me a research plan',
      ...(kind ? { taskMode: { version: 1, kind } } : {}),
    },
  });
  return { sessionId: session.id, sourceUserSeq: event.seq };
}

function readReceipt(id: { sessionId: string; sourceUserSeq: number }) {
  eventlog.appendEvent({
    sessionId: id.sessionId, turn: 1, role: 'system', type: 'read_receipt',
    data: { sourceUserSeq: id.sourceUserSeq, record: { effectClass: 'read', identifier: 'FIXTURE_READ' } },
  });
}

function staged(id: { sessionId: string; sourceUserSeq: number }) {
  eventlog.appendEvent({
    sessionId: id.sessionId, turn: 1, role: 'system', type: 'capability_resolution',
    data: { sourceUserSeq: id.sourceUserSeq, entries: [{ kind: 'composio', identifier: 'FIXTURE_OP', status: 'proven' }] },
  });
}

/** A settled top-level call that added nothing — the recall churn shape. */
function quietCall(id: { sessionId: string; sourceUserSeq: number }, n = 1) {
  for (let i = 0; i < n; i += 1) {
    eventlog.appendEvent({
      sessionId: id.sessionId, turn: 1, role: 'system', type: 'tool_returned',
      data: { sourceUserSeq: id.sourceUserSeq, accounting: 'top_level', effectiveTool: 'recall_tool_result' },
    });
  }
}

test('the steer fires only after the inputs are read AND the capabilities are staged', async () => {
  // Gathering is the RIGHT move until both preconditions hold. A host that
  // interrupts before then is telling her to publish a plan she cannot write.
  const bare = planTurn();
  quietCall(bare, 40);
  assert.equal(nextTurnSteer(bare), null, 'churn alone is not the condition — nothing has been read yet');

  const readOnly = planTurn();
  readReceipt(readOnly);
  quietCall(readOnly, 40);
  assert.equal(nextTurnSteer(readOnly), null, 'read the doc but hold no capabilities: still gathering legitimately');

  const stagedOnly = planTurn();
  staged(stagedOnly);
  quietCall(stagedOnly, 40);
  assert.equal(nextTurnSteer(stagedOnly), null, 'capabilities without the named input is not the live shape');

  // Both preconditions, and enough quiet frames to prove nothing new is landing.
  const stalled = planTurn();
  readReceipt(stalled);
  staged(stalled);
  quietCall(stalled, 40);
  const due = nextTurnSteer(stalled);
  assert.ok(due, 'the measured stall shape must be recognised');
  assert.equal(due!.kind, 'publish_or_ask');
  assert.equal(due!.text, PUBLISH_OR_ASK_STEER);
});

test('a turn that is still learning is never interrupted', async () => {
  // Quiet resets on new evidence. A turn alternating real reads with recalls is
  // working, not stalling, and must be left alone however long it runs.
  const working = planTurn();
  readReceipt(working);
  staged(working);
  for (let i = 0; i < 6; i += 1) {
    quietCall(working, 8);
    staged(working); // new capability lands: the window resets
  }
  assert.equal(nextTurnSteer(working), null,
    'evidence kept arriving — this turn is converging and must not be steered');

  // One more quiet stretch with nothing new, and now it qualifies.
  quietCall(working, 40);
  assert.ok(nextTurnSteer(working), 'once the evidence genuinely stops, the host speaks');
});

test('once the plan exists there is nothing to steer toward', async () => {
  const published = planTurn();
  readReceipt(published);
  staged(published);
  quietCall(published, 40);
  eventlog.appendEvent({
    sessionId: published.sessionId, turn: 1, role: 'system', type: 'tool_returned',
    data: { sourceUserSeq: published.sourceUserSeq, accounting: 'top_level', effectiveTool: 'publish_plan' },
  });
  quietCall(published, 40);
  assert.equal(nextTurnSteer(published), null,
    'a published plan means the procedure terminated; saying "publish" now is noise');
});

test('it speaks once per source — a repeated nudge is how the static instruction lost', async () => {
  const stalled = planTurn();
  readReceipt(stalled);
  staged(stalled);
  quietCall(stalled, 40);

  const first = nextTurnSteer(stalled);
  assert.ok(first);
  recordTurnSteer(stalled, first!.kind, { reads: 1, staged: 1, quietCalls: 40 });

  quietCall(stalled, 40);
  assert.equal(nextTurnSteer(stalled), null,
    'delivered once; repeating every frame trains the model to skip it');

  // And it is OBSERVABLE. Every behaviour this session that could not be seen
  // in the ledger cost hours to diagnose.
  const recorded = eventlog.listEvents(stalled.sessionId, { types: ['guardrail_tripped'] })
    .filter((event) => event.data.kind === 'turn_steer');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.data.steer, 'publish_or_ask');
  assert.equal(recorded[0]!.data.sourceUserSeq, stalled.sourceUserSeq);
  assert.equal(recorded[0]!.data.quietCalls, 40);
});

test('scope: Plan turns only, and a missing mode is not a Plan turn', async () => {
  for (const kind of ['act', null]) {
    const other = planTurn(kind as string | null);
    readReceipt(other);
    staged(other);
    quietCall(other, 40);
    assert.equal(nextTurnSteer(other), null,
      `mode ${String(kind)} has its own terminal shape and deserves its own measured condition`);
  }
});

test('the steer carries guidance and explicitly no authority', async () => {
  // It redirects attention. It must never read as permission — every gate in
  // the system still runs, and the text has to say so.
  assert.match(PUBLISH_OR_ASK_STEER, /approves nothing|binds no account|every gate still applies/i);
  assert.match(PUBLISH_OR_ASK_STEER, /publish/i);
  assert.match(PUBLISH_OR_ASK_STEER, /ask the user/i);
  // It is not a clock: no elapsed-time language, per the owner's standing
  // direction that pace is user-facing only.
  assert.doesNotMatch(PUBLISH_OR_ASK_STEER, /minute|second|time limit|too long|hurry|deadline/i);
});

test('appending never disturbs the result it rides on', async () => {
  assert.equal(appendSteerToResultText('rows: 3', 'STEER'), 'rows: 3\n\nSTEER');
  assert.equal(appendSteerToResultText('', 'STEER'), 'STEER', 'an empty result still carries the steer');
  // The original text survives byte-for-byte as the prefix; a model parsing the
  // result must find exactly what the tool returned.
  const body = '{"ok":true,"rows":[1,2,3]}';
  assert.ok(appendSteerToResultText(body, 'STEER').startsWith(body));
});

test('a broken ledger degrades to silence, never to a failed turn', async () => {
  assert.equal(nextTurnSteer({ sessionId: '', sourceUserSeq: 1 }), null);
  assert.equal(nextTurnSteer({ sessionId: 'no-such-session', sourceUserSeq: 5 }), null);
  assert.equal(nextTurnSteer({ sessionId: 'x', sourceUserSeq: 0 }), null);
  assert.equal(nextTurnSteer({ sessionId: 'x', sourceUserSeq: -3 }), null);
  // Recording against a dead session must also not throw.
  recordTurnSteer({ sessionId: 'no-such-session', sourceUserSeq: 5 }, 'publish_or_ask');
});
