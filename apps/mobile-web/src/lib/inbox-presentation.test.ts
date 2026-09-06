import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalDetails,
  approvalKindLabel,
  approvalQuestion,
  collapseAttentionNotifications,
  notificationIsRepresentedByApprovals,
  notificationRunTarget,
  trustScopeSummary,
} from './inbox-presentation';
import type { InboxNotification } from './api';
import { readFileSync } from 'node:fs';

test('approval presentation turns provider plumbing into assistant language', () => {
  assert.equal(approvalKindLabel('OUTLOOK_SEND_EMAIL'), 'Email');
  assert.equal(approvalKindLabel('GMAIL_DELETE_MESSAGE'), 'Sensitive change');
  assert.equal(
    approvalQuestion('Send the renewal follow-up to Acme.'),
    'I’m ready to send the renewal follow-up to Acme. Should I go ahead?',
  );
});

test('approval details are bounded before rendering untrusted tool arguments', () => {
  const args: Record<string, unknown> = { body: 'x'.repeat(20_000) };
  for (let index = 0; index < 100; index += 1) args[`field_${index}`] = { nested: ['value'] };
  const rows = approvalDetails({ args });
  assert.ok(rows.length <= 21, 'twenty fields plus one omission receipt');
  assert.ok(rows.every((row) => row.value.length <= 4_000));
  assert.equal(rows.at(-1)?.label, 'Additional fields');
});

test('approval details use readable labels and keep message previews intact', () => {
  const rows = approvalDetails({
    args: {
      close_date: '2026-09-30',
      account: 'Acme Corp',
      body: 'Hi Jordan — here are the options.',
    },
  });
  assert.deepEqual(rows.map((row) => row.label), ['Account', 'Message', 'Close date']);
  assert.equal(rows[1]?.long, true);
});

test('attention notifications never collapse distinct issues by workflow or title', () => {
  const base: InboxNotification = {
    id: 'n-1', kind: 'workflow', title: 'Flow needs attention', body: '',
    createdAt: '2026-08-30T12:00:00.000Z', read: false, needsAttention: true,
    deliveredAt: null, deliveryError: null,
    context: {
      actionItemId: null,
      approvalId: null,
      planProposalId: null,
      trustProposalId: null,
      questionId: null,
      sessionId: null,
      runId: null,
      stepId: null,
      workflow: 'daily-summary',
    },
  };
  const collapsed = collapseAttentionNotifications([base, { ...base, id: 'n-2' }]);
  assert.deepEqual(collapsed.map(({ row, earlier }) => ({ id: row.id, earlier })), [
    { id: 'n-1', earlier: 0 },
    { id: 'n-2', earlier: 0 },
  ]);
});

test('trust presentation never hides a domain behind exact recipients', () => {
  assert.equal(
    trustScopeSummary({
      recipients: ['renewals@acme.test'],
      domains: ['partners.acme.test'],
    }),
    'exact recipients renewals@acme.test; anyone at partners.acme.test',
  );
});

test('an aggregate approval digest is not counted as a third decision', () => {
  const context = {
    actionItemId: null,
    approvalId: null,
    planProposalId: null,
    trustProposalId: null,
    relatedApprovalIds: ['approval-a', 'approval-b'],
    questionId: null,
    sessionId: null,
    runId: null,
    stepId: null,
    workflow: null,
  };
  assert.equal(
    notificationIsRepresentedByApprovals({ context }, new Set(['approval-a', 'approval-b'])),
    true,
  );
  assert.equal(
    notificationIsRepresentedByApprovals({ context }, new Set(['approval-a'])),
    false,
  );
});

test('“Open run” opens the RUN — the same one the push for that row opens', () => {
  // A background task's notification carries both: sessionId is the chat that
  // asked for the work, runSessionId is the run that did it. Keyed on
  // sessionId, the button opened the originating transcript rendered through
  // the run screen, while the push for the same notification opened the run.
  const context = {
    actionItemId: null,
    approvalId: null,
    planProposalId: null,
    trustProposalId: null,
    questionId: null,
    sessionId: 'sess-origin',
    runSessionId: 'background:task-1',
    runId: 'task-1',
    stepId: null,
    workflow: null,
  };
  assert.equal(notificationRunTarget({ context }), 'background:task-1');
  // A plain chat notification has only the one session, and it IS the run.
  assert.equal(
    notificationRunTarget({ context: { ...context, runSessionId: null } }),
    'sess-origin',
  );
  assert.equal(
    notificationRunTarget({ context: { ...context, runSessionId: '  ', sessionId: '' } }),
    null,
    'no run means no “Open run” affordance at all',
  );
});

test('the Inbox asks for that destination instead of spelling sessionId itself', () => {
  const inbox = readFileSync(new URL('../screens/Inbox.tsx', import.meta.url), 'utf8');
  assert.match(inbox, /const runTarget = notificationRunTarget\(row\);/);
  assert.equal((inbox.match(/onOpenRun\(runTarget\)/g) ?? []).length, 2, 'both Open run buttons');
  assert.doesNotMatch(
    inbox,
    /onOpenRun\(row\.context\.sessionId as string\)/,
    'the origin conversation is where a REPLY goes, not where the run is',
  );
  // Reply still goes to the conversation — that part was always right.
  assert.match(inbox, /onReply\(row\.context\.sessionId, `About/);
});
