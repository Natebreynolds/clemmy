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
  regions?: Record<string, string>;
  docsUrl?: string;
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
  title?: string;
  transcriptionStatus?: 'not_started' | 'queued' | 'transcribing' | 'ready' | 'failed' | 'cancelled' | string;
  transcriptionError?: string;
  transcriptionModel?: string;
}

export interface MeetingSegment { speaker?: string; text?: string; [k: string]: unknown }
export interface MeetingDetail {
  record?: {
    id?: string; provider?: string; source?: string; platform?: string; status?: string; startedAt?: string; endedAt?: string;
    segments?: MeetingSegment[]; artifactPath?: string;
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
