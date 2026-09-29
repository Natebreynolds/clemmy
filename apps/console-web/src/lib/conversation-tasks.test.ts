/**
 * Run: node scripts/run-tests-isolated.mjs apps/console-web/src/lib/conversation-tasks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delegatedTaskIds, reportInThread, reportOwner, threadTaskCards } from './conversation-tasks.js';
import type { DelegatedTask } from './projects.js';

function task(patch: Partial<DelegatedTask>): DelegatedTask {
  return {
    taskId: 'bg-1', title: 'Draft the weekly briefing', status: 'running', phase: 'working',
    owner: { agentId: 'sales-assistant', agentName: 'Sales Assistant', chosenBy: 'owner' },
    project: { id: 'p1', name: 'Weekly Sales' },
    requestVersion: 1, revisions: [], correctionPending: false, artifactDestination: null,
    question: null, approvalId: null, resultPreview: null, resultPath: null, error: null,
    originSessionId: 'chat-1', runSessionId: 'background:bg-1', followsTaskId: null,
    createdAt: '2026-09-29T09:00:00.000Z', startedAt: null, completedAt: null, updatedAt: '2026-09-29T09:00:00.000Z',
    controls: { canSteer: true, canStop: true, canResume: false, canAnswer: false },
    ...patch,
  };
}

test('a thread shows what is still open, and what ended while it was being watched', () => {
  const tasks = [
    task({ taskId: 'ended-before', phase: 'finished', updatedAt: '2026-09-29T08:00:00.000Z' }),
    task({ taskId: 'running', phase: 'working', updatedAt: '2026-09-29T09:00:00.000Z' }),
    task({ taskId: 'ended-watching', phase: 'finished', updatedAt: '2026-09-29T10:00:00.000Z' }),
    task({ taskId: 'asking', phase: 'needs_you', updatedAt: '2026-09-29T07:00:00.000Z' }),
  ];
  assert.deepEqual(threadTaskCards(tasks, new Set(['ended-watching'])).map((row) => row.taskId), ['asking', 'running', 'ended-watching']);
  assert.deepEqual(threadTaskCards(tasks, new Set()).map((row) => row.taskId), ['asking', 'running']);
  assert.deepEqual(threadTaskCards([], new Set(['ended-watching'])), [], 'a conversation that delegated nothing draws nothing');
});

test('a report-back is spoken by the agent that owned the task; Clem keeps her own', () => {
  const tasks = [task({ taskId: 'bg-1' }), task({ taskId: 'bg-2', owner: { agentId: null, agentName: null, chosenBy: null } })];
  assert.equal(reportOwner({ id: 'm1', taskRef: { id: 'bg-1' } }, tasks), 'Sales Assistant');
  assert.equal(reportOwner({ id: 'm2', taskRef: { id: 'bg-2' } }, tasks), undefined);
  assert.equal(reportOwner({ id: 'm3', taskRef: { id: 'bg-9' } }, tasks), undefined, 'a task this conversation did not delegate');
  assert.equal(reportOwner({ id: 'm4' }, tasks), undefined);
});

test('the live strip is replaced only for tasks this conversation delegated, and a report is not repeated', () => {
  const ids = delegatedTaskIds([task({ taskId: 'bg-1' })]);
  assert.equal(ids.has('bg-1'), true);
  assert.equal(ids.has('bg-2'), false);
  assert.equal(reportInThread('bg-1', [{ id: 'm1' }, { id: 'm2', taskRef: { id: 'bg-1' } }]), true);
  assert.equal(reportInThread('bg-1', [{ id: 'm1', delegated: { taskId: 'bg-1' } }]), false);
});
