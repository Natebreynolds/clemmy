import type { RecallCaptureStatus } from './recall-capture.js';
import type { LocalMeetingRecorderStatus } from './local-meeting-recorder.js';
import { redactSensitiveText } from './redaction.js';

export interface ClementineNotchMeetingWindow {
  windowId: string;
  platform?: string;
  title?: string;
  detectedAt?: string;
  recording?: boolean;
}

export interface ClementineNotchMeetingStatus {
  enabled: boolean;
  sdkAvailable: boolean;
  initialized: boolean;
  recording: boolean;
  capturePhase: RecallCaptureStatus['capturePhase'];
  pendingMeeting?: ClementineNotchMeetingWindow;
  recordingStartedAt?: string;
  currentWindowId?: string;
  lastError?: string;
  blocked?: { reason: string; message: string };
  permissionStatuses: Record<string, string>;
  networkStatus?: 'reconnected' | 'disconnected';
  mediaCapture?: { audio?: boolean; video?: boolean };
  detectedWindows: ClementineNotchMeetingWindow[];
  lastMeeting?: Omit<ClementineNotchMeetingWindow, 'detectedAt' | 'recording'>;
  platformSupport: { supported: boolean; platform: string; arch: string; message?: string };
  autoRecord: boolean;
}

export interface ClementineNotchMeetingEvent {
  type: string;
  at?: string;
  windowId?: string;
  platform?: string;
  title?: string;
  detectedAt?: string;
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

export interface ClementineNotchLocalMeetingRecorder {
  recording: boolean;
  sessionId?: string;
  title?: string;
  startedAt?: string;
  bytes: number;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  stale?: boolean;
}

export interface RecallMeetingDetectionNotificationCopy {
  title: string;
  body: string;
}

const LIVE_EVENT_TYPES = new Set([
  'meeting-prompt-required',
  'meeting-prompt-dismissed',
  'meeting-updated',
  'meeting-closed',
  'recording-start-requested',
  'recording-started',
  'recording-start-failed',
  'recording-blocked',
  'recording-stop-requested',
  'recording-ended',
  'network-status',
  'media-capture-status',
  'shutdown',
  'error',
]);

export function recallCaptureRequiresVisibleControls(
  status: Pick<RecallCaptureStatus, 'capturePhase'> | null | undefined,
): boolean {
  return status?.capturePhase === 'starting'
    || status?.capturePhase === 'recording'
    || status?.capturePhase === 'stopping';
}

function text(value: unknown, maxLength = 500): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

function safeError(value: unknown): string | undefined {
  const valueText = text(value, 1_500);
  return valueText ? redactSensitiveText(valueText).slice(0, 800) : undefined;
}

/** Native meeting alerts deliberately use a small provider allowlist instead
 * of putting an SDK-controlled platform or meeting title on the lock screen. */
export function recallMeetingDetectionNotificationCopy(
  platform: unknown,
  recording = false,
): RecallMeetingDetectionNotificationCopy {
  const normalized = text(platform, 80)?.toLowerCase() ?? '';
  const provider = normalized.includes('slack') || normalized.includes('huddle')
    ? 'Slack Huddle'
    : normalized.includes('teams')
      ? 'Microsoft Teams meeting'
      : normalized.includes('zoom')
        ? 'Zoom meeting'
        : normalized.includes('meet')
          ? 'Google Meet'
          : 'Online meeting';
  return {
    title: `${provider} detected`,
    body: recording
      ? 'Clementine is recording it now. Click to open the notch controls.'
      : 'Clementine is ready to record it. Click to choose from the notch.',
  };
}

/** Only expose meeting presentation data to the sandboxed Notch renderer.
 * Upload tokens, Recall ids, transcript payloads, retention metadata, and
 * completion internals intentionally never cross this bridge. */
export function sanitizeRecallStatusForNotch(
  status: RecallCaptureStatus | null | undefined,
): ClementineNotchMeetingStatus | null {
  if (!status) return null;
  const pendingWindowId = text(status.pendingMeeting?.windowId, 512);
  const lastMeetingWindowId = text(status.lastMeeting?.windowId, 512);
  const activeMedia = status.currentWindowId
    ? status.mediaCaptureStatuses[status.currentWindowId]
    : undefined;
  const mediaCapture = activeMedia && (typeof activeMedia.audio === 'boolean' || typeof activeMedia.video === 'boolean')
    ? {
        audio: typeof activeMedia.audio === 'boolean' ? activeMedia.audio : undefined,
        video: typeof activeMedia.video === 'boolean' ? activeMedia.video : undefined,
      }
    : undefined;
  return {
    enabled: status.enabled,
    sdkAvailable: status.sdkAvailable,
    initialized: status.initialized,
    recording: status.recording,
    capturePhase: status.capturePhase,
    pendingMeeting: status.pendingMeeting && pendingWindowId ? {
      windowId: pendingWindowId,
      platform: text(status.pendingMeeting.platform, 80),
      title: text(status.pendingMeeting.title, 240),
      detectedAt: text(status.pendingMeeting.detectedAt, 80),
    } : undefined,
    recordingStartedAt: text(status.recordingStartedAt),
    currentWindowId: text(status.currentWindowId),
    lastError: safeError(status.lastError),
    blocked: status.blocked ? {
      reason: text(status.blocked.reason, 80) ?? 'blocked',
      message: safeError(status.blocked.message) ?? 'Meeting recording is blocked.',
    } : undefined,
    permissionStatuses: Object.fromEntries(
      Object.entries(status.permissionStatuses).slice(0, 32).flatMap(([key, value]) => {
        const safeKey = text(key);
        const safeValue = text(value);
        return safeKey && safeValue ? [[safeKey, safeValue]] : [];
      }),
    ),
    networkStatus: status.networkStatus,
    mediaCapture,
    detectedWindows: status.detectedWindows.slice(0, 25).flatMap((window) => {
      const windowId = text(window.windowId);
      if (!windowId) return [];
      return [{
        windowId,
        platform: text(window.platform),
        title: text(window.title),
        detectedAt: text(window.detectedAt),
        recording: window.recording === true,
      }];
    }),
    lastMeeting: status.lastMeeting && lastMeetingWindowId ? {
      windowId: lastMeetingWindowId,
      platform: text(status.lastMeeting.platform),
      title: text(status.lastMeeting.title),
    } : undefined,
    platformSupport: {
      supported: status.platformSupport.supported,
      platform: status.platformSupport.platform,
      arch: status.platformSupport.arch,
      message: text(status.platformSupport.message),
    },
    autoRecord: status.settings.autoRecord,
  };
}

export function sanitizeRecallEventForNotch(event: unknown): ClementineNotchMeetingEvent | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const raw = event as Record<string, unknown>;
  const type = text(raw.type);
  if (!type || !LIVE_EVENT_TYPES.has(type)) return null;
  const safe: ClementineNotchMeetingEvent = { type };
  for (const key of ['at', 'windowId', 'platform', 'title', 'detectedAt', 'startedAt', 'endedAt', 'error', 'phase', 'reason', 'message', 'status'] as const) {
    const value = key === 'error' || key === 'message'
      ? safeError(raw[key])
      : text(raw[key], key === 'title' ? 240 : 512);
    if (value) safe[key] = value;
  }
  if (typeof raw.capturing === 'boolean') safe.capturing = raw.capturing;
  const mediaType = text(raw.mediaType ?? raw.typeName);
  if (mediaType) safe.mediaType = mediaType;
  return safe;
}

/** The local recorder tracks absolute file paths and sidecar details that the
 * sandboxed notch never needs. Keep only presentation and stream-health truth. */
export function sanitizeLocalMeetingRecorderForNotch(
  status: LocalMeetingRecorderStatus,
): ClementineNotchLocalMeetingRecorder {
  return {
    recording: status.recording,
    sessionId: text(status.sessionId, 80),
    title: text(status.title, 160),
    startedAt: text(status.startedAt, 80),
    bytes: Math.max(0, Number.isFinite(status.bytes) ? status.bytes : 0),
    durationSeconds: Math.max(0, Number.isFinite(status.durationSeconds) ? status.durationSeconds : 0),
    sampleRate: Math.max(0, Number.isFinite(status.sampleRate) ? status.sampleRate : 0),
    channels: Math.max(0, Number.isFinite(status.channels) ? status.channels : 0),
    stale: typeof status.stale === 'boolean' ? status.stale : undefined,
  };
}

export function isCurrentDetectedMeeting(
  status: RecallCaptureStatus | null | undefined,
  windowId: string,
): boolean {
  const id = windowId.trim();
  return Boolean(id && status?.detectedWindows.some((window) => window.windowId === id));
}
