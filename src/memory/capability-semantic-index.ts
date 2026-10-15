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
import {
  getLocalEmbeddingProvider, isUsableEmbeddingVector, localEmbeddingProviderSync,
  localEmbeddingSpaceKey, type EmbeddingProvider,
} from './embeddings.js';

/** One backfill tick. Bounded so a boot reconcile never saturates the provider. */
const DEFAULT_BACKFILL_LIMIT = 256;
/** Provider batch size; mirrors the fact-embedding backfill's shape. */
const EMBED_BATCH = 32;
/** Reciprocal-rank-fusion constant. 60 is the standard published value. */
const RRF_K = 60;
const QUERY_BUDGET_MS = 900;
const BACKFILL_BUDGET_MS = 60_000;

interface CapabilityEmbeddingOptions { deadlineAtMs?: number }

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
  embedOne(text: string, options?: CapabilityEmbeddingOptions): Promise<Float32Array | null>;
  embedMany(texts: string[], options?: CapabilityEmbeddingOptions): Promise<Float32Array[] | null>;
}

function providerSpace(provider: EmbeddingProvider): string {
  return `${provider.name}:${provider.model}:${provider.dim}`;
}

function validVectors(vectors: Float32Array[] | null, count: number, dim?: number): vectors is Float32Array[] {
  return Array.isArray(vectors) && vectors.length === count
    && vectors.every((vector) => vector instanceof Float32Array
      && isUsableEmbeddingVector(vector, dim ?? vectors[0]?.length ?? 0));
}

const productionEmbedder: CapabilityEmbedder = {
  spaceKey: () => {
    const provider = localEmbeddingProviderSync();
    return provider ? providerSpace(provider) : localEmbeddingSpaceKey();
  },
  async embedOne(text, options = {}) {
    // Request-path retrieval can use an already warm LOCAL model only. A
    // configured remote embedder never produces rows labeled as local here.
    const provider = localEmbeddingProviderSync();
    if (!provider || provider.name !== 'local') return null;
    const space = providerSpace(provider);
    const vectors = await provider.embed([text], {
      priority: 'foreground', deadlineAtMs: options.deadlineAtMs ?? Date.now() + QUERY_BUDGET_MS,
    });
    return localEmbeddingProviderSync() === provider && providerSpace(provider) === space
      && validVectors(vectors, 1, provider.dim) ? vectors[0] : null;
  },
  async embedMany(texts, options = {}) {
    const deadlineAtMs = options.deadlineAtMs ?? Date.now() + BACKFILL_BUDGET_MS;
    const expectedSpace = productionEmbedder.spaceKey();
    const provider = await getLocalEmbeddingProvider();
    if (!provider || provider.name !== 'local' || providerSpace(provider) !== expectedSpace || Date.now() >= deadlineAtMs) return null;
    const vectors = await provider.embed(texts, {
      priority: 'background', deadlineAtMs,
    });
    return localEmbeddingProviderSync() === provider && providerSpace(provider) === expectedSpace
      && validVectors(vectors, texts.length, provider.dim) ? vectors : null;
  },
};

let embedder: CapabilityEmbedder = productionEmbedder;
let embedderGeneration = 0;

/** Test seam. Pass nothing to restore the real local embedding provider. */
export function _setCapabilityEmbedderForTest(next?: CapabilityEmbedder): void {
  embedderGeneration++;
  embedder = next ?? productionEmbedder;
}

async function withinDeadline<T>(work: () => Promise<T | null>, deadlineAtMs: number): Promise<T | null> {
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      work(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining); }),
    ]);
    return Date.now() < deadlineAtMs ? result : null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Production keys end in their declared dimensionality; custom test keys
 * may be opaque, in which case vectors must still be internally consistent. */
