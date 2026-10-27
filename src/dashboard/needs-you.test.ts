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

const { summarizeNeedsYou, needsYouReferents, needsYouKey, notificationNeedsYou, questionsByWorkflow } = await import('./needs-you.js');
const { addNotification } = await import('../runtime/notifications.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { createSession } = await import('../runtime/harness/eventlog.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function writeRun(id: string, workflow: string, status: string, createdAt: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${id}.json`), JSON.stringify({
    id, workflow, workflowSlug: workflow, status, createdAt, ...extra,
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

test('failed runs a heartbeat reports are their workflow: one stopped item, not one per run', async () => {
  writeRun('run-f1', 'team-slack-updates', 'failed', iso(-2 * 86_400_000));
  writeRun('run-f2', 'team-slack-updates', 'failed', iso(-86_400_000));
  for (const run of ['run-f1', 'run-f2']) {
    notify(`hb-${run}`, 'execution', 'Something went wrong: Team Slack Updates', {
      needsAttention: true, heartbeatId: 'work-review', itemKey: `run_failed:${run}`,
      changeKind: 'run_failed', refType: 'workflow_run', refId: run,
    });
  }
  // A run the index has never seen keeps the heartbeat's own identity.
  notify('hb-unknown', 'execution', 'Something went wrong: elsewhere', {
    needsAttention: true, heartbeatId: 'work-review', itemKey: 'run_failed:run-unknown',
    changeKind: 'run_failed', refType: 'workflow_run', refId: 'run-unknown',
  });

  const summary = await summarizeNeedsYou({ nowMs: NOW });
  assert.equal(summary.keys.filter((key) => key === 'flow:team-slack-updates').length, 1);
  assert.equal(summary.keys.some((key) => key.startsWith('heartbeat:work-review:run_failed:run-f')), false);
  assert.ok(summary.keys.includes('heartbeat:work-review:run_failed:run-unknown'));
});

test('a workflow stopped on an open question is that question, on every surface', () => {
  writeRun('run-q-open', 'swim-blog', 'awaiting_input', iso(-3_600_000));
  const ref = needsYouReferents(NOW);
  const questionId = 'workflow:run-q-open|workflow-input:run-q-open:draft:1';
  const questionByWorkflow = questionsByWorkflow([questionId, 'task:bgq-1', 'workflow:run-never-seen|q'], ref.runs);
  assert.deepEqual([...questionByWorkflow], [['flow:swim-blog', questionId]]);
  const finished = { id: 'wf-finished', kind: 'workflow' as const, title: 'Finished: Swim Blog', metadata: { workflow: 'swim-blog', runId: 'run-q-open' } };
  assert.equal(needsYouKey(finished, { ...ref, questionByWorkflow }), questionId);
  assert.equal(needsYouKey(finished, { ...ref, questionByWorkflow: new Map() }), 'flow:swim-blog');
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

test('a chat question the owner moved past no longer counts; one still waiting does', async () => {
  const { appendEvent } = await import('../runtime/harness/eventlog.js');
  const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
  const { turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');
  const moved = createSession({ kind: 'chat', channel: 'desktop', userId: 'desktop' });
  const waiting = createSession({ kind: 'chat', channel: 'desktop', userId: 'desktop' });
  const ask = (sessionId: string) => appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Which account?' } });
  const movedAsk = ask(moved.id);
  const waitingAsk = ask(waiting.id);
  for (const [session, seq] of [[moved, movedAsk.seq], [waiting, waitingAsk.seq]] as const) {
    const identity = { sessionId: session.id, turn: 1, sourceUserSeq: seq };
    commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'needs_input', resumable: true,
      needs: { kind: 'input' }, presentation: { kind: 'question', text: 'Which one?' } });
    notify(`foreground-report-back-${session.id}-${seq}`, 'execution', 'Needs your answer: which account',
      { status: 'needs_input', sessionId: session.id, needsAttention: true, foregroundRun: true, terminalReportBack: true });
  }
  // The owner said something else in that chat: the question is history.
  appendEvent({ sessionId: moved.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Never mind, do the other thing.' } });

  const summary = await summarizeNeedsYou({ nowMs: NOW });
  assert.equal(summary.keys.includes(`session:${moved.id}`), false, 'moved on');
  assert.ok(summary.keys.includes(`session:${waiting.id}`), 'still waiting');
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
  assert.equal(needsYouKey(row, ref), `approval:${approval.approvalId}`);
  assert.equal(notificationNeedsYou(row, ref), true);

  // The conversation's own report ("Chat run needs you … Review apr-… to
  // continue") names only its session: it is the same ask as the approval.
  notify('chat-report', 'execution', 'Chat run needs you: send the summary', { status: 'needs_input', sessionId: session.id, needsAttention: true });
  const withReport = await summarizeNeedsYou({ nowMs: NOW });
  assert.equal(withReport.keys.includes(`session:${session.id}`), false);
  assert.equal(withReport.keys.filter((key) => key === `approval:${approval.approvalId}`).length, 1);
  approvalRegistry.resolve(approval.approvalId, 'rejected', 'test');
});

test('runs paused after repeated restarts are one decision per workflow, even after a newer run', async () => {
  // Two paused occurrences, then a newer run that finished: the paused ones
  // still wait for "resume or skip", and there is no notice to list them.
  writeRun('run-p1', 'weekly-digest', 'parked', iso(-5 * 86_400_000), { bootResumeParkedAt: iso(-5 * 86_400_000), bootResumeCount: 3 });
  writeRun('run-p2', 'weekly-digest', 'parked', iso(-4 * 86_400_000), { bootResumeParkedAt: iso(-4 * 86_400_000), bootResumeCount: 3 });
  writeRun('run-p3', 'weekly-digest', 'completed', iso(-3_600_000));
  // Parked on an approval is not a restart pause.
  writeRun('run-q1', 'invoice-chase', 'parked', iso(-3_600_000), { bootResumeParkedAt: iso(-3_600_000), parked: { reason: 'approval' } });
  const pendingRuns = [
    { workflowName: 'weekly-digest', runId: 'run-p1', runStatus: 'parked' },
    { workflowName: 'weekly-digest', runId: 'run-p2', runStatus: 'parked' },
    { workflowName: 'invoice-chase', runId: 'run-q1', runStatus: 'parked' },
  ];
  const summary = await summarizeNeedsYou({ nowMs: NOW, pendingRuns });
  assert.equal(summary.keys.filter((key) => key === 'flow:weekly-digest').length, 1);
  assert.equal(summary.keys.includes('flow:invoice-chase'), false);
  const row = summary.unlisted.find((item) => item.key === 'flow:weekly-digest');
  assert.equal(row?.kind, 'workflow_paused');
  assert.match(row?.title ?? '', /^2 runs of weekly-digest stopped after restarting several times/);
});

test('the total is exactly the distinct keys, and every key is either listed or unlisted', async () => {
  const summary = await summarizeNeedsYou({ nowMs: NOW });
  assert.equal(summary.total, new Set(summary.keys).size);
  for (const item of summary.unlisted) assert.ok(summary.keys.includes(item.key));
});

test('a retired runtime approval is not a decision: it is neither counted nor listed', async () => {
  // Deciding a runtime approval with no waiting task and no registry card
  // rejects it whatever was tapped, so it is not something the owner can do.
  const before = await summarizeNeedsYou();
  const summary = await summarizeNeedsYou({ runtimeApprovalIds: ['retired-runtime-approval'] });
  assert.equal(summary.approvals, before.approvals);
  assert.equal(summary.total, before.total);
  assert.ok(!summary.keys.includes('approval:retired-runtime-approval'));
});
