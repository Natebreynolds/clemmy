import { apiGet, api } from './api';

export interface RecallSettings {
  enabled?: boolean;
  region?: string;
  autoRecord?: boolean;
  liveTranscript?: boolean;
  analyzeOnComplete?: boolean;
  retentionMode?: 'zero' | 'timed';
  retentionHours?: number;
}
export interface RecallStatus {
  settings?: RecallSettings;
  credential?: { status?: string; source?: string; hasValue?: boolean };
  /** windowId of the Recall meeting currently recording, if any — used to key
   *  the live scratchpad during a Zoom/Meet/Teams call. */
  activeMeetingId?: string;
  activeWindowId?: string;
  /** startedAt of that active recording, so notes can be timestamped. */
  activeStartedAt?: string;
  /** Exact native recording epoch; separate from first detection. */
  activeRecordingStartedAt?: string;
  regions?: Record<string, string>;
  docsUrl?: string;
}

export type MeetingNoteKind = 'action' | 'question' | 'followup';
export interface MeetingNote {
  id: string;
  text: string;
  kind?: MeetingNoteKind;
  atSeconds?: number;
  createdAt: string;
}

export interface LocalMeetingSettings {
  enabled?: boolean;
  analyzeOnComplete?: boolean;
  model?: 'base.en';
  language?: string;
  keepAudio?: boolean;
}

export interface LocalMeetingRuntimeStatus {
  available?: boolean;
  modelReady?: boolean;
  modelPath?: string;
  reason?: string;
  platform?: string;
}

export interface LocalMeetingStatus {
  liveTranscript?: {
    segments?: Array<{ text: string; startSeconds: number; endSeconds: number }>;
    throughSeconds?: number;
    updatedAt?: string;
    lastError?: string;
  };
  settings?: LocalMeetingSettings;
  runtime?: LocalMeetingRuntimeStatus;
  recorder?: {
    recording?: boolean;
    sessionId?: string;
    startedAt?: string;
    durationSeconds?: number;
  };
  queue?: { activeMeetingId?: string; queuedMeetingIds?: string[] };
}

export type RecallMeetingPresentationStatus =
  | 'detected'
  | 'recording'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'timed_out'
  | 'unavailable'
  | 'cancelled';

export interface RecallMeetingPresentation {
  status: RecallMeetingPresentationStatus;
  label: string;
  error?: string;
  retryable: boolean;
}

export interface MeetingSummary {
  id: string;
  provider?: 'recall' | 'local' | string;
  source?: string;
  windowId?: string;
  platform?: string;
  status?: string;
  startedAt?: string;
  recordingStartedAt?: string;
  endedAt?: string;
  segmentCount?: number;
  notesCount?: number;
  title?: string;
  transcriptionStatus?: 'not_started' | 'queued' | 'transcribing' | 'ready' | 'failed' | 'cancelled' | string;
  transcriptionError?: string;
  transcriptionModel?: string;
  sdkUploadStatus?: 'pending' | 'complete' | 'failed' | 'timed_out' | string;
  sdkUploadError?: string;
  canonicalStatus?: 'not_started' | 'pending' | 'ready' | 'failed' | 'timed_out' | string;
  canonicalError?: string;
  presentation?: RecallMeetingPresentation;
}

export interface MeetingSegment { speaker?: string; text?: string; [k: string]: unknown }
export interface MeetingDetail {
  record?: {
    id?: string; provider?: string; source?: string; platform?: string; status?: string; startedAt?: string; endedAt?: string;
    windowId?: string; sdkUploadId?: string; recordingId?: string; recordingStartedAt?: string; segments?: MeetingSegment[]; notes?: MeetingNote[]; artifactPath?: string;
    transcriptionStatus?: string; transcriptionError?: string; transcriptionModel?: string;
    sdkUploadStatus?: string; sdkUploadError?: string; canonicalStatus?: string; canonicalError?: string;
  };
  presentation?: RecallMeetingPresentation;
  analysisState?: {
    status: 'off' | 'queued' | 'running' | 'complete' | 'failed' | 'incomplete' | 'unavailable';
    taskId?: string;
    partialTranscript?: boolean;
  };
  analysis?: {
    title?: string; summary?: string;
    decisions?: string[]; actionItems?: string[]; topics?: string[]; participants?: string[];
  };
}

