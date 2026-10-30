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

function unrelatedChunks(prefix: string, vector: number[], space = model, count = 5001): void {
  openMemoryDb().transaction(() => {
    for (let index = 0; index < count; index++) chunk(`${prefix}/note-${index}.md`, 'Unrelated inventory', vector, space);
  })();
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

test('the strongest semantic-only note remains reachable behind more than five thousand newer eligible notes', async () => {
  chunk('long-tail.md', 'The statutory deadline for submitting the annual return is Friday.', [1, 0]);
  unrelatedChunks('eligible-noise', [0.25, 1]);
  assert.deepEqual(recall('semanticlongtailprobe'), [], 'the old note has no lexical rescue');
  assert.deepEqual((await recallHybrid('semanticlongtailprobe', { limit: 1 })).map(hit => hit.title), ['long-tail.md']);

  chunk('long-tail-lexical.md', 'semanticlongtailprobe saved reference', [0, 1]);
  const hits = await recallHybrid('semanticlongtailprobe', { limit: 6 });
  assert.equal(hits[0]?.title, 'long-tail.md');
  assert.ok(hits.some(hit => hit.title === 'long-tail-lexical.md'), 'the independent dense arm preserves lexical evidence');
  assert.equal(hits.length, 6, 'one final selection honors the requested result limit');
  assert.equal(new Set(hits.map(hit => hit.filePath)).size, hits.length, 'fusion returns each indexed note once');
});

test('newer vectors from a different model cannot crowd out an older semantic-only note', async () => {
  chunk('model-tail.md', 'The desired paraphrased evidence is saved here.', [1, 0]);
  unrelatedChunks('foreign-model-noise', [1, 0], 'fixture-foreign-model');
  assert.deepEqual(recall('modelcrowdingprobe'), []);
  assert.deepEqual((await recallHybrid('modelcrowdingprobe', { limit: 6 })).map(hit => hit.title), ['model-tail.md']);
});

test('newer vectors with the same model and a different dimension cannot crowd out an older semantic-only note', async () => {
  chunk('dimension-tail.md', 'The desired paraphrased evidence is saved here.', [1, 0]);
  unrelatedChunks('foreign-dimension-noise', [1, 0, 0]);
  assert.deepEqual(recall('dimensioncrowdingprobe'), []);
  assert.deepEqual((await recallHybrid('dimensioncrowdingprobe', { limit: 6 })).map(hit => hit.title), ['dimension-tail.md']);
});

test('newer vectors in another subtree cannot crowd out an older semantic-only note in the requested subtree', async () => {
  chunk('allowed/subtree-tail.md', 'The desired paraphrased evidence is saved here.', [1, 0]);
  unrelatedChunks('elsewhere-noise', [1, 0]);
  const options = { pathPrefix: '/fixture/allowed/', limit: 6 };
  assert.deepEqual(recall('subtreecrowdingprobe', options), []);
  const hits = await recallHybrid('subtreecrowdingprobe', options);
  assert.deepEqual(hits.map(hit => hit.filePath), ['/fixture/allowed/subtree-tail.md']);
});

for (const excludedRows of ['outside the requested subtree', 'with malformed vector bytes'] as const) {
  test(`a large corpus ${excludedRows} permits queued work and retains the valid scoped result`, async () => {
    chunk('allowed/responsive-target.md', 'The desired paraphrased evidence is saved here.', [1, 0]);
    if (excludedRows === 'outside the requested subtree') unrelatedChunks('outside-scope-noise', [1, 0]);
    else {
      const db = openMemoryDb();
      const insert = db.prepare('INSERT INTO embeddings (chunk_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)');
      db.transaction(() => {
        for (let index = 0; index < 5001; index++) {
          const id = chunk(`allowed/malformed-noise-${index}.md`, 'Unrelated inventory');
          insert.run(id, model, 2, Buffer.alloc(3), '2026-10-14T00:00:00Z');
        }
      })();
    }
    const options = { pathPrefix: '/fixture/allowed/', limit: 6 };
    assert.deepEqual(recall('responsivecorpusprobe', options), []);
    let recallSettled = false;
    let queuedWorkRanBeforeSettlement = false;
    let queuedWork: Promise<void> | undefined;
    _setEmbeddingProviderForTest({ name: 'fixture', model, dim: 2, embed: async texts => {
      queuedWork = new Promise<void>(resolve => setImmediate(() => {
        queuedWorkRanBeforeSettlement = !recallSettled;
        resolve();
      }));
      return texts.map(() => new Float32Array([1, 0]));
    } });
    const hits = await recallHybrid('responsivecorpusprobe', options).finally(() => { recallSettled = true; });
    await queuedWork;
    assert.equal(queuedWorkRanBeforeSettlement, true, 'excluded rows must not turn a large corpus scan into one uninterrupted operation');
    assert.deepEqual(hits.map(hit => hit.filePath), ['/fixture/allowed/responsive-target.md']);
  });
}

test('a stronger note inserted during a yielding scan becomes eligible on the next query', async () => {
  chunk('existing-horizon-target.md', 'The current desired paraphrased evidence.', [0.5, 1]);
  unrelatedChunks('horizon-noise', [0.25, 1], model, 513);
  assert.deepEqual(recall('insertionhorizonprobe'), []);
  let firstRecallSettled = false;
  let insertedBeforeFirstRecallSettled = false;
  let insertionError: unknown;
  let insertionFinished: Promise<void> | undefined;
  _setEmbeddingProviderForTest({ name: 'fixture', model, dim: 2, embed: async texts => {
    insertionFinished ??= new Promise<void>(resolve => setImmediate(() => {
      try {
        chunk('new-horizon-target.md', 'Newly indexed stronger paraphrased evidence.', [1, 0]);
        insertedBeforeFirstRecallSettled = !firstRecallSettled;
      } catch (error) { insertionError = error; }
      finally { resolve(); }
    }));
    return texts.map(() => new Float32Array([1, 0]));
  } });
  const firstHits = await recallHybrid('insertionhorizonprobe', { limit: 1 }).finally(() => { firstRecallSettled = true; });
  await insertionFinished;
  assert.ifError(insertionError);
  assert.equal(insertedBeforeFirstRecallSettled, true, 'indexing proceeds while the original query is still scanning');
  assert.deepEqual(firstHits.map(hit => hit.title), ['existing-horizon-target.md'], 'new chunks do not extend an in-progress search');
  assert.deepEqual((await recallHybrid('insertionhorizonprobe', { limit: 1 })).map(hit => hit.title), ['new-horizon-target.md']);
});

test('an already expired foreground budget preserves lexical evidence without starting the producer', async () => {
  chunk('expired-lexical.md', 'expiredqueryprobe saved evidence', [0, 1]);
  chunk('expired-semantic.md', 'Desired paraphrased evidence', [1, 0]);
  let calls = 0;
  _setEmbeddingProviderForTest({ name: 'fixture', model, dim: 2, embed: async texts => {
    calls++;
    return texts.map(() => new Float32Array([1, 0]));
  } });
  assert.deepEqual((await recallHybrid('expiredqueryprobe', { deadlineAtMs: Date.now() - 1 })).map(hit => hit.title), ['expired-lexical.md']);
  assert.equal(calls, 0);
});

test('a producer result arriving at the foreground deadline preserves the lexical answer', async t => {
  chunk('late-lexical.md', 'lateproducerprobe saved evidence', [0, 1]);
  chunk('late-semantic.md', 'Desired paraphrased evidence', [1, 0]);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-29T12:00:00.000Z') });
  const deadlineAtMs = Date.now() + 1000;
  let calls = 0;
  _setEmbeddingProviderForTest({ name: 'fixture', model, dim: 2, embed: async texts => {
    calls++;
    t.mock.timers.tick(1000);
    return texts.map(() => new Float32Array([1, 0]));
  } });
  const hits = await recallHybrid('lateproducerprobe', { deadlineAtMs });
  assert.equal(calls, 1);
  assert.deepEqual(hits.map(hit => hit.title), ['late-lexical.md']);
});

for (const mutation of ['delete', 'reembed', 'replace-content'] as const) {
  test(`a retained semantic candidate changed between scan turns is not published after ${mutation}`, async () => {
    const target = chunk('changing-target.md', 'Original desired paraphrased evidence.', [1, 0]);
    unrelatedChunks('stable-noise', [0.25, 1], model, 513);
    const db = openMemoryDb();
    let recallSettled = false;
    let mutatedBeforeRecallSettled = false;
    let mutationError: unknown;
    let mutationFinished: Promise<void> | undefined;
    _setEmbeddingProviderForTest({ name: 'fixture', model, dim: 2, embed: async texts => {
      mutationFinished = new Promise<void>(resolve => setImmediate(() => {
        try {
          if (mutation === 'delete') db.prepare('DELETE FROM vault_chunks WHERE id = ?').run(target);
          else if (mutation === 'reembed') db.prepare('UPDATE embeddings SET vector = ? WHERE chunk_id = ?')
            .run(vectorToBuffer(new Float32Array([0, 1])), target);
          else {
            const replacement = 'Replacement source bytes written during recall.';
            db.prepare('UPDATE vault_chunks SET content = ?, content_hash = ?, byte_size = ?, mtime = ? WHERE id = ?')
              .run(replacement, replacement, replacement.length, 2000, target);
          }
          mutatedBeforeRecallSettled = !recallSettled;
        } catch (error) { mutationError = error; }
        finally { resolve(); }
      }));
      return texts.map(() => new Float32Array([1, 0]));
    } });
    const hits = await recallHybrid('changedcandidateprobe', { limit: 1 }).finally(() => { recallSettled = true; });
    await mutationFinished;
    assert.ifError(mutationError);
    assert.equal(mutatedBeforeRecallSettled, true, 'the corpus scan permits queued work before publishing its selection');
    assert.equal(hits.length, 1, 'unchanged candidates remain available');
    assert.ok(hits.every(hit => hit.filePath !== '/fixture/changing-target.md'), 'a previously scored candidate must still match its current source and vector');
    assert.ok(hits.every(hit => !hit.snippet.includes('Original desired') && !hit.snippet.includes('Replacement source')));
    if (mutation === 'delete') assert.equal(db.prepare('SELECT 1 FROM embeddings WHERE chunk_id = ?').get(target), undefined);
  });
}

test('a deadline reached between scan turns discards partial dense results and preserves lexical evidence', async t => {
  chunk('scan-deadline-target.md', 'Desired paraphrased evidence', [1, 0]);
  unrelatedChunks('scan-deadline-noise', [0.25, 1], model, 513);
  chunk('scan-deadline-lexical.md', 'scandeadlineprobe saved evidence', [0, 1]);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-29T12:00:00.000Z') });
  const deadlineAtMs = Date.now() + 1000;
  let recallSettled = false;
  let expiredBeforeRecallSettled = false;
  let expirationFinished: Promise<void> | undefined;
  _setEmbeddingProviderForTest({ name: 'fixture', model, dim: 2, embed: async texts => {
    expirationFinished = new Promise<void>(resolve => setImmediate(() => {
      t.mock.timers.tick(1000);
      expiredBeforeRecallSettled = !recallSettled;
      resolve();
    }));
    return texts.map(() => new Float32Array([1, 0]));
  } });
  const hits = await recallHybrid('scandeadlineprobe', { deadlineAtMs }).finally(() => { recallSettled = true; });
  await expirationFinished;
  assert.equal(expiredBeforeRecallSettled, true);
  assert.deepEqual(hits.map(hit => hit.title), ['scan-deadline-lexical.md']);
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
