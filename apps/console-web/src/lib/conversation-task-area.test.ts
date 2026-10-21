import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DelegatedTask } from '@clem/chat-engine';
import { conversationTaskGroups, conversationTaskGroupOpen, readConversationTaskExpansion, rememberConversationTaskExpansion, type ConversationTaskExpansion } from './conversation-task-area';

function task(patch: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    taskId: 'task-1', title: 'Prepare the briefing', status: 'running', phase: 'working',
    owner: { agentId: null, agentName: null, chosenBy: null }, project: null,
    requestVersion: 1, revisions: [], correctionPending: false, artifactDestination: null,
    question: null, approvalId: null, resultPreview: null, resultPath: null, error: null,
    originSessionId: 'chat-1', runSessionId: 'background:task-1', followsTaskId: null,
    createdAt: '2026-10-10T09:00:00Z', startedAt: null, completedAt: null, updatedAt: '2026-10-10T09:00:00Z',
    controls: { canSteer: true, canStop: true, canResume: false, canAnswer: false }, ...patch,
  };
}

test('current decisions and unfinished work lead; routine work and finished records stay quiet', () => {
  const rows = [
    task({ taskId: 'complete', phase: 'finished' }),
    task({ taskId: 'working' }),
    task({ taskId: 'stopped', phase: 'stopped' }),
    task({ taskId: 'failed', phase: 'failed' }),
    task({ taskId: 'question', phase: 'needs_you', question: { id: 'q1', text: 'Which period?', options: ['This week'] } }),
  ];
  const groups = conversationTaskGroups(rows);
  assert.deepEqual(groups.map(group => [group.kind, group.tasks.map(row => row.taskId)]), [
    ['decision', ['question']], ['attention', ['failed']], ['background', ['working']], ['finished', ['complete']], ['stopped', ['stopped']],
  ]);
  assert.deepEqual(groups.map(group => conversationTaskGroupOpen(group, {})), [true, true, true, false, false]);
  assert.equal(groups[0].tasks[0], rows[4], 'the actual task and its controls pass through unchanged');
});

test('stale question and approval fields cannot turn a terminal or working task into a decision', () => {
  const cached = { question: { id: 'old', text: 'Earlier question', options: [] }, approvalId: 'old-approval' };
  const groups = conversationTaskGroups([
    task({ ...cached, taskId: 'done', phase: 'finished' }),
    task({ ...cached, taskId: 'working' }),
    task({ taskId: 'dismissed', phase: 'needs_you', question: null, approvalId: null }),
  ]);
  assert.equal(groups.some(group => group.kind === 'decision'), false);
  assert.deepEqual(groups.find(group => group.kind === 'attention')?.tasks.map(row => row.taskId), ['dismissed']);
});

test('a non-answerable current question remains visible without creating permission to answer it', () => {
  const row = task({ phase: 'needs_you', question: { id: 'origin-only', text: 'Which account?', options: [] }, controls: { canSteer: false, canStop: false, canResume: false, canAnswer: false } });
  const [group] = conversationTaskGroups([row]);
  assert.equal(group.kind, 'decision');
  assert.equal(group.defaultOpen, true);
  assert.equal(group.tasks[0].controls.canAnswer, false);
  assert.equal(conversationTaskGroups([task({ phase: 'needs_you', approvalId: 'approval-1' })])[0].kind, 'decision');
});

test('finished with a recorded gap is separate from finished; partial work does not invent missing items', () => {
  const work = { done: 1, total: 2, items: [{ id: 'a', label: 'A', state: 'done' as const }, { id: 'b', label: 'B', state: 'waiting' as const }] };
  const groups = conversationTaskGroups([
    task({ taskId: 'gap', phase: 'finished', work }),
    task({ taskId: 'partial', phase: 'finished', work: { ...work, partial: true } }),
    task({ taskId: 'unknown', phase: 'unrecognized' as DelegatedTask['phase'] }),
  ]);
  assert.deepEqual(groups.find(group => group.kind === 'attention')?.tasks.map(row => row.taskId).sort(), ['gap', 'unknown']);
  assert.deepEqual(groups.find(group => group.kind === 'finished')?.tasks.map(row => row.taskId), ['partial']);
});

test('collapse applies to known decisions, not a new question or approval', () => {
  const row = task({ phase: 'needs_you', question: { id: 'q1', text: 'Which period?', options: [] } });
  const [first] = conversationTaskGroups([row]);
  const preferences: ConversationTaskExpansion = { decision: { open: false, seen: first.attentionKeys } };
  assert.equal(conversationTaskGroupOpen(first, preferences), false);
  const [polled] = conversationTaskGroups([{ ...row, updatedAt: '2026-10-10T10:00:00Z' }]);
  assert.equal(conversationTaskGroupOpen(polled, preferences), false, 'poll timestamps do not reopen it');
  const [replacement] = conversationTaskGroups([{ ...row, question: { ...row.question!, id: 'q2' } }]);
  assert.equal(conversationTaskGroupOpen(replacement, preferences), true);
  const [approval] = conversationTaskGroups([{ ...row, question: null, approvalId: 'approval-2' }]);
  assert.equal(conversationTaskGroupOpen(approval, preferences), true);
});

test('expansion preference belongs to one conversation and does not persist without an identity', () => {
  const preference: ConversationTaskExpansion = { background: { open: true, seen: [] } };
  rememberConversationTaskExpansion('expansion-fixture-a', preference);
  assert.deepEqual(readConversationTaskExpansion('expansion-fixture-a'), preference);
  assert.deepEqual(readConversationTaskExpansion('expansion-fixture-b'), {});
  rememberConversationTaskExpansion(undefined, preference);
  assert.deepEqual(readConversationTaskExpansion(), {});
});

test('no delegated work produces no task area', () => {
  assert.deepEqual(conversationTaskGroups([]), []);
});
