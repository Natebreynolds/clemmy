import path from 'node:path';
import pino from 'pino';
import { openMemoryDb } from './db.js';
import type { MemorySearchHit } from '../types.js';

/**
 * Hybrid recall over the vault index.
 *
 * Day-one behavior:
 * - Run an FTS5 MATCH with BM25 ranking. Returns top-k chunks.
 *
 * Designed for: when embeddings land, recall() runs FTS to get a candidate
 * pool of ~3k, then reranks with cosine similarity and merges the two
 * orderings via reciprocal rank fusion. The public signature stays the same.
 *
 * Return shape mirrors `MemorySearchHit` so `formatSearchHits` and any
 * existing callers (vault-tools, prompt assembly) keep working unchanged.
 */

const logger = pino({ name: 'clementine-next.memory.recall' });

interface RecallChunkRow {
  id: number;
  path: string;
  title: string | null;
  content: string;
  rank: number;
  snip: string;
}

/**
 * Escape a free-text query for FTS5 MATCH.
 *
 * FTS5 has a tokenizer-level query syntax with reserved characters (* " ( )
 * AND OR NOT NEAR :). For agent-facing recall we don't want users to think
 * about that — we tokenize the query ourselves and rebuild it as a safe
 * OR of quoted terms, plus a prefix-match variant for short tokens so
 * partial words still hit ("clem" → matches "clementine").
 */
export function buildFtsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  if (tokens.length === 0) return '';

  const unique = Array.from(new Set(tokens));
  // Quote each token (FTS5 phrase) and add a prefix variant. OR them together.
  const clauses = unique.map((token) => {
    const safe = token.replace(/"/g, '');
    return `"${safe}" OR ${safe}*`;
  });
  return clauses.join(' OR ');
}

function deriveTitle(row: RecallChunkRow): string {
  if (row.title && row.title.trim()) return row.title.trim();
  return path.basename(row.path, '.md');
}

export interface RecallOptions {
  /** Maximum hits to return. */
  limit?: number;
  /** Optional path prefix filter (e.g. only /vault/02-People). */
  pathPrefix?: string;
}

/**
 * Recall the top-k most relevant vault chunks for a query.
 *
 * Returns [] when the DB is empty (e.g. indexer hasn't run yet) or the
 * query produces no tokens after cleanup — callers can fall back to the
 * legacy `searchVault` path on empty results.
 */
export function recall(query: string, options: RecallOptions = {}): MemorySearchHit[] {
  const limit = Math.max(1, options.limit ?? 6);
  const fts = buildFtsQuery(query);
  if (!fts) return [];

  const db = openMemoryDb();

  let sql = `
    SELECT
      vc.id     AS id,
      vc.path   AS path,
      vc.title  AS title,
      vc.content AS content,
      bm25(vault_chunks_fts) AS rank,
      snippet(vault_chunks_fts, 0, '[', ']', ' … ', 12) AS snip
    FROM vault_chunks_fts
    JOIN vault_chunks vc ON vc.id = vault_chunks_fts.rowid
    WHERE vault_chunks_fts MATCH ?
  `;
  const params: unknown[] = [fts];

  if (options.pathPrefix) {
    sql += ' AND vc.path LIKE ?';
    params.push(`${options.pathPrefix}%`);
  }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);

  let rows: RecallChunkRow[] = [];
  try {
    rows = db.prepare(sql).all(...params) as RecallChunkRow[];
  } catch (err) {
    logger.warn({ err, query }, 'fts query failed');
    return [];
  }

  // BM25 returns negative scores in SQLite (lower = better). Normalize to a
  // positive 0..1-ish score so it composes with the legacy `searchVault`
  // scale that callers may already have UI for.
  if (rows.length === 0) return [];

  const ranks = rows.map((r) => r.rank);
  const best = Math.min(...ranks);
  const worst = Math.max(...ranks);
  const spread = Math.max(0.0001, worst - best);

  return rows.map((row) => {
    const normalized = 1 - (row.rank - best) / spread; // 1 = best, → 0 = worst
    return {
      filePath: row.path,
      title: deriveTitle(row),
      snippet: row.snip || row.content.slice(0, 240).replace(/\s+/g, ' '),
      score: Number((normalized * 10).toFixed(3)), // keep order-of-magnitude similar to scoreContent
    } satisfies MemorySearchHit;
  });
}

/**
 * Count indexed chunks. Used by `searchVault` to decide whether the DB has
 * any data to recall from yet.
 */
export function recallIndexSize(): number {
  try {
    const db = openMemoryDb();
    const row = db.prepare('SELECT COUNT(*) AS c FROM vault_chunks').get() as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}
