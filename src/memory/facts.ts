import { createHash } from 'node:crypto';
import { getRuntimeEnv } from '../config.js';
import { openMemoryDb, type ConsolidatedFactKind, type ConsolidatedFactRow } from './db.js';
import { cosine, embedQuery, isEmbeddingsEnabled, loadFactEmbeddings } from './embeddings.js';

/**
 * Floor for the Stanford recall candidate pool. The pool is pre-filtered by
 * `updated_at DESC` but SCORED by the Stanford axis (last_accessed_at +
 * importance + relevance). A small floor (the old 100) silently drops warm,
 * high-importance facts whose CONTENT wasn't recently edited before they can
 * be scored — at audit time 63 of 73 active importance>=7 facts sat past
 * rank 100 by updated_at. 500 matches findSimilarFactsScored's cap and covers
 * the full active set at our scale (~1k facts); a JS sort of 500 stays sub-ms.
 * Widening only — it never reorders the pool, so any fact surfaced today still
 * surfaces. Override via CLEMMY_RECALL_POOL (invalid/empty → 500).
 */
function recallCandidatePoolFloor(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_RECALL_POOL', '500') || '500', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 500;
}

// ─── Per-turn semantic recall (reuse the turn's query embedding) ───────────
// The per-turn fact ranking is SYNCHRONOUS, but embedding the query is async.
// The harness loop computes the query vector once at turn start (concurrent
// with the memory primer, so ~no added latency) and stashes it here;
// listActiveFacts(stanford) then adds a BONUS semantic-relevance term
// (weight · max(0, cosine)) so recall becomes recency + importance + RELEVANCE
// instead of recency + lexical-only — the 968 fact embeddings finally feed the
// per-turn path. Bonus-only: it can only PROMOTE an on-topic fact, never demote
// one below where recency+importance already placed it. TTL-guarded so a stale
// vector can never leak into an unrelated later call. Flag CLEMMY_SEMANTIC_RECALL
// (default on); off → byte-identical to the prior lexical ranking.
const TURN_QUERY_TTL_MS = 60_000;
let turnQuery: { text: string; vector: Float32Array; atMs: number } | null = null;

export function setTurnQueryVector(text: string, vector: Float32Array | null, nowMs: number = Date.now()): void {
  turnQuery = vector && vector.length > 0 ? { text, vector, atMs: nowMs } : null;
}
export function clearTurnQueryVector(): void { turnQuery = null; }

/** Compute + stash the turn's query embedding so the (sync) per-turn fact
 *  recall can add a semantic-relevance term. Fire concurrently with the memory
 *  primer — it never throws and never blocks recall (embedQuery is breaker- and
 *  timeout-guarded). No-op when the flag is off or embeddings are unavailable,
 *  leaving recall on the prior lexical ranking. */
export async function primeTurnRecallVector(input: string): Promise<void> {
  if (!semanticRecallEnabled() || !input || !input.trim()) { clearTurnQueryVector(); return; }
  try {
    setTurnQueryVector(input, await embedQuery(input));
  } catch {
    setTurnQueryVector(input, null);
  }
}

function getActiveTurnQueryVector(nowMs: number): Float32Array | null {
  if (!turnQuery) return null;
  if (nowMs - turnQuery.atMs > TURN_QUERY_TTL_MS) return null;
  return turnQuery.vector;
}

function semanticRecallEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_SEMANTIC_RECALL', 'on') || 'on').toLowerCase() !== 'off';
}
function semanticRecallWeight(): number {
  const raw = Number.parseFloat(getRuntimeEnv('CLEMMY_SEMANTIC_RECALL_WEIGHT', '1.0') || '1.0');
  return Number.isFinite(raw) && raw >= 0 ? raw : 1.0;
}

/**
 * Read/write API for durable, agent-curated facts.
 *
 * Why this exists:
 * - Session briefs and working memory drift as conversations evolve.
 *   `consolidated_facts` is for the things that should NOT drift —
 *   user preferences, project context, persistent feedback, links to
 *   external references the agent should keep coming back to.
 * - The agent itself decides what to remember (via the `memory_remember`
 *   MCP tool). No automatic LLM extraction; the agent's own judgment is
 *   the consolidation step.
 * - On every turn, the top-N active facts are injected into the
 *   assistant's instructions so the model is fact-aware.
 *
 * Schema lives in src/memory/db.ts. Content is deduped by hash so the
 * same fact written twice is a no-op (we bump `score` and `updated_at`).
 */

export interface ConsolidatedFact {
  id: number;
  kind: ConsolidatedFactKind;
  content: string;
  source: { sessionId?: string; path?: string };
  score: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  // v3 brain-architecture provenance (NULL when not derived).
  derivedFrom?: {
    sessionId: string | null;
    callId: string | null;
    tool: string | null;
  };
  trustLevel?: number | null;
  extractedAt?: string | null;
  // v4 — Stanford Generative Agents §4.1 poignancy + recency anchor.
  importance?: number | null;
  lastAccessedAt?: string | null;
  // v5 — recursive reflection / Stanford trees (§4.2). 0 for atomic
  // facts; 1+ for synthesized higher-order patterns.
  derivationDepth?: number;
  derivedFromFactIds?: number[] | null;
  // v8 — pinned standing instruction: always injected into the prompt,
  // exempt from the top-N cap and recency decay.
  pinned?: boolean;
  // v9 — friendly app name when derived from a system of record
  // (Salesforce/Outlook/Airtable/…). NULL otherwise.
  sourceApp?: string | null;
  // v11 — how many times this fact has been surfaced into a prompt.
  // Reinforces recall ranking + decay resistance via log(1+accessCount).
  accessCount?: number;
}

export const FACT_KINDS: ConsolidatedFactKind[] = ['user', 'project', 'feedback', 'reference', 'constraint'];

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function hashContent(kind: ConsolidatedFactKind, content: string): string {
  return createHash('sha1').update(`${kind}::${normalizeContent(content).toLowerCase()}`).digest('hex');
}

function rowToFact(row: ConsolidatedFactRow): ConsolidatedFact {
  const derived = row.derived_from_call_id || row.derived_from_session_id || row.derived_from_tool;
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    source: {
      sessionId: row.source_session_id ?? undefined,
      path: row.source_path ?? undefined,
    },
    score: row.score,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    derivedFrom: derived
      ? {
          sessionId: row.derived_from_session_id,
          callId: row.derived_from_call_id,
          tool: row.derived_from_tool,
        }
      : undefined,
    trustLevel: row.trust_level,
    extractedAt: row.extracted_at,
    importance: row.importance,
    lastAccessedAt: row.last_accessed_at,
    derivationDepth: row.derivation_depth ?? 0,
    derivedFromFactIds: row.derived_from_fact_ids
      ? safeParseFactIds(row.derived_from_fact_ids)
      : null,
    pinned: row.pinned === 1,
    sourceApp: row.source_app ?? null,
    accessCount: row.access_count ?? 0,
  };
}

function safeParseFactIds(json: string): number[] | null {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((n) => Number.isInteger(n))) {
      return parsed as number[];
    }
  } catch { /* ignore */ }
  return null;
}

