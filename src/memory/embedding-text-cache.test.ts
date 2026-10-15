import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import type { EmbeddingProvider } from './embeddings.js';
import type { EmbeddingWorkOptions } from './embedding-worker.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-shared-text-cache-'));
process.env.CLEMENTINE_HOME = home;
const {
  createSharedEmbeddingTextCache, embedQueryWithSpace, getEmbeddingHealth,
  _setEmbeddingProviderForTest, _setLocalProviderForTest,
  _resetEmbeddingHealthForTest, _resetEmbedDemotionForTest, _setEmbeddingProviderHealthFileForTest,
} = await import('./embeddings.js');
const { EmbeddingWorkSkippedError } = await import('./embedding-worker.js');
const vector = () => new Float32Array([1, 0]);
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
let calls: string[][];
let provider: EmbeddingProvider;
beforeEach(() => {
  calls = [];
  _setEmbeddingProviderHealthFileForTest(path.join(home, 'provider-health.json'));
  _resetEmbeddingHealthForTest(); _resetEmbedDemotionForTest(); _setLocalProviderForTest(null);
  provider = { name: 'text-cache-fixture', model: 'space-a', dim: 2,
    async embed(texts) { calls.push([...texts]); return texts.map(vector); },
  };
  _setEmbeddingProviderForTest(provider);
});
afterEach(() => { _setEmbeddingProviderForTest(null); _setLocalProviderForTest(null); });
after(() => rmSync(home, { recursive: true, force: true }));
async function query() { const result = await embedQueryWithSpace('fixture query'); assert.ok(result); return result; }

test('duplicate input texts share one physical vector and preserve requested output order', async () => {
  const space = await query(), cache = createSharedEmbeddingTextCache({ maxEntries: 2 });
  const result = await cache.embed(['a', 'a', 'b'], { space });
  assert.equal(result?.vectors.length, 3);
  assert.deepEqual(calls, [['fixture query'], ['a', 'b']]);
  assert.deepEqual(result?.vectors.map(v => [...v]), [[1, 0], [1, 0], [1, 0]]);
});

test('pending entries are not evicted into duplicate work when capacity is saturated', async () => {
  const space = await query(), cache = createSharedEmbeddingTextCache({ maxEntries: 2 });
  const release = deferred<Float32Array[]>();
  provider.embed = async texts => { calls.push([...texts]); return texts[0] === 'a' ? release.promise : texts.map(vector); };
  const first = cache.embed(['a', 'b'], { space });
  const shared = cache.embed(['a'], { space });
  assert.equal(await cache.embed(['c'], { space }), null);
  assert.equal(calls.length, 2, 'one query plus the one held batch');
  release.resolve([vector(), vector()]);
  assert.ok(await first); assert.ok(await shared);
  assert.ok(await cache.embed(['c'], { space }), 'settled entries can be evicted for newer text');
  assert.equal(calls.length, 3);
});

test('settled eviction is LRU and a changed exact text receives a new vector', async () => {
  const space = await query(), cache = createSharedEmbeddingTextCache({ maxEntries: 2 });
  await cache.embed(['a', 'b'], { space });
  await cache.embed(['a'], { space });
  await cache.embed(['c'], { space });
  await cache.embed(['a'], { space });
  await cache.embed(['b'], { space });
  assert.deepEqual(calls.slice(1), [['a', 'b'], ['c'], ['b']]);
});

test('retained text and raw input bounds reject work before provider invocation', async () => {
  const space = await query(), cache = createSharedEmbeddingTextCache({ maxTextCharacters: 4 });
  assert.equal(await cache.embed(['oversized'], { space }), null);
  const oversized: string[] = new Array(4097);
  Object.defineProperty(oversized, 0, { get() { throw new Error('an oversized request must be rejected before reading its contents'); } });
  assert.equal(await cache.embed(oversized, { space }), null);
  assert.equal(calls.length, 1);
  assert.ok(await cache.embed(['a'], { space }));
});

