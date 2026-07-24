/**
 * Run: npx tsx --test src/channels/discord-harness-background.test.ts
 *
 * Focused parity coverage for Discord/Slack background handoff replies. These
 * tests keep their own CLEMENTINE_HOME so they never touch local daemon state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-discord-bg-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { __test__ } = await import('./discord-harness.js');
const {
  createBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  markBackgroundTaskAwaitingContinue,
  markBackgroundTaskAwaitingInput,
} = await import('../execution/background-tasks.js');
const {
  createSession,
  getActiveRunAttempt,
  isKillRequested,
  recordRunAttemptUserInput,
} = await import('../runtime/harness/eventlog.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function transport() {
  const sent: string[] = [];
  return {
    sent,
    api: {
      async sendInitial(content: string) {
        sent.push(content);
        return { async edit() { /* no-op */ } };
      },
      async sendError(content: string) {
        sent.push(`error:${content}`);
      },
    },
  };
}

test('Discord/Slack parked background question captures the next freeform reply', async () => {
  const origin = createSession({ kind: 'chat', channel: 'discord' });
  const task = createBackgroundTask({
    title: 'Segment prospects',
    prompt: 'finish the prospect segment',
    originSessionId: origin.id,
    channel: 'discord:chan-a',
    source: 'discord',
  });
  markBackgroundTaskAwaitingInput(task.id, 'q-bg-discord', 'Which segment should I use?');

  const tx = transport();
  const handled = await __test__.maybeRouteParkedBackgroundReply({
    sessionId: origin.id,
    message: 'healthcare only',
    transport: tx.api,
  });

  assert.equal(handled, true);
  const stored = getBackgroundTask(task.id);
  assert.equal(stored?.status, 'pending');
  assert.equal(stored?.inputResolution?.answer, 'healthcare only');
  assert.match(tx.sent[0], /Answer sent to "Segment prospects"/);
});

test('Discord/Slack continue resumes one parked background continuation', async () => {
  const origin = createSession({ kind: 'chat', channel: 'slack' });
  const task = createBackgroundTask({
    title: 'Long report',
    prompt: 'continue the report',
    originSessionId: origin.id,
    channel: 'slack:chan-a',
    source: 'slack',
  });
  markBackgroundTaskAwaitingContinue(task.id, 'turn budget', 'partial work');

  const tx = transport();
  const handled = await __test__.maybeRouteParkedBackgroundReply({
    sessionId: origin.id,
    message: 'continue',
    transport: tx.api,
  });

  assert.equal(handled, true);
  const stored = getBackgroundTask(task.id);
  assert.equal(stored?.status, 'pending');
  assert.ok(stored?.continueResolution, 'continue request should be queued');
  assert.match(tx.sent[0], /Continuing background task "Long report"/);
});

test('stale Discord channel mapping still captures one parked background question by exact channel', async () => {
  const origin = createSession({ kind: 'chat', channel: 'discord' });
  const task = createBackgroundTask({
    title: 'Stale channel question',
    prompt: 'finish the stale channel task',
    originSessionId: origin.id,
    channel: 'discord:chan-stale-question',
    source: 'discord',
  });
  markBackgroundTaskAwaitingInput(task.id, 'q-bg-stale-channel', 'Which market?');

  const tx = transport();
  const handled = await __test__.maybeRouteParkedBackgroundReply({
    channelLabel: 'discord:chan-stale-question',
    channelId: 'chan-stale-question',
    channel: 'discord',
    message: 'Birmingham',
    transport: tx.api,
  });

  assert.equal(handled, true);
  const stored = getBackgroundTask(task.id);
  assert.equal(stored?.status, 'pending');
  assert.equal(stored?.inputResolution?.answer, 'Birmingham');
  assert.match(tx.sent[0], /Answer sent to "Stale channel question"/);
});

