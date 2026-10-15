/** Synthetic provider API controls: no network, ONNX, models or live home. */
import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EmbeddingProvider } from './embeddings.js';
import type { EmbeddingWorkOptions, EmbeddingWorkUpdate } from './embedding-worker.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-embedding-space-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_EMBED_PROVIDER = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'false';
delete process.env.OPENAI_API_KEY;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('Unexpected network in synthetic embedding test'); }) as typeof fetch;

const {
  embedQueryWithSpace, embedTextsWithSpace, getEmbeddingHealth,
  _setEmbeddingProviderForTest, _setLocalProviderForTest,
  _resetEmbeddingHealthForTest, _resetEmbedDemotionForTest,
  _setEmbeddingProviderHealthFileForTest,
} = await import('./embeddings.js');
const { EmbeddingWorkSkippedError } = await import('./embedding-worker.js');

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const vector = () => new Float32Array([1, 0]);
const batch = (texts: string[]) => texts.map(vector);
const admitted = () => new Promise<void>(resolve => setImmediate(resolve));

beforeEach(() => {
  process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
  _setEmbeddingProviderForTest(null);
  _setLocalProviderForTest(null);
  _setEmbeddingProviderHealthFileForTest(path.join(home, 'provider-health.json'));
  _resetEmbeddingHealthForTest();
  _resetEmbedDemotionForTest();
});
afterEach(() => {
  _setEmbeddingProviderForTest(null);
  _setLocalProviderForTest(null);
  _resetEmbeddingHealthForTest();
  _resetEmbedDemotionForTest();
});
after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });

test('short caller expires without cancelling or evicting shared work needed by later callers', async () => {
  const started = deferred<void>();
  const release = deferred<Float32Array[]>();
  const updates: EmbeddingWorkUpdate[] = [];
  let calls = 0, cancellations = 0;
  let work: EmbeddingWorkOptions | undefined;
  _setEmbeddingProviderForTest({ name: 'fixture-shared', model: 'shared-v1', dim: 2,
    async embed(_texts, options) {
      calls++; work = options;
      options?.onQueued?.({ update: update => updates.push({ ...update }), cancel: () => { cancellations++; } });
      started.resolve(); return release.promise;
    },
  });
  const shortDeadline = Date.now() + 35;
  const short = embedQueryWithSpace('shared budget', { priority: 'background', deadlineAtMs: shortDeadline });
  await started.promise;
  const longDeadline = Date.now() + 5_000;
  const long = embedQueryWithSpace('shared budget', { priority: 'foreground', deadlineAtMs: longDeadline });
  await admitted();
  assert.equal(work?.priority, 'foreground');
  assert.equal(work?.deadlineAtMs, longDeadline);
  assert.equal(await short, null, 'only the short caller stops waiting');
  const third = embedQueryWithSpace('shared budget', { deadlineAtMs: Date.now() + 1_000 });
  await admitted();
  assert.equal(calls, 1, 'expired subscriber did not evict or replay the producer');
  assert.equal(cancellations, 0, 'one subscriber cannot cancel another subscriber');
  assert.equal(work?.deadlineAtMs, longDeadline, 'a later shorter subscriber cannot shorten the lease');
  release.resolve([vector()]);
  const [a, b] = await Promise.all([long, third]);
  assert.ok(a); assert.strictEqual(a, b);
  assert.equal(a.model, 'shared-v1');
  assert.ok(updates.some(update => update.priority === 'foreground' && update.deadlineAtMs === longDeadline));
  assert.strictEqual(await embedQueryWithSpace('shared budget'), a, 'settled producer remains cached');
  assert.equal(calls, 1);
});

