import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getToolOutput } from '../runtime/harness/eventlog.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { textResult } from './shared.js';

/**
 * recall_tool_result — retrieve the verbatim output of a prior tool
 * call when auto-compact (Layer 1) has clipped it from the conversation.
 *
 * Lossless fetch from the `tool_outputs` table (populated at write-time
 * in hooks.ts with up to 200KB of original output, before the
 * event-log copy is clipped to 8KB).
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

export function registerRecallTools(server: McpServer): void {
  server.tool(
    'recall_tool_result',
    [
      'Retrieve the full verbatim output of a prior tool call by its call_id.',
      'Use this whenever the conversation shows a `[clipped: …]` stub OR a `[digest: …]` footer carrying a call_id and you need a detail the shortened view dropped (URLs, IDs, exact figures, ranking positions, full records, etc.).',
      'This reader is ALWAYS available to you inside a turn — the full payload is stored losslessly. Never tell the user the data is unavailable, that the reader "isn\'t exposed", or that a completed call is still pending: call this instead.',
      'Returns up to 30KB of original output. Counts against a per-turn budget of 3 calls / 60KB total — use sparingly.',
    ].join(' '),
    {
      call_id: z
        .string()
        .min(1)
        .describe('The call_id from the [clipped: ...] stub. Looks like "call_abc123".'),
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

      // Slice the result to maxChars and account for actual returned bytes.
      const slice = row.output.length > maxChars ? row.output.slice(0, maxChars) : row.output;
      const sliceBytes = Buffer.byteLength(slice, 'utf8');

      // Budget check — only when a HarnessRunContext provided one.
      if (ctx.recallBudget) {
        const err = ctx.recallBudget.consume(sliceBytes);
        if (err) return textResult(err);
      }

      const header = [
        `Recalled ${slice.length} chars (of ${row.contentBytes} total bytes)`,
        row.tool ? `tool=${row.tool}` : null,
        `recorded at ${row.createdAt}`,
        row.truncatedAtWrite ? '⚠ original was tail-truncated at write-time (200KB cap)' : null,
        slice.length < row.output.length
          ? `(showing first ${maxChars} chars; pass max_chars to widen up to 30000)`
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
        return textResult(`Tool output "${callId}" is not JSON — use recall_tool_result to read it as text.`);
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
        const bodyText = `${header}\n\n${JSON.stringify(page, null, 1)}`;
        return textResult(bodyText, { maxChars: bodyText.length });
      }

      if (parsed && typeof parsed === 'object') {
        const projected = project(parsed);
        const bodyText = `Object (${Object.keys(parsed as object).length} top-level keys)\n\n${JSON.stringify(projected, null, 1)}`;
        return textResult(bodyText, { maxChars: bodyText.length });
      }

      return textResult(`Tool output "${callId}" is a scalar: ${JSON.stringify(parsed)}`);
    },
  );
}
