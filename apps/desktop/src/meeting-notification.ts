import type { RecallCaptureStatus } from './recall-capture.js';

/** Navigation identity only. This never carries an upload token, transcript,
 * meeting title or permission to start recording. */
export interface RecallMeetingNotificationTarget {
  readonly windowId: string;
  readonly detectedAt: string;
  readonly startedAt?: string;
}

type MeetingStatus = Pick<RecallCaptureStatus,
  'capturePhase' | 'pendingMeeting' | 'detectedWindows' | 'recording' | 'currentWindowId' | 'recordingStartedAt'>;

export const MEETING_NOTIFICATION_ROUTE = '/console/meetings';

function windowIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,511}$/.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Capture the generation that raised the toast, not whichever meeting happens
 * to be current when an old Action Center entry is eventually clicked. */
export function recallMeetingNotificationTarget(windowId: unknown, status: MeetingStatus | null | undefined,
  recording: boolean): RecallMeetingNotificationTarget | null {
  if (!windowIdentity(windowId) || !status) return null;
  const detected = status.detectedWindows.find(window => window.windowId === windowId);
  if (!detected || !timestamp(detected.detectedAt)) return null;
  if (recording) {
    if (!status.recording || status.capturePhase !== 'recording' || status.currentWindowId !== windowId
      || !timestamp(status.recordingStartedAt)) return null;
    return Object.freeze({ windowId, detectedAt: detected.detectedAt, startedAt: status.recordingStartedAt });
  }
  if (status.capturePhase !== 'prompt' || status.pendingMeeting?.windowId !== windowId
    || status.pendingMeeting.detectedAt !== detected.detectedAt) return null;
  return Object.freeze({ windowId, detectedAt: detected.detectedAt });
}

export function recallMeetingNotificationTargetIsCurrent(target: RecallMeetingNotificationTarget | null,
  status: MeetingStatus | null | undefined): boolean {
  if (!target || !windowIdentity(target.windowId) || !timestamp(target.detectedAt)
    || (target.startedAt !== undefined && !timestamp(target.startedAt))) return false;
  const current = recallMeetingNotificationTarget(target.windowId, status, target.startedAt !== undefined);
  return Boolean(current && current.detectedAt === target.detectedAt && current.startedAt === target.startedAt);
}

/** The renderer must independently resolve this same generation against fresh
 * SDK status/retained recording identity. A query is never recording consent. */
export function recallMeetingNotificationRoute(target: RecallMeetingNotificationTarget | null,
  _status: MeetingStatus | null | undefined): string {
  // Preserve a valid original target even after it closes. The renderer must
  // explain its unavailability, rather than auto-opening a different call.
  if (!target || !windowIdentity(target.windowId) || !timestamp(target.detectedAt)
    || (target.startedAt !== undefined && !timestamp(target.startedAt))) return MEETING_NOTIFICATION_ROUTE;
  const params = new URLSearchParams({ captureWindow: target!.windowId, captureDetectedAt: target!.detectedAt });
  if (target!.startedAt) params.set('captureStartedAt', target!.startedAt);
  return `${MEETING_NOTIFICATION_ROUTE}?${params}`;
}

/** Main-process destination allowlist, independent of renderer parsing. */
export function isRecallMeetingNotificationRoute(route: string): boolean {
  if (route === MEETING_NOTIFICATION_ROUTE) return true;
  try {
    const url = new URL(route, 'http://clementine.local');
    if (url.origin !== 'http://clementine.local' || url.pathname !== MEETING_NOTIFICATION_ROUTE || url.hash
      || `${url.pathname}${url.search}` !== route) return false;
    const keys = [...url.searchParams.keys()];
    if (keys.length < 2 || keys.length > 3 || new Set(keys).size !== keys.length
      || keys.some(key => !['captureWindow', 'captureDetectedAt', 'captureStartedAt'].includes(key))) return false;
    return windowIdentity(url.searchParams.get('captureWindow')) && timestamp(url.searchParams.get('captureDetectedAt'))
      && (!url.searchParams.has('captureStartedAt') || timestamp(url.searchParams.get('captureStartedAt')));
  } catch { return false; }
}

export interface RecallMeetingNotificationOpenPorts {
  getStatus(): MeetingStatus | null | undefined;
  revealMainWindow(): void;
  navigate(route: string): Promise<boolean>;
}

/** Only presentation ports are available here: opening a notification cannot
 * record, update settings, invoke a provider or acknowledge a permission. */
export async function openRecallMeetingNotification(target: RecallMeetingNotificationTarget | null,
  ports: RecallMeetingNotificationOpenPorts): Promise<'meetings' | 'unavailable'> {
  let status: MeetingStatus | null | undefined;
  try { status = ports.getStatus(); } catch { status = null; }
  try {
    ports.revealMainWindow();
    return await ports.navigate(recallMeetingNotificationRoute(target, status)) ? 'meetings' : 'unavailable';
  } catch { return 'unavailable'; }
}
