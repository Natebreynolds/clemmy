/**
 * Run: npx tsx --test src/memory/embeddings.test.ts
 *
 * Uses Node's built-in test runner so we have no new dependencies and
 * tests work the moment you check out the branch. When the project
 * adopts a proper test framework later, these files port verbatim —
 * the assertions are identical to anything vitest/jest would use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bufferToVector,
  classifyEmbedError,
  embedErrorIsRetryable,
  cosine,
  EMBEDDING_DIM,
  embedQuery,
  getEmbeddingHealth,
  isEmbeddingsEnabled,
  vectorToBuffer,
  _resetEmbeddingHealthForTest,
  _driveEmbedFailureForTest,
  _driveEmbedSuccessForTest,
  _setEmbeddingProviderForTest,
} from './embeddings.js';

test('embedQuery in-flight cache: two CONCURRENT identical embeds make ONE provider call (the per-turn double-embed)', async () => {
  _resetEmbeddingHealthForTest();
  let calls = 0;
  _setEmbeddingProviderForTest({
    id: 'test-counter',
    dim: EMBEDDING_DIM,
    embed: async (texts: string[]) => {
      calls += 1;
      return texts.map(() => new Float32Array(EMBEDDING_DIM));
    },
  } as any);
  try {
    // The hot path: buildTurnMemoryPrimer + primeTurnRecallVector both embed
    // options.input concurrently. Caching the promise collapses them to one call.
    const [a, b] = await Promise.all([embedQuery('pull my market leaders'), embedQuery('pull my market leaders')]);
    assert.ok(a && b);
    assert.equal(calls, 1, 'concurrent identical embeds deduped to a single provider call');
    // A DIFFERENT query is a distinct call.
    await embedQuery('something else entirely');
    assert.equal(calls, 2);
  } finally {
    _setEmbeddingProviderForTest(undefined);
    _resetEmbeddingHealthForTest();
  }
});

test('embedQuery in-flight cache: kill-switch off ⇒ every call hits the provider', async () => {
  _resetEmbeddingHealthForTest();
  const prev = process.env.CLEMMY_EMBED_QUERY_CACHE;
  process.env.CLEMMY_EMBED_QUERY_CACHE = 'off';
  let calls = 0;
  _setEmbeddingProviderForTest({
    id: 'test-counter', dim: EMBEDDING_DIM,
    embed: async (texts: string[]) => { calls += 1; return texts.map(() => new Float32Array(EMBEDDING_DIM)); },
  } as any);
  try {
    await Promise.all([embedQuery('same query'), embedQuery('same query')]);
    assert.equal(calls, 2, 'cache disabled → no dedup');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_EMBED_QUERY_CACHE; else process.env.CLEMMY_EMBED_QUERY_CACHE = prev;
    _setEmbeddingProviderForTest(undefined);
    _resetEmbeddingHealthForTest();
  }
});

test('embedQuery cache is cleared when the embedding provider changes', async () => {
  _resetEmbeddingHealthForTest();
  let callsA = 0;
  let callsB = 0;
  _setEmbeddingProviderForTest({
    name: 'test-a',
    model: 'a',
    dim: EMBEDDING_DIM,
    embed: async (texts: string[]) => {
      callsA += 1;
      return texts.map(() => Float32Array.from({ length: EMBEDDING_DIM }, () => 1));
    },
  });
  try {
    const a = await embedQuery('same query after provider swap');
    assert.ok(a);
    assert.equal(callsA, 1);
    _setEmbeddingProviderForTest({
      name: 'test-b',
      model: 'b',
      dim: EMBEDDING_DIM,
      embed: async (texts: string[]) => {
        callsB += 1;
        return texts.map(() => Float32Array.from({ length: EMBEDDING_DIM }, () => 2));
      },
    });
    const b = await embedQuery('same query after provider swap');
    assert.ok(b);
    assert.equal(callsB, 1, 'provider swap must not reuse the previous provider vector');
    assert.equal(b[0], 2);
  } finally {
    _setEmbeddingProviderForTest(undefined);
    _resetEmbeddingHealthForTest();
  }
});

test('vectorToBuffer + bufferToVector roundtrip preserves vectors', () => {
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = Math.sin(i * 0.01);
  const buffer = vectorToBuffer(v);
  const restored = bufferToVector(buffer);

  assert.equal(restored.length, v.length, 'length matches');
  // Roundtrip should be bit-exact for Float32.
  for (let i = 0; i < v.length; i++) {
    assert.equal(restored[i], v[i], `index ${i} differs`);
  }
});

test('vectorToBuffer copies storage (does not alias)', () => {
  const v = new Float32Array(4);
  v[0] = 1; v[1] = 2; v[2] = 3; v[3] = 4;
  const buffer = vectorToBuffer(v);
  // Mutate the source vector — buffer should not change.
  v[0] = 99;
  const restored = bufferToVector(buffer);
  assert.equal(restored[0], 1, 'buffer must not alias source vector');
});

test('cosine of identical vectors is 1', () => {
  const v = new Float32Array(8);
  for (let i = 0; i < 8; i++) v[i] = i + 1;
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6, 'expected cosine ≈ 1');
});

test('cosine of orthogonal vectors is 0', () => {
  const a = new Float32Array([1, 0, 0, 0]);
  const b = new Float32Array([0, 1, 0, 0]);
  assert.equal(cosine(a, b), 0);
});

test('cosine of antiparallel vectors is -1', () => {
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([-1, -2, -3]);
  assert.ok(Math.abs(cosine(a, b) - -1) < 1e-6);
});

test('cosine returns 0 when one vector is zero (avoids NaN)', () => {
  const a = new Float32Array([1, 2, 3]);
  const z = new Float32Array([0, 0, 0]);
  assert.equal(cosine(a, z), 0);
  assert.equal(cosine(z, a), 0);
  assert.equal(cosine(z, z), 0);
});

test('cosine returns 0 on mismatched lengths (different provider spaces)', () => {
  const a = new Float32Array([1, 0, 0, 100]);
  const b = new Float32Array([1, 0, 0]); // length 3
  // WS3: a 1536-dim OpenAI vector and a 384-dim local vector live in different
  // spaces — comparing them is meaningless, so cosine returns 0 rather than a
  // garbage truncated score that would corrupt ranking/dedup.
  assert.equal(cosine(a, b), 0);
});

test('isEmbeddingsEnabled honors EMBEDDINGS_DISABLED (key-decoupled opt-out)', () => {
  // process.env takes precedence over any .env file, so this is hermetic
  // regardless of the live install's EMBEDDINGS_DISABLED setting.
  const prevDisabled = process.env.EMBEDDINGS_DISABLED;
  const prevKey = process.env.OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = 'sk-test-key-present';

    // Explicit opt-out wins even with a key present → FTS-only.
    process.env.EMBEDDINGS_DISABLED = 'true';
    assert.equal(isEmbeddingsEnabled(), false, 'EMBEDDINGS_DISABLED=true must disable embeddings');

    // Explicit false (overrides any inherited true) → key presence governs.
    process.env.EMBEDDINGS_DISABLED = 'false';
    assert.equal(isEmbeddingsEnabled(), true, 'EMBEDDINGS_DISABLED=false leaves key-presence behavior');
  } finally {
    if (prevDisabled === undefined) delete process.env.EMBEDDINGS_DISABLED; else process.env.EMBEDDINGS_DISABLED = prevDisabled;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
  }
});

test('classifyEmbedError: maps API errors to terminal/transient classes', () => {
  assert.equal(classifyEmbedError(new Error('Embeddings API 429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details","type":"insufficient_quota"}}')), 'quota');
  assert.equal(classifyEmbedError(new Error('Embeddings API 401: {"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}')), 'auth');
  assert.equal(classifyEmbedError(new Error('OPENAI_API_KEY is not set')), 'auth');
  assert.equal(classifyEmbedError(new Error('Embeddings API 429: {"error":{"type":"rate_limit_exceeded"}}')), 'rate_limit');
  assert.equal(classifyEmbedError(new Error('The operation was aborted due to timeout')), 'transient');
  assert.equal(classifyEmbedError(new Error('Embeddings API 503: upstream error')), 'transient');
});

test('embedErrorIsRetryable: retries genuine transient (timeout/5xx), NOT persistent 4xx or terminal', () => {
  // Genuine transient blips → worth one retry.
  assert.equal(embedErrorIsRetryable(new Error('The operation was aborted due to timeout')), true);
  assert.equal(embedErrorIsRetryable(new Error('Embeddings API 503: upstream error')), true);
  assert.equal(embedErrorIsRetryable(new Error('fetch failed: ECONNRESET')), true);
  // Persistent CLIENT errors classify as 'transient' by default but must NOT retry
  // (they fail identically and double the synchronous JIT/recall latency).
  assert.equal(embedErrorIsRetryable(new Error('Embeddings API 400: input array too large')), false);
  assert.equal(embedErrorIsRetryable(new Error('Embeddings API 404: model not found')), false);
  // Terminal / rate-limit are never retried.
  assert.equal(embedErrorIsRetryable(new Error('Embeddings API 401: invalid_api_key')), false);
  assert.equal(embedErrorIsRetryable(new Error('exceeded your current quota, check your plan and billing')), false);
  assert.equal(embedErrorIsRetryable(new Error('Embeddings API 429: rate_limit_exceeded')), false);
});

test('breaker: a quota error opens the breaker IMMEDIATELY with a long cooldown', () => {
  // Pin the LEGACY breaker semantics with the local-fallback demotion off —
  // with it on (the default), a quota open demotes to the local provider and
  // deliberately clears this cooldown (see embeddings-demotion.test.ts).
  process.env.CLEMMY_EMBED_LOCAL_FALLBACK = 'off';
  try {
    _resetEmbeddingHealthForTest();
    _driveEmbedFailureForTest(new Error('Embeddings API 429: insufficient_quota — exceeded your current quota'));
    const h = getEmbeddingHealth();
    assert.equal(h.breakerOpen, true, 'one quota failure must open the breaker');
    assert.equal(h.lastErrorClass, 'quota');
    // ~1h cooldown, not the 5-min transient one.
    assert.ok(h.cooldownUntilMs - Date.now() > 30 * 60_000, 'terminal cooldown should be far longer than transient');
  } finally {
    delete process.env.CLEMMY_EMBED_LOCAL_FALLBACK;
  }
});

test('breaker: a single transient error does NOT open the breaker (needs 3)', () => {
  _resetEmbeddingHealthForTest();
  _driveEmbedFailureForTest(new Error('connect ETIMEDOUT'));
  assert.equal(getEmbeddingHealth().breakerOpen, false, 'one transient blip must not drop recall to FTS');
  _driveEmbedFailureForTest(new Error('connect ETIMEDOUT'));
  _driveEmbedFailureForTest(new Error('connect ETIMEDOUT'));
  assert.equal(getEmbeddingHealth().breakerOpen, true, 'three transient failures open the breaker');
});

test('breaker: success resets state and records lastSuccessAt', () => {
  // Legacy semantics — a terminal open would otherwise demote to local and
  // clear the breaker (embeddings-demotion.test.ts covers that path).
  process.env.CLEMMY_EMBED_LOCAL_FALLBACK = 'off';
  try {
    _resetEmbeddingHealthForTest();
    _driveEmbedFailureForTest(new Error('Embeddings API 401: invalid_api_key'));
    assert.equal(getEmbeddingHealth().breakerOpen, true);
    _driveEmbedSuccessForTest();
    const h = getEmbeddingHealth();
    assert.equal(h.breakerOpen, false, 'success closes the breaker');
    assert.equal(h.consecutiveFailures, 0);
    assert.equal(h.lastErrorClass, null);
    assert.ok(h.lastSuccessAt, 'lastSuccessAt is recorded');
  } finally {
    delete process.env.CLEMMY_EMBED_LOCAL_FALLBACK;
  }
});
