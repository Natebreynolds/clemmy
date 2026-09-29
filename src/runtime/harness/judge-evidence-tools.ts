/** Read-only evidence tools for a reviewer.
 *
 * A reviewer shown only what fits in its prompt can say a claim is unverified,
 * but it cannot check one: "every respond email has a draft" is unprovable from
 * a sample, and a result shown as a bounded view hides the records a claim may
 * rest on. These tools let the reviewer open the retained results itself. They
 * resolve only the refs the caller scoped to the work under review, execute
 * nothing, and stop after a small number of lookups so a review stays short. */
import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { describeJsonShape } from './tool-output-digest.js';

export interface JudgeEvidenceEntry {
  /** The complete retained content as text. */
  text: string;
  /** Its parsed JSON value, when it has one. */
  value?: unknown;
  /** Authenticated retained record path, when the carrier supplied one. */
  recordPath?: string;
}

export interface JudgeEvidenceSource {
  /** What a ref names, for the reviewer's instructions (e.g. "step ids"). */
  refKind: string;
  /** Every ref the reviewer may open. */
  refs(): readonly string[];
  resolve(ref: string): JudgeEvidenceEntry | undefined;
}

/** What one reviewer lookup actually returned, recorded by the host. A verdict
 * that rests on a bounded result is only as strong as the part of it the
 * reviewer opened; without this record that part cannot be known afterwards. */
export interface JudgeEvidenceLookup {
  tool: 'open_evidence' | 'query_evidence';
  ref: string;
  /** Why nothing was returned, when nothing was. */
  refused?: 'budget' | 'unknown_ref' | 'no_records';
  /** open_evidence: the character range returned, and the result's length. */
  charStart?: number;
  charEnd?: number;
  charTotal?: number;
  /** query_evidence: the list queried and how much of it was returned. */
  recordPath?: string;
  recordsTotal?: number;
  recordsMatched?: number;
  recordsReturned?: number;
  offset?: number;
  /** The query kept only records matching a criterion. Its match count is
   * true of every record; the records outside it were not returned. */
  filter?: { field: string; mode: 'equals' | 'contains' };
  fields?: string[];
}

export type JudgeEvidenceLookupObserver = (lookup: JudgeEvidenceLookup) => void;

export const JUDGE_EVIDENCE_LOOKUP_BUDGET = 4;
const MAX_CHARS_PER_LOOKUP = 12_000;
const MAX_RECORDS_PER_QUERY = 100;
const LISTED_REFS = 40;

/** Appended to a reviewer's instructions only when it has the tools. */
export function judgeEvidenceGuidance(source: JudgeEvidenceSource, budget = JUDGE_EVIDENCE_LOOKUP_BUDGET): string {
  return [
    '',
    `EVIDENCE TOOLS: open_evidence reads a retained result as text and query_evidence filters the records of a retained JSON result and returns their true count. A ref is one of the ${source.refKind}.`,
    'Use them when your verdict depends on content you were not shown: the rest of a bounded view, every record of a list, a field a claim rests on. Do not re-open content already shown in full, and do not look up what your verdict does not depend on.',
    'A result shown in part supports a statement that something is absent from it, is true of all of it, or that so many of its records match something only after you queried every record for it or opened the rest. How many records it holds, or that the call succeeded, is not that check.',
    `You have at most ${budget} lookups. Then reply in the required format.`,
    'After a DONE verdict line add one more line naming, by ref, each result your verdict needs the whole of, because something must be absent from it or true of every record in it: "NEEDS ALL OF: <ref>, <ref>". When the verdict rests only on what you were shown, including a result\'s stated record count, write "NEEDS ALL OF: none".',
  ].join('\n');
}

const openInput = z.object({
  ref: z.string().min(1).describe('Which retained result to read.'),
  offset: z.number().int().min(0).optional().describe('Character offset to start from (default 0).'),
  max_chars: z.number().int().min(200).max(MAX_CHARS_PER_LOOKUP).optional()
    .describe(`How many characters to return (default and maximum ${MAX_CHARS_PER_LOOKUP}).`),
});

const queryInput = z.object({
  ref: z.string().min(1).describe('Which retained JSON result to query.'),
  path: z.string().optional().describe('Dotted path to the list to query, e.g. "data.items" or "emails". Default: the result\'s main list.'),
  where_field: z.string().optional().describe('Keep only records whose field (dotted path allowed) matches equals or contains.'),
  equals: z.string().optional().describe('Exact value for where_field.'),
  contains: z.string().optional().describe('Case-insensitive substring for where_field.'),
  fields: z.array(z.string()).optional().describe('Fields to return from each record (dotted paths allowed). Default: whole records.'),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_RECORDS_PER_QUERY).optional()
    .describe(`Records to return (default 50, maximum ${MAX_RECORDS_PER_QUERY}).`),
});

