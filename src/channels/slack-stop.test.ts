/**
 * Run: npx tsx --test src/channels/slack-stop.test.ts
 *
 * Durable Slack/AI-Assistant Stop controls. These tests intentionally clear
 * process-local channel continuity before dispatch so only SQLite can identify
 * the run the user meant to stop.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-slack-stop-'));
const PREV_HOME = process.env.CLEMENTINE_HOME;
process.env.CLEMENTINE_HOME = TMP_HOME;

const { __test__ } = await import('./slack.js');
const {
  bindDiscordHarnessSession,
  clearDiscordHarnessSession,
} = await import('./discord-harness.js');
const {
  beginRunAttempt,
  createSession,
  getActiveRunAttempt,
  getKillRequest,
  getSession,
  isKillRequested,
} = await import('../runtime/harness/eventlog.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { HarnessSession } = await import('../runtime/harness/session.js');

after(() => {
  if (PREV_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PREV_HOME;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function fakeSlackClient() {
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        return { ts: `${posts.length}.000` };
      },
      update: async () => ({}),
    },
  };
  return { client, posts };
}

test('Slack AI Assistant stop rehydrates and exact-kills the bound attempt after restart', async () => {
  const channelId = 'C-STOP';
  const threadTs = '1700000000.000100';
  const conversationId = `${channelId}:${threadTs}`;
  const session = createSession({
    kind: 'chat',
    channel: 'slack',
    userId: 'U-STOP',
    metadata: { source: 'slack', channelId: conversationId, userId: 'U-STOP', guildId: 'T-STOP' },
  });
  assert.equal(bindDiscordHarnessSession({ channelId: conversationId, sessionId: session.id, userId: 'U-STOP' }), true);
  const attempt = beginRunAttempt(session.id);
  clearDiscordHarnessSession(conversationId);

  const { client, posts } = fakeSlackClient();
  const statuses: string[] = [];
  await __test__.dispatchInbound({
    client: client as never,
    channelId,
    userId: 'U-STOP',
    teamId: 'T-STOP',
    ts: '1700000001.000100',
    threadTs,
    prompt: 'stop',
    setStatus: async (status: string) => { statuses.push(status); },
  });

  assert.equal(posts.length, 1, 'control is answered once instead of starting a model turn');
  assert.match(String(posts[0].text), /Stopping the current Slack run/);
  assert.equal(getActiveRunAttempt(session.id)?.attemptId, attempt.attemptId, 'Stop must not mint/supersede an attempt');
  assert.equal(isKillRequested(session.id, attempt), true);
  assert.equal(getKillRequest(session.id, attempt)?.attemptId, attempt.attemptId);
  assert.deepEqual(statuses, [], 'a control reply does not start/churn the AI Assistant work indicator');
});

test('bare Slack stop rejects the relevant pending approval before run cancellation', async () => {
  const channelId = 'D-APPROVAL';
  const session = createSession({
    kind: 'chat',
    channel: 'slack',
    userId: 'U-APPROVAL',
    metadata: { source: 'slack', channelId, userId: 'U-APPROVAL' },
  });
  assert.equal(bindDiscordHarnessSession({ channelId, sessionId: session.id, userId: 'U-APPROVAL' }), true);
  const approval = approvalRegistry.register({
    sessionId: session.id,
    channel: 'slack',
    channelId,
    subject: 'Send the client update',
    tool: 'request_approval',
  });

  const { client, posts } = fakeSlackClient();
  await __test__.dispatchInbound({
    client: client as never,
    channelId,
    userId: 'U-APPROVAL',
    ts: '1700000002.000100',
    prompt: 'stop',
  });

  assert.equal(approvalRegistry.get(approval.approvalId)?.resolution, 'rejected');
  assert.equal(posts.length, 1);
  assert.match(String(posts[0].text), /rejected/i);
});

test('/cancel exact-stops and abandons a paused Slack approval instead of leaving it pending', async () => {
  const channelId = 'D-PAUSED-CANCEL';
  const session = createSession({
    kind: 'chat',
    channel: 'slack',
    userId: 'U-PAUSED-CANCEL',
    metadata: { source: 'slack', channelId, userId: 'U-PAUSED-CANCEL' },
  });
  assert.equal(bindDiscordHarnessSession({ channelId, sessionId: session.id, userId: 'U-PAUSED-CANCEL' }), true);
  HarnessSession.load(session.id)!.saveInterruptState('{"paused":true}');
  const approval = approvalRegistry.register({
    sessionId: session.id,
    channel: 'slack',
    channelId,
    subject: 'Publish the client update',
    tool: 'request_approval',
  });
  const attempt = beginRunAttempt(session.id);
  clearDiscordHarnessSession(channelId);

  const { client, posts } = fakeSlackClient();
  await __test__.dispatchInbound({
    client: client as never,
    channelId,
    userId: 'U-PAUSED-CANCEL',
    ts: '1700000003.000100',
    prompt: '/cancel',
  });

  assert.equal(isKillRequested(session.id, attempt), true, 'the still-live paused attempt is exact-stopped');
  assert.equal(
    approvalRegistry.get(approval.approvalId)?.resolution,
    'cancelled_by_user',
    JSON.stringify({ posts, session: getSession(session.id), interrupt: HarnessSession.load(session.id)?.loadInterruptState() }),
  );
  assert.equal(HarnessSession.load(session.id)?.loadInterruptState(), null);
  assert.equal(getSession(session.id)?.status, 'cancelled');
  assert.equal(posts.length, 1);
  assert.match(String(posts[0].text), /Cancelled/);
});

test('Slack stop control vocabulary is exact and preserves /cancel fallback', () => {
  assert.deepEqual(__test__.parseSlackRunStopControl('/cancel'), {
    fallbackToPausedCancel: true,
    rejectRelevantApprovalFirst: false,
  });
  assert.deepEqual(__test__.parseSlackRunStopControl('cancel'), {
    fallbackToPausedCancel: true,
    rejectRelevantApprovalFirst: true,
  });
  for (const command of ['stop', 'halt', 'abort', 'cancel run', 'cancel-run', 'cancel the run', 'stop the run']) {
    assert.ok(__test__.parseSlackRunStopControl(command), command);
  }
  assert.equal(__test__.parseSlackRunStopControl('stop by the store on your way home'), null);
  assert.equal(__test__.parseSlackRunStopControl('can you cancel the run if it fails?'), null);
});
