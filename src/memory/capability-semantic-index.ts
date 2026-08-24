/**
 * SEMANTIC RETRIEVAL over the capability index — the source leg's missing sense.
 *
 * Measured 2026-08-21 on a live install holding 2,368 operations across 419
 * carriers: for the objective "Find the top 5 restaurants and put them on a new
 * spreadsheet", lexical retrieval ranked `FIRECRAWL_SEARCH` — the only indexed
 * capability that can answer the ask — **62nd**. The shortlist is 24, so the
 * binder never saw it and refused the turn. What won instead was
 * `GOOGLESHEETS_FIND_REPLACE` and `SLACK_FIND_CHANNELS`, on the function word
 * "find", and `REDDIT_GET_R_TOP`, on "top".
 *
 * That is not a tuning problem. BM25 requires the user to speak the vendor's
 * vocabulary: nothing in the index contains the word "restaurants", so the one
 * capability whose description reads "performs a web search for a query" is
 * unreachable from the sentence a person actually types. On a blank install —
 * which is the whole product premise — there is no use-derived history to
 * compensate. Retrieval by MEANING is what makes an arbitrary ask reach an
 * arbitrary tool.
 *
 * Two measured properties shape the design:
 *
 *  1. EFFECT SCOPING IS LOAD-BEARING. Embedding the whole objective ranks the
 *     DESTINATION above the SOURCE (`GOOGLESHEETS_SHEET_FROM_JSON` 0.386 vs
 *     `FIRECRAWL_SEARCH` 0.259) because the sentence names its destination.
 *     Filtering to `effectClass: 'read'` removes the writes that were drowning
 *     the source and `FIRECRAWL_SEARCH` becomes rank 1. A role that knows the
 *     effect it needs must say so.
 *  2. LEXICAL STILL EARNS ITS KEEP. An exact slug or carrier name ("run
 *     FIRECRAWL_SCRAPE", "check dataforseo") is precisely what BM25 is good at
 *     and embeddings blur. The two are fused rather than swapped.
 *
 * Embedding happens at INDEX time, never on the request path: `embedQuery` costs
 * ~1.6s cold. Retrieval embeds only the query. A missing, disabled, or
 * still-backfilling embedding space degrades to pure lexical — the same rule the
 * index already follows for a cold store, because a capability that cannot be
 * ranked well must still be reachable.
 */
import { createHash } from 'node:crypto';
import { capabilityIndexDatabase, type CapabilityOperationHit } from './capability-index.js';
import type { CapabilityCarrierKind, CapabilityEffectClass } from './capability-index.js';
import { embedQuery, embedTexts, localEmbeddingSpaceKey } from './embeddings.js';

/** One backfill tick. Bounded so a boot reconcile never saturates the provider. */
const DEFAULT_BACKFILL_LIMIT = 256;
/** Provider batch size; mirrors the fact-embedding backfill's shape. */
const EMBED_BATCH = 32;
/** Reciprocal-rank-fusion constant. 60 is the standard published value. */
const RRF_K = 60;

/**
 * The embedding space, injectable for tests.
 *
 * CI runs with `CLEMMY_LOCAL_EMBEDDINGS=off` (scripts/run-tests-isolated.mjs),
 * so a pin that calls the real provider silently degrades to asserting nothing.
 * A deterministic stand-in keeps the RANKING LOGIC pinned — fusion order, effect
 * scoping, resumable backfill — independently of whether a model is present,
 * which is the part that can actually regress.
 */
export interface CapabilityEmbedder {
  spaceKey(): string;
  embedOne(text: string): Promise<Float32Array | null>;
  embedMany(texts: string[]): Promise<Float32Array[] | null>;
}

const productionEmbedder: CapabilityEmbedder = {
  spaceKey: () => localEmbeddingSpaceKey(),
  embedOne: (text) => embedQuery(text),
  embedMany: (texts) => embedTexts(texts),
};

let embedder: CapabilityEmbedder = productionEmbedder;

/** Test seam. Pass nothing to restore the real local embedding provider. */
export function _setCapabilityEmbedderForTest(next?: CapabilityEmbedder): void {
  embedder = next ?? productionEmbedder;
}

export interface CapabilityEmbeddingStats {
  enabled: boolean;
  candidates: number;
  embedded: number;
  failed: number;
  durationMs: number;
  reason?: string;
}

/**
 * The text a capability is embedded AS. Carrier and display name carry real
 * signal ("firecrawl", "Search the web"); the raw identifier does not — it is
 * SCREAMING_SNAKE vendor boilerplate whose tokens ("GET", "CREATE", "TASK")
 * pull unrelated operations together in embedding space the same way they do
 * in BM25.
 */
function embeddableText(row: { carrier: string; displayName: string; description: string }): string {
  return `${row.carrier} ${row.displayName}. ${row.description}`.replace(/\s+/g, ' ').trim();
}

