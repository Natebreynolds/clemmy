import path from 'node:path';
import pino from 'pino';
import { openMemoryDb } from './db.js';
import {
  bufferToVector,
  cosine,
  embedQuery,
  isEmbeddingsEnabled,
  loadEmbeddingsForChunks,
} from './embeddings.js';
import type { MemorySearchHit } from '../types.js';
import { loadUserProfile } from '../runtime/user-profile.js';

/**
 * Hybrid recall over the vault index.
 *
 * Two entry points:
 *   - recall()        — sync, FTS5 + BM25 only. Snappy, no network.
 *   - recallHybrid()  — async, FTS narrows the candidate pool, then
 *                       cosine similarity against query embedding reranks
 *                       via reciprocal rank fusion. Falls back to FTS
 *                       cleanly when embeddings are disabled or fail.
 *
 * Public signature mirrors MemorySearchHit so `formatSearchHits` and
 * existing callers (vault-tools, prompt assembly) don't change.
 */

const logger = pino({ name: 'clementine-next.memory.recall' });

/** Candidates pulled from FTS before rerank. Larger pool = better
 *  rerank ceiling, but more work and more API tokens spent on the query. */
const RERANK_CANDIDATE_POOL = 40;
/** Reciprocal Rank Fusion constant. 60 is the standard from the IR
 *  literature; small changes here barely move ordering. */
const RRF_K = 60;
/** Bound pure-vector fallback scans so personal vaults stay snappy. */
const SEMANTIC_FALLBACK_MAX_SCAN = 5000;

// Tier D2 — lightweight recall hit-rate telemetry. In-memory, process-local
// (resets on restart) — enough for the dashboard "are recalls finding
// anything?" health signal without a new table or write amplification.
const recallStats = { calls: 0, hits: 0, empties: 0 };

function recordRecall(hitCount: number): void {
  recallStats.calls += 1;
  if (hitCount > 0) recallStats.hits += 1;
  else recallStats.empties += 1;
}

export interface RecallStats {
  calls: number;
  hits: number;
  empties: number;
  hitRate: number; // 0..1; 0 when no calls yet
}

export function getRecallStats(): RecallStats {
  const { calls, hits, empties } = recallStats;
  return { calls, hits, empties, hitRate: calls > 0 ? hits / calls : 0 };
}

interface RecallChunkRow {
  id: number;
  path: string;
  title: string | null;
  content: string;
  rank: number;
  snip: string;
  mtime: number;
}

interface SemanticChunkRow {
  id: number;
  path: string;
  title: string | null;
  content: string;
  vector: Buffer;
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

function deriveTitle(row: Pick<RecallChunkRow, 'title' | 'path'>): string {
  if (row.title && row.title.trim()) return row.title.trim();
  return path.basename(row.path, '.md');
}

export interface RecallOptions {
  /** Maximum hits to return. */
  limit?: number;
  /** Optional path prefix filter (e.g. only /vault/02-People). */
  pathPrefix?: string;
  /**
   * Scope ranking toward this objective string (the active focus blended with
   * the current message). Candidates whose title/content overlaps the objective
   * get a small ADDITIVE bonus, so a freshly-referenced item outranks a stale
   * one with a slightly stronger lexical match. Unset → no effect.
   */
  objective?: string;
  /**
   * Half-life (days) for a gentle recency nudge applied to the fused score.
   * The multiplier is FLOORED at 0.5 — a very old chunk is at most halved, never
   * buried — so this breaks near-ties toward recent without dropping a strong
   * old match. Unset or <= 0 → no recency weighting (ranking byte-identical).
   */
  recencyHalfLifeDays?: number;
  /** Deterministic clock override used by temporal recall and tests. */
  nowMs?: number;
  /** IANA timezone for relative dates such as "today" and "yesterday". */
  timeZone?: string;
}

const MEETING_INTENT_RE = /\b(?:meetings?|calls?|recorded|recording|transcripts?|captured?|capture)\b/i;
const RELATIVE_DATE_RE = /\b(?:today|tonight|yesterday|this\s+(?:morning|afternoon|evening))\b/i;
const IN_PERSON_RE = /\b(?:in\s*-?\s*person|inperson)(?=$|[^a-z0-9])/i;
const GENERIC_MEETING_TITLES = new Set(['summary', 'topics', 'participants', 'capture', 'transcript', 'action items']);

function datePartsAt(ms: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day') };
}

function safeTimeZone(explicit?: string): string {
  const requested = explicit?.trim() || loadUserProfile().timezone?.trim()
    || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: requested }).format(new Date(0));
    return requested;
  } catch {
    return 'UTC';
  }
}

