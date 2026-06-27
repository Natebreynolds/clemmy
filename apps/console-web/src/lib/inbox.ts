import { apiGet, apiPost } from './api';

export interface ApprovalRow {
  approvalId: string;
  sessionId?: string | null;
  subject: string;
  tool?: string | null;
  args?: unknown;
  status: string;
  requestedAt?: string;
  expiresAt?: string;
  kind?: string;
}

export interface RunRow {
  id: string;
  sessionId?: string;
  kind?: string;
  channel?: string;
  source?: string;
  title: string;
  input?: string;
  status: string;
  statusLabel?: string;
  runState?: string;
  runStateLabel?: string;
  needsAttention?: boolean;
  preview?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  outputPreview?: string;
  error?: string;
}

export interface NotificationRow {
  id: string;
  title?: string;
  body?: string;
  createdAt?: string;
  read?: boolean;
  kind?: string;
  deliveredAt?: string;
  deliveryAttempts?: number;
  deliveryError?: string;
}

export const listApprovals = () =>
  apiGet<{ approvals: ApprovalRow[]; count: number }>('/api/console/approvals/list');

// Runtime approvals (chat/Discord/CLI loop) resolve via /api/approvals/:id/:decision;
// harness approvals via /api/console/harness-approvals/:id/:decision. The list
// returns both kinds, so route by the row's `kind`.
export const decideApproval = (
  id: string,
  decision: 'approve' | 'reject',
  opts?: { kind?: string; modifiedArgs?: string },
) => {
  const path = opts?.kind === 'runtime'
    ? `/api/approvals/${encodeURIComponent(id)}/${decision}`
    : `/api/console/harness-approvals/${encodeURIComponent(id)}/${decision}`;
  return apiPost(path, opts?.modifiedArgs ? { modifiedArgs: opts.modifiedArgs } : undefined);
};

export const cancelStaleApprovals = () => apiPost('/api/console/approvals/cancel-stale');

export const listRuns = (limit = 40) => apiGet<{ runs: RunRow[] }>(`/api/runs?limit=${limit}`);

// 300 matches the command-center feed window — Home "Needs you" cards can
// deep-link to any notification the feed surfaced, so the Inbox must be able
// to find it (50 left older anchors unselectable).
export const listNotifications = () =>
  apiGet<{ notifications: NotificationRow[] }>('/api/notifications?limit=300');

/** Dismiss a "Needs you" card (check-in / plan / proposal). */
export const dismissInboxItem = (kind: string, id: string) =>
  apiPost(`/api/console/inbox/dismiss`, { kind, id });

export const markNotificationRead = (id: string) =>
  apiPost(`/api/notifications/${encodeURIComponent(id)}/read`);

export const retryNotification = (id: string) =>
  apiPost(`/api/notifications/${encodeURIComponent(id)}/retry`);

/** Friendly relative time ("4m", "2h", "3d", "now"). */
export function relativeTime(value?: string | number | null): string {
  if (!value) return '';
  const t = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

import type { Tone } from '@/components/ui/StatusPill';

/** Map a run/notification status to a semantic tone + label. */
export function statusTone(status?: string): { tone: Tone; label: string } {
  const s = (status ?? '').toLowerCase();
  if (['completed', 'complete', 'done', 'delivered', 'sent', 'ok'].includes(s)) return { tone: 'success', label: 'Done' };
  if (['failed', 'error', 'not_delivered'].includes(s)) return { tone: 'danger', label: 'Failed' };
  if (['running', 'active', 'received', 'in_progress'].includes(s)) return { tone: 'live', label: 'Working' };
  if (['awaiting_approval', 'needs_attention', 'paused', 'queued', 'pending'].includes(s)) {
    return { tone: 'warning', label: s === 'needs_attention' ? 'Needs attention' : 'Waiting' };
  }
  if (['cancelled', 'canceled'].includes(s)) return { tone: 'neutral', label: 'Cancelled' };
  return { tone: 'neutral', label: status || 'Unknown' };
}

/** Notification pill derived from real delivery fields (no `status` exists). */
export function notifTone(n: NotificationRow): { tone: Tone; label: string } {
  if (notifFailed(n)) return { tone: 'danger', label: 'Failed' };
  if (n.deliveredAt) return { tone: 'success', label: 'Sent' };
  const kind = (n.kind ?? '').toLowerCase();
  if (kind === 'approval') return { tone: 'warning', label: 'Approval' };
  if (kind) return { tone: 'neutral', label: kind.charAt(0).toUpperCase() + kind.slice(1) };
  return { tone: 'neutral', label: 'Update' };
}

/** A notification whose delivery to an external destination failed. */
export function notifFailed(n: NotificationRow): boolean {
  return Boolean(n.deliveryError) || ((n.deliveryAttempts ?? 0) > 0 && !n.deliveredAt);
}
