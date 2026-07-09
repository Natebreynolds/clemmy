/**
 * Run: npx tsx --test src/agents/yolo-send-guard.test.ts
 *
 * 2026-07-09 sess-mrds80fu regression: "Auto-approved by YOLO mode: Send
 * market-leader reactivation emails 1-10" put 10 unapproved emails on the
 * wire. YOLO must never auto-approve a BATCH of irreversible sends at/over
 * batchConfirmThreshold; single/uncounted sends (the daily standup brief)
 * keep the YOLO contract unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-yolo-guard-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { _yoloBlockedForSendBatchForTests: guard } = await import('./orchestrator.js');
const { queuePendingAction } = await import('../runtime/harness/pending-actions.js');
const { sendBatchApprovalFloor } = await import('./proactivity-policy.js');

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

test('default floor honors batchConfirmThreshold (>=2)', () => {
  assert.ok(sendBatchApprovalFloor() >= 2);
});

test('queued send batch at/over the floor blocks YOLO auto-approval', async () => {
  const record = queueSendBatch(10);
  assert.equal(await guard({ subject: 'Send market-leader reactivation emails 1-10', reason: null, destructive: false, pendingActionId: record.id } as never), true);
});

test('small send batch under the floor keeps YOLO flowing', async () => {
  const record = queueSendBatch(2);
  const floor = sendBatchApprovalFloor();
  assert.equal(await guard({ subject: 'Send two follow-ups', reason: null, destructive: false, pendingActionId: record.id } as never), 2 >= floor);
});

test('non-send pending action never blocks YOLO', async () => {
  const record = queueSendBatch(50, 'external_write');
  assert.equal(await guard({ subject: 'Update 50 sheet rows', reason: null, destructive: false, pendingActionId: record.id } as never), false);
});

test('text fallback: send vocabulary + counted range blocks; single uncounted send does not', async () => {
  assert.equal(await guard({ subject: 'Send market-leader reactivation emails 1-10', reason: null, destructive: false } as never), true);
  assert.equal(await guard({ subject: 'Send 25 outreach emails to the prospect list', reason: null, destructive: false } as never), true);
  assert.equal(await guard({ subject: 'Send daily standup email', reason: null, destructive: false } as never), false);
  assert.equal(await guard({ subject: 'Create 30 draft rows in the sheet', reason: null, destructive: false } as never), false);
});
