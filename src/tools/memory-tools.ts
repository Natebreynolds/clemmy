import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatSearchHits, searchVaultAsync } from '../memory/search.js';
import { recallHybrid } from '../memory/recall.js';
import { embedMissingChunks, isEmbeddingsEnabled, readEmbeddingStats } from '../memory/embeddings.js';
import { FACT_KINDS, forgetFact, listActiveFacts, listAllFacts, rememberFact } from '../memory/facts.js';
import { WORKING_MEMORY_FILE } from '../memory/vault.js';
import { readText, replaceFile, resolveMemoryTarget, textResult } from './shared.js';

export function registerMemoryTools(server: McpServer): void {
  server.tool(
    'memory_search',
    'Search the local Clementine vault for relevant notes and memories. Uses FTS5 and (when OPENAI_API_KEY is set) an embedding rerank.',
    { query: z.string().min(1) },
    async ({ query }) => {
      const hits = await searchVaultAsync(query, 8);
      const text = hits.length > 0 ? formatSearchHits(hits, 3000) : 'No relevant memory hits found.';
      return textResult(text);
    },
  );

  server.tool(
    'memory_read',
    'Read a key memory file or a vault-relative markdown path.',
    { target: z.string().min(1) },
    async ({ target }) => {
      const resolved = resolveMemoryTarget(target);
      return textResult(readText(resolved, `Not found: ${target}`));
    },
  );

  server.tool(
    'working_memory',
    'Read, append, replace, or clear the working-memory scratchpad.',
    {
      action: z.enum(['read', 'append', 'replace', 'clear']),
      content: z.string().optional(),
    },
    async ({ action, content }) => {
      if (action === 'read') {
        const text = existsSync(WORKING_MEMORY_FILE)
          ? readFileSync(WORKING_MEMORY_FILE, 'utf-8')
          : 'Working memory is empty.';
        return textResult(text);
      }

      if (action === 'clear') {
        if (existsSync(WORKING_MEMORY_FILE)) {
          unlinkSync(WORKING_MEMORY_FILE);
        }
        return textResult('Working memory cleared.');
      }

      if (!content) {
        return textResult(`Missing content for ${action} action.`);
      }

      if (action === 'append') {
        const existing = existsSync(WORKING_MEMORY_FILE) ? readFileSync(WORKING_MEMORY_FILE, 'utf-8').trimEnd() : '';
        const next = existing ? `${existing}\n${content.trim()}` : content.trim();
        replaceFile(WORKING_MEMORY_FILE, next);
        return textResult('Working memory updated.');
      }

      writeFileSync(WORKING_MEMORY_FILE, `${content.trim()}\n`, 'utf-8');
      return textResult('Working memory replaced.');
    },
  );

  // ---------------------------------------------------------------------
  // SQLite-backed memory: FTS recall + durable facts.
  // ---------------------------------------------------------------------

  server.tool(
    'memory_recall',
    'Recall vault chunks. FTS5 narrows the pool; with an OPENAI_API_KEY an embedding rerank reorders via reciprocal rank fusion. Supports limit and pathPrefix filters.',
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
      pathPrefix: z.string().optional(),
    },
    async ({ query, limit, pathPrefix }) => {
      const hits = await recallHybrid(query, { limit: limit ?? 6, pathPrefix });
      if (hits.length === 0) {
        return textResult('No vault hits.');
      }
      return textResult(formatSearchHits(hits, 3000));
    },
  );

  server.tool(
    'memory_embed_backfill',
    'Compute embeddings for vault chunks that don\'t have one yet. Runs in small batches; safe to invoke repeatedly. No-ops when OPENAI_API_KEY is not set.',
    {
      maxChunks: z.number().int().min(1).max(2000).optional(),
    },
    async ({ maxChunks }) => {
      if (!isEmbeddingsEnabled()) {
        return textResult('Embeddings disabled (OPENAI_API_KEY not set).');
      }
      const stats = await embedMissingChunks({ maxChunks: maxChunks ?? 200 });
      const embStats = readEmbeddingStats();
      return textResult([
        `Embedded ${stats.embedded} / ${stats.candidateChunks} candidate chunks in ${stats.durationMs}ms`,
        `Batches: ${stats.batched}, failures: ${stats.failed}`,
        `Total embeddings: ${embStats.count} (${embStats.model ?? '-'}, dim ${embStats.dim ?? '-'})`,
      ].join('\n'));
    },
  );

  server.tool(
    'memory_remember',
    'Record a durable fact in long-term memory. Use for user preferences (kind=user), project context (project), standing feedback (feedback), or external references (reference). Idempotent — re-recording the same fact bumps its score.',
    {
      kind: z.enum(FACT_KINDS as unknown as [string, ...string[]]),
      content: z.string().min(3).max(800),
      sessionId: z.string().optional(),
      sourcePath: z.string().optional(),
    },
    async ({ kind, content, sessionId, sourcePath }) => {
      try {
        const fact = rememberFact({
          kind: kind as (typeof FACT_KINDS)[number],
          content,
          sessionId,
          path: sourcePath,
        });
        return textResult(`Remembered #${fact.id} (${fact.kind}, score ${fact.score.toFixed(2)}): ${fact.content}`);
      } catch (err) {
        return textResult(`memory_remember failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'memory_list_facts',
    'List durable facts. Defaults to top active facts by score; set includeInactive=true to see soft-deleted history.',
    {
      kind: z.enum(FACT_KINDS as unknown as [string, ...string[]]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      includeInactive: z.boolean().optional(),
    },
    async ({ kind, limit, includeInactive }) => {
      const facts = includeInactive
        ? listAllFacts(limit ?? 25).filter((fact) => !kind || fact.kind === kind)
        : listActiveFacts({
            limit: limit ?? 25,
            kind: kind as (typeof FACT_KINDS)[number] | undefined,
          });

      if (facts.length === 0) return textResult('No facts recorded yet.');

      const lines = facts.map((fact) => {
        const flag = fact.active ? '' : ' [inactive]';
        return `- #${fact.id} ${fact.kind} (${fact.score.toFixed(2)})${flag}: ${fact.content}`;
      });
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'memory_forget',
    'Soft-delete a fact by id (sets active=0). Pass hard=true to drop the row entirely.',
    {
      id: z.number().int().positive(),
      hard: z.boolean().optional(),
    },
    async ({ id, hard }) => {
      const ok = forgetFact(id, { hard });
      return textResult(ok ? `Forgot fact #${id}${hard ? ' (hard delete)' : ''}.` : `No fact found with id ${id}.`);
    },
  );
}
