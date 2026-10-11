import assert from 'node:assert/strict';
import test from 'node:test';
import { modelScoreLine, modelScoreRow, type ModelScoreRowLike } from './model-scorecard-presentation.js';

const row = (role: string, modelId: string, extra: Partial<ModelScoreRowLike> = {}): ModelScoreRowLike => ({
  role, modelId, calls: 0, failedCalls: 0, cacheHitRate: null, latencyMs: null, reviewed: 0, passed: 0,
  toolTurns: 0, toolTurnsLanded: 0, fellOver: 0, stoodIn: 0, billedUsd: null, ...extra,
});

test('one line per role, in the order a person reads it, with only what was measured', () => {
  const card = { window: { days: 7 }, rows: [
    row('brain', 'model-a', { calls: 430, failedCalls: 3, reviewed: 10, passed: 9, toolTurns: 40, toolTurnsLanded: 38,
      latencyMs: { p50: 2_140, p95: 9_000 }, cacheHitRate: 0.812, fellOver: 2 }),
    row('judge', 'model-c', { calls: 1, latencyMs: { p50: 14_400, p95: 14_400 } }),
  ] };
  assert.equal(modelScoreLine(card, 'brain', 'model-a'),
    'This week: 430 calls · 3 failed · 9 of 10 passed review · tools worked 95% of the time · 2.1 s typical · 81% cached · fell back 2 times');
  assert.equal(modelScoreLine(card, 'judge', 'model-c'), 'This week: 1 check · 14 s typical');
  assert.equal(modelScoreLine(card, 'quick', 'model-q'), 'This week: not used.');
});

test('a share under twenty reads as a count, and a cost shows only when billed', () => {
  const card = { window: { days: 30 }, rows: [row('worker', 'model-w', { calls: 25, reviewed: 25, passed: 24, toolTurns: 4, toolTurnsLanded: 3, billedUsd: 1.234, stoodIn: 1 })] };
  assert.equal(modelScoreLine(card, 'worker', 'model-w'),
    'Last 30 days: 25 calls · 96% passed review · tools worked 3 of 4 times · stood in 1 time · $1.23 billed');
});

test('a new home says nothing; a role that moved models names the one that ran', () => {
  assert.equal(modelScoreLine({ window: { days: 7 }, rows: [] }, 'brain', 'model-a'), null);
  assert.equal(modelScoreLine(null, 'brain'), null);
  const card = { window: { days: 7 }, rows: [row('brain', 'org/model-old', { calls: 12 }), row('brain', 'model-b', { calls: 3 })] };
  assert.equal(modelScoreRow(card, 'brain', 'model-new')?.modelId, 'org/model-old');
  assert.match(modelScoreLine(card, 'brain', 'model-new') ?? '', /^This week on .+: 12 calls$/);
  assert.equal(modelScoreLine(card, 'brain', 'model-b'), 'This week: 3 calls');
});
