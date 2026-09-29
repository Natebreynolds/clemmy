/**
 * Run: npx tsx --test src/lib/chat-delegated.test.ts   (from apps/mobile-web)
 *
 * Pins for delegated tasks in a conversation: an ordinary chat asks for
 * nothing, a changed row is a nudge to refetch, and a task's card stays where
 * the work was handed over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldTranscript, reduceActivity, type ActivityItem, type HarnessEvent } from '@clem/chat-engine';
import {
  anyTaskCanMove,
  conversationTasksPollMs,
  delegatedRowsSignature,
  placeDelegatedTasks,
} from './chat-delegated';

const user = (id: string) => ({ id, role: 'user' as const });
const reply = (id: string, rows: Array<{ id: string; status?: string; detail?: string }> = []) => ({
  id, role: 'assistant' as const, activity: rows,
});

test('a conversation that delegated nothing has an empty signature', () => {
  assert.equal(delegatedRowsSignature([]), '');
  assert.equal(delegatedRowsSignature([user('u1'), reply('a1', [{ id: 'model-phase-live', status: 'done' }, { id: 'tool-1', status: 'done' }])]), '');
});

test('the signature changes exactly when a task row changes', () => {
  const working = [user('u1'), reply('a1', [{ id: 'delegated-bg-1', status: 'running', detail: 'Working' }])];
  const same = [user('u1'), reply('a1', [{ id: 'delegated-bg-1', status: 'running', detail: 'Working' }, { id: 'tool-9', status: 'done' }])];
  const finished = [user('u1'), reply('a1', [{ id: 'delegated-bg-1', status: 'done', detail: 'Finished' }])];
  const second = [...working, user('u2'), reply('a2', [{ id: 'delegated-bg-2', status: 'running', detail: 'Handed over, waiting to start' }])];
  assert.notEqual(delegatedRowsSignature(working), '');
  assert.equal(delegatedRowsSignature(working), delegatedRowsSignature(same), 'other activity is not a nudge');
  assert.notEqual(delegatedRowsSignature(working), delegatedRowsSignature(finished));
  assert.notEqual(delegatedRowsSignature(working), delegatedRowsSignature(second));
});

test('the signature reads the rows the shared engine actually folds', () => {
  let activity: ActivityItem[] = [];
  const event = (seq: number, phase: string): HarnessEvent => ({
    seq, id: `e${seq}`, turn: 1, role: 'system', type: 'delegated_task_state', createdAt: seq, sessionId: 's1',
    data: { taskId: 'bg-1', title: 'Draft the weekly briefing', phase, status: phase, contractVersion: 1, agentName: 'Sales Assistant' },
  } as unknown as HarnessEvent);
  activity = reduceActivity(activity, event(1, 'dispatched'), () => 1);
  const dispatched = delegatedRowsSignature([reply('a1', activity)]);
  activity = reduceActivity(activity, event(2, 'finished'), () => 2);
  const finished = delegatedRowsSignature([reply('a1', activity)]);
  assert.match(dispatched, /delegated-bg-1/);
  assert.notEqual(dispatched, finished);
});

test('a reopened transcript carries the row, so the card has a place', () => {
  const events = [
    { seq: 1, id: 'e1', turn: 1, role: 'user', type: 'user_input_received', createdAt: 1, sessionId: 's1', data: { text: 'Draft the briefing' } },
    { seq: 2, id: 'e2', turn: 1, role: 'system', type: 'delegated_task_state', createdAt: 2, sessionId: 's1',
      data: { taskId: 'bg-1', title: 'Draft the weekly briefing', phase: 'dispatched', status: 'pending', contractVersion: 1 } },
    { seq: 3, id: 'e3', turn: 1, role: 'assistant', type: 'conversation_completed', createdAt: 3, sessionId: 's1', data: { text: 'Handed to the Sales Assistant.' } },
  ] as unknown as HarnessEvent[];
  const messages = foldTranscript(events);
  const placed = placeDelegatedTasks(messages, [{ taskId: 'bg-1' }]);
  const owner = messages.find((message) => message.role === 'assistant');
  assert.ok(owner, 'the reply is in the transcript');
  assert.deepEqual(placed.byMessage.get(owner!.id), [{ taskId: 'bg-1' }]);
  assert.deepEqual(placed.unplaced, []);
});

test('a task sits under the first reply that names it and never twice', () => {
  const messages = [
    user('u1'),
    reply('a1', [{ id: 'delegated-bg-1', status: 'running' }, { id: 'delegated-bg-2', status: 'running' }]),
    user('u2'),
    reply('a2', [{ id: 'delegated-bg-1', status: 'done' }]),
  ];
  const placed = placeDelegatedTasks(messages, [{ taskId: 'bg-2' }, { taskId: 'bg-1' }, { taskId: 'bg-1' }, { taskId: 'bg-3' }]);
  assert.deepEqual(placed.byMessage.get('a1'), [{ taskId: 'bg-2' }, { taskId: 'bg-1' }]);
  assert.equal(placed.byMessage.get('a2'), undefined, 'the later mention does not move or repeat the card');
  assert.deepEqual(placed.unplaced, [{ taskId: 'bg-3' }], 'a task no reply on screen names is still shown');
});

test('a row on the owner\'s own message places nothing', () => {
  const messages = [{ id: 'u1', role: 'user' as const, activity: [{ id: 'delegated-bg-1' }] }];
  assert.deepEqual(placeDelegatedTasks(messages, [{ taskId: 'bg-1' }]).unplaced, [{ taskId: 'bg-1' }]);
});

test('the task views are read on a timer only while a task can still move', () => {
  assert.equal(anyTaskCanMove([]), false);
  assert.equal(anyTaskCanMove([{ phase: 'finished' }, { phase: 'stopped' }, { phase: 'failed' }]), false);
  for (const phase of ['waiting_to_start', 'working', 'stopping', 'needs_you', 'paused'] as const) {
    assert.equal(anyTaskCanMove([{ phase: 'finished' }, { phase }]), true, phase);
  }
  assert.ok(conversationTasksPollMs(true) > 0, 'a moving task is read again without the stream');
  assert.equal(conversationTasksPollMs(false), 0, 'nothing moving, nothing polled');
});

test('a correction sits directly after the finished task it follows', () => {
  const messages = [
    user('u1'),
    reply('a1', [{ id: 'delegated-bg-1', status: 'done' }, { id: 'delegated-bg-2', status: 'running' }]),
    user('u2'),
    reply('a2', [{ id: 'delegated-bg-9', status: 'running' }]),
  ];
  const placed = placeDelegatedTasks(messages, [
    { taskId: 'bg-9', followsTaskId: 'bg-1' },
    { taskId: 'bg-2', followsTaskId: null },
    { taskId: 'bg-1' },
    { taskId: 'bg-10', followsTaskId: 'bg-9' },
  ]);
  assert.deepEqual(placed.byMessage.get('a1')?.map((task) => task.taskId), ['bg-2', 'bg-1', 'bg-9', 'bg-10']);
  assert.equal(placed.byMessage.get('a2'), undefined, 'its own later mention does not pull it away');
  assert.deepEqual(placed.unplaced, []);
});

test('a follow-up whose finished task is not here is placed on its own', () => {
  const messages = [user('u1'), reply('a1', [{ id: 'delegated-bg-9', status: 'running' }])];
  const placed = placeDelegatedTasks(messages, [{ taskId: 'bg-9', followsTaskId: 'bg-gone' }, { taskId: 'bg-7', followsTaskId: 'bg-gone' }]);
  assert.deepEqual(placed.byMessage.get('a1')?.map((task) => task.taskId), ['bg-9']);
  assert.deepEqual(placed.unplaced.map((task) => task.taskId), ['bg-7']);
});

test('tasks that claim to follow each other are still each drawn once', () => {
  const placed = placeDelegatedTasks([], [{ taskId: 'a', followsTaskId: 'b' }, { taskId: 'b', followsTaskId: 'a' }]);
  assert.deepEqual(placed.unplaced.map((task) => task.taskId).sort(), ['a', 'b']);
});
