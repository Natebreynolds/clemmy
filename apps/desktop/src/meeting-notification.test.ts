import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DesktopNotificationRetention } from './desktop-toast-queue.js';
import { isRecallMeetingNotificationRoute, openRecallMeetingNotification, recallMeetingNotificationRoute, recallMeetingNotificationTarget,
  recallMeetingNotificationTargetIsCurrent } from './meeting-notification.js';

type Status = NonNullable<Parameters<typeof recallMeetingNotificationTarget>[1]>;
const detectedAt = '2026-10-18T08:00:00.000Z';
const startedAt = '2026-10-18T08:01:00.000Z';
const windowId = 'controlled-window:one+two';
function status(recording = false): Status {
  return { capturePhase: recording ? 'recording' : 'prompt', recording,
    pendingMeeting: recording ? undefined : { windowId, detectedAt },
    detectedWindows: [{ windowId, detectedAt }], currentWindowId: recording ? windowId : undefined,
    recordingStartedAt: recording ? startedAt : undefined };
}

function ports(current: () => Status | null | undefined) {
  const actions: string[] = [];
  const routes: string[] = [];
  return { actions, routes, ports: { getStatus: current,
    revealMainWindow: () => { actions.push('reveal'); },
    navigate: async (route: string) => { actions.push('navigate'); routes.push(route); return true; } } };
}

test('Windows popup opens the exact detected meeting with bounded encoded identifiers, without a notch or recording action', async () => {
  const current = status(); const target = recallMeetingNotificationTarget(windowId, current, false);
  assert.ok(target); assert.equal(Object.isFrozen(target), true);
  const f = ports(() => current);
  assert.equal(await openRecallMeetingNotification(target, f.ports), 'meetings');
  assert.deepEqual(f.actions, ['reveal', 'navigate']);
  const url = new URL(f.routes[0]!, 'http://controlled.local');
  assert.equal(url.pathname, '/console/meetings');
  assert.equal(url.searchParams.get('captureWindow'), windowId);
  assert.equal(url.searchParams.get('captureDetectedAt'), detectedAt);
  assert.equal(url.searchParams.has('captureStartedAt'), false);
  assert.deepEqual([...url.searchParams.keys()], ['captureWindow', 'captureDetectedAt']);
});

test('recording destination includes the original recording generation and no private capture data', async () => {
  const current = status(true); const target = recallMeetingNotificationTarget(windowId, current, true);
  assert.deepEqual(target, { windowId, detectedAt, startedAt });
  const f = ports(() => current);
  assert.equal(await openRecallMeetingNotification(target, f.ports), 'meetings');
  const url = new URL(f.routes[0]!, 'http://controlled.local');
  assert.equal(url.searchParams.get('captureStartedAt'), startedAt);
  assert.deepEqual([...url.searchParams.keys()], ['captureWindow', 'captureDetectedAt', 'captureStartedAt']);
  assert.equal(recallMeetingNotificationTarget(windowId, { ...current, currentWindowId: 'another-window' }, true), null);
  assert.equal(recallMeetingNotificationTarget(windowId, { ...current, recordingStartedAt: undefined }, true), null);
});

test('a current prompt and a missing native target both have a direct Meetings destination', async () => {
  const current = status(); const target = recallMeetingNotificationTarget(windowId, current, false);
  for (const original of [target, null]) {
    const f = ports(() => current);
    assert.equal(await openRecallMeetingNotification(original, f.ports), 'meetings');
    assert.deepEqual(f.actions, ['reveal', 'navigate']);
    assert.equal(f.routes[0] === '/console/meetings', original === null);
  }
});

test('closed or reused window never opens another meeting, including the Mac notch', async () => {
  const original = status(); const target = recallMeetingNotificationTarget(windowId, original, false);
  const changed: Array<Status | null> = [null, { ...original, capturePhase: 'idle', pendingMeeting: undefined, detectedWindows: [] },
    { ...original, pendingMeeting: { windowId, detectedAt: startedAt }, detectedWindows: [{ windowId, detectedAt: startedAt }] },
    { ...original, pendingMeeting: { windowId: 'another-window', detectedAt }, detectedWindows: [{ windowId: 'another-window', detectedAt }] }];
  for (const current of changed) {
    assert.equal(recallMeetingNotificationTargetIsCurrent(target, current), false);
    const f = ports(() => current);
    assert.equal(await openRecallMeetingNotification(target, f.ports), 'meetings');
    assert.deepEqual(f.actions, ['reveal', 'navigate']); assert.deepEqual(f.routes, [recallMeetingNotificationRoute(target, original)]);
  }
});