function schema(input: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(input, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
}

export function judgeEvidenceReferences(source: JudgeEvidenceSource): string {
  const refs = source.refs();
  return refs.length <= LISTED_REFS
    ? `Valid refs: ${refs.join(', ') || '(none)'}.`
    : `Valid refs: the ${refs.length} ${source.refKind}.`;
}

function segments(path: string): string[] {
  return path.replace(/^\//, '').split(/[./]|\[(\d+)\]/).filter((part) => part !== undefined && part !== '');
}

/** Traverse JSON documents embedded in carrier text without rewriting their
 * retained representation or interpreting ordinary prose as data. */
function jsonContainer(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return value;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : value;
  } catch { return value; }
}

function at(value: unknown, path: string): unknown {
  let current = value;
  for (const part of segments(path)) {
    current = jsonContainer(current);
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export function judgeEvidenceJsonValue(entry: JudgeEvidenceEntry): unknown {
  let value = entry.value !== undefined ? entry.value : entry.text;
  // A result that is a JSON document in a string is queried as that document.
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); continue; } catch { break; }
    }
    // Query the document inside a single-text MCP response. Mixed content and
    // error envelopes stay intact; open_evidence always retains original text.
    const envelope = value as { content?: Array<{ type?: string; text?: unknown }>; isError?: boolean } | null;
    if (envelope && !Array.isArray(envelope) && envelope.isError !== true
      && Array.isArray(envelope.content) && envelope.content.length === 1
      && envelope.content[0]?.type === 'text' && typeof envelope.content[0].text === 'string') {
      try { value = JSON.parse(envelope.content[0].text); continue; } catch { break; }
    }
    break;
  }
  return value;
}

/** The largest list in a result, found by shape alone (never by key names),
 * searching objects to a bounded depth; the shallower list wins a tie. */
function largestList(value: unknown): { rows: unknown[]; path: string } | undefined {
  let best: { rows: unknown[]; path: string; depth: number } | undefined;
  const visit = (node: unknown, path: string, depth: number): void => {
    node = jsonContainer(node);
    if (depth > 5 || !node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, rawChild] of Object.entries(node as Record<string, unknown>)) {
      const child = jsonContainer(rawChild);
      const childPath = path ? `${path}.${key}` : key;
      if (Array.isArray(child)) {
        if (!best || child.length > best.rows.length || (child.length === best.rows.length && depth < best.depth)) {
          best = { rows: child, path: childPath, depth };
        }
      } else {
        visit(child, childPath, depth + 1);
      }
    }
  };
  visit(value, '', 0);
  return best && best.rows.length > 0 ? { rows: best.rows, path: best.path } : undefined;
}

function recordsOf(value: unknown, path: string | undefined): { rows: unknown[]; from: string } | string {
  if (path) {
    const selected = jsonContainer(at(value, path));
    if (Array.isArray(selected)) return { rows: selected, from: path };
    return `Nothing list-shaped at path ${JSON.stringify(path)}. The result is ${describeJsonShape(value)}`;
  }
  if (Array.isArray(value)) return { rows: value, from: '(root)' };
  const largest = largestList(value);
  if (largest) return { rows: largest.rows, from: largest.path };
  return `The result has no list of records. It is ${describeJsonShape(value)}`;
}

function project(record: unknown, fields: readonly string[] | undefined): unknown {
  if (!fields?.length || !record || typeof record !== 'object') return record;
  return Object.fromEntries(fields.map((field) => [field, at(record, field)]));
}

/** Whole records that fit one lookup. A page cut mid-record would report more
 * records than the reviewer could read; the first record is always returned,
 * clipped if it alone is over the limit, so a lookup never returns nothing. */
function wholeRecordsWithin<T>(page: readonly T[], maxChars: number): { shown: T[]; firstClipped: boolean } {
  const shown: T[] = [];
  let used = 2;
  for (const entry of page) {
    const cost = JSON.stringify(entry, null, 1).length + 2;
    if (shown.length > 0 && used + cost > maxChars) break;
    shown.push(entry);
    used += cost;
    if (used > maxChars) return { shown, firstClipped: true };
  }
  return { shown, firstClipped: false };
}

