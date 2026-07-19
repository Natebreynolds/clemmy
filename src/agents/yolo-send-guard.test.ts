/**
 * Run: npx tsx --test src/agents/yolo-send-guard.test.ts
 *
 * Ask-first batch regression: "Auto-approved by YOLO mode: Send
 * priority-account reactivation emails 1-10" put 10 unapproved emails on the
 * wire. YOLO covers reversible work, never irreversible sends or destructive
 * actions; the one concrete approval card owns those pauses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-yolo-guard-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { _requestApprovalRequiresHumanForTests: guard } = await import('./orchestrator.js');
const { queuePendingAction } = await import('../runtime/harness/pending-actions.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

function queueSendBatch(items: number, kind: 'external_send' | 'external_write' = 'external_send') {
  return queuePendingAction({
    title: `Batch send: test`,
    summary: 'test batch',
    kind,
    toolName: 'run_batch',
    payload: { sideEffect: kind === 'external_send' ? 'send' : 'write', items: Array.from({ length: items }, (_, i) => ({ id: `t-${i}`, args: {} })) },
    targetSummary: `${items} item(s)`,
    preview: '{}',
    risk: 'test',
    rollback: 'test',
    sessionId: 'sess-test',
    createdBy: 'run_batch',
  });
}

test('queued irreversible send requires a human regardless of batch size', async () => {
  const record = queueSendBatch(10);
  assert.equal(await guard({ subject: 'Send priority-account reactivation emails 1-10', reason: null, destructive: false, pendingActionId: record.id } as never), true);
  const single = queueSendBatch(1);
  assert.equal(await guard({ subject: 'Send one follow-up', reason: null, destructive: false, pendingActionId: single.id } as never), true);
});

test('non-send pending action never blocks YOLO', async () => {
  const record = queueSendBatch(50, 'external_write');
  assert.equal(await guard({ subject: 'Update 50 sheet rows', reason: null, destructive: false, pendingActionId: record.id } as never), false);
});

test('text fallback: every explicit irreversible action blocks; reversible drafts and writes do not', async () => {
  assert.equal(await guard({ subject: 'Send priority-account reactivation emails 1-10', reason: null, destructive: false } as never), true);
  assert.equal(await guard({ subject: 'Send 25 outreach emails to the prospect list', reason: null, destructive: false } as never), true);
  assert.equal(await guard({ subject: 'Send daily standup email', reason: null, destructive: false } as never), true);
  assert.equal(await guard({ subject: 'Create 30 Outlook email drafts for review', reason: null, destructive: false } as never), false);
  assert.equal(await guard({ subject: 'Create 30 draft rows in the sheet', reason: null, destructive: false } as never), false);
  assert.equal(await guard({ subject: 'Delete the production workspace', reason: null, destructive: true } as never), true);
});
