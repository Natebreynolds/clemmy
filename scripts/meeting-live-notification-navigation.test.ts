import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMeetingCaptureTarget, resolveMeetingLiveNavigation } from '../apps/console-web/src/lib/meeting-live-navigation.js';
import { openRecallMeetingNotification, recallMeetingNotificationTarget } from '../apps/desktop/src/meeting-notification.js';
const detectedAt = '2026-10-18T08:00:00.000Z';
const startedAt = '2026-10-18T08:01:00.000Z';
const windowId = 'controlled-window:one+two';
function status(_recording: boolean) {
  return { capturePhase: 'recording' as const, recording: true, detectedWindows: [{ windowId, detectedAt }],
    currentWindowId: windowId, recordingStartedAt: startedAt };
}
function ports(current: () => ReturnType<typeof status>) {
  const routes: string[] = [];
  return { routes, ports: { getStatus: current, revealMainWindow() {}, navigate: async (route: string) => { routes.push(route); return true; } } };
}

test('a stale popup cannot become another current recording through the renderer default', async () => {
  const original = status(true);
  const target = recallMeetingNotificationTarget(windowId, original, true);
  const replacement = { ...original, currentWindowId: 'different-window',
    recordingStartedAt: '2026-10-18T08:05:00.000Z',
    detectedWindows: [{ windowId: 'different-window', detectedAt: '2026-10-18T08:04:00.000Z' }] };
  const opened = ports(() => replacement);
  await openRecallMeetingNotification(target, opened.ports);
  const query = new URL(opened.routes[0]!, 'http://controlled.local').search;
  const parsed = parseMeetingCaptureTarget(query);
  assert.equal(parsed.kind, 'target');
  if (parsed.kind !== 'target') assert.fail('Original capture identity must survive');
  assert.deepEqual(parsed.target, { windowId, detectedAt, startedAt });
  const resolved = resolveMeetingLiveNavigation({ target: parsed, sdk: { ...replacement, sdkAvailable: true, initialized: true },
    daemon: { activeMeetingId: 'different-meeting', activeWindowId: 'different-window', activeRecordingStartedAt: replacement.recordingStartedAt },
    meetings: [{ id: 'different-meeting', windowId: 'different-window', recordingStartedAt: replacement.recordingStartedAt, status: 'recording' }] });
  assert.deepEqual(resolved, { kind: 'unavailable', reason: 'capture_not_detected', explicit: true, target: parsed.target });
});
