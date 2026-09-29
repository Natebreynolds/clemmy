/**
 * Run: npx tsx --test src/lib/project-detail.test.ts   (from apps/mobile-web)
 *
 * Pins for the project screen's layout: a decision is drawn once, an approval
 * asked inside a conversation never gets a button, and the work list holds
 * only what is not already drawn above it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DelegatedTaskPhase } from '@clem/chat-engine';
import { assignableAgents, bindableApps, layoutProjectWork } from './project-detail';

const task = (
  taskId: string,
  phase: DelegatedTaskPhase,
  updatedAt: string,
  extra: { controls?: { canAnswer: boolean }; question?: unknown } = {},
) => ({
  taskId, phase, updatedAt, controls: { canAnswer: false }, question: null as unknown, ...extra,
});
const asking = (taskId: string, updatedAt: string) => task(taskId, 'needs_you', updatedAt, {
  controls: { canAnswer: true }, question: { id: `q-${taskId}`, text: 'Which quarter?', options: [] },
});
const question = (taskId: string | null) => ({ kind: 'question' as const, taskId, approvalId: null, questionId: `q-${taskId}`, askedAt: '2026-09-29T10:00:00Z' });
const approval = (approvalId: string | null, taskId: string | null = null, formal?: boolean, sessionId = 'sess-1') => ({
  kind: 'approval' as const, taskId, approvalId, questionId: null, askedAt: '2026-09-29T10:00:00Z', sessionId,
  detail: approvalId ?? 'Reply to the customer about the renewal date?',
  ...(formal === undefined ? {} : { formal }),
});

test('a question is drawn once, as its task card, and leaves the work list', () => {
  const tasks = [task('t1', 'working', '2026-09-29T09:00:00Z'), asking('t2', '2026-09-29T10:00:00Z'), task('t3', 'finished', '2026-09-29T08:00:00Z')];
  const layout = layoutProjectWork({ tasks, decisions: [question('t2'), question('t2')], approvalCards: [] });
  assert.deepEqual(layout.questions.map((row) => row.taskId), ['t2']);
  assert.deepEqual(layout.current.map((row) => row.taskId), ['t1']);
  assert.deepEqual(layout.ended.map((row) => row.taskId), ['t3']);
  assert.deepEqual(layout.looseQuestions, []);
  assert.equal(layout.waiting, 1);
});

test('a question whose task is not in the overview is still answerable by its task id', () => {
  const layout = layoutProjectWork({ tasks: [], decisions: [question('t9'), question(null)], approvalCards: [] });
  assert.deepEqual(layout.looseQuestions.map((row) => row.taskId), ['t9'], 'a question with no task has nothing to answer through');
  assert.equal(layout.waiting, 1);
});

test('a task that can be answered is a decision even when the decisions list was cut short', () => {
  const layout = layoutProjectWork({ tasks: [asking('t2', '2026-09-29T10:00:00Z')], decisions: [], approvalCards: null });
  assert.deepEqual(layout.questions.map((row) => row.taskId), ['t2']);
  assert.deepEqual(layout.current, []);
});

test('an approval asked in a conversation is answered there and never gets a button', () => {
  const layout = layoutProjectWork({
    tasks: [task('t1', 'needs_you', '2026-09-29T10:00:00Z')],
    decisions: [approval('ap-1', 't1', true), approval(null, null, false), approval(null, null, false), approval('ap-1', 't1', true)],
    approvalCards: [{ approvalId: 'ap-1' }],
  });
  assert.deepEqual(layout.approvals.map((row) => [row.decision.approvalId, row.card?.approvalId ?? null]), [['ap-1', 'ap-1']]);
  assert.equal(layout.asked.length, 1, 'the same question is drawn once');
  assert.equal(layout.asked[0]!.formal, false);
  assert.deepEqual(layout.current.map((row) => row.taskId), ['t1'], 'the task waiting on the approval stays in the work list');
  assert.equal(layout.waiting, 2);
});

test('a card the Mac calls formal is never sent to the conversation, even unread', () => {
  const unread = layoutProjectWork({ tasks: [], decisions: [approval('ap-1', null, true)], approvalCards: null });
  assert.deepEqual(unread.approvals.map((row) => row.card), [null], 'no buttons are drawn without the card');
  assert.deepEqual(unread.asked, []);
  const missing = layoutProjectWork({ tasks: [], decisions: [approval('ap-1', null, true)], approvalCards: [] });
  assert.equal(missing.approvals.length, 1);
  assert.deepEqual(missing.asked, []);
});

test('a decision that does not say is read as the shared engine reads it: a card', () => {
  const layout = layoutProjectWork({
    tasks: [],
    decisions: [approval('ap-1'), approval('ap-2'), approval(null)],
    approvalCards: [{ approvalId: 'ap-1' }],
  });
  assert.deepEqual(layout.approvals.map((row) => [row.decision.approvalId, row.card?.approvalId ?? null]), [['ap-1', 'ap-1'], ['ap-2', null]],
    'a card Needs you does not list is decided there; it gets no button here');
  assert.deepEqual(layout.asked.map((row) => row.approvalId), [null], 'with nothing to decide it by, it is answered where it was asked');
});

test('work is ordered: waiting on the owner, then moving, then ended; newest first', () => {
  const layout = layoutProjectWork({
    tasks: [
      task('old-working', 'working', '2026-09-29T08:00:00Z'),
      task('stopped', 'stopped', '2026-09-29T11:00:00Z'),
      task('new-working', 'working', '2026-09-29T10:00:00Z'),
      task('needs-approval', 'needs_you', '2026-09-29T07:00:00Z'),
      task('failed', 'failed', '2026-09-29T12:00:00Z'),
    ],
    decisions: [],
    approvalCards: [],
  });
  assert.deepEqual(layout.current.map((row) => row.taskId), ['needs-approval', 'new-working', 'old-working']);
  assert.deepEqual(layout.ended.map((row) => row.taskId), ['failed', 'stopped']);
});

test('an agent already assigned is not offered again; one whose assignment lost its agent is', () => {
  const agents = [{ id: 'a2', name: 'Writer' }, { id: 'a1', name: 'Analyst' }, { id: 'a3', name: 'Closer' }];
  const assigned = [{ agentId: 'a1', available: true }, { agentId: 'a3', available: false }];
  assert.deepEqual(assignableAgents(agents, assigned).map((agent) => agent.name), ['Closer', 'Writer']);
});

test('apps are the ones the Mac lists with an account connected, by name', () => {
  const apps = bindableApps([
    { toolkit: 'outlook', name: 'Outlook', accounts: [{ accountId: 'ca_1', label: 'owner@example.test' }, { accountId: 'ca_1', label: 'again' }, { accountId: 'ca_2', label: '' }] },
    { toolkit: 'googlesheets', name: 'Google Sheets', accounts: [{ accountId: 'ca_3', label: 'owner@example.test' }] },
    { toolkit: 'outlook', name: 'Outlook again', accounts: [{ accountId: 'ca_9', label: 'x' }] },
    { toolkit: 'slack', name: 'Slack', accounts: [] },
    { toolkit: 'unnamed', name: ' ', accounts: [{ accountId: 'ca_4', label: 'x' }] },
    null,
  ]);
  assert.deepEqual(apps, [
    { toolkit: 'googlesheets', name: 'Google Sheets', accounts: [{ accountId: 'ca_3', label: 'owner@example.test' }] },
    { toolkit: 'outlook', name: 'Outlook', accounts: [{ accountId: 'ca_1', label: 'owner@example.test' }, { accountId: 'ca_2', label: 'Connected account' }] },
  ]);
  assert.deepEqual(bindableApps(undefined), []);
});
