/**
 * Run: npx tsx --test src/lib/inbox-projects.test.ts   (from apps/mobile-web)
 *
 * Pins for labelling what waits on the owner by project: one request names
 * every session once, a task's own run outranks the conversation it was
 * asked from, and a row in no project is left exactly as it was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalSessions,
  inboxLabelSessions,
  indexProjectLabels,
  notificationSessions,
  projectNameFor,
  questionSessions,
} from './inbox-projects';

const label = (sessionId: string, projectName: string, taskId: string | null = null, agentName: string | null = null) => ({
  sessionId, projectId: `prj-${projectName}`, projectName, agentName, taskId,
});

test('one request names every session once', () => {
  const sessions = inboxLabelSessions({
    questions: [{ sessionId: 'sess-1', taskId: 'bg-1' }, { sessionId: 'sess-1', taskId: null }, { sessionId: null, taskId: null }],
    approvals: [{ sessionId: 'background:bg-1' }, { sessionId: 'sess-2' }, { sessionId: '  ' }],
    notifications: [{ context: { sessionId: 'sess-2', runSessionId: 'background:bg-7' } }, { context: {} }],
  });
  assert.deepEqual(sessions, ['background:bg-1', 'sess-1', 'sess-2', 'background:bg-7']);
  assert.deepEqual(inboxLabelSessions({}), []);
});

test('an id that would break the list is left out, and the list is bounded', () => {
  assert.deepEqual(inboxLabelSessions({ approvals: [{ sessionId: 'a,b' }, { sessionId: 'ok' }] }), ['ok']);
  const many = Array.from({ length: 300 }, (_, i) => ({ sessionId: `s-${i}` }));
  assert.equal(inboxLabelSessions({ approvals: many }).length, 200);
});

test('a task question is labelled by the project its work is for', () => {
  const labels = indexProjectLabels([label('sess-1', 'Board Prep'), label('background:bg-1', 'Weekly Sales', 'bg-1')]);
  const asked = { sessionId: 'sess-1', taskId: 'bg-1' };
  assert.equal(projectNameFor(asked, questionSessions(asked), labels), 'Weekly Sales');
  const plain = { sessionId: 'sess-1', taskId: null };
  assert.equal(projectNameFor(plain, questionSessions(plain), labels), 'Board Prep');
});

test('a run outranks the conversation for a notification too', () => {
  const labels = indexProjectLabels([label('sess-1', 'Board Prep'), label('background:bg-1', 'Weekly Sales')]);
  const row = { context: { sessionId: 'sess-1', runSessionId: 'background:bg-1' } };
  assert.equal(projectNameFor({}, notificationSessions(row), labels), 'Weekly Sales');
});

test('a row in no project, or with the lookup unread, has no label', () => {
  const labels = indexProjectLabels([label('sess-1', 'Board Prep')]);
  const row = { sessionId: 'sess-9' };
  assert.equal(projectNameFor(row, approvalSessions(row), labels), null);
  assert.equal(projectNameFor(row, approvalSessions(row), null), null);
  assert.equal(projectNameFor({ sessionId: 'sess-1' }, approvalSessions({ sessionId: 'sess-1' }), indexProjectLabels(null)), null);
});

test('what the row itself says is believed first', () => {
  const labels = indexProjectLabels([label('sess-1', 'Board Prep')]);
  const row = { sessionId: 'sess-1', projectName: ' Weekly Sales ' };
  assert.equal(projectNameFor(row, approvalSessions(row), labels), 'Weekly Sales');
});

test('an answer with unusable rows labels only the usable ones', () => {
  const index = indexProjectLabels([
    label('sess-1', 'Board Prep'),
    label('sess-1', 'Second answer for the same session'),
    label('sess-2', '   '),
    { sessionId: 'sess-3' } as never,
  ]);
  assert.deepEqual([...index.keys()], ['sess-1']);
  assert.equal(index.get('sess-1')?.projectName, 'Board Prep');
});

test('the chip names the agent too when one is on the work, in the shared words', () => {
  const labels = indexProjectLabels([label('background:bg-1', 'Weekly Sales', 'bg-1', 'Sales Assistant')]);
  const asked = { sessionId: 'sess-1', taskId: 'bg-1' };
  assert.equal(projectNameFor(asked, questionSessions(asked), labels), 'Weekly Sales · Sales Assistant');
});
