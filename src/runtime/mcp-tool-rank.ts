/**
 * T1 — semantic tool retrieval (Tool-RAG) for the fail-open MCP surface.
 *
 * When an intent matches no keyword family, the scope falls open to "the user's
 * connected servers, capped at N" — and the filter, having no keywords, picks an
 * effectively ARBITRARY N (first-by-index). This module turns that into the N
 * MOST RELEVANT tools: embed the user's query + each candidate tool's text, and
 * return a cosine-relevance map the filter blends into its ranking.
 *
 * Design constraints honored:
 *  - Reuses the existing embedding infra with actual-producer provenance.
 *  - GRACEFUL: returns undefined whenever embeddings are off/unhealthy or the
 *    flag is disabled, so the filter falls straight back to keyword/index order
 *    (zero behavior change). Never throws.
 *  - Tool vectors are cached by producer space + content hash; only new/changed
 *    tools are embedded, and only on fail-open turns.
 *  - Run-start only (the agent's tool surface is immutable per run); applied to
 *    the fail-open path, whose shim wraps the shared base fresh per query.
 *
 * Kill-switch: CLEMMY_MCP_SEMANTIC_RANK=off restores the prior keyword-only
 * fail-open ranking.
 */
import type { MCPServer } from '@openai/agents';
import { createHash } from 'node:crypto';
import pino from 'pino';
import {
  cosine,
  embeddingSelectionRevision,
  embedQueryWithSpace,
  embedTextsWithSpace,
  isEmbeddingsEnabled,
} from '../memory/embeddings.js';
import { toolHaystack } from './mcp-tool-filter.js';

const logger = pino({ name: 'clementine-next.mcp-tool-rank' });

type MCPTool = Awaited<ReturnType<MCPServer['listTools']>>[number];

export function semanticToolRankEnabled(): boolean {
  return (process.env.CLEMMY_MCP_SEMANTIC_RANK ?? 'on').toLowerCase() !== 'off';
}

type QueryEmbedding = NonNullable<Awaited<ReturnType<typeof embedQueryWithSpace>>>;

// Space + tool text → vector. Equal dimensions alone do not establish equal
// geometry: another provider/model must never reuse these document vectors.
const toolVecCache = new Map<string, Float32Array>();

// Tiny TTL cache for the per-turn query vector so a shim whose listTools() is
// called more than once in a run doesn't re-embed the same query.
const QUERY_TTL_MS = 60_000;
let queryCache: { key: string; result: QueryEmbedding; selectionRevision: string; at: number } | null = null;
// A clear during an await must not be undone when the old operation completes.
let cacheGeneration = 0;

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

async function getQueryVector(
  query: string,
  now: number,
  selectionRevision: string,
  isCurrent: () => boolean,
): Promise<QueryEmbedding | null> {
  if (queryCache && queryCache.key === query && queryCache.selectionRevision === selectionRevision
    && now - queryCache.at < QUERY_TTL_MS) {
    return queryCache.result;
  }
  const result = await embedQueryWithSpace(query);
  if (!isCurrent()) return null;
  // Keep the full result: its opaque lease binds any missing documents to the
  // producer that actually rescued the query, rather than retrying its failure.
  if (result) queryCache = { key: query, result, selectionRevision, at: now };
  return result;
}

/**
 * Rank candidate MCP tools by semantic relevance to the user's query.
 * Returns a Map(toolName → cosine in [0,1]) the filter blends into scoreTool,
 * or `undefined` to signal "no semantic signal — use the existing ranking".
 *
 * @param now injectable clock for tests (defaults to Date.now()).
 */
export async function rankToolsBySemantic(
  queryText: string | undefined | null,
  tools: MCPTool[],
  now: number = Date.now(),
): Promise<Map<string, number> | undefined> {
  if (!semanticToolRankEnabled()) return undefined;
  const query = (queryText ?? '').trim();
  if (!query || tools.length === 0) return undefined;
  if (!isEmbeddingsEnabled()) return undefined;

  try {
    const selectionRevision = embeddingSelectionRevision();
    const generation = cacheGeneration;
    const isCurrent = () => cacheGeneration === generation
      && embeddingSelectionRevision() === selectionRevision;
    const queryResult = await getQueryVector(query, now, selectionRevision, isCurrent);
    if (!queryResult || !isCurrent()) return undefined;
    const queryVec = queryResult.vector;
    if (queryVec.length !== queryResult.dim) return undefined;

    // Embed any tools we haven't seen before (one batched call).
    const entries = tools.map((tool) => {
      const text = toolHaystack(tool);
      return { tool, text, cacheKey: `${queryResult.spaceKey}\n${hashText(text)}` };
    });
    const missing = entries.filter((e) => !toolVecCache.has(e.cacheKey));
    if (missing.length > 0) {
      const result = await embedTextsWithSpace(missing.map((e) => e.text), { space: queryResult });
      if (!isCurrent() || !result || result.spaceKey !== queryResult.spaceKey
        || result.dim !== queryResult.dim || result.vectors.length !== missing.length
        || result.vectors.some((vector) => vector.length !== queryResult.dim)) return undefined;
      const vectors = result.vectors;
      missing.forEach((e, i) => {
        toolVecCache.set(e.cacheKey, vectors[i]);
      });
    }

    const scores = new Map<string, number>();
    for (const e of entries) {
      const vec = toolVecCache.get(e.cacheKey);
      if (vec) scores.set(e.tool.name, clamp01(cosine(queryVec, vec)));
    }
    return scores.size > 0 ? scores : undefined;
  } catch (err) {
    logger.warn({ err }, 'rankToolsBySemantic failed; falling back to keyword ranking');
    return undefined;
  }
}

/** Test-only: clear the in-memory caches. */
export function _resetToolRankCachesForTest(): void {
  cacheGeneration += 1;
  toolVecCache.clear();
  queryCache = null;
}