/** Fresh tools with their own lookup budget; build one set per review attempt. */
export function judgeEvidenceTools(
  source: JudgeEvidenceSource,
  budget = JUDGE_EVIDENCE_LOOKUP_BUDGET,
  onLookup?: JudgeEvidenceLookupObserver,
): Tool[] {
  let used = 0;
  const record = (lookup: JudgeEvidenceLookup): void => {
    // Recording is observation: it never changes what the reviewer receives.
    try { onLookup?.(lookup); } catch { /* the lookup result stands */ }
  };
  const lookup = (tool: JudgeEvidenceLookup['tool'], ref: string): JudgeEvidenceEntry | string => {
    if (used >= budget) {
      record({ tool, ref: ref.trim(), refused: 'budget' });
      return `Lookup budget spent (${budget}). Rule from the evidence you have, and say what you could not check.`;
    }
    used += 1;
    const entry = source.resolve(ref.trim());
    if (!entry) record({ tool, ref: ref.trim(), refused: 'unknown_ref' });
    return entry ?? `No retained result for ref ${JSON.stringify(ref)}. ${judgeEvidenceReferences(source)}`;
  };
  return [
    tool({
      name: 'open_evidence',
      description: 'Read a retained result under review as text, from an offset. Returns the requested characters and the total length. Use a ref listed in the review evidence references.',
      parameters: schema(openInput) as never,
      strict: false,
      execute: async (raw) => {
        const input = openInput.parse(raw);
        const entry = lookup('open_evidence', input.ref);
        if (typeof entry === 'string') return entry;
        const offset = Math.min(input.offset ?? 0, entry.text.length);
        const end = Math.min(entry.text.length, offset + (input.max_chars ?? MAX_CHARS_PER_LOOKUP));
        record({ tool: 'open_evidence', ref: input.ref.trim(), charStart: offset, charEnd: end, charTotal: entry.text.length });
        return `${input.ref}: characters ${offset}–${end} of ${entry.text.length}${end < entry.text.length ? ` (continue with offset ${end})` : ' (end)'}\n\n${entry.text.slice(offset, end)}`;
      },
    }),
    tool({
      name: 'query_evidence',
      description: 'Query the records of a retained JSON result under review: choose the list (path, default its main list), keep records whose where_field equals or contains a value, return chosen fields, with the true match count and original zero-based sourceIndex for each match. Numeric fields select tuple columns. Use a ref listed in the review evidence references.',
      parameters: schema(queryInput) as never,
      strict: false,
      execute: async (raw) => {
        const input = queryInput.parse(raw);
        const ref = input.ref.trim();
        const entry = lookup('query_evidence', input.ref);
        if (typeof entry === 'string') return entry;
        const records = recordsOf(judgeEvidenceJsonValue(entry), input.path ?? entry.recordPath);
        if (typeof records === 'string') {
          record({ tool: 'query_evidence', ref, refused: 'no_records' });
          return records;
        }
        let rows = records.rows.map((record, sourceIndex) => ({ record, sourceIndex }));
        const filtered = Boolean(input.where_field && (input.equals !== undefined || input.contains !== undefined));
        if (input.where_field && (input.equals !== undefined || input.contains !== undefined)) {
          const needle = input.contains?.toLowerCase();
          rows = rows.filter((row) => {
            const found = at(row.record, input.where_field!);
            const text = found === null || found === undefined
              ? ''
              : typeof found === 'string' ? found : JSON.stringify(found);
            return input.equals !== undefined ? text === input.equals : text.toLowerCase().includes(needle!);
          });
        }
        const offset = input.offset ?? 0;
        const page = rows.slice(offset, offset + (input.limit ?? 50)).map(({ record, sourceIndex }) => ({ sourceIndex, record: project(record, input.fields) }));
        const header = (shown: number): string => `${input.ref}: ${rows.length} of ${records.rows.length} records at ${records.from} match; showing ${shown} from offset ${offset}`;
        // The count reported is the count returned: a page is cut between
        // records, never inside one, and says where the next one starts.
        const fit = wholeRecordsWithin(page, MAX_CHARS_PER_LOOKUP - 240);
        const next = offset + fit.shown.length;
        const body = JSON.stringify(fit.shown, null, 1);
        const complete = !fit.firstClipped;
        record({ tool: 'query_evidence', ref, recordPath: records.from, recordsTotal: records.rows.length,
          recordsMatched: rows.length, recordsReturned: complete ? fit.shown.length : 0, offset,
          ...(filtered ? { filter: { field: input.where_field!, mode: input.equals !== undefined ? 'equals' as const : 'contains' as const } } : {}),
          ...(input.fields?.length ? { fields: [...input.fields] } : {}) });
        if (!complete) {
          return `${header(1)}, clipped inside the record at ${MAX_CHARS_PER_LOOKUP} characters (it is not whole; choose fields to read it).\n\n${body.slice(0, MAX_CHARS_PER_LOOKUP)}`;
        }
        return `${header(fit.shown.length)}${next < rows.length ? ` (continue with offset ${next})` : ' (end)'}.\n\n${body}`;
      },
    }),
  ];
}
