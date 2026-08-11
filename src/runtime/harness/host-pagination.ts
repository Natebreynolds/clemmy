/**
 * The host follows the continuation, not the model.
 *
 * A paginated source used to cost one model turn per page: read, hand back a
 * cursor, wait for the model to copy it into the next call, repeat. That is
 * expensive, and it puts an opaque token through a component that is free to
 * paraphrase — a live turn stopped mid-collection with a cursor outstanding and
 * still reported done.
 *
 * So collection is a host loop. It stays on ONE requirement, under the same
 * authority, account and base arguments; it is bounded four ways; and a
 * collection that hits a bound is honestly partial rather than quietly short.
 */

export interface HostPaginationBounds {
  maxPages?: number;
  maxRecords?: number;
  maxBytes?: number;
  maxWallMs?: number;
}

export interface CollectCompleteSourceInput extends HostPaginationBounds {
  /**
   * One page. The host passes back the provider's own continuation, so cursor
   * bytes never leave this loop.
   */
  read: (cursor?: string) => unknown | Promise<unknown>;
  /** Called once per page with the raw payload, for single-write persistence. */
  persistPage?: (page: unknown, index: number) => void;
  /** Wall clock, injectable so bounds are testable without sleeping. */
  now?: () => number;
}

export type PaginationStopReason =
  | 'complete'
  | 'repeated_cursor'
  | 'max_pages'
  | 'max_records'
  | 'max_bytes'
  | 'max_wall_ms'
  | 'failed';

export interface CollectedSource {
  /** True ONLY when the source was exhausted. */
  complete: boolean;
  records: unknown[];
  pages: number;
  bytes: number;
  stopReason: PaginationStopReason;
  /** Set when a page failed; the aggregate is not usable as a snapshot. */
  failure?: { statusCode: number | null; page: number };
}

const DEFAULTS: Required<HostPaginationBounds> = {
  maxPages: 25,
  maxRecords: 5_000,
  maxBytes: 8_000_000,
  maxWallMs: 60_000,
};

/**
 * Collect every page of one source.
 *
 * Sequential by necessity: each page depends on the previous page's cursor, so
 * this is the case that must never be mistaken for parallelisable fan-out.
 */
export async function collectCompleteSource(
  input: CollectCompleteSourceInput,
): Promise<CollectedSource> {
  const bounds = { ...DEFAULTS, ...input };
  const now = input.now ?? (() => Date.now());
  const startedAt = now();

  const records: unknown[] = [];
  let pages = 0;
  let bytes = 0;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  for (;;) {
    if (pages >= bounds.maxPages) return partial('max_pages');
    if (now() - startedAt > bounds.maxWallMs) return partial('max_wall_ms');

    const page = await input.read(cursor);
    const { toResultHandle } = await import('./result-handle.js');
    const handle = toResultHandle(page, { skipRawStore: true });
    pages += 1;
    input.persistPage?.(page, pages - 1);

    if (!handle.success) {
      return {
        complete: false,
        records,
        pages,
        bytes,
        stopReason: 'failed',
        failure: { statusCode: handle.statusCode, page: pages },
      };
    }

    // Read the records from the raw page: the handle's projection is bounded
    // for the MODEL, and the host is collecting the real thing.
    const pageRecords = readRecords(page, handle.recordPath);
    records.push(...pageRecords);
    bytes += safeSize(page);

    if (records.length > bounds.maxRecords) return partial('max_records');
    if (bytes > bounds.maxBytes) return partial('max_bytes');

    const nextCursor = handle.continuationRef
      ? (await import('./result-handle.js')).resolveContinuation(handle.continuationRef)
      : undefined;
    if (!nextCursor || handle.completeness === 'complete') {
      return { complete: true, records, pages, bytes, stopReason: 'complete' };
    }
    // Continuations are opaque, but byte identity is still meaningful to the
    // host. Following one we have already received can only revisit an earlier
    // pagination state (including longer cycles such as A -> B -> A), so stop
    // before issuing another provider call and keep the aggregate partial.
    if (seenCursors.has(nextCursor)) return partial('repeated_cursor');
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  function partial(stopReason: PaginationStopReason): CollectedSource {
    // A bounded-out collection is a partial snapshot and must say so — the
    // caller may not treat it as the complete source.
    return { complete: false, records, pages, bytes, stopReason };
  }
}

function readRecords(page: unknown, recordPath: string | null): unknown[] {
  if (!recordPath) return [];
  let cursorValue: unknown = page;
  for (const segment of recordPath.split('.').filter(Boolean)) {
    const record = cursorValue && typeof cursorValue === 'object' && !Array.isArray(cursorValue)
      ? cursorValue as Record<string, unknown>
      : null;
    if (!record) return [];
    cursorValue = record[segment];
  }
  return Array.isArray(cursorValue) ? cursorValue : [];
}

function safeSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}
