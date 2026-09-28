/**
 * Run: npx tsx --test src/runtime/harness/approval-reminder.test.ts
 *
 * One reminder for an approval nobody answered (live 2026-09-25: a card for a
 * time-sensitive message sat unseen for hours). Every pin drives the real
 * approval reaper sweep — the function the daemon schedules at boot and every
 * minute — against the real registry, notification store and delivery queue.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-approval-reminder-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NewConversationalApprovalPresentation } from './approval-registry.js';

const reaper = await import('./reaper.js');
const reg = await import('./approval-registry.js');
const { appendEvent, createSession, closeEventLog, openEventLog } = await import('./eventlog.js');
const {
  addNotification,
  getNotificationDestinationsForRecord,
  listNotifications,
  listQueuedNotificationDeliveries,
} = await import('../notifications.js');
const { snoozeHomeItem } = await import('../home-snoozes.js');
const { exactOriginDeliveryTargetDigest } = await import('../exact-origin-delivery.js');
const {
  APPROVAL_REMINDER_AFTER_MS,
  approvalReminderNotificationId,
} = await import('./approval-reminder.js');

const DAY_MS = 24 * 60 * 60_000;
const STATE_DIR = path.join(TMP_HOME, 'state');

test.beforeEach(() => {
  openEventLog().prepare('DELETE FROM pending_approvals').run();
});

test.after(() => {
  reaper.stopApprovalReaper();
  try { closeEventLog(); } catch { /* best effort */ }
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function requestedAgo(approvalId: string, ms: number): void {
  openEventLog().prepare('UPDATE pending_approvals SET requested_at = ? WHERE approval_id = ?')
    .run(ago(ms), approvalId);
}

function remindersFor(approvalId: string) {
  return listNotifications(1_000).filter((item) => (
    item.metadata?.approvalId === approvalId && item.metadata?.approvalReminder === true
  ));
}

function queuedJobsFor(notificationId: string): number {
  return listQueuedNotificationDeliveries().filter((job) => job.notificationId === notificationId).length;
}

/** The notice the host raises with every formal card (loop.ts shape). */
function raiseOriginalNotice(row: { approvalId: string; sessionId: string; subject: string; tool: string | null }): void {
  addNotification({
    id: `approval-${row.approvalId}`,
    kind: 'approval',
    title: 'Approval pending',
    body: row.subject,
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { approvalId: row.approvalId, sessionId: row.sessionId, tool: row.tool },
  });
}

/** Stands in for count/age pruning: the store forgets a notification. */
function forgetNotification(id: string): void {
  const notificationsFile = path.join(STATE_DIR, 'notifications.json');
  const items = JSON.parse(readFileSync(notificationsFile, 'utf-8')) as Array<{ id: string }>;
  writeFileSync(notificationsFile, JSON.stringify(items.filter((item) => item.id !== id)));
  const queueFile = path.join(STATE_DIR, 'notification-delivery-queue.json');
  const jobs = JSON.parse(readFileSync(queueFile, 'utf-8')) as Array<{ notificationId: string }>;
  writeFileSync(queueFile, JSON.stringify(jobs.filter((job) => job.notificationId !== id)));
}

function conversationalPresentation(conversationKey: string): NewConversationalApprovalPresentation {
  const originReplyTarget = { type: 'discord_channel' as const, channelId: `${conversationKey}-channel` };
  return {
    version: 1,
    kind: 'autonomous_send_consent',
    question: 'The draft is ready. Send it to the review list?',
    actionLabel: 'message',
    target: 'review list',
    subject: 'Review',
    bodyPreview: 'Draft body',
    resultUrl: null,
    sourceUserSeq: 1,
    originReplyTarget,
    originReplyTargetDigest: exactOriginDeliveryTargetDigest(originReplyTarget),
    conversationKey,
    audienceUserId: 'owner-1',
  };
}

