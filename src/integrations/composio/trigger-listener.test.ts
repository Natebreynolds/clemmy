/** Run: node scripts/run-tests-isolated.mjs src/integrations/composio/trigger-listener.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-app-events-'));
const listener = await import('./trigger-listener.js');

test('an app event becomes the workflow event named by its trigger slug, with the app\'s fields and the event\'s identity', () => {
  assert.equal(listener.appEventTypeFor('GMAIL_NEW_GMAIL_MESSAGE'), 'composio.gmail_new_gmail_message');
  assert.equal(listener.triggerSlugFor('composio.outlook_message_trigger'), 'OUTLOOK_MESSAGE_TRIGGER');
  assert.equal(listener.triggerSlugFor('crm.lead.created'), null);
  assert.equal(listener.triggerSlugFor('composio.bad slug'), null);
  const fired: Array<[string, unknown]> = [];
  const port = { fire: (type: string, payload: unknown) => { fired.push([type, payload]); }, cap: new listener.DailyEventCap(5) };
  const outcome = listener.routeAppEvent({ triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', toolkitSlug: 'gmail', payload: { subject: 'Invoice', from: 'a@b.c' }, metadata: { id: 'evt-1', connectedAccountId: 'ca-1' } }, port);
  assert.equal(outcome, 'fired');
  assert.deepEqual(fired, [['composio.gmail_new_gmail_message', { subject: 'Invoice', from: 'a@b.c', _event: { id: 'evt-1', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', toolkit: 'gmail', connectedAccountId: 'ca-1' } }]]);
  assert.equal(listener.routeAppEvent({ triggerSlug: '' }, port), 'ignored');
});

test('past the daily cap a trigger\'s events are dropped, announced once, and admitted again the next day', () => {
  const logs: string[] = [];
  const port = { fire: () => undefined, cap: new listener.DailyEventCap(2), log: (_level: string, _fields: unknown, message: string) => { logs.push(message); } };
  const day = Date.parse('2026-10-28T10:00:00.000Z');
  const event = { triggerSlug: 'SLACK_CHANNEL_MESSAGE_RECEIVED' };
  assert.deepEqual([1, 2, 3, 4].map(() => listener.routeAppEvent(event, port, day)), ['fired', 'fired', 'dropped', 'dropped']);
  assert.equal(logs.length, 1, 'the cap is announced once a day');
  assert.equal(listener.routeAppEvent({ triggerSlug: 'OTHER' }, port, day), 'fired', 'another trigger has its own cap');
  assert.equal(listener.routeAppEvent(event, port, day + 86_400_000), 'fired', 'a new day admits again');
  assert.equal(listener.dailyCapFromEnv({ CLEMMY_APP_EVENTS_DAILY_CAP: '50' } as NodeJS.ProcessEnv), 50);
  assert.equal(listener.dailyCapFromEnv({} as NodeJS.ProcessEnv), 200);
});

test('the slugs to subscribe to come from enabled workflows that name an app event', () => {
  const workflows = [
    { name: 'a', data: { enabled: true, trigger: { events: [{ type: 'composio.gmail_new_gmail_message' }, { type: 'crm.lead.created' }] } } },
    { name: 'b', data: { enabled: false, trigger: { events: [{ type: 'composio.slack_channel_message_received' }] } } },
    { name: 'c', data: { enabled: true, trigger: { schedule: '0 8 * * *' } } },
    { name: 'd', data: { enabled: true, trigger: { events: [{ type: 'composio.outlook_message_trigger' }] } } },
  ] as unknown as Parameters<typeof listener.subscribedTriggerSlugs>[0];
  assert.deepEqual(listener.subscribedTriggerSlugs(workflows), ['GMAIL_NEW_GMAIL_MESSAGE', 'OUTLOOK_MESSAGE_TRIGGER']);
});
