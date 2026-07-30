import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-approval-focus-'));

const approvals = await import('./approval-registry.js');
const eventlog = await import('./eventlog.js');
const focus = await import('../../memory/focus.js');
const reconcile = await import('./approval-focus-reconcile.js');

test('resolving the exact approval closes a synthetic approval-only Home focus', () => {
  const session = eventlog.createSession({ id: 'space-sales-focus', kind: 'chat' });
  const approval = approvals.register({
    sessionId: session.id,
    subject: 'Trust Salesforce runner',
    tool: 'space_trust_data_runner',
    args: {},
  });
  const row = focus.createFocus({
    resourceRef: `session:${session.id}`,
    title: `ASK: Approve the pending Workspace runner card (${approval.approvalId})`,
    summary: `ASK: Approve ${approval.approvalId} so I can refresh Salesforce.`,
    resourceKind: 'thread',
    relatedSessionId: session.id,
    metadata: { source: 'harness_auto_focus' },
  });

  reconcile.initApprovalFocusReconciliation();
  assert.equal(approvals.resolve(approval.approvalId, 'approved', 'test').ok, true);
  assert.equal(focus.getFocusById(row.id)?.status, 'completed');
  assert.equal(focus.getActiveFocus(), null);
});

test('recovery closes a previously resolved approval ask but preserves user focus', () => {
  const session = eventlog.createSession({ id: 'space-recovery-focus', kind: 'chat' });
  const approval = approvals.register({
    sessionId: session.id,
    subject: 'Trust runner',
    tool: 'space_trust_data_runner',
    args: {},
  });
  assert.equal(approvals.resolve(approval.approvalId, 'rejected', 'test').ok, true);
  const stale = focus.createFocus({
    resourceRef: `session:${session.id}`,
    title: `ASK: Review ${approval.approvalId}`,
    summary: `ASK: Reject or approve ${approval.approvalId}.`,
    resourceKind: 'thread',
    relatedSessionId: session.id,
    metadata: { source: 'harness_auto_focus' },
  });
  assert.ok(reconcile.reconcileResolvedApprovalFocus());
  assert.equal(focus.getFocusById(stale.id)?.status, 'abandoned');

  const userOwned = focus.createFocus({
    resourceRef: 'project:sales',
    title: `Sales improvements after ${approval.approvalId}`,
    summary: 'Continue improving sales reporting.',
    resourceKind: 'project',
    relatedSessionId: session.id,
    metadata: { source: 'focus_set' },
  });
  assert.equal(reconcile.reconcileResolvedApprovalFocus(), null);
  assert.equal(focus.getFocusById(userOwned.id)?.status, 'active');
});
