import pino from 'pino';
import { getOpenAiApiKey, getRuntimeEnv } from '../config.js';
import { openMemoryDb } from './db.js';

/**
 * OpenAI-backed embeddings for semantic recall rerank.
 *
 * Design choices:
 * - No new dependency. Embeddings is a single REST call; we use the
 *   built-in `fetch` (Node 20+ already required by this project).
 * - Hard requirement is just `OPENAI_API_KEY`. Without it the entire
 *   embedding path silently degrades to FTS-only — no errors, no
 *   prompts, no UX cliffs for codex_oauth users.
 * - Vectors stored as raw Float32 buffers in SQLite. 1536 dim × 4 bytes
 *   = 6144 bytes per chunk. A 10k-chunk vault is ~60MB on disk, easy.
 * - Recall does the cosine rerank in-process over the FTS candidate
 *   pool — usually 30–60 vectors — which is microseconds. No ANN
 *   library needed at personal scale.
 *
 * Schema lives in src/memory/db.ts (`embeddings` table, FK-cascaded
 * to `vault_chunks` so chunk delete → embedding delete for free).
 */

const logger = pino({ name: 'clementine-next.memory.embeddings' });

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;

// OpenAI accepts up to 2048 inputs per request; we stay conservative
// so a single bad chunk can't poison too many at once.
const BATCH_SIZE = 96;
// Embedding model max is 8192 tokens; chunks are ~300 tokens, but we
// hard-cap the input length to avoid surprises on edge-case files.
const MAX_INPUT_CHARS = 16_000;
// Per-call timeout for the embeddings fetch. Tighter than undici's
// default (10s) so the daemon doesn't hang for a full 10s on a stale
// Cloudflare IP — chat/recall fall back to FTS-only on timeout.
const FETCH_TIMEOUT_MS = 6_000;

// Circuit breaker for the long-running daemon's pool-poisoning
// failure mode. After ~hours of uptime, undici keeps stale Cloudflare
// IPs in its connection pool and every embedding call times out for
// some period. When we see CONSECUTIVE_FAIL_THRESHOLD failures in a
// row we open the breaker for COOLDOWN_MS — recall and the indexer
// silently fall through to the FTS path, avoiding the 6s × N tax per
// chat. A single success closes the breaker.
const CONSECUTIVE_FAIL_THRESHOLD = 3;
// Class-aware cooldowns. A transient pool/network blip clears in minutes and a
// rate-limit clears fast, but a TERMINAL error (quota exhausted / bad key) will
// NOT fix itself for hours — retrying it every 5 min just drip-spends and floods
// the log (the 2026-06-08 incident: 149 retries in a day against an empty
// account). So terminal errors back off hard and surface loudly.
const COOLDOWN_TRANSIENT_MS = 5 * 60_000;   // pooled-IP / network / 5xx / timeout
const COOLDOWN_RATE_LIMIT_MS = 60_000;      // 429 throttle (not quota)
const COOLDOWN_TERMINAL_MS = 60 * 60_000;   // quota / auth — probe at most hourly

export type EmbedErrorClass = 'quota' | 'auth' | 'rate_limit' | 'transient';

export function classifyEmbedError(err: unknown): EmbedErrorClass {
  const msg = err instanceof Error ? err.message : String(err);
  if (/insufficient_quota|exceeded your current quota|check your plan and billing/i.test(msg)) return 'quota';
  if (/\b401\b|invalid_api_key|incorrect api key|OPENAI_API_KEY is not set/i.test(msg)) return 'auth';
  if (/\b429\b|rate.?limit/i.test(msg)) return 'rate_limit';
  return 'transient';
}

function cooldownForClass(cls: EmbedErrorClass): number {
  switch (cls) {
    case 'quota':
    case 'auth': return COOLDOWN_TERMINAL_MS;
    case 'rate_limit': return COOLDOWN_RATE_LIMIT_MS;
    default: return COOLDOWN_TRANSIENT_MS;
  }
}

let consecutiveFailures = 0;
let cooldownUntilMs = 0;
let lastSuccessAtMs = 0;
let lastErrorClass: EmbedErrorClass | null = null;
let lastErrorAtMs = 0;

function inCooldown(): boolean {
  if (cooldownUntilMs === 0) return false;
  if (Date.now() >= cooldownUntilMs) {
    // Half-open: let the next call probe. Don't reset failures — if
    // the probe also fails the breaker re-opens immediately.
    cooldownUntilMs = 0;
    return false;
  }
  return true;
}

/** Non-mutating view of breaker state for the health getter (never half-opens). */
function breakerOpenPeek(): boolean {
  return cooldownUntilMs !== 0 && Date.now() < cooldownUntilMs;
}

