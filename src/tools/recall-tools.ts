import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getToolOutput, TOOL_OUTPUT_MAX_BYTES } from '../runtime/harness/eventlog.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { textResult } from './shared.js';
import { parseShellToolOutput } from './code-mode-tool.js';

/**
 * recall_tool_result — retrieve the verbatim output of a prior tool
 * call when auto-compact (Layer 1) has clipped it from the conversation.
 *
 * Lossless fetch from the `tool_outputs` table (populated at write-time
 * in hooks.ts with up to TOOL_OUTPUT_MAX_BYTES (2MB) of original output,
 * before the event-log copy is clipped to 8KB). Pass `offset` to page
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

const DEFAULT_RECALL_MAX_CHARS = 30_000;

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

export function registerRecallTools(server: McpServer): void {
  server.tool(
    'recall_tool_result',
    [
      'Retrieve the full verbatim output of a prior tool call by its call_id.',
      'Use this whenever the conversation shows a `[clipped: …]` stub OR a `[digest: …]` footer carrying a call_id and you need a detail the shortened view dropped (URLs, IDs, exact figures, ranking positions, full records, etc.).',
      'This reader is ALWAYS available to you inside a turn — the full payload is stored losslessly. Never tell the user the data is unavailable, that the reader "isn\'t exposed", or that a completed call is still pending: call this instead.',
      'Returns up to 30KB of original output per call, starting at `offset` (default 0). When the result is bigger, the header says how much remains and the exact `offset` to pass next to continue paging. Counts against a per-turn budget of 3 calls / 60KB total — use sparingly; for a JSON list prefer tool_output_query (it pages records, not raw chars).',
    ].join(' '),
    {
      call_id: z
        .string()
        .min(1)
        .describe('The call_id from the [clipped: ...] stub. Looks like "call_abc123".'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Start character to read from (default 0). Use the "more remains — offset: N" hint from a prior call to page through a large payload.'),
      max_chars: z
        .number()
        .int()
        .min(100)
        .max(DEFAULT_RECALL_MAX_CHARS)
        .optional()
        .describe('Optional cap on the returned slice. Defaults to 30000.'),
    },
    async (input: Record<string, unknown>) => {
      const callId = String(input.call_id ?? '');
      const maxChars = Number.isFinite(input.max_chars as number)
        ? Math.min(DEFAULT_RECALL_MAX_CHARS, Math.max(100, Math.trunc(input.max_chars as number)))
        : DEFAULT_RECALL_MAX_CHARS;
      const offset = Number.isFinite(input.offset as number)
        ? Math.max(0, Math.trunc(input.offset as number))
        : 0;

      const ctx = harnessRunContextStorage.getStore();
      if (!ctx?.sessionId) {
        return textResult(
          'recall_tool_result is only available within a harness-managed turn. (No active session context.)',
        );
      }

      const row = getToolOutput(ctx.sessionId, callId);
      if (!row) {
        return textResult(
          `No tool output found for call_id "${callId}" in this session. Check the [clipped: ...] stub for the correct call_id, or proceed with the summary.`,
        );
      }

      // Slice [offset, offset+maxChars) so a payload bigger than one slice can be
      // paged across calls, and account for actual returned bytes.
      const total = row.output.length;
      const start = Math.min(offset, total);
      const slice = row.output.slice(start, start + maxChars);
      const sliceBytes = Buffer.byteLength(slice, 'utf8');

      // Budget check — only when a HarnessRunContext provided one.
      if (ctx.recallBudget) {
        const err = ctx.recallBudget.consume(sliceBytes);
        if (err) return textResult(err);
      }

      const end = start + slice.length;
      const header = [
        `Recalled chars ${start}–${end} of ${total} (${row.contentBytes} total bytes)`,
        row.tool ? `tool=${row.tool}` : null,
        `recorded at ${row.createdAt}`,
        row.truncatedAtWrite
          ? `⚠ original was tail-truncated at write-time (${Math.round(TOOL_OUTPUT_MAX_BYTES / 1_000_000)}MB cap)`
          : null,
        end < total
          ? `(more remains — call again with offset: ${end} to continue)`
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
      'Query a slice of a large prior tool output by its call_id, without loading the whole payload.',
      'Use after you see a `[digest: … tool_output_query("call_xxx", …)]` footer (or a `[clipped: …]` stub) and you need specific records the digest did not show.',
      'This reader is ALWAYS available inside a turn — the full result is parked losslessly. Never claim the data is unavailable, the reader "isn\'t exposed", or that the call is still pending; call this to pull exactly the rows/fields you need.',
      'For a JSON array result: filter rows, project fields, and paginate. For a JSON object: project top-level keys. Returns compact JSON plus a "showing X of N" header.',
    ].join(' '),
    {
      call_id: z.string().min(1).describe('The call_id from the digest/clip footer, e.g. "call_abc123".'),
      fields: z.array(z.string()).optional().describe('Only include these keys from each record/object (projection). Omit for all fields.'),
      filter_field: z.string().optional().describe('Keep only records where this field matches filter_contains/filter_equals.'),
      filter_contains: z.string().optional().describe('Substring match (case-insensitive) for filter_field.'),
      filter_equals: z.string().optional().describe('Exact match for filter_field.'),
      offset: z.number().int().min(0).optional().describe('Skip this many matching records (default 0).'),
      limit: z.number().int().min(1).max(200).optional().describe('Return at most this many records (default 50).'),
    },
    async (input: Record<string, unknown>) => {
      const callId = String(input.call_id ?? '');
      const ctx = harnessRunContextStorage.getStore();
      if (!ctx?.sessionId) {
        return textResult('tool_output_query is only available within a harness-managed turn. (No active session context.)');
      }
      const row = getToolOutput(ctx.sessionId, callId);
      if (!row) {
        return textResult(`No tool output found for call_id "${callId}" in this session.`);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(row.output); } catch {
        // Very common footgun: the parked output is a run_shell_command wrapper
        // (`exit_code:/stdout:/stderr:`) around a `--json` payload (sf, gh, aws…),
        // so a whole-string JSON.parse fails even though the data IS structured.
        // Extract and query the embedded stdout JSON instead of bouncing to
        // recall_tool_result — which returns raw text the model must re-parse,
        // the exact slow path that turned a Salesforce team pull into a
        // multi-turn detour.
        const shell = parseShellToolOutput(row.output);
        if (shell?.stdout_json !== undefined) {
          parsed = shell.stdout_json;
        } else {
          return textResult(`Tool output "${callId}" is not JSON — use recall_tool_result to read it as text.`);
        }
      }

      const fields = Array.isArray(input.fields) ? (input.fields as string[]) : undefined;
      const project = (rec: unknown): unknown => {
        if (!fields || !rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
        const out: Record<string, unknown> = {};
        for (const f of fields) if (f in (rec as Record<string, unknown>)) out[f] = (rec as Record<string, unknown>)[f];
        return out;
      };

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
        const offset = Number.isFinite(input.offset as number) ? Math.max(0, Math.trunc(input.offset as number)) : 0;
        const limit = Number.isFinite(input.limit as number) ? Math.min(200, Math.max(1, Math.trunc(input.limit as number))) : 50;
        const page = rows.slice(offset, offset + limit).map(project);
        const header = `Showing ${page.length} record(s) [${offset}–${offset + page.length}] of ${matched} matching (${(parsed as unknown[]).length} total)`;
        // Hand the model the EXACT, copy-paste reference for these values, so a
        // downstream send binds them by reference instead of retyping (which is
        // how a value gets invented or dropped). Root array + single projected
        // field → a precise path.
        const refPath = fields && fields.length === 1 ? `[*].${fields[0]}` : '[*]';
        const refHint = `\n\n[grounded reference] To use these EXACT values in a later send/write WITHOUT retyping them, pass this as the field value: {"$fromToolOutput":{"callId":"${callId}","path":"${refPath}"}} — the harness binds the real values before the call (fabrication-proof; a bad reference fails closed).`;
        const bodyText = clipQueryBody(`${header}\n\n${JSON.stringify(page, null, 1)}`) + refHint;
        return textResult(bodyText, { maxChars: bodyText.length });
      }

      if (parsed && typeof parsed === 'object') {
        const projected = project(parsed);
        const refHint = `\n\n[grounded reference] To reuse values from this result in a later send/write WITHOUT retyping, reference them: {"$fromToolOutput":{"callId":"${callId}","path":"<path to the values, e.g. result.records[*].Email>"}} — the harness binds the real values before the call.`;
        const bodyText = clipQueryBody(`Object (${Object.keys(parsed as object).length} top-level keys)\n\n${JSON.stringify(projected, null, 1)}`) + refHint;
        return textResult(bodyText, { maxChars: bodyText.length });
      }

      return textResult(`Tool output "${callId}" is a scalar: ${JSON.stringify(parsed)}`);
    },
  );
}