export interface RememberInput {
  kind: ConsolidatedFactKind;
  content: string;
  sessionId?: string;
  path?: string;
  score?: number;
  // v3 brain-architecture: when the reflection loop synthesizes this
  // fact from a tool return, populate `derivedFrom` so the fact links
  // back to the source call_id (recallable via recall_tool_result).
  derivedFrom?: {
    sessionId?: string;
    callId?: string;
    tool?: string;
  };
  trustLevel?: number; // 0.0–1.0; user-stated facts default to 1.0; derived ~0.6
  // v4 — Stanford §4.1 poignancy score (1.0–10.0). Defaults: user-stated
  // facts → 5.0 (mundane-to-meaningful midpoint per Park et al's prompt);
  // derived facts → set by the reflection extractor. Used by retrieval
  // weighting and reflection-trigger sum-threshold.
  importance?: number;
  // v5 — recursive reflection (Stanford §4.2). depth=0 (default) for
  // atomic facts (direct + tool-derived). depth=1+ for synthesized
  // higher-order patterns; derivedFromFactIds carries the source ids.
  derivationDepth?: number;
  derivedFromFactIds?: number[];
  // v9 — friendly source-app name when this fact was derived from a system
  // of record (set by the reflection loop via classifySource).
  sourceApp?: string;
}

/**
 * Record a durable fact. Idempotent on (kind, normalized content):
 * a repeat write bumps `score` by 0.1 and `updated_at` instead of
 * creating a duplicate row.
 */
