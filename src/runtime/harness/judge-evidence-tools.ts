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
}

export interface JudgeEvidenceSource {
  /** What a ref names, for the reviewer's instructions (e.g. "step ids"). */
  refKind: string;
  /** Every ref the reviewer may open. */
  refs(): readonly string[];
  resolve(ref: string): JudgeEvidenceEntry | undefined;
}

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
    `You have at most ${budget} lookups. Then reply in the required format.`,
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

function refHint(source: JudgeEvidenceSource): string {
  const refs = source.refs();
  return refs.length <= LISTED_REFS
    ? `Valid refs: ${refs.join(', ') || '(none)'}.`
    : `Valid refs: the ${refs.length} ${source.refKind}.`;
}

function segments(path: string): string[] {
  return path.replace(/^\//, '').split(/[./]|\[(\d+)\]/).filter((part) => part !== undefined && part !== '');
}

function at(value: unknown, path: string): unknown {
  let current = value;
  for (const part of segments(path)) {
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

function jsonValue(entry: JudgeEvidenceEntry): unknown {
  let value = entry.value !== undefined ? entry.value : entry.text;
  // A result that is a JSON document in a string is queried as that document.
  for (let depth = 0; depth < 2 && typeof value === 'string'; depth += 1) {
    try { value = JSON.parse(value); } catch { break; }
  }
  return value;
}

/** The largest list in a result, found by shape alone (never by key names),
 * searching objects to a bounded depth; the shallower list wins a tie. */
function largestList(value: unknown): { rows: unknown[]; path: string } | undefined {
  let best: { rows: unknown[]; path: string; depth: number } | undefined;
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > 5 || !node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
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
    const selected = at(value, path);
    if (Array.isArray(selected)) return { rows: selected, from: path };
    return `Nothing list-shaped at path ${JSON.stringify(path)}. The result is ${describeJsonShape(value)}`;
  }
  if (Array.isArray(value)) return { rows: value, from: '(root)' };
  const largest = largestList(value);
  if (largest) return { rows: largest.rows, from: largest.path };
  return `The result has no list of records. It is ${describeJsonShape(value)}`;
}

function project(record: unknown, fields: readonly string[] | undefined): unknown {
  if (!fields?.length || !record || typeof record !== 'object' || Array.isArray(record)) return record;
  return Object.fromEntries(fields.map((field) => [field, at(record, field)]));
}

function clip(text: string): string {
  return text.length <= MAX_CHARS_PER_LOOKUP
    ? text
    : `${text.slice(0, MAX_CHARS_PER_LOOKUP)}\n…[clipped at ${MAX_CHARS_PER_LOOKUP} of ${text.length} chars; narrow the query or page with offset]`;
}

/** Fresh tools with their own lookup budget; build one set per review attempt. */
export function judgeEvidenceTools(
  source: JudgeEvidenceSource,
  budget = JUDGE_EVIDENCE_LOOKUP_BUDGET,
): Tool[] {
  let used = 0;
  const lookup = (ref: string): JudgeEvidenceEntry | string => {
    if (used >= budget) {
      return `Lookup budget spent (${budget}). Rule from the evidence you have, and say what you could not check.`;
    }
    used += 1;
    const entry = source.resolve(ref.trim());
    return entry ?? `No retained result for ref ${JSON.stringify(ref)}. ${refHint(source)}`;
  };
  return [
    tool({
      name: 'open_evidence',
      description: `Read a retained result under review as text, from an offset. Returns the requested characters and the total length. ${refHint(source)}`,
      parameters: schema(openInput) as never,
      strict: false,
      execute: async (raw) => {
        const input = openInput.parse(raw);
        const entry = lookup(input.ref);
        if (typeof entry === 'string') return entry;
        const offset = Math.min(input.offset ?? 0, entry.text.length);
        const end = Math.min(entry.text.length, offset + (input.max_chars ?? MAX_CHARS_PER_LOOKUP));
        return `${input.ref}: characters ${offset}–${end} of ${entry.text.length}${end < entry.text.length ? ` (continue with offset ${end})` : ' (end)'}\n\n${entry.text.slice(offset, end)}`;
      },
    }),
    tool({
      name: 'query_evidence',
      description: `Query the records of a retained JSON result under review: choose the list (path, default its main list), keep records whose where_field equals or contains a value, return chosen fields, with the true match count. ${refHint(source)}`,
      parameters: schema(queryInput) as never,
      strict: false,
      execute: async (raw) => {
        const input = queryInput.parse(raw);
        const entry = lookup(input.ref);
        if (typeof entry === 'string') return entry;
        const records = recordsOf(jsonValue(entry), input.path);
        if (typeof records === 'string') return records;
        let rows = records.rows;
        if (input.where_field && (input.equals !== undefined || input.contains !== undefined)) {
          const needle = input.contains?.toLowerCase();
          rows = rows.filter((row) => {
            const found = at(row, input.where_field!);
            const text = found === null || found === undefined
              ? ''
              : typeof found === 'string' ? found : JSON.stringify(found);
            return input.equals !== undefined ? text === input.equals : text.toLowerCase().includes(needle!);
          });
        }
        const offset = input.offset ?? 0;
        const page = rows.slice(offset, offset + (input.limit ?? 50)).map((row) => project(row, input.fields));
        return clip(`${input.ref}: ${rows.length} of ${records.rows.length} records at ${records.from} match; showing ${page.length} from offset ${offset}.\n\n${JSON.stringify(page, null, 1)}`);
      },
    }),
  ];
}
