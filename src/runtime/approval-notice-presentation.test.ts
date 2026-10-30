/**
 * Run: npx tsx --test src/runtime/approval-notice-presentation.test.ts
 *
 * An approval notice says what became of the approval. Live 2026-10-30 the
 * Updates list held 49 rows titled "Approval pending", 26 tagged Failed (a push
 * had not reached a device) and 23 Handled (the row had been opened), long
 * after each approval was answered.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-approval-notice-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const reg = await import('./harness/approval-registry.js');
const { closeEventLog, createSession } = await import('./harness/eventlog.js');
const { approvalNoticeFields, approvalNoticeOutcome } = await import('./approval-notice-presentation.js');

test.after(() => {
  try { closeEventLog(); } catch { /* best effort */ }
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

const notice = (metadata: Record<string, unknown>, title = 'Approval pending') => ({
  kind: 'approval' as const,
  title,
  body: 'Delete Outlook calendar event',
  metadata,
});

test('a settled approval notice leads with its outcome and its subject', () => {
  assert.deepEqual(approvalNoticeFields(notice({ approvalId: 'apr-a', approvalResolution: 'approved' })), {
    title: 'Approved: Delete Outlook calendar event',
    approvalOutcome: 'approved',
    approvalOutcomeLabel: 'Approved',
  });
  assert.equal(approvalNoticeFields(notice({ approvalResolution: 'rejected' })).title, 'Declined: Delete Outlook calendar event');
  assert.equal(approvalNoticeFields(notice({ approvalResolution: 'expired' })).title, 'No answer in time: Delete Outlook calendar event');
  assert.equal(approvalNoticeFields(notice({ approvalResolution: 'cancelled_by_system' })).title, 'Withdrawn: Delete Outlook calendar event');
});

test('a notice without a recorded outcome reads the registry: open is waiting, gone is closed', () => {
  const session = createSession({ kind: 'chat', channel: 'desktop', title: 'Notice outcome' });
  const row = reg.register({ sessionId: session.id, subject: 'Move the team meeting', tool: 'work_call', ttlMs: 60 * 60_000 });
  assert.equal(approvalNoticeOutcome(notice({ approvalId: row.approvalId })), 'waiting');
  assert.equal(approvalNoticeFields(notice({ approvalId: row.approvalId })).title, 'Waiting on your OK: Delete Outlook calendar event');
  reg.resolve(row.approvalId, 'rejected', 'test');
  assert.equal(approvalNoticeOutcome(notice({ approvalId: row.approvalId })), 'declined');
  assert.equal(approvalNoticeOutcome(notice({ approvalId: 'apr-unknown' })), 'closed');
});

test('a notice that is not an approval, or already has its own title, keeps it', () => {
  assert.deepEqual(approvalNoticeFields({ kind: 'workflow', title: 'Finished: Daily brief', body: '', metadata: {} }), {});
  assert.equal(approvalNoticeFields(notice({ approvalResolution: 'approved' }, 'Send the weekly update?')).title, 'Send the weekly update?');
});
