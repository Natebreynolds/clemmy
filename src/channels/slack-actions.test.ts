/**
 * Run: npx tsx --test src/channels/slack-actions.test.ts
 *
 * Slack sibling of discord-actions.test.ts — verifies the metadata → Block Kit
 * action_id mapping the notification-delivery path uses to attach buttons.
 * Same precedence + the same `clementine:<verb>:<id>` convention as Discord,
 * so the Slack action handler routes them through the identical paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clementine-slack-actions-'));

const { __test__ } = await import('./slack.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const { createCheckIn, getCheckIn } = await import('../agents/check-ins.js');
const { createBackgroundTask, updateBackgroundTask } = await import('../execution/background-tasks.js');
const { buildSlackActionsForNotification, formatSlackNotificationMessage } = __test__;

const basicSession = HarnessSession.create({
  id: 'slack-actions-basic',
  kind: 'chat',
  channel: 'slack',
  title: 'Slack action test',
});
const basicApproval = approvalRegistry.register({
  sessionId: basicSession.id,
  subject: 'Approve the action',
  tool: 'request_approval',
});

function actionIds(blocks: ReturnType<typeof buildSlackActionsForNotification>): string[] {
  if (!blocks) return [];
  const ids: string[] = [];
  for (const block of blocks) {
    const elements = (block as { elements?: Array<{ action_id?: string }> }).elements ?? [];
    for (const el of elements) {
      if (el.action_id) ids.push(el.action_id);
    }
  }
  return ids;
}

test('buildSlackActionsForNotification: no metadata returns undefined (plain text)', () => {
  assert.equal(buildSlackActionsForNotification(undefined), undefined);
  assert.equal(buildSlackActionsForNotification({}), undefined);
  assert.equal(buildSlackActionsForNotification({ foo: 'bar' }), undefined);
});

test('buildSlackActionsForNotification: approvalId attaches approve/edit/reject', () => {
  const ids = actionIds(buildSlackActionsForNotification({ approvalId: basicApproval.approvalId }));
  assert.equal(ids.length, 3, 'expected approve, edit, reject');
  assert.ok(ids.includes(`clementine:approve:${basicApproval.approvalId}`));
  assert.ok(ids.includes(`clementine:edit:${basicApproval.approvalId}`));
  assert.ok(ids.includes(`clementine:reject:${basicApproval.approvalId}`));
});

test('buildSlackActionsForNotification: Outlook workflow uses human labels and offers pause', () => {
  const session = HarnessSession.create({
    id: 'workflow:sched-test:main',
    kind: 'workflow',
    channel: 'workflow',
    title: 'daily-standup-email',
    metadata: { workflowName: 'daily-standup-email', workflowRunId: 'sched-test', stepId: 'main' },
  });
  const row = approvalRegistry.register({
    sessionId: session.id,
    subject: 'Run OUTLOOK_OUTLOOK_SEND_EMAIL?',
    tool: 'composio_execute_tool',
    args: {
      tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
      arguments: JSON.stringify({ to_email: 'alex@corp.example', subject: 'Daily Standup', body: 'Meetings today' }),
    },
  });
  const blocks = buildSlackActionsForNotification({ approvalId: row.approvalId, workflowName: 'daily-standup-email' });
  const ids = actionIds(blocks);
  const labels = ((blocks?.[0] as { elements?: Array<{ text?: { text?: string } }> })?.elements ?? [])
    .map((element) => element.text?.text);

  assert.deepEqual(labels, ['Send email', 'Review / edit', 'Skip this email', 'Pause workflow']);
  assert.ok(ids.includes(`clementine:workflow-pause:${row.approvalId}`));
  const message = formatSlackNotificationMessage('Approval pending', row.subject, { approvalId: row.approvalId });
  assert.match(message, /Send an Outlook email/);
  assert.match(message, /alex@corp\.example/);
  assert.match(message, /Daily Standup/);
  assert.match(message, /scheduled workflow/);
});

test('buildSlackActionsForNotification: a resolved approval never gets stale buttons', () => {
  approvalRegistry.resolve(basicApproval.approvalId, 'rejected', 'unit-test');
  assert.equal(buildSlackActionsForNotification({ approvalId: basicApproval.approvalId }), undefined);
});

test('buildSlackActionsForNotification: checkInId attaches answer buttons', () => {
  const checkIn = createCheckIn({
    agentSlug: 'Clem',
    question: 'Which exact region should receive the finished report?',
  });
  const ids = actionIds(buildSlackActionsForNotification({ checkInId: checkIn.id }));
  assert.equal(ids.length, 1, 'a question gets one honestly labelled Answer control');
  assert.ok(ids.includes(`clementine:checkin-answer:${checkIn.id}`));
  assert.ok(!ids.includes(`clementine:checkin-approve:${checkIn.id}`));
  assert.ok(!ids.includes(`clementine:checkin-reject:${checkIn.id}`));
});

test('buildSlackActionsForNotification: linked carrier requires exact coordinates and stale Q1 settles', () => {
  const task = createBackgroundTask({ title: 'Slack exact question', prompt: 'Wait for the exact answer.' });
  const q1 = `slack:${task.id}:q1`;
  const q2 = `slack:${task.id}:q2`;
  updateBackgroundTask(task.id, { status: 'awaiting_input', pendingQuestionId: q1, pendingQuestion: 'Choose A or B?' });
  const checkIn = createCheckIn({
    agentSlug: 'Clem',
    question: 'Should I use account A or account B?',
    linkedTaskId: task.id,
    linkedQuestionId: q1,
  });

  assert.equal(actionIds(buildSlackActionsForNotification({ checkInId: checkIn.id })).length, 0, 'id-only legacy carrier has no linked authority');
  assert.equal(actionIds(buildSlackActionsForNotification({
    checkInId: checkIn.id,
    linkedTaskId: task.id,
    linkedQuestionId: q1,
  })).length, 1);

  updateBackgroundTask(task.id, { status: 'awaiting_input', pendingQuestionId: q2, pendingQuestion: 'Choose East or West?' });
  assert.equal(actionIds(buildSlackActionsForNotification({
    checkInId: checkIn.id,
    linkedTaskId: task.id,
    linkedQuestionId: q1,
  })).length, 0, 'stale Q1 cannot keep a Slack Answer button');
  assert.equal(getCheckIn(checkIn.id)?.status, 'closed');
});

test('buildSlackActionsForNotification: stale planProposalId does not attach dead buttons', () => {
  // No matching plan record on disk → undefined/empty, exactly like Discord.
  const ids = actionIds(buildSlackActionsForNotification({ planProposalId: 'plan-does-not-exist' }));
  assert.equal(ids.length, 0);
});

test('buildSlackActionsForNotification: stale goalDraftId does not attach dead buttons', () => {
  const ids = actionIds(buildSlackActionsForNotification({ goalDraftId: 'goal-does-not-exist' }));
  assert.equal(ids.length, 0);
});

test('buildSlackActionsForNotification: non-string ids are ignored', () => {
  assert.equal(buildSlackActionsForNotification({ approvalId: 123 as unknown as string }), undefined);
  assert.equal(buildSlackActionsForNotification({ checkInId: { x: 1 } as unknown as string }), undefined);
});