function contentHash(text: string, model: string): string {
  return createHash('sha256').update(`${model}\n${text}`).digest('hex');
}

function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function fromBlob(blob: Buffer): Float32Array {
  // Copy: the Buffer is owned by better-sqlite3 and may be reused.
  const copy = new ArrayBuffer(blob.byteLength);
  new Uint8Array(copy).set(blob);
  return new Float32Array(copy);
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Embed operations that have no current vector. Idempotent and resumable: a row
 * is a candidate when it has no embedding, or when its text or the embedding
 * space changed, so a re-enumeration that rewrites a description re-embeds only
 * what moved. Never throws — a provider outage leaves the index lexical.
 */
export async function embedMissingCapabilityOperations(
  options: { maxOperations?: number } = {},
): Promise<CapabilityEmbeddingStats> {
  const startedAt = Date.now();
  const stats: CapabilityEmbeddingStats = {
    enabled: true, candidates: 0, embedded: 0, failed: 0, durationMs: 0,
  };
  let model: string;
  try {
    model = embedder.spaceKey();
  } catch {
    return { ...stats, enabled: false, reason: 'no embedding space', durationMs: Date.now() - startedAt };
  }
  const limit = Math.max(1, options.maxOperations ?? DEFAULT_BACKFILL_LIMIT);
  try {
    const db = capabilityIndexDatabase();
    const rows = db.prepare(`
      SELECT ops.identifier, ops.account_identity, ops.carrier, ops.display_name, ops.description
        FROM capability_operations AS ops
        LEFT JOIN capability_embeddings AS emb
          ON emb.identifier = ops.identifier AND emb.account_identity = ops.account_identity
       WHERE ops.active = 1
         AND (emb.identifier IS NULL OR emb.model != ?)
       LIMIT ?
    `).all(model, limit) as Array<Record<string, unknown>>;

    const pending = rows.map((row) => {
      const text = embeddableText({
        carrier: String(row.carrier ?? ''),
        displayName: String(row.display_name ?? ''),
        description: String(row.description ?? ''),
      });
      return {
        identifier: String(row.identifier ?? ''),
        account: String(row.account_identity ?? ''),
        text,
        hash: contentHash(text, model),
      };
    }).filter((row) => row.identifier && row.text);

    stats.candidates = pending.length;
    if (pending.length === 0) return { ...stats, durationMs: Date.now() - startedAt };

    const insert = db.prepare(`
      INSERT OR REPLACE INTO capability_embeddings
        (identifier, account_identity, model, dim, vector, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();

    for (let offset = 0; offset < pending.length; offset += EMBED_BATCH) {
      const batch = pending.slice(offset, offset + EMBED_BATCH);
      const vectors = await embedder.embedMany(batch.map((row) => row.text));
      if (!vectors) {
        // Disabled, cooling down, or failed: stop cleanly, keep what landed.
        stats.failed += batch.length;
        return {
          ...stats,
          enabled: stats.embedded > 0,
          reason: 'embedding provider unavailable',
          durationMs: Date.now() - startedAt,
        };
      }
      const write = db.transaction(() => {
        batch.forEach((row, index) => {
          const vector = vectors[index];
          if (!vector) { stats.failed += 1; return; }
          insert.run(row.identifier, row.account, model, vector.length, toBlob(vector), row.hash, now);
          stats.embedded += 1;
        });
      });
      write();
    }
    return { ...stats, durationMs: Date.now() - startedAt };
  } catch {
    return { ...stats, enabled: false, reason: 'index unavailable', durationMs: Date.now() - startedAt };
  }
}

export interface CapabilityRetrievalOptions {
  limit?: number;
  carrierKind?: CapabilityCarrierKind;
  /**
   * Scope to one effect class. Load-bearing for the source leg: an objective
   * that names its destination ranks writes above reads, so a role that needs a
   * read must say so or the destination drowns the source.
   */
  effectClass?: CapabilityEffectClass;
}

interface StoredVector {
  identifier: string;
  account: string;
  vector: Float32Array;
}

function loadVectors(model: string, options: CapabilityRetrievalOptions): StoredVector[] {
  const filters = ['ops.active = 1', 'emb.model = ?'];
  const params: unknown[] = [model];
  if (options.carrierKind) { filters.push('ops.carrier_kind = ?'); params.push(options.carrierKind); }
  if (options.effectClass) { filters.push('ops.effect_class = ?'); params.push(options.effectClass); }
  const rows = capabilityIndexDatabase().prepare(`
    SELECT emb.identifier, emb.account_identity, emb.vector
      FROM capability_embeddings AS emb
      JOIN capability_operations AS ops
        ON ops.identifier = emb.identifier AND ops.account_identity = emb.account_identity
     WHERE ${filters.join(' AND ')}
  `).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    identifier: String(row.identifier ?? ''),
    account: String(row.account_identity ?? ''),
    vector: fromBlob(row.vector as Buffer),
  }));
}

/**
 * Semantic-only shortlist. Exposed for measurement and for callers that want
 * meaning without lexical interference; ordinary retrieval should use
 * `retrieveCapabilityOperations`, which fuses both.
 */
export async function semanticCapabilityCandidates(
  query: string,
  options: CapabilityRetrievalOptions = {},
): Promise<Array<{ identifier: string; account: string; similarity: number }>> {
  const text = query.trim();
  if (!text) return [];
  try {
    const model = embedder.spaceKey();
    const stored = loadVectors(model, options);
    if (stored.length === 0) return [];
    const queryVector = await embedder.embedOne(text);
    if (!queryVector) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    return stored
      .map((row) => ({
        identifier: row.identifier,
        account: row.account,
        similarity: cosine(queryVector, row.vector),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * HYBRID retrieval: lexical and semantic fused by reciprocal rank.
 *
 * RRF is used rather than a weighted score blend because bm25 and cosine are not
 * commensurable — one is unbounded and corpus-relative, the other is a bounded
 * angle — and any fixed weighting between them is a constant that would need
 * retuning per install. Rank position is comparable by construction.
 *
 * Degrades to exactly the lexical result when embeddings are absent, so a cold
 * or disabled embedding space costs reachability nothing.
 */
export async function retrieveCapabilityOperations(
  query: string,
  options: CapabilityRetrievalOptions = {},
): Promise<CapabilityOperationHit[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  // Over-fetch each arm so fusion has room to reorder before truncating.
  const armLimit = Math.min(100, Math.max(limit * 3, 30));
  const { searchCapabilityOperations } = await import('./capability-index.js');
  const lexical = searchCapabilityOperations(query, { ...options, limit: armLimit });
  const semantic = await semanticCapabilityCandidates(query, { ...options, limit: armLimit });
  if (semantic.length === 0) return lexical.slice(0, limit);

  const keyOf = (identifier: string, account: string): string => `${identifier}\u0000${account}`;
  const fused = new Map<string, { hit?: CapabilityOperationHit; score: number }>();
  lexical.forEach((hit, index) => {
    const key = keyOf(hit.identifier, hit.accountIdentity ?? '');
    fused.set(key, { hit, score: 1 / (RRF_K + index + 1) });
  });
  semantic.forEach((candidate, index) => {
    const key = keyOf(candidate.identifier, candidate.account);
    const existing = fused.get(key);
    const contribution = 1 / (RRF_K + index + 1);
    if (existing) existing.score += contribution;
    else fused.set(key, { score: contribution });
  });

  // Semantic-only winners have no row yet; fetch them in one pass.
  const missing = [...fused.entries()].filter(([, value]) => !value.hit);
  if (missing.length > 0) {
    try {
      const placeholders = missing.map(() => '(identifier = ? AND account_identity = ?)').join(' OR ');
      const params = missing.flatMap(([key]) => key.split('\u0000'));
      const rows = capabilityIndexDatabase().prepare(`
        SELECT * FROM capability_operations WHERE active = 1 AND (${placeholders})
      `).all(...params) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const key = keyOf(String(row.identifier ?? ''), String(row.account_identity ?? ''));
        const entry = fused.get(key);
        if (!entry) continue;
        const account = String(row.account_identity ?? '');
        entry.hit = {
          identifier: String(row.identifier ?? ''),
          carrierKind: String(row.carrier_kind ?? 'composio') as CapabilityCarrierKind,
          carrier: String(row.carrier ?? ''),
          displayName: String(row.display_name ?? ''),
          description: String(row.description ?? ''),
          effectClass: String(row.effect_class ?? 'unknown') as CapabilityEffectClass,
          effectProvenance: String(row.effect_provenance ?? 'none') as never,
          ...(account ? { accountIdentity: account } : {}),
          score: 0,
        };
      }
    } catch {
      // Fall through: entries without a row are dropped below.
    }
  }

  const ranked = [...fused.values()]
    .filter((entry): entry is { hit: CapabilityOperationHit; score: number } => Boolean(entry.hit))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return ranked.map((entry, index) => ({
    ...entry.hit,
    score: Math.max(0, 1 - index / Math.max(1, ranked.length)),
  }));
}

/** Coverage of the semantic space, for the boot reconcile's log line. */
export function capabilityEmbeddingCoverage(): { operations: number; embedded: number } {
  try {
    const db = capabilityIndexDatabase();
    const operations = (db.prepare('SELECT COUNT(*) AS n FROM capability_operations WHERE active = 1')
      .get() as { n: number }).n;
    const embedded = (db.prepare(`
      SELECT COUNT(*) AS n FROM capability_embeddings AS emb
        JOIN capability_operations AS ops
          ON ops.identifier = emb.identifier AND ops.account_identity = emb.account_identity
       WHERE ops.active = 1
    `).get() as { n: number }).n;
    return { operations, embedded };
  } catch {
    return { operations: 0, embedded: 0 };
  }
}