function shiftCalendarDate(parts: { year: number; month: number; day: number }, days: number): string {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return shifted.toISOString().slice(0, 10);
}

/** Resolve the calendar date named by a meeting query in the user's timezone. */
export function resolveTemporalMeetingDate(query: string, options: Pick<RecallOptions, 'nowMs' | 'timeZone'> = {}): string | null {
  if (!MEETING_INTENT_RE.test(query)) return null;
  const explicit = query.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
  if (explicit) return explicit;
  if (!RELATIVE_DATE_RE.test(query)) return null;
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const parts = datePartsAt(nowMs, safeTimeZone(options.timeZone));
  return shiftCalendarDate(parts, /\byesterday\b/i.test(query) ? -1 : 0);
}

export function isTemporalMeetingQuery(query: string): boolean {
  return MEETING_INTENT_RE.test(query)
    && (RELATIVE_DATE_RE.test(query) || /\b20\d{2}-\d{2}-\d{2}\b/.test(query));
}

interface TemporalMeetingChunk {
  path: string;
  title: string | null;
  content: string;
  mtime: number;
}

function frontmatterValue(content: string, key: string): string | undefined {
  return content.match(new RegExp(`^${key}:\\s*(.+)$`, 'im'))?.[1]?.trim();
}

function temporalMeetingHits(query: string, options: RecallOptions, limit: number): MemorySearchHit[] {
  const date = resolveTemporalMeetingDate(query, options);
  if (!date) return [];
  const db = openMemoryDb();
  const params: unknown[] = [`%${date}%`, `%${date}%`];
  let sql = `
    SELECT path, MAX(mtime) AS mtime
    FROM vault_chunks
    WHERE REPLACE(path, '\\', '/') LIKE '%/04-Meetings/%'
      AND (path LIKE ? OR content LIKE ?)
  `;
  if (options.pathPrefix) {
    sql += ' AND path LIKE ?';
    params.push(`${options.pathPrefix}%`);
  }
  sql += ' GROUP BY path ORDER BY mtime DESC LIMIT ?';
  params.push(Math.max(limit, 12));
  const paths = db.prepare(sql).all(...params) as Array<{ path: string; mtime: number }>;
  const load = db.prepare(`
    SELECT path, title, content, mtime
    FROM vault_chunks WHERE path = ? ORDER BY chunk_index ASC
  `);
  const inPersonIntent = IN_PERSON_RE.test(query);
  return paths.map(({ path: filePath, mtime }) => {
    const chunks = load.all(filePath) as TemporalMeetingChunk[];
    const all = chunks.map((chunk) => chunk.content).join('\n');
    const metadata = chunks.find((chunk) => /(?:^|\n)type:\s*meeting-transcript\b/i.test(chunk.content))?.content ?? chunks[0]?.content ?? '';
    const summary = chunks.find((chunk) => chunk.title?.trim().toLowerCase() === 'summary' || /^##\s+Summary\b/im.test(chunk.content));
    const named = chunks.find((chunk) => chunk.title?.trim() && !GENERIC_MEETING_TITLES.has(chunk.title.trim().toLowerCase()));
    const title = frontmatterValue(metadata, 'title') || named?.title?.trim() || deriveTitle({ title: null, path: filePath });
    const startedAt = frontmatterValue(metadata, 'started_at');
    const source = frontmatterValue(metadata, 'source');
    const summaryText = (summary?.content ?? metadata)
      .replace(/^##\s+Summary\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 420);
    const isTranscript = /(?:^|\n)type:\s*meeting-transcript\b/i.test(metadata)
      || /(?:^|\n)(?:recording_id|meeting_id):/im.test(all);
    const label = `${isTranscript ? 'Recorded meeting' : 'Meeting note'} on ${date}`;
    const details = [startedAt ? `started ${startedAt}` : '', source ? `source ${source}` : ''].filter(Boolean).join(' · ');
    return {
      hit: {
        filePath,
        title,
        snippet: `${label}${details ? ` (${details})` : ''}: ${summaryText}`,
        score: 10,
      } satisfies MemorySearchHit,
      occurredMs: Number.isFinite(Date.parse(startedAt ?? '')) ? Date.parse(startedAt!) : mtime,
      inPersonMatch: IN_PERSON_RE.test(`${filePath} ${title} ${all}`),
    };
  })
    // Occurrence time is the temporal truth; mtime is only a fallback for old
    // notes without frontmatter. Explicit in-person wording wins before time.
    .sort((a, b) => (inPersonIntent ? Number(b.inPersonMatch) - Number(a.inPersonMatch) : 0) || b.occurredMs - a.occurredMs)
    .slice(0, limit)
    .map(({ hit }, rank) => ({ ...hit, score: Number((10 - rank * 0.05).toFixed(3)) }));
}

function mergeTemporalMeetingHits(query: string, options: RecallOptions, hits: MemorySearchHit[], limit: number): MemorySearchHit[] {
  const prioritized = temporalMeetingHits(query, options, limit);
  if (prioritized.length === 0) return hits.slice(0, limit);
  const merged = new Map<string, MemorySearchHit>();
  for (const hit of [...prioritized, ...hits]) if (!merged.has(hit.filePath)) merged.set(hit.filePath, hit);
  return Array.from(merged.values()).slice(0, limit);
}

// Recency multiplier floor: an arbitrarily old chunk is demoted to at most this
// fraction of its base score, never to zero. Keeps a strong old match in play.
const RECENCY_FLOOR = 0.5;
// Weight of the additive objective-overlap bonus. ~comparable to a one-rank jump
// at the top of the RRF scale (1/(RRF_K+1) ≈ 0.0164), so it nudges, not dominates.
const OBJECTIVE_BONUS_WEIGHT = 0.012;
const MS_PER_DAY = 86_400_000;

/** True when any scope signal is set — gates the re-rank so the default path
 *  (no objective, no recency) is byte-identical to legacy BM25/RRF ordering. */
function scopeActive(options: RecallOptions): boolean {
  return Boolean(options.objective)
    || (typeof options.recencyHalfLifeDays === 'number' && options.recencyHalfLifeDays > 0);
}

/** Floored exponential recency decay in (RECENCY_FLOOR, 1]. */
function recencyMultiplier(mtime: number | undefined, halfLifeDays?: number): number {
  if (!halfLifeDays || halfLifeDays <= 0 || !mtime || mtime <= 0) return 1;
  const ageDays = Math.max(0, (Date.now() - mtime) / MS_PER_DAY);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * Math.pow(0.5, ageDays / halfLifeDays);
}

function scopeTokens(objective?: string): Set<string> {
  if (!objective) return new Set();
  return new Set(
    objective.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 3),
  );
}

/** Fraction (0..1) of objective tokens that appear in the candidate. */
function objectiveOverlap(tokens: Set<string>, row: RecallChunkRow): number {
  if (tokens.size === 0) return 0;
  const hay = `${row.title ?? ''} ${row.content}`.toLowerCase();
  let hits = 0;
  for (const token of tokens) if (hay.includes(token)) hits += 1;
  return hits / tokens.size;
}

/**
 * Re-rank FTS candidates (already in BM25 order) by a base-position score
 * nudged by recency + objective overlap. No-op (returns the input order) when
 * no scope signal is set, so the default recall path is unchanged.
 */
function reRankByScope(candidates: RecallChunkRow[], options: RecallOptions): RecallChunkRow[] {
  if (!scopeActive(options)) return candidates;
  const tokens = scopeTokens(options.objective);
  return candidates
    .map((candidate, idx) => {
      const base = 1 / (RRF_K + idx + 1);
      const score = base * recencyMultiplier(candidate.mtime, options.recencyHalfLifeDays)
        + OBJECTIVE_BONUS_WEIGHT * objectiveOverlap(tokens, candidate);
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.candidate);
}

/**
 * Pull the top-N FTS candidates for a query. Internal — both `recall`
 * and `recallHybrid` consume this.
 */
function fetchFtsCandidates(query: string, options: RecallOptions, poolSize: number): RecallChunkRow[] {
  const fts = buildFtsQuery(query);
  if (!fts) return [];

  const db = openMemoryDb();

  let sql = `
    SELECT
      vc.id      AS id,
      vc.path    AS path,
      vc.title   AS title,
      vc.content AS content,
      vc.mtime   AS mtime,
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
  params.push(poolSize);

  try {
    return db.prepare(sql).all(...params) as RecallChunkRow[];
  } catch (err) {
    logger.warn({ err, query }, 'fts query failed');
    return [];
  }
}

function rowsToHits(rows: RecallChunkRow[]): MemorySearchHit[] {
  if (rows.length === 0) return [];

  // BM25 returns negative scores in SQLite (lower = better). Normalize to a
  // positive 0..1-ish score so it composes with the legacy `searchVault`
  // scale that callers may already have UI for.
  const ranks = rows.map((r) => r.rank);
  const best = Math.min(...ranks);
  const worst = Math.max(...ranks);
  const spread = Math.max(0.0001, worst - best);

  return rows.map((row) => {
    const normalized = 1 - (row.rank - best) / spread;
    return {
      filePath: row.path,
      title: deriveTitle(row),
      snippet: row.snip || row.content.slice(0, 240).replace(/\s+/g, ' '),
      score: Number((normalized * 10).toFixed(3)),
    } satisfies MemorySearchHit;
  });
}

async function semanticFallback(query: string, options: RecallOptions, limit: number): Promise<MemorySearchHit[]> {
  if (!isEmbeddingsEnabled()) return [];
  const db = openMemoryDb();
  let sql = `
    SELECT
      vc.id      AS id,
      vc.path    AS path,
      vc.title   AS title,
      vc.content AS content,
      e.vector   AS vector
    FROM embeddings e
    JOIN vault_chunks vc ON vc.id = e.chunk_id
  `;
  const params: unknown[] = [];
  if (options.pathPrefix) {
    sql += ' WHERE vc.path LIKE ?';
    params.push(`${options.pathPrefix}%`);
  }
  sql += ' ORDER BY vc.id DESC LIMIT ?';
  params.push(SEMANTIC_FALLBACK_MAX_SCAN);

  let rows: SemanticChunkRow[] = [];
  try {
    rows = db.prepare(sql).all(...params) as SemanticChunkRow[];
  } catch (err) {
    logger.warn({ err, query }, 'semantic fallback query failed');
    return [];
  }
  if (rows.length === 0) return [];

  const queryVector = await embedQuery(query);
  if (!queryVector) return [];

  const scored = rows
    .map((row) => ({
      row,
      score: cosine(queryVector, bufferToVector(row.vector)),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((entry) => ({
    filePath: entry.row.path,
    title: deriveTitle({ title: entry.row.title, path: entry.row.path }),
    snippet: entry.row.content.slice(0, 240).replace(/\s+/g, ' '),
    score: Number((Math.max(0, entry.score) * 10).toFixed(3)),
  }));
}

/**
 * Sync FTS-only recall. Use when you don't have an event loop budget
 * for embeddings (CLI prints, simple tool callbacks).
 */
export function recall(query: string, options: RecallOptions = {}): MemorySearchHit[] {
  const limit = Math.max(1, options.limit ?? 6);
  const rows = fetchFtsCandidates(query, options, limit);
  const hits = mergeTemporalMeetingHits(query, options, rowsToHits(rows), limit);
  recordRecall(hits.length);
  return hits;
}

/**
 * Hybrid recall: FTS narrows the candidate pool, optional embedding
 * rerank merges via Reciprocal Rank Fusion. Falls back to FTS-only
 * silently if embeddings are disabled, the query embedding fails, or
 * no candidates in the pool have stored embeddings.
 */
export async function recallHybrid(query: string, options: RecallOptions = {}): Promise<MemorySearchHit[]> {
  const hits = await recallHybridImpl(query, options);
  recordRecall(hits.length);
  return hits;
}

async function recallHybridImpl(query: string, options: RecallOptions = {}): Promise<MemorySearchHit[]> {
  const limit = Math.max(1, options.limit ?? 6);
  // An exact calendar-date meeting match is stronger than a semantic guess and
  // needs no embedding call. Returning it immediately also keeps automatic
  // primer assembly comfortably inside its first-token latency budget.
  const exactMeetings = temporalMeetingHits(query, options, limit);
  if (exactMeetings.length > 0) return exactMeetings;
  const poolSize = Math.max(limit, RERANK_CANDIDATE_POOL);
  const candidates = fetchFtsCandidates(query, options, poolSize);
  if (candidates.length === 0) {
    return mergeTemporalMeetingHits(query, options, await semanticFallback(query, options, limit), limit);
  }

  // FTS-only fast path when embeddings aren't available.
  if (!isEmbeddingsEnabled()) {
    return mergeTemporalMeetingHits(query, options, rowsToHits(reRankByScope(candidates, options).slice(0, limit)), limit);
  }

  const stored = loadEmbeddingsForChunks(candidates.map((c) => c.id));
  if (stored.size === 0) {
    // Pool has no embeddings yet — return FTS order. The backfill task
    // will fill them in over time and the next call benefits.
    return mergeTemporalMeetingHits(query, options, rowsToHits(reRankByScope(candidates, options).slice(0, limit)), limit);
  }

  const queryVector = await embedQuery(query);
  if (!queryVector) {
    return mergeTemporalMeetingHits(query, options, rowsToHits(reRankByScope(candidates, options).slice(0, limit)), limit);
  }

  // Rank by FTS (already ordered) and by semantic similarity. Then fuse
  // with reciprocal rank fusion. Chunks missing an embedding still
  // participate via their FTS rank alone — they just don't get a
  // semantic boost.
  const ftsRankByChunk = new Map<number, number>();
  candidates.forEach((c, idx) => ftsRankByChunk.set(c.id, idx + 1));

  const semanticScored: Array<{ id: number; sim: number }> = [];
  for (const candidate of candidates) {
    const vec = stored.get(candidate.id);
    if (!vec) continue;
    semanticScored.push({ id: candidate.id, sim: cosine(queryVector, vec) });
  }
  semanticScored.sort((a, b) => b.sim - a.sim);

  const semanticRankByChunk = new Map<number, number>();
  semanticScored.forEach((entry, idx) => semanticRankByChunk.set(entry.id, idx + 1));

  const tokens = scopeTokens(options.objective);
  const fused = candidates.map((candidate) => {
    const ftsRank = ftsRankByChunk.get(candidate.id) ?? candidates.length + 1;
    const semRank = semanticRankByChunk.get(candidate.id);
    const ftsScore = 1 / (RRF_K + ftsRank);
    const semScore = semRank !== undefined ? 1 / (RRF_K + semRank) : 0;
    // Recency + objective scope. Both are identity no-ops when their options are
    // unset (multiplier 1, overlap 0), so the default fused order is unchanged.
    const base = ftsScore + semScore;
    const score = base * recencyMultiplier(candidate.mtime, options.recencyHalfLifeDays)
      + OBJECTIVE_BONUS_WEIGHT * objectiveOverlap(tokens, candidate);
    return { candidate, score };
  });

  fused.sort((a, b) => b.score - a.score);
  const top = fused.slice(0, limit).map((entry) => entry.candidate);
  const hits = rowsToHits(top);

  // Rescale scores using the fused order so callers see a sensible 0..10
  // gradient consistent with the FTS-only path.
  return mergeTemporalMeetingHits(query, options, hits.map((hit, idx) => ({
    ...hit,
    score: Number((10 - (idx * (10 / Math.max(1, hits.length)))).toFixed(3)),
  })), limit);
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
