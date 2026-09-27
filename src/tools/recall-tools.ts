import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retainedResultRoutes, retainedResultWayThrough } from '../runtime/harness/retained-result-routes.js';
import { z } from 'zod';
import { getToolOutput, getToolOutputSlice, type ToolOutputRecord } from '../runtime/harness/eventlog.js';
import { harnessRunContextStorage, type HarnessRunContext } from '../runtime/harness/brackets.js';
import { windowScaleForModel } from '../runtime/harness/model-window-observations.js';
import {
  RETAINED_OUTPUT_READER_MAX_SLICE_CHARS,
  inlineResultBudgetForModel,
} from '../runtime/harness/tool-output-format.js';
import { textResult } from './shared.js';
import { parseShellToolOutput } from './inner-dispatch.js';
import { parseStoredToolOutputJson } from '../runtime/harness/json-repair.js';
import { listToolOutputCallIds } from '../runtime/harness/eventlog.js';
import { describeJsonShape, resolveDominantArray } from '../runtime/harness/tool-output-digest.js';
import { toolCallHint } from '../runtime/harness/tool-call-hint.js';
import { resolveRetainedOutputRead } from '../runtime/harness/retained-output-read.js';
import { projectProviderResultEvidenceView } from '../runtime/harness/result-facts.js';
import { describeMissingRetainedOutputForSession } from '../runtime/harness/retained-output-redirect.js';
import {
  aggregateRows,
  applyWhere,
  fieldValue,
  sortRows,
  type AggregateFigure,
  type RecordAggregateOp,
  type RecordCondition,
} from './record-query.js';

/**
 * recall_tool_result — retrieve the verbatim output of a prior tool
 * call when auto-compact (Layer 1) has clipped it from the conversation.
 *
 * Lossless fetch from the `tool_outputs` table (populated at write-time
 * in hooks.ts using inline plus content-addressed chunks before the event-log
 * copy is clipped to 8KB). Pass `offset` to page
 * through a payload larger than a single 30KB slice.
 *
 * Scoping: reads the session id from the harness AsyncLocalStorage
 * (brackets.ts:harnessRunContextStorage). Cross-session call_id lookups
 * are forbidden except for exact parent results explicitly shared by the host
 * with a delegated worker. Those reads verify the stored content fingerprint;
 * arbitrary session lookup remains unavailable.
 *
 * Budget: 3 calls + 60KB per turn (defaults in loop.ts when the
 * HarnessRunContext is built). Beyond budget, returns an error string
 * rather than throwing — the agent can pivot without aborting the turn.
 */

/**
 * Per-call slice, scaled to the routed brain's context window.
 *
 * A fixed 30KB slice is a long-horizon cliff: paging one large parked payload
 * costs a tool call per 30KB, those calls credit no business progress, and the
 * no-progress governor ends the run before the work starts (live platform-49
 * run 2026-09-02: 19 recalls, zero business calls, the sheet never touched).
 * A 1M-window brain can hold far more than 30KB per step, so the slice now
 * rides the same window scale the recall BUDGET already uses rather than
 * pinning every model to the smallest one's ceiling.
 */
const BASE_RECALL_MAX_CHARS = 30_000;
/** Schema bound: BASE × the maximum window scale (4). Static so the tool
 *  contract — and therefore the prompt cache — never churns per model. */
const RECALL_MAX_CHARS_CEILING = RETAINED_OUTPUT_READER_MAX_SLICE_CHARS;

function recallSliceCeiling(routedModelId?: string): number {
  return Math.min(
    RECALL_MAX_CHARS_CEILING,
    Math.max(BASE_RECALL_MAX_CHARS, Math.round(BASE_RECALL_MAX_CHARS * windowScaleForModel(routedModelId))),
  );
}

/**
 * The slice one recall returns. An explicit max_chars is honored up to the
 * window's slice ceiling. Without one, a recall shows one whole inline result
 * for this window (the same budget a Clementine state read gets), never the
 * much larger ceiling, so a bare recall costs what the original read would
 * have cost and pages on with an exact next offset.
 */
export function recallSliceChars(requested: unknown, routedModelId?: string): number {
  const ceiling = recallSliceCeiling(routedModelId);
  if (typeof requested === 'number' && Number.isFinite(requested)) {
    return Math.min(ceiling, Math.max(100, Math.trunc(requested)));
  }
  return Math.min(ceiling, inlineResultBudgetForModel(routedModelId));
}

/** The most one tool_output_query reply returns when the caller names a page
 * size or a projection: that page was asked for explicitly, so it may run
 * past one inline result. The marker tells the model how to narrow further. */