function recordSuccess(): void {
  consecutiveFailures = 0;
  cooldownUntilMs = 0;
  lastSuccessAtMs = Date.now();
  lastErrorClass = null;
}

function recordFailure(err: unknown): void {
  consecutiveFailures++;
  const cls = classifyEmbedError(err);
  lastErrorClass = cls;
  lastErrorAtMs = Date.now();
  const terminal = cls === 'quota' || cls === 'auth';
  // Terminal errors are definitive — open immediately (don't burn 2 more calls
  // confirming the quota is still empty). Transient/rate-limit wait for the
  // threshold so a single blip doesn't drop recall to FTS.
  const shouldOpen = cooldownUntilMs === 0 && (terminal || consecutiveFailures >= CONSECUTIVE_FAIL_THRESHOLD);
  if (shouldOpen) {
    const ms = cooldownForClass(cls);
    cooldownUntilMs = Date.now() + ms;
    const line = `embeddings circuit breaker open (${cls}) — recall on FTS-only for ~${Math.round(ms / 60_000)}m`;
    if (terminal) {
      logger.error(
        { cls, failures: consecutiveFailures, cooldownMs: ms },
        `${line}. ${cls === 'quota' ? 'OpenAI quota exhausted — add credit/billing to restore semantic memory.' : 'OpenAI key rejected — check credentials.'}`,
      );
    } else {
      logger.warn({ cls, failures: consecutiveFailures, cooldownMs: ms }, line);
    }
  }
}

export interface EmbeddingHealth {
  enabled: boolean;
  breakerOpen: boolean;
  cooldownUntilMs: number;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastErrorClass: EmbedErrorClass | null;
  lastErrorAt: string | null;
}

/** Snapshot of embedding health for the diagnostics panel — non-mutating. */
export function getEmbeddingHealth(): EmbeddingHealth {
  return {
    enabled: isEmbeddingsEnabled(),
    breakerOpen: breakerOpenPeek(),
    cooldownUntilMs,
    lastSuccessAt: lastSuccessAtMs ? new Date(lastSuccessAtMs).toISOString() : null,
    consecutiveFailures,
    lastErrorClass,
    lastErrorAt: lastErrorAtMs ? new Date(lastErrorAtMs).toISOString() : null,
  };
}

/** Test-only: reset the in-process breaker/health state between cases. */
export function _resetEmbeddingHealthForTest(): void {
  consecutiveFailures = 0;
  cooldownUntilMs = 0;
  lastSuccessAtMs = 0;
  lastErrorClass = null;
  lastErrorAtMs = 0;
}
/** Test-only: drive the breaker without a real API call. */
export function _driveEmbedFailureForTest(err: unknown): void { recordFailure(err); }
export function _driveEmbedSuccessForTest(): void { recordSuccess(); }

export function isEmbeddingsEnabled(): boolean {
  // Explicit, key-decoupled opt-out. Previously EMBEDDINGS_DISABLED was read
  // nowhere (a dead flag); honoring it makes the user's off-switch real. Default
  // (unset) is byte-identical to the old key-presence behavior. When disabled,
  // every consumer degrades gracefully to the FTS/LIKE fallback.
  if ((getRuntimeEnv('EMBEDDINGS_DISABLED', '') || '').trim().toLowerCase() === 'true') return false;
  return Boolean(getOpenAiApiKey());
}

/**
 * Convert a Float32Array to a Buffer for SQLite BLOB storage.
 * We copy the underlying ArrayBuffer to be safe — Float32Array views
 * can share buffers in surprising ways.
 */
