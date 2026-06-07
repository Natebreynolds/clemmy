import { apiGet, api } from './api';

export interface RecallSettings {
  enabled?: boolean;
  region?: string;
  autoRecord?: boolean;
  liveTranscript?: boolean;
  analyzeOnComplete?: boolean;
}
export interface RecallStatus {
  settings?: RecallSettings;
  credential?: { status?: string; source?: string; hasValue?: boolean };
  regions?: Record<string, string>;
  docsUrl?: string;
}

export interface MeetingSummary {
  id: string;
  windowId?: string;
  platform?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  segmentCount?: number;
  title?: string;
}

export interface MeetingSegment { speaker?: string; text?: string; [k: string]: unknown }
export interface MeetingDetail {
  record?: {
    id?: string; platform?: string; status?: string; startedAt?: string; endedAt?: string;
    segments?: MeetingSegment[]; artifactPath?: string;
  };
  analysis?: {
    title?: string; summary?: string;
    decisions?: string[]; actionItems?: string[]; topics?: string[]; participants?: string[];
  };
}

export const getRecallStatus = () => apiGet<RecallStatus>('/api/console/meetings/recall');
export const patchRecallSettings = (settings: Partial<RecallSettings>) =>
  api<{ settings: RecallSettings }>('/api/console/meetings/recall/settings', { method: 'PATCH', body: JSON.stringify(settings) });
export const listMeetings = () => apiGet<{ meetings: MeetingSummary[] }>('/api/console/meetings/recall/recent');
export const getMeeting = (id: string) => apiGet<MeetingDetail>(`/api/console/meetings/recall/${encodeURIComponent(id)}`);
export const getMeetingChatPrompt = (id: string) =>
  apiGet<{ prompt: string }>(`/api/console/meetings/recall/${encodeURIComponent(id)}/chat-prompt`);
