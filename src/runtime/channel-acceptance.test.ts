/**
 * Run: npx tsx --test src/runtime/channel-acceptance.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChannelAcceptance } from './channel-acceptance.js';
import type { NotificationDestination } from './notifications.js';

function destination(partial: Partial<NotificationDestination>): NotificationDestination {
  return {
    id: partial.id ?? `dest-${partial.type ?? 'discord_channel'}`,
    name: partial.name ?? 'Destination',
    type: partial.type ?? 'discord_channel',
    enabled: partial.enabled ?? true,
    createdAt: '2026-07-03T10:00:00.000Z',
    ...partial,
  };
}

test('runChannelAcceptance ignores non Slack/Discord routes and skips disabled routes', async () => {
  const report = await runChannelAcceptance({
    now: () => '2026-07-03T10:00:00.000Z',
    destinations: [
      destination({ id: 'generic', type: 'generic_webhook', url: 'https://example.test/hook' }),
      destination({ id: 'slack-off', type: 'slack_user', enabled: false, userId: 'U123' }),
    ],
    deliver: async () => {
      throw new Error('should not send');
    },
  });

  assert.equal(report.status, 'skipped');
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]?.id, 'slack-off');
  assert.equal(report.results[0]?.status, 'skipped');
});

test('runChannelAcceptance aggregates live delivery pass and fail outcomes', async () => {
  const sent: string[] = [];
  const report = await runChannelAcceptance({
    now: () => '2026-07-03T10:00:00.000Z',
    destinations: [
      destination({ id: 'slack', type: 'slack_channel', channelId: 'C123' }),
      destination({ id: 'discord', type: 'discord_channel', channelId: 'D456' }),
    ],
    deliver: async (dest) => {
      sent.push(dest.id);
      if (dest.id === 'discord') throw new Error('Discord client is offline');
    },
  });

  assert.deepEqual(sent, ['slack', 'discord']);
  assert.equal(report.status, 'failed');
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.results.find((result) => result.id === 'discord')?.message, 'Discord client is offline');
});
