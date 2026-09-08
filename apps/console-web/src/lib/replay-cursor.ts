import { advanceRunEventPage, recentEventsUrl, type RecentEventsPage } from '../features/conversations/lib/run-event-buffer';
import type { HarnessEvent } from './types';

/** Raw read coverage is independent of public events that happened to arrive
 * live. The set holds delivered events beyond that coverage for overlap only. */
export interface ReplayCursor {
  scanSeq: number;
  snapshotSeq?: number;
  pending?: boolean;
  seen: Set<string>;
}

export function createReplayCursor(sinceSeq = 0): ReplayCursor {
  return { scanSeq: sinceSeq, seen: new Set() };
}

export function copyReplayCursor(cursor: ReplayCursor): ReplayCursor {
  return { scanSeq: cursor.scanSeq, snapshotSeq: cursor.snapshotSeq, pending: cursor.pending, seen: new Set(cursor.seen) };
}

export function acceptReplayEvent(cursor: ReplayCursor, sessionId: string, event: HarnessEvent): boolean {
  if (!(event.seq > 0)) return true; // ephemeral token deltas are never deduped
  const own = !event.sessionId || event.sessionId === sessionId;
  if (own && event.seq <= cursor.scanSeq) return false;
  const key = `${event.sessionId || sessionId}\0${event.seq}`;
  if (cursor.seen.has(key)) return false;
  cursor.seen.add(key);
  return true;
}

function pruneScannedOwnEvents(cursor: ReplayCursor, sessionId: string): void {
  const prefix = `${sessionId}\0`;
  for (const key of cursor.seen) {
    if (key.startsWith(prefix) && Number(key.slice(prefix.length)) <= cursor.scanSeq) cursor.seen.delete(key);
  }
}

/** One bounded fetch turn. Continuation survives on cursor when the budget is
 * exhausted; callers retain their existing reconnect/poll schedule. */
export async function pollRecentReplayPages(input: {
  sessionId: string;
  cursor: ReplayCursor;
  fetchPage(url: string): Promise<RecentEventsPage>;
  onEvent(event: HarnessEvent): boolean | void;
  active(): boolean;
  limit?: number;
  maxPages?: number;
}): Promise<void> {
  const limit = input.limit ?? 500;
  const maxPages = Number.isSafeInteger(input.maxPages) && Number(input.maxPages) > 0 ? Math.min(4, Number(input.maxPages)) : 4;
  for (let pageNumber = 0; pageNumber < maxPages && input.active(); pageNumber += 1) {
    const data = await input.fetchPage(recentEventsUrl(input.sessionId, input.cursor, limit));
    if (!input.active()) return;
    const next = { scanSeq: input.cursor.scanSeq, snapshotSeq: input.cursor.snapshotSeq };
    const continuation = advanceRunEventPage(next, data, limit);
    // Validate raw continuation before presenting anything from this page.
    for (const event of data.events ?? []) {
      if (event.sessionId && event.sessionId !== input.sessionId) throw new Error('The session replay returned an unrelated event.');
      if (data.page && (!Number.isSafeInteger(event.seq) || event.seq <= input.cursor.scanSeq || event.seq > next.scanSeq)) {
        throw new Error('The session replay event falls outside its scanned page.');
      }
    }
    for (const event of data.events ?? []) {
      if (!input.active()) return;
      if (!acceptReplayEvent(input.cursor, input.sessionId, event)) continue;
      if (input.onEvent(event) === false || !input.active()) {
        // A terminal may stop part-way through a public page. Only the rows
        // through that terminal were consumed; its unread siblings stay due.
        input.cursor.scanSeq = Math.max(input.cursor.scanSeq, event.seq || 0);
        input.cursor.snapshotSeq = data.page && input.cursor.scanSeq < data.page.snapshotSeq ? data.page.snapshotSeq : undefined;
        input.cursor.pending = input.cursor.snapshotSeq !== undefined;
        pruneScannedOwnEvents(input.cursor, input.sessionId);
        return;
      }
    }
    input.cursor.scanSeq = next.scanSeq;
    input.cursor.snapshotSeq = next.snapshotSeq;
    input.cursor.pending = continuation.more;
    pruneScannedOwnEvents(input.cursor, input.sessionId);
    if (!continuation.more) return;
  }
}
