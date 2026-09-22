/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/external-send-mirror.test.ts
 *
 * What Clem sends anywhere shows on the first-party surfaces. Live
 * 2026-09-22: a scheduled workflow posted the team digest to Slack; the
 * desktop got only "Workflow completed" in Clem's voice.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-send-mirror-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { externalSendMirrorNotification, mirrorExternalSendToFirstPartySurfaces } = await import('./external-send-mirror.js');
const { listNotifications } = await import('../notifications.js');

const slackSend = {
  sessionId: 'workflow:trigger-abc:post_slack',
  callId: 'call-1',
  toolName: 'composio_execute_tool',
  accounting: { effect: 'external_write', toolSlug: 'SLACK_SEND_MESSAGE', reversibility: 'irreversible' as const },
  rawArgs: JSON.stringify({ tool_slug: 'SLACK_SEND_MESSAGE', arguments: { channel: 'C0BHT7WHZDL', text: 'Morning team activity update: Taylor 26 calls / 54 emails, Jake 18 / 22. No zero-activity flags.', markdown_text: 'x' } }),
  ok: true,
};

test('a successful irreversible send becomes one in-app item carrying the message and its destination', () => {
  const n = externalSendMirrorNotification(slackSend);
  assert.ok(n);
  assert.equal(n.id, 'sent:call-1');
  assert.match(n.title, /^Sent via \w+ by a workflow step$/);
  assert.match(n.body, /^Morning team activity update: Taylor 26 calls/);
  assert.match(n.body, /channel: C0BHT7WHZDL/);
  assert.equal(n.metadata.inboxOnly, true, 'never queued back out to a channel');
  assert.equal(n.metadata.runId, 'trigger-abc');
  assert.equal(n.metadata.stepId, 'post_slack');
  assert.equal(n.metadata.operation, 'SLACK_SEND_MESSAGE');
  const chat = externalSendMirrorNotification({ ...slackSend, sessionId: 'sess-desktop-1', callId: 'call-2' });
  assert.match(chat!.title, /^Sent via \w+$/);
});

test('reads, reversible writes, failed sends and argument-less calls are not mirrored', () => {
  assert.equal(externalSendMirrorNotification({ ...slackSend, accounting: { effect: 'read', toolSlug: 'SLACK_FETCH_CONVERSATION_HISTORY' } }), null);
  assert.equal(externalSendMirrorNotification({ ...slackSend, accounting: { effect: 'external_write', toolSlug: 'GOOGLESHEETS_BATCH_UPDATE', reversibility: 'reversible' } }), null);
  assert.equal(externalSendMirrorNotification({ ...slackSend, ok: false }), null);
  assert.equal(externalSendMirrorNotification({ ...slackSend, rawArgs: 'not json' }), null);
});

test('the mirror is written once per call, unread, visible in-app and excluded from delivery channels', () => {
  assert.equal(mirrorExternalSendToFirstPartySurfaces(slackSend), true);
  assert.equal(mirrorExternalSendToFirstPartySurfaces(slackSend), true, 'a second settle of the same call is a no-op write');
  const rows = listNotifications(20).filter((row) => row.id === 'sent:call-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].read, false);
  assert.notEqual(rows[0].silent, true);
  assert.equal(rows[0].metadata?.inboxOnly, true, 'in-app only: the delivery queue skips inboxOnly items');
});
