import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityAwareCompactionThresholds } from './context-capacity-policy.js';

const normal = { resultTriggerTokens: 48000, retainedResultBudgetTokens: 20000,
  minRetainPairs: 3, maxRetainPairs: 8, checkpointed: true };

test('ordinary cached frames keep their original policy and object', () => {
  assert.equal(capacityAwareCompactionThresholds(normal, 200000, 180000).thresholds, normal);
  assert.equal(capacityAwareCompactionThresholds(normal, 1000000, 250000).thresholds, normal);
});

test('instructions and current input can cause pressure below the result-only trigger', () => {
  const result = capacityAwareCompactionThresholds(normal, 200000, 150000 + 15000 + 20000);
  assert.equal(result.capacityPressure, true);
  assert.equal(result.thresholds.maxRetainPairs, 1);
  assert.equal(result.thresholds.minRetainPairs, 1);
  assert.equal(result.thresholds.checkpointed, true);
  assert.equal(normal.minRetainPairs, 3);
});

test('unavailable or malformed capacity does not invent a pressure signal', () => {
  for (const window of [0, -1, NaN, Infinity]) {
    assert.equal(capacityAwareCompactionThresholds(normal, window, 100000).capacityPressure, false);
  }
  assert.equal(capacityAwareCompactionThresholds(normal, 200000, NaN).capacityPressure, false);
});
