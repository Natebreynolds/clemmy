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
  activeWindowId?: string;
  /** startedAt of that active recording, so notes can be timestamped. */
  activeStartedAt?: string;
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

export interface MeetingSummary {
  id: string;
  provider?: 'recall' | 'local' | string;
  source?: string;
  windowId?: string;
  platform?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  segmentCount?: number;
  notesCount?: number;
  title?: string;
  transcriptionStatus?: 'not_started' | 'queued' | 'transcribing' | 'ready' | 'failed' | 'cancelled' | string;
  transcriptionError?: string;
  transcriptionModel?: string;
}

export interface MeetingSegment { speaker?: string; text?: string; [k: string]: unknown }
export interface MeetingDetail {
  record?: {
    id?: string; provider?: string; source?: string; platform?: string; status?: string; startedAt?: string; endedAt?: string;
    windowId?: string; segments?: MeetingSegment[]; notes?: MeetingNote[]; artifactPath?: string;
    transcriptionStatus?: string; transcriptionError?: string; transcriptionModel?: string;
  };
  analysis?: {
    title?: string; summary?: string;
    decisions?: string[]; actionItems?: string[]; topics?: string[]; participants?: string[];
  };
}

export const getRecallStatus = () => apiGet<RecallStatus>('/api/console/meetings/recall');
export const patchRecallSettings = (settings: Partial<RecallSettings>) =>
  api<{ settings: RecallSettings }>('/api/console/meetings/recall/settings', { method: 'PATCH', body: JSON.stringify(settings) });
export const patchLocalMeetingSettings = (settings: Partial<LocalMeetingSettings>) =>
  api<{ settings: LocalMeetingSettings }>('/api/console/meetings/local/settings', { method: 'PATCH', body: JSON.stringify(settings) });
export const retryLocalMeetingTranscription = (meetingId: string) =>
  api<{ record: Record<string, unknown>; queue: Record<string, unknown> }>('/api/console/meetings/local/retry', {
    method: 'POST',
    body: JSON.stringify({ meetingId }),
  });
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
