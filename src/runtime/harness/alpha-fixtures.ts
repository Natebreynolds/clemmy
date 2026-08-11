/**
 * Provider-neutral source/sink fixtures.
 *
 * AlphaSource is a paginated read; AlphaSink is an external artifact you can
 * write to and read back. Neither corresponds to a real vendor, and nothing in
 * the runtime may branch on their names — they exist so the behaviours the
 * traces exposed (dependent cursors, opaque envelope metadata, two carrier
 * encodings of one call, receipts that are not verification) can be pinned
 * without smuggling a provider into the kernel.
 *
 * Test-only module: never imported by production code.
 */

export const ALPHA_SOURCE = 'alphasource__list_records';
export const ALPHA_SINK_WRITE = 'alphasink__write_range';
export const ALPHA_SINK_READ = 'alphasink__read_range';

export interface AlphaRecord {
  id: string;
  day: string;
  label: string;
}

/** Nine records across three pages, so completeness is only reachable by
 *  following the cursor to exhaustion. */
const ALL_RECORDS: AlphaRecord[] = [
  { id: 'r1', day: 'D1', label: 'first' },
  { id: 'r2', day: 'D1', label: 'second' },
  { id: 'r3', day: 'D1', label: 'third' },
  { id: 'r4', day: 'D2', label: 'fourth' },
  { id: 'r5', day: 'D2', label: 'fifth' },
  { id: 'r6', day: 'D2', label: 'sixth' },
  { id: 'r7', day: 'D3', label: 'seventh' },
  { id: 'r8', day: 'D3', label: 'eighth' },
  { id: 'r9', day: 'D3', label: 'ninth' },
];

/** Records the caller must never see: outside the requested window. */
const OUT_OF_RANGE: AlphaRecord[] = [
  { id: 'x1', day: 'D0', label: 'before-window' },
  { id: 'x2', day: 'D9', label: 'after-window' },
];

export const ALPHA_TOTAL_RECORDS = ALL_RECORDS.length;
export const ALPHA_PAGE_SIZE = 4;

/**
 * Cursors are OPAQUE on purpose: base64 of an internal offset, with a checksum
 * the caller cannot reconstruct. Any attempt to parse, truncate or retype one
 * fails — which is what makes "the model must not copy or retype the cursor"
 * testable rather than aspirational.
 */
function encodeCursor(offset: number): string {
  return Buffer.from(`alpha:${offset}:${(offset * 7919) % 65521}`).toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const parts = Buffer.from(cursor, 'base64').toString('utf8').split(':');
    if (parts.length !== 3 || parts[0] !== 'alpha') return null;
    const offset = Number(parts[1]);
    if (!Number.isSafeInteger(offset) || offset < 0) return null;
    if (Number(parts[2]) !== (offset * 7919) % 65521) return null;
    return offset;
  } catch {
    return null;
  }
}

export interface AlphaSourceEnvelope {
  successful: boolean;
  data?: { records: AlphaRecord[]; total_available: number };
  /** Opaque continuation; absent on the final page. */
  next_cursor?: string;
  /** Envelope-level metadata that is NOT inside the record path — the field a
   *  record-only projection silently loses. */
  meta?: { page: number; complete: boolean };
  error?: { status_code: number; message: string };
}

export interface AlphaSourceOptions {
  cursor?: string;
  /** Force one transient failure before serving. */
  failTransientOnce?: boolean;
  /** Force an unsupported-capability answer. */
  unsupported?: boolean;
}

const transientFired = new Set<string>();

export function resetAlphaFixtures(): void {
  transientFired.clear();
  sinkStore.clear();
}

/** One page of the source. Out-of-range records are never returned. */
export function alphaSourceRead(
  options: AlphaSourceOptions = {},
  runKey = 'default',
): AlphaSourceEnvelope {
  if (options.unsupported) {
    return { successful: false, error: { status_code: 501, message: 'operation not supported' } };
  }
  if (options.failTransientOnce && !transientFired.has(runKey)) {
    transientFired.add(runKey);
    return { successful: false, error: { status_code: 503, message: 'temporarily unavailable' } };
  }

  let offset = 0;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(options.cursor);
    // A mangled cursor is a REPAIRABLE argument problem, not a dead capability.
    if (decoded === null) {
      return { successful: false, error: { status_code: 400, message: 'invalid cursor' } };
    }
    offset = decoded;
  }

  const page = ALL_RECORDS.slice(offset, offset + ALPHA_PAGE_SIZE);
  const nextOffset = offset + page.length;
  const complete = nextOffset >= ALL_RECORDS.length;
  void OUT_OF_RANGE; // present in the fixture, never served
  return {
    successful: true,
    data: { records: page, total_available: ALL_RECORDS.length },
    ...(complete ? {} : { next_cursor: encodeCursor(nextOffset) }),
    meta: { page: Math.floor(offset / ALPHA_PAGE_SIZE) + 1, complete },
  };
}

/** Every record, for tests asserting completeness. */
export function alphaAllRecords(): AlphaRecord[] {
  return ALL_RECORDS.map((record) => ({ ...record }));
}

// ── AlphaSink: an external artifact with a receipt and a real read-back ──────

const sinkStore = new Map<string, string[][]>();

export interface AlphaSinkReceipt {
  successful: boolean;
  data?: { updated_range: string; updated_rows: number };
  error?: { status_code: number; message: string };
}

/**
 * A write returns a RECEIPT. The receipt says how many rows the sink accepted
 * — it does not say what they contain, which is the whole point: an
 * acknowledgement is not verification.
 */
export function alphaSinkWrite(range: string, rows: string[][]): AlphaSinkReceipt {
  if (!range.trim()) {
    return { successful: false, error: { status_code: 400, message: 'range is required' } };
  }
  const existing = sinkStore.get(range) ?? [];
  // Writing fewer rows than are already present leaves the tail behind. Real
  // sinks behave this way and it is exactly how stale rows survived a rewrite.
  const merged = [...rows, ...existing.slice(rows.length)];
  sinkStore.set(range, merged);
  return { successful: true, data: { updated_range: range, updated_rows: rows.length } };
}

/** Read back exactly what the sink holds. */
export function alphaSinkRead(range: string): { successful: boolean; data?: { values: string[][] } } {
  return { successful: true, data: { values: (sinkStore.get(range) ?? []).map((row) => [...row]) } };
}

/** Seed the sink with prior content, to test stale-row inheritance. */
export function alphaSinkSeed(range: string, rows: string[][]): void {
  sinkStore.set(range, rows.map((row) => [...row]));
}

// ── Carrier encodings: one logical call, several wire shapes ─────────────────

/**
 * The four shapes this call actually arrived in across the two live traces.
 * A logical call must resolve to ONE identity regardless of which it is.
 */
export function alphaCarrierEncodings(
  toolSlug: string,
  args: Record<string, unknown>,
): unknown[] {
  return [
    // Direct object.
    { tool_slug: toolSlug, arguments: args },
    // Object carrier, stringified arguments (seen 17:35–17:37).
    { tool_slug: toolSlug, arguments: JSON.stringify(args) },
    // Whole envelope stringified, object arguments (seen 17:39+).
    JSON.stringify({ tool_slug: toolSlug, arguments: args }),
    // Whole envelope stringified, stringified arguments.
    JSON.stringify({ tool_slug: toolSlug, arguments: JSON.stringify(args) }),
  ];
}
