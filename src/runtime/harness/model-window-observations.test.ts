import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';

// Isolated home BEFORE imports that read BASE_DIR (standard test-home pattern).
const TMP_HOME = path.join(process.env.TMPDIR ?? '/tmp', `clem-window-obs-${process.pid}`);
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  effectiveContextWindow,
  recordCatalogWindow,
  recordWindowAcceptance,
  recordWindowRejection,
  _resetModelWindowObservationCacheForTests,
} = await import('./model-window-observations.js');
const { compactionBudgetForModel } = await import('./compaction.js');
const { normalizeModelsList } = await import('./byo-providers.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * REGRESSION PIN — evidence beats the static registry, both directions.
 *
 * The owner's concern (2026-08-05): hard-coded model→window rows rot when
 * Anthropic/OpenAI/Together ship new or improved models. The contract that
 * prevents that:
 *   1. unknown NEW model → conservative registry fallback (early compaction,
 *      never overflow) — nothing breaks on release day;
 *   2. a provider catalog listing teaches the real window with zero code;
 *   3. a live overflow rejection ratchets the belief DOWN after ONE failure;
 *   4. a live acceptance above belief raises it (provider behavior wins).
 */

test('unknown new model falls back to the conservative registry default — never overflows', () => {
  _resetModelWindowObservationCacheForTests();
  const w = effectiveContextWindow('gpt-7-brand-new');
  assert.equal(w, 272_000, 'future gpt-* rides the codex family row');
  assert.equal(effectiveContextWindow('totally-unknown-model'), 128_000, 'unmatched ids get the 128K floor');
});

test('a provider catalog listing overrides the registry seed with zero code changes', () => {
  _resetModelWindowObservationCacheForTests();
  // Simulate the exact Together/Moonshot models-endpoint shape.
  const models = normalizeModelsList({ data: [
    { id: 'vendor/new-huge-model', context_length: 2_000_000 },
    { id: 'vendor/no-window-model' },
  ] });
  assert.equal(models.find((m) => m.id === 'vendor/new-huge-model')?.contextLength, 2_000_000, 'catalog window survives normalization');
  recordCatalogWindow('vendor/new-huge-model', 2_000_000, 'https://api.example.test/v1');
  assert.equal(effectiveContextWindow('vendor/new-huge-model'), 2_000_000);
  assert.equal(compactionBudgetForModel('vendor/new-huge-model'), 2_000_000, 'compaction budget follows the evidence');
});

test('an overflow rejection ratchets the window DOWN after one failure', () => {
  _resetModelWindowObservationCacheForTests();
  recordCatalogWindow('vendor/shrunk-model', 200_000);
  recordWindowRejection('vendor/shrunk-model'); // no attempted size → 10% ratchet
  assert.equal(effectiveContextWindow('vendor/shrunk-model'), 180_000);
  recordWindowRejection('vendor/shrunk-model', 150_000); // known attempted size → hard ceiling
  assert.equal(effectiveContextWindow('vendor/shrunk-model'), 149_999);
});

test('a live acceptance above belief raises the floor; acceptance wins over an older lower rejection', () => {
  _resetModelWindowObservationCacheForTests();
  recordWindowRejection('vendor/improved-model', 100_000);
  assert.equal(effectiveContextWindow('vendor/improved-model'), 99_999);
  recordWindowAcceptance('vendor/improved-model', 400_000); // provider now accepts more
  assert.equal(effectiveContextWindow('vendor/improved-model'), 400_000, 'live provider behavior is the tiebreak');
});

test('acceptance at or below current belief writes nothing (steady-state cost is zero)', () => {
  _resetModelWindowObservationCacheForTests();
  recordWindowAcceptance('gpt-5.4', 100_000); // below the 272K registry row
  assert.equal(effectiveContextWindow('gpt-5.4'), 272_000, 'registry belief unchanged');
});

test('windowScaleForModel: tuned-for-200K defaults scale with the real window, clamped [1, 4]', async () => {
  _resetModelWindowObservationCacheForTests();
  const { windowScaleForModel } = await import('./model-window-observations.js');
  assert.equal(windowScaleForModel('gpt-5.4'), 272_000 / 200_000, 'codex 272K scales 1.36x');
  assert.equal(windowScaleForModel('kimi-k3'), 4, '1M window clamps at 4x, never unbounded');
  assert.equal(windowScaleForModel('claude-opus-4-8'), 4);
  assert.equal(windowScaleForModel('totally-unknown-model'), 1, 'unknown window never scales below the tuned default');
  assert.equal(windowScaleForModel(undefined), 1);
});

test('warmByoProviderCatalogs: daemon start records provider windows without the models UI (fire-and-forget, dead-provider safe)', async () => {
  // REGRESSION PIN (2026-08-06 live-run review): the observation layer shipped
  // with the console route as its only catalog feed — a daemon whose models UI
  // was never opened ran on registry seeds forever. The startup warm lists
  // every CONFIGURED provider and records published windows; a dead provider
  // must cost only its own timeout, never a throw.
  _resetModelWindowObservationCacheForTests();
  const { warmByoProviderCatalogs, discoverProviderModels } = await import('./byo-providers.js');

  // Direct path: a provider response with context_length reaches the store.
  const fakeFetch = (async () => new Response(JSON.stringify({
    data: [{ id: 'warm-test/model-a', context_length: 300_000 }, { id: 'warm-test/model-b' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  const result = await discoverProviderModels({ baseURL: 'https://warm.example.test/v1', apiKey: 'k' }, fakeFetch);
  assert.equal(result.status, 200);
  // recording is fire-and-forget — give the microtask queue one beat.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(effectiveContextWindow('warm-test/model-a'), 300_000, 'published window became an observation');
  assert.equal(effectiveContextWindow('warm-test/model-b'), 128_000, 'no published window → registry fallback untouched');

  // The startup wrapper never throws even with unreachable configured providers.
  const recorded = await warmByoProviderCatalogs(500);
  assert.equal(typeof recorded, 'number');
});

// ─── The wire teaches the harness whether it caches ──────────────────────────
//
// The registry seeds supportsPromptCache per family, and on 2026-09-12 that
// seed was measurably wrong for a shipping brain: grok was marked non-caching
// on a 2026-08-20 note reading "no server-side prompt cache contract we can
// rely on", while this machine's usage log held 673 of 690 grok calls reporting
// cache reads — 3,457,024 cached of 11,449,913 input tokens, cacheDialect
// 'inclusive' on every one. The evidence was recorded all along; nothing read
// it. That flag decides whether mid-turn compaction stays absolute or scales
// with the window, so reading it wrong pinned a 256k brain to a 32k trigger.
//
// A model a user plugs in tomorrow must not wait on a code release.
test('a non-caching seed flips only after the wire proves it, repeatedly', async () => {
  const obs = await import('./model-window-observations.js');
  const id = 'fixture-unknown-brain-1';

  // An unknown model seeds non-caching and stays there on no evidence.
  assert.equal(obs.effectivePromptCacheSupport(id), false);

  // A few cache-less calls teach nothing — absence of a hit is a cold prefix,
  // not proof of a contract.
  for (let i = 0; i < 8; i += 1) obs.recordCacheObservation(id, 5_000, 0);
  obs._resetModelWindowObservationCacheForTests();
  assert.equal(obs.effectivePromptCacheSupport(id), false,
    'calls without hits must never flip a wire');

  // One hit is a fluke, not a contract.
  obs.recordCacheObservation(id, 5_000, 2_000);
  obs._resetModelWindowObservationCacheForTests();
  assert.equal(obs.effectivePromptCacheSupport(id), false, 'one hit is not proof');

  // Five hits against eight misses is a wire that mostly re-prefills: the
  // budgets that protect a cached prefix would cost more than they save.
  for (let i = 0; i < 5; i += 1) obs.recordCacheObservation(id, 5_000, 2_000);
  obs._resetModelWindowObservationCacheForTests();
  assert.equal(obs.effectivePromptCacheSupport(id), false,
    'hits that are outnumbered by misses do not make a caching wire');

  // Once the wire serves a cached prefix at least as often as it misses, it
  // has demonstrated its contract in practice and the seed no longer governs.
  for (let i = 0; i < 3; i += 1) obs.recordCacheObservation(id, 5_000, 2_000);
  obs._resetModelWindowObservationCacheForTests();
  assert.equal(obs.effectivePromptCacheSupport(id), true,
    'the wire demonstrated caching; the seed no longer governs');

  // And the practical floor is learned from the smallest prompt that hit.
  obs.recordCacheObservation(id, 1_093, 400);
  obs._resetModelWindowObservationCacheForTests();
  assert.ok(obs.effectiveCacheMinTokens(id) <= 1_093);
});

test('a seeded caching wire is never un-learned by a cold conversation', async () => {
  const obs = await import('./model-window-observations.js');
  // Claude seeds true. A run of cache-less calls (a genuinely cold prefix)
  // must not demote it — that would silently re-enable prefix-busting
  // collapses on exactly the wire the 2026-09-03 incident was measured on.
  for (let i = 0; i < 20; i += 1) obs.recordCacheObservation('claude-sonnet-5', 9_000, 0);
  obs._resetModelWindowObservationCacheForTests();
  assert.equal(obs.effectivePromptCacheSupport('claude-sonnet-5'), true);
});

test('a wire that misses more than it hits stays non-caching however many hits it collects', async () => {
  // Live 2026-09-15, the Codex OAuth brain: 124 cache reads in 367 calls over
  // three days (0 of 22 when the tool list changed, 3 of 27 when history was
  // rewritten, ~40% otherwise). Five lifetime hits had flipped it to "caches",
  // which scaled every compaction threshold to its 880k window — so a 67k
  // history was re-prefilled on six calls in ten and never compacted.
  const obs = await import('./model-window-observations.js');
  const { layer1CompactionBudgetForModel, inFlightPromptCacheScale } = await import('./compaction.js');
  const id = 'fixture-sometimes-cached-brain';
  obs.recordCatalogWindow(id, 880_000, 'https://fixture.example.test/v1');
  for (let i = 0; i < 367; i += 1) obs.recordCacheObservation(id, 60_000, i % 3 === 0 ? 40_000 : 0);
  obs._resetModelWindowObservationCacheForTests();
  assert.equal(obs.effectivePromptCacheSupport(id), false, '124 of 367 is not a wire that caches');
  assert.equal(inFlightPromptCacheScale(id), 1, 'mid-turn thresholds stay absolute');
  assert.equal(compactionBudgetForModel(id), 880_000, 'lossy layers still fork inside the real window');
  assert.equal(layer1CompactionBudgetForModel(id), 200_000, 'lossless Layer 1 is held to prefill cost');

  // The same wire serving a cached prefix on most calls earns its window back.
  const steady = 'fixture-steadily-cached-brain';
  obs.recordCatalogWindow(steady, 880_000, 'https://fixture.example.test/v1');
  for (let i = 0; i < 40; i += 1) obs.recordCacheObservation(steady, 60_000, i % 10 === 0 ? 0 : 50_000);
  obs._resetModelWindowObservationCacheForTests();
  assert.equal(obs.effectivePromptCacheSupport(steady), true);
  assert.equal(layer1CompactionBudgetForModel(steady), 880_000);
});

test('observation recording never throws on junk', async () => {
  const obs = await import('./model-window-observations.js');
  obs.recordCacheObservation('', 100, 10);
  obs.recordCacheObservation(null, 100, 10);
  obs.recordCacheObservation('x', 0, 0);
  obs.recordCacheObservation('x', 'nonsense' as unknown as number, undefined);
  assert.ok(true, 'budgeting must never break a turn');
});