test('an ended or replaced recording cannot borrow the same window identity', async () => {
  const original = status(true); const target = recallMeetingNotificationTarget(windowId, original, true);
  for (const current of [{ ...original, recordingStartedAt: '2026-10-18T08:02:00.000Z' }, status(),
    { ...original, capturePhase: 'stopping' as const, recording: false },
    { ...original, detectedWindows: [{ windowId, detectedAt: startedAt }] }]) {
    const f = ports(() => current);
    assert.equal(await openRecallMeetingNotification(target, f.ports), 'meetings');
    assert.deepEqual(f.routes, [recallMeetingNotificationRoute(target, original)]);
  }
});

test('target validation refuses malformed, URL-shaped or missing native generation identities', () => {
  const current = status();
  for (const id of ['', 'x'.repeat(513), ' invalid ', 'line\nbreak', 'bad/id', 'bad%id', 'bad?id', 'bad#id', 'https://controlled.invalid/capability', null]) {
    assert.equal(recallMeetingNotificationTarget(id, current, false), null);
  }
  for (const value of [{ ...current, pendingMeeting: undefined }, { ...current, detectedWindows: [] },
    { ...current, detectedWindows: [{ windowId, detectedAt: 'not-a-date' }] }]) {
    assert.equal(recallMeetingNotificationTarget(windowId, value, false), null);
  }
  assert.equal(recallMeetingNotificationRoute({ windowId, detectedAt, startedAt: 'bad-date' }, current), '/console/meetings');
});

test('native SPA destination validation accepts only exact bounded Meetings navigation identities', () => {
  const current = status(true); const target = recallMeetingNotificationTarget(windowId, current, true);
  const exact = recallMeetingNotificationRoute(target, current);
  assert.equal(isRecallMeetingNotificationRoute('/console/meetings'), true);
  assert.equal(isRecallMeetingNotificationRoute(exact), true);
  for (const route of ['https://controlled.invalid/console/meetings', '//controlled.invalid/console/meetings',
    '/console/meetings#fragment', '/console/settings', '/console/meetings?captureWindow=x',
    `${exact}&captureWindow=another`, `${exact}&extra=data`, exact.replace('.000Z', 'Z'),
    exact.replace('captureDetectedAt=', 'detectedAt='), exact.replace('captureWindow=', 'captureWindow=bad%2Fid')]) {
    assert.equal(isRecallMeetingNotificationRoute(route), false, route);
  }
});

test('fresh status is read only on click; unreadable status preserves the explicit original target', async () => {
  let current: Status | null = status(); let reads = 0;
  const target = recallMeetingNotificationTarget(windowId, current, false);
  const f = ports(() => { reads++; return current; });
  current = null;
  assert.equal(reads, 0);
  assert.equal(await openRecallMeetingNotification(target, f.ports), 'meetings');
  assert.equal(reads, 1); assert.deepEqual(f.routes, [recallMeetingNotificationRoute(target, null)]);
  const unreadable = ports(() => { throw new Error('Controlled unreadable native status'); });
  assert.equal(await openRecallMeetingNotification(target, unreadable.ports), 'meetings');
  assert.deepEqual(unreadable.routes, [recallMeetingNotificationRoute(target, null)]);
});

test('navigation failure does not reload, retry or turn an open into recording consent', async () => {
  const current = status(); const target = recallMeetingNotificationTarget(windowId, current, false);
  let navigations = 0; const f = ports(() => current);
  f.ports.navigate = async () => { navigations++; return false; };
  assert.equal(await openRecallMeetingNotification(target, f.ports), 'unavailable');
  assert.equal(navigations, 1); assert.deepEqual(f.actions, ['reveal']);
});

test('the shared bounded retention keeps Windows Action Center clicks after banner timeout', async () => {
  class ControlledNotification extends EventEmitter { close() { this.emit('close'); } }
  const retention = new DesktopNotificationRetention<ControlledNotification>(2);
  const notification = new ControlledNotification(); const current = status();
  const target = recallMeetingNotificationTarget(windowId, current, false); const f = ports(() => current);
  let opened: Promise<unknown> | undefined;
  retention.retain(notification);
  notification.on('click', () => { opened = openRecallMeetingNotification(target, f.ports); });
  notification.emit('close', { reason: 'timedOut' });
  assert.equal(retention.has(notification), true);
  notification.emit('click'); await opened;
  assert.equal(retention.has(notification), false); assert.deepEqual(f.actions, ['reveal', 'navigate']);
  const queued = [new ControlledNotification(), new ControlledNotification(), new ControlledNotification()];
  for (const next of queued) retention.retain(next);
  assert.equal(retention.size, 2); assert.equal(retention.has(queued[0]!), false);
});
