/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-post-turn npx tsx --test src/runtime/harness/post-turn.test.ts
 *
 * Pins the cross-process recall-run sweep (2026-07-31): the Claude Agent SDK
 * lane's memory tools run in a separate MCP process, so their recall-run ids
 * never reach the lane's in-memory context — before the sweep, every explicit
 * tool recall in that lane earned zero utility credit. The seam now recovers
 * this turn's runs from the shared DB by (session_id, created_at).
 */
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-post-turn';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { resetMemoryDb } = await import('../../memory/db.js');
const { getFact, rememberFact } = await import('../../memory/facts.js');
const { recordRecallRun } = await import('../../memory/recall-usage.js');
const { runPostTurnHooks } = await import('./post-turn.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetMemoryDb(); });

test('a run recorded in another process is swept and credited when the turn provably used it', () => {
  const fact = rememberFact({ kind: 'project', content: 'The Harbor renewal owner is the northeast ops lead.' });
  // TIME-RELATIVE fixtures (2026-08-07): these were hardcoded to 2026-07-31 and
  // the suite went red the day those runs' `expires_at` elapsed — the sweep
  // requires a LIVE run (`expires_at > now`), so a frozen fixture date is a
  // time bomb that fails long after the code it guards last changed.
  const turnStartedAt = new Date(Date.now() - 60_000).toISOString();
  // Simulates the MCP tool process: session-stamped in the shared DB, but its
  // id is NOT handed to the lane (recallIds below stays empty).
  recordRecallRun({
    objective: 'who owns the Harbor renewal?',
    surface: 'memory_search_facts',
    answerability: 'partial',
    candidateRefs: [{ type: 'fact', id: String(fact.id), snippet: fact.content }],
    sessionId: 'sess-sweep',
    nowIso: new Date(Date.now() - 55_000).toISOString(),
  });

  runPostTurnHooks({
    sessionId: 'sess-sweep',
    turn: 0,
    userInput: 'who owns the Harbor renewal?',
    detectCorrection: false,
    recallIds: [],
    replyText: `Per [fact:${fact.id}], the northeast ops lead owns it.`,
    turnStartedAt,
  });
  assert.equal(getFact(fact.id)?.utilityCount, 1, 'the swept run credits exactly like a lane-passed one');
});

test('the sweep never reaches runs from before the turn or other sessions', () => {
  const fact = rememberFact({ kind: 'project', content: 'The Harbor renewal owner is the northeast ops lead.' });
  // Both fixtures stay LIVE (unexpired) so this test proves the sweep's real
  // boundaries — before-the-turn and other-session — instead of passing
  // vacuously because the rows aged out (which is what the frozen 2026-07-31
  // dates had started doing).
  recordRecallRun({
    objective: 'stale run', surface: 'memory_search_facts', answerability: 'partial',
    candidateRefs: [{ type: 'fact', id: String(fact.id), snippet: fact.content }],
    sessionId: 'sess-sweep', nowIso: new Date(Date.now() - 3 * 60_000).toISOString(),
  });
  recordRecallRun({
    objective: 'other session', surface: 'memory_search_facts', answerability: 'partial',
    candidateRefs: [{ type: 'fact', id: String(fact.id), snippet: fact.content }],
    sessionId: 'sess-other', nowIso: new Date(Date.now() - 55_000).toISOString(),
  });

  runPostTurnHooks({
    sessionId: 'sess-sweep',
    turn: 0,
    userInput: 'who owns the Harbor renewal?',
    detectCorrection: false,
    recallIds: [],
    replyText: `Per [fact:${fact.id}], the northeast ops lead owns it.`,
    turnStartedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  });
  assert.equal(getFact(fact.id)?.utilityCount, 0, 'pre-turn and cross-session runs stay out of this turn\'s credit');
});