test('an approval still unanswered 30 minutes after it was requested gets exactly one reminder with the card content', () => {
  const session = createSession({ kind: 'chat' });
  const row = reg.register({
    sessionId: session.id,
    subject: 'Send message',
    tool: 'work_call',
    args: { name: 'send_message', args_json: JSON.stringify({ recipient: 'R-100', text: 'unused' }) },
    ttlMs: DAY_MS,
  });
  // What the card showed when it was raised, including the name it found
  // for an id. The reminder repeats this, not a fresh guess.
  appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'Clem',
    type: 'approval_requested',
    data: {
      approvalId: row.approvalId,
      subject: 'Send message',
      tool: 'work_call',
      preview: {
        operation: 'Send message',
        fields: [
          { name: 'recipient', value: 'R-100', label: 'Reviewer' },
          { name: 'text', value: 'Can you run the 4:15 review\non your own today?' },
        ],
      },
    },
  });
  raiseOriginalNotice(row);
  requestedAgo(row.approvalId, APPROVAL_REMINDER_AFTER_MS + 60_000);

  reaper.reapOnce();

  const reminders = remindersFor(row.approvalId);
  assert.equal(reminders.length, 1, 'one refreshed notice');
  assert.equal(listNotifications(1_000).filter(item => item.metadata?.approvalId === row.approvalId).length, 1,
    'the original and reminder are one approval notice');
  const [reminder] = reminders;
  assert.equal(reminder!.id, approvalReminderNotificationId(row.approvalId));
  assert.equal(reminder!.kind, 'approval', 'the reminder is the approval ask, so it settles with it');
  assert.equal(reminder!.read, false);
  assert.equal(reminder!.title, 'Still waiting on you: Send message');
  assert.match(reminder!.body, /^Clem has been waiting 31 minutes for your answer\. Nothing happens until you decide\./);
  assert.match(reminder!.body, /\nRecipient: Reviewer \(R-100\)\n/);
  assert.match(reminder!.body, /\nText: Can you run the 4:15 review on your own today\?$/);
  assert.equal(queuedJobsFor(reminder!.id), 1, 'queued for delivery like any loud notice');
  const recorded = reg.get(row.approvalId);
  assert.ok(recorded?.remindedAt, 'the approval row records that its reminder went out');
  assert.equal(recorded?.status, 'pending', 'a reminder never decides anything');

  reaper.reapOnce();
  reaper.reapOnce();
  assert.equal(remindersFor(row.approvalId).length, 1, 'still exactly one reminder after later sweeps');
  assert.equal(queuedJobsFor(reminder!.id), 1, 'and exactly one delivery job');
  assert.equal(reg.get(row.approvalId)?.remindedAt, recorded?.remindedAt);
});

test('a card raised without a preview is reminded from its exact frozen call', () => {
  const session = createSession({ kind: 'chat' });
  // The live shape: planned work wraps a broker call whose arguments are a
  // JSON string, and the card event carried no preview.
  const row = reg.register({
    sessionId: session.id,
    subject: 'Post the review note',
    tool: 'work_call',
    args: {
      name: 'composio_execute_tool',
      args_json: JSON.stringify({
        tool_slug: 'NOTES_SEND_MESSAGE',
        arguments: JSON.stringify({ channel: 'C-200', markdown_text: 'The review moved to 4:15.' }),
      }),
    },
    ttlMs: DAY_MS,
  });
  appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'Clem',
    type: 'approval_requested',
    data: { approvalId: row.approvalId, subject: 'Post the review note', tool: 'work_call' },
  });
  requestedAgo(row.approvalId, 4 * 60 * 60_000);

  reaper.reapOnce();

  const [reminder] = remindersFor(row.approvalId);
  assert.ok(reminder, 'reminded');
  assert.equal(reminder.title, 'Still waiting on you: Post the review note', 'headed like the card');
  assert.match(reminder.body, /waiting 4 hours for your answer/);
  assert.match(reminder.body, /\nChannel: C-200\n/);
  assert.match(reminder.body, /\nMarkdown text: The review moved to 4:15\.$/);
});

test('the reminder reaches the destinations the original notice named', () => {
  const session = createSession({ kind: 'chat' });
  const row = reg.register({
    sessionId: session.id, subject: 'Send the weekly summary', tool: 'write_note', ttlMs: DAY_MS,
  });
  addNotification({
    id: `approval-${row.approvalId}`,
    kind: 'approval',
    title: 'Approval pending',
    body: 'Send the weekly summary',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: {
      approvalId: row.approvalId,
      sessionId: session.id,
      tool: 'write_note',
      slackChannelId: 'C-ORIGIN',
      slackThreadTs: '1790000000.000100',
      workflowName: 'Weekly summary',
      stepId: 'send',
      discordInlineHandled: true,
    },
  });
  requestedAgo(row.approvalId, APPROVAL_REMINDER_AFTER_MS + 60_000);

  reaper.reapOnce();

  const [reminder] = remindersFor(row.approvalId);
  assert.ok(reminder, 'reminded');
  const routes = getNotificationDestinationsForRecord(reminder).map((destination) => destination.id);
  assert.ok(routes.includes('derived-slack-channel:C-ORIGIN:1790000000.000100'), 'the conversation the original named');
  assert.ok(routes.includes('derived-desktop'), 'and the desktop record');
  assert.equal(reminder.metadata?.workflowName, 'Weekly summary');
  assert.equal(reminder.metadata?.stepId, 'send');
  assert.equal(reminder.metadata?.discordInlineHandled, true,
    'the same ask retains the original inline-delivery suppression');
});

