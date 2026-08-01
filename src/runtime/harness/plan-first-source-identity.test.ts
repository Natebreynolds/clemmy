import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-plan-first-source-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { appendEvent, createSession, listEvents } = await import('./eventlog.js');
const { commitPlanFirstOutcome, runPlanFirstPreflight } = await import('./plan-first.js');

test.after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('a newer unrelated user row cannot steal a plan-first terminal', () => {
  const sessionId = 'plan-first-exact-source';
  createSession({ id: sessionId, kind: 'chat' });
  const accepted = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Draft me a plan first for the accepted request.' },
  });
  const unrelated = appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'A newer unrelated message.' },
  });

  commitPlanFirstOutcome({
    sessionId,
    sourceUserSeq: accepted.seq,
    text: 'Which destination should the plan use?',
    status: 'needs_input',
    reason: 'plan_first_needs_input',
  });

  const terminal = listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.ok(terminal);
  assert.equal(terminal.turn, accepted.turn, 'terminal turn comes from the exact durable source row');
  assert.equal(terminal.data.sourceUserSeq, accepted.seq);
  assert.equal(terminal.data.terminalKey, `turn:${accepted.seq}`);
  assert.notEqual(terminal.data.sourceUserSeq, unrelated.seq);
});

test('reuseRecordedUserInput fails before planning when its exact source is absent or foreign', async () => {
  const sessionId = 'plan-first-reuse-source';
  const otherSessionId = 'plan-first-reuse-source-other';
  createSession({ id: sessionId, kind: 'chat' });
  createSession({ id: otherSessionId, kind: 'chat' });
  const foreign = appendEvent({
    sessionId: otherSessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Foreign accepted input.' },
  });
  const base = {
    input: 'Draft me a plan first before you do anything.',
    sessionId,
    freshSession: true,
    force: true,
    reuseRecordedUserInput: true,
  } as const;

  await assert.rejects(
    runPlanFirstPreflight({ ...base }),
    /requires the exact sourceUserSeq/i,
  );
  await assert.rejects(
    runPlanFirstPreflight({ ...base, sourceUserSeq: foreign.seq }),
    /was not found in this session/i,
  );
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
});
