import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewPlanWithinRepairBudget } from './plan-review-repair-policy.js';

test('final repaired candidate is reviewed even after both send-backs', async () => {
  const reviewed: string[] = [];
  for (let round = 0; round < 3; round++) {
    const result = await reviewPlanWithinRepairBudget(async () => {
      reviewed.push(`candidate-${round}`);
      return round === 2 ? 'done' : 'continue';
    }, round, 2);
    assert.equal(result.requestRepair, round < 2);
  }
  assert.deepEqual(reviewed, ['candidate-0', 'candidate-1', 'candidate-2']);
});

test('a still-negative final candidate is reviewed without another repair loop', async () => {
  let reviewed = false;
  assert.deepEqual(await reviewPlanWithinRepairBudget(async () => {
    reviewed = true;
    return 'continue';
  }, 2, 2), { requestRepair: false, budgetSpent: true });
  assert.equal(reviewed, true);
});

test('review errors do not manufacture a successful final review', async () => {
  await assert.rejects(reviewPlanWithinRepairBudget(async () => {
    throw new Error('review unavailable');
  }, 2, 2), /review unavailable/);
});
