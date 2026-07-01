// Characterization test for the 2026-06-29 "workflow output reached Discord but
// not Slack" incident. A scheduled workflow notification carries no origin
// channel and no routing metadata, so it routes ONLY via the per-surface DM
// fallback. Previously the Discord and Slack fallbacks both gated on
// `combined.length === 0`, and since Discord is evaluated first it shadowed
// Slack — so with both surfaces configured, only Discord ever received it.
// These envs must be set BEFORE config.js loads (the channel flags are module
// constants), so this lives in its own file.
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-notif-parity-'));
process.env.DISCORD_ENABLED = 'true';
process.env.DISCORD_BOT_TOKEN = 'xoxb-test-discord';
process.env.DISCORD_DM_ALLOWED_USERS = 'D_PRIMARY';
process.env.SLACK_ENABLED = 'true';
process.env.SLACK_BOT_TOKEN = 'xoxb-test-slack';
process.env.SLACK_ALLOWED_USERS = 'U_PRIMARY';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { getNotificationDestinationsForRecord } = await import('./notifications.js');

function record(metadata?: Record<string, unknown>, silent = false) {
  return {
    id: 'n1', kind: 'workflow', title: 't', body: 'b',
    createdAt: new Date(0).toISOString(), read: false, silent, metadata,
  } as never;
}

test('no-origin notification fans out to BOTH Discord and Slack fallbacks (parity, de-shadowed)', () => {
  // Mirrors this morning's scorpion metadata: a run id, but no channel/userId.
  const dests = getNotificationDestinationsForRecord(
    record({ source: 'notify_user_tool', workflowRunId: 'sched-x' }),
  );
  const types = dests.map((d) => d.type);
  assert.ok(types.includes('discord_user'), 'Discord fallback still fires');
  assert.ok(types.includes('slack_user'), 'Slack fallback now also fires (was shadowed before the fix)');
});

test('an explicit Discord destination suppresses BOTH fallbacks (no duplicate Slack DM for a Discord-origin run)', () => {
  const dests = getNotificationDestinationsForRecord(
    record({ discordChannelId: 'C123' }),
  );
  const ids = dests.map((d) => d.id);
  assert.ok(dests.some((d) => d.type === 'discord_channel'), 'derived Discord channel present');
  assert.ok(!ids.some((id) => id.startsWith('fallback-')), 'no fallback fires when a real destination routed it');
});

test('an explicit Slack thread destination preserves thread identity and suppresses fallbacks', () => {
  const dests = getNotificationDestinationsForRecord(
    record({ slackChannelId: 'C_SLACK', slackThreadTs: '1700000000.000100' }),
  );
  const slack = dests.find((d) => d.type === 'slack_channel');
  assert.equal(slack?.channelId, 'C_SLACK');
  assert.equal(slack?.threadTs, '1700000000.000100');
  assert.ok(!dests.some((d) => d.id.startsWith('fallback-')), 'no fallback fires when the Slack thread routed it');
});