export const getRecallStatus = () => apiGet<RecallStatus>('/api/console/meetings/recall');
export const patchRecallSettings = (settings: Partial<RecallSettings>) =>
  api<{ settings: RecallSettings }>('/api/console/meetings/recall/settings', { method: 'PATCH', body: JSON.stringify(settings) });
export const getLocalMeetingSettings = () =>
  apiGet<{ settings: LocalMeetingSettings }>('/api/console/meetings/local/settings');
export const patchLocalMeetingSettings = (settings: Partial<LocalMeetingSettings>) =>
  api<{ settings: LocalMeetingSettings }>('/api/console/meetings/local/settings', { method: 'PATCH', body: JSON.stringify(settings) });
export const retryLocalMeetingTranscription = (meetingId: string) =>
  api<{ record: Record<string, unknown>; queue: Record<string, unknown> }>('/api/console/meetings/local/retry', {
    method: 'POST',
    body: JSON.stringify({ meetingId }),
  });
export const retryRecallMeetingTranscript = (meetingId: string) =>
  api<{
    status: 'started' | 'already_running';
    mode?: 'sdk_upload' | 'canonical';
    presentation?: RecallMeetingPresentation;
  }>(`/api/console/meetings/recall/${encodeURIComponent(meetingId)}/retry-transcript`, {
    method: 'POST',
  });

/** Explicit owner recovery only; reading a meeting never reaches this door. */
export async function retryRecallMeetingAnalysis(meetingId: string, expectedTaskId: string | null): Promise<{ taskId: string }> {
  const result = await api<unknown>(`/api/console/meetings/recall/${encodeURIComponent(meetingId)}/analysis/retry`, {
    method: 'POST', body: JSON.stringify({ expectedTaskId }),
  });
  const taskId = result && typeof result === 'object' && 'taskId' in result ? result.taskId : undefined;
  if (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 200 || /[\u0000-\u001f\u007f]/.test(taskId)) throw new Error('Summary recovery could not be confirmed.');
  return { taskId };
}
export const listMeetings = () => apiGet<{ meetings: MeetingSummary[] }>('/api/console/meetings/recall/recent');
export const getMeeting = (id: string) => apiGet<MeetingDetail>(`/api/console/meetings/recall/${encodeURIComponent(id)}`);
export const getMeetingChatPrompt = (id: string) =>
  apiGet<{ prompt: string }>(`/api/console/meetings/recall/${encodeURIComponent(id)}/chat-prompt`);

// ── Live scratchpad notes (keyed by windowId; works for in-person + Recall) ──
export const listMeetingNotes = (windowId: string) =>
  apiGet<{ notes: MeetingNote[] }>(`/api/console/meetings/notes?windowId=${encodeURIComponent(windowId)}`);
export const addMeetingNote = (windowId: string, note: { text: string; kind?: MeetingNoteKind; atSeconds?: number }) =>
  api<{ note: MeetingNote; notes: MeetingNote[] }>('/api/console/meetings/notes', {
    method: 'POST', body: JSON.stringify({ windowId, ...note }),
  });
export const updateMeetingNote = (windowId: string, id: string, patch: { text?: string; kind?: MeetingNoteKind | null }) =>
  api<{ notes: MeetingNote[] }>('/api/console/meetings/notes', {
    method: 'PATCH', body: JSON.stringify({ windowId, id, ...patch }),
  });
export const deleteMeetingNote = (windowId: string, id: string) =>
  api<{ notes: MeetingNote[] }>('/api/console/meetings/notes', {
    method: 'DELETE', body: JSON.stringify({ windowId, id }),
  });

type MeetingTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral' | 'live';
export const RECALL_MEETING_DETAIL_POLL_MS = 5_000;

/** Keep only the selected meeting fresh while its transcript or exact summary
 * task can change. A transcript becoming ready does not finish its summary. */
export function recallMeetingDetailPollInterval(detail?: MeetingDetail): number | false {
  const status = detail?.presentation?.status;
  const analysis = detail?.analysisState;
  return status === 'recording' || status === 'processing'
    || (Boolean(analysis?.taskId) && (analysis?.status === 'queued' || analysis?.status === 'running'))
    ? RECALL_MEETING_DETAIL_POLL_MS
    : false;
}

