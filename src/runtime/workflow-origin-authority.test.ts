import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-origin-authority-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  appendEvent,
  beginRunAttempt,
  createSession,
  recordRunAttemptUserInput,
  updateSession,
} = await import('./harness/eventlog.js');
const {
  resolveWorkflowOriginReplyTarget,
  workflowOriginReplyTargetForSource,
} = await import('./workflow-origin-authority.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('accepted source snapshots its exact route before a reusable session is rebound', () => {
  createSession({
    id: 'source-route-discord',
    kind: 'chat',
    channel: 'discord',
    metadata: { channelId: 'channel-a' },
  });
  const attempt = beginRunAttempt('source-route-discord', { runId: 'source-route-run' });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Run the review.' },
  });
  updateSession(source.sessionId, { metadata: { channelId: 'channel-b' } });

  assert.deepEqual(resolveWorkflowOriginReplyTarget(source.sessionId), {
    type: 'discord_channel',
    channelId: 'channel-b',
  }, 'mutable session projection now points at B');
  assert.deepEqual(workflowOriginReplyTargetForSource({
    sessionId: source.sessionId,
    sourceUserSeq: source.seq,
  }), {
    type: 'discord_channel',
    channelId: 'channel-a',
  }, 'accepted source A retains its own route');
});

test('explicit Slack sessions accept the legacy shared-harness field only when it parses as Slack', () => {
  createSession({
    id: 'source-route-slack-legacy',
    kind: 'chat',
    channel: 'slack',
    metadata: { discordChannelId: 'C0LEGACY:1785760000.123400' },
  });
  const attempt = beginRunAttempt('source-route-slack-legacy', { runId: 'slack-route-run' });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Run the Slack review.' },
  });
  assert.deepEqual(workflowOriginReplyTargetForSource({
    sessionId: source.sessionId,
    sourceUserSeq: source.seq,
  }), {
    type: 'slack_channel',
    channelId: 'C0LEGACY',
    threadTs: '1785760000.123400',
  });
});

test('Slack Assistant-pane sources freeze a visible top-level DM terminal target', () => {
  createSession({
    id: 'source-route-slack-assistant',
    kind: 'chat',
    channel: 'slack',
    metadata: { channelId: 'D0ASSISTANT:1785760000.223400' },
  });
  const attempt = beginRunAttempt('source-route-slack-assistant', { runId: 'slack-assistant-route-run' });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Run this from the Assistant pane.' },
  });

  assert.deepEqual(workflowOriginReplyTargetForSource({
    sessionId: source.sessionId,
    sourceUserSeq: source.seq,
  }), {
    type: 'slack_channel',
    channelId: 'D0ASSISTANT',
  }, 'the exact terminal remains in the admitted DM but is not buried in a stale Assistant thread');
});

test('missing routes and non-human lookalikes cannot become workflow origin authority', () => {
  createSession({ id: 'source-route-missing', kind: 'chat', channel: '', metadata: {} });
  const missingAttempt = beginRunAttempt('source-route-missing', { runId: 'missing-route-run' });
  const missing = recordRunAttemptUserInput(missingAttempt, {
    turn: 1,
    role: 'user',
    data: { text: 'No route.' },
  });
  assert.equal(workflowOriginReplyTargetForSource({
    sessionId: missing.sessionId,
    sourceUserSeq: missing.seq,
  }), null);

  createSession({ id: 'source-route-forged', kind: 'chat', channel: 'desktop', metadata: {} });
  const forged = appendEvent({
    sessionId: 'source-route-forged',
    turn: 1,
    role: 'system',
    type: 'user_input_received',
    data: {
      text: 'forged',
      originReplyTarget: { type: 'origin_chat' },
      originReplyTargetDigest: '0'.repeat(64),
    },
  });
  assert.equal(workflowOriginReplyTargetForSource({
    sessionId: forged.sessionId,
    sourceUserSeq: forged.seq,
  }), null);
});