test('stale Slack channel mapping still resumes one parked background continuation', async () => {
  const origin = createSession({ kind: 'chat', channel: 'slack' });
  const task = createBackgroundTask({
    title: 'Stale Slack continue',
    prompt: 'finish the Slack report',
    originSessionId: origin.id,
    channel: 'slack:chan-stale-continue',
    source: 'slack',
  });
  markBackgroundTaskAwaitingContinue(task.id, 'turn budget', 'partial work');

  const tx = transport();
  const handled = await __test__.maybeRouteParkedBackgroundReply({
    channelLabel: 'slack:chan-stale-continue',
    channelId: 'chan-stale-continue',
    channel: 'slack',
    message: 'continue',
    transport: tx.api,
  });

  assert.equal(handled, true);
  const stored = getBackgroundTask(task.id);
  assert.equal(stored?.status, 'pending');
  assert.ok(stored?.continueResolution, 'continue request should be queued');
  assert.match(tx.sent[0], /Continuing background task "Stale Slack continue"/);
});

test('stale channel fallback uses origin session metadata for tasks without stored channel', async () => {
  const origin = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId: 'chan-meta-fallback' },
  });
  const task = createBackgroundTask({
    title: 'Metadata fallback question',
    prompt: 'finish metadata fallback task',
    originSessionId: origin.id,
    source: 'desktop',
  });
  markBackgroundTaskAwaitingInput(task.id, 'q-bg-metadata-fallback', 'Which city?');

  const tx = transport();
  const handled = await __test__.maybeRouteParkedBackgroundReply({
    channelLabel: 'discord:chan-meta-fallback',
    channelId: 'chan-meta-fallback',
    channel: 'discord',
    message: 'Austin',
    transport: tx.api,
  });

  assert.equal(handled, true);
  const stored = getBackgroundTask(task.id);
  assert.equal(stored?.status, 'pending');
  assert.equal(stored?.inputResolution?.answer, 'Austin');
  assert.match(tx.sent[0], /Answer sent to "Metadata fallback question"/);
});

test('stale channel fallback does not cross-match discordChannelId across surfaces', async () => {
  const origin = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', discordChannelId: 'shared-raw-id' },
  });
  const task = createBackgroundTask({
    title: 'Discord-only question',
    prompt: 'finish the Discord task',
    originSessionId: origin.id,
    source: 'desktop',
  });
  markBackgroundTaskAwaitingInput(task.id, 'q-bg-cross-surface', 'Which segment?');

  const tx = transport();
  const handled = await __test__.maybeRouteParkedBackgroundReply({
    channelLabel: 'slack:shared-raw-id',
    channelId: 'shared-raw-id',
    channel: 'slack',
    message: 'healthcare',
    transport: tx.api,
  });

  assert.equal(handled, false);
  assert.equal(tx.sent.length, 0);
  assert.equal(getBackgroundTask(task.id)?.status, 'awaiting_input');
});

test('session rehydration does not cross-match discordChannelId across surfaces', async () => {
  const discord = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', discordChannelId: 'shared-session-id' },
  });
  assert.equal(__test__.findMostRecentChannelSession('shared-session-id', 'slack'), null);
  assert.equal(__test__.findMostRecentChannelSession('shared-session-id', 'discord')?.sessionId, discord.id);
});

test('stale channel fallback refuses ambiguous parked background questions', async () => {
  const first = createSession({ kind: 'chat', channel: 'discord' });
  const second = createSession({ kind: 'chat', channel: 'discord' });
  const taskA = createBackgroundTask({
    title: 'Ambiguous A',
    prompt: 'first ambiguous task',
    originSessionId: first.id,
    channel: 'discord:chan-ambiguous',
    source: 'discord',
  });
  const taskB = createBackgroundTask({
    title: 'Ambiguous B',
    prompt: 'second ambiguous task',
    originSessionId: second.id,
    channel: 'discord:chan-ambiguous',
    source: 'discord',
  });
  markBackgroundTaskAwaitingInput(taskA.id, 'q-bg-ambiguous-a', 'First question?');
  markBackgroundTaskAwaitingInput(taskB.id, 'q-bg-ambiguous-b', 'Second question?');

  const tx = transport();
  const handled = await __test__.maybeRouteParkedBackgroundReply({
    channelLabel: 'discord:chan-ambiguous',
    channelId: 'chan-ambiguous',
    channel: 'discord',
    message: 'use healthcare',
    transport: tx.api,
  });

  assert.equal(handled, false);
  assert.equal(tx.sent.length, 0);
  assert.equal(getBackgroundTask(taskA.id)?.status, 'awaiting_input');
  assert.equal(getBackgroundTask(taskB.id)?.status, 'awaiting_input');
});