export function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function bufferToVector(buffer: Buffer): Float32Array {
  // Slice to ensure we own the bytes and aren't aliasing the SQLite buffer.
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(ab);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface EmbeddingsApiResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * Embed a batch of texts. Returns vectors in the same order as input.
 * Throws on hard failure — callers decide whether to retry or skip.
 */
async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  if (texts.length === 0) return [];

  const safeInputs = texts.map((t) => (t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t));

  // keepalive:false forces undici to NOT pool this connection. After
  // hours of daemon uptime, the keep-alive pool fills with stale
  // Cloudflare-edge IPs that no longer route — every subsequent call
  // times out at undici's 10s connect timeout. Opting out of the pool
  // means every embedding call does a fresh DNS lookup + TCP connect.
  // That's a few-ms tax per call but avoids the multi-hour outage.
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: safeInputs,
    }),
    keepalive: false,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Embeddings API ${response.status}: ${body.slice(0, 400)}`);
  }

  const json = await response.json() as EmbeddingsApiResponse;
  // Sort by `index` defensively; the API returns in order but we don't rely on it.
  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  return sorted.map((row) => Float32Array.from(row.embedding));
}

/**
 * Public API: embed a single query string. Convenience for the recall
 * rerank path. Returns null if embeddings are disabled or the call fails
 * — recall falls back to FTS-only ordering.
 */
export async function embedQuery(query: string): Promise<Float32Array | null> {
  if (!isEmbeddingsEnabled()) return null;
  if (inCooldown()) return null;
  try {
    const [vector] = await embedBatch([query]);
    recordSuccess();
    return vector ?? null;
  } catch (err) {
    recordFailure(err);
    logger.warn({ err }, 'embedQuery failed; falling back to FTS-only');
    return null;
  }
}

/**
 * Public API: embed a batch of texts in one call. Convenience for rankers that
 * need many vectors at once (e.g. semantic tool retrieval). Returns vectors in
 * input order, or null if embeddings are disabled / in cooldown / the call
 * fails — callers fall back to a non-semantic path. Never throws.
 */
export async function embedTexts(texts: string[]): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];
  if (!isEmbeddingsEnabled()) return null;
  if (inCooldown()) return null;
  try {
    const vectors = await embedBatch(texts);
    recordSuccess();
    return vectors;
  } catch (err) {
    recordFailure(err);
    logger.warn({ err, count: texts.length }, 'embedTexts failed; caller falls back to non-semantic path');
    return null;
  }
}

export interface EmbedBackfillStats {
  enabled: boolean;
  candidateChunks: number;
  batched: number;
  embedded: number;
  failed: number;
  durationMs: number;
  reason?: string;
}

/**
 * Find chunks that don't yet have embeddings and embed them.
 * - Caller-controlled `maxChunks` so the daemon can run small batches
 *   per tick (default 200) without saturating the API.
 * - Idempotent: rerunning picks up where it left off because we only
 *   look at chunks missing from the `embeddings` table.
 * - One INSERT per successful chunk; failed batches are logged and
 *   skipped without blocking the others.
 */
export async function embedMissingChunks(options: { maxChunks?: number } = {}): Promise<EmbedBackfillStats> {
  const start = Date.now();
  const stats: EmbedBackfillStats = {
    enabled: isEmbeddingsEnabled(),
    candidateChunks: 0,
    batched: 0,
    embedded: 0,
    failed: 0,
    durationMs: 0,
  };

  if (!stats.enabled) {
    stats.reason = 'OPENAI_API_KEY not set';
    stats.durationMs = Date.now() - start;
    return stats;
  }
  if (inCooldown()) {
    stats.reason = 'circuit breaker open — skipping this backfill tick';
    stats.durationMs = Date.now() - start;
    return stats;
  }

  const db = openMemoryDb();
  const limit = Math.max(1, options.maxChunks ?? 200);

  const rows = db.prepare(`
    SELECT vc.id AS id, vc.content AS content
    FROM vault_chunks vc
    LEFT JOIN embeddings e ON e.chunk_id = vc.id
    WHERE e.chunk_id IS NULL
    ORDER BY vc.id ASC
    LIMIT ?
  `).all(limit) as { id: number; content: string }[];

  stats.candidateChunks = rows.length;
  if (rows.length === 0) {
    stats.durationMs = Date.now() - start;
    return stats;
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO embeddings (chunk_id, model, dim, vector, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    stats.batched++;
    let vectors: Float32Array[] = [];
    try {
      vectors = await embedBatch(batch.map((r) => r.content));
      recordSuccess();
    } catch (err) {
      recordFailure(err);
      stats.failed += batch.length;
      logger.warn({ err, batchStart: i, batchSize: batch.length }, 'embed batch failed');
      // If the breaker tripped on this batch, bail the whole tick —
      // hammering N more batches just to time out N more times wastes
      // 6s per batch and floods the log.
      if (inCooldown()) {
        stats.reason = 'circuit breaker opened mid-tick';
        break;
      }
      continue;
    }

    const tx = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const vector = vectors[j];
        if (!vector) continue;
        insert.run(batch[j].id, EMBEDDING_MODEL, vector.length, vectorToBuffer(vector), now);
        stats.embedded++;
      }
    });
    try {
      tx();
    } catch (err) {
      stats.failed += batch.length;
      logger.warn({ err, batchStart: i }, 'embed batch insert failed');
    }
  }

  stats.durationMs = Date.now() - start;
  return stats;
}

/**
 * Load embeddings for a set of chunk ids. Returns a Map for O(1)
 * lookup during the rerank scan.
 */
export function loadEmbeddingsForChunks(chunkIds: number[]): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>();
  if (chunkIds.length === 0) return out;
  const db = openMemoryDb();
  const placeholders = chunkIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT chunk_id AS id, vector FROM embeddings WHERE chunk_id IN (${placeholders})`
  ).all(...chunkIds) as { id: number; vector: Buffer }[];
  for (const row of rows) out.set(row.id, bufferToVector(row.vector));
  return out;
}

