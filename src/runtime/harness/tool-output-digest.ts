/**
 * Structure-aware digest for large tool outputs — the single, always-on path
 * for parked tool output (the legacy clip-and-recall fallback + its
 * LARGE_TOOL_OUTPUT_DIGEST toggle were removed 2026-06-24).
 *
 * The problem: tool outputs are unbounded (query results, API lists, web
 * scrapes), the context window is finite. The old clip was `text.slice(0,
 * maxChars)` — a raw mid-content cut that severs a JSON array mid-record,
 * so the agent silently loses structured data and re-queries.
 *
 * This produces a faithful, boundary-respecting digest instead: for a JSON
 * array, as many COMPLETE records as fit + the true total + the field
 * list; for an object, the top-level shape; for text, head+tail + line
 * count. Always paired with the recovery path — `tool_output_query` (pull
 * any exact slice) or `recall_tool_result` (raw payload) — since the full
 * output is already parked in `tool_outputs`.
 *
 * Pure: callId is passed in, no I/O.
 */

import { toolCallHint } from './tool-call-hint.js';

export interface DigestOptions {
  maxChars?: number;
  toolName?: string | null;
  callId?: string | null;
}

function tryParse(text: string): unknown {
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

// Well-known keys that hold the "rows" of a list/records result, across
// composio/Airtable/Sheets/Gmail/etc. Used to report the TRUE item count.
const DOMINANT_LIST_KEYS = [
  'records', 'items', 'results', 'rows', 'data', 'value', 'entries',
  'messages', 'files', 'matches', 'documents',
  // Search providers commonly split one response into sibling result sets.
  // These must participate in the same bounded-query path: a large `web`
  // record must not hide a later, more useful `news` array.
  'news', 'web', 'images',
];

interface DominantArrayLocation {
  key: string;
  rows: unknown[];
  path: string;
}

function dominantArrayLocation(value: unknown): DominantArrayLocation | null {
  if (Array.isArray(value)) return { key: 'items', rows: value, path: '' };
  if (!value || typeof value !== 'object') return null;

  let best: DominantArrayLocation | null = null;
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > 5 || !node || typeof node !== 'object' || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    for (const key of DOMINANT_LIST_KEYS) {
      const candidate = record[key];
      if (Array.isArray(candidate) && (!best || candidate.length > best.rows.length)) {
        best = { key, rows: candidate, path: path ? `${path}.${key}` : key };
      }
    }
    // Provider envelopes are commonly nested as data -> data. Walk bounded
    // object carriers, but never descend into record arrays or arbitrary depth.
    for (const [key, child] of Object.entries(record)) {
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        visit(child, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };
  visit(value, '', 0);
  return best;
}

/** Find the dominant list inside a parsed tool result — a records/items/results
 *  array, possibly nested one level under `data` (the composio/Airtable shape
 *  `{ data: { records: [...] } }`). Returns the key + count so a clip/digest can
 *  tell the model the TRUE item count ("59 records") and that recall returns ALL
 *  of them — instead of a char count that reads like "there may be more pages"
 *  and invites hallucinated pagination. */
export function countDominantArray(value: unknown): { key: string; count: number } | null {
  const located = dominantArrayLocation(value);
  return located ? { key: located.key, count: located.rows.length } : null;
}

/** Parse text then count the dominant list — for callers that only hold the raw
 *  string (e.g. the plain clip footer). Returns null when not a list payload. */
export function dominantListCount(text: string): { key: string; count: number } | null {
  return countDominantArray(tryParse(text));
}

/** Locate the ACTUAL dominant list array (not just its count): the value at
 *  `key`, or nested one level under `data` — the composio/Graph/Airtable wrap
 *  `{ data: { value: [...] } }`. Returns the rows plus the dotted path so a
 *  query engine can operate on the records directly and NAME where they live. */
export function resolveDominantArray(value: unknown): { rows: unknown[]; path: string } | null {
  const located = dominantArrayLocation(value);
  return located && located.rows.length > 0
    ? { rows: located.rows, path: located.path }
    : null;
}

const STRUCTURED_PROJECTION_META_KEY = '__clementine';
const MAX_STRUCTURED_PROJECTION_KEYS = 64;
const MAX_STRUCTURED_PROJECTION_ITEMS = 64;
const MIN_JSON_VALUE_CHARS = 4; // `null`

interface StructuredProjectionStats {
  clippedStrings: number;
  omittedArrayItems: number;
  omittedObjectKeys: number;
}

export interface StructuredJsonToolOutputOptions extends DigestOptions {
  /** Exact host-minted receipt string. It is embedded inside the JSON rather
   * than appended as prose so the projection remains parseable. */
  exactOutputReceipt: string;
  resourceIndex?: string;
}

function jsonChars(value: unknown): number {
  return JSON.stringify(value).length;
}

function projectionKeyPriority(key: string): number {
  const priority = [
    'data', 'successful', 'success', 'error',
    'news', 'records', 'items', 'results', 'rows', 'value', 'entries',
    'url', 'title', 'date', 'publishedAt', 'publishedDate', 'publisher',
    'snippet', 'description', 'content', 'markdown',
    'web', 'images', 'logId',
  ];
  const index = priority.indexOf(key);
  return index < 0 ? priority.length : index;
}

function allocateJsonBudgets(sizes: number[], available: number): number[] {
  const budgets = new Array<number>(sizes.length).fill(0);
  let remaining = available;
  let active = sizes.map((_, index) => index);
  while (active.length > 0) {
    const share = Math.floor(remaining / active.length);
    const satisfied = active.filter((index) => sizes[index]! <= share);
    if (satisfied.length === 0) {
      for (let position = 0; position < active.length; position += 1) {
        const index = active[position]!;
        const extra = position < (remaining % active.length) ? 1 : 0;
        budgets[index] = share + extra;
      }
      break;
    }
    const satisfiedSet = new Set(satisfied);
    for (const index of satisfied) {
      budgets[index] = sizes[index]!;
      remaining -= sizes[index]!;
    }
    active = active.filter((index) => !satisfiedSet.has(index));
  }
  return budgets;
}

function compactJsonString(value: string, budget: number, stats: StructuredProjectionStats): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= budget) return value;
  if (budget < MIN_JSON_VALUE_CHARS) return null;

  const marker = `…[${value.length} chars total]`;
  let low = 0;
  let high = value.length;
  let best: string | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${value.slice(0, middle)}${marker}`;
    if (JSON.stringify(candidate).length <= budget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  stats.clippedStrings += 1;
  return best ?? null;
}

function compactJsonValue(
  value: unknown,
  budget: number,
  stats: StructuredProjectionStats,
  depth = 0,
): unknown {
  if (budget < MIN_JSON_VALUE_CHARS || depth > 12) return null;
  const fullSize = jsonChars(value);
  if (fullSize <= budget) return value;
  if (typeof value === 'string') return compactJsonString(value, budget, stats);
  if (value === null || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    const maximum = Math.min(value.length, MAX_STRUCTURED_PROJECTION_ITEMS);
    let shown = maximum;
    while (shown > 0) {
      const overhead = 2 + Math.max(0, shown - 1);
      if (overhead + (shown * MIN_JSON_VALUE_CHARS) <= budget) break;
      shown -= 1;
    }
    stats.omittedArrayItems += value.length - shown;
    if (shown === 0) return [];
    const overhead = 2 + Math.max(0, shown - 1);
    const sizes = value.slice(0, shown).map(jsonChars);
    const budgets = allocateJsonBudgets(sizes, budget - overhead);
    return value.slice(0, shown).map((entry, index) => (
      compactJsonValue(entry, budgets[index]!, stats, depth + 1)
    ));
  }

  const record = value as Record<string, unknown>;
  const originalKeys = Object.keys(record);
  let keys = originalKeys
    .map((key, index) => ({ key, index, priority: projectionKeyPriority(key) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .slice(0, MAX_STRUCTURED_PROJECTION_KEYS)
    .map(({ key }) => key);
  while (keys.length > 0) {
    const overhead = 2
      + Math.max(0, keys.length - 1)
      + keys.reduce((sum, key) => sum + JSON.stringify(key).length + 1, 0);
    if (overhead + (keys.length * MIN_JSON_VALUE_CHARS) <= budget) break;
    keys = keys.slice(0, -1);
  }
  stats.omittedObjectKeys += originalKeys.length - keys.length;
  if (keys.length === 0) return {};
  const overhead = 2
    + Math.max(0, keys.length - 1)
    + keys.reduce((sum, key) => sum + JSON.stringify(key).length + 1, 0);
  const sizes = keys.map((key) => jsonChars(record[key]));
  const budgets = allocateJsonBudgets(sizes, budget - overhead);
  const compact: Record<string, unknown> = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    compact[key] = compactJsonValue(record[key], budgets[index]!, stats, depth + 1);
  }
  return compact;
}

/**
 * Build a bounded, parseable JSON projection for an oversized JSON object.
 * Sibling objects/arrays receive fair budgets, so one early huge scrape cannot
 * starve later result sets. The exact-output receipt lives inside a reserved
 * host metadata property: downstream typed JSON proof can still parse the
 * provider envelope while exact raw redemption continues to use the receipt.
 */
export function compactStructuredJsonToolOutput(
  text: string,
  options: StructuredJsonToolOutputOptions,
): string | null {
  const parsed = tryParse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (Object.hasOwn(parsed, STRUCTURED_PROJECTION_META_KEY)) return null;

  const maxChars = options.maxChars ?? 4000;
  const callId = options.callId ?? null;
  const fullMetadata = {
    kind: 'structured_projection_v1',
    truncated: true,
    rawChars: text.length,
    recovery: callId ? {
      tool_output_query: { call_id: callId, limit: 50 },
      recall_tool_result: { call_id: callId },
    } : undefined,
    resourceIndex: options.resourceIndex || undefined,
    receipt: options.exactOutputReceipt,
  };
  const metadataCandidates: Array<Record<string, unknown>> = [
    fullMetadata,
    { kind: 'structured_projection_v1', receipt: options.exactOutputReceipt },
    { receipt: options.exactOutputReceipt },
  ];

  for (const metadataBase of metadataCandidates) {
    let payloadBudget = maxChars
      - JSON.stringify(STRUCTURED_PROJECTION_META_KEY).length
      - JSON.stringify(metadataBase).length
      - 4; // root braces, colon, and comma
    if (payloadBudget < 2) continue;
    for (let attempt = 0; attempt < 12 && payloadBudget >= 2; attempt += 1) {
      const stats: StructuredProjectionStats = {
        clippedStrings: 0,
        omittedArrayItems: 0,
        omittedObjectKeys: 0,
      };
      const projected = compactJsonValue(parsed, payloadBudget, stats);
      if (!projected || typeof projected !== 'object' || Array.isArray(projected)) break;
      const metadata = metadataBase === fullMetadata
        ? { ...metadataBase, projection: stats }
        : metadataBase;
      const output = JSON.stringify({
        ...(projected as Record<string, unknown>),
        [STRUCTURED_PROJECTION_META_KEY]: metadata,
      });
      if (output.length <= maxChars) return output;
      payloadBudget -= output.length - maxChars + 8;
    }
  }
  return null;
}

/**
 * One-line-per-key shape outline of a JSON value — the MAP a model needs to
 * write a query that lands on the first try (2026-07-31 calendar-run audit: a
 * no-match projection answered "{}" with no shape, so the model gave up on
 * querying and recalled the full 26KB payload). Pure, bounded, no content.
 */
export function describeJsonShape(value: unknown, maxLines = 12): string {
  if (Array.isArray(value)) {
    const fields = collectFields(value);
    return `array of ${value.length} record(s)${fields.length ? ` — record fields: ${fields.slice(0, 24).join(', ')}${fields.length > 24 ? ', …' : ''}` : ''}`;
  }
  if (!value || typeof value !== 'object') return typeof value;
  const obj = value as Record<string, unknown>;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (lines.length >= maxLines) { lines.push(`… (+${Object.keys(obj).length - maxLines} more keys)`); break; }
    if (Array.isArray(v)) {
      const fields = collectFields(v);
      lines.push(`${k}: array(${v.length})${fields.length ? ` of {${fields.slice(0, 10).join(', ')}${fields.length > 10 ? ', …' : ''}}` : ''}`);
    } else if (v && typeof v === 'object') {
      const inner = Object.keys(v as object);
      lines.push(`${k}: object {${inner.slice(0, 10).join(', ')}${inner.length > 10 ? ', …' : ''}}`);
    } else {
      lines.push(`${k}: ${v === null ? 'null' : typeof v}`);
    }
  }
  const dom = resolveDominantArray(value);
  if (dom && dom.path) {
    const fields = collectFields(dom.rows);
    lines.push(`→ the records live at ${dom.path}[*]${fields.length ? ` (fields: ${fields.slice(0, 12).join(', ')}${fields.length > 12 ? ', …' : ''})` : ''}`);
  }
  return lines.join('\n');
}

/** Union of keys across the first N objects in an array (the "schema"). */
function collectFields(arr: unknown[], sample = 12): string[] {
  const keys = new Set<string>();
  for (let i = 0; i < Math.min(arr.length, sample); i++) {
    const el = arr[i];
    if (el && typeof el === 'object' && !Array.isArray(el)) {
      for (const k of Object.keys(el as Record<string, unknown>)) keys.add(k);
    }
  }
  return [...keys];
}

function recoveryHint(callId: string | null | undefined, sampleFields?: string[]): string {
  if (!callId) return 'Re-run the call with a narrower scope (filter / fewer fields / a smaller range) to get the rest.';
  // The full result is parked losslessly under this call_id — these two
  // readers are available to you RIGHT NOW. Spell that out so the model
  // pulls the data instead of declaring it unavailable / still pending /
  // "the reader isn't exposed" (observed live, 2026-06-01). The examples are
  // literal valid-JSON inputs (toolCallHint) — the model copies hint syntax
  // verbatim, so a pseudo-signature here becomes an unparseable tool call
  // (observed live, 2026-08-05).
  const queryArgs: Record<string, unknown> = { call_id: callId };
  if (sampleFields && sampleFields.length > 0) queryArgs.fields = sampleFields.slice(0, 3);
  queryArgs.limit = 50;
  return (
    `The full result is stored — pull records with ${toolCallHint('tool_output_query', queryArgs)} ` +
    `(offset / filter_field / filter_contains also accepted), or the raw payload with ` +
    `${toolCallHint('recall_tool_result', { call_id: callId })}. ` +
    `These readers are available now; do NOT say the data is unavailable or that the call is still pending.`
  );
}

function digestArray(arr: unknown[], totalChars: number, maxChars: number, toolName: string, callId: string | null | undefined): string {
  const total = arr.length;
  const fields = collectFields(arr);
  const footerReserve = 360;
  const budget = Math.max(200, maxChars - footerReserve);
  const shown: unknown[] = [];
  let used = 2; // for the enclosing []
  for (const el of arr) {
    const s = JSON.stringify(el);
    // Never admit an oversized first record raw. Showing zero complete rows is
    // truthful; ballooning a 300KB first row through a 20KB budget is not.
    if (used + s.length + 1 > budget) break;
    shown.push(el);
    used += s.length + 1;
  }
  const more = total - shown.length;
  const body = JSON.stringify(shown, null, 1);
  // Field list rendered as a JSON array — the model lifts this list verbatim
  // into `fields:`, so it must already be the exact syntax the tool accepts
  // (a bare comma list here became `"fields": subject,start,…` live 2026-08-05).
  const fieldList = fields.length ? ` Fields: ${JSON.stringify(fields.slice(0, 24))}${fields.length > 24 ? ' (+more)' : ''}.` : '';
  const footer =
    `\n[digest: ${toolName} returned a JSON array of ${total} record${total === 1 ? '' : 's'} (~${totalChars.toLocaleString()} chars). ` +
    `Showing the first ${shown.length} COMPLETE record${shown.length === 1 ? '' : 's'}${more > 0 ? `; ${more} more not shown` : ''}.${fieldList} ` +
    `${recoveryHint(callId, fields)}]`;
  return body + footer;
}

/**
 * Render a value showing real CONTENT (not just shape), bounded by `budget`.
 * Arrays show their first complete elements + "(+N more)"; nested objects
 * recurse one or two levels then collapse. This is what lets a wrapped result
 * — e.g. Composio's `{ data: { tables: [...] } }` — surface the actual tables
 * (ids, names, fields) instead of the useless `data: object(1 keys)` the old
 * shape-only digest produced for EVERY Composio/MCP return.
 */
function renderValue(v: unknown, budget: number, depth: number): string {
  if (v === null) return 'null';
  if (typeof v !== 'object') {
    const s = JSON.stringify(v);
    if (typeof v === 'string' && s.length > 200) return `${JSON.stringify(v.slice(0, 160))}… (${s.length} chars)`;
    return s;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const shown: unknown[] = [];
    let used = 2;
    for (const el of v) {
      const s = JSON.stringify(el);
      if (used + s.length + 2 > budget) break;
      shown.push(el);
      used += s.length + 2;
      if (shown.length >= 25) break;
    }
    const more = v.length - shown.length;
    return `${JSON.stringify(shown)}${more > 0 ? ` …(+${more} more of ${v.length})` : ''}`;
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (depth >= 3) {
    // Don't collapse a CONTENT-bearing object to a useless shape — surface a
    // BOUNDED clip of its first text leaf (content/text/body/…) so the payload the
    // user actually needs (e.g. an email body at data.response_data.body.content,
    // depth 4) reaches context instead of forcing a shell-dig of the on-disk
    // result. Compaction-safe: the clip is length-capped AND rides the caller's
    // `budget`, and the parent digest still caps the TOTAL — so a huge read never
    // balloons, it just shows useful text within the same size (2026-07-09).
    for (const ck of ['content', 'text', 'body', 'message', 'snippet', 'value', 'plainText', 'bodyPreview']) {
      const leaf = obj[ck];
      if (typeof leaf === 'string' && leaf.trim()) {
        const cap = Math.max(80, Math.min(240, budget));
        const clip = leaf.length > cap ? `${leaf.slice(0, cap)}… (${leaf.length} chars)` : leaf;
        const moreKeys = keys.length - 1;
        return `{ ${JSON.stringify(ck)}: ${JSON.stringify(clip)}${moreKeys > 0 ? `, …(+${moreKeys} more)` : ''} }`;
      }
    }
    return `object(${keys.length} keys)`;
  }
  const parts: string[] = [];
  let used = 2;
  let shown = 0;
  for (const [k, val] of Object.entries(obj)) {
    const rv = renderValue(val, Math.max(120, budget - used), depth + 1);
    const seg = `${JSON.stringify(k)}: ${rv}`;
    if (used + seg.length + 2 > budget && shown > 0) break;
    parts.push(seg);
    used += seg.length + 2;
    shown++;
  }
  const moreKeys = keys.length - shown;
  return `{ ${parts.join(', ')}${moreKeys > 0 ? `, …(+${moreKeys} more key${moreKeys === 1 ? '' : 's'})` : ''} }`;
}

function digestObject(obj: Record<string, unknown>, totalChars: number, maxChars: number, toolName: string, callId: string | null | undefined): string {
  const entries = Object.entries(obj);
  const lines: string[] = [];
  const footerReserve = 320;
  const budget = Math.max(200, maxChars - footerReserve);
  let used = 0;
  let shownKeys = 0;
  for (const [k, v] of entries) {
    // Show CONTENT, not just shape — recurse into the value within the
    // remaining budget so the model sees the actual payload (tables, records,
    // fields), not `array(N)` / `object(K keys)`.
    const desc = renderValue(v, Math.max(160, budget - used), 1);
    const line = `  ${k}: ${desc}`;
    if (used + line.length + 1 > budget && shownKeys > 0) break;
    lines.push(line);
    used += line.length + 1;
    shownKeys++;
  }
  const moreKeys = entries.length - shownKeys;
  // Surface the TRUE count of a nested records/items array so the model knows
  // the full set size + that recall returns ALL of it — never reads the clip as
  // "maybe more pages" and guesses an offset (the acme 44→4 / 'itr2' bug).
  const resolved = resolveDominantArray(obj);
  const domFields = resolved ? collectFields(resolved.rows) : [];
  // Name WHERE the records live and their fields, and say the query engine
  // operates on them directly — so the first tool_output_query is written
  // against known shape instead of a guessed top-level projection (the
  // 2026-07-31 calendar run paid 3 extra calls + a 26KB replay for that guess).
  // Field list as a JSON array — the model lifts it verbatim into `fields:`,
  // so it must already be the exact accepted syntax (same fix as digestArray;
  // a bare comma list here became `"fields": subject,start,…` live 2026-08-05).
  const domNote = resolved
    ? ` Contains ${resolved.rows.length} record(s) at ${resolved.path ? `${resolved.path}[*]` : '[*]'}` +
      `${domFields.length ? ` with fields: ${JSON.stringify(domFields.slice(0, 16))}${domFields.length > 16 ? ' (+more)' : ''}` : ''}` +
      ` — tool_output_query filters/projects/paginates THESE records directly; recall_tool_result returns ALL ${resolved.rows.length} (no pagination needed).`
    : '';
  const footer =
    `\n[digest: ${toolName} returned a JSON object with ${entries.length} top-level key${entries.length === 1 ? '' : 's'} (~${totalChars.toLocaleString()} chars)${moreKeys > 0 ? `; ${moreKeys} key(s) not shown` : ''}.${domNote} ` +
    `${recoveryHint(callId, domFields)}]`;
  return `{\n${lines.join('\n')}\n}${footer}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function truncate(value: string | undefined, max = 240): string | undefined {
  if (!value) return undefined;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function schemaSummary(inputParameters: unknown): Record<string, unknown> | undefined {
  if (!isRecord(inputParameters)) return undefined;
  const properties = isRecord(inputParameters.properties) ? inputParameters.properties : undefined;
  const required = asStringArray(inputParameters.required);
  const fields: string[] = [];

  if (properties) {
    for (const [name, value] of Object.entries(properties)) {
      const field = isRecord(value) ? value : {};
      const type = typeof field.type === 'string' ? field.type : 'unknown';
      const description = typeof field.description === 'string' ? ` — ${truncate(field.description, 80)}` : '';
      fields.push(`${name}:${type}${description}`);
      if (fields.length >= 24) break;
    }
  }

  const out: Record<string, unknown> = {};
  if (required.length) out.required = required.slice(0, 24);
  if (fields.length) out.fields = fields;
  return Object.keys(out).length ? out : undefined;
}

function compactComposioCatalogItem(item: unknown): Record<string, unknown> | null {
  if (!isRecord(item)) return null;
  const slug = typeof item.slug === 'string' ? item.slug : undefined;
  if (!slug) return null;

  const compact: Record<string, unknown> = { slug };
  if (typeof item.toolkit === 'string') compact.toolkit = item.toolkit;
  if (typeof item.name === 'string') compact.name = item.name;
  if (typeof item.description === 'string') compact.description = truncate(item.description);
  if (typeof item.score === 'number') compact.score = item.score;
  const inputSummary = schemaSummary(item.inputParameters);
  if (inputSummary) compact.inputParameters = inputSummary;
  return compact;
}

function fitStringList(values: string[], maxChars: number): { shown: string[]; omitted: number } {
  const shown: string[] = [];
  let used = 2; // []
  for (const value of values) {
    const serialized = JSON.stringify(value);
    if (used + serialized.length + 1 > maxChars) break;
    shown.push(value);
    used += serialized.length + 1;
  }
  return { shown, omitted: values.length - shown.length };
}

function digestComposioCatalog(
  obj: Record<string, unknown>,
  totalChars: number,
  maxChars: number,
  toolName: string,
  callId: string | null | undefined,
): string | null {
  if (toolName !== 'composio_search_tools' && toolName !== 'composio_list_tools') return null;

  const listKey = Array.isArray(obj.matches) ? 'matches' : Array.isArray(obj.tools) ? 'tools' : null;
  if (!listKey) return null;

  const records = (obj[listKey] as unknown[]).map(compactComposioCatalogItem).filter((item): item is Record<string, unknown> => Boolean(item));
  const slugs = records.map((item) => item.slug).filter((slug): slug is string => typeof slug === 'string');
  const budget = Math.max(700, maxChars - 520);
  const slugBudget = Math.max(240, Math.min(4000, Math.floor(budget * 0.4)));
  const fittedSlugs = fitStringList(slugs, slugBudget);
  const slugKey = listKey === 'matches' ? 'matchingSlugs' : 'availableSlugs';

  const base: Record<string, unknown> = {
    digestKind: 'composio_catalog',
  };
  if (typeof obj.configured === 'boolean') base.configured = obj.configured;
  if (typeof obj.toolkit === 'string') base.toolkit = obj.toolkit;
  if (typeof obj.query === 'string') base.query = obj.query;
  if (Array.isArray(obj.searchedToolkits)) base.searchedToolkits = obj.searchedToolkits;
  if (typeof obj.count === 'number') base.count = obj.count;
  base[slugKey] = fittedSlugs.shown;
  if (fittedSlugs.omitted > 0) base.omittedSlugs = fittedSlugs.omitted;

  const shown: Record<string, unknown>[] = [];
  const build = () => JSON.stringify({
    ...base,
    [listKey]: shown,
    nextStep: obj.nextStep ?? `Pick an exact slug from ${slugKey}, then call composio_execute_tool with that slug.`,
  }, null, 1);

  let body = build();
  for (const record of records) {
    shown.push(record);
    const candidate = build();
    if (candidate.length > budget && shown.length > 1) {
      shown.pop();
      break;
    }
    body = candidate;
    if (body.length > budget) break;
  }

  const moreRecords = records.length - shown.length;
  const footer =
    `\n[digest: ${toolName} returned a Composio tool catalog with ${records.length} slug${records.length === 1 ? '' : 's'} ` +
    `(~${totalChars.toLocaleString()} chars). Preserved ${fittedSlugs.shown.length} exact slug${fittedSlugs.shown.length === 1 ? '' : 's'} ` +
    `and ${shown.length} compact record${shown.length === 1 ? '' : 's'}${moreRecords > 0 ? `; ${moreRecords} compact record(s) not shown` : ''}. ` +
    `${recoveryHint(callId)}]`;
  return body + footer;
}

function digestText(text: string, maxChars: number, toolName: string, callId: string | null | undefined): string {
  const lines = text.split('\n');
  const footerReserve = 300;
  const budget = Math.max(200, maxChars - footerReserve);
  const headLen = Math.floor(budget * 0.7);
  const tailLen = budget - headLen;
  const head = text.slice(0, headLen);
  const tail = text.length > headLen + tailLen ? text.slice(text.length - tailLen) : '';
  const footer =
    `\n[digest: ${toolName} returned ${text.length.toLocaleString()} chars / ${lines.length.toLocaleString()} lines. ` +
    `Showing the head${tail ? ' and tail' : ''}. ${recoveryHint(callId)}]`;
  return tail ? `${head}\n…[middle omitted]…\n${tail}${footer}` : `${head}${footer}`;
}

/**
 * Produce a structure-aware digest of `text` that fits roughly within
 * `maxChars`. Returns the digest string. Caller decides when to invoke
 * (i.e. only when text exceeds the budget).
 */
export function digestToolOutput(text: string, options: DigestOptions = {}): string {
  const maxChars = options.maxChars ?? 4000;
  const toolName = options.toolName ?? 'tool';
  const callId = options.callId ?? null;
  const parsed = tryParse(text);
  if (Array.isArray(parsed)) return digestArray(parsed, text.length, maxChars, toolName, callId);
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    return digestComposioCatalog(obj, text.length, maxChars, toolName, callId) ?? digestObject(obj, text.length, maxChars, toolName, callId);
  }
  return digestText(text, maxChars, toolName, callId);
}