export function rememberFact(input: RememberInput): ConsolidatedFact {
  const content = normalizeContent(input.content);
  if (!content) throw new Error('rememberFact: content is required');
  if (!FACT_KINDS.includes(input.kind)) {
    throw new Error(`rememberFact: invalid kind "${input.kind}"`);
  }

  const db = openMemoryDb();
  const hash = hashContent(input.kind, content);
  const now = new Date().toISOString();
  const initialScore = input.score ?? 1.0;

  const existing = db.prepare(
    'SELECT * FROM consolidated_facts WHERE content_hash = ?'
  ).get(hash) as ConsolidatedFactRow | undefined;

  const dfSession = input.derivedFrom?.sessionId ?? null;
  const dfCall = input.derivedFrom?.callId ?? null;
  const dfTool = input.derivedFrom?.tool ?? null;
  const trust = typeof input.trustLevel === 'number'
    ? Math.max(0, Math.min(1, input.trustLevel))
    : (dfSession || dfCall ? 0.6 : 1.0);
  const extractedAt = dfSession || dfCall ? now : null;
  // Stanford §4.1: poignancy score 1.0–10.0. Direct user statements get
  // a midpoint default (5.0); derived facts MUST carry an extractor-
  // assigned score (the reflection layer sets it). Clamp to range.
  const importance = typeof input.importance === 'number'
    ? Math.max(1, Math.min(10, input.importance))
    : 5.0;
  // Constraints are hard rules that guard tool dispatch — they must be in the
  // always-rendered pinned tier from birth, not only after a manual pin (an
  // unpinned constraint can be scoped out of context exactly when it matters).
  // Auto-pin on insert AND on the dedup-update path; setFactPinned still
  // allows a manual unpin of a constraint the user no longer wants standing.
  const autoPin = input.kind === 'constraint' ? 1 : 0;

  if (existing) {
    db.prepare(`
      UPDATE consolidated_facts
      SET score = MIN(score + 0.1, 10),
          active = 1,
          updated_at = ?,
          source_session_id = COALESCE(?, source_session_id),
          source_path       = COALESCE(?, source_path),
          derived_from_session_id = COALESCE(derived_from_session_id, ?),
          derived_from_call_id    = COALESCE(derived_from_call_id, ?),
          derived_from_tool       = COALESCE(derived_from_tool, ?),
          -- Bias toward higher trust when conflicting writes arrive:
          -- user-stated (1.0) supersedes derived (0.6).
          trust_level             = MAX(COALESCE(trust_level, 0), ?),
          extracted_at            = COALESCE(extracted_at, ?),
          -- Importance MAX-merges too: a fact that was first derived
          -- as importance=4 but later restated with importance=8
          -- should reflect the higher salience.
          importance              = MAX(COALESCE(importance, 0), ?),
          -- v9: fill in source provenance if a later authoritative write
          -- knows it and the row didn't yet (don't clobber an existing one).
          source_app              = COALESCE(source_app, ?),
          -- Constraint auto-pin: MAX so a re-write never UNpins a fact a
          -- user or the safety path pinned.
          pinned                   = MAX(pinned, ?)
      WHERE id = ?
    `).run(now, input.sessionId ?? null, input.path ?? null,
           dfSession, dfCall, dfTool, trust, extractedAt, importance, input.sourceApp ?? null, autoPin, existing.id);
    const refreshed = db.prepare('SELECT * FROM consolidated_facts WHERE id = ?')
      .get(existing.id) as ConsolidatedFactRow;
    return rowToFact(refreshed);
  }

  const derivationDepth = Math.max(0, Math.min(2, input.derivationDepth ?? 0));
  const derivedFromIdsJson = Array.isArray(input.derivedFromFactIds) && input.derivedFromFactIds.length > 0
    ? JSON.stringify(input.derivedFromFactIds.filter((n) => Number.isInteger(n)))
    : null;

  const info = db.prepare(`
    INSERT INTO consolidated_facts
      (kind, content, content_hash, source_session_id, source_path,
       score, active, created_at, updated_at,
       derived_from_session_id, derived_from_call_id, derived_from_tool,
       trust_level, extracted_at, importance,
       derivation_depth, derived_from_fact_ids, source_app, pinned)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.kind, content, hash, input.sessionId ?? null, input.path ?? null,
         initialScore, now, now,
         dfSession, dfCall, dfTool, trust, extractedAt, importance,
         derivationDepth, derivedFromIdsJson, input.sourceApp ?? null, autoPin);

  const inserted = db.prepare('SELECT * FROM consolidated_facts WHERE id = ?')
    .get(info.lastInsertRowid) as ConsolidatedFactRow;
  return rowToFact(inserted);
}

/**
 * Touch the last_accessed_at column on a fact whenever the agent
 * retrieves it. Stanford §4.1 anchors recency decay on THIS column,
 * not creation: recall-decay shifts when a fact is re-surfaced.
 *
 * Best-effort: a missing row is a no-op. Callers (memory_search,
 * memory_recall) fire this in a loop over their result set without
 * awaiting individual completions.
 */
export function touchFactAccess(id: number): void {
  try {
    const db = openMemoryDb();
    db.prepare('UPDATE consolidated_facts SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?')
      .run(new Date().toISOString(), id);
  } catch {
    // ignore
  }
}

/**
 * Mem0-style UPDATE: overwrite an existing fact's content + bump its
 * updated_at and last_accessed_at. Used when the reflection conflict-
 * resolver decides a new candidate fact supersedes an old one
 * (Chhikara et al §2.1 — "augmentation of existing memories with
 * complementary information").
 *
 * The content_hash is recomputed so future writes of the same new
 * content de-dup correctly. Trust + importance can be lifted but not
 * demoted (we use MAX semantics here too).
 */
export function updateFact(
  id: number,
  patch: {
    content?: string;
    trustLevel?: number;
    importance?: number;
    sessionId?: string;
    sourceApp?: string;
  },
): ConsolidatedFact | null {
  const db = openMemoryDb();
  const existing = db.prepare('SELECT * FROM consolidated_facts WHERE id = ?')
    .get(id) as ConsolidatedFactRow | undefined;
  if (!existing) return null;
  const now = new Date().toISOString();
  let newContent = existing.content;
  let newHash = existing.content_hash;
  if (typeof patch.content === 'string' && patch.content.trim() && patch.content !== existing.content) {
    newContent = normalizeContent(patch.content);
    newHash = hashContent(existing.kind, newContent);
  }
  const newTrust = typeof patch.trustLevel === 'number'
    ? Math.max(existing.trust_level ?? 0, Math.min(1, patch.trustLevel))
    : existing.trust_level;
  const newImportance = typeof patch.importance === 'number'
    ? Math.max(existing.importance ?? 0, Math.min(10, patch.importance))
    : existing.importance;
  db.prepare(`
    UPDATE consolidated_facts
    SET content       = ?,
        content_hash  = ?,
        updated_at    = ?,
        last_accessed_at = ?,
        trust_level   = ?,
        importance    = ?,
        source_session_id = COALESCE(?, source_session_id),
        source_app    = COALESCE(?, source_app)
    WHERE id = ?
  `).run(newContent, newHash, now, now, newTrust, newImportance, patch.sessionId ?? null, patch.sourceApp ?? null, id);
  const refreshed = db.prepare('SELECT * FROM consolidated_facts WHERE id = ?')
    .get(id) as ConsolidatedFactRow;
  return rowToFact(refreshed);
}

/**
 * Mem0-style DELETE: marks active=0 (soft delete). Stanford keeps a
 * paper trail of all memories; we honor that by NOT physically
 * removing the row. The fact becomes invisible to memory_search /
 * memory_recall but remains queryable for audit + future re-activation.
 *
 * Use case from Mem0 §2.1: "removal of memories contradicted by new
 * information." Example: user said "I prefer Tuesday" then later
 * "actually Wednesday now" — the old fact gets soft-deleted.
 */
export function deleteFact(id: number): boolean {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  const info = db.prepare('UPDATE consolidated_facts SET active = 0, updated_at = ? WHERE id = ?')
    .run(now, id);
  return info.changes > 0;
}

/**
 * Reactivate a soft-deleted fact — the inverse of deleteFact/forgetFact.
 *
 * The load-bearing reversibility primitive: soft-delete (active=0) keeps the
 * row, embedding, and provenance intact, but until now there was no way back —
 * a forgotten or auto-decayed fact was stranded. This restores it. It also
 * refreshes last_accessed_at so the just-restored fact is NOT immediately
 * idle-eligible for re-decay on the next hygiene pass (the user explicitly
 * brought it back — that counts as an access). Idempotent: a no-op on an
 * already-active fact returns false (no rows changed).
 */
export function reactivateFact(id: number): boolean {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  const info = db.prepare(
    'UPDATE consolidated_facts SET active = 1, updated_at = ?, last_accessed_at = ? WHERE id = ? AND active = 0',
  ).run(now, now, id);
  return info.changes > 0;
}

/**
 * Find facts semantically similar to a candidate content string. Used
 * by the reflection conflict resolver: before ADDing a new candidate
 * fact, retrieve the top-K most-similar existing active facts so the
 * LLM can decide ADD / UPDATE / DELETE / NOOP. Mirrors Mem0's
 * "Update Phase" (Chhikara et al §2.1).
 *
 * Semantic-first: when embeddings are configured we rank the active
 * (kind-filtered) fact pool by cosine similarity to the candidate, so a
 * paraphrased contradiction with no shared tokens still surfaces for the
 * resolver. Falls back to the LIKE-token ranker when embeddings are
 * disabled, the query embed fails, or no pooled fact is embedded yet
 * (the backfill warms it over time) — preserving behavior for no-key
 * (codex_oauth) installs. The conflict resolver's LLM call provides the
 * actual contradiction-vs-complement judgment; this retrieval just
 * narrows the candidate pool.
 */
/** A fact paired with its similarity to the query. `sim` is the cosine
 *  similarity (0..1) on the semantic path, or `null` on the lexical
 *  fallback path (no comparable score is available without embeddings).
 *  Callers that gate on a similarity threshold (novelty fast-path, dedup)
 *  MUST treat `null` as "unknown" and not threshold against it. */
export interface ScoredFact {
  fact: ConsolidatedFact;
  sim: number | null;
}

/**
 * Like {@link findSimilarFacts} but returns each fact paired with its
 * cosine similarity to the query (semantic path) or `null` (lexical
 * fallback). Single source of truth — `findSimilarFacts` strips the score.
 */
export async function findSimilarFactsScored(
  content: string,
  options: { kind?: ConsolidatedFactKind; topK?: number } = {},
): Promise<ScoredFact[]> {
  const db = openMemoryDb();
  const topK = Math.max(1, Math.min(20, options.topK ?? 5));
  const normalized = normalizeContent(content);
  if (!normalized) return [];

  // Semantic path — cosine over the embedded fact pool.
  if (isEmbeddingsEnabled()) {
    try {
      // Cap the candidate pool so we never load every embedding on a
      // large vault. Most-recently-updated facts are the relevant
      // contradiction targets. Load stored vectors before embedding the
      // query; fresh installs often have facts but no fact_embeddings yet,
      // and making a network call just to discover an empty comparison
      // pool adds latency without improving recall.
      // Same env-driven pool floor as listActiveFacts (CLEMMY_RECALL_POOL,
      // default 500) so this semantic-recall path — which backs both
      // memory_search_facts and the dedup/conflict resolver — widens together
      // and stops pre-filtering high-importance facts out by updated_at before
      // they're ever cosine-scored. Widening only; updated_at stays the
      // tiebreaker so today's top-K never reorders.
      const pool = recallCandidatePoolFloor();
      const poolRows = (options.kind
        ? db.prepare(`SELECT id FROM consolidated_facts WHERE active = 1 AND kind = ? ORDER BY updated_at DESC LIMIT ${pool}`).all(options.kind)
        : db.prepare(`SELECT id FROM consolidated_facts WHERE active = 1 ORDER BY updated_at DESC LIMIT ${pool}`).all()) as { id: number }[];
      const ids = poolRows.map((r) => r.id);
      const vectors = loadFactEmbeddings(ids);
      if (vectors.size > 0) {
        const queryVector = await embedQuery(normalized);
        if (queryVector) {
          const scored: Array<{ id: number; sim: number }> = [];
          for (const id of ids) {
            const vec = vectors.get(id);
            if (!vec) continue;
            scored.push({ id, sim: cosine(queryVector, vec) });
          }
          scored.sort((a, b) => b.sim - a.sim);
          const top = scored.slice(0, topK);
          const topIds = top.map((s) => s.id);
          if (topIds.length > 0) {
            const simById = new Map(top.map((s) => [s.id, s.sim]));
            const placeholders = topIds.map(() => '?').join(',');
            const factRows = db.prepare(
              `SELECT * FROM consolidated_facts WHERE id IN (${placeholders})`
            ).all(...topIds) as ConsolidatedFactRow[];
            const byId = new Map(factRows.map((r) => [r.id, r]));
            // Preserve cosine order, carrying the similarity score.
            return topIds
              .map((id) => byId.get(id))
              .filter((r): r is ConsolidatedFactRow => Boolean(r))
              .map((r) => ({ fact: rowToFact(r), sim: simById.get(r.id) ?? null }));
          }
        }
      }
      // Embeddings on but pool not yet embedded — fall through to LIKE.
    } catch {
      // Any failure (embed timeout, circuit breaker) → LIKE fallback.
    }
  }

  // Light tokenization → FTS5 OR-match over content. We don't use the
  // full searchVault path because the conflict resolver wants ONLY
  // consolidated_facts (no vault chunks).
  const tokens = normalized
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
    .slice(0, 12);
  if (tokens.length === 0) return [];

  // bm25-like ranking via fts5 if facts have an FTS index. They
  // currently don't, so we fall back to a simple LIKE-token-count
  // ranker which still gives the resolver a useful candidate pool.
  const matches = db.prepare(`
    SELECT * FROM consolidated_facts
    WHERE active = 1
      ${options.kind ? 'AND kind = ?' : ''}
      AND (${tokens.map(() => 'LOWER(content) LIKE ?').join(' OR ')})
    LIMIT 200
  `).all(...(options.kind ? [options.kind] : []), ...tokens.map((t) => `%${t}%`)) as ConsolidatedFactRow[];

  // Score by token-occurrence count, return top-K. No cosine available on
  // this path, so sim is null (callers must not threshold against it).
  const scored = matches.map((row) => {
    const lc = row.content.toLowerCase();
    const hits = tokens.reduce((sum, t) => sum + (lc.includes(t) ? 1 : 0), 0);
    return { row, hits };
  });
  scored.sort((a, b) => b.hits - a.hits || (b.row.updated_at || '').localeCompare(a.row.updated_at || ''));
  return scored.slice(0, topK).map((s) => ({ fact: rowToFact(s.row), sim: null }));
}

export async function findSimilarFacts(
  content: string,
  options: { kind?: ConsolidatedFactKind; topK?: number } = {},
): Promise<ConsolidatedFact[]> {
  return (await findSimilarFactsScored(content, options)).map((s) => s.fact);
}

/**
 * Lexical (LIKE-token) search over the durable fact store. SYNCHRONOUS and
 * embedding-free by design: unlike findSimilarFacts (semantic-first, which
 * skips its LIKE fallback whenever the embedded pool returns a full top-K), a
 * FRESHLY-remembered fact — whose embedding may not be indexed yet — is found
 * here immediately by text. This backs the per-turn memory primer so
 * "remember my X is TOKEN" is recallable in the very next turn, closing the
 * fresh-fact recall gap. Token-occurrence ranked, recency as tiebreaker.
 */
/** Common words that match too many facts to be useful as a lexical key. */
const FACT_QUERY_STOPWORDS = new Set<string>([
  'the', 'and', 'but', 'not', 'are', 'was', 'were', 'for', 'with', 'from', 'this',
  'that', 'these', 'those', 'what', 'when', 'where', 'who', 'whom', 'which', 'why',
  'how', 'your', 'you', 'mine', 'our', 'their', 'just', 'please', 'can', 'will',
  'would', 'should', 'could', 'have', 'has', 'had', 'did', 'does', 'about', 'into',
  'only', 'also', 'exactly', 'confirm', 'tell', 'give', 'show', 'list', 'find',
  'get', 'got', 'need', 'want', 'here', 'there', 'now', 'then', 'any', 'all',
  'some', 'more', 'most', 'than', 'them', 'they', 'its', 'his', 'her', 'out',
]);

export function searchFactsByText(query: string, limit = 5): ConsolidatedFact[] {
  const normalized = normalizeContent(query);
  if (!normalized) return [];
  // Drop high-frequency stop-words: the LIKE match has no ORDER BY before its
  // LIMIT, so a common word (the/what/just/your) matches thousands of facts and
  // evicts the relevant one before token-ranking. Keeping only content-bearing
  // tokens ("staging","token") makes the relevant fact the one that matches.
  const tokens = normalized
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !FACT_QUERY_STOPWORDS.has(t))
    .slice(0, 12);
  if (tokens.length === 0) return [];
  try {
    const db = openMemoryDb();
    const matches = db.prepare(`
      SELECT * FROM consolidated_facts
      WHERE active = 1
        AND (${tokens.map(() => 'LOWER(content) LIKE ?').join(' OR ')})
      ORDER BY updated_at DESC
      LIMIT 200
    `).all(...tokens.map((t) => `%${t}%`)) as ConsolidatedFactRow[];
    const scored = matches.map((row) => {
      const lc = row.content.toLowerCase();
      const hits = tokens.reduce((sum, t) => sum + (lc.includes(t) ? 1 : 0), 0);
      return { row, hits };
    });
    scored.sort((a, b) => b.hits - a.hits || (b.row.updated_at || '').localeCompare(a.row.updated_at || ''));
    return scored.slice(0, Math.max(1, limit)).map((s) => rowToFact(s.row));
  } catch {
    return [];
  }
}

/**
 * Agent-facing semantic search over the durable fact store (Tier B).
 * Thin wrapper over {@link findSimilarFacts} — the conflict resolver's
 * `findSimilarFacts` was previously the ONLY semantic entry into the
 * 800+ fact long-tail, and it was internal-only, so on-demand fact recall
 * was limited to the ~40 facts that win a MEMORY.md slot. This exposes the
 * full embedded pool to `memory_search_facts`.
 */
export async function searchFacts(
  query: string,
  options: { kind?: ConsolidatedFactKind; topK?: number } = {},
): Promise<ConsolidatedFact[]> {
  return findSimilarFacts(query, { kind: options.kind, topK: options.topK ?? 8 });
}

/**
 * Render the "Recently Learned" section for the persistent context block.
 * Pulls derived facts from the last N hours, formats them with a small
 * provenance hint so the model knows these were synthesized from tool
 * returns (not directly stated by the user) and can use recall_tool_result
 * if a specific source is needed.
 */
export function renderRecentlyLearnedForInstructions(
  sinceHours = 24,
  limit = 15,
  maxChars = 2000,
): string {
  const facts = listRecentlyLearnedFacts({ sinceHours, limit });
  if (facts.length === 0) return '';
  const lines: string[] = [];
  let used = 0;
  let elided = 0;
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const callRef = fact.derivedFrom?.callId ? ` [${fact.derivedFrom.callId}]` : '';
    const toolRef = fact.derivedFrom?.tool ? ` (from ${fact.derivedFrom.tool})` : '';
    const line = `- ${fact.content}${callRef}${toolRef}`;
    if (used + line.length > maxChars) { elided = facts.length - i; break; }
    lines.push(line);
    used += line.length;
  }
  if (elided > 0) {
    lines.push(`- _… and ${elided} more recent fact${elided === 1 ? '' : 's'} (recall via memory_search_facts)._`);
  }
  return lines.join('\n');
}

/**
 * Read the most-recently-learned derived facts. Powers the "Recently
 * Learned" section in the orchestrator's persistent context block.
 */
export function listRecentlyLearnedFacts(options: { sinceHours?: number; limit?: number } = {}): ConsolidatedFact[] {
  const db = openMemoryDb();
  const sinceHours = options.sinceHours ?? 24;
  const limit = options.limit ?? 15;
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT * FROM consolidated_facts
    WHERE active = 1
      AND extracted_at IS NOT NULL
      AND extracted_at >= ?
    ORDER BY importance DESC, extracted_at DESC, id DESC
    LIMIT ?
  `).all(since, limit) as ConsolidatedFactRow[];
  return rows.map(rowToFact);
}

