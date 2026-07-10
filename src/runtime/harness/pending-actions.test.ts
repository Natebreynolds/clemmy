/**
 * Run: npx tsx --test src/runtime/harness/pending-actions.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-pending-actions-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const pending = await import('./pending-actions.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('queuePendingAction persists exact payload metadata and hashes', () => {
  const record = pending.queuePendingAction({
    title: 'Send proof email',
    summary: 'Send one fictional proof email after approval.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    targetSummary: 'proof@example.com',
    preview: 'Subject: Proof pending action',
    risk: 'Would send one email.',
    rollback: 'No undo for sent email.',
    sessionId: 'sess-pending-test',
    payload: {
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: { to: 'proof@example.com', subject: 'Proof pending action', body: 'Hello' },
    },
  });

  assert.match(record.id, /^pa-/);
  assert.equal(record.status, 'queued');
  assert.equal(record.toolName, 'composio_execute_tool');
  assert.equal(record.targetSummary, 'proof@example.com');
  assert.match(record.payloadHash, /^[a-f0-9]{16}$/);
  assert.match(record.idempotencyKey, /^[a-f0-9]{16}$/);

  const fetched = pending.getPendingAction(record.id);
  assert.equal(fetched?.payloadHash, record.payloadHash);
  assert.equal(pending.listPendingActions({ sessionId: 'sess-pending-test' }).length, 1);
});

test('approval and result transitions update status without losing history', () => {
  const record = pending.queuePendingAction({
    title: 'Publish proof',
    summary: 'Publish after approval.',
    kind: 'deployment',
    toolName: 'run_shell_command',
    payload: { command: 'npm run deploy' },
  });

  pending.linkPendingActionApproval(record.id, 'apr-1234');
  assert.equal(pending.getPendingAction(record.id)?.status, 'approval_requested');
  assert.equal(pending.getPendingAction(record.id)?.approvalId, 'apr-1234');

  pending.markPendingActionApprovalResolved(record.id, 'approved', 'apr-1234');
  assert.equal(pending.getPendingAction(record.id)?.status, 'approved');

  pending.recordPendingActionResult(record.id, 'executed', 'Deploy completed.');
  const done = pending.getPendingAction(record.id);
  assert.equal(done?.status, 'executed');
  assert.equal(done?.resultSummary, 'Deploy completed.');
  assert.ok((done?.history.length ?? 0) >= 4);
});

test('human approval provenance cannot be downgraded by later policy bookkeeping', () => {
  const record = pending.queuePendingAction({
    title: 'Send approved proof',
    summary: 'Send after a real card decision.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'proof@example.com' } },
  });

  pending.markPendingActionApprovalResolved(record.id, 'approved', 'apr-human');
  pending.markPendingActionApprovalResolved(record.id, 'approved', null, {
    by: 'policy',
    evidence: { kind: 'policy', scope: 'yolo' },
  });

  const approved = pending.getPendingAction(record.id);
  assert.equal(approved?.approvedBy, 'human');
  assert.deepEqual(approved?.approvalEvidence, { kind: 'card', approvalId: 'apr-human' });
  assert.equal(approved?.approvalId, 'apr-human');
});

test('parsePendingActionPayloadJson rejects malformed JSON with a corrective message', () => {
  assert.throws(
    () => pending.parsePendingActionPayloadJson('{bad json'),
    /payloadJson must be valid JSON/,
  );
});
