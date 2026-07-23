/**
 * U5 — desktop as a first-class loud notification destination.
 *
 * Pure logic for the shell's notification poll: which pending items become
 * native toasts this cycle, how many are collapsed into a summary toast, and
 * how the `since` watermark advances. The I/O (HTTP poll against the daemon,
 * `new Notification(...)`, marking read) lives in main.ts; everything here is
 * deterministic so it can be unit-tested without Electron.
 */

/** One loud, unread notification as returned by the daemon poll endpoint. */
export interface DesktopPendingNotification {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  kind?: string;
}

/** At most this many individual native toasts per poll cycle (burst safety). */
export const DESKTOP_TOAST_BURST_CAP = 3;

export interface DesktopToastPlan {
  /** Individual native toasts to show this cycle (length ≤ cap). */
  toasts: DesktopPendingNotification[];
  /**
   * When more items are pending than the cap allows, a single collapsed toast
   * covering the remainder ("N more updates — open Clementine"); otherwise null.
   */
  summary: { count: number } | null;
  /**
   * Every id surfaced this cycle (shown individually *and* folded into the
   * summary). Add these to the dedupe set so a slow read-mark or an
   * un-advanced watermark can't replay them next cycle.
   */
  seenIds: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Normalize an untrusted `desktop-pending` payload into typed items + `now`.
 * Anything missing an id or with a malformed shape is dropped rather than
 * throwing, so one bad row can't stall the whole poll.
 */
export function parseDesktopPendingResponse(payload: unknown): {
  items: DesktopPendingNotification[];
  now: string | undefined;
} {
  if (!payload || typeof payload !== 'object') return { items: [], now: undefined };
  const raw = payload as { items?: unknown; now?: unknown };
  const now = isNonEmptyString(raw.now) && Number.isFinite(Date.parse(raw.now))
    ? raw.now
    : undefined;
  const items: DesktopPendingNotification[] = [];
  if (Array.isArray(raw.items)) {
    for (const entry of raw.items) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      if (!isNonEmptyString(row.id)) continue;
      items.push({
        id: row.id.trim(),
        title: isNonEmptyString(row.title) ? row.title : 'Clementine',
        body: typeof row.body === 'string' ? row.body : '',
        createdAt: isNonEmptyString(row.createdAt) ? row.createdAt : new Date().toISOString(),
        kind: isNonEmptyString(row.kind) ? row.kind : undefined,
      });
    }
  }
  return { items, now };
}

/**
 * Decide which pending items to toast this cycle. Filters out ids already
 * surfaced (`alreadySeen`), dedupes within the batch, applies the burst cap,
 * and collapses any remainder into a single summary.
 */
export function planDesktopToasts(
  items: readonly DesktopPendingNotification[],
  alreadySeen: ReadonlySet<string>,
  cap: number = DESKTOP_TOAST_BURST_CAP,
): DesktopToastPlan {
  const effectiveCap = Math.max(0, Math.floor(cap));
  const fresh: DesktopPendingNotification[] = [];
  const batchSeen = new Set<string>();
  for (const item of items) {
    const id = item?.id?.trim();
    if (!id || alreadySeen.has(id) || batchSeen.has(id)) continue;
    batchSeen.add(id);
    fresh.push({ ...item, id });
  }

  if (fresh.length <= effectiveCap) {
    return { toasts: fresh, summary: null, seenIds: fresh.map((i) => i.id) };
  }
  const toasts = fresh.slice(0, effectiveCap);
  return {
    toasts,
    summary: { count: fresh.length - effectiveCap },
    seenIds: fresh.map((i) => i.id),
  };
}

/**
 * Advance the `since` watermark monotonically. Prefers the server's `now`
 * (authoritative clock), but never moves backwards — a clock skew or a missing
 * `now` keeps the current watermark rather than replaying the backlog.
 */
export function advanceWatermark(current: string, responseNow: string | undefined): string {
  if (!isNonEmptyString(responseNow)) return current;
  const next = Date.parse(responseNow);
  if (!Number.isFinite(next)) return current;
  const prev = Date.parse(current);
  if (!Number.isFinite(prev)) return responseNow;
  return next >= prev ? responseNow : current;
}
