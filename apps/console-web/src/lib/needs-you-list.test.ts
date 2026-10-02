/** Run: npx tsx --test apps/console-web/src/lib/needs-you-list.test.ts
 *
 * Needs you reads as one compact list: every kind of decision is the same
 * one-line row, a preview never repeats the title, ordinary questions are quiet,
 * and the order and membership are exactly the feeds' (older approvals last).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionDestination, buildNeedsYouItems, needsYouRowView } from './needs-you-list.js';
import type { ApprovalRow, InboxQuestionRow, PlanProposalRow } from './inbox.js';

const longText = 'Clem found that the research steps you ran three times this week share the same inputs. '.repeat(12);

const question = (over: Partial<InboxQuestionRow> = {}): InboxQuestionRow => ({
  id: 'q1', source: 'check_in', question: 'Should I save this research as a workflow?', options: [], context: longText,
  askedAt: '2026-10-01T10:00:00.000Z', urgency: 'normal', agentLabel: 'Clem', sessionId: null, taskId: null,
  workflowName: null, runId: null, stepId: null, answerable: true, unavailableReason: null, ...over,
});
const approval = (id: string, over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  approvalId: id, subject: 'Send a message to the team channel', status: 'pending', requestedAt: '2026-10-01T09:00:00.000Z', ...over,
});
const plan: PlanProposalRow = {
  id: 'p1', proposedAt: '2026-10-01T08:00:00.000Z', status: 'pending', originatingRequest: 'Turn my weekly research into a reusable workflow',
  plan: { objective: 'Save the research steps as a workflow', steps: [{ action: 'Collect the steps' }] },
};

test('a row is one line: long text is cut to a sentence-sized preview, never a wall', () => {
  const view = needsYouRowView({ kind: 'question', id: 'q1', row: question() });
  assert.equal(view.title, 'Should I save this research as a workflow?');
  assert.ok(view.preview && view.preview.length <= 140, view.preview);
  assert.ok(view.preview!.endsWith('…'));
  assert.equal(view.state.tone, 'neutral', 'an ordinary question is not a warning');
  assert.equal(view.context, 'Clem · Check-in');
});

test('a preview never repeats the title', () => {
  const same = needsYouRowView({ kind: 'question', id: 'q2', row: question({ question: 'Pick the next goal step', context: 'Pick the next goal step' }) });
  assert.equal(same.preview, undefined);
  const approvalView = needsYouRowView({ kind: 'approval', id: 'a1', row: approval('a1', { summary: 'Send a message to the team channel' }), aged: false });
  assert.equal(approvalView.preview, undefined);
});

test('order and membership follow the feeds; older approvals sit last; only approvals are batch-decidable', () => {
  const items = buildNeedsYouItems({
    workspaceChoosers: [],
    questions: [question()],
    plans: [plan],
    approvals: [approval('old', { stale: true }), approval('new')],
    trust: [],
    attention: [{ row: { id: 'n1', title: 'Workflow needs attention: weekly-report', body: 'It stopped.', needsYouKey: 'flow:weekly-report' }, collapsedCount: 2, groupIds: ['n1', 'n0', 'nx'] }],
    unlisted: [{ key: 'u1', kind: 'workflow_paused', title: 'Weekly report is paused', detail: 'Waiting for a connection', workflow: 'weekly-report' }],
  });
  assert.deepEqual(items.map((item) => item.id), ['q1', 'p1', 'new', 'n1', 'u1', 'old']);
  const views = items.map(needsYouRowView);
  assert.deepEqual(views.filter((v) => v.checkable).map((v) => v.id), ['new', 'old']);
  assert.equal(views.at(-1)!.aged, true);
  const stopped = views.find((v) => v.id === 'n1')!;
  assert.equal(stopped.state.tone, 'warning', 'a stopped workflow is a real problem');
  assert.match(stopped.context ?? '', /\+2 earlier/);
  assert.equal(views.find((v) => v.id === 'u1')!.href, '/automate?workflow=weekly-report');
});

test('a reference id is never a row preview', () => {
  const view = needsYouRowView({ kind: 'question', id: 'q3', row: question({ context: 'noticing:ntc-mupqxx8k-aa8684' }) });
  assert.equal(view.preview, undefined);
});

test('an attention item links to where it is resolved, by the server key alone', () => {
  assert.deepEqual(attentionDestination('session:sess-desktop-1'), { href: '/chat/sess-desktop-1', label: 'Open the conversation' });
  assert.deepEqual(attentionDestination('flow:weekly report'), { href: '/automate?workflow=weekly%20report', label: 'Open the workflow' });
  assert.equal(attentionDestination('calendar:abc'), undefined);
  assert.equal(attentionDestination(undefined), undefined);
});
