import { getLatestEventSeq, listEvents, type EventRow } from './eventlog.js';
import { projectHarnessEventsForPublic } from './public-presentation.js';

export interface PublicEventPage {
  events: EventRow[];
  latestSeq: number;
  page: {
    version: 1;
    /** Raw rows scanned, including rows omitted from public presentation. */
    scannedThroughSeq: number;
    /** Frozen raw frontier for this traversal; later events belong to a new one. */
    snapshotSeq: number;
    hasMore: boolean;
  };
}

function sequence(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return number;
}

/** Read membership/authentication stays with the route. A public event count
 * cannot advance a raw cursor: an entire page can contain private audit rows. */
export function readPublicHarnessEventPage(
  sessionId: string,
  query: { sinceSeq?: unknown; throughSeq?: unknown; limit?: unknown } = {},
): PublicEventPage {
  const sinceSeq = sequence(query.sinceSeq, 'sinceSeq', 0);
  const limit = Math.max(1, Math.min(500, sequence(query.limit, 'limit', 500)));
  const latestSeq = getLatestEventSeq(sessionId);
  // A client with a later live event may have advanced beyond the retained
  // own-session frontier. An empty traversal must never move it backwards.
  const snapshotSeq = sequence(query.throughSeq, 'throughSeq', Math.max(sinceSeq, latestSeq));
  if (snapshotSeq < sinceSeq) throw new RangeError('throughSeq precedes sinceSeq');
  const rows = listEvents(sessionId, { sinceSeq, throughSeq: snapshotSeq, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const scanned = rows.slice(0, limit);
  const scannedThroughSeq = hasMore ? scanned[scanned.length - 1]!.seq : snapshotSeq;
  return {
    events: projectHarnessEventsForPublic(scanned),
    latestSeq,
    page: { version: 1, scannedThroughSeq, snapshotSeq, hasMore },
  };
}
