/**
 * file_query tool (2026-07-21) — make a big document/tool-result QUERYABLE
 * instead of byte-clipped. Sources: a local file (PDF/DOCX/etc convert via
 * markitdown automatically), or a prior tool call's lossless parked output.
 * Deterministic retrieval (file-query-core.ts): no model call, no network.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveToolOutputForAuthority } from '../runtime/harness/eventlog.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { convertToMarkdown, isConvertibleExtension } from '../runtime/markitdown.js';
import { textResult } from './shared.js';
import { chunkText, scoreChunks } from './file-query-core.js';

const MAX_TEXT_BYTES = 50 * 1024 * 1024;

export function registerFileQueryTools(server: McpServer): void {
  server.tool(
    'file_query',
    [
      'Ask a question against a BIG document or a prior tool result and get back only the most relevant passages — instead of reading a byte-clipped preview. Deterministic retrieval (no model call): heading-aware chunks ranked by term relevance.',
      'Sources (pass exactly one): `file` — a local path; PDFs/DOCX/PPTX/etc are converted to text automatically; or `call_id` — a prior tool call whose lossless parked output is searched even though your model-visible copy was clipped. A provider result that exceeded the durable cap fails closed; page/re-read it or stage the full result as a file.',
      'Use for: "what does the 200-page agreement say about termination", "find the rows mentioning refunds in that big export", "which section covers X".',
    ].join(' '),
    {
      query: z.string().min(2).describe('What to find — a question or key phrase.'),
      file: z.string().optional(),
      call_id: z.string().optional(),
      top_k: z.number().int().min(1).max(20).optional().describe('How many passages (default 5).'),
    },
    async ({ query, file, call_id, top_k }) => {
      try {
        const sources = [file, call_id].filter((v) => v && v.trim());
        if (sources.length !== 1) return textResult('ERROR: pass exactly ONE of `file` / `call_id`.');
        let text: string;
        let label: string;
        if (file?.trim()) {
          const filePath = path.resolve(file.trim());
          const stat = statSync(filePath);
          if (stat.size > MAX_TEXT_BYTES) return textResult(`ERROR: file is ${Math.round(stat.size / 1024 / 1024)}MB (cap 50MB).`);
          if (isConvertibleExtension(filePath)) {
            const converted = await convertToMarkdown(filePath);
            if (!converted.ok) return textResult(`ERROR: could not extract text from ${path.basename(filePath)}: ${converted.error}`);
            text = converted.markdown;
          } else {
            text = readFileSync(filePath, 'utf-8');
          }
          label = path.basename(filePath);
        } else {
          const sessionId = getToolOutputContext()?.sessionId;
          if (!sessionId) return textResult('ERROR: call_id needs a live session context — pass `file` instead.');
          const resolution = resolveToolOutputForAuthority(sessionId, call_id!.trim());
          if (resolution.status === 'ambiguous') return textResult(`ERROR: call id "${call_id}" was reused by ${resolution.invocationCount} invocations; pass a fresh unique call id.`);
          if (resolution.status === 'missing') return textResult(`ERROR: no stored output for call id "${call_id}" in this session.`);
          if (resolution.status === 'failed') return textResult(`ERROR: stored output for call id "${call_id}" cannot be used because ${resolution.reason}. Re-run the source read.`);
          if (resolution.record.truncatedAtWrite) {
            return textResult(
              `ERROR: stored output for call id "${call_id}" is incomplete (${resolution.record.contentBytes} original bytes exceeded the durable output cap), so file_query will not report matches or misses from a prefix. `
              + 'Re-read/page the provider source until every page is present, or stage the full result as a file and query that file.',
            );
          }
          text = resolution.record.output;
          label = `tool output ${call_id}`;
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
        return textResult(`ERROR: file_query failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
