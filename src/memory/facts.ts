import { createHash } from 'node:crypto';
import { openMemoryDb, type ConsolidatedFactKind, type ConsolidatedFactRow } from './db.js';
import { cosine, embedQuery, isEmbeddingsEnabled, loadFactEmbeddings } from './embeddings.js';

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
}

export const FACT_KINDS: ConsolidatedFactKind[] = ['user', 'project', 'feedback', 'reference'];

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
          importance              = MAX(COALESCE(importance, 0), ?)
      WHERE id = ?
    `).run(now, input.sessionId ?? null, input.path ?? null,
           dfSession, dfCall, dfTool, trust, extractedAt, importance, existing.id);
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
       derivation_depth, derived_from_fact_ids)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.kind, content, hash, input.sessionId ?? null, input.path ?? null,
         initialScore, now, now,
         dfSession, dfCall, dfTool, trust, extractedAt, importance,
         derivationDepth, derivedFromIdsJson);

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
    db.prepare('UPDATE consolidated_facts SET last_accessed_at = ? WHERE id = ?')
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
        source_session_id = COALESCE(?, source_session_id)
    WHERE id = ?
  `).run(newContent, newHash, now, now, newTrust, newImportance, patch.sessionId ?? null, id);
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
export async function findSimilarFacts(
  content: string,
  options: { kind?: ConsolidatedFactKind; topK?: number } = {},
): Promise<ConsolidatedFact[]> {
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
      const poolRows = (options.kind
        ? db.prepare('SELECT id FROM consolidated_facts WHERE active = 1 AND kind = ? ORDER BY updated_at DESC LIMIT 500').all(options.kind)
        : db.prepare('SELECT id FROM consolidated_facts WHERE active = 1 ORDER BY updated_at DESC LIMIT 500').all()) as { id: number }[];
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
          const topIds = scored.slice(0, topK).map((s) => s.id);
          if (topIds.length > 0) {
            const placeholders = topIds.map(() => '?').join(',');
            const factRows = db.prepare(
              `SELECT * FROM consolidated_facts WHERE id IN (${placeholders})`
            ).all(...topIds) as ConsolidatedFactRow[];
            const byId = new Map(factRows.map((r) => [r.id, r]));
            // Preserve cosine order.
            return topIds
              .map((id) => byId.get(id))
              .filter((r): r is ConsolidatedFactRow => Boolean(r))
              .map(rowToFact);
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

  // Score by token-occurrence count, return top-K.
  const scored = matches.map((row) => {
    const lc = row.content.toLowerCase();
    const hits = tokens.reduce((sum, t) => sum + (lc.includes(t) ? 1 : 0), 0);
    return { row, hits };
  });
  scored.sort((a, b) => b.hits - a.hits || (b.row.updated_at || '').localeCompare(a.row.updated_at || ''));
  return scored.slice(0, topK).map((s) => rowToFact(s.row));
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
  maxChars = 1200,
): string {
  const facts = listRecentlyLearnedFacts({ sinceHours, limit });
  if (facts.length === 0) return '';
  const lines: string[] = [];
  let used = 0;
  for (const fact of facts) {
    const callRef = fact.derivedFrom?.callId ? ` [${fact.derivedFrom.callId}]` : '';
    const toolRef = fact.derivedFrom?.tool ? ` (from ${fact.derivedFrom.tool})` : '';
    const line = `- ${fact.content}${callRef}${toolRef}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
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
    ORDER BY extracted_at DESC, id DESC
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

export function stanfordRecallScore(fact: ConsolidatedFact, nowMs: number = Date.now()): number {
  const accessIso = fact.lastAccessedAt || fact.extractedAt || fact.updatedAt || fact.createdAt;
  const accessedAtMs = Date.parse(accessIso);
  const hoursSince = Number.isFinite(accessedAtMs)
    ? Math.max(0, (nowMs - accessedAtMs) / 3_600_000)
    : 0;
  const recency = Math.exp(-STANFORD_RECENCY_DECAY_RATE * hoursSince);
  const importance = (typeof fact.importance === 'number' ? fact.importance : 5.0) / 10;
  // recency + importance (no relevance component for non-query reads)
  return recency + importance;
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
  return hits / factTokens.size;
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
    // negligible. The over-fetch factor (5×) caps the candidate pool
    // so we never sort the whole table.
    const candidatePool = Math.max(limit * 5, 100);
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
    return rows
      .map(rowToFact)
      .map((fact) => ({ fact, s: scoreOf(fact) }))
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
  const rows = db.prepare(`
    SELECT * FROM consolidated_facts
    WHERE active = 1 AND pinned = 1
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(Math.max(1, limit)) as ConsolidatedFactRow[];
  return rows.map(rowToFact);
}

/**
 * Render the top-N active facts as a compact block for the assistant's
 * instructions. Empty string when no facts exist — keeps the prompt clean.
 */
export function renderFactsForInstructions(limit = 10, maxChars = 1600, objective?: string): string {
  let facts: ConsolidatedFact[] = [];
  try {
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
  let pinned: ConsolidatedFact[] = [];
  try {
    pinned = listPinnedFacts(12);
  } catch {
    pinned = [];
  }
  const pinnedIds = new Set(pinned.map((f) => f.id));
  const scored = facts.filter((f) => !pinnedIds.has(f.id));

  if (pinned.length === 0 && scored.length === 0) return '';

  // Touch last_accessed for every fact we're about to expose to the
  // model (the act of rendering = an access in Stanford's framework).
  // NON-CRITICAL recency bookkeeping — must NEVER break prompt assembly.
  // Previously unguarded: a transient SQLite WAL/busy error here threw
  // straight out of renderFactsForInstructions and could fail the whole
  // turn. Swallow per-loop so the facts still render even if the touch
  // can't be written this tick.
  try {
    for (const fact of [...pinned, ...scored]) touchFactAccess(fact.id);
  } catch {
    // recency anchor will just be slightly stale — never a turn-breaker.
  }

  const sections: string[] = [];

  if (pinned.length > 0) {
    const lines = pinned.map((fact) => `- ${fact.content}`).join('\n');
    sections.push(`**Standing instructions (always apply)**\n${lines}`);
  }

  const byKind: Record<ConsolidatedFactKind, ConsolidatedFact[]> = {
    user: [], project: [], feedback: [], reference: [],
  };
  for (const fact of scored) byKind[fact.kind].push(fact);

  const titles: Record<ConsolidatedFactKind, string> = {
    user: 'About the user',
    project: 'Project context',
    feedback: 'Standing feedback',
    reference: 'References',
  };

  for (const kind of FACT_KINDS) {
    const group = byKind[kind];
    if (group.length === 0) continue;
    const lines = group.map((fact) => `- ${fact.content}`).join('\n');
    sections.push(`**${titles[kind]}**\n${lines}`);
  }

  return sections.join('\n\n').slice(0, maxChars);
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
