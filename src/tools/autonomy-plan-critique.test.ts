/**
 * Move 2 — deterministic pre-execution plan critique. Run:
 *   npx tsx --test src/tools/autonomy-plan-critique.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { critiquePlan } from './autonomy-action-tools.js';
import type { Plan } from '../agents/planner.js';

function mkPlan(over: Partial<Plan>): Plan {
  return {
    objective: 'do the thing',
    steps: [{ n: 1, action: 'pull data', rationale: 'needed', verification: 'rows > 0' }],
    successCriteria: ['data pulled'],
    stages: null,
    risks: [],
    estimatedComplexity: 'moderate',
    recommendsTrackedExecution: false,
    needsUserInput: [],
    appliedInstructions: [],
    externalSends: [],
    ...over,
  } as Plan;
}

test('critiquePlan: flags a success criterion covered by NO stage', () => {
  const issues = critiquePlan(mkPlan({
    successCriteria: ['A', 'B'],
    stages: [{ title: 's1', criteria: ['A'] }],
  }));
  assert.ok(issues.some((i) => /NO stage/i.test(i) && i.includes('B')), `expected uncovered-criterion issue, got: ${JSON.stringify(issues)}`);
});

test('critiquePlan: flags a criterion duplicated across stages', () => {
  const issues = critiquePlan(mkPlan({
    successCriteria: ['A'],
    stages: [{ title: 's1', criteria: ['A'] }, { title: 's2', criteria: ['A'] }],
  }));
  assert.ok(issues.some((i) => /2 times across stages/.test(i)), `expected duplicate-criterion issue, got: ${JSON.stringify(issues)}`);
});

test('critiquePlan: a coherent staged plan yields NO issues', () => {
  const issues = critiquePlan(mkPlan({
    successCriteria: ['A', 'B'],
    stages: [{ title: 's1', criteria: ['A'] }, { title: 's2', criteria: ['B'] }],
  }));
  assert.deepEqual(issues, []);
});

test('critiquePlan: a LARGE plan with unverifiable steps is flagged; a trivial one is not', () => {
  const big = critiquePlan(mkPlan({
    estimatedComplexity: 'large',
    steps: [
      { n: 1, action: 'a', rationale: 'r', verification: null },
      { n: 2, action: 'b', rationale: 'r', verification: 'checked' },
    ],
  }));
  assert.ok(big.some((i) => /no verification/i.test(i)), `expected unverifiable-steps issue, got: ${JSON.stringify(big)}`);

  const small = critiquePlan(mkPlan({
    estimatedComplexity: 'trivial',
    steps: [{ n: 1, action: 'a', rationale: 'r', verification: null }],
  }));
  assert.deepEqual(small, [], 'verification is only required on significant/large plans');
});
