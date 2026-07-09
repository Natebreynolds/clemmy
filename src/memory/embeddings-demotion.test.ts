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
// Keep the local transformers model from ACTUALLY loading in this test — the
// selection logic is what's under test, not the ONNX runtime.
process.env.CLEMMY_LOCAL_EMBEDDINGS = process.env.CLEMMY_LOCAL_EMBEDDINGS ?? '';

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
  _setLocalProviderForTest(undefined);
  delete process.env.CLEMMY_EMBED_LOCAL_FALLBACK;
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

test('kill-switch CLEMMY_EMBED_LOCAL_FALLBACK=off keeps the legacy FTS-only degradation', () => {
  process.env.CLEMMY_EMBED_LOCAL_FALLBACK = 'off';
  _driveEmbedFailureForTest(new Error('insufficient_quota: exceeded your current quota'));
  assert.equal(activeEmbeddingModel(), EMBEDDING_MODEL, 'no demotion with the kill-switch off');
  assert.equal(getEmbeddingHealth().breakerOpen, true, 'legacy breaker behavior intact');
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