function dimensionOfSpace(space: string): number | undefined {
  const raw = /:(\d+)$/.exec(space)?.[1];
  const dim = raw === undefined ? undefined : Number(raw);
  return dim && Number.isSafeInteger(dim) ? dim : undefined;
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
  options: { maxOperations?: number; deadlineAtMs?: number } = {},
): Promise<CapabilityEmbeddingStats> {
  const startedAt = Date.now();
  const stats: CapabilityEmbeddingStats = {
    enabled: true, candidates: 0, embedded: 0, failed: 0, durationMs: 0,
  };
  const operationEmbedder = embedder;
  const generation = embedderGeneration;
  let model: string;
  try {
    model = operationEmbedder.spaceKey();
  } catch {
    return { ...stats, enabled: false, reason: 'no embedding space', durationMs: Date.now() - startedAt };
  }
  const limit = Math.max(1, options.maxOperations ?? DEFAULT_BACKFILL_LIMIT);
  const deadlineAtMs = options.deadlineAtMs ?? Date.now() + BACKFILL_BUDGET_MS;
  const isCurrent = () => embedder === operationEmbedder && embedderGeneration === generation
    && operationEmbedder.spaceKey() === model;
  try {
    const db = capabilityIndexDatabase();
    const rows = db.prepare(`
      SELECT ops.identifier, ops.account_identity, ops.carrier, ops.display_name, ops.description,
             emb.model AS embedding_model, emb.dim AS embedding_dim,
             emb.content_hash AS embedding_hash
        FROM capability_operations AS ops
        LEFT JOIN capability_embeddings AS emb
          ON emb.identifier = ops.identifier AND emb.account_identity = ops.account_identity
       WHERE ops.active = 1
    `).iterate() as IterableIterator<Record<string, unknown>>;

    const pending: Array<{ identifier: string; account: string; text: string; hash: string }> = [];
    const expectedDim = dimensionOfSpace(model);
    for (const row of rows) {
      if (Date.now() >= deadlineAtMs) {
        return { ...stats, enabled: false, reason: 'embedding deadline ended', durationMs: Date.now() - startedAt };
      }
      const text = embeddableText({
        carrier: String(row.carrier ?? ''),
        displayName: String(row.display_name ?? ''),
        description: String(row.description ?? ''),
      });
      const hash = contentHash(text, model);
      const identifier = String(row.identifier ?? '');
      const missing = row.embedding_model !== model || row.embedding_hash !== hash
        || (expectedDim !== undefined && row.embedding_dim !== expectedDim);
      if (!identifier || !text || !missing) continue;
      pending.push({ identifier, account: String(row.account_identity ?? ''), text, hash });
      if (pending.length >= limit) break;
    }

    stats.candidates = pending.length;
    if (pending.length === 0) return { ...stats, durationMs: Date.now() - startedAt };

    const insert = db.prepare(`
      INSERT OR REPLACE INTO capability_embeddings
        (identifier, account_identity, model, dim, vector, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    const currentOperation = db.prepare(`
      SELECT carrier, display_name, description FROM capability_operations
       WHERE identifier = ? AND account_identity = ? AND active = 1
    `);

    for (let offset = 0; offset < pending.length; offset += EMBED_BATCH) {
      const batch = pending.slice(offset, offset + EMBED_BATCH);
      if (!isCurrent()) return { ...stats, enabled: false, reason: 'embedding space changed', durationMs: Date.now() - startedAt };
      const vectors = await withinDeadline(
        () => operationEmbedder.embedMany(batch.map((row) => row.text), { deadlineAtMs }), deadlineAtMs,
      );
      if (!isCurrent() || !validVectors(vectors, batch.length, dimensionOfSpace(model))) {
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
          const current = currentOperation.get(row.identifier, row.account) as Record<string, unknown> | undefined;
          const currentText = current && embeddableText({
            carrier: String(current.carrier ?? ''), displayName: String(current.display_name ?? ''),
            description: String(current.description ?? ''),
          });
          if (!currentText || contentHash(currentText, model) !== row.hash) { stats.failed += 1; return; }
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
  deadlineAtMs?: number;
}

interface StoredVector {
  identifier: string;
  account: string;
  vector: Float32Array;
}

function loadVectors(model: string, options: CapabilityRetrievalOptions, firstOnly = false): StoredVector[] {
  const filters = ['ops.active = 1', 'emb.model = ?'];
  const params: unknown[] = [model];
  if (options.carrierKind) { filters.push('ops.carrier_kind = ?'); params.push(options.carrierKind); }
  if (options.effectClass) { filters.push('ops.effect_class = ?'); params.push(options.effectClass); }
  const rows = capabilityIndexDatabase().prepare(`
    SELECT emb.identifier, emb.account_identity, emb.vector, emb.dim, emb.content_hash,
           ops.carrier, ops.display_name, ops.description
      FROM capability_embeddings AS emb
      JOIN capability_operations AS ops
        ON ops.identifier = emb.identifier AND ops.account_identity = emb.account_identity
     WHERE ${filters.join(' AND ')}
  `).iterate(...params) as IterableIterator<Record<string, unknown>>;
  const vectors: StoredVector[] = [];
  const expectedDim = dimensionOfSpace(model);
  for (const row of rows) {
    if (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs) return [];
    try {
      const vector = fromBlob(row.vector as Buffer);
      const text = embeddableText({
        carrier: String(row.carrier ?? ''), displayName: String(row.display_name ?? ''), description: String(row.description ?? ''),
      });
      if (row.content_hash !== contentHash(text, model) || row.dim !== vector.length
        || !validVectors([vector], 1, expectedDim)) continue;
      vectors.push({ identifier: String(row.identifier ?? ''), account: String(row.account_identity ?? ''), vector });
      if (firstOnly) break;
    } catch { /* A malformed advisory row cannot disable the remaining index. */ }
  }
  return vectors;
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
    const operationEmbedder = embedder;
    const generation = embedderGeneration;
    const model = operationEmbedder.spaceKey();
    const deadlineAtMs = options.deadlineAtMs ?? Date.now() + QUERY_BUDGET_MS;
    const scopedOptions = { ...options, deadlineAtMs };
    if (loadVectors(model, scopedOptions, true).length === 0) return [];
    const queryVector = await withinDeadline(() => operationEmbedder.embedOne(text, { deadlineAtMs }), deadlineAtMs);
    if (embedder !== operationEmbedder || embedderGeneration !== generation || operationEmbedder.spaceKey() !== model
      || !queryVector || !validVectors([queryVector], 1, dimensionOfSpace(model))) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const candidates = loadVectors(model, scopedOptions)
      .filter((row) => row.vector.length === queryVector.length)
      .map((row) => ({
        identifier: row.identifier,
        account: row.account,
        similarity: cosine(queryVector, row.vector),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
    return Date.now() < deadlineAtMs ? candidates : [];
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
  const semantic = await semanticCapabilityCandidates(query, { ...options, limit: armLimit });
  // Availability/effects may change while the semantic query is in flight.
  // Fuse current lexical descriptors, including the lexical-only fallback.
  const lexical = searchCapabilityOperations(query, { ...options, limit: armLimit });
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
