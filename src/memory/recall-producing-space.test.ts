import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-recall-producing-space-'));
process.env.CLEMENTINE_HOME = home;
const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const { recall, recallHybrid } = await import('./recall.js');
const { recallMemory } = await import('./recall-memory.js');
const {
  _setEmbeddingProviderForTest, _setLocalProviderForTest,
  _resetEmbeddingHealthForTest, _resetEmbedDemotionForTest,
  _setEmbeddingProviderHealthFileForTest, vectorToBuffer,
} = await import('./embeddings.js');

_setEmbeddingProviderHealthFileForTest(path.join(home, 'provider-health.json'));
const model = 'fixture-query-space-a';
beforeEach(() => {
  resetMemoryDb();
  _resetEmbeddingHealthForTest();
  _resetEmbedDemotionForTest();
  _setEmbeddingProviderForTest({ name: 'fixture', model, dim: 2, embed: async texts => texts.map(() => new Float32Array([1, 0])) });
});
afterEach(() => {
  _setEmbeddingProviderForTest(undefined);
  _setLocalProviderForTest(undefined);
});
after(() => { resetMemoryDb(); rmSync(home, { recursive: true, force: true }); });

function chunk(name: string, content: string, vector?: number[], space = model): number {
  const db = openMemoryDb();
  const row = db.prepare(`INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
    VALUES (?, 0, ?, ?, ?, ?, ?)`).run(`/fixture/${name}`, content, name, 1000, content.length, content);
  const id = Number(row.lastInsertRowid);
  if (vector) db.prepare('INSERT INTO embeddings (chunk_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, space, vector.length, vectorToBuffer(new Float32Array(vector)), '2026-10-14T00:00:00Z');
  return id;
}

test('meaning-only note enters a nonempty lexical pool instead of remaining unreachable', async () => {
  chunk('lexical-noise.md', 'Find filing cabinet supplies and office paperwork.', [0, 1]);
  chunk('correct-note.md', 'The statutory deadline for submitting the annual return is Friday.', [1, 0]);
  assert.deepEqual(recall('filing', { limit: 3 }).map(hit => hit.title), ['lexical-noise.md']);
  const hits = await recallHybrid('filing', { limit: 3 });
  assert.equal(hits[0]?.title, 'correct-note.md');
  assert.ok(hits.some(hit => hit.title === 'lexical-noise.md'), 'fusion retains lexical reachability');
});

for (const query of ['lexicalprobe', 'meaningonly']) {
  test(`different-model vectors never enter dense candidates for ${query}`, async () => {
    chunk('lexical.md', 'lexicalprobe unrelated note', [0, 1]);
    chunk('foreign-same-dimension.md', 'Foreign unrelated document', [1, 0], 'fixture-space-b');
    chunk('foreign-dimension.md', 'Different geometry document', [1, 0, 0], 'fixture-space-c');
    chunk('correct.md', 'Paraphrased desired evidence', [1, 0]);
    const hits = await recallHybrid(query, { limit: 6 });
    assert.equal(hits[0]?.title, 'correct.md');
    assert.ok(!hits.some(hit => hit.title?.startsWith('foreign-')));
  });
}

test('same-call remote rescue searches the actual local space, not the requested space', async () => {
  chunk('remote.md', 'Remote-only evidence', [1, 0], 'fixture-remote');
  chunk('local.md', 'Local paraphrase evidence', [0, 1], 'fixture-local');
  _setLocalProviderForTest({ name: 'local', model: 'fixture-local', dim: 2, embed: async texts => texts.map(() => new Float32Array([0, 1])) });
  _setEmbeddingProviderForTest({ name: 'openai', model: 'fixture-remote', dim: 2, embed: async () => { throw new Error('temporary unavailable'); } });
  const hits = await recallHybrid('semanticrescue', { limit: 4 });
  assert.deepEqual(hits.map(hit => hit.title), ['local.md']);
});

test('no stored vectors avoids embedding entirely and preserves the lexical answer', async () => {
  chunk('lexical.md', 'coldindex known answer');
  let calls = 0;
  _setEmbeddingProviderForTest({ name: 'fixture', model, dim: 2, embed: async () => { calls++; throw new Error('must not be called'); } });
  assert.deepEqual((await recallHybrid('coldindex')).map(hit => hit.title), ['lexical.md']);
  assert.equal(calls, 0);
});

test('dense candidate expansion honors the requested subtree', async () => {
  chunk('allowed/correct.md', 'Paraphrased evidence', [1, 0]);
  chunk('private/foreign.md', 'Other subtree evidence', [1, 0]);
  assert.deepEqual((await recallHybrid('subtreequery', { pathPrefix: '/fixture/allowed/' })).map(hit => hit.title), ['allowed/correct.md']);
});

test('unusable stored vectors are excluded without losing valid candidates', async () => {
  chunk('zero.md', 'Invalid origin vector', [0, 0]);
  chunk('nonfinite.md', 'Invalid nonfinite vector', [Number.NaN, 1]);
  const malformed = chunk('malformed.md', 'Invalid byte length');
  openMemoryDb().prepare('INSERT INTO embeddings (chunk_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(malformed, model, 2, Buffer.alloc(3), '2026-10-14T00:00:00Z');
  chunk('valid.md', 'Desired paraphrase', [1, 0]);
  assert.deepEqual((await recallHybrid('vectorvalidity')).map(hit => hit.title), ['valid.md']);
});

test('an older lexical match keeps semantic ranking outside the bounded newest window', async () => {
  chunk('older.md', 'windowprobe saved evidence', [1, 0]);
  const db = openMemoryDb();
  db.transaction(() => {
    for (let index = 0; index < 5001; index++) chunk(`noise-${index}.md`, 'Unrelated inventory', [0, 1]);
  })();
  chunk('lexical-decoy.md', 'windowprobe windowprobe windowprobe windowprobe', [0, 1]);
  assert.equal(recall('windowprobe')[0]?.title, 'lexical-decoy.md');
  assert.equal((await recallHybrid('windowprobe'))[0]?.title, 'older.md', 'primary-key lexical vector fetch is separate from the newest independent window');
});

test('expired foreground budget returns lexical evidence without waiting for the held producer', async () => {
  chunk('lexical.md', 'deadlineprobe saved evidence', [1, 0]);
  let release!: (vectors: Float32Array[]) => void;
  const pending = new Promise<Float32Array[]>(resolve => { release = resolve; });
  _setEmbeddingProviderForTest({ name: 'fixture', model, dim: 2, embed: () => pending });
  const started = Date.now();
  try {
    const hits = await recallHybrid('deadlineprobe', { deadlineAtMs: started + 30 });
    assert.deepEqual(hits.map(hit => hit.title), ['lexical.md']);
    assert.ok(Date.now() - started < 500, 'caller is not held until producer completion');
  } finally { release([new Float32Array([1, 0])]); await pending; }
});

test('the outer note-leg timeout preserves available lexical evidence', async () => {
  chunk('leg-fallback.md', 'legdeadlineprobe The saved deadline is Friday.', [1, 0]);
  let release!: (vectors: Float32Array[]) => void;
  const pending = new Promise<Float32Array[]>(resolve => { release = resolve; });
  _setEmbeddingProviderForTest({ name: 'fixture', model, dim: 2, embed: () => pending });
  try {
    const result = await recallMemory('legdeadlineprobe', { stores: ['note'], graphDepth: 0, deadlineAtMs: Date.now() + 30 });
    assert.ok(result.hits.some(hit => hit.ref.type === 'note' && hit.text.includes('The saved deadline is Friday.')),
      'a held embedding must not turn known local note evidence into an empty recall leg');
  } finally { release([new Float32Array([1, 0])]); await pending; }
});
