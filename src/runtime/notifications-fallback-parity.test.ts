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

const { getNotificationDestinationsForRecord, upsertWebPushDestination, removeWebPushDestinationByEndpoint, addNotification, listQueuedNotificationDeliveries, getNotification } = await import('./notifications.js');

test('Wave 3 Move B: a TERMINAL origin_chat report-back pings the user\'s own web-push devices; non-terminal + kill-switch stay silent', () => {
  const endpoint = 'https://push.example/dev1';
  upsertWebPushDestination({ endpoint, p256dh: 'k', auth: 'a', deviceId: 'dev1' });
  try {
    const origin = (extra: Record<string, unknown>) => getNotificationDestinationsForRecord(
      record({ reportBackTargetType: 'origin_chat', ...extra }),
    );
    // Terminal completion → the user's registered devices get pinged (never a channel).
    assert.deepEqual(origin({ terminalReportBack: true }).map((d) => d.type), ['web_push'], 'terminal report-back pings web-push only');
    // A non-terminal in-app notification (heartbeat/progress) stays silent.
    assert.equal(origin({}).length, 0, 'non-terminal origin_chat notification pushes nothing');
    // Kill-switch restores the silent behavior even for a terminal report-back.
    const prev = process.env.CLEMMY_REPORTBACK_PUSH;
    process.env.CLEMMY_REPORTBACK_PUSH = 'off';
    try {
      assert.equal(origin({ terminalReportBack: true }).length, 0, 'kill-switch off → no web-push');
    } finally {
      if (prev === undefined) delete process.env.CLEMMY_REPORTBACK_PUSH; else process.env.CLEMMY_REPORTBACK_PUSH = prev;
    }
  } finally {
    removeWebPushDestinationByEndpoint(endpoint); // isolation: don't leak into the parity tests
  }
});

test('Wave 3 Move B (LIVE PATH): a TERMINAL origin_chat report-back is ENQUEUED so the delivery worker resolves web-push — not just resolvable in isolation', () => {
  // The unit test above proves the resolver returns web_push, but the resolver's
  // ONLY production caller is the delivery-queue worker — so unless the record is
  // actually enqueued, the branch is dead code and the away-user ping never fires
  // (the Wave-3 adversarial-review finding). This drives the REAL addNotification
  // path and asserts a delivery job exists.
  const endpoint = 'https://push.example/live-dev';
  upsertWebPushDestination({ endpoint, p256dh: 'k', auth: 'a', deviceId: 'live-dev' });
  try {
    // Terminal report-back WITH a registered device → enqueued + resolves web_push.
    const doneId = 'movb-live-done-1';
    addNotification({
      id: doneId, kind: 'execution', title: 'Background task completed', body: 'b',
      createdAt: new Date(0).toISOString(), read: false,
      metadata: { reportBackTargetType: 'origin_chat', terminalReportBack: true },
    } as never);
    assert.ok(
      listQueuedNotificationDeliveries().some((j) => j.notificationId === doneId),
      'terminal origin_chat report-back is enqueued for delivery',
    );
    assert.deepEqual(
      getNotificationDestinationsForRecord(getNotification(doneId)!).map((d) => d.type),
      ['web_push'],
      'the worker resolves web_push (never a Discord/Slack channel) for it',
    );

    // A NON-terminal origin_chat notification (heartbeat/progress) is NOT enqueued.
    const beatId = 'movb-live-beat-1';
    addNotification({
      id: beatId, kind: 'execution', title: 'heartbeat', body: 'b',
      createdAt: new Date(0).toISOString(), read: false,
      metadata: { reportBackTargetType: 'origin_chat' },
    } as never);
    assert.ok(
      !listQueuedNotificationDeliveries().some((j) => j.notificationId === beatId),
      'non-terminal origin_chat stays transcript-only (not enqueued)',
    );

    // Kill-switch off → a terminal report-back is NOT enqueued either.
    const prev = process.env.CLEMMY_REPORTBACK_PUSH;
    process.env.CLEMMY_REPORTBACK_PUSH = 'off';
    try {
      const killId = 'movb-live-kill-1';
      addNotification({
        id: killId, kind: 'execution', title: 'Background task completed', body: 'b',
        createdAt: new Date(0).toISOString(), read: false,
        metadata: { reportBackTargetType: 'origin_chat', terminalReportBack: true },
      } as never);
      assert.ok(
        !listQueuedNotificationDeliveries().some((j) => j.notificationId === killId),
        'kill-switch off → terminal report-back not enqueued',
      );
    } finally {
      if (prev === undefined) delete process.env.CLEMMY_REPORTBACK_PUSH; else process.env.CLEMMY_REPORTBACK_PUSH = prev;
    }
  } finally {
    removeWebPushDestinationByEndpoint(endpoint);
  }
});

test('Wave 3 Move B: with NO web-push device registered, a terminal origin_chat report-back stays transcript-only (no perpetually-deferred job)', () => {
  const noDevId = 'movb-nodev-1';
  addNotification({
    id: noDevId, kind: 'execution', title: 'Background task completed', body: 'b',
    createdAt: new Date(0).toISOString(), read: false,
    metadata: { reportBackTargetType: 'origin_chat', terminalReportBack: true },
  } as never);
  assert.ok(
    !listQueuedNotificationDeliveries().some((j) => j.notificationId === noDevId),
    'no web_push device → not enqueued (would otherwise sit deferred with no destination)',
  );
});

function record(metadata?: Record<string, unknown>, silent = false) {
  return {
    id: 'n1', kind: 'workflow', title: 't', body: 'b',
    createdAt: new Date(0).toISOString(), read: false, silent, metadata,
  } as never;
}

test('no-origin notification fans out to BOTH Discord and Slack fallbacks (parity, de-shadowed)', () => {
  // Mirrors this morning's acme metadata: a run id, but no channel/userId.
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