export function meetingAnalysisNotice(detail?: MeetingDetail): {
  title: string; description?: string; attention: boolean; canRefresh: boolean; taskHref?: string;
} | null {
  const analysis = detail?.analysisState;
  if (!analysis) return null;
  const taskHref = analysis.taskId ? `/tasks?select=${encodeURIComponent(analysis.taskId)}` : undefined;
  switch (analysis.status) {
    case 'queued': return { title: 'Summary queued', description: 'Clem is waiting to prepare this meeting’s summary and action items.', attention: false, canRefresh: false, taskHref };
    case 'running': return { title: 'Preparing your meeting summary', description: 'Clem is working on this meeting’s summary and action items.', attention: false, canRefresh: false, taskHref };
    case 'complete': return { title: 'Summary ready', attention: false, canRefresh: false };
    case 'failed': return { title: 'The summary couldn’t be prepared', description: taskHref ? 'The summary task failed. You can open the task to see where it stopped.' : 'The summary task failed. Read its status again to check for an update.', attention: true, canRefresh: true, taskHref };
    case 'incomplete': return { title: 'The summary isn’t complete', description: taskHref ? 'The task ended without a saved meeting summary. You can open the task to see where it stopped.' : 'No saved meeting summary is available. Read its status again to check for an update.', attention: true, canRefresh: true, taskHref };
    case 'unavailable': return { title: 'Summary status couldn’t be read', description: 'Clem couldn’t confirm what happened to this meeting’s summary task. Read its status again before trying anything else.', attention: true, canRefresh: true, taskHref };
    case 'off': return { title: 'Automatic summary is off', description: 'You can still discuss this meeting with Clem in chat.', attention: false, canRefresh: false };
  }
}

export function canRetryMeetingAnalysis(detail?: MeetingDetail): boolean {
  return detail?.record?.status === 'completed' && detail.record.provider !== 'local'
    && typeof detail.record.id === 'string' && Boolean(detail.record.id.trim())
    && typeof detail.record.artifactPath === 'string' && Boolean(detail.record.artifactPath.trim())
    && Boolean(detail.analysisState && ['failed', 'incomplete', 'unavailable'].includes(detail.analysisState.status));
}

/** Transcript-aware row tone. Never turns raw capture completion into green success. */
export function recallMeetingTone(meeting: MeetingSummary): { tone: MeetingTone; label: string } {
  const presentation = meeting.presentation;
  if (presentation) {
    switch (presentation.status) {
      case 'ready': return { tone: 'success', label: presentation.label };
      case 'recording':
      case 'processing': return { tone: 'live', label: presentation.label };
      case 'failed':
      case 'timed_out':
      case 'unavailable': return { tone: 'danger', label: presentation.label };
      case 'detected': return { tone: 'warning', label: presentation.label };
      case 'cancelled': return { tone: 'neutral', label: presentation.label };
    }
  }

  // Defensive fallback for a temporarily mismatched daemon/UI bundle.
  if (meeting.sdkUploadStatus === 'failed') return { tone: 'danger', label: 'Upload failed' };
  if (meeting.sdkUploadStatus === 'timed_out') return { tone: 'danger', label: 'Upload timed out' };
  if (meeting.canonicalStatus === 'failed') return { tone: 'danger', label: 'Transcript failed' };
  if (meeting.canonicalStatus === 'timed_out') return { tone: 'danger', label: 'Transcript timed out' };
  if (meeting.sdkUploadStatus === 'pending') return { tone: 'live', label: 'Processing upload' };
  if (meeting.canonicalStatus === 'pending') return { tone: 'live', label: 'Processing transcript' };
  if (meeting.status === 'recording') return { tone: 'live', label: 'Recording' };
  if (meeting.status === 'cancelled') return { tone: 'neutral', label: 'Cancelled' };
  if (meeting.status === 'completed' && (meeting.segmentCount ?? 0) > 0) {
    return { tone: 'success', label: 'Transcribed' };
  }
  if (meeting.status === 'completed') return { tone: 'danger', label: 'Transcript unavailable' };
  return { tone: 'warning', label: 'Waiting' };
}
