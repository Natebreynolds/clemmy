/**
 * Run: npx tsx --test src/tools/background-task-tools.test.ts
 *
 * Focused provenance tests for dispatch_background_task. The tool should carry
 * the origin chat's surface/channel into the durable task record so report-back,
 * notifications, and stale-channel reply routing behave like manual promotion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-bg-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { backgroundRouteForOriginSession } = await import('./background-task-tools.js');
const { createSession } = await import('../runtime/harness/eventlog.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('backgroundRouteForOriginSession derives Discord source/channel/user', () => {
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    userId: 'user-1',
    metadata: { source: 'discord', channelId: 'chan-1' },
  });

  assert.deepEqual(backgroundRouteForOriginSession(session.id), {
    source: 'discord',
    channel: 'discord:chan-1',
    userId: 'user-1',
  });
});

test('backgroundRouteForOriginSession supports Slack sessions with historical discordChannelId metadata', () => {
  const session = createSession({
    kind: 'chat',
    channel: 'slack',
    metadata: { source: 'slack', discordChannelId: 'slack-thread-1', userId: 'slack-user-1' },
  });

  assert.deepEqual(backgroundRouteForOriginSession(session.id), {
    source: 'slack',
    channel: 'slack:slack-thread-1',
    userId: 'slack-user-1',
  });
});

test('backgroundRouteForOriginSession preserves explicit Slack thread metadata', () => {
  const session = createSession({
    kind: 'chat',
    channel: 'slack',
    metadata: {
      source: 'slack',
      slackChannelId: 'C123',
      slackThreadTs: '1700000000.000100',
      slackUserId: 'U123',
    },
  });

  assert.deepEqual(backgroundRouteForOriginSession(session.id), {
    source: 'slack',
    channel: 'slack:C123:1700000000.000100',
    userId: 'U123',
  });
});

test('backgroundRouteForOriginSession falls back to desktop for unknown or missing sessions', () => {
  assert.deepEqual(backgroundRouteForOriginSession('missing-session'), { source: 'desktop' });

  const session = createSession({ kind: 'chat', channel: 'electron' });
  assert.deepEqual(backgroundRouteForOriginSession(session.id), {
    source: 'desktop',
    channel: 'electron',
    userId: undefined,
  });
});
