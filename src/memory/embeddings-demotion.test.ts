/**
 * Run: npx tsx --test src/memory/embeddings-demotion.test.ts
 *
 * 2026-07-08 — local-fallback demotion. When the OpenAI embedder trips its
 * breaker (quota/auth immediately; transient twice), the provider demotes to
 * the local model for the process lifetime instead of degrading recall to
 * FTS-only. 99 live embedQuery failures over two days motivated this.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const TEST_HOME = '/tmp/clemmy-test-emb-demotion';
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.OPENAI_API_KEY = 'sk-test-not-real';
// Keep the local transformers model from ACTUALLY loading in this test — the
// selection logic is what's under test, not the ONNX runtime.
process.env.CLEMMY_LOCAL_EMBEDDINGS = process.env.CLEMMY_LOCAL_EMBEDDINGS ?? '';

const {
  activeEmbeddingModel, getEmbeddingHealth, EMBEDDING_MODEL,
  _driveEmbedFailureForTest, _driveEmbedSuccessForTest,
  _resetEmbeddingHealthForTest, _resetEmbedDemotionForTest,
} = await import('./embeddings.js');

beforeEach(() => {
  _resetEmbeddingHealthForTest();
  _resetEmbedDemotionForTest();
  delete process.env.CLEMMY_EMBED_LOCAL_FALLBACK;
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