const QUERY_MAX_CHARS = 50_000;
/** A reply too small to hold a header and one record is not worth a round. */
const QUERY_MIN_REPLY_CHARS = 1_000;

const clipQueryBody = (text: string, maxChars: number = QUERY_MAX_CHARS): string =>
  text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n…[clipped to ${maxChars} chars — narrow with fields:[...], a filter, or a smaller limit]`;

/** Whether the caller named a page size or a projection. */
function queryNamesItsPage(input: Record<string, unknown>): boolean {
  if (normalizeFieldsInput(input.fields) !== undefined) return true;
  return typeof input.limit === 'number' && Number.isFinite(input.limit);
}

/**
 * The most one tool_output_query reply may hold. A bare query (no limit, no
 * fields) is one inline result for the routed window, the same default a bare
 * recall gets; a named page or projection may use QUERY_MAX_CHARS. Either way
 * the reply fits what the turn's reading byte budget still allows.
 */
function queryReplyChars(input: Record<string, unknown>, ctx: HarnessRunContext): number {
  const shaped = queryNamesItsPage(input)
    ? QUERY_MAX_CHARS
    : Math.min(QUERY_MAX_CHARS, inlineResultBudgetForModel(ctx.routedModelId));
  return Math.min(shaped, ctx.recallBudget?.remainingBytes() ?? Number.POSITIVE_INFINITY);
}

const QUERY_CONTINUATION_KEYS = [
  'fields', 'filter_field', 'filter_contains', 'filter_equals', 'where', 'sort_by', 'order', 'limit',
] as const;

/** The exact next query for the records a reply had no room for. */
function nextQueryCall(callId: string, input: Record<string, unknown>, offset: number): string {
  const args: Record<string, unknown> = { call_id: callId };
  for (const key of QUERY_CONTINUATION_KEYS) {
    const value = input[key];
    if (value !== undefined && value !== null) args[key] = value;
  }
  args.offset = offset;
  return `tool_output_query ${JSON.stringify(args)}`;
}

/**
 * The largest leading run of a page that fits `maxChars`, cut on a record
 * boundary, never inside a record. When not even one record fits, the one
 * record is clipped with the narrowing marker.
 */
function fitRecordPage(
  pageLength: number,
  render: (count: number) => string,
  maxChars: number,
): { count: number; text: string } {
  const whole = render(pageLength);
  if (whole.length <= maxChars) return { count: pageLength, text: whole };
  let fits = 0;
  let low = 1;
  let high = pageLength - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (render(middle).length <= maxChars) {
      fits = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (fits === 0) return { count: Math.min(1, pageLength), text: clipQueryBody(render(Math.min(1, pageLength)), maxChars) };
  return { count: fits, text: render(fits) };
}

/** Charge a query reply to the turn's reading byte budget. */
function chargeQueryReply(ctx: HarnessRunContext, callId: string, bodyText: string) {
  const refusal = ctx.recallBudget?.consumeQueryBytes(Buffer.byteLength(bodyText, 'utf8'), callId);
  return refusal ? textResult(`ERROR: ${refusal}`) : textResult(bodyText, { maxChars: bodyText.length });
}

/** Zod shapes exported so the tool-call-hint pin can validate every emitted
 * hint example against the REAL registered contract (single source of truth —
 * a hand-written example can never drift from the schema unnoticed). */
export const RECALL_TOOL_RESULT_SHAPE = {
  call_id: z
    .string()
    .min(1)
    .describe('The original call_id from a clip/digest, or an rh_ receipt handle shown in a saved checkpoint.'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Start character (default 0); page with the "offset: N" hint from a prior slice.'),
  max_chars: z
    .number()
    .int()
    .min(100)
    .max(RECALL_MAX_CHARS_CEILING)
    .optional()
    .describe('Optional slice size; a larger value up to this context window\'s ceiling is returned whole (default: one inline result).'),
};

export const TOOL_OUTPUT_QUERY_SHAPE = {
  call_id: z.string().min(1).describe('The original call_id from a digest/clip, or an rh_ receipt handle shown in a saved checkpoint.'),
  // Accepts BOTH an array and a comma-separated string. The array is the
  // documented form; the string form is deliberate boundary tolerance — a
  // near-miss models actually produce (`"fields": "subject,start"`), and a
  // comma-separated projection list has exactly one meaning, so accepting it
  // converts a wasted error round-trip into the intended query. Both branches
  // are TYPED (strict-schema compatible — see the nullish-anyOf constraint).
  fields: z
    .union([
      z.array(z.string()),
      z.string(),
    ])
    .optional()
    .describe('Keys to keep per record, e.g. ["subject","start"] or "subject,start"; omit for all.'),
  filter_field: z.string().optional().describe('Field to match with filter_contains/filter_equals.'),
  filter_contains: z.string().optional().describe('Case-insensitive substring for filter_field.'),
  filter_equals: z.string().optional().describe('Exact match for filter_field.'),
  offset: z.number().int().min(0).optional().describe('Matching records to skip (default 0).'),
  limit: z.number().int().min(1).max(200).optional().describe('Max records to return (default 50).'),
  where: z
    .array(z.object({
      field: z.string().min(1).describe('Record field; a dotted path reaches nested values.'),
      op: z.enum(['eq', 'ne', 'contains', 'lt', 'lte', 'gt', 'gte']),
      value: z.union([z.string(), z.number()]),
    }))
    .optional()
    .describe('Conditions every record must meet. Numbers compare as numbers and ISO dates as dates; text compares case-insensitively.'),
  sort_by: z.string().optional().describe('Order matching records by this field, for a ranking or a top N.'),
  order: z.enum(['asc', 'desc']).optional().describe('Sort direction (default asc).'),
  aggregate: z
    .enum(['count', 'sum', 'avg', 'min', 'max'])
    .optional()
    .describe('Return this exact figure over EVERY matching record instead of listing them: count, or sum/avg/min/max of value_field.'),
  value_field: z.string().optional().describe('The numeric field sum/avg/min/max read.'),
  group_by: z.string().optional().describe('Compute the aggregate per distinct value of this field.'),
};

/** A computed figure as the model should read it: binary floating-point
 *  noise (0.1 + 0.2) is not part of the data, so the text carries at most 12
 *  significant digits, which still shows very small and very large values. */
function figureText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
}

function aggregateLine(label: string, op: RecordAggregateOp, valueField: string | undefined, result: AggregateFigure): string {
  const what = op === 'count' ? 'count' : `${op} of ${valueField}`;
  const value = result.value === null ? 'no numeric values' : figureText(result.value);
  const lacking = result.lackedNumber > 0 ? `; ${result.lackedNumber} matching record(s) had no number in ${valueField}` : '';
  return `${label}${what} = ${value}${op === 'count' ? '' : ` (over ${result.counted} record(s)${lacking})`}`;
}

/** Normalize the widened `fields` input to a clean array (or undefined). One
 * canonical spelling past this boundary — so downstream projection logic and
 * any future input-bound reuse/replay identity never see two encodings of the
 * same query. */
export function normalizeFieldsInput(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const arr = raw.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).map((f) => f.trim());
    return arr.length > 0 ? arr : undefined;
  }
  if (typeof raw === 'string' && raw.trim()) {
    // String-only tool transports can serialize the documented array form.
    // Decode only a nonempty string array; malformed input must not widen a
    // projection into returning every field.
    try {
      const decoded: unknown = JSON.parse(raw);
      if (Array.isArray(decoded) && decoded.length > 0
        && decoded.every((field) => typeof field === 'string' && field.trim().length > 0)) {
        return decoded.map((field: string) => field.trim());
      }
    } catch { /* the existing comma-separated spelling is also supported */ }
    const arr = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return arr.length > 0 ? arr : undefined;
  }
  return undefined;
}

/** Levenshtein distance, bounded — we only care whether two ids are a slip apart. */
function editDistanceWithin(a: string, b: string, max: number): number | null {
  if (Math.abs(a.length - b.length) > max) return null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      row.push(value);
      if (value < best) best = value;
    }
    if (best > max) return null;
    prev = row;
  }
  const distance = prev[b.length]!;
  return distance <= max ? distance : null;
}

/**
 * The exact correction for a call_id that does not exist.
 *
 * The harness knows every real id, so a transposition should be answered with
 * the right one rather than a dead end. Live 2026-09-03, platform-49 run 10:
 * the model asked for `toulu_016PctF8QXsnvKo5ZKasu1ri` (a two-letter swap of
 * `toolu_…`), got a bare "no tool output found", and spent the rest of the turn
 * recovering. Run 5 proved the opposite works — an exact correction repaired the
 * very next frame.
 */
export function nearestToolOutputCallId(
  wanted: string,
  known: readonly string[],
): string | null {
  const target = wanted.trim();
  if (!target) return null;
  // Same length class only, and at most two edits: a genuine typo, never a
  // guess at a different result.
  let best: { id: string; distance: number } | null = null;
  for (const candidate of known) {
    if (candidate === target) return null;
    const distance = editDistanceWithin(target, candidate, 2);
    if (distance === null) continue;
    if (!best || distance < best.distance) best = { id: candidate, distance };
  }
  return best ? best.id : null;
}

type RetainedTextSlice =
  | { status: 'missing' }
  | { status: 'incomplete'; contentBytes: number }
  | { status: 'budget'; error: string }
  | { status: 'ok'; body: string };

/**
 * One verbatim slice of a retained output, with the header that names the
 * exact next call. The single owner of reading retained TEXT: recall_tool_result
 * returns it, and tool_output_query returns it for an output that holds no
 * structured records. Either way it spends the turn's recall budget.
 */
function readRetainedTextSlice(
  ctx: HarnessRunContext,
  resolved: { callId: string; receipt?: ToolOutputRecord },
  offset: number,
  maxChars: number,
): RetainedTextSlice {
  const callId = resolved.callId;
  const start = resolved.receipt ? Math.min(offset, resolved.receipt.output.length) : 0;
  const row = resolved.receipt
    ? { ...resolved.receipt, start, end: Math.min(start + maxChars, resolved.receipt.output.length),
        totalChars: resolved.receipt.output.length, output: resolved.receipt.output.slice(start, start + maxChars) }
    : getToolOutputSlice(ctx.sessionId, callId, offset, maxChars);
  if (!row) return { status: 'missing' };
  if (row.truncatedAtWrite) return { status: 'incomplete', contentBytes: row.contentBytes };

  // The range reader uses persisted UTF-16 offsets and fetches only BLOBs
  // intersecting this page; it does not rebuild/hash an unrelated tail on
  // every slice.
  const total = row.totalChars;
  const sliceStart = row.start;
  const slice = row.output;
  const sliceBytes = Buffer.byteLength(slice, 'utf8');

  // Budget check — only when a HarnessRunContext provided one.
  if (ctx.recallBudget) {
    const err = ctx.recallBudget.consume(sliceBytes, callId);
    if (err) return { status: 'budget', error: err };
  }

  const end = row.end;
  // When a lot is left, paging is the wrong instrument entirely: a reader that
  // answers over the SAME stored output beats walking it a slice at a time.
  // Which reader that is depends on the output's shape, so the one reader
  // router names it (a query for records, a passage search for text).
  const answerRoute = end < total && (total - end) > maxChars * 2
    ? retainedResultRoutes({ sessionId: ctx.sessionId, callId, exclude: ['recall_tool_result'] })[0]
    : undefined;
  const header = [
    `Recalled chars ${sliceStart}–${end} of ${total} (${row.contentBytes} total bytes)`,
    row.tool ? `tool=${row.tool}` : null,
    `recorded at ${row.createdAt}`,
    end < total
      // Name the EXACT next call. A model that has to reconstruct it guesses
      // offsets, and blind paging spends a turn per slice while crediting no
      // business progress until the governor ends the run.
      ? `(more remains — continue with recall_tool_result {"call_id":"${callId}","offset":${end}}`
        + (answerRoute
          ? `; that is ~${Math.ceil((total - end) / maxChars)} more slices, so if you need an ANSWER rather than `
            + `the raw text, ${answerRoute.call} — ${answerRoute.why}`
          : '')
        + ')'
      : null,
  ]
    .filter(Boolean)
    .join(' • ');
  return { status: 'ok', body: `${header}\n\n${slice}` };
}

/** Whether a tool_output_query asks for record shaping (a projection, filter,
 * ordering or figure) rather than just the stored output. Strict-schema
 * transports send unused optional arguments as null. */
function asksForRecordShaping(input: Record<string, unknown>): boolean {
  if (normalizeFieldsInput(input.fields) !== undefined) return true;
  return ['filter_field', 'filter_contains', 'filter_equals', 'where', 'sort_by', 'aggregate', 'value_field', 'group_by']
    .some((key) => {
      const value = input[key];
      if (value === undefined || value === null) return false;
      if (typeof value === 'string') return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    });
}

export function registerRecallTools(server: McpServer): void {
  server.tool(
    'recall_tool_result',
    [
      'Read the full verbatim output of a prior tool call by the call_id a `[clipped: …]` stub or `[digest: …]` footer names, when you need a detail the shortened view dropped.',
      'The payload is stored losslessly — never say the data is unavailable. Returns one slice from `offset`; the header names the next offset when more remains.',
      `E.g. ${toolCallHint('recall_tool_result', { call_id: 'call_abc123' })}.`,
    ].join(' '),
    RECALL_TOOL_RESULT_SHAPE,
    async (input: Record<string, unknown>) => {
      let callId = String(input.call_id ?? '');
      const ctx = harnessRunContextStorage.getStore();
      const maxChars = recallSliceChars(input.max_chars, ctx?.routedModelId);
      const offset = Number.isFinite(input.offset as number)
        ? Math.max(0, Math.trunc(input.offset as number))
        : 0;
      if (!ctx?.sessionId) {
        return textResult(
          'recall_tool_result is only available within a harness-managed turn. (No active session context.)',
        );
      }

      const resolved = resolveRetainedOutputRead(ctx.sessionId, callId);
      callId = resolved.callId;
      const read = readRetainedTextSlice(ctx, resolved, offset, maxChars);
      if (read.status === 'missing') {
        // A capability reference is not a result handle, and "not found" is
        // not "empty": name what the id is, how to invoke it, and what this
        // turn has actually retained.
        return textResult(describeMissingRetainedOutputForSession({
          sessionId: ctx.sessionId,
          sourceUserSeq: ctx.sourceUserSeq,
          requestedId: callId,
          readerTool: 'recall_tool_result',
        }));
      }
      if (read.status === 'incomplete') {
        return textResult(
          `ERROR: tool output "${callId}" is incomplete (${read.contentBytes} original bytes; legacy truncation or missing/corrupt durable chunks). Re-read/page the provider source or stage a complete artifact; the stored prefix cannot be recalled as authoritative data.`,
        );
      }
      // Unmistakably an ERROR, never data: a program must not JSON.parse a
      // budget message and call good data malformed.
      if (read.status === 'budget') return textResult(`ERROR: ${read.error}`);
      return textResult(read.body, { maxChars: read.body.length });
    },
  );

  // tool_output_query — pull an exact SLICE of a large parked tool output
  // (projected fields, filtered rows, a page) without loading the whole
  // payload into context. The companion to the structure-aware digest:
  // when the digest shows the first K of N records, this fetches any
  // other slice on demand. Reads the same lossless tool_outputs store.
  server.tool(
    'tool_output_query',
    [
      'Query a slice of a large prior tool output by the call_id a `[digest: …]` footer or `[clipped: …]` stub names, without loading it all: filter rows, project fields and paginate a JSON array, or project the top-level keys of an object.',
      'Compute exact figures here instead of reading rows: `where` conditions (eq/ne/contains/lt/lte/gt/gte), `sort_by` + `order` + `limit` for a ranking or top N, and `aggregate` (count, or sum/avg/min/max of `value_field`, optionally per `group_by`) over every matching record. Any count, total, average or ranking you state should come from here.',
      'The result is parked losslessly — never say the data is unavailable.',
      `E.g. ${toolCallHint('tool_output_query', { call_id: 'call_abc123', fields: ['name', 'id'], limit: 50 })}.`,
    ].join(' '),
    TOOL_OUTPUT_QUERY_SHAPE,
    async (input: Record<string, unknown>) => {
      let callId = String(input.call_id ?? '');
      const ctx = harnessRunContextStorage.getStore();
      if (!ctx?.sessionId) {
        return textResult('tool_output_query is only available within a harness-managed turn. (No active session context.)');
      }
      // Counting historical queries cannot prove that every record was seen.
      // Keep the existing run/read budgets, but do not deny a valid projection
      // just because a different turn or failed field lookup used this result.
      const resolved = resolveRetainedOutputRead(ctx.sessionId, callId);
      callId = resolved.callId;
      const row = resolved.receipt ?? getToolOutput(ctx.sessionId, callId);
      if (!row) {
        const suggestion = nearestToolOutputCallId(callId, listToolOutputCallIds(ctx.sessionId));
        if (suggestion) {
          return textResult(
            `No tool output found for call_id "${callId}". Did you mean "${suggestion}"? `
              + 'Re-run this query with that exact id.',
          );
        }
        // Not a typo of a real id. Say what the id IS (a capability reference
        // that was never invoked, or an unknown id), the exact carrier call
        // that produces a result, and which results this turn has retained.
        return textResult(describeMissingRetainedOutputForSession({
          sessionId: ctx.sessionId,
          sourceUserSeq: ctx.sourceUserSeq,
          requestedId: callId,
          readerTool: 'tool_output_query',
        }));
      }
      if (row.truncatedAtWrite) {
        return textResult(
          `ERROR: tool output "${callId}" is incomplete (${row.contentBytes} original bytes; legacy truncation or missing/corrupt durable chunks). Re-read/page the provider source or stage a complete artifact; the stored prefix cannot be queried as authoritative data.`,
        );
      }
      // One canonical recovery for every reader of a parked output. The store
      // may hold the provider payload PLUS harness prose (composio route
      // notes, a recall preamble), so a bare JSON.parse is not the question.
      const recovered = parseStoredToolOutputJson(row.output, { shell: parseShellToolOutput });
      if (!recovered) {
        // Text never dead-ends. Asked for the output itself (no projection,
        // filter or figure), answer with the text exactly as recall would,
        // spending the same recall budget, instead of a refusal round.
        if (!asksForRecordShaping(input)) {
          // One inline result, exactly what a bare recall returns: the header
          // names the next offset, and a larger slice is recall's explicit ask.
          const read = readRetainedTextSlice(ctx, resolved, 0, recallSliceChars(undefined, ctx.routedModelId));
          if (read.status === 'ok') {
            const bodyText = `Tool output "${callId}" is text, not structured records, so here is its text as recall_tool_result returns it (fields, filters and figures need records).\n${read.body}`;
            return textResult(bodyText, { maxChars: bodyText.length });
          }
          if (read.status === 'budget') {
            return textResult(
              `ERROR: tool output "${callId}" is text, and this turn's recall budget is spent, so its text cannot be returned here. `
              + retainedResultWayThrough({ sessionId: ctx.sessionId, callId,
                exclude: ['tool_output_query', 'recall_tool_result'], recallCallsRemaining: 0 }),
            );
          }
        }
        // Say what is true: recovery failed. Never tell the model its own
        // valid JSON "is not JSON" — it obeys, comes back, and burns the turn.
        // The successor is COMPUTED by the one reader router, never named
        // here, so no two readers can point at each other.
        return textResult(
          `No JSON value could be recovered from tool output "${callId}" (${row.output.length.toLocaleString()} chars). `
          + 'It is text, not structured data. '
          + retainedResultWayThrough({ sessionId: ctx.sessionId, callId, exclude: ['tool_output_query'] }),
        );
      }
      let parsed: unknown = recovered.value;
      const recoveredClippedArrayPrefix = recovered.partialArrayPrefix === true;

      // One canonical spelling past this line: the widened string form
      // ("subject,start") becomes the same array the documented form produces.
      const fields = normalizeFieldsInput(input.fields);
      // The receipt reader and this query must agree on the payload owner.
      // JSON inside an exact MCP result is data, not a list of text blocks.
      // Preserve explicit envelope inspection and never select a failed or
      // conflicting payload. Raw stored bytes and receipt authority are intact.
      const explicitlyQueriesEnvelope = fields?.some(field => parsed !== null && typeof parsed === 'object'
        && Object.prototype.hasOwnProperty.call(parsed, field));
      const view = explicitlyQueriesEnvelope ? undefined : projectProviderResultEvidenceView(parsed);
      const decodedMcpPayload = view?.kind === 'provider_payload'
        && (view.owner === 'mcp_structured_content' || view.owner === 'mcp_text_json');
      if (decodedMcpPayload) parsed = view.payload;
      // A dotted field reaches into nested objects, as `where` and `sort_by`
      // already do; the projected key is the path as written. A projection
      // that ignored the path would empty every record and tell the model a
      // field it can sort by does not exist.
      const project = (rec: unknown): unknown => {
        if (!fields || !rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
        const out: Record<string, unknown> = {};
        for (const f of fields) {
          const value = fieldValue(rec, f);
          if (value !== undefined) out[f] = value;
        }
        return out;
      };

      // Unwrap the dominant nested list: providers wrap their records —
      // `{ data: { value: [...] } }` (Graph), `{ data: { records: [...] } }`
      // (composio/Airtable) — and the object path below can only project
      // TOP-LEVEL keys, so every filter/project/paginate query against a
      // wrapped result missed (2026-07-31 calendar run: the miss cost 3 extra
      // calls and a full 26KB recall). The records ARE the result; query them.
      let unwrappedPath = '';
      if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
        const wantsRecordQuery = Boolean(
          input.filter_field !== undefined || input.offset !== undefined || input.limit !== undefined
          || fields !== undefined || input.where !== undefined || input.sort_by !== undefined
          || input.aggregate !== undefined || input.group_by !== undefined,
        );
        const dom = resolveDominantArray(parsed);
        if (dom && dom.path && wantsRecordQuery) {
          // Only when the requested fields aren't literal top-level keys — an
          // explicit top-level projection still means the top-level object.
          const topLevel = new Set(Object.keys(parsed as Record<string, unknown>));
          const fieldsAreTopLevel = fields !== undefined
            && fields.length > 0
            && fields.every((f) => topLevel.has(f));
          if (!fieldsAreTopLevel) {
            parsed = dom.rows;
            unwrappedPath = dom.path;
          }
        }
      }

      if (Array.isArray(parsed)) {
        const ff = typeof input.filter_field === 'string' ? input.filter_field : undefined;
        const contains = typeof input.filter_contains === 'string' ? input.filter_contains.toLowerCase() : undefined;
        const equals = typeof input.filter_equals === 'string' ? input.filter_equals : undefined;
        let rows = parsed as unknown[];
        if (ff && (contains !== undefined || equals !== undefined)) {
          rows = rows.filter((r) => {
            const v = r && typeof r === 'object' ? (r as Record<string, unknown>)[ff] : undefined;
            const s = v == null ? '' : String(v);
            if (equals !== undefined) return s === equals;
            return s.toLowerCase().includes(contains as string);
          });
        }
        const conditions = Array.isArray(input.where) ? input.where as RecordCondition[] : [];
        let skipped = 0;
        if (conditions.length > 0) {
          const filtered = applyWhere(rows, conditions);
          rows = filtered.rows;
          skipped = filtered.skipped;
        }
        const skippedNote = skipped > 0
          ? ` ${skipped} record(s) were left out because a condition's field held no value comparable with it (missing, empty, or a different kind: number, date or text).`
          : '';
        const sortBy = typeof input.sort_by === 'string' && input.sort_by.trim() ? input.sort_by.trim() : undefined;
        const aggregate = typeof input.aggregate === 'string' ? input.aggregate as RecordAggregateOp : undefined;
        // An exact figure or a ranking needs the complete set: over a clipped
        // prefix it would read as the answer while missing records.
        if ((aggregate || sortBy) && recoveredClippedArrayPrefix) {
          const bodyText = `ERROR: tool output "${callId}" holds only ${(parsed as unknown[]).length} complete record(s) recovered from a clipped prefix; `
            + 'an exact count, total or ranking needs the complete set. Re-read the source whole (or page it) and query that result.';
          return textResult(bodyText, { maxChars: bodyText.length });
        }
        if (aggregate) {
          const valueField = typeof input.value_field === 'string' && input.value_field.trim() ? input.value_field.trim() : undefined;
          if (aggregate !== 'count' && !valueField) {
            const bodyText = `aggregate "${aggregate}" needs value_field: the numeric field to ${aggregate}. The records are an ${describeJsonShape(parsed)}.`;
            return textResult(bodyText, { maxChars: bodyText.length });
          }
          const groupBy = typeof input.group_by === 'string' && input.group_by.trim() ? input.group_by.trim() : undefined;
          const result = aggregateRows(rows, aggregate, { ...(valueField ? { valueField } : {}), ...(groupBy ? { groupBy } : {}) });
          const scope = `${rows.length} matching record(s) of ${(parsed as unknown[]).length} total${unwrappedPath ? ` from ${unwrappedPath}[*]` : ''}`;
          const lines = [`Exact over ${scope}.${skippedNote}`, aggregateLine('', aggregate, valueField, result.overall)];
          if (result.groups) {
            const shown = result.groups.slice(0, 100);
            lines.push('', `Per ${groupBy} (${result.groups.length} group(s), largest first):`);
            for (const group of shown) lines.push(aggregateLine(`${group.group}: `, aggregate, valueField, group.figure));
            if (result.groups.length > shown.length) lines.push(`…and ${result.groups.length - shown.length} more group(s)`);
          }
          return chargeQueryReply(ctx, callId, clipQueryBody(lines.join('\n')));
        }
        if (sortBy) rows = sortRows(rows, sortBy, input.order === 'desc' ? 'desc' : 'asc');
        const matched = rows.length;
        // Zero matches must TEACH, not stonewall: name the fields that exist so
        // the next filter lands (weakest-model rule — every dead end escapable
        // from its text alone).
        if (matched === 0 && conditions.length > 0) {
          const bodyText = `0 records met the conditions ${JSON.stringify(conditions)}.${skippedNote} The result is an ${describeJsonShape(parsed)}. `
            + 'Check the field names, values and value kinds, and re-query.';
          return textResult(bodyText, { maxChars: bodyText.length });
        }
        if (matched === 0 && ff) {
          const shape = describeJsonShape(parsed);
          const bodyText = `0 records matched filter_field=${JSON.stringify(ff)}. The result is an ${shape}. `
            + 'Check the field name/value and re-query.';
          return textResult(bodyText, { maxChars: bodyText.length });
        }
        const offset = Number.isFinite(input.offset as number) ? Math.max(0, Math.trunc(input.offset as number)) : 0;
        const limit = Number.isFinite(input.limit as number) ? Math.min(200, Math.max(1, Math.trunc(input.limit as number))) : 50;
        const page = rows.slice(offset, offset + limit).map(project);
        // A projection that strips EVERY record to {} is the same dead end as a
        // missed top-level projection — teach the record fields instead.
        if (fields && fields.length > 0 && page.length > 0
          && page.every((r) => r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r as object).length === 0)) {
          const bodyText = `None of ${JSON.stringify(fields)} exist on these records. The result is an ${describeJsonShape(rows)}. Re-query with fields that exist.`;
          return textResult(bodyText, { maxChars: bodyText.length });
        }
        const replyChars = queryReplyChars(input, ctx);
        if (replyChars < QUERY_MIN_REPLY_CHARS) {
          const refusal = ctx.recallBudget?.queryRefusal(QUERY_MIN_REPLY_CHARS, callId);
          if (refusal) return textResult(`ERROR: ${refusal}`);
        }
        const from = unwrappedPath ? ` from ${unwrappedPath}[*]` : '';
        // Hand the model the EXACT, copy-paste reference for these values, so a
        // downstream send binds them by reference instead of retyping (which is
        // how a value gets invented or dropped). Root array + single projected
        // field → a precise path.
        const refBase = unwrappedPath ? `${unwrappedPath}[*]` : '[*]';
        const refPath = fields && fields.length === 1 ? `${refBase}.${fields[0]}` : refBase;
        const refHint = resolved.receipt || decodedMcpPayload ? '' : `\n\n[grounded reference] To use these EXACT values in a later send/write WITHOUT retyping them, pass this as the field value: {"$fromToolOutput":{"callId":"${callId}","path":"${refPath}"}} — the harness binds the real values before the call (fabrication-proof; a bad reference fails closed).`;
        // A page that does not fit the reply is cut on a record boundary, and
        // the header counts only the records shown and names the exact query
        // for the rest, so paging never skips a record the model did not see.
        const render = (count: number): string => {
          const header = recoveredClippedArrayPrefix
            ? `Showing ${count} record(s) [${offset}–${offset + count}] of ${matched} matching among ${(parsed as unknown[]).length} complete record(s) recovered from a clipped JSON-array prefix (full total unknown)`
            : `Showing ${count} record(s) [${offset}–${offset + count}] of ${matched} matching (${(parsed as unknown[]).length} total${from})${sortBy ? `, ordered by ${sortBy} ${input.order === 'desc' ? 'descending' : 'ascending'}` : ''}${skippedNote ? `.${skippedNote}` : ''}`;
          const continuation = count < page.length
            ? `\n\n[${page.length - count} more record(s) of this page did not fit this reply. Next: ${nextQueryCall(callId, input, offset + count)}; fields:[...] fits more records per reply.]`
            : '';
          return `${header}\n\n${JSON.stringify(page.slice(0, count), null, 1)}${continuation}`;
        };
        const fitted = fitRecordPage(page.length, render, Math.max(0, replyChars - refHint.length));
        return chargeQueryReply(ctx, callId, fitted.text + refHint);
      }

      if (parsed && typeof parsed === 'object') {
        const projected = project(parsed);
        // A projection that matched NOTHING must return the map, not "{}" —
        // the 2026-07-31 calendar run got the empty object, learned nothing,
        // and fell back to recalling the entire 26KB raw payload.
        const projectionMissed = fields && fields.length > 0
          && Object.keys(projected as Record<string, unknown>).length === 0;
        if (projectionMissed) {
          const bodyText = `None of ${JSON.stringify(fields)} exist at the top level. The result's shape:\n`
            + `${describeJsonShape(parsed)}\n`
            + `Re-query with the fields/filter of the records themselves — this tool queries the record list directly.`;
          return textResult(bodyText, { maxChars: bodyText.length });
        }
        const replyChars = queryReplyChars(input, ctx);
        if (replyChars < QUERY_MIN_REPLY_CHARS) {
          const refusal = ctx.recallBudget?.queryRefusal(QUERY_MIN_REPLY_CHARS, callId);
          if (refusal) return textResult(`ERROR: ${refusal}`);
        }
        const refHint = resolved.receipt || decodedMcpPayload ? '' : `\n\n[grounded reference] To reuse values from this result in a later send/write WITHOUT retyping, reference them: {"$fromToolOutput":{"callId":"${callId}","path":"<path to the values, e.g. result.records[*].Email>"}} — the harness binds the real values before the call.`;
        const body = clipQueryBody(`Object (${Object.keys(parsed as object).length} top-level keys)\n\n${JSON.stringify(projected, null, 1)}`,
          Math.max(0, replyChars - refHint.length));
        return chargeQueryReply(ctx, callId, body + refHint);
      }

      return textResult(`Tool output "${callId}" is a scalar: ${JSON.stringify(parsed)}`);
    },
  );
}
