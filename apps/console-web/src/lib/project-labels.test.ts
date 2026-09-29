/**
 * Run: node scripts/run-tests-isolated.mjs apps/console-web/src/lib/project-labels.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelCandidates, labelFor, labelSessionId, labelSessionIds, type SessionProjectLabel } from './project-labels.js';

const label = (sessionId: string, patch: Partial<SessionProjectLabel> = {}): SessionProjectLabel => ({
  sessionId, projectId: 'p1', projectName: 'Weekly Sales', agentName: null, taskId: null, ...patch,
});

test('an item is asked about by the session that asked, and by its task run', () => {
  assert.equal(labelSessionId('harness:console:abc'), 'console:abc');
  assert.equal(labelSessionId('console:abc'), 'console:abc', 'a raw id with a colon is still a raw id');
  assert.equal(labelSessionId(null), '');
  assert.deepEqual(labelCandidates({ sessionId: 'chat-1', taskId: 'bg-1' }), ['chat-1', 'background:bg-1']);
  assert.deepEqual(labelCandidates({ targetSessionId: 'harness:chat-1', sessionId: 'chat-1' }), ['chat-1']);
  assert.deepEqual(labelCandidates({ taskId: 'background:bg-1' }), ['background:bg-1']);
  assert.deepEqual(labelCandidates({}), []);
});

test('one question per screen: each session once, in a stable order', () => {
  const a = labelSessionIds([{ sessionId: 'chat-2' }, { sessionId: 'chat-1', taskId: 'bg-1' }, { targetSessionId: 'chat-2' }, {}]);
  const b = labelSessionIds([{ sessionId: 'chat-1', taskId: 'bg-1' }, { sessionId: 'chat-2' }]);
  assert.deepEqual(a, ['background:bg-1', 'chat-1', 'chat-2']);
  assert.deepEqual(a, b);
  assert.deepEqual(labelSessionIds([]), []);
  assert.equal(labelSessionIds(Array.from({ length: 300 }, (_, i) => ({ sessionId: `s-${i}` }))).length, 200);
});

test('an item in no project has no label; the asking session wins over the task run', () => {
  const labels = new Map([
    ['chat-1', label('chat-1')],
    ['background:bg-1', label('background:bg-1', { projectName: 'Spring Launch', agentName: 'Research', taskId: 'bg-1' })],
  ]);
  assert.equal(labelFor({ sessionId: 'chat-9' }, labels), undefined);
  assert.equal(labelFor({}, labels), undefined);
  assert.equal(labelFor({ sessionId: 'harness:chat-1', taskId: 'bg-1' }, labels)?.projectName, 'Weekly Sales');
  assert.equal(labelFor({ sessionId: 'chat-9', taskId: 'bg-1' }, labels)?.projectName, 'Spring Launch');
  assert.equal(labelFor({ sessionId: 'chat-1' }, new Map()), undefined, 'a failed read labels nothing');
});
