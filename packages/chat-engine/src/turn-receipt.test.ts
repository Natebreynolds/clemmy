import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnModelName, turnReview } from './turn-receipt.js';
import { boundedModelId, modelDisplayName } from './model-name.js';
import { readQuestionOptions } from './question-options.js';
import { MODEL_PHASE_ACTIVITY_ID, reduceActivity } from './reduce-activity.js';
import type { ActivityItem } from './types.js';

test('a model id reads the way a person says it', () => {
  assert.equal(modelDisplayName('vendor-ai/Vendor-V4.1-Fast'), 'Vendor V4.1 Fast');
  assert.equal(modelDisplayName('acme-large-4-5-20250101'), 'Acme Large 4.5');
  assert.equal(modelDisplayName('qrs-5.2-mini'), 'QRS 5.2 Mini');
  assert.equal(modelDisplayName('open-coder-70b-latest'), 'Open Coder 70B');
  assert.equal(modelDisplayName('build-4-1106-preview'), 'Build 4 1106 Preview');
  assert.equal(modelDisplayName('  '), '');
});

test('a namespaced model id is a name, and a provider alone never is', () => {
  const rows = reduceActivity([], { seq: 1, type: 'turn_model_routed', data: { model: 'vendor-ai/Vendor-V4.1-Fast', provider: 'byo' } }, () => 1);
  assert.equal(rows[0]?.id, MODEL_PHASE_ACTIVITY_ID);
  assert.equal(rows[0]?.label, 'Thinking with Vendor V4.1 Fast…');
  assert.equal(turnModelName(rows), 'Vendor V4.1 Fast');
  const providerOnly = reduceActivity([], { seq: 1, type: 'turn_model_routed', data: { provider: 'byo' } }, () => 1);
  assert.equal(turnModelName(providerOnly), undefined);
  assert.equal(turnModelName([]), undefined);
  assert.equal(boundedModelId('a/b/c'), '');
  assert.equal(boundedModelId('../etc'), '');
});

test('the last verdict decides the review line, and no reviewer is never a pass', () => {
  const verdict = (pass: boolean, failedOpen = false): ActivityItem[] => reduceActivity(
    [], { seq: 1, type: 'verdict_recorded', data: { door: 'completion', pass, failedOpen } }, () => 1,
  );
  assert.equal(turnReview([...verdict(false), ...verdict(true)]), 'checked');
  assert.equal(turnReview(verdict(true, true)), 'unchecked');
  assert.equal(turnReview(verdict(false)), 'rejected');
  assert.equal(turnReview([]), null);
  assert.equal(turnReview(undefined), null);
});

test('question options keep real, distinct, readable choices only', () => {
  assert.deepEqual(readQuestionOptions(['Your inbox', ' your  inbox ', '', 42, 'The shared inbox', 'x'.repeat(121)]), ['Your inbox', 'The shared inbox']);
  assert.deepEqual(readQuestionOptions('Your inbox'), []);
  assert.equal(readQuestionOptions(Array.from({ length: 12 }, (_v, i) => `Option ${i}`)).length, 8);
});
