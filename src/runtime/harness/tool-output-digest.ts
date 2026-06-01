/**
 * Structure-aware digest for large tool outputs (flag:
 * LARGE_TOOL_OUTPUT_DIGEST, default off).
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

function recoveryHint(callId: string | null | undefined): string {
  if (!callId) return 'Re-run the call with a narrower scope (filter / fewer fields / a smaller range) to get the rest.';
  return `Get any slice with tool_output_query("${callId}", {offset, limit, fields, filter}), or recall_tool_result("${callId}") for the raw payload.`;
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
    if (used + s.length + 1 > budget && shown.length > 0) break;
    shown.push(el);
    used += s.length + 1;
  }
  const more = total - shown.length;
  const body = JSON.stringify(shown, null, 1);
  const fieldList = fields.length ? ` Fields: ${fields.slice(0, 24).join(', ')}${fields.length > 24 ? ', …' : ''}.` : '';
  const footer =
    `\n[digest: ${toolName} returned a JSON array of ${total} record${total === 1 ? '' : 's'} (~${totalChars.toLocaleString()} chars). ` +
    `Showing the first ${shown.length} COMPLETE record${shown.length === 1 ? '' : 's'}${more > 0 ? `; ${more} more not shown` : ''}.${fieldList} ` +
    `${recoveryHint(callId)}]`;
  return body + footer;
}

function digestObject(obj: Record<string, unknown>, totalChars: number, maxChars: number, toolName: string, callId: string | null | undefined): string {
  const entries = Object.entries(obj);
  const lines: string[] = [];
  const footerReserve = 320;
  const budget = Math.max(200, maxChars - footerReserve);
  let used = 0;
  let shownKeys = 0;
  for (const [k, v] of entries) {
    let desc: string;
    if (v === null) desc = 'null';
    else if (Array.isArray(v)) desc = `array(${v.length})`;
    else if (typeof v === 'object') desc = `object(${Object.keys(v as object).length} keys)`;
    else if (typeof v === 'string') desc = v.length <= 80 ? JSON.stringify(v) : `string(${v.length} chars): ${JSON.stringify(v.slice(0, 77))}…`;
    else desc = JSON.stringify(v);
    const line = `  ${k}: ${desc}`;
    if (used + line.length + 1 > budget && shownKeys > 0) break;
    lines.push(line);
    used += line.length + 1;
    shownKeys++;
  }
  const moreKeys = entries.length - shownKeys;
  const footer =
    `\n[digest: ${toolName} returned a JSON object with ${entries.length} top-level key${entries.length === 1 ? '' : 's'} (~${totalChars.toLocaleString()} chars)${moreKeys > 0 ? `; ${moreKeys} key(s) not shown` : ''}. ` +
    `${recoveryHint(callId)}]`;
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
    if (used + serialized.length + 1 > maxChars && shown.length > 0) break;
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
