import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retainedResultWayThrough } from '../runtime/harness/retained-result-routes.js';
import { z } from 'zod';
import { getToolOutput, getToolOutputSlice } from '../runtime/harness/eventlog.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { windowScaleForModel } from '../runtime/harness/model-window-observations.js';
import { textResult } from './shared.js';
import { parseShellToolOutput } from './inner-dispatch.js';
import { parseStoredToolOutputJson } from '../runtime/harness/json-repair.js';
import { listToolOutputCallIds } from '../runtime/harness/eventlog.js';
import { describeJsonShape, resolveDominantArray } from '../runtime/harness/tool-output-digest.js';
import { toolCallHint } from '../runtime/harness/tool-call-hint.js';

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
 * are forbidden — call_ids from different sessions live in different
 * scopes and the table primary key (session_id, call_id) enforces it.
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
const RECALL_MAX_CHARS_CEILING = 120_000;

function recallSliceCeiling(routedModelId?: string): number {
  return Math.min(
    RECALL_MAX_CHARS_CEILING,
    Math.max(BASE_RECALL_MAX_CHARS, Math.round(BASE_RECALL_MAX_CHARS * windowScaleForModel(routedModelId))),
  );
}

// Cap a single tool_output_query response. The store now holds up to 2MB, and
// tool_output_query intentionally bypasses the digest clip (it returns exactly
// the page/projection asked for) — so without this bound an UNFILTERED query on
// a large parked object (or a big array page) could dump the whole payload into
// context. A page/projection is an explicit ask, so this sits a bit above
// recall's per-call 30KB; the marker tells the model how to narrow further.
const QUERY_MAX_CHARS = 50_000;
const clipQueryBody = (text: string): string =>
  text.length <= QUERY_MAX_CHARS
    ? text
    : `${text.slice(0, QUERY_MAX_CHARS)}\n…[clipped to ${QUERY_MAX_CHARS} chars — narrow with fields:[...], a filter, or a smaller limit]`;

/** Zod shapes exported so the tool-call-hint pin can validate every emitted
 * hint example against the REAL registered contract (single source of truth —
 * a hand-written example can never drift from the schema unnoticed). */
export const RECALL_TOOL_RESULT_SHAPE = {
  call_id: z
    .string()
    .min(1)
    .describe('The call_id from the [clipped: ...] stub, e.g. "call_abc123".'),
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
    .describe('Optional cap on the returned slice (default: the largest this context window allows).'),
};

