import { apiGet } from './api';

/**
 * Minimal "what is Clementine doing right now" payload for the desktop notch.
 * Mirrors the backend GET /api/console/live-activity shape, which derives it
 * from the shared activity snapshot (parity with the command center / Slack /
 * Discord). Kept intentionally small — the notch renders a single status pill.
 */
export interface NotchLiveActivity {
  state: 'idle' | 'working' | 'approval';
  title: string;
  detail: string;
  needsYouCount: number;
  runningCount: number;
  updatedAt: string;
}

export const getLiveActivity = () => apiGet<NotchLiveActivity>('/api/console/live-activity');
