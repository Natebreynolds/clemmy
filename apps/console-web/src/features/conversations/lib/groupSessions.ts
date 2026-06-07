import type { Session } from '../types';

export interface SessionGroup {
  label: string;
  items: Session[];
}

function dayBucket(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'Earlier';
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (t >= startOfToday) return 'Today';
  if (t >= startOfToday - dayMs) return 'Yesterday';
  if (t >= startOfToday - 7 * dayMs) return 'Previous 7 days';
  if (t >= startOfToday - 30 * dayMs) return 'Previous 30 days';
  return 'Earlier';
}

const ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Earlier'];

/**
 * Split sessions into a Pinned section (if any) followed by date buckets.
 * Input is assumed already sorted (pinned first, then updatedAt desc) by
 * the server, so we preserve order within each bucket.
 */
export function groupSessions(sessions: Session[], now: number): SessionGroup[] {
  const pinned = sessions.filter((s) => s.pinned);
  const rest = sessions.filter((s) => !s.pinned);

  const buckets = new Map<string, Session[]>();
  for (const s of rest) {
    const label = dayBucket(s.updatedAt, now);
    const arr = buckets.get(label) ?? [];
    arr.push(s);
    buckets.set(label, arr);
  }

  const groups: SessionGroup[] = [];
  if (pinned.length) groups.push({ label: 'Pinned', items: pinned });
  for (const label of ORDER) {
    const items = buckets.get(label);
    if (items?.length) groups.push({ label, items });
  }
  return groups;
}

/** All distinct tags across the sessions, sorted, for the filter bar. */
export function collectTags(sessions: Session[]): string[] {
  const set = new Set<string>();
  for (const s of sessions) for (const t of s.tags) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
}
