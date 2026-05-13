import pino from 'pino';
import { OPENAI_API_KEY } from '../config.js';
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

export function isEmbeddingsEnabled(): boolean {
  return Boolean(OPENAI_API_KEY);
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
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  if (texts.length === 0) return [];

  const safeInputs = texts.map((t) => (t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t));

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: safeInputs,
    }),
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
  try {
    const [vector] = await embedBatch([query]);
    return vector ?? null;
  } catch (err) {
    logger.warn({ err }, 'embedQuery failed; falling back to FTS-only');
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
    } catch (err) {
      stats.failed += batch.length;
      logger.warn({ err, batchStart: i, batchSize: batch.length }, 'embed batch failed');
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