export const TOOL_OUTPUT_QUERY_SHAPE = {
  call_id: z.string().min(1).describe('The call_id from the digest/clip footer.'),
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
};

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
      const callId = String(input.call_id ?? '');
      const ctx = harnessRunContextStorage.getStore();
      const sliceCeiling = recallSliceCeiling(ctx?.routedModelId);
      const maxChars = Number.isFinite(input.max_chars as number)
        ? Math.min(sliceCeiling, Math.max(100, Math.trunc(input.max_chars as number)))
        : sliceCeiling;
      const offset = Number.isFinite(input.offset as number)
        ? Math.max(0, Math.trunc(input.offset as number))
        : 0;
      if (!ctx?.sessionId) {
        return textResult(
          'recall_tool_result is only available within a harness-managed turn. (No active session context.)',
        );
      }

      const row = getToolOutputSlice(ctx.sessionId, callId, offset, maxChars);
      if (!row) {
        return textResult(
          `No tool output found for call_id "${callId}" in this session. Check the [clipped: ...] stub for the correct call_id, or proceed with the summary.`,
        );
      }
      if (row.truncatedAtWrite) {
        return textResult(
          `ERROR: tool output "${callId}" is incomplete (${row.contentBytes} original bytes; legacy truncation or missing/corrupt durable chunks). Re-read/page the provider source or stage a complete artifact; the stored prefix cannot be recalled as authoritative data.`,
        );
      }

      // The range reader uses persisted UTF-16 offsets and fetches only BLOBs
      // intersecting this page; it does not rebuild/hash an unrelated 100MB
      // tail on every 30KB recall call.
      const total = row.totalChars;
      const start = row.start;
      const slice = row.output;
      const sliceBytes = Buffer.byteLength(slice, 'utf8');

      // Budget check — only when a HarnessRunContext provided one.
      if (ctx.recallBudget) {
        const err = ctx.recallBudget.consume(sliceBytes, callId);
        // Unmistakably an ERROR, never data (live 2026-07-24: a program
        // JSON.parsed the bare budget message and called good data malformed).
        if (err) return textResult(`ERROR: ${err}`);
      }

      const end = row.end;
      const header = [
        `Recalled chars ${start}–${end} of ${total} (${row.contentBytes} total bytes)`,
        row.tool ? `tool=${row.tool}` : null,
        `recorded at ${row.createdAt}`,
        end < total
          // Name the EXACT next call. A model that has to reconstruct it
          // guesses offsets, and blind paging spends a turn per slice while
          // crediting no business progress until the governor ends the run.
          ? `(more remains — continue with recall_tool_result {"call_id":"${callId}","offset":${end}}`
            // When a lot is left, paging is the wrong instrument entirely:
            // tool_output_query answers over the SAME stored output instead of
            // walking it a slice at a time.
            + ((total - end) > maxChars * 2
              ? `; that is ~${Math.ceil((total - end) / maxChars)} more slices, so if you need an ANSWER rather than `
                + `the raw text, tool_output_query {"call_id":"${callId}"} reads the same stored output server-side `
                + `and does not page`
              : '')
            + ')'
          : null,
      ]
        .filter(Boolean)
        .join(' • ');

      const body = `${header}\n\n${slice}`;
      return textResult(body, { maxChars: body.length });
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
      'The result is parked losslessly — never say the data is unavailable.',
      `E.g. ${toolCallHint('tool_output_query', { call_id: 'call_abc123', fields: ['name', 'id'], limit: 50 })}.`,
    ].join(' '),
    TOOL_OUTPUT_QUERY_SHAPE,
    async (input: Record<string, unknown>) => {
      const callId = String(input.call_id ?? '');
      const ctx = harnessRunContextStorage.getStore();
      if (!ctx?.sessionId) {
        return textResult('tool_output_query is only available within a harness-managed turn. (No active session context.)');
      }
      const row = getToolOutput(ctx.sessionId, callId);
      if (!row) {
        const suggestion = nearestToolOutputCallId(callId, listToolOutputCallIds(ctx.sessionId));
        return textResult(
          suggestion
            ? `No tool output found for call_id "${callId}". Did you mean "${suggestion}"? `
              + 'Re-run this query with that exact id.'
            : `No tool output found for call_id "${callId}" in this session.`,
        );
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
        // Say what is true: recovery failed. Never tell the model its own
        // valid JSON "is not JSON" — it obeys, comes back, and burns the turn.
        // The successor is COMPUTED. This used to say "use recall_tool_result"
        // unconditionally, while recall's own exhaustion message said "call
        // tool_output_query instead" — a closed loop with no exit (live
        // 2026-09-07 source 146537, the Platform 49 plan that never published).
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
      const project = (rec: unknown): unknown => {
        if (!fields || !rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
        const out: Record<string, unknown> = {};
        for (const f of fields) if (f in (rec as Record<string, unknown>)) out[f] = (rec as Record<string, unknown>)[f];
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
          || fields !== undefined,
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
        const matched = rows.length;
        // Zero matches must TEACH, not stonewall: name the fields that exist so
        // the next filter lands (weakest-model rule — every dead end escapable
        // from its text alone).
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
        const from = unwrappedPath ? ` from ${unwrappedPath}[*]` : '';
        const header = recoveredClippedArrayPrefix
          ? `Showing ${page.length} record(s) [${offset}–${offset + page.length}] of ${matched} matching among ${(parsed as unknown[]).length} complete record(s) recovered from a clipped JSON-array prefix (full total unknown)`
          : `Showing ${page.length} record(s) [${offset}–${offset + page.length}] of ${matched} matching (${(parsed as unknown[]).length} total${from})`;
        // Hand the model the EXACT, copy-paste reference for these values, so a
        // downstream send binds them by reference instead of retyping (which is
        // how a value gets invented or dropped). Root array + single projected
        // field → a precise path.
        const refBase = unwrappedPath ? `${unwrappedPath}[*]` : '[*]';
        const refPath = fields && fields.length === 1 ? `${refBase}.${fields[0]}` : refBase;
        const refHint = `\n\n[grounded reference] To use these EXACT values in a later send/write WITHOUT retyping them, pass this as the field value: {"$fromToolOutput":{"callId":"${callId}","path":"${refPath}"}} — the harness binds the real values before the call (fabrication-proof; a bad reference fails closed).`;
        const bodyText = clipQueryBody(`${header}\n\n${JSON.stringify(page, null, 1)}`) + refHint;
        return textResult(bodyText, { maxChars: bodyText.length });
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
        const refHint = `\n\n[grounded reference] To reuse values from this result in a later send/write WITHOUT retyping, reference them: {"$fromToolOutput":{"callId":"${callId}","path":"<path to the values, e.g. result.records[*].Email>"}} — the harness binds the real values before the call.`;
        const bodyText = clipQueryBody(`Object (${Object.keys(parsed as object).length} top-level keys)\n\n${JSON.stringify(projected, null, 1)}`) + refHint;
        return textResult(bodyText, { maxChars: bodyText.length });
      }

      return textResult(`Tool output "${callId}" is a scalar: ${JSON.stringify(parsed)}`);
    },
  );
}
