/** Heartbeats: what Clementine checks on her own, and the owner's contract for each. */
import { api, apiGet, apiPost } from './api';

export type HeartbeatId = 'work-review' | 'calendar' | 'workflow-suggestions' | 'noticing';
export type HeartbeatNotifyMode = 'quiet' | 'push';

export interface HeartbeatRule {
  id: string;
  text: string;
  by: 'owner' | 'clementine';
  createdAt: string;
}

export interface HeartbeatItem {
  key: string;
  kind: string;
  subject: string;
  detail?: string;
  createdAt: string;
  acknowledgedAt?: string;
  retiredAt?: string;
  retiredReason?: string;
}

export interface HeartbeatStatus {
  id: HeartbeatId;
  title: string;
  purpose: string;
  enabled: boolean;
  cadenceMinutes: number;
  cadenceRange: { min: number; max: number };
  quietHoursActive: boolean;
  running: boolean;
  lastTickAt?: string;
  nextTickAt?: string;
  lastFinding?: { at: string; summary: string; quiet: boolean; durationMs: number };
  lastError?: { at: string; reason: string };
  metrics: { ticks: number; quietTicks: number; itemsProduced: number; itemsAcknowledged: number; itemsRetired: number; modelCalls: number; modelVetoes: number };
  openItems: HeartbeatItem[];
  recentlyRetired: HeartbeatItem[];
  rulesApply: boolean;
  contract: { id: string; notify: HeartbeatNotifyMode; rules: HeartbeatRule[]; updatedAt: string };
  /** Whether "reach my phone" could reach one right now, and if not, why. */
  phonePush: { ready: boolean; reason?: 'no_phone_registered' | 'apns_key_missing'; phones: { webPush: number; apns: number } };
}

export const listHeartbeats = () => apiGet<{ heartbeats: HeartbeatStatus[] }>('/api/console/heartbeats');
export const patchHeartbeat = (id: HeartbeatId, patch: { enabled?: boolean; cadenceMinutes?: number; notify?: HeartbeatNotifyMode }) =>
  api<{ heartbeat: HeartbeatStatus }>(`/api/console/heartbeats/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const tickHeartbeat = (id: HeartbeatId) =>
  apiPost<{ tick: { summary: string; produced: number; quiet: boolean }; heartbeat: HeartbeatStatus }>(`/api/console/heartbeats/${encodeURIComponent(id)}/tick`, {});
export const addHeartbeatRule = (id: HeartbeatId, text: string) =>
  apiPost<{ rule: HeartbeatRule; heartbeat: HeartbeatStatus }>(`/api/console/heartbeats/${encodeURIComponent(id)}/rules`, { text });
export const removeHeartbeatRule = (id: HeartbeatId, ruleId: string) =>
  api<{ heartbeat: HeartbeatStatus }>(`/api/console/heartbeats/${encodeURIComponent(id)}/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });

/** "every 2 h", "every 45 min", "every day" */
export function cadenceWords(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return minutes === 1440 ? 'every day' : `every ${minutes / 1440} days`;
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? 'every hour' : `every ${minutes / 60} h`;
  return `every ${minutes} min`;
}

/** The cadences a heartbeat may pick from, within its range. */
export function cadenceChoices(range: { min: number; max: number }, current: number): number[] {
  const all = [5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440];
  const inRange = all.filter((m) => m >= range.min && m <= range.max);
  return inRange.includes(current) ? inRange : [...inRange, current].sort((a, b) => a - b);
}

/** Why push would not reach a phone today, in the owner's terms; empty when it would. */
export function phonePushCaveat(readiness: HeartbeatStatus['phonePush'] | undefined): string {
  if (!readiness || readiness.ready) return '';
  if (readiness.reason === 'apns_key_missing') return 'Your phone is paired, but this Mac has no Apple push key yet, so these items stay in the app for now.';
  return 'No phone is set up for notifications yet. Open Clem on your phone and allow notifications; until then these items stay in the app.';
}

/** The opening line of a chat about a heartbeat: names it and stops. */
export function refineHeartbeatPrompt(title: string): string {
  return `About my "${title}" heartbeat: `;
}