test('resolved, expired, conversational, fresh and long-stale approvals never get a reminder', () => {
  const resolved = reg.register({
    sessionId: createSession({ kind: 'chat' }).id, subject: 'Answered ask', tool: 'write_note', ttlMs: DAY_MS,
  });
  requestedAgo(resolved.approvalId, APPROVAL_REMINDER_AFTER_MS + 60_000);
  assert.equal(reg.resolve(resolved.approvalId, 'approved', 'approval-reminder-test').ok, true);

  const expired = reg.register({
    sessionId: createSession({ kind: 'chat' }).id, subject: 'Ran out', tool: 'write_note', ttlMs: DAY_MS,
  });
  openEventLog().prepare('UPDATE pending_approvals SET requested_at = ?, expires_at = ? WHERE approval_id = ?')
    .run(ago(APPROVAL_REMINDER_AFTER_MS + 60_000), ago(60_000), expired.approvalId);

  const conversational = reg.register({
    sessionId: createSession({ kind: 'chat' }).id,
    subject: 'Consent question',
    tool: 'send_message',
    ttlMs: DAY_MS,
    presentation: conversationalPresentation('reminder-test-conversation'),
  });
  assert.ok(conversational.presentation, 'precondition: a conversational consent question');
  requestedAgo(conversational.approvalId, APPROVAL_REMINDER_AFTER_MS + 60_000);

  const fresh = reg.register({
    sessionId: createSession({ kind: 'chat' }).id, subject: 'Just asked', tool: 'write_note', ttlMs: DAY_MS,
  });
  requestedAgo(fresh.approvalId, APPROVAL_REMINDER_AFTER_MS - 60_000);

  // A long-lived standing ask that already aged out of the urgent surfaces
  // (e.g. a daemon that was off for days) is not re-raised in a burst.
  const longStale = reg.register({
    sessionId: createSession({ kind: 'chat' }).id, subject: 'Standing ask', tool: 'write_note', ttlMs: 90 * DAY_MS,
  });
  requestedAgo(longStale.approvalId, reg.APPROVAL_HEADER_URGENT_WINDOW_MS + 60 * 60_000);

  reaper.reapOnce();

  assert.equal(reg.get(expired.approvalId)?.status, 'expired', 'precondition: the sweep expired it');
  for (const [label, row] of Object.entries({ resolved, expired, conversational, fresh, longStale })) {
    assert.equal(remindersFor(row.approvalId).length, 0, `${label}: no reminder`);
    assert.equal(reg.get(row.approvalId)?.remindedAt, null, `${label}: nothing recorded`);
  }
});

test('"Not now" holds the reminder until the snooze ends, and it still goes out once', async () => {
  const row = reg.register({
    sessionId: createSession({ kind: 'chat' }).id, subject: 'Set aside', tool: 'write_note', ttlMs: DAY_MS,
  });
  requestedAgo(row.approvalId, APPROVAL_REMINDER_AFTER_MS + 60_000);
  await snoozeHomeItem(`approval:${row.approvalId}`, 1);

  reaper.reapOnce();
  assert.equal(remindersFor(row.approvalId).length, 0, 'no reminder while the owner said not now');

  const afterSnooze = Date.now() + 61 * 60_000;
  reaper.reapOnce({ nowMs: afterSnooze });
  assert.equal(remindersFor(row.approvalId).length, 1, 'one reminder once the snooze ends');
  reaper.reapOnce({ nowMs: afterSnooze + 60_000 });
  assert.equal(remindersFor(row.approvalId).length, 1, 'and only one');
});

test('a restart never sends the reminder again, even after the store forgot the notification', () => {
  const row = reg.register({
    sessionId: createSession({ kind: 'chat' }).id, subject: 'Survives restarts', tool: 'write_note', ttlMs: DAY_MS,
  });
  requestedAgo(row.approvalId, APPROVAL_REMINDER_AFTER_MS + 60_000);
  reaper.reapOnce();
  assert.equal(remindersFor(row.approvalId).length, 1, 'precondition: reminded once');
  const remindedAt = reg.get(row.approvalId)?.remindedAt;
  assert.ok(remindedAt);

  // Take away the notification-id guard so only the durable approval row can
  // stop a second send, then restart: the daemon's boot sweep runs at once.
  forgetNotification(approvalReminderNotificationId(row.approvalId));
  reaper.stopApprovalReaper();
  const stop = reaper.startApprovalReaper({ immediate: true });
  stop();

  assert.equal(remindersFor(row.approvalId).length, 0, 'no second reminder after the restart');
  assert.equal(queuedJobsFor(approvalReminderNotificationId(row.approvalId)), 0);
  assert.equal(reg.get(row.approvalId)?.remindedAt, remindedAt);
});

test('a crash between sending the reminder and recording it cannot send it twice', () => {
  const row = reg.register({
    sessionId: createSession({ kind: 'chat' }).id, subject: 'Crash window', tool: 'write_note', ttlMs: DAY_MS,
  });
  requestedAgo(row.approvalId, APPROVAL_REMINDER_AFTER_MS + 60_000);
  reaper.reapOnce();
  const [first] = remindersFor(row.approvalId);
  assert.ok(first);

  // The process died after the notification was written, before the row
  // recorded it. The retry comes a sweep later, so its wording differs
  // ("33 minutes"): only the stable notification id can keep it one notice.
  openEventLog().prepare('UPDATE pending_approvals SET reminded_at = NULL WHERE approval_id = ?').run(row.approvalId);
  reaper.reapOnce({ nowMs: Date.now() + 2 * 60_000 });

  const reminders = remindersFor(row.approvalId);
  assert.equal(reminders.length, 1, 'still one reminder');
  assert.equal(reminders[0]!.createdAt, first.createdAt, 'the same notice, not a new one');
  assert.equal(queuedJobsFor(first.id), 1, 'still one delivery job');
  assert.ok(reg.get(row.approvalId)?.remindedAt, 'the retry records it');
});
