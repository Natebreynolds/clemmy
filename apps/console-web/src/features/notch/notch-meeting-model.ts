export type NotchMeetingPhase = 'idle' | 'prompt' | 'starting' | 'recording' | 'stopping' | 'stopped' | 'error';
export type NotchMeetingBusyAction = 'start' | 'start-auto' | 'stop' | 'dismiss' | 'permissions' | null;

export const AUTO_RECORD_CONSENT_LABEL = 'Record now & auto-record future meetings';

export interface NotchMeetingIdentity {
  windowId: string;
  platform?: string;
  title?: string;
  detectedAt?: string;
}

export interface NotchMeetingState {
  phase: NotchMeetingPhase;
  meeting?: NotchMeetingIdentity;
  recordingStartedAt?: string;
  audioCapturing?: boolean;
  networkStatus?: 'reconnected' | 'disconnected';
  error?: string;
}

export interface NotchMeetingStatus {
  enabled?: boolean;
  capturePhase?: 'idle' | 'prompt' | 'starting' | 'recording' | 'stopping';
  pendingMeeting?: NotchMeetingIdentity;
  currentWindowId?: string;
  recordingStartedAt?: string;
  lastMeeting?: NotchMeetingIdentity;
  detectedWindows?: Array<NotchMeetingIdentity & { recording?: boolean }>;
  blocked?: { reason?: string; message?: string };
  lastError?: string;
  permissionStatuses?: Record<string, string>;
  networkStatus?: 'reconnected' | 'disconnected';
  mediaCapture?: { audio?: boolean; video?: boolean };
}

export interface NotchMeetingEvent extends Partial<NotchMeetingIdentity> {
  type?: string;
  at?: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  phase?: string;
  reason?: string;
  message?: string;
  status?: string;
  capturing?: boolean;
  mediaType?: string;
}

export type NotchMeetingAction =
  | { type: 'hydrate'; status: unknown }
  | { type: 'event'; event: unknown }
  | { type: 'start'; meeting: NotchMeetingIdentity }
  | { type: 'stop' }
  | { type: 'dismiss-prompt' }
  | { type: 'failure'; message: string }
  | { type: 'clear' };

export const INITIAL_NOTCH_MEETING_STATE: NotchMeetingState = { phase: 'idle' };

export function notchMeetingCaptureInterrupted(
  state: Pick<NotchMeetingState, 'audioCapturing' | 'networkStatus'>,
): boolean {
  return state.networkStatus === 'disconnected' || state.audioCapturing === false;
}

