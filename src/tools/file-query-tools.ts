/**
 * file_query tool (2026-07-21) — make a big document/tool-result QUERYABLE
 * instead of byte-clipped. Sources: a local file (PDF/DOCX/etc convert via
 * markitdown automatically), or a prior tool call's lossless parked output.
 * Deterministic retrieval (file-query-core.ts): no model call, no network.
 */

import { retainedResultWayThrough } from '../runtime/harness/retained-result-routes.js';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveToolOutputForAuthority } from '../runtime/harness/eventlog.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { convertToMarkdown, isConvertibleExtension } from '../runtime/markitdown.js';
import { invalidArgumentsTextResult, textResult } from './shared.js';
import { chunkText, scoreChunks } from './file-query-core.js';

const MAX_TEXT_BYTES = 50 * 1024 * 1024;

/**
 * Strict tool schemas represent an optional string as string | null. Some
 * compatible models textualize that unused null as the literal string
 * `"null"`. Reserve only that bare token as absence; real paths such as
 * `./null` and call ids containing the word remain ordinary sources.
 */
function optionalSource(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return !trimmed || trimmed.toLowerCase() === 'null' ? null : trimmed;
}

export function registerFileQueryTools(server: McpServer): void {
  server.tool(
    'file_query',
    [
      'Get only the most relevant passages of a BIG document or prior tool result instead of a byte-clipped preview (deterministic heading-aware retrieval, no model call).',
      'Pass exactly one source: `file` (a local path; PDF/DOCX/PPTX are converted automatically) or `call_id` (the lossless parked output of a prior call). A truncated or corrupt stored result fails closed.',
    ].join(' '),
    {
      query: z.string().min(2).describe('A question or key phrase.'),
      file: z.string().optional(),
      call_id: z.string().optional(),
      top_k: z.number().int().min(1).max(20).optional().describe('Passages to return (default 5).'),
    },
    async ({ query, file, call_id, top_k }) => {
      try {
        const fileSource = optionalSource(file);
        const callIdSource = optionalSource(call_id);
        if ((fileSource === null) === (callIdSource === null)) {
          return invalidArgumentsTextResult('ERROR: pass exactly ONE of `file` / `call_id`.');
        }
        let text: string;
        let label: string;
        if (fileSource !== null) {
          const filePath = path.resolve(fileSource);
          const stat = statSync(filePath);
          if (stat.size > MAX_TEXT_BYTES) return invalidArgumentsTextResult(`ERROR: file is ${Math.round(stat.size / 1024 / 1024)}MB (cap 50MB).`);
          if (isConvertibleExtension(filePath)) {
            const converted = await convertToMarkdown(filePath);
            if (!converted.ok) return invalidArgumentsTextResult(`ERROR: could not extract text from ${path.basename(filePath)}: ${converted.error}`);
            text = converted.markdown;
          } else {
            text = readFileSync(filePath, 'utf-8');
          }
          label = path.basename(filePath);
        } else {
          const sessionId = getToolOutputContext()?.sessionId;
          if (!sessionId) return invalidArgumentsTextResult('ERROR: call_id needs a live session context — pass `file` instead.');
          const resolution = resolveToolOutputForAuthority(sessionId, callIdSource!);
          if (resolution.status === 'ambiguous') return invalidArgumentsTextResult(`ERROR: call id "${callIdSource}" was reused by ${resolution.invocationCount} invocations; pass a fresh unique call id.`);
          if (resolution.status === 'missing') return invalidArgumentsTextResult(`ERROR: no stored output for call id "${callIdSource}" in this session.`);
          if (resolution.status === 'failed') {
            // "Re-run the source read" is not actionable for a derived,
            // presentation-only reader, and it throws away outputs the host is
            // still holding. Live 2026-09-07 source 148101 looped here. Name
            // the authentic retained evidence instead.
            const wayThrough = retainedResultWayThrough({
              sessionId, callId: callIdSource!, exclude: ['file_query'],
            });
            return invalidArgumentsTextResult(
              `ERROR: stored output for call id "${callIdSource}" cannot be used because ${resolution.reason}. ${wayThrough}`,
            );
          }
          if (resolution.record.truncatedAtWrite) {
            return invalidArgumentsTextResult(
              `ERROR: stored output for call id "${callIdSource}" is incomplete (${resolution.record.contentBytes} original bytes; legacy truncation or missing/corrupt chunks), so file_query will not report matches or misses from a prefix. `
              + 'Re-read/page the provider source until every page is present, or stage the full result as a file and query that file.',
            );
          }
          text = resolution.record.output;
          label = `tool output ${callIdSource}`;
        }

        const chunks = chunkText(text);
        const hits = scoreChunks(chunks, query, top_k ?? 5);
        if (hits.length === 0) {
          return textResult(JSON.stringify({
            source: label, totalChunks: chunks.length, hits: [],
            note: 'No passage matched the query terms. Try different words (retrieval is lexical), or read the document structure first.',
          }));
        }
        return textResult(JSON.stringify({
          source: label,
          totalChunks: chunks.length,
          hits: hits.map((h) => ({
            chunk: h.index + 1,
            of: chunks.length,
            heading: h.heading,
            score: Number(h.score.toFixed(2)),
            text: h.text.slice(0, 2000),
          })),
        }, null, 1));
      } catch (err) {
        return invalidArgumentsTextResult(`ERROR: file_query failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