/**
 * Stanford §4.1 retrieval scoring: `score = α_recency·recency +
 * α_importance·importance + α_relevance·relevance`. With α_recency =
 * α_importance = α_relevance = 1.0 in the paper.
 *
 * For non-query reads (`listActiveFacts` with no search query), we
 * apply recency + importance only (relevance requires a query). For
 * query reads, the caller folds this scoring on top of FTS5 +
 * embedding rerank.
 *
 * Recency: exp(-rate · hoursSinceLastAccess), rate chosen so 0.995/hr
 * matches Stanford's published decay (rate = -ln(0.995) ≈ 0.005012).
 * Anchor is `last_accessed_at` if set, else `extracted_at`, else
 * `updated_at`.
 *
 * Importance: scaled to [0,1] from the 1-10 column; null → 0.5 as a
 * conservative midpoint.
 */
const STANFORD_RECENCY_DECAY_RATE = -Math.log(0.995); // ≈ 0.00501

// Access-frequency reinforcement weight. log1p(access_count) is bounded and
// gentle (0 accesses → 0, 1 → 0.69, 10 → 0.24·w, 50 → 0.39·w at w=0.1), so a
// repeatedly-useful fact rises in recall AND clears the decay score-floor more
// easily, while a never-recalled fact is unchanged. Tunable via
// CLEMMY_RECALL_REINFORCEMENT_WEIGHT (0 disables — byte-identical to before).
function recallReinforcementWeight(): number {
  const raw = Number.parseFloat(getRuntimeEnv('CLEMMY_RECALL_REINFORCEMENT_WEIGHT', '0.1') || '0.1');
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.1;
}

