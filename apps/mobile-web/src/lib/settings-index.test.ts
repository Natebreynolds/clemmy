import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionsSummary, devicesSummary, notificationsSummary, relativeDay, sectionFromSearch, settingsSearch, splitDevices,
} from './settings-index.js';
import type { MobileDeviceRow, PhoneHeartbeat } from './api.js';

const NOW = Date.parse('2026-09-26T20:00:00Z');
const dev = (over: Partial<MobileDeviceRow>): MobileDeviceRow => ({
  deviceId: 'd', createdAt: '2026-09-01T00:00:00Z', lastSeenAt: '2026-09-26T19:00:00Z', expiresAt: '2027-01-01T00:00:00Z',
  pushSubscribed: false, binding: 'key', current: false, ...over,
});

test('a section only reads on the settings tab, and its URL round-trips', () => {
  assert.equal(sectionFromSearch('?tab=settings&section=devices'), 'devices');
  assert.equal(sectionFromSearch('?tab=home&section=devices'), null);
  assert.equal(sectionFromSearch('?tab=settings&section=nonsense'), null);
  assert.equal(settingsSearch('models'), '?tab=settings&section=models');
  assert.equal(sectionFromSearch(settingsSearch(null)), null);
});

test('this phone comes first and phones unseen for two weeks are set apart', () => {
  const rows = [
    dev({ deviceId: 'old', lastSeenAt: '2026-08-29T00:00:00Z' }),
    dev({ deviceId: 'me', current: true }),
    dev({ deviceId: 'fresh', lastSeenAt: '2026-09-25T00:00:00Z' }),
  ];
  const split = splitDevices(rows, NOW);
  assert.equal(split.current?.deviceId, 'me');
  assert.deepEqual(split.active.map((d) => d.deviceId), ['fresh']);
  assert.deepEqual(split.stale.map((d) => d.deviceId), ['old']);
  assert.equal(devicesSummary(rows, NOW), 'This phone and 2 others · 1 not seen in weeks');
  assert.equal(devicesSummary([dev({ current: true })], NOW), 'Only this phone is signed in');
  assert.equal(relativeDay('2026-08-29T00:00:00Z', NOW), '4 weeks ago');
  assert.equal(relativeDay('2026-09-26T01:00:00Z', NOW), 'today');
});

test('connections are counted as apps and Mac tools, with what needs a look', () => {
  const rows = [
    { id: 'a', name: 'Slack', kind: 'composio', state: 'ok' as const, cause: null },
    { id: 'b', name: 'Monday', kind: 'composio', state: 'ok' as const, cause: null },
    { id: 'c', name: 'sf', kind: 'cli', state: 'warn' as const, cause: 'Not checked yet' },
  ];
  assert.equal(connectionsSummary(rows), '2 apps · 1 tool on your Mac · 1 needs a look');
  assert.equal(connectionsSummary([]), 'Nothing connected yet');
});

test('the notifications line says what reaches this phone, or that nothing does yet', () => {
  const hb = (title: string, notify: 'quiet' | 'push'): PhoneHeartbeat => ({
    id: title, title, purpose: '', enabled: true, cadenceMinutes: 60, notify, openItems: 0,
    phonePush: { ready: true, phones: { webPush: 0, apns: 1 } },
  });
  assert.equal(notificationsSummary({ registered: false, heartbeats: [] }), 'Not reaching this phone yet');
  assert.equal(notificationsSummary({ registered: true, heartbeats: [hb('Work review', 'quiet')] }), 'Questions and finished work reach this phone');
  assert.equal(notificationsSummary({ registered: true, heartbeats: [hb('Work review', 'push'), hb('Calendar', 'push')] }), 'Questions, finished work and Work review and Calendar reach this phone'.replace('and Work review and Calendar', 'and Work review and Calendar'));
});