export function notchMeetingStopControl(
  phase: NotchMeetingPhase,
  busyAction: NotchMeetingBusyAction,
): { label: string; disabled: boolean } | null {
  if (phase !== 'starting' && phase !== 'recording') return null;
  const stopping = busyAction === 'stop';
  return {
    disabled: stopping,
    label: stopping
      ? phase === 'starting' ? 'Cancelling…' : 'Stopping…'
      : phase === 'starting' ? 'Cancel recording' : 'Stop recording',
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function meetingIdentity(value: unknown): NotchMeetingIdentity | undefined {
  const raw = record(value);
  const windowId = cleanText(raw?.windowId);
  if (!windowId) return undefined;
  const meeting: NotchMeetingIdentity = { windowId };
  const platform = cleanText(raw?.platform);
  const title = cleanText(raw?.title);
  const detectedAt = cleanText(raw?.detectedAt);
  if (platform) meeting.platform = platform;
  if (title) meeting.title = title;
  if (detectedAt) meeting.detectedAt = detectedAt;
  return meeting;
}

function statusIdentity(status: NotchMeetingStatus): NotchMeetingIdentity | undefined {
  const currentId = cleanText(status.currentWindowId);
  if (currentId) {
    return meetingIdentity(status.detectedWindows?.find((meeting) => meeting.windowId === currentId))
      ?? (status.lastMeeting?.windowId === currentId ? meetingIdentity(status.lastMeeting) : undefined)
      ?? { windowId: currentId };
  }
  if (status.pendingMeeting) return meetingIdentity(status.pendingMeeting);
  return meetingIdentity(status.lastMeeting);
}

export function notchMeetingStateFromStatus(
  value: unknown,
  previous: NotchMeetingState = INITIAL_NOTCH_MEETING_STATE,
): NotchMeetingState {
  const raw = record(value) as NotchMeetingStatus | null;
  if (!raw || raw.enabled === false) return { phase: 'idle' };
  const meeting = statusIdentity(raw) ?? previous.meeting;
  const sameMeeting = Boolean(meeting && previous.meeting?.windowId === meeting.windowId);
  const captureTruth: Pick<NotchMeetingState, 'audioCapturing' | 'networkStatus'> = {};
  if (typeof raw.mediaCapture?.audio === 'boolean') captureTruth.audioCapturing = raw.mediaCapture.audio;
  else if (sameMeeting && typeof previous.audioCapturing === 'boolean') captureTruth.audioCapturing = previous.audioCapturing;
  if (raw.networkStatus) captureTruth.networkStatus = raw.networkStatus;
  else if (previous.networkStatus) captureTruth.networkStatus = previous.networkStatus;
  switch (raw.capturePhase) {
    case 'prompt':
      return raw.pendingMeeting && meeting ? { phase: 'prompt', meeting } : { phase: 'idle' };
    case 'starting':
      if (sameMeeting && (previous.phase === 'recording' || previous.phase === 'stopping' || previous.phase === 'stopped')) return previous;
      return meeting ? { phase: 'starting', meeting, recordingStartedAt: raw.recordingStartedAt, ...captureTruth } : previous;
    case 'recording':
      if (sameMeeting && (previous.phase === 'stopping' || previous.phase === 'stopped')) return previous;
      return meeting ? { phase: 'recording', meeting, recordingStartedAt: raw.recordingStartedAt, ...captureTruth } : previous;
    case 'stopping':
      if (sameMeeting && previous.phase === 'stopped') return previous;
      return meeting ? { phase: 'stopping', meeting, recordingStartedAt: raw.recordingStartedAt ?? previous.recordingStartedAt, ...captureTruth } : previous;
    case 'idle':
    default:
      if (previous.phase === 'stopping' || previous.phase === 'stopped') return { ...previous, phase: 'stopped' };
      return { phase: 'idle' };
  }
}

function eventIdentity(event: NotchMeetingEvent, current?: NotchMeetingIdentity): NotchMeetingIdentity | undefined {
  const next = meetingIdentity(event);
  if (!next) return current;
  if (!current || current.windowId === next.windowId) return { ...current, ...next };
  return next;
}

export function notchMeetingReducer(state: NotchMeetingState, action: NotchMeetingAction): NotchMeetingState {
  switch (action.type) {
    case 'hydrate':
      return notchMeetingStateFromStatus(action.status, state);
    case 'start':
      return { phase: 'starting', meeting: action.meeting, networkStatus: state.networkStatus };
    case 'stop':
      return state.meeting ? { ...state, phase: 'stopping' } : state;
    case 'dismiss-prompt':
    case 'clear':
      return { phase: 'idle' };
    case 'failure':
      if (state.phase === 'recording' || state.phase === 'stopping') {
        return { ...state, phase: 'recording', error: action.message };
      }
      if (state.phase === 'stopped') return { ...state, error: action.message };
      return { ...state, phase: 'error', error: action.message };
    case 'event': {
      const raw = record(action.event) as NotchMeetingEvent | null;
      const type = cleanText(raw?.type);
      if (!raw || !type) return state;
      const meeting = eventIdentity(raw, state.meeting);
      const sameMeeting = !state.meeting || !raw.windowId || state.meeting.windowId === raw.windowId;
      switch (type) {
        case 'meeting-prompt-required':
          if ((state.phase === 'starting' || state.phase === 'recording' || state.phase === 'stopping')
              && state.meeting && raw.windowId && state.meeting.windowId !== raw.windowId) {
            return state;
          }
          return meeting ? { phase: 'prompt', meeting } : state;
        case 'meeting-updated':
          return sameMeeting && meeting ? { ...state, meeting } : state;
        case 'meeting-prompt-dismissed':
          return sameMeeting && state.phase === 'prompt' ? { phase: 'idle' } : state;
        case 'meeting-closed':
          return sameMeeting && state.phase === 'prompt' ? { phase: 'idle' } : state;
        case 'recording-start-requested':
          return sameMeeting && meeting
            ? { ...state, phase: 'starting', meeting, recordingStartedAt: cleanText(raw.startedAt) }
            : state;
        case 'recording-started':
          return sameMeeting && meeting
            ? { ...state, phase: 'recording', meeting, recordingStartedAt: state.recordingStartedAt ?? cleanText(raw.startedAt) }
            : state;
        case 'recording-start-failed':
        case 'recording-blocked':
          return sameMeeting
            ? { ...state, phase: 'error', meeting, error: cleanText(raw.message ?? raw.error) ?? 'Meeting recording could not start.' }
            : state;
        case 'recording-ended':
          return sameMeeting && meeting ? { ...state, phase: 'stopped', meeting } : state;
        case 'recording-stop-requested':
          // The native stop path emits recording-ended first. This later
          // acknowledgement must never regress Stopped back to Stopping.
          return state;
        case 'media-capture-status':
          return sameMeeting && raw.mediaType === 'audio' && typeof raw.capturing === 'boolean'
            ? { ...state, audioCapturing: raw.capturing }
            : state;
        case 'network-status':
          return raw.status === 'disconnected' || raw.status === 'reconnected'
            ? { ...state, networkStatus: raw.status }
            : state;
        case 'shutdown':
          return state.phase === 'recording' || state.phase === 'starting' || state.phase === 'stopping'
            ? { ...state, phase: 'error', error: cleanText(raw.error) ?? 'Meeting recording was interrupted. Clementine is saving what it captured.' }
            : state;
        case 'error':
          return sameMeeting && (state.phase === 'starting' || raw.phase === 'auto-record')
            ? { ...state, phase: 'error', meeting, error: cleanText(raw.error) ?? 'Meeting recording needs attention.' }
            : state;
        default:
          return state;
      }
    }
  }
}

export function meetingDisplayName(meeting?: NotchMeetingIdentity): string {
  if (meeting?.title) return meeting.title;
  const platform = meeting?.platform?.toLowerCase() ?? '';
  if (platform.includes('zoom')) return 'Zoom meeting';
  if (platform.includes('meet')) return 'Google Meet meeting';
  if (platform.includes('teams')) return 'Teams meeting';
  return 'Online meeting';
}

export function meetingPlatformLabel(meeting?: NotchMeetingIdentity): string {
  const platform = meeting?.platform?.trim();
  if (!platform) return 'Recall';
  if (/google.?meet/i.test(platform)) return 'Google Meet';
  return platform.slice(0, 1).toUpperCase() + platform.slice(1);
}
