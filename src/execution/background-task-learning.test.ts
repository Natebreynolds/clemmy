import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-background-learning-'));
process.env.CLEMENTINE_HOME = home;
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');
const { readTurnLearningPolicyForSource } = await import('../memory/turn-learning-policy.js');
const { backgroundTaskLearningSource } = await import('./background-task-learning.js');
after(() => { resetEventLog(); rmSync(home, { recursive: true, force: true }); });

test('a background handoff keeps the excluded original after an ordinary sibling is accepted', () => {
  const session = createSession({ id: 'fixture-background-policy', kind: 'chat' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Controlled task.', learningPolicy: { version: 1, mode: 'exclude', reason: 'controlled_test' } } });
  const sibling = appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Ordinary next task.' } });
  const frozen = { originSessionId: session.id, foregroundHandoff: { sessionId: session.id, sourceUserSeq: source.seq,
    attemptId: 'fixture-attempt', throughSeq: source.seq } };
  const inherited = backgroundTaskLearningSource(frozen)!;
  assert.equal(readTurnLearningPolicyForSource(inherited).status, 'excluded');
  assert.equal(readTurnLearningPolicyForSource({ sessionId: session.id, sourceUserSeq: sibling.seq }).status, 'allowed');
  const child = createSession({ id: 'fixture-background-policy-child', kind: 'agent' });
  const childSource = appendEvent({ sessionId: child.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Host background directive.', learningPolicySource: inherited } });
  assert.equal(readTurnLearningPolicyForSource({ sessionId: child.id, sourceUserSeq: childSource.seq }).status, 'excluded');
});

test('incomplete/conflicting background ancestry stays unavailable without stopping standalone work', () => {
  assert.equal(backgroundTaskLearningSource({}), undefined);
  const missing = backgroundTaskLearningSource({ originSessionId: 'fixture-origin-without-source' })!;
  assert.equal(readTurnLearningPolicyForSource(missing).status, 'unavailable');
  const conflict = backgroundTaskLearningSource({ originSessionId: 'fixture-other', foregroundHandoff: {
    sessionId: 'fixture-origin', sourceUserSeq: 1, attemptId: 'fixture-attempt', throughSeq: 1 } })!;
  assert.equal(readTurnLearningPolicyForSource(conflict).status, 'unavailable');
  for (const raw of [
    { originSessionId: 'fixture-origin', foregroundHandoff: null },
    { originSessionId: 'fixture-origin', foregroundHandoff: 'corrupt' },
    { originSessionId: 42 },
    { delegation: null },
    { originSessionId: 'fixture-origin', delegation: { originSourceUserSeq: '1' } },
  ]) {
    const unknown = backgroundTaskLearningSource(raw as never)!;
    assert.ok(unknown);
    assert.equal(readTurnLearningPolicyForSource(unknown).status, 'unavailable');
  }
});