export function stanfordRecallScore(fact: ConsolidatedFact, nowMs: number = Date.now()): number {
  const accessIso = fact.lastAccessedAt || fact.extractedAt || fact.updatedAt || fact.createdAt;
  const accessedAtMs = Date.parse(accessIso);
  const hoursSince = Number.isFinite(accessedAtMs)
    ? Math.max(0, (nowMs - accessedAtMs) / 3_600_000)
    : 0;
  const recency = Math.exp(-STANFORD_RECENCY_DECAY_RATE * hoursSince);
  const importance = (typeof fact.importance === 'number' ? fact.importance : 5.0) / 10;
  // Reinforcement: a fact recalled many times is proven useful — promote it and
  // help it resist decay. log1p keeps it bounded so it never dominates recency.
  const reinforcement = recallReinforcementWeight() * Math.log1p(Math.max(0, fact.accessCount ?? 0));
  return recency + importance + reinforcement;
}

// Tiny stopword set so common words don't manufacture false relevance.
const RELEVANCE_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her',
  'was', 'one', 'our', 'out', 'his', 'has', 'had', 'how', 'its', 'who', 'get',
  'this', 'that', 'with', 'have', 'from', 'they', 'will', 'your', 'them',
  'then', 'than', 'into', 'when', 'what', 'their', 'about', 'would', 'there',
  'should', 'these', 'those', 'want', 'need', 'make', 'like', 'just', 'also',
]);

