/**
 * Run: npx tsx --test src/memory/embeddings-demotion.test.ts
 *
 * 2026-07-08 — local-fallback demotion. When the OpenAI embedder trips its
 * breaker (quota/auth immediately; transient twice), the provider demotes to
 * the local model for the process lifetime instead of degrading recall to
 * FTS-only. 99 live embedQuery failures over two days motivated this.
 */
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-test-emb-demotion-'));
const PROVIDER_HEALTH_FILE = path.join(TEST_HOME, 'state', 'embedding-provider-health.json');
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.OPENAI_API_KEY = 'sk-test-not-real';
// Exercise local failover, but always inject a fake provider so the real
// transformers model is never loaded or downloaded by this unit test.
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'on';

const {
  activeEmbeddingModel, embedQuery, getEmbeddingHealth, EMBEDDING_MODEL,
  _driveEmbedFailureForTest, _driveEmbedSuccessForTest,
  _resetEmbeddingHealthForTest, _resetEmbedDemotionForTest,
  _resetEmbeddingProviderCooldownsForTest,
  _setEmbeddingProviderHealthFileForTest,
  _setLocalProviderForTest,
} = await import('./embeddings.js');

const realFetch = globalThis.fetch;
_setEmbeddingProviderHealthFileForTest(PROVIDER_HEALTH_FILE);

function fakeLocalProvider() {
  return {
    name: 'local',
    model: 'test-local-embedding',
    dim: 4,
    async embed(texts: string[]) {
      return texts.map((text) => {
        const v = new Float32Array(4);
        v[0] = text.length || 1;
        v[1] = 1;
        return v;
      });
    },
  };
}

beforeEach(() => {
  _resetEmbeddingProviderCooldownsForTest();
  _resetEmbeddingHealthForTest();
  _resetEmbedDemotionForTest();
  _setLocalProviderForTest(fakeLocalProvider());
});

afterEach(() => {
  globalThis.fetch = realFetch;
  _setLocalProviderForTest(undefined);
  _resetEmbeddingProviderCooldownsForTest();
});

after(() => {
  _setEmbeddingProviderHealthFileForTest(null);
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('a TERMINAL breaker open (auth/quota) demotes to local on the FIRST open', () => {
  assert.equal(activeEmbeddingModel(), EMBEDDING_MODEL, 'baseline: OpenAI selected');
  _driveEmbedFailureForTest(new Error('401 invalid_api_key'));
  // Demoted: OpenAI is no longer the active provider (local reports once loaded;
  // sync view is null until then — either way, NOT the OpenAI model).
  assert.notEqual(activeEmbeddingModel(), EMBEDDING_MODEL, 'OpenAI no longer selected after terminal open');
  // The breaker was cleared on demotion — it guarded the OpenAI provider.
  assert.equal(getEmbeddingHealth().breakerOpen, false, 'breaker does not gate the local provider');
});

test('a single TRANSIENT breaker open does NOT demote; the second one does', () => {
  for (let i = 0; i < 3; i++) _driveEmbedFailureForTest(new Error('fetch timeout'));
  assert.equal(activeEmbeddingModel(), EMBEDDING_MODEL, 'first transient open: still OpenAI');
  // Breaker recovers, then a second run of failures opens it again.
  _driveEmbedSuccessForTest();
  for (let i = 0; i < 3; i++) _driveEmbedFailureForTest(new Error('fetch timeout'));
  assert.notEqual(activeEmbeddingModel(), EMBEDDING_MODEL, 'second transient open: demoted to local');
});

test('embedQuery retries the same request on local after terminal OpenAI failure', async () => {
  _setLocalProviderForTest(fakeLocalProvider());
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return {
      ok: false,
      status: 401,
      text: async () => 'invalid_api_key',
    };
  }) as unknown as typeof fetch;

  const vector = await embedQuery('semantic memory should stay online');

  assert.equal(fetchCalls, 1, 'OpenAI is attempted once');
  assert.ok(vector, 'same call returns a local vector instead of null');
  assert.equal(vector.length, 4);
  assert.equal(activeEmbeddingModel(), 'test-local-embedding');
  assert.equal(getEmbeddingHealth().breakerOpen, false, 'OpenAI breaker does not gate local recall');
});

test('embedQuery retries the same request on local after a single TRANSIENT OpenAI timeout', async () => {
  // Regression pin (2026-08-26): a terminal failure (above) already got a
  // same-call rescue for free, because it demotes and clears the breaker
  // within the same recordFailure() call. A transient timeout — measured
  // live as the actual failure mode, 24 times in one daemon's lifetime, the
  // breaker never once open — got nothing: fallbackProviderAfterFailure used
  // to route through getEmbeddingProvider(), which stays pinned to OpenAI
  // until 3 CONSECUTIVE failures accumulate, so the very first (or second)
  // timeout returned null and the already-warm local model sat idle. This
  // must rescue the call on the FIRST transient timeout, while leaving the
  // process's standing provider choice and the breaker's threshold — both
  // deliberately conservative, so one blip cannot flip the default provider
  // — completely untouched.
  _setLocalProviderForTest(fakeLocalProvider());
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('The operation was aborted due to timeout');
  }) as unknown as typeof fetch;

  const vector = await embedQuery('semantic memory should stay online during one bad network patch');

  // openaiEmbedBatch retries a genuinely transient error once internally
  // before the failure is even recorded toward the breaker.
  assert.equal(fetchCalls, 2, 'OpenAI is retried once internally before failing this call');
  assert.ok(vector, 'a single transient timeout still returns a local vector instead of null');
  assert.equal(vector.length, 4);
  // The process's default provider is NOT flipped by one rescued call: only
  // a second breaker-open (two full incidents) demotes it (see the transient
  // breaker test above).
  assert.equal(getEmbeddingHealth().breakerOpen, false, 'a single timeout does not open the breaker');
  assert.equal(getEmbeddingHealth().consecutiveFailures, 1, 'the rescue does not hide the failure from the breaker count');
});
