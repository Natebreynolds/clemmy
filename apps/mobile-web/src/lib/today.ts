/**
 * The Today stack: what the day holds, in one list, from facts the phone
 * already has. Calendar next, what Clementine found on her own (heartbeat
 * items), what came back (finished work and updates). Pure, so the screen
 * and its test agree on the order and the words.
 */
import type { InboxNotification, ReminderItem } from './api';

export type TodayRowKind = 'calendar' | 'heartbeat' | 'delivered' | 'update';

export interface TodayRow {
  key: string;
  kind: TodayRowKind;
  /** Small eyebrow above the title: "Calendar", "Work review", "Delivered", "Update". */
  eyebrow: string;
  title: string;
  /** Sortable instant; calendar rows sort by when they happen, the rest by when they arrived. */
  at: string;
  /** A row Clementine raised on her own carries the id to mark it done. */
  notificationId?: string;
  /** The run or session the row points at, when it does. */
  sessionId?: string | null;
  needsAttention?: boolean;
}

/** A notification that a heartbeat raised (dashboard/needs-you.ts keys them so). */
export function isHeartbeatItem(row: Pick<InboxNotification, 'needsYouKey'>): boolean {
  return typeof row.needsYouKey === 'string' && row.needsYouKey.startsWith('heartbeat:');
}

function heartbeatName(key: string): string {
  const id = key.split(':')[1] ?? '';
  return id.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) || 'Heartbeat';
}

export function todayRows(input: {
  reminders: ReadonlyArray<ReminderItem>;
  notifications: ReadonlyArray<InboxNotification>;
  nowMs: number;
  limit?: number;
}): TodayRow[] {
  const limit = input.limit ?? 6;
  const rows: TodayRow[] = [];
  for (const item of input.reminders) {
    if (!item.at) continue;
    const at = Date.parse(item.at);
    if (!Number.isFinite(at) || at < input.nowMs - 60 * 60 * 1000) continue;
    rows.push({ key: `cal:${item.id}`, kind: 'calendar', eyebrow: 'Calendar', title: item.text, at: item.at });
  }
  for (const row of input.notifications) {
    if (isHeartbeatItem(row)) {
      if (row.read || !row.needsAttention) continue;
      rows.push({ key: `hb:${row.id}`, kind: 'heartbeat', eyebrow: heartbeatName(row.needsYouKey!), title: row.title, at: row.createdAt, notificationId: row.id, sessionId: row.context?.sessionId ?? null, needsAttention: true });
      continue;
    }
    // Open decisions live in Needs you; here only what finished or was read.
    if (row.needsAttention && !row.read) continue;
    const delivered = row.kind === 'workflow' || row.kind === 'execution' || row.kind === 'cron';
    rows.push({ key: `n:${row.id}`, kind: delivered ? 'delivered' : 'update', eyebrow: delivered ? 'Came back' : 'Update', title: row.title || 'Update from Clem', at: row.createdAt, notificationId: row.id, sessionId: row.context?.sessionId ?? null });
  }
  // Calendar first when it is soon, then the rest newest first.
  const soon = input.nowMs + 3 * 60 * 60 * 1000;
  rows.sort((a, b) => {
    const aSoon = a.kind === 'calendar' && Date.parse(a.at) <= soon;
    const bSoon = b.kind === 'calendar' && Date.parse(b.at) <= soon;
    if (aSoon !== bSoon) return aSoon ? -1 : 1;
    if (a.kind === 'heartbeat' !== (b.kind === 'heartbeat')) return a.kind === 'heartbeat' ? -1 : 1;
    return Date.parse(b.at) - Date.parse(a.at);
  });
  return rows.slice(0, limit);
}

/**
 * The once-a-day line under the greeting: what happened since you last
 * looked. Counts only; the rows below carry the detail, and the lead above
 * already says who needs you. Empty when nothing happened, so the line never
 * reads "0 finished".
 */
export function todayDigest(input: {
  notifications: ReadonlyArray<InboxNotification>;
  sinceMs: number;
}): string {
  let finished = 0;
  let raised = 0;
  for (const row of input.notifications) {
    const at = Date.parse(row.createdAt);
    if (!Number.isFinite(at) || at < input.sinceMs) continue;
    if (isHeartbeatItem(row)) { if (!row.read) raised += 1; continue; }
    if (row.kind === 'workflow' || row.kind === 'execution' || row.kind === 'cron') finished += 1;
  }
  const parts = [
    finished ? `${finished} finished` : '',
    raised ? `${raised} ${raised === 1 ? 'thing' : 'things'} Clementine noticed` : '',
  ].filter(Boolean);
  return parts.length ? `Since you last looked: ${parts.join(' · ')}` : '';
}

/** Shown once per calendar day, at the first open. */
export function shouldShowDigest(lastShownIso: string | null, nowMs: number): boolean {
  if (!lastShownIso) return true;
  const last = new Date(lastShownIso);
  const now = new Date(nowMs);
  return last.toDateString() !== now.toDateString();
}
