import type { RecallCaptureStatus } from './recall-capture.js';

export interface RecallMeetingStopTarget {
  windowId: string;
  recordingStartedAt: string;
}

type CaptureStatus = Pick<RecallCaptureStatus,
  'recording' | 'capturePhase' | 'currentWindowId' | 'recordingStartedAt' | 'detectedWindows'>;

function windowIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,511}$/.test(value);
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Synchronous IPC admission only. The caller must invoke stopRecording
 * immediately after this check, without an await between observation/action.
 * Undefined preserves existing general Stop controls; a supplied exact target
 * must never stop a different or replacement recording. */
export function assertRecallMeetingStopTarget(payload: unknown, status: CaptureStatus | null | undefined): void {
  if (payload === undefined) return;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).sort().join(',') !== 'recordingStartedAt,windowId') {
    throw new Error('That meeting recording is no longer active. Refresh its controls.');
  }
  const { windowId, recordingStartedAt } = payload as Record<string, unknown>;
  if (!windowIdentity(windowId) || !timestamp(recordingStartedAt) || !status?.recording
    || (status.capturePhase !== 'starting' && status.capturePhase !== 'recording')
    || status.currentWindowId !== windowId || status.recordingStartedAt !== recordingStartedAt) {
    throw new Error('That meeting recording is no longer active. Refresh its controls.');
  }
}

/** Optional generation check for new exact-window controls. Legacy callers
 * without detectedAt keep their existing single-window-id behavior. */
export function assertRecallMeetingDetectionTarget(windowId: string, detectedAt: unknown,
  status: CaptureStatus | null | undefined): void {
  if (detectedAt === undefined) return;
  if (!windowIdentity(windowId) || !timestamp(detectedAt)
    || !status?.detectedWindows.some(window => window.windowId === windowId && window.detectedAt === detectedAt)) {
    throw new Error('That detected meeting changed or closed. Refresh its controls.');
  }
}
