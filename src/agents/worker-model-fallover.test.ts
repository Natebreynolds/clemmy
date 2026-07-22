import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearWorkerModelCooldownsForTest,
  isWorkerModelCoolingDown,
  markWorkerModelCoolingDown,
  pickWorkerModelWithFallover,
  workerFailureLooksRateLimited,
} from './worker-model-fallover.js';

beforeEach(() => clearWorkerModelCooldownsForTest());

test('rate-limit classifier: provider infra shapes yes, item defects no', () => {
  assert.equal(workerFailureLooksRateLimited('ERROR: worker for "x" failed: 429 Rate limit reached for requests'), true);
  assert.equal(workerFailureLooksRateLimited('provider overloaded, retry later'), true);
  assert.equal(workerFailureLooksRateLimited('usage_limit_reached'), true);
  assert.equal(workerFailureLooksRateLimited('quota exceeded for org'), true);
  assert.equal(workerFailureLooksRateLimited('ERROR: no rows matched the filter'), false);
  assert.equal(workerFailureLooksRateLimited('400 Unknown model kimi-k9'), false, 'unknown-model has its own heal');
  assert.equal(workerFailureLooksRateLimited(null), false);
});

test('cooldown memo: benched models are skipped, healthy routed model is untouched', () => {
  assert.deepEqual(pickWorkerModelWithFallover(['kimi-k3', 'glm-5.2', 'claude-x']), { model: 'kimi-k3' });
  markWorkerModelCoolingDown('kimi-k3');
  assert.equal(isWorkerModelCoolingDown('kimi-k3'), true);
  assert.deepEqual(
    pickWorkerModelWithFallover(['kimi-k3', 'glm-5.2', 'claude-x']),
    { model: 'glm-5.2', falloverFrom: 'kimi-k3' },
  );
});

test('exhausted chain returns the routed model unchanged — fail visibly, never invent', () => {
  markWorkerModelCoolingDown('a');
  markWorkerModelCoolingDown('b');
  assert.deepEqual(pickWorkerModelWithFallover(['a', 'b']), { model: 'a' });
  // Blank/dup candidates are ignored; empty chain yields empty model.
  assert.deepEqual(pickWorkerModelWithFallover(['', null, undefined]), { model: '' });
  assert.deepEqual(pickWorkerModelWithFallover(['x', 'x', 'x']), { model: 'x' });
});

test('cooldown honors retry-after with cushion, caps at 30min, never shortens', () => {
  markWorkerModelCoolingDown('m', 90 * 60_000); // request 90min → capped to 30
  assert.equal(isWorkerModelCoolingDown('m'), true);
  // A second racing failure with a SHORT retry-after must not shrink the bench:
  markWorkerModelCoolingDown('m', 1); // ~5s effective — smaller than the existing 30min
  assert.equal(isWorkerModelCoolingDown('m'), true, 'bench survives the shorter racer');
});

test('REAL Moonshot 429 text classifies rate-limited RAW, even though normalization eats the code', async () => {
  const { workerFailureSignature } = await import('./worker-job-packet.js');
  const real = 'An error occurred while running the tool. Please try again. Error: Error: 429 Your account org-47cdcfa64dec44539bf5fc1343e676a0 has exceeded its request limit.';
  // The live blinding: the normalized signature loses the literal 429…
  const normalized = workerFailureSignature(real);
  assert.doesNotMatch(normalized, /429/, 'normalization rewrites the status code');
  // …so the branch must classify on the RAW text, which stays detectable.
  assert.equal(workerFailureLooksRateLimited(real), true);
});
