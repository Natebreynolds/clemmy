/**
 * Run: npx tsx --test src/dashboard/needs-you.test.ts
 *
 * The one needs-you count (owner decision 2026-09-22, "Clem's asks + your
 * replies"). Every surface reads this summary, so each rule below is a rule
 * for the sidebar, Home, the Needs you tab and the phone at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-needs-you-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { summarizeNeedsYou, needsYouReferents, needsYouKey, notificationNeedsYou } = await import('./needs-you.js');
const { addNotification } = await import('../runtime/notifications.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { createSession } = await import('../runtime/harness/eventlog.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function writeRun(id: string, workflow: string, status: string, createdAt: string): void {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${id}.json`), JSON.stringify({
    id, workflow, workflowSlug: workflow, status, createdAt,
  }));
}

function notify(id: string, kind: 'workflow' | 'execution', title: string, metadata: Record<string, unknown>): void {
  addNotification({ id, kind, title, body: '', createdAt: iso(-60_000), read: false, metadata } as never);
}

test('a workflow notice counts while its newest run is stopped, once per workflow', async () => {
  // Stopped now: three notices, one item.
  writeRun('run-a1', 'daily-standup', 'completed', iso(-3 * 86_400_000));
  writeRun('run-a2', 'daily-standup', 'parked', iso(-3_600_000));
  for (const n of [1, 2, 3]) {
    notify(`wf-a-${n}`, 'workflow', 'Workflow blocked: daily-standup', { workflow: 'daily-standup', runId: n === 3 ? 'run-a2' : 'run-a1', needsAttention: true });
  }
  // Blocked once, then ran fine: history, not an ask.
  writeRun('run-b1', 'friday-report', 'blocked', iso(-2 * 86_400_000));
  writeRun('run-b2', 'friday-report', 'completed', iso(-3_600_000));
  notify('wf-b-1', 'workflow', 'Workflow blocked: friday-report', { workflow: 'friday-report', runId: 'run-b1', needsAttention: true });

  const summary = await summarizeNeedsYou({ nowMs: NOW });
  assert.ok(summary.keys.includes('flow:daily-standup'));
  assert.equal(summary.keys.filter((key) => key === 'flow:daily-standup').length, 1);
  assert.equal(summary.keys.includes('flow:friday-report'), false, 'a workflow that ran since is not stopped');
});

test('a meeting invite counts until the meeting starts; a moved meeting is news', async () => {
  const calendar = { watch: 'calendar', source: 'calendar-watch', signal: 'high', needsAttention: true };
  notify('cal-future', 'execution', 'Reply needed: Pipeline review', { ...calendar, changeKind: 'invite_unanswered', itemKey: 'acct|invite_unanswered|evt-1', startsAt: iso(86_400_000) });
  notify('cal-past', 'execution', 'Reply needed: Yesterday sync', { ...calendar, changeKind: 'invite_unanswered', itemKey: 'acct|invite_unanswered|evt-2', startsAt: iso(-86_400_000) });
  notify('cal-moved', 'execution', 'Moved: Team sync', { ...calendar, changeKind: 'moved', itemKey: 'acct|moved|evt-3', startsAt: iso(86_400_000) });

  const summary = await summarizeNeedsYou({ nowMs: NOW });
  assert.ok(summary.keys.includes('calendar:acct|invite_unanswered|evt-1'));
  assert.equal(summary.keys.includes('calendar:acct|invite_unanswered|evt-2'), false);
  assert.equal(summary.keys.includes('calendar:acct|moved|evt-3'), false);
});

test('a chat run waiting on an answer counts; a past-tense "blocked" report is an update', async () => {
  notify('chat-asks', 'execution', 'Chat run needs you: pick an account', { status: 'needs_input', sessionId: 'sess-asks', needsAttention: true });
  notify('chat-blocked', 'execution', 'Chat run blocked: gave up', { status: 'blocked', sessionId: 'sess-gave-up', needsAttention: true });

  const summary = await summarizeNeedsYou({ nowMs: NOW });
  assert.ok(summary.keys.includes('session:sess-asks'));
  assert.equal(summary.keys.includes('session:sess-gave-up'), false);
});

test('a notification carrying a pending approval is that approval, counted once', async () => {
  const session = createSession({ kind: 'chat', channel: 'desktop', userId: 'desktop' });
  const approval = approvalRegistry.register({
    sessionId: session.id,
    channel: 'desktop',
    subject: 'Send Slack message',
    tool: 'composio_execute_tool',
    args: { reason: 'Post the weekly summary.' },
  });
  notify('carrier', 'execution', 'Approval pending', { approvalId: approval.approvalId, needsAttention: true });

  const summary = await summarizeNeedsYou({ nowMs: NOW });
  assert.equal(summary.keys.filter((key) => key === `approval:${approval.approvalId}`).length, 1);
  assert.equal(summary.keys.includes('notification:carrier'), false);

  const ref = needsYouReferents(NOW);
  const row = { id: 'carrier', kind: 'execution' as const, title: 'Approval pending', metadata: { approvalId: approval.approvalId } };
  assert.equal(needsYouKey(row, ref.runs), `approval:${approval.approvalId}`);
  assert.equal(notificationNeedsYou(row, ref), true);
  approvalRegistry.resolve(approval.approvalId, 'rejected', 'test');
});

test('the total is exactly the distinct keys, and every key is either listed or unlisted', async () => {
  const summary = await summarizeNeedsYou({ nowMs: NOW });
  assert.equal(summary.total, new Set(summary.keys).size);
  for (const item of summary.unlisted) assert.ok(summary.keys.includes(item.key));
});