test('nonfinite constructor limits retain finite default bounds', async () => {
  const space = await query(), cache = createSharedEmbeddingTextCache({ maxEntries: Infinity, maxTextCharacters: NaN });
  assert.equal(await cache.embed(Array.from({ length: 513 }, (_, i) => `item${i}`), { space }), null);
  assert.equal(calls.length, 1);
});

test('settled expiry permits a fresh batch without expiring pending work into a duplicate', async () => {
  const space = await query(), cache = createSharedEmbeddingTextCache({ ttlMs: 5 });
  await cache.embed(['a'], { space });
  await new Promise(resolve => setTimeout(resolve, 20));
  await cache.embed(['a'], { space });
  assert.equal(calls.length, 3);
});

test('returned vector mutation cannot poison a later consumer of the cache', async () => {
  const space = await query(), cache = createSharedEmbeddingTextCache();
  const first = await cache.embed(['a'], { space }); assert.ok(first);
  first.vectors[0]![0] = 900;
  const second = await cache.embed(['a'], { space }); assert.ok(second);
  assert.equal(second.vectors[0]![0], 1);
  assert.equal(calls.length, 2);
});

test('one failed physical batch counts one health failure and all entries retry', async () => {
  const space = await query(), cache = createSharedEmbeddingTextCache();
  let batches = 0;
  provider.embed = async texts => {
    batches++;
    if (batches === 1) throw new Error('synthetic one-batch refusal');
    return texts.map(vector);
  };
  assert.equal(await cache.embed(['a', 'b', 'c'], { space }), null);
  assert.equal(getEmbeddingHealth().consecutiveFailures, 1, 'failure is not counted per document');
  assert.ok(await cache.embed(['a', 'b', 'c'], { space }));
  assert.equal(batches, 2);
  assert.equal(getEmbeddingHealth().consecutiveFailures, 0);
});

test('typed queue skips release entries without opening a breaker', async () => {
  const space = await query(), cache = createSharedEmbeddingTextCache();
  let batches = 0;
  provider.embed = async texts => { if (++batches === 1) throw new EmbeddingWorkSkippedError('queue_full'); return texts.map(vector); };
  assert.equal(await cache.embed(['a'], { space }), null);
  assert.equal(getEmbeddingHealth().consecutiveFailures, 0);
  assert.ok(await cache.embed(['a'], { space }));
});

test('one unbounded subscriber extends a whole shared batch and promotes it once', async () => {
  const space = await query(), cache = createSharedEmbeddingTextCache();
  const release = deferred<Float32Array[]>();
  let work: EmbeddingWorkOptions | undefined, updates = 0;
  provider.embed = async (_texts, options) => {
    work = options;
    options?.onQueued?.({ update() { updates++; }, cancel() { throw new Error('subscribers must not cancel shared work'); } });
    return release.promise;
  };
  const first = cache.embed(['a', 'b'], { space, priority: 'background', deadlineAtMs: Date.now() + 40 });
  const initialUpdates = updates;
  const second = cache.embed(['b', 'a'], { space, priority: 'foreground' });
  assert.equal(work?.deadlineAtMs, undefined); assert.equal(work?.priority, 'foreground');
  assert.equal(updates, initialUpdates + 1, 'one batch update, not one update per document');
  assert.equal(await first, null);
  release.resolve([vector(), vector()]);
  assert.ok(await second);
});

test('clear cannot let an old completion replace a newer same-key entry', async () => {
  const space = await query(), cache = createSharedEmbeddingTextCache();
  const release = deferred<Float32Array[]>(); let batches = 0;
  provider.embed = async texts => ++batches === 1 ? release.promise : texts.map(() => new Float32Array([0, 1]));
  const old = cache.embed(['a'], { space }); cache.clear();
  const current = await cache.embed(['a'], { space }); assert.ok(current);
  release.resolve([vector()]); assert.equal(await old, null); await turn();
  assert.deepEqual([...(await cache.embed(['a'], { space }))!.vectors[0]!], [0, 1]);
  assert.equal(batches, 2);
});

test('copied space metadata is not an authenticated producer lease', async () => {
  const space = await query(), cache = createSharedEmbeddingTextCache();
  assert.equal(await cache.embed(['a'], { space: { ...space } }), null);
  assert.equal(calls.length, 1);
});
