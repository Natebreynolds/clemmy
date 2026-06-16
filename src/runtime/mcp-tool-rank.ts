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
 *  - Reuses the existing embedding infra (embedQuery/embedTexts/cosine).
 *  - GRACEFUL: returns undefined whenever embeddings are off/unhealthy or the
 *    flag is disabled, so the filter falls straight back to keyword/index order
 *    (zero behavior change). Never throws.
 *  - Tool vectors are cached in-memory by a content hash (daemon lifetime); only
 *    new/changed tools are embedded, and only on fail-open turns.
 *  - Run-start only (the agent's tool surface is immutable per run); applied to
 *    the fail-open path, whose shim wraps the shared base fresh per query.
 *
 * Kill-switch: CLEMMY_MCP_SEMANTIC_RANK=off restores the prior keyword-only
 * fail-open ranking.
 */
import type { MCPServer } from '@openai/agents';
import { createHash } from 'node:crypto';
import pino from 'pino';
import { cosine, embedQuery, embedTexts, isEmbeddingsEnabled } from '../memory/embeddings.js';
import { toolHaystack } from './mcp-tool-filter.js';

const logger = pino({ name: 'clementine-next.mcp-tool-rank' });

type MCPTool = Awaited<ReturnType<MCPServer['listTools']>>[number];

export function semanticToolRankEnabled(): boolean {
  return (process.env.CLEMMY_MCP_SEMANTIC_RANK ?? 'on').toLowerCase() !== 'off';
}

// Tool text → vector, keyed by a content hash so a changed description re-embeds.
// Daemon-lifetime; rebuilt cheaply on restart.
const toolVecCache = new Map<string, Float32Array>();

// Tiny TTL cache for the per-turn query vector so a shim whose listTools() is
// called more than once in a run doesn't re-embed the same query.
const QUERY_TTL_MS = 60_000;
let queryCache: { key: string; vec: Float32Array | null; at: number } | null = null;

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

async function getQueryVector(query: string, now: number): Promise<Float32Array | null> {
  if (queryCache && queryCache.key === query && now - queryCache.at < QUERY_TTL_MS) {
    return queryCache.vec;
  }
  const vec = await embedQuery(query);
  queryCache = { key: query, vec, at: now };
  return vec;
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
    const queryVec = await getQueryVector(query, now);
    if (!queryVec) return undefined;

    // Embed any tools we haven't seen before (one batched call).
    const entries = tools.map((tool) => ({ tool, text: toolHaystack(tool), hash: '' }));
    for (const e of entries) e.hash = hashText(e.text);
    const missing = entries.filter((e) => !toolVecCache.has(e.hash));
    if (missing.length > 0) {
      const vectors = await embedTexts(missing.map((e) => e.text));
      if (!vectors) return undefined; // embeddings unhealthy → fall back to keyword
      missing.forEach((e, i) => {
        const v = vectors[i];
        if (v) toolVecCache.set(e.hash, v);
      });
    }

    const scores = new Map<string, number>();
    for (const e of entries) {
      const vec = toolVecCache.get(e.hash);
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
  toolVecCache.clear();
  queryCache = null;
}