/**
 * Find consolidated_facts that don't yet have an embedding — or whose
 * stored embedding is stale because the fact's content changed — and
 * embed them. Mirrors `embedMissingChunks` exactly (same batching,
 * circuit breaker, idempotency) but over the `fact_embeddings` table.
 *
 * Staleness check: `fact_embeddings.content_hash != consolidated_facts.
 * content_hash`. updateFact recomputes the fact's content_hash, so a
 * Mem0 UPDATE naturally re-embeds on the next backfill tick.
 */
export async function embedMissingFacts(options: { maxChunks?: number } = {}): Promise<EmbedBackfillStats> {
  const start = Date.now();
  const stats: EmbedBackfillStats = {
    enabled: isEmbeddingsEnabled(),
    candidateChunks: 0,
    batched: 0,
    embedded: 0,
    failed: 0,
    durationMs: 0,
  };

  if (!stats.enabled) {
    stats.reason = 'OPENAI_API_KEY not set';
    stats.durationMs = Date.now() - start;
    return stats;
  }
  if (inCooldown()) {
    stats.reason = 'circuit breaker open — skipping this backfill tick';
    stats.durationMs = Date.now() - start;
    return stats;
  }

  const db = openMemoryDb();
  const limit = Math.max(1, options.maxChunks ?? 200);

  const rows = db.prepare(`
    SELECT cf.id AS id, cf.content AS content, cf.content_hash AS hash
    FROM consolidated_facts cf
    LEFT JOIN fact_embeddings fe ON fe.fact_id = cf.id
    WHERE cf.active = 1
      AND (fe.fact_id IS NULL OR fe.content_hash != cf.content_hash)
    ORDER BY cf.id ASC
    LIMIT ?
  `).all(limit) as { id: number; content: string; hash: string }[];

  stats.candidateChunks = rows.length;
  if (rows.length === 0) {
    stats.durationMs = Date.now() - start;
    return stats;
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO fact_embeddings (fact_id, model, dim, vector, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    stats.batched++;
    let vectors: Float32Array[] = [];
    try {
      vectors = await embedBatch(batch.map((r) => r.content));
      recordSuccess();
    } catch (err) {
      recordFailure(err);
      stats.failed += batch.length;
      logger.warn({ err, batchStart: i, batchSize: batch.length }, 'embed fact batch failed');
      if (inCooldown()) {
        stats.reason = 'circuit breaker opened mid-tick';
        break;
      }
      continue;
    }

    const tx = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const vector = vectors[j];
        if (!vector) continue;
        insert.run(batch[j].id, EMBEDDING_MODEL, vector.length, vectorToBuffer(vector), batch[j].hash, now);
        stats.embedded++;
      }
    });
    try {
      tx();
    } catch (err) {
      stats.failed += batch.length;
      logger.warn({ err, batchStart: i }, 'embed fact batch insert failed');
    }
  }

  stats.durationMs = Date.now() - start;
  return stats;
}

/**
 * Load embeddings for a set of fact ids. Returns a Map for O(1) lookup
 * during the semantic findSimilarFacts rerank. Mirrors
 * `loadEmbeddingsForChunks`.
 */
export function loadFactEmbeddings(factIds: number[]): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>();
  if (factIds.length === 0) return out;
  const db = openMemoryDb();
  const placeholders = factIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT fact_id AS id, vector FROM fact_embeddings WHERE fact_id IN (${placeholders})`
  ).all(...factIds) as { id: number; vector: Buffer }[];
  for (const row of rows) out.set(row.id, bufferToVector(row.vector));
  return out;
}

export interface EmbeddingStats {
  enabled: boolean;
  count: number;
  model: string | null;
  dim: number | null;
}

export function readEmbeddingStats(): EmbeddingStats {
  const stats: EmbeddingStats = {
    enabled: isEmbeddingsEnabled(),
    count: 0,
    model: null,
    dim: null,
  };
  try {
    const db = openMemoryDb();
    const row = db.prepare(`
      SELECT COUNT(*) AS c, MAX(model) AS model, MAX(dim) AS dim
      FROM embeddings
    `).get() as { c: number; model: string | null; dim: number | null };
    stats.count = row.c;
    stats.model = row.model;
    stats.dim = row.dim;
  } catch {
    // Table may not exist or DB may not be openable in some edge tests.
  }
  return stats;
}

/** Active facts that don't yet have an embedding — the backfill backlog. A
 *  growing value while the breaker is open means semantic recall is degrading. */
export function countUnembeddedActiveFacts(): number {
  try {
    const db = openMemoryDb();
    const row = db.prepare(`
      SELECT COUNT(*) AS c FROM consolidated_facts f
      WHERE f.active = 1
        AND NOT EXISTS (SELECT 1 FROM fact_embeddings e WHERE e.fact_id = f.id)
    `).get() as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}
