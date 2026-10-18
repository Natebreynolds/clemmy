import assert from 'node:assert/strict';
import test from 'node:test';
import { taskHandlingSource } from './task-handling-source.js';

const acceptedSource = { sessionId: 'controlled-conversation', sourceUserSeq: 101, turn: 0 };
test('a settled reply keeps its exact source when a later task exists in the same conversation', () => {
  const older = { role: 'assistant' as const, status: 'complete', acceptedSource };
  const newer = { ...older, acceptedSource: { ...acceptedSource, sourceUserSeq: 205 } };
  assert.deepEqual(taskHandlingSource(older, acceptedSource.sessionId), { sessionId: acceptedSource.sessionId, sourceUserSeq: 101 });
  assert.deepEqual(taskHandlingSource(newer, acceptedSource.sessionId), { sessionId: acceptedSource.sessionId, sourceUserSeq: 205 });
  assert.deepEqual(taskHandlingSource({ ...older, status: 'stopped' }), taskHandlingSource(older));
  assert.deepEqual(taskHandlingSource({ ...older, status: 'failed' }), taskHandlingSource(older));
});

test('legacy, foreign, live and progress messages cannot borrow a task explanation', () => {
  const message = { role: 'assistant' as const, status: 'complete', acceptedSource };
  assert.equal(taskHandlingSource({ role: 'assistant', status: 'complete' }), null);
  assert.equal(taskHandlingSource(message, 'different-conversation'), null);
  assert.equal(taskHandlingSource({ ...message, role: 'user' }), null);
  assert.equal(taskHandlingSource({ ...message, checkIn: true }), null);
  for (const status of ['thinking', 'awaiting-approval', 'awaiting-reply', 'awaiting-plan', undefined]) {
    assert.equal(taskHandlingSource({ ...message, status }), null);
  }
  for (const sourceUserSeq of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(taskHandlingSource({ ...message, acceptedSource: { ...acceptedSource, sourceUserSeq } }), null);
  }
});
