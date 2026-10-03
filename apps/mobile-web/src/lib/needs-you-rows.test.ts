/** Run: npx tsx --test apps/mobile-web/src/lib/needs-you-rows.test.ts
 *
 * The phone's Needs you is one compact list: every kind of waiting item is the
 * same one-line row with the identity its card and deep link use, in the order
 * the screen already shows, and only a stopped workflow reads as urgent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNeedsRows } from './needs-you-rows.js';
import type { ApprovalRow, InboxNotification, InboxQuestion, PlanProposalRow } from './api.js';

const longText = 'Clem found that the research steps you ran three times this week share the same inputs. '.repeat(12);

const question: InboxQuestion = {
  id: 'checkin:q1', source: 'check_in', question: 'Should I save this research as a workflow?', options: [], context: 'noticing:ntc-mupqxx8k-aa8684',
  askedAt: '2026-10-01T10:00:00.000Z', urgency: 'normal', agentLabel: 'Clem', sessionId: null, taskId: null,
  workflowName: null, runId: null, stepId: null, answerable: true, unavailableReason: null,
};
const plan: PlanProposalRow = {
  id: 'p1', sessionId: 's1', proposedAt: '2026-10-01T08:00:00.000Z', status: 'pending', objective: longText, context: null,
  complexity: 'moderate', steps: [{ n: 1, action: 'Collect the steps', rationale: '', verification: null }],
  successCriteria: [], risks: [], needsUserInput: [], appliedInstructions: [],
};
const approval: ApprovalRow = {
  approvalId: 'a1', sessionId: 's2', channel: null, channelId: null, requestedAt: '2026-10-01T09:00:00.000Z', expiresAt: '2026-10-02T09:00:00.000Z',
  subject: 'Send a message to the team channel', tool: 'slack_send', args: {}, status: 'pending', resolution: null,
  contentPreview: { body: 'Weekly update: three deals moved forward.' },
};
const notification = (over: Partial<InboxNotification>): InboxNotification => ({
  id: 'n1', kind: 'workflow', title: 'Workflow blocked: weekly-report', body: 'It stopped at the send step.', createdAt: '2026-10-01T07:00:00.000Z',
  read: false, needsAttention: true, deliveredAt: null, deliveryError: null,
  context: { actionItemId: null, approvalId: null, planProposalId: null, trustProposalId: null } as InboxNotification['context'],
  ...over,
});

test('every kind is one row, in screen order, keyed like its card and deep link', () => {
  const rows = buildNeedsRows({
    questions: [question], trustProposals: [], workspaceChoosers: [], plans: [plan], approvals: [approval],
    unlisted: [{ key: 'u1', kind: 'workflow_paused', title: 'Weekly report is paused', detail: 'Waiting for a connection', workflow: 'weekly-report' }],
    attention: [{ row: notification({ needsYouKey: 'flow:weekly-report' }), earlier: 2 }],
  });
  assert.deepEqual(rows.map((row) => row.key), ['checkin:q1', 'plan:p1', 'approval:a1', 'unlisted:u1', 'notification:n1']);
  assert.ok(rows.every((row) => row.title.length <= 120), 'a title is one line, never a wall');
  assert.equal(rows[0]!.preview, undefined, 'a reference id is never the preview');
  assert.equal(rows[2]!.preview, 'Weekly update: three deals moved forward.', 'an approval previews the draft');
  assert.deepEqual(rows.map((row) => row.urgent), [false, false, false, true, true], 'only a stopped workflow is urgent');
  assert.match(rows[4]!.context ?? '', /\+2 earlier/);
});

test('a project name, when the Mac says so, leads the context', () => {
  const [row] = buildNeedsRows({
    questions: [question], trustProposals: [], workspaceChoosers: [], plans: [], approvals: [], unlisted: [], attention: [],
    projectOf: () => 'Research',
  });
  assert.equal(row!.context, 'Research · Check-in');
});

test('a row speaks in words: Clem\'s question first, a workflow by its name', () => {
  const asked = { ...approval, presentation: { action: 'Workspace source script consent', ask: 'Can I keep your dashboard up to date?', why: 'It refreshes from your CRM each weekday.', details: [], unwrapped: false } };
  const rows = buildNeedsRows({
    questions: [], trustProposals: [], workspaceChoosers: [], plans: [],
    approvals: [asked, { ...approval, approvalId: 'a2', presentation: { action: 'Workspace source script consent', details: [], unwrapped: false } }],
    unlisted: [{ key: 'u1', kind: 'workflow_binding', title: "end-of-week-team-sales-snapshot can't run on its schedule", detail: 'Pick the account it should use.', workflow: 'end-of-week-team-sales-snapshot' }],
    attention: [],
  });
  assert.equal(rows[0]!.title, 'Can I keep your dashboard up to date?');
  assert.equal(rows[0]!.preview, 'It refreshes from your CRM each weekday.');
  assert.equal(rows[1]!.title, 'Send a message to the team channel', 'the subject in words before the kind of action');
  assert.equal(rows[2]!.title, "End of Week Team Sales Snapshot can't run on its schedule");
  assert.equal(rows[2]!.context, undefined, 'the name is not repeated as its own id');
});
