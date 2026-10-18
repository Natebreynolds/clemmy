/** Read-only navigation. A URL can select an exactly identified capture; it
 * never grants permission to record, change settings or choose another call. */
export interface MeetingCaptureTarget {
  windowId: string;
  detectedAt: string;
  /** Canonical native recording epoch, not the daemon's detection time. */
  startedAt?: string;
}

export type ParsedMeetingCaptureTarget =
  | { kind: 'none' }
  | { kind: 'target'; target: MeetingCaptureTarget }
  | { kind: 'invalid'; reason: 'invalid_query' | 'unknown_parameter' | 'duplicate_parameter' | 'incomplete_target' | 'invalid_identity' };

export interface MeetingNavigationSdkStatus {
  sdkAvailable?: boolean;
  initialized?: boolean;
  recording?: boolean;
  capturePhase?: 'idle' | 'prompt' | 'starting' | 'recording' | 'stopping';
  currentWindowId?: string;
  recordingStartedAt?: string;
  detectedWindows?: ReadonlyArray<{ windowId: string; detectedAt: string; recording?: boolean }>;
}
export interface MeetingNavigationDaemonStatus {
  activeMeetingId?: string;
  activeWindowId?: string;
  activeRecordingStartedAt?: string;
}
export interface MeetingNavigationRow {
  id: string;
  windowId?: string;
  status?: string;
  /** A legacy/detection timestamp is deliberately not a recording identity. */
  startedAt?: string;
  recordingStartedAt?: string;
}
export type MeetingNavigationReason =
  | 'invalid_target' | 'native_status_pending' | 'native_unavailable'
  | 'capture_not_detected' | 'capture_replaced' | 'ambiguous_capture'
  | 'capture_not_current' | 'recording_identity_pending' | 'recording_identity_mismatch'
  | 'capture_starting' | 'capture_stopping' | 'daemon_status_pending'
  | 'meeting_pending' | 'ambiguous_meeting' | 'meeting_not_recording' | 'daemon_identity_mismatch';
export type MeetingLiveNavigation =
  | { kind: 'none' }
  | { kind: 'recording'; meetingId: string; windowId: string; startedAt: string; source: 'explicit' | 'active'; target?: MeetingCaptureTarget }
  | { kind: 'prompt'; target: MeetingCaptureTarget }
  | { kind: 'waiting'; reason: MeetingNavigationReason; target?: MeetingCaptureTarget }
  | { kind: 'unavailable'; reason: MeetingNavigationReason; explicit: boolean; target?: MeetingCaptureTarget };

export interface RetainedMeetingCapture { meetingId: string; windowId: string; startedAt: string }

/** After Stop, a notification can still select its retained recording. This
 * deliberately does not consult the latest native window: that may already
 * describe another meeting. A prompt-only URL needs the exact capture that
 * this same view observed while it was recording. */
export function retainedMeetingCapture(input: {
  target: ParsedMeetingCaptureTarget; meetings?: readonly MeetingNavigationRow[];
  observed?: RetainedMeetingCapture;
}): RetainedMeetingCapture | null {
  if (input.target.kind !== 'target' || !input.meetings) return null;
  const target = input.target.target;
  const observed = input.observed?.windowId === target.windowId ? input.observed : undefined;
  const startedAt = target.startedAt ?? observed?.startedAt;
  if (!instant(startedAt)) return null;
  const matches = input.meetings.filter(row => row.windowId === target.windowId && row.recordingStartedAt === startedAt
    && (row.status === 'completed' || row.status === 'cancelled'));
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  if (!id(match.id) || input.meetings.filter(row => row.id === match.id).length !== 1
    || (!target.startedAt && match.id !== observed?.meetingId)) return null;
  return { meetingId: match.id, windowId: target.windowId, startedAt };
}

// Keep these identical to the native popup route's bounded opaque identity.
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,511}$/.test(value);
const instant = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
};

