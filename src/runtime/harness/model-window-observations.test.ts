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
