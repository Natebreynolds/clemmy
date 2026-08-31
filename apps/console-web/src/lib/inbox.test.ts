/** Run: npx tsx --test apps/console-web/src/lib/inbox.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  approvalDecisionSuccessText,
  collapseAttentionRows,
  summarizeApprovalDecisionBatch,
  trustProposalScopeExpectation,
  type NotificationRow,
  type TrustProposalRow,
} from './inbox.js';

const row = (id: string, title: string, createdAt: string): NotificationRow => ({ id, title, createdAt });

test('duplicate workflow needs-attention rows collapse to the newest with a count', () => {
  const collapsed = collapseAttentionRows([
    row('n1', 'Workflow needs attention: morning-prospect-prep', '2026-07-27T10:00:00Z'),
    row('n2', 'Workflow needs attention: morning-prospect-prep', '2026-07-27T12:00:00Z'),
    row('n3', 'Workflow needs attention: morning-prospect-prep', '2026-07-27T11:00:00Z'),
    row('n4', 'Workflow needs attention: weekly-review', '2026-07-27T09:00:00Z'),
  ]);
  assert.equal(collapsed.length, 2);
  // Newest of the duplicate group leads, carrying the earlier two.
  assert.equal(collapsed[0].row.id, 'n2');
  assert.equal(collapsed[0].collapsedCount, 2);
  assert.deepEqual(collapsed[0].groupIds, ['n2', 'n3', 'n1']);
  // The distinct workflow keeps its own row, no count.
  assert.equal(collapsed[1].row.id, 'n4');
  assert.equal(collapsed[1].collapsedCount, 0);
});

test('unrelated titles never merge; ordering is newest-first across groups', () => {
  const collapsed = collapseAttentionRows([
    row('a', 'Task blocked: deploy snapshot', '2026-07-27T08:00:00Z'),
    row('b', 'Task blocked: deploy snapshot', '2026-07-27T09:30:00Z'),
    row('c', 'Needs input: which channel?', '2026-07-27T09:00:00Z'),
  ]);
  assert.deepEqual(collapsed.map((c) => c.row.id), ['b', 'c']);
  assert.equal(collapsed[0].collapsedCount, 1);
});

test('exact workflow capability gates never collapse by presentation title', () => {
  const gate = (notificationId: string): NotificationRow['workflowCapability'] => ({
    notificationId,
    workflow: 'Renewal workbook',
    runId: notificationId,
    stepId: 'publish',
    tool: 'GOOGLESHEETS_BATCH_UPDATE',
    toolkit: 'googlesheets',
    reason: 'ambiguous-account',
    retryAt: null,
    provenNoDispatch: true,
    resolution: { kind: 'review_run', reason: 'fixture' },
  });
  const collapsed = collapseAttentionRows([
    { ...row('cap-a', 'Workflow needs you — choose an account', '2026-08-30T10:00:00Z'), workflowCapability: gate('cap-a') },
    { ...row('cap-b', 'Workflow needs you — choose an account', '2026-08-30T10:01:00Z'), workflowCapability: gate('cap-b') },
  ]);
  assert.deepEqual(collapsed.map((entry) => entry.row.id), ['cap-b', 'cap-a']);
  assert.ok(collapsed.every((entry) => entry.collapsedCount === 0));
});

test('desktop Inbox makes workflow gates actionable and never approves a plan that still needs answers', () => {
  const source = readFileSync(new URL('../screens/Inbox.tsx', import.meta.url), 'utf8');
  const automate = readFileSync(new URL('../screens/Automate.tsx', import.meta.url), 'utf8');
  const api = readFileSync(new URL('./inbox.ts', import.meta.url), 'utf8');
  assert.match(source, /WorkflowCapabilityCard/);
  assert.match(api, /choiceSetDigest: gate\.resolution\.choiceSetDigest/);
  assert.match(source, /Use \$\{candidate\.label\}/);
  assert.match(source, /I connected it — resume this run/);
  assert.match(source, /Retry exact metadata now/);
  assert.match(source, /!needsInput && \(/);
  assert.match(source, /Answer in the exact conversation/);
  assert.match(source, /to=\{`\/chat\/\$\{encodeURIComponent\(row\.sessionId\)\}`\}/);
  assert.match(source, /Reject it and ask Clem to draft a new plan/);
  assert.match(automate, /Open exact Needs You gate/);
  assert.match(automate, /Choose an exact account/);
  assert.doesNotMatch(automate, /resumeWorkflowCapability/);
});

test('queued-action approval copy never claims the external action executed', () => {
  const text = approvalDecisionSuccessText({
    approvalId: 'apr-queued',
    subject: 'Publish approved post',
    status: 'pending',
    pendingAction: {
      id: 'pa-queued',
      title: 'Publish post',
      summary: 'Prepared post',
      kind: 'external_send',
      toolName: 'SOCIALS_PUBLISH_POST',
      payload: { body: 'hello' },
      payloadHash: 'hash',
      targetSummary: 'LinkedIn',
      preview: 'hello',
      risk: 'Publishes externally',
      rollback: 'Delete the post',
      status: 'approval_requested',
      idempotencyKey: 'one',
      approvalId: 'apr-queued',
      resultSummary: null,
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    },
  }, 'approve');

  assert.match(text, /approved/i);
  assert.match(text, /execution is not confirmed/i);
  assert.doesNotMatch(text, /\bexecuted\b|\bpublished\b|\bsent\b/i);
});

test('bulk approval summary exposes partial failure and keeps failed items actionable', () => {
  assert.equal(
    summarizeApprovalDecisionBatch({
      decision: 'approve',
      total: 3,
      succeeded: 2,
      errors: ['Provider rejected one payload.'],
    }),
    'Approved 2 of 3; 1 failed: Provider rejected one payload. Failed items remain selected.',
  );
  assert.equal(
    summarizeApprovalDecisionBatch({
      decision: 'reject',
      total: 2,
      succeeded: 2,
      errors: [],
    }),
    'Rejected 2 of 2.',
  );
});

test('desktop trust decision binds the exact rendered scope revision and digest', () => {
  const proposal: TrustProposalRow = {
    id: 'trust-exact-scope',
    scopeRevision: 1,
    scopeDigest: `sha256:${'a'.repeat(64)}`,
    toolkits: ['gmail_send_email'],
    recipients: ['owner@public.test'],
    domains: ['example.test'],
    maxRecipients: 2,
    evidence: {
      cleanSendCount: 5,
      distinctDays: 4,
      firstAt: '2026-08-20T12:00:00.000Z',
      lastAt: '2026-08-29T12:00:00.000Z',
    },
    rationale: 'Exact scope fixture.',
    status: 'pending',
    createdAt: '2026-08-30T12:00:00.000Z',
  };
  assert.deepEqual(trustProposalScopeExpectation(proposal), {
    scopeRevision: proposal.scopeRevision,
    scopeDigest: proposal.scopeDigest,
  });
});