test('an unbounded subscriber removes a finite shared deadline without extra work', async () => {
  const started = deferred<void>(), release = deferred<Float32Array[]>();
  let calls = 0, work: EmbeddingWorkOptions | undefined;
  const updates: EmbeddingWorkUpdate[] = [];
  _setEmbeddingProviderForTest({ name: 'fixture-unbounded', model: 'lease-v1', dim: 2,
    async embed(_texts, options) {
      calls++; work = options;
      options?.onQueued?.({ update: update => updates.push({ ...update }), cancel() {} });
      started.resolve(); return release.promise;
    },
  });
  const finite = embedQueryWithSpace('unbounded share', { deadlineAtMs: Date.now() + 35 });
  await started.promise;
  const unbounded = embedQueryWithSpace('unbounded share');
  await admitted();
  assert.equal(work?.deadlineAtMs, undefined);
  assert.ok(updates.some(update => Object.hasOwn(update, 'deadlineAtMs') && update.deadlineAtMs === undefined));
  assert.equal(await finite, null);
  release.resolve([vector()]);
  assert.ok(await unbounded); assert.equal(calls, 1);
});

test('unpinned text callers respect their deadline even when the provider ignores it', async () => {
  const started = deferred<void>(), release = deferred<Float32Array[]>();
  let completed = false;
  _setEmbeddingProviderForTest({ name: 'fixture-ignores-budget', model: 'slow-v1', dim: 2,
    async embed() { started.resolve(); const out = await release.promise; completed = true; return out; },
  });
  const result = embedTextsWithSpace(['document'], { deadlineAtMs: Date.now() + 35 });
  await started.promise;
  assert.equal(await result, null);
  assert.equal(completed, false, 'the caller returned while the provider remained unresolved');
  release.resolve([vector()]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(getEmbeddingHealth().consecutiveFailures, 0);
});

test('a synchronous producer finishing after its deadline cannot beat a blocked timer', async () => {
  let calls = 0;
  _setEmbeddingProviderForTest({ name: 'fixture-sync', model: 'blocked-loop-v1', dim: 2,
    async embed(texts) {
      calls++;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
      return batch(texts);
    },
  });
  const result = await embedQueryWithSpace('synchronous native fallback', { deadlineAtMs: Date.now() + 30 });
  assert.equal(calls, 1);
  assert.equal(result, null, 'a completed result is still too late for this caller');
});

test('queue retirement and expired work do not poison provider health', async () => {
  let calls = 0;
  _setEmbeddingProviderForTest({ name: 'fixture-skips', model: 'skip-v1', dim: 2,
    async embed() { calls++; throw new EmbeddingWorkSkippedError('queue_full'); },
  });
  for (let i = 0; i < 4; i++) assert.equal(await embedQueryWithSpace(`skipped ${i}`), null);
  assert.equal(calls, 4, 'skips do not open a breaker that prevents later admission');
  const beforeExpired = calls;
  assert.equal(await embedQueryWithSpace('already expired', { deadlineAtMs: Date.now() - 1 }), null);
  assert.equal(calls, beforeExpired, 'expired work does not invoke the provider');
  assert.equal(getEmbeddingHealth().consecutiveFailures, 0);
  assert.equal(getEmbeddingHealth().breakerOpen, false);
});

test('same-call local rescue reports its real space and pins documents without retrying remote', async () => {
  process.env.CLEMMY_LOCAL_EMBEDDINGS = 'on';
  let remoteCalls = 0, localCalls = 0;
  _setEmbeddingProviderForTest({ name: 'openai', model: 'remote-v1', dim: 2,
    async embed() { remoteCalls++; throw new Error('synthetic transport unavailable'); },
  });
  _setLocalProviderForTest({ name: 'local', model: 'rescue-v1', dim: 2,
    async embed(texts) { localCalls++; return batch(texts); },
  });
  const query = await embedQueryWithSpace('rescue query');
  assert.ok(query); assert.equal(query.spaceKey, 'local:rescue-v1:2');
  assert.equal(query.model, 'rescue-v1'); assert.equal(query.dim, 2);
  assert.equal(getEmbeddingHealth().consecutiveFailures, 1);
  const documents = await embedTextsWithSpace(['document'], { space: query });
  assert.ok(documents); assert.equal(documents.spaceKey, query.spaceKey);
  assert.equal(remoteCalls, 1); assert.equal(localCalls, 2);
  assert.equal(getEmbeddingHealth().consecutiveFailures, 1, 'rescue success does not erase the failed primary call');
});

test('a pinned remote producer still admits only one document batch at a time', async () => {
  const started = deferred<void>(), release = deferred<Float32Array[]>();
  let calls = 0;
  _setEmbeddingProviderForTest({ name: 'openai', model: 'single-flight-v1', dim: 2,
    async embed(texts) {
      calls++;
      if (texts[0] === 'hold document') { started.resolve(); return release.promise; }
      return batch(texts);
    },
  });
  const query = await embedQueryWithSpace('remote query'); assert.ok(query);
  const first = embedTextsWithSpace(['hold document'], { space: query });
  await started.promise;
  assert.equal(await embedTextsWithSpace(['competing document'], { space: query }), null);
  assert.equal(calls, 2, 'query plus one admitted document batch');
  release.resolve([vector()]); assert.ok(await first);
  assert.equal(getEmbeddingHealth().consecutiveFailures, 0);
});

test('successful pinned primary documents reset consecutive failure accounting', async () => {
  _setEmbeddingProviderForTest({ name: 'openai', model: 'alternating-v1', dim: 2,
    async embed(texts) {
      if (texts[0] === 'fail') throw new Error('synthetic temporary failure');
      return batch(texts);
    },
  });
  const query = await embedQueryWithSpace('primary query'); assert.ok(query);
  for (let i = 0; i < 3; i++) {
    assert.equal(await embedTextsWithSpace(['fail'], { space: query }), null);
    assert.equal(getEmbeddingHealth().consecutiveFailures, 1);
    assert.ok(await embedTextsWithSpace(['success'], { space: query }));
    assert.equal(getEmbeddingHealth().consecutiveFailures, 0);
    assert.equal(getEmbeddingHealth().breakerOpen, false);
  }
});

test('wrong dimensions, zero vectors, nonfinite vectors and wrong batch size fail closed', async () => {
  const invalid = [
    [new Float32Array([1])], [new Float32Array([0, 0])],
    [new Float32Array([Number.NaN, 1])], [new Float32Array([Number.POSITIVE_INFINITY, 1])], [],
  ];
  for (const [i, vectors] of invalid.entries()) {
    _resetEmbeddingHealthForTest();
    _setEmbeddingProviderForTest({ name: 'fixture-invalid', model: `invalid-${i}`, dim: 2,
      async embed() { return vectors; },
    });
    assert.equal(await embedQueryWithSpace(`invalid ${i}`), null);
  }
});

test('same-sized provider replacement cannot relabel a retained query lease', async () => {
  const first: EmbeddingProvider = { name: 'fixture', model: 'space-a', dim: 2, async embed(texts) { return texts.map(() => new Float32Array([1, 0])); } };
  let secondCalls = 0;
  const second: EmbeddingProvider = { name: 'fixture', model: 'space-b', dim: 2, async embed(texts) { secondCalls++; return texts.map(() => new Float32Array([0, 1])); } };
  _setEmbeddingProviderForTest(first);
  const queryA = await embedQueryWithSpace('identical query'); assert.ok(queryA);
  _setEmbeddingProviderForTest(second);
  const docsA = await embedTextsWithSpace(['document A'], { space: queryA });
  assert.equal(docsA?.spaceKey, 'fixture:space-a:2');
  assert.deepEqual(Array.from(docsA!.vectors[0]), [1, 0]); assert.equal(secondCalls, 0);
  const queryB = await embedQueryWithSpace('identical query'); assert.ok(queryB);
  assert.equal(queryB.spaceKey, 'fixture:space-b:2');
  assert.deepEqual(Array.from(queryB.vector), [0, 1]); assert.equal(secondCalls, 1);
  assert.equal(await embedTextsWithSpace(['forged'], { space: { ...queryA } }), null, 'a copied descriptor is not the opaque producer lease');
});
