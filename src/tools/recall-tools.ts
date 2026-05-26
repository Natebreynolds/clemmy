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
      'Use this ONLY when you see `[clipped: ... call recall_tool_result("call_xxx") for full output]` in the conversation AND the summary lacks a specific detail you need (URLs, IDs, exact figures, ranking positions, etc.).',
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
}
