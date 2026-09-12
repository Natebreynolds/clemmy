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

function staged(id: { sessionId: string; sourceUserSeq: number }, identifier = 'FIXTURE_OP') {
  eventlog.appendEvent({
    sessionId: id.sessionId, turn: 1, role: 'system', type: 'capability_resolution',
    data: { sourceUserSeq: id.sourceUserSeq, entries: [{ kind: 'composio', identifier, status: 'proven' }] },
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
  // Quiet resets on GENUINELY new evidence. A turn that keeps reaching toolkits
  // it did not have is working, not stalling, and must be left alone however
  // long it runs. Each staging below is a DISTINCT toolkit — that is what
  // "still learning" means; re-proving one she already holds is covered by the
  // churn test below.
  const working = planTurn();
  readReceipt(working);
  staged(working, 'FIRSTKIT_OP');
  for (let i = 0; i < 6; i += 1) {
    quietCall(working, 8);
    staged(working, `KIT${i}_OP`); // a toolkit she did not have: the window resets
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

test('the steer carries its own evidence window — the call site, not just the helper', async () => {
  // THE BUG THIS PINS. recordTurnSteer took an OPTIONAL window and the only
  // call site never passed it, so the first live firing (2026-09-12 04:48:41)
  // recorded {kind, steer, sourceUserSeq} and nothing else — the one event
  // whose purpose was tuning the threshold carried no threshold data.
  //
  // The original test passed anyway because it called recordTurnSteer directly
  // WITH a window. It pinned the function and not the connection, which is the
  // same mistake in miniature.
  const stalled = planTurn();
  readReceipt(stalled);
  staged(stalled);
  quietCall(stalled, 20);

  const due = nextTurnSteer(stalled);
  assert.ok(due, 'the stall shape is recognised');
  // The detector hands the window OUT, so a caller cannot forget to compute it.
  assert.ok(due!.window, 'the steer carries its own evidence');
  assert.equal(due!.window.reads, 1);
  assert.equal(due!.window.staged, 1);
  assert.equal(due!.window.quietCalls, 20);

  // And the runner's call edge passes it through.
  const { readFileSync } = await import('node:fs');
  const runner = readFileSync(new URL('./host-turn-runner.ts', import.meta.url), 'utf8');
  assert.match(runner, /recordTurnSteer\(identity, due\.kind, due\.window\)/,
    'the only call site must record the window it was given');
});

test('re-proving a toolkit she already holds is churn, not evidence', async () => {
  // THE SHAPE THAT DEFEATED THE FIRST VERSION. Live 2026-09-12 05:29-05:32:
  // six near-identical DataForSEO searches in three minutes, three of them
  // byte-for-byte repeats, against NINE DataForSEO operations already proven.
  // Every one staged fresh capability rows; every one reset the quiet window to
  // zero. The steer could never fire while she circled a single toolkit, and
  // the turn was cancelled at 16 minutes with no plan.
  //
  // A toolkit already held is not a discovery.
  const circling = planTurn();
  readReceipt(circling);
  staged(circling, 'DATAFORSEO_FIRST_OP');   // genuine: a new toolkit
  for (let i = 0; i < 6; i += 1) {
    quietCall(circling, 3);
    staged(circling, `DATAFORSEO_VARIANT_${i}`); // churn: same toolkit again
  }
  const due = nextTurnSteer(circling);
  assert.ok(due, 'circling one toolkit must reach the window, not reset it forever');
  assert.equal(due!.window.staged, 1, 'nine DataForSEO rows are ONE toolkit of knowledge');
  assert.ok(due!.window.quietCalls >= 12, `churn keeps counting: got ${due!.window.quietCalls}`);

  // And a genuinely NEW toolkit still resets it — breadth she did not have is
  // real progress and must never be mistaken for circling.
  const widening = planTurn();
  readReceipt(widening);
  staged(widening, 'DATAFORSEO_OP');
  quietCall(widening, 10);
  staged(widening, 'APIFY_RUN_ACTOR');   // new toolkit: this IS news
  quietCall(widening, 5);
  assert.equal(nextTurnSteer(widening), null,
    'she just learned a toolkit she did not have — that is progress, not a stall');
  assert.equal(nextTurnSteer({ ...widening }), null);

  quietCall(widening, 12);
  const later = nextTurnSteer(widening);
  assert.ok(later, 'once the new toolkit stops producing, the window closes normally');
  assert.equal(later!.window.staged, 2, 'two distinct toolkits held');
});