export function parseMeetingCaptureTarget(search: string | URLSearchParams): ParsedMeetingCaptureTarget {
  if (typeof search === 'string' && (search.length > 4_096 || /[#\u0000-\u001f\u007f]/.test(search)
    || /%(?![a-fA-F0-9]{2})/.test(search))) return { kind: 'invalid', reason: 'invalid_query' };
  const params = new URLSearchParams(search);
  const allowed = new Set(['captureWindow', 'captureDetectedAt', 'captureStartedAt']);
  for (const key of params.keys()) {
    if (!allowed.has(key)) return { kind: 'invalid', reason: 'unknown_parameter' };
    if (params.getAll(key).length !== 1) return { kind: 'invalid', reason: 'duplicate_parameter' };
  }
  if (params.size === 0) return { kind: 'none' };
  const windowId = params.get('captureWindow'); const detectedAt = params.get('captureDetectedAt');
  const startedAt = params.get('captureStartedAt');
  if (windowId === null || detectedAt === null) return { kind: 'invalid', reason: 'incomplete_target' };
  if (!id(windowId) || !instant(detectedAt) || (startedAt !== null && !instant(startedAt))) return { kind: 'invalid', reason: 'invalid_identity' };
  return { kind: 'target', target: { windowId, detectedAt, ...(startedAt !== null ? { startedAt } : {}) } };
}

/** Explicit navigation never falls back to another meeting or a newer window
 * generation. Without a target, only the exact active daemon id may select a
 * record, and manual history selection wins over that default. */
export function resolveMeetingLiveNavigation(input: {
  target: ParsedMeetingCaptureTarget;
  sdk?: MeetingNavigationSdkStatus | null;
  daemon?: MeetingNavigationDaemonStatus | null;
  meetings?: readonly MeetingNavigationRow[];
  historySelected?: boolean;
}): MeetingLiveNavigation {
  const explicit = input.target.kind !== 'none';
  const target = input.target.kind === 'target' ? input.target.target : undefined;
  const unavailable = (reason: MeetingNavigationReason): MeetingLiveNavigation => ({ kind: 'unavailable', reason, explicit, ...(target ? { target } : {}) });
  const waiting = (reason: MeetingNavigationReason): MeetingLiveNavigation => ({ kind: 'waiting', reason, ...(target ? { target } : {}) });
  if (input.target.kind === 'invalid') return unavailable('invalid_target');
  if (!target && input.historySelected) return { kind: 'none' };
  const { sdk, daemon, meetings } = input;
  if (!target && !daemon?.activeMeetingId && !sdk?.recording
    && !['starting', 'recording', 'stopping'].includes(sdk?.capturePhase ?? '')) return { kind: 'none' };
  if (sdk === undefined) return waiting('native_status_pending');
  if (sdk === null || sdk.sdkAvailable === false || sdk.initialized === false) return unavailable('native_unavailable');
  const windowId = target?.windowId ?? sdk.currentWindowId;
  if (!id(windowId)) return unavailable('capture_not_current');
  const detections = sdk.detectedWindows?.filter(item => item.windowId === windowId) ?? [];
  if (detections.length > 1) return unavailable('ambiguous_capture');
  const detection = detections[0];
  if (!detection || !instant(detection.detectedAt)) return unavailable('capture_not_detected');
  if (target && detection.detectedAt !== target.detectedAt) return unavailable('capture_replaced');
  const current = sdk.currentWindowId === windowId;
  if (target?.startedAt && instant(sdk.recordingStartedAt) && target.startedAt !== sdk.recordingStartedAt) return unavailable('recording_identity_mismatch');
  if (sdk.capturePhase === 'starting') return current ? waiting('capture_starting') : unavailable('capture_not_current');
  if (sdk.capturePhase === 'stopping') return current ? waiting('capture_stopping') : unavailable('capture_not_current');
  const recording = sdk.capturePhase === 'recording' || (sdk.capturePhase === undefined && sdk.recording === true);
  if (!recording) {
    if (target?.startedAt || detection.recording === true) return unavailable('capture_not_current');
    return target ? { kind: 'prompt', target } : { kind: 'none' };
  }
  if (!current || detection.recording === false) return unavailable('capture_not_current');
  const startedAt = sdk.recordingStartedAt;
  if (!instant(startedAt)) return waiting('recording_identity_pending');
  if (target?.startedAt && target.startedAt !== startedAt) return unavailable('recording_identity_mismatch');
  if (daemon === undefined || daemon === null) return waiting('daemon_status_pending');
  if (!daemon.activeMeetingId) return waiting('meeting_pending');
  if (!id(daemon.activeMeetingId) || daemon.activeWindowId !== windowId) return unavailable('daemon_identity_mismatch');
  if (!instant(daemon.activeRecordingStartedAt)) return waiting('recording_identity_pending');
  if (daemon.activeRecordingStartedAt !== startedAt) return unavailable('daemon_identity_mismatch');
  if (!meetings) return waiting('meeting_pending');
  const exactRows = meetings.filter(row => row.windowId === windowId && row.recordingStartedAt === startedAt);
  const activeRows = meetings.filter(row => row.id === daemon.activeMeetingId);
  if (exactRows.length > 1 || activeRows.length > 1) return unavailable('ambiguous_meeting');
  const meeting = exactRows[0];
  if (!meeting) return meetings.some(row => row.windowId === windowId && row.status === 'recording')
    ? unavailable('recording_identity_mismatch') : waiting('meeting_pending');
  if (meeting.id !== daemon.activeMeetingId || activeRows[0] !== meeting) return unavailable('daemon_identity_mismatch');
  if (meeting.status !== 'recording') return unavailable('meeting_not_recording');
  return { kind: 'recording', meetingId: meeting.id, windowId, startedAt, source: target ? 'explicit' : 'active', ...(target ? { target } : {}) };
}
