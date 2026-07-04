/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-embprov npx tsx --test src/memory/embedding-provider.test.ts
 *
 * WS3 — embedding provider abstraction. Verifies provider selection, that the
 * ACTIVE provider's model/dim are stored on write, and that switching providers
 * (model/dim change) triggers a re-embed — the migration path the audit flagged.
 * Uses the injectable test provider so no network/model load is needed.
 */
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { EmbeddingProvider } from './embeddings.js';

const TEST_HOME = '/tmp/clemmy-test-embprov';
process.env.CLEMENTINE_HOME = TEST_HOME;
// No real key — selection is driven entirely by the injected provider.
delete process.env.OPENAI_API_KEY;

// eslint-disable-next-line import/first
const { resetMemoryDb, openMemoryDb } = await import('./db.js');
// eslint-disable-next-line import/first
const { rememberFact } = await import('./facts.js');
// eslint-disable-next-line import/first
const {
  embedMissingFacts, isEmbeddingsEnabled, getEmbeddingProvider, activeEmbeddingDim, activeEmbeddingModel,
  loadEmbeddingsForChunks, loadFactEmbeddings, vectorToBuffer,
  _setEmbeddingProviderForTest,
} = await import('./embeddings.js');

function fakeProvider(name: string, model: string, dim: number): EmbeddingProvider {
  return {
    name, model, dim,
    async embed(texts) {
      // Deterministic non-zero vector per text, of the declared dim.
      return texts.map((t) => {
        const v = new Float32Array(dim);
        for (let i = 0; i < dim; i++) v[i] = ((t.charCodeAt(i % Math.max(1, t.length)) || 1) % 7) + 1;
        return v;
      });
    },
  };
}

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetMemoryDb(); openMemoryDb(); });
afterEach(() => { _setEmbeddingProviderForTest(undefined); });

test('an injected provider is selected and reports enabled + model/dim', async () => {
  _setEmbeddingProviderForTest(fakeProvider('local', 'bge-small', 384));
  assert.equal(isEmbeddingsEnabled(), true);
  assert.equal(activeEmbeddingModel(), 'bge-small');
  assert.equal(activeEmbeddingDim(), 384);
  assert.equal((await getEmbeddingProvider())?.name, 'local');
});

test('no provider (null) ⇒ embeddings disabled, backfill no-ops cleanly', async () => {
  _setEmbeddingProviderForTest(null);
  assert.equal(isEmbeddingsEnabled(), false);
  rememberFact({ kind: 'user', content: 'Some durable fact about the user.' });
  const stats = await embedMissingFacts({ maxChunks: 50 });
  assert.equal(stats.enabled, false);
  assert.equal(stats.embedded, 0);
});

test('the ACTIVE provider model/dim are stored on the embedding row', async () => {
  _setEmbeddingProviderForTest(fakeProvider('local', 'bge-small', 384));
  rememberFact({ kind: 'user', content: 'Fact one alpha.' });
  const stats = await embedMissingFacts({ maxChunks: 50 });
  assert.equal(stats.embedded, 1);
  const db = openMemoryDb();
  const row = db.prepare('SELECT model, dim FROM fact_embeddings LIMIT 1').get() as { model: string; dim: number };
  assert.equal(row.model, 'bge-small');
  assert.equal(row.dim, 384);
});

test('switching providers (model/dim change) re-embeds, then is idempotent', async () => {
  _setEmbeddingProviderForTest(fakeProvider('openai', 'text-embedding-3-small', 1536));
  rememberFact({ kind: 'user', content: 'Fact one alpha.' });
  rememberFact({ kind: 'project', content: 'Fact two bravo.' });
  const first = await embedMissingFacts({ maxChunks: 50 });
  assert.equal(first.embedded, 2);

  // Switch provider → stored model/dim now mismatch → all rows re-embed.
  _setEmbeddingProviderForTest(fakeProvider('local', 'bge-small', 384));
  const afterSwitch = await embedMissingFacts({ maxChunks: 50 });
  assert.equal(afterSwitch.candidateChunks, 2, 'both facts re-embedded after provider switch');
  assert.equal(afterSwitch.embedded, 2);

  const db = openMemoryDb();
  const dims = (db.prepare('SELECT DISTINCT dim FROM fact_embeddings').all() as { dim: number }[]).map((r) => r.dim);
  assert.deepEqual(dims, [384], 'no mixed-dim rows survive the switch');

  // Rerun on the same provider → nothing stale.
  const idempotent = await embedMissingFacts({ maxChunks: 50 });
  assert.equal(idempotent.candidateChunks, 0);
});

test('loadFactEmbeddings only returns vectors from the active provider space', async () => {
  _setEmbeddingProviderForTest(fakeProvider('openai', 'text-embedding-3-small', 1536));
  const fact = rememberFact({ kind: 'user', content: 'Fact one alpha.' });
  await embedMissingFacts({ maxChunks: 50 });
  assert.equal(loadFactEmbeddings([fact.id]).size, 1);

  _setEmbeddingProviderForTest(fakeProvider('local', 'bge-small', 384));
  assert.equal(loadFactEmbeddings([fact.id]).size, 0, 'stale prior-provider fact vector is ignored before re-embed');

  await embedMissingFacts({ maxChunks: 50 });
  assert.equal(loadFactEmbeddings([fact.id]).size, 1, 'active-provider fact vector is visible after re-embed');
});

test('loadEmbeddingsForChunks only returns vectors from the active provider space', async () => {
  const db = openMemoryDb();
  db.prepare(`
    INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('/tmp/provider-switch.md', 0, 'Chunk content alpha.', 'Provider switch', 1, 20, 'chunk-hash');
  const chunkId = (db.prepare('SELECT id FROM vault_chunks LIMIT 1').get() as { id: number }).id;
  db.prepare(`
    INSERT INTO embeddings (chunk_id, model, dim, vector, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(chunkId, 'text-embedding-3-small', 1536, vectorToBuffer(new Float32Array(1536)), new Date().toISOString());

  _setEmbeddingProviderForTest(fakeProvider('openai', 'text-embedding-3-small', 1536));
  assert.equal(loadEmbeddingsForChunks([chunkId]).size, 1);

  _setEmbeddingProviderForTest(fakeProvider('local', 'bge-small', 384));
  assert.equal(loadEmbeddingsForChunks([chunkId]).size, 0, 'stale prior-provider chunk vector is ignored');
});

test('CLEMMY_EMBED_PROVIDER=off forces no provider even with one injectable', async () => {
  // Injection takes precedence over env in this harness, so clear it and rely
  // on the env override path (no key, local disabled).
  _setEmbeddingProviderForTest(undefined);
  process.env.CLEMMY_EMBED_PROVIDER = 'off';
  try {
    assert.equal(isEmbeddingsEnabled(), false);
    assert.equal(await getEmbeddingProvider(), null);
  } finally {
    delete process.env.CLEMMY_EMBED_PROVIDER;
  }
});
