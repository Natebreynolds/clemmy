/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/external-send-mirror.test.ts
 *
 * What Clem sends anywhere shows on the first-party surfaces. Live
 * 2026-09-22: a scheduled workflow posted the team digest to Slack; the
 * desktop got only "Workflow completed" in Clem's voice.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-send-mirror-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { externalSendMirrorNotification, mirrorExternalSendToFirstPartySurfaces } = await import('./external-send-mirror.js');
const { addNotification, listNotifications } = await import('../notifications.js');

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
  assert.match(n.id, /^sent:[a-f0-9]{64}$/);
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
  const rows = listNotifications(20).filter((row) => row.id === externalSendMirrorNotification(slackSend)!.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].read, false);
  assert.notEqual(rows[0].silent, true);
  assert.equal(rows[0].metadata?.inboxOnly, true, 'in-app only: the delivery queue skips inboxOnly items');
});


test('separate sessions may reuse a provider call id without losing a send mirror', () => {
  const first = { ...slackSend, callId: 'reused-provider-id', sessionId: 'workflow:occurrence-a:send' };
  const second = { ...first, sessionId: 'workflow:occurrence-b:send' };
  assert.notEqual(externalSendMirrorNotification(first)!.id, externalSendMirrorNotification(second)!.id);
  assert.equal(mirrorExternalSendToFirstPartySurfaces(first), true);
  assert.equal(mirrorExternalSendToFirstPartySurfaces(second), true);
  const rows = listNotifications(100).filter((row) => row.metadata?.callId === first.callId);
  assert.equal(rows.length, 2);
});

test('a mirror needs durable call identity rather than inventing a timestamp on replay', () => {
  for (const callId of [null, undefined, '', '   ']) {
    assert.equal(externalSendMirrorNotification({ ...slackSend, callId }), null);
  }
  assert.equal(externalSendMirrorNotification({ ...slackSend, sessionId: '' }), null);
});


test('a replay after upgrade keeps the existing mirror but does not inherit another session’s row', () => {
  const input = { ...slackSend, callId: 'legacy-call', sessionId: 'workflow:legacy-run:send' };
  const projected = externalSendMirrorNotification(input)!;
  addNotification({ id: 'sent:legacy-call', kind: 'system', title: projected.title,
    body: projected.body, createdAt: new Date().toISOString(), read: true, metadata: projected.metadata });
  assert.equal(mirrorExternalSendToFirstPartySurfaces(input), true);
  assert.equal(listNotifications(100).filter((row) => row.metadata?.callId === 'legacy-call').length, 1);
  assert.equal(mirrorExternalSendToFirstPartySurfaces({ ...input, sessionId: 'workflow:new-run:send' }), true);
  assert.equal(listNotifications(100).filter((row) => row.metadata?.callId === 'legacy-call').length, 2);
});


test('replaying a settled send in a fresh process preserves one mirror', () => {
  const input = { ...slackSend, callId: 'restart-call', sessionId: 'workflow:restart-run:send' };
  assert.equal(mirrorExternalSendToFirstPartySurfaces(input), true);
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { mirrorExternalSendToFirstPartySurfaces } = await import(${JSON.stringify(new URL('./external-send-mirror.ts', import.meta.url).href)});
    if (!mirrorExternalSendToFirstPartySurfaces(${JSON.stringify(input)})) process.exitCode = 1;
  `], { env: { ...process.env, CLEMENTINE_HOME: TMP }, encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const rows = listNotifications(100).filter((row) => row.metadata?.callId === input.callId);
  assert.equal(rows.length, 1);
});