function relevanceTokens(text: string): Set<string> {
  const tokens = (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((tok) => tok.length >= 3 && !RELEVANCE_STOPWORDS.has(tok));
  return new Set(tokens);
}

/**
 * Synchronous lexical relevance of a fact to the current objective,
 * in [0,1]. Token-overlap (a fact's significant tokens that appear in
 * the objective, normalized by the fact's token count). Deliberately
 * NOT embeddings: this runs on the synchronous prompt-assembly path, so
 * it must never block or make a network call. It is a coarse demotion
 * signal — enough to keep an off-objective fact (home-services on a
 * legal task) out of the limited prompt slots when an objective exists.
 */
export function lexicalRelevance(objective: string, content: string): number {
  const objTokens = relevanceTokens(objective);
  if (objTokens.size === 0) return 0;
  const factTokens = relevanceTokens(content);
  if (factTokens.size === 0) return 0;
  let hits = 0;
  for (const tok of factTokens) if (objTokens.has(tok)) hits += 1;
  // Blend precision (hits ÷ fact tokens) with objective COVERAGE (hits ÷
  // objective tokens). Precision alone has a short-fact bias: a detailed,
  // on-point fact with many tokens is divided by its own length and loses to a
  // short generic one (the verified "travis" failure mode). Coverage credits a
  // fact for addressing the objective's key terms regardless of its length;
  // max() keeps the [0,1] range and removes the bias without penalizing short
  // exact matches (which still score 1.0 via precision).
  const precision = hits / factTokens.size;
  const coverage = hits / objTokens.size;
  return Math.max(precision, coverage);
}

// Weights for the objective-scoped blend (Move 1 — scoped recall).
// stanfordRecallScore tops out near 2.0 (recency≤1 + importance≤1).
// RELEVANCE_WEIGHT is set high enough that a clearly on-objective fact
// reliably out-ranks an off-objective high-importance one, so the leak
// (off-topic fact occupying a prompt slot) is closed. TRUST_WEIGHT lets
// user-stated facts (trust 1.0) edge out derived ones (≈0.6) on ties.
// Bonus-only: facts never lose their base score, so a fact that is
// eligible today can only be re-ordered, never dropped below something
// that wasn't already eligible.
const RELEVANCE_WEIGHT = 2.0;
const TRUST_WEIGHT = 0.25;

function scopedRecallScore(fact: ConsolidatedFact, objective: string, nowMs: number): number {
  const base = stanfordRecallScore(fact, nowMs);
  const relevance = lexicalRelevance(objective, fact.content);
  const trust = typeof fact.trustLevel === 'number' ? fact.trustLevel : 1.0;
  return base + RELEVANCE_WEIGHT * relevance + TRUST_WEIGHT * trust;
}

/** Human-readable provenance hint for a fact, for surfacing at the
 *  confirm-first turn so the user can see WHERE a standing instruction
 *  came from before deciding to keep or prune it. */
function sourceHintOf(fact: ConsolidatedFact): string {
  const when = (fact.updatedAt || fact.createdAt || '').slice(0, 10);
  let origin = '';
  if (fact.derivedFrom?.tool) origin = `learned from ${fact.derivedFrom.tool}`;
  else if (fact.source?.path) origin = `from ${fact.source.path}`;
  else if (fact.derivedFrom?.sessionId || fact.source?.sessionId) origin = 'stated in chat';
  else origin = 'stated by you';
  return when ? `${origin} · ${when}` : origin;
}

export interface StandingInstructionReview {
  id: number;
  kind: ConsolidatedFactKind;
  content: string;
  importance: number;
  /** 0–1 lexical relevance to the objective (0 when no objective given). */
  relevance: number;
  /** Where this instruction came from, for the user's review. */
  sourceHint: string;
  /** Whether this is a pinned standing instruction (always applied). */
  pinned: boolean;
}

/**
 * Move 4 (in-loop prune): list the active standing instructions /
 * durable preferences, annotated with relevance to the current
 * objective, importance, and provenance — so the confirm-first turn can
 * show the user exactly which stored instructions are in play and let
 * them prune a stale one via `memory_forget`.
 *
 * Deliberately returns ALL of them (least-relevant first) with the
 * relevance SCORE rather than auto-flagging "delete this": lexical
 * zero-overlap is a safe demotion signal (a fact merely loses prompt
 * slots) but a dangerous deletion signal — a genuinely relevant rule can
 * share no tokens with the objective phrasing. The keep/drop judgment
 * stays with the model + user; this just hands them accurate, sourced,
 * id-bearing data to judge from.
 */
export function reviewStandingInstructions(
  objective: string | undefined,
  opts: { limit?: number } = {},
): StandingInstructionReview[] {
  const limit = Math.max(1, opts.limit ?? 20);
  const obj = objective?.trim() ?? '';
  let facts: ConsolidatedFact[];
  try {
    facts = listActiveFacts({ limit: 200, ranking: 'stanford' });
  } catch {
    return [];
  }
  return facts
    .map((fact) => ({
      id: fact.id,
      kind: fact.kind,
      content: fact.content,
      importance: typeof fact.importance === 'number' ? fact.importance : 5,
      relevance: obj ? lexicalRelevance(obj, fact.content) : 0,
      sourceHint: sourceHintOf(fact),
      pinned: fact.pinned === true,
    }))
    // Least-relevant first so a potentially off-objective instruction is
    // easy to spot at the top; break ties by importance (loudest rules
    // first).
    .sort((a, b) => (a.relevance - b.relevance) || (b.importance - a.importance))
    .slice(0, limit);
}

export function listActiveFacts(options: {
  limit?: number;
  kind?: ConsolidatedFactKind;
  /** v4: rank with Stanford retrieval score (recency + importance)
   *  instead of legacy score DESC. The instructions-render path now
   *  uses this so important + recently-accessed facts surface first. */
  ranking?: 'score' | 'stanford';
  /** Move 1 (scoped recall): when set (and ranking is 'stanford'), blend
   *  a lexical-relevance + trust bonus on top of the Stanford score so
   *  facts relevant to the current objective win the limited prompt
   *  slots. Omitted/empty → identical to the plain Stanford ranking, so
   *  the no-focus path is byte-for-byte unchanged. */
  objective?: string;
} = {}): ConsolidatedFact[] {
  const db = openMemoryDb();
  const limit = Math.max(1, options.limit ?? 12);
  const ranking = options.ranking ?? 'score';
  const objective = options.objective?.trim();

  if (ranking === 'stanford') {
    // Over-fetch then sort in JS by Stanford recall score. Keeps the
    // SQL simple — at our vault size (low thousands of facts) this is
    // negligible. The pool is pre-filtered by updated_at but scored on a
    // DIFFERENT axis (last_accessed_at + importance), so the floor must be
    // wide enough that warm high-importance facts aren't dropped before
    // scoring — see recallCandidatePoolFloor().
    const candidatePool = Math.max(limit * 5, recallCandidatePoolFloor());
    const rows = options.kind
      ? db.prepare(`
          SELECT * FROM consolidated_facts
          WHERE active = 1 AND kind = ?
          ORDER BY updated_at DESC
          LIMIT ?
        `).all(options.kind, candidatePool) as ConsolidatedFactRow[]
      : db.prepare(`
          SELECT * FROM consolidated_facts
          WHERE active = 1
          ORDER BY updated_at DESC
          LIMIT ?
        `).all(candidatePool) as ConsolidatedFactRow[];
    const now = Date.now();
    const scoreOf = objective
      ? (fact: ConsolidatedFact) => scopedRecallScore(fact, objective, now)
      : (fact: ConsolidatedFact) => stanfordRecallScore(fact, now);
    // Bonus-only semantic-relevance term: blend cosine(queryVector, factVector)
    // when the harness stashed a turn query embedding. Loaded once for the whole
    // candidate pool (sync DB read). No vector / flag off → s is unchanged.
    const queryVec = semanticRecallEnabled() ? getActiveTurnQueryVector(now) : null;
    const factVectors = queryVec ? loadFactEmbeddings(rows.map((r) => r.id)) : null;
    const wSem = semanticRecallWeight();
    return rows
      .map(rowToFact)
      .map((fact) => {
        let s = scoreOf(fact);
        if (queryVec && factVectors) {
          const v = factVectors.get(fact.id);
          if (v) s += wSem * Math.max(0, cosine(queryVec, v));
        }
        return { fact, s };
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.fact);
  }

  const rows = options.kind
    ? db.prepare(`
        SELECT * FROM consolidated_facts
        WHERE active = 1 AND kind = ?
        ORDER BY score DESC, updated_at DESC
        LIMIT ?
      `).all(options.kind, limit) as ConsolidatedFactRow[]
    : db.prepare(`
        SELECT * FROM consolidated_facts
        WHERE active = 1
        ORDER BY score DESC, updated_at DESC
        LIMIT ?
      `).all(limit) as ConsolidatedFactRow[];
  return rows.map(rowToFact);
}

export function listAllFacts(limit = 50): ConsolidatedFact[] {
  const db = openMemoryDb();
  const rows = db.prepare(`
    SELECT * FROM consolidated_facts
    ORDER BY active DESC, score DESC, updated_at DESC
    LIMIT ?
  `).all(limit) as ConsolidatedFactRow[];
  return rows.map(rowToFact);
}

export function getFact(id: number): ConsolidatedFact | null {
  const db = openMemoryDb();
  const row = db.prepare('SELECT * FROM consolidated_facts WHERE id = ?').get(id) as ConsolidatedFactRow | undefined;
  return row ? rowToFact(row) : null;
}

/**
 * Soft-delete a fact (sets active = 0). The row stays for audit/history.
 * Use {hard: true} to actually drop the row.
 */
export function forgetFact(id: number, options: { hard?: boolean } = {}): boolean {
  const db = openMemoryDb();
  if (options.hard) {
    const info = db.prepare('DELETE FROM consolidated_facts WHERE id = ?').run(id);
    return Number(info.changes ?? 0) > 0;
  }
  const info = db.prepare(`
    UPDATE consolidated_facts
    SET active = 0, updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id);
  return Number(info.changes ?? 0) > 0;
}

/**
 * Pin / unpin a fact as a standing instruction (v8). Pinned facts are
 * ALWAYS injected into the prompt, exempt from the top-N cap and recency
 * decay — so a durable rule can't age out as the fact pool grows.
 */
export function setFactPinned(id: number, pinned: boolean): boolean {
  const db = openMemoryDb();
  const info = db.prepare(`
    UPDATE consolidated_facts
    SET pinned = ?, updated_at = ?
    WHERE id = ?
  `).run(pinned ? 1 : 0, new Date().toISOString(), id);
  return Number(info.changes ?? 0) > 0;
}

/** Active pinned facts (standing instructions), newest-first. Capped so
 *  a runaway pin count can't blow the prompt budget. */
export function listPinnedFacts(limit = 12): ConsolidatedFact[] {
  const db = openMemoryDb();
  // Importance-first (recency breaks ties): a pinned rule is a durable "always
  // apply" instruction, so when more than the budget cap are pinned the LEAST
  // important should drop — not the OLDEST. Pure recency silently aged out a
  // high-importance old safety pin in favour of a trivial recent one.
  const rows = db.prepare(`
    SELECT * FROM consolidated_facts
    WHERE active = 1 AND pinned = 1
    ORDER BY COALESCE(importance, 5) DESC, updated_at DESC
    LIMIT ?
  `).all(Math.max(1, limit)) as ConsolidatedFactRow[];
  return rows.map(rowToFact);
}

/**
 * List active constraint facts. Constraints are hard rules that guard tool
 * dispatch, so ENFORCEMENT must see ALL of them — a recency LIMIT silently
 * stopped enforcing an old-but-critical safety rule once a user accumulated
 * more than the cap (e.g. >20 standing rules → the oldest mailbox/org rule
 * fell out and stopped gating dispatch). `limit` undefined ⇒ unbounded (the
 * enforcement callers in constraint-guard.ts pass nothing). A caller that
 * only DISPLAYS a subset (harness-context) passes an explicit cap; that
 * subset is ranked by importance first so the most critical rules show.
 */
export function listConstraints(limit?: number): ConsolidatedFact[] {
  const db = openMemoryDb();
  // Importance-first ordering so an explicit display cap keeps the most
  // critical rules; recency breaks ties. Enforcement (no limit) gets all rows,
  // so order is immaterial there — but consistent ordering keeps findEmail/
  // toolkit "first match wins" deterministic (highest-importance rule wins).
  const base = `SELECT * FROM consolidated_facts
    WHERE active = 1 AND kind = 'constraint'
    ORDER BY COALESCE(importance, 5) DESC, updated_at DESC`;
  const rows = (typeof limit === 'number'
    ? db.prepare(`${base} LIMIT ?`).all(Math.max(1, limit))
    : db.prepare(base).all()) as ConsolidatedFactRow[];
  return rows.map(rowToFact);
}

/**
 * Render the top-N active facts as a compact block for the assistant's
 * instructions. Empty string when no facts exist — keeps the prompt clean.
 */
// Pinned standing instructions: a runaway-safety row bound (well above any real
// pin count — the live DB has reached 40) and a generous char budget for the
// rendered block. Together they replace the old hard count of 12 that silently
// evicted genuine user rules; importance-first ordering means overflow sheds the
// least-important, and the render signals any elision.
const PINNED_RUNAWAY_CAP = 64;
const PINNED_SECTION_BUDGET = 2400;

export function renderFactsForInstructions(
  limit = 10,
  maxChars = 1600,
  objective?: string,
  // Tiered context: 'pinned' → only the always-apply standing instructions
  // (Tier-1); 'scored' → only the ranked by-kind facts (Tier-2); 'all'
  // (default) → both, byte-identical to before.
  mode: 'all' | 'pinned' | 'scored' = 'all',
): string {
  let facts: ConsolidatedFact[] = [];
  if (mode === 'pinned') {
    // pinned-only: skip the (relatively expensive) ranked retrieval entirely.
  } else try {
    // v4: Stanford-ranked retrieval. Important + recently-accessed
    // facts surface first. Touching last_accessed_at below shifts the
    // recency anchor so a fact the agent just used stays warm in the
    // next turn's context.
    //
    // Move 1 (scoped recall): when an objective is supplied, facts
    // relevant to it are promoted into the limited slots so an
    // off-objective fact (e.g. a home-services rule during legal work)
    // doesn't leak in. No objective → unchanged global ranking.
    facts = listActiveFacts({ limit, ranking: 'stanford', objective });
  } catch {
    // Don't ever break prompt assembly because the index is unhappy.
    return '';
  }

  // v8 — pinned standing instructions are ALWAYS injected, regardless of
  // the scored top-N, so a durable rule never silently ages out. They get
  // their own section and are removed from the scored set to avoid
  // double-rendering.
  // ALWAYS fetch pinned ids — even in 'scored' mode — so the scored set can
  // EXCLUDE them. A pinned fact that also ranks into the Stanford top-N would
  // otherwise render in BOTH the Tier-1 standing block ('pinned') and the
  // Tier-2 scored block ('scored'), double-sending the very rule the user
  // pinned. The pinned SECTION is only RENDERED when mode !== 'scored'.
  // Fetch well above any sane pin count (the live DB has had 40) so genuine
  // standing rules aren't cut at a hard 12 — listPinnedFacts is importance-first
  // so the runaway bound only ever sheds the LEAST important. The visible set is
  // then bounded by a CHAR budget with an explicit elision signal below (never a
  // silent count cap). Closes MEM-INJ-1: real user safety rules were evicted from
  // the "always apply" block by harness-synthetic auto-pins under the old 12-cap.
  let pinned: ConsolidatedFact[] = [];
  try {
    pinned = listPinnedFacts(PINNED_RUNAWAY_CAP);
  } catch {
    pinned = [];
  }
  const pinnedIds = new Set(pinned.map((f) => f.id));
  const renderPinned = mode !== 'scored';
  const scored = mode === 'pinned' ? [] : facts.filter((f) => !pinnedIds.has(f.id));

  if ((!renderPinned || pinned.length === 0) && scored.length === 0) return '';

  // Touch last_accessed for every fact we're about to EXPOSE to the model (the
  // act of rendering = an access in Stanford's framework). Pinned facts we
  // fetched only to filter (mode 'scored') are NOT exposed, so don't touch them.
  // NON-CRITICAL recency bookkeeping — must NEVER break prompt assembly.
  try {
    for (const fact of [...(renderPinned ? pinned : []), ...scored]) touchFactAccess(fact.id);
  } catch {
    // recency anchor will just be slightly stale — never a turn-breaker.
  }

  // Pinned standing instructions are EXEMPT from the char cap — they're the
  // user's durable rules and must NEVER be silently cut (they're already
  // hard-bounded by listPinnedFacts(12)). The maxChars cap below applies ONLY
  // to the ranked scored tail; rendering pinned first AND slicing the whole
  // join (the old behavior) cut into the standing block whenever it alone
  // exceeded maxChars, reading a half-rule as a complete one.
  // Render ALL pinned rules (importance-first) bounded by a generous CHAR budget
  // — not a hard count. On overflow, clip on a line boundary and SIGNAL the
  // elision (same primitive as the scored tail) so a dropped rule is never
  // silent and the least-important is what's shed.
  let pinnedSection = '';
  if (renderPinned && pinned.length > 0) {
    const header = '**Standing instructions (always apply)**';
    const body = pinned.map((fact) => `- ${fact.content}`).join('\n');
    if (body.length <= PINNED_SECTION_BUDGET) {
      pinnedSection = `${header}\n${body}`;
    } else {
      pinnedSection = `${header}\n${clipToLineBoundary(body, PINNED_SECTION_BUDGET)}`
        + '\n_… more standing instructions elided to fit (importance-ranked); call memory_search_facts to widen._';
    }
  }

  const byKind: Record<ConsolidatedFactKind, ConsolidatedFact[]> = {
    user: [], project: [], feedback: [], reference: [], constraint: [],
  };
  for (const fact of scored) byKind[fact.kind].push(fact);

  const titles: Record<ConsolidatedFactKind, string> = {
    user: 'About the user',
    project: 'Project context',
    feedback: 'Standing feedback',
    reference: 'References',
    constraint: 'Active Constraints',
  };

  const scoredSections: string[] = [];
  for (const kind of FACT_KINDS) {
    const group = byKind[kind];
    if (group.length === 0) continue;
    const lines = group.map((fact) => `- ${fact.content}`).join('\n');
    scoredSections.push(`**${titles[kind]}**\n${lines}`);
  }
  let scoredBlock = scoredSections.join('\n\n');

  // Cap the scored tail only, on a fact/section boundary (never mid-fact), and
  // flag the elision so the model knows recall can widen.
  const scoredBudget = Math.max(0, maxChars - (pinnedSection ? pinnedSection.length + 2 : 0));
  if (scoredBlock.length > scoredBudget) {
    scoredBlock = clipToLineBoundary(scoredBlock, scoredBudget);
    if (scoredBlock) scoredBlock += '\n_… more facts elided to fit; call memory_search_facts to widen._';
  }

  return [pinnedSection, scoredBlock].filter(Boolean).join('\n\n');
}

/** Trim `text` to at most `max` chars on a newline boundary (never mid-line),
 *  so a fact is never cut mid-sentence. */
function clipToLineBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return (nl > 0 ? cut.slice(0, nl) : cut).trimEnd();
}

export function countActiveFacts(): number {
  try {
    const db = openMemoryDb();
    const row = db.prepare('SELECT COUNT(*) AS c FROM consolidated_facts WHERE active = 1').get() as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}

export interface DecayOptions {
  /** Max facts to soft-delete in a single pass (blast-radius cap). */
  maxDeactivate?: number;
  /** Only consider facts idle (no access/update) for at least this many days. */
  minIdleDays?: number;
  /** Only consider facts whose importance is at or below this (1–10).
   *  Default 4 is strictly BELOW the 5.0 default, so the majority of
   *  facts (default-importance, never reflection-scored) are NEVER
   *  evicted by decay — only facts the reflector judged low-salience. */
  importanceCeil?: number;
  /** Soft-delete only when the Stanford recall score is below this floor. */
  scoreFloor?: number;
  /** v11 — importance-AWARE decay: instead of the binary importance≤ceil gate
   *  (which makes the importance≥5 tail structurally immortal), scale the idle
   *  threshold by importance × access-frequency so even a high-importance fact
   *  can fade after MONTHS of total disuse, while proven-useful ones are
   *  protected longer. Default from CLEMMY_DECAY_IMPORTANCE_AWARE (off). */
  importanceAware?: boolean;
  nowMs?: number;
}

export interface DecayResult {
  scanned: number;
  deactivated: number;
  ids: number[];
  /** Per-eviction human-readable reason ("#42 imp:2 score:0.31"), for the
   *  reviewable hygiene audit log — so the owner can see WHY a fact decayed. */
  reasons: string[];
}

/**
 * Forgetting / staleness eviction (Tier A2). Soft-deletes (active=0)
 * active, NON-PINNED facts that are simultaneously (a) idle past
 * `minIdleDays`, (b) low-importance (<= `importanceCeil`, default 4 — below
 * the 5.0 default so the bulk of the store is protected), and (c) below the
 * Stanford recall-score floor. Bounded by `maxDeactivate` per run.
 *
 * Decay is a STORAGE complement to the existing RANKING-time recency decay
 * (`stanfordRecallScore`): ranking demotes stale facts in the prompt; this
 * actually retires the long, low-value tail so the fact store stops growing
 * unbounded. Conservative by design and flag-gated off — the owner tunes the
 * thresholds from telemetry, mirroring CLEMMY_REFLECTION_THRESHOLD.
 *
 * Soft delete only (active=0): the row, its embedding, and its audit trail
 * survive for re-activation, exactly like `deleteFact`/Mem0 DELETE.
 */
/** Idle days before a fact is eligible to decay in importance-aware mode,
 *  scaled by importance (more important → protected longer) and access
 *  frequency (proven-useful → protected longer). With base 60d:
 *  imp1/0-access ≈ 36d, imp5/0 ≈ 60d, imp8/0 ≈ 78d, imp10/50-access ≈ 270d. */
export function importanceAwareIdleThresholdDays(fact: ConsolidatedFact, baseIdleDays: number): number {
  const importance = typeof fact.importance === 'number' ? fact.importance : 5;
  const importanceFactor = 0.5 + importance / 10;
  const accessFactor = 1 + 0.5 * Math.log1p(Math.max(0, fact.accessCount ?? 0));
  return baseIdleDays * importanceFactor * accessFactor;
}

function decayImportanceAwareEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_DECAY_IMPORTANCE_AWARE', 'off') || 'off').toLowerCase() === 'on';
}

export function decayAndEvictFacts(options: DecayOptions = {}): DecayResult {
  const maxDeactivate = Math.max(0, options.maxDeactivate ?? 100);
  const minIdleDays = Math.max(1, options.minIdleDays ?? 60);
  const importanceCeil = Math.max(1, Math.min(10, options.importanceCeil ?? 4));
  const scoreFloor = options.scoreFloor ?? 0.4;
  const importanceAware = options.importanceAware ?? decayImportanceAwareEnabled();
  const nowMs = options.nowMs ?? Date.now();
  const result: DecayResult = { scanned: 0, deactivated: 0, ids: [], reasons: [] };
  if (maxDeactivate === 0) return result;

  const db = openMemoryDb();

  if (importanceAware) {
    // Fetch broadly-idle, unpinned candidates (idle ≥ the smallest possible
    // threshold = base × 0.6 for imp1/0-access) then apply the per-fact
    // importance×access threshold in JS. Most-idle first.
    const minThresholdDays = minIdleDays * 0.6;
    const minCutoff = new Date(nowMs - minThresholdDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT * FROM consolidated_facts
      WHERE active = 1
        AND pinned = 0
        AND COALESCE(last_accessed_at, extracted_at, updated_at, created_at) < ?
      ORDER BY COALESCE(last_accessed_at, updated_at, created_at) ASC
      LIMIT ?
    `).all(minCutoff, maxDeactivate * 8) as ConsolidatedFactRow[];
    for (const row of rows) {
      result.scanned += 1;
      if (result.deactivated >= maxDeactivate) break;
      const fact = rowToFact(row);
      const anchorIso = fact.lastAccessedAt || fact.extractedAt || fact.updatedAt || fact.createdAt;
      const idleDays = (nowMs - Date.parse(anchorIso)) / (24 * 60 * 60 * 1000);
      const threshold = importanceAwareIdleThresholdDays(fact, minIdleDays);
      if (!(idleDays >= threshold)) continue;
      if (deleteFact(fact.id)) {
        result.deactivated += 1;
        result.ids.push(fact.id);
        result.reasons.push(`#${fact.id} imp:${fact.importance ?? 5} idle:${idleDays.toFixed(0)}d/${threshold.toFixed(0)}d acc:${fact.accessCount ?? 0}`);
      }
    }
    return result;
  }

  const idleCutoff = new Date(nowMs - minIdleDays * 24 * 60 * 60 * 1000).toISOString();
  // Candidate set: active, unpinned, idle, low-importance. Over-fetch (×4)
  // so the score-floor filter below still has room to hit maxDeactivate.
  const rows = db.prepare(`
    SELECT * FROM consolidated_facts
    WHERE active = 1
      AND pinned = 0
      AND COALESCE(last_accessed_at, extracted_at, updated_at, created_at) < ?
      AND COALESCE(importance, 5) <= ?
    ORDER BY COALESCE(last_accessed_at, updated_at, created_at) ASC
    LIMIT ?
  `).all(idleCutoff, importanceCeil, maxDeactivate * 4) as ConsolidatedFactRow[];

  for (const row of rows) {
    result.scanned += 1;
    if (result.deactivated >= maxDeactivate) break;
    const fact = rowToFact(row);
    // Final gate: even an idle low-importance fact survives if its Stanford
    // recall score is still above the floor (e.g. importance was bumped).
    const score = stanfordRecallScore(fact, nowMs);
    if (score > scoreFloor) continue;
    if (deleteFact(fact.id)) {
      result.deactivated += 1;
      result.ids.push(fact.id);
      result.reasons.push(`#${fact.id} imp:${fact.importance ?? 5} score:${score.toFixed(2)}`);
    }
  }
  return result;
}
