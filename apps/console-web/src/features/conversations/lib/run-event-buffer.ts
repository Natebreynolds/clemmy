import type { HarnessEvent } from '@/lib/types';

export interface RecentEventsPage {
  events?: HarnessEvent[];
  sessionStatus?: string;
  latestSeq?: number;
  page?: { version: 1; scannedThroughSeq: number; snapshotSeq: number; hasMore: boolean };
}

export interface StepBuffer {
  events: HarnessEvent[];
  maxSeq: number;
  /** Separate from events received live: a later live frame cannot skip history. */
  scanSeq: number;
  snapshotSeq?: number;
  seenSeq?: Set<number>;
}

export function recentEventsUrl(sessionId: string, buffer: Pick<StepBuffer, 'scanSeq' | 'snapshotSeq'>, limit: number): string {
  const query = new URLSearchParams({ sinceSeq: String(buffer.scanSeq), limit: String(limit) });
  if (buffer.snapshotSeq !== undefined) query.set('throughSeq', String(buffer.snapshotSeq));
  return `/api/sessions/${encodeURIComponent(sessionId)}/events/recent?${query}`;
}

/** Late replay can contain older rows than a live frame already in the buffer. */
export function appendRunEvents(buffer: StepBuffer, incoming: readonly HarnessEvent[]): number {
  const seen = buffer.seenSeq ??= new Set(buffer.events.filter(event => event.seq > 0).map(event => event.seq));
  let added = 0;
  let reordered = false;
  for (const event of incoming) {
    if (event.seq > 0) {
      if (seen.has(event.seq)) continue;
      seen.add(event.seq);
      reordered ||= event.seq < buffer.maxSeq || (buffer.events.length > 0 && buffer.events[buffer.events.length - 1]!.seq <= 0);
      buffer.maxSeq = Math.max(buffer.maxSeq, event.seq);
    }
    buffer.events.push(event);
    added += 1;
  }
  if (reordered) buffer.events.sort((a, b) => (a.seq > 0 ? a.seq : Infinity) - (b.seq > 0 ? b.seq : Infinity));
  return added;
}

export function advanceRunEventPage(buffer: Pick<StepBuffer, 'scanSeq' | 'snapshotSeq'>, data: RecentEventsPage, limit: number): {
  more: boolean;
  complete: boolean;
} {
  if (data.page !== undefined) {
    const page = data.page;
    if (page.version !== 1 || !Number.isSafeInteger(page.scannedThroughSeq)
      || !Number.isSafeInteger(page.snapshotSeq) || typeof page.hasMore !== 'boolean'
      || page.scannedThroughSeq < buffer.scanSeq || page.snapshotSeq < page.scannedThroughSeq
      || (buffer.snapshotSeq !== undefined && page.snapshotSeq !== buffer.snapshotSeq)
      || (page.hasMore && page.scannedThroughSeq === buffer.scanSeq)
      || (!page.hasMore && page.scannedThroughSeq !== page.snapshotSeq)) {
      throw new Error('This run’s history returned an invalid continuation.');
    }
    buffer.scanSeq = page.scannedThroughSeq;
    buffer.snapshotSeq = page.hasMore ? page.snapshotSeq : undefined;
    const newerRows = typeof data.latestSeq === 'number' && data.latestSeq > buffer.scanSeq;
    return { more: page.hasMore || newerRows, complete: !page.hasMore && !newerRows };
  }
  // Compatibility with an older daemon: public rows alone cannot prove that
  // private rows did not fill its raw page. Keep partial coverage explicit.
  const prior = buffer.scanSeq;
  buffer.scanSeq = Math.max(prior, ...(data.events ?? []).map(event => event.seq || 0));
  buffer.snapshotSeq = undefined;
  const progressed = buffer.scanSeq > prior;
  return {
    more: progressed && (data.events?.length ?? 0) >= limit,
    complete: typeof data.latestSeq === 'number' && data.latestSeq <= buffer.scanSeq,
  };
}
