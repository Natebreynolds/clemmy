import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatSearchHits, searchVaultAsync } from '../memory/search.js';
import { recallHybrid } from '../memory/recall.js';
import { embedMissingChunks, isEmbeddingsEnabled, readEmbeddingStats } from '../memory/embeddings.js';
import { FACT_KINDS, forgetFact, getFact, listActiveFacts, listAllFacts, rememberFact, reviewStandingInstructions, searchFacts, setFactPinned, touchFactAccess } from '../memory/facts.js';
import { consolidateFact } from '../memory/reflection.js';
import { upsertResourcePointer, isSourceMapEnabled } from '../memory/source-map.js';
import { getRuntimeEnv } from '../config.js';
import { WORKING_MEMORY_FILE } from '../memory/vault.js';
import { readText, replaceFile, resolveMemoryTarget, textResult } from './shared.js';

// Tier A1 — when CLEMMY_REMEMBER_RECONCILE=on, the agent's explicit
// memory_remember writes route through the Mem0 conflict resolver
// (consolidateFact) instead of blind-appending, so a restated/contradicted
// preference UPDATEs or supersedes the old fact instead of stacking a
// duplicate. Below this cosine bar a candidate is treated as clearly novel
// and ADDed without an LLM resolver call (cost fast-path).
const REMEMBER_NOVELTY_FAST_PATH_SIM = 0.6;

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
        const reconcile = (getRuntimeEnv('CLEMMY_REMEMBER_RECONCILE', 'off') || 'off').toLowerCase() === 'on';
        if (reconcile) {
          // Route through the Mem0 resolver. User-stated facts pass trust
          // 1.0 so they win conflicts against derived (0.6) facts.
          const outcome = await consolidateFact(
            { kind: kind as (typeof FACT_KINDS)[number], text: content, trustLevel: 1.0 },
            { sessionId },
            { noveltyFastPathSim: REMEMBER_NOVELTY_FAST_PATH_SIM },
          );
          const verb = outcome.updated
            ? 'Updated an existing fact'
            : outcome.deleted
              ? 'Superseded the prior fact and recorded'
              : outcome.noop
                ? 'Already known — no change'
                : 'Remembered';
          return textResult(`${verb} (${kind}): ${content}`);
        }
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
    'source_map_upsert',
    'Record WHERE a resource lives in one of the user\'s connected sources — a Drive folder, an Airtable base/table, a CRM object, a mail label/folder — as a navigation POINTER, never its content. Use when you enumerate or discover the STRUCTURE of a connected source (the user asks to "map"/"index" a source, or you list its folders/bases/objects). One call per resource. Pass providerId (the real id from the source, e.g. the Drive folder id) so the pointer dedupes and stays stable; parentRef links it into a tree.',
    {
      app: z.string().min(1),                 // friendly app name, e.g. "Google Drive"
      kind: z.string().min(1),                // folder | file | base | table | object | channel | label
      name: z.string().min(1),
      providerId: z.string().optional(),      // the source's stable id (preferred)
      whatsHere: z.string().optional(),       // one phrase: what this holds
      whenToUse: z.string().optional(),       // when to navigate here
      parentRef: z.string().optional(),       // canonicalRef of the parent (tree)
    },
    async ({ app, kind, name, providerId, whatsHere, whenToUse, parentRef }) => {
      // Writes are gated on the same flag as the reader (renderSourceMapForContext)
      // — otherwise the model could write resource_pointers rows that nothing ever
      // surfaces when the feature is off (silent, invisible accumulation).
      if (!isSourceMapEnabled()) {
        return textResult('source_map_upsert is disabled (CLEMMY_SOURCE_MAP is off) — not recording.');
      }
      try {
        const p = upsertResourcePointer({ app, kind, name, providerId, whatsHere, whenToUse, parentRef, source: 'reactive' });
        return textResult(`Mapped ${p.app} ${p.kind}: ${p.name}`);
      } catch (err) {
        return textResult(`source_map_upsert failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'memory_search_facts',
    'Semantically search durable FACTS (your long-term memory of the user, projects, standing feedback, references) by meaning. Unlike memory_search/memory_recall (which search the vault notes), this queries the consolidated_facts store directly via embeddings — use it to answer "what do I already know about X?" before asking the user or re-deriving. Returns the most relevant facts even when they share no exact words with the query.',
    {
      query: z.string().min(1),
      kind: z.enum(FACT_KINDS as unknown as [string, ...string[]]).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async ({ query, kind, limit }) => {
      const facts = await searchFacts(query, {
        kind: kind as (typeof FACT_KINDS)[number] | undefined,
        topK: limit ?? 8,
      });
      // Refresh the recency anchor for surfaced facts: an on-demand recall is an
      // ACCESS, so bumping last_accessed_at keeps frequently-recalled facts warm
      // for the Stanford recall score (best-effort, never throws).
      for (const fact of facts) touchFactAccess(fact.id);
      if (facts.length === 0) return textResult('No relevant facts found.');
      const lines = facts.map((fact) => `- #${fact.id} ${fact.kind}: ${fact.content}`);
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

  server.tool(
    'memory_pin',
    'Pin a fact as a STANDING INSTRUCTION (always injected into context, exempt from the recency/relevance cap so it never ages out) — or unpin it. Use when the user says "always …", "never …", or "from now on …". Pin sparingly: only durable rules that should hold across every session, not one-off facts.',
    {
      id: z.number().int().positive(),
      pinned: z.boolean().optional(),
    },
    async ({ id, pinned }) => {
      const want = pinned !== false;
      const fact = getFact(id);
      if (!fact) return textResult(`No fact found with id ${id}.`);
      const ok = setFactPinned(id, want);
      return textResult(
        ok
          ? `${want ? 'Pinned' : 'Unpinned'} fact #${id}${want ? ' — it will always be applied' : ''}: ${fact.content}`
          : `Could not update fact #${id}.`,
      );
    },
  );

  server.tool(
    'memory_review_instructions',
    'Before a batch/irreversible external write, review the standing instructions in play. Pass the objective to sort by relevance (least-relevant first, so a possibly off-objective rule is easy to spot). Returns each as "#id [kind, imp N, rel R] content — sourceHint" so you can show the user what you are following and, if one looks stale or wrong for this objective, ask them and then call memory_forget(id). Relevance is a lexical hint, not a verdict — use your judgment, do not auto-delete.',
    {
      objective: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ objective, limit }) => {
      const items = reviewStandingInstructions(objective, { limit: limit ?? 20 });
      if (items.length === 0) return textResult('No standing instructions recorded.');
      const lines = items.map((i) =>
        `- #${i.id} [${i.kind}, imp ${i.importance.toFixed(0)}, rel ${i.relevance.toFixed(2)}${i.pinned ? ', 📌pinned' : ''}] ${i.content} — ${i.sourceHint}`,
      );
      return textResult(
        `Standing instructions in play${objective ? ` (vs objective: ${objective.slice(0, 80)})` : ''}:\n${lines.join('\n')}\n\n` +
        'If any look unrelated or wrong for this objective, ask the user before applying — and offer to memory_forget(id) the stale one.',
      );
    },
  );
}