test('typed background control moves the prior exact channel attempt without registering a control attempt', async () => {
  const channelId = 'chan-exact-background-control';
  const userId = 'user-exact-background-control';
  const session = createSession({
    kind: 'chat',
    channel: `discord:${channelId}`,
    userId,
    metadata: { channelId },
  });
  const active = __test__.registerActiveChannelRunForTest({
    channel: 'discord',
    channelId,
    userId,
    guildId: null,
    sessionId: session.id,
  });
  recordRunAttemptUserInput(active, {
    turn: 0,
    role: 'user',
    data: { text: 'research the firm and prepare its document' },
  });
  const before = listBackgroundTasks({ includeArchived: true }).length;
  const tx = transport();
  try {
    const handled = await __test__.tryHandleBackgroundItControl({
      message: 'background it',
      channelId,
      userId,
      guildId: null,
      channel: 'discord',
      channelLabel: `discord:${channelId}`,
      transport: tx.api,
    });

    assert.equal(handled, true);
    assert.equal(getActiveRunAttempt(session.id)?.attemptId, active.attemptId, 'the control does not mint/supersede an attempt');
    assert.equal(isKillRequested(session.id, active), true, 'the prior exact attempt receives the handoff stop');
    const created = listBackgroundTasks({ includeArchived: true }).slice(0, 1)[0];
    assert.equal(listBackgroundTasks({ includeArchived: true }).length, before + 1);
    assert.equal(created.foregroundHandoff?.attemptId, active.attemptId);
    assert.equal(created.source, 'discord');
    assert.equal(created.channel, `discord:${channelId}`);
    assert.match(tx.sent[0], /moving .* to the background/i);
  } finally {
    __test__.unregisterActiveChannelRunForTest(active, 'cancelled');
  }
});

test('typed background control fails closed when no exact channel attempt is active', async () => {
  const tx = transport();
  const handled = await __test__.tryHandleBackgroundItControl({
    message: 'background it',
    channelId: 'chan-no-background-run',
    userId: 'user-no-background-run',
    guildId: null,
    channel: 'discord',
    channelLabel: 'discord:chan-no-background-run',
    transport: tx.api,
  });
  assert.equal(handled, true);
  assert.match(tx.sent[0], /could not find a running turn/i);
});

test('typed background control explains that a pending approval must be resolved first', async () => {
  const channelId = 'chan-approval-background-control';
  const userId = 'user-approval-background-control';
  const session = createSession({
    kind: 'chat',
    channel: `discord:${channelId}`,
    userId,
    metadata: { channelId },
  });
  const active = __test__.registerActiveChannelRunForTest({
    channel: 'discord',
    channelId,
    userId,
    guildId: null,
    sessionId: session.id,
  });
  recordRunAttemptUserInput(active, {
    turn: 0,
    role: 'user',
    data: { text: 'send the client email after approval' },
  });
  const approval = approvalRegistry.register({
    sessionId: session.id,
    channel: 'discord',
    channelId,
    subject: 'Send the client email',
    tool: 'OUTLOOK_SEND_EMAIL',
    args: { to: 'client@example.com' },
  });
  const before = listBackgroundTasks({ includeArchived: true }).length;
  const tx = transport();
  try {
    const handled = await __test__.tryHandleBackgroundItControl({
      message: 'background it',
      channelId,
      userId,
      guildId: null,
      channel: 'discord',
      channelLabel: `discord:${channelId}`,
      transport: tx.api,
    });

    assert.equal(handled, true);
    assert.equal(listBackgroundTasks({ includeArchived: true }).length, before);
    assert.equal(isKillRequested(session.id, active), false);
    assert.match(tx.sent[0], /waiting on an approval/i);
    assert.match(tx.sent[0], /approve or reject/i);
  } finally {
    approvalRegistry.resolve(approval.approvalId, 'cancelled_by_user', 'test-cleanup');
    __test__.unregisterActiveChannelRunForTest(active, 'cancelled');
  }
});
