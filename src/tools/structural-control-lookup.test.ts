/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/structural-control-lookup.test.ts
 *
 * Searching for Clementine's own plan/work controls by name answers with the
 * controls, however the rest of the query is worded; naming a real operation
 * beside them stays ordinary discovery.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isHostStructuralPlanningControlLookup } = await import('./structural-control-lookup.js');

test('naming plan_task with any wording and no other operation is a control lookup', () => {
  for (const query of [
    'plan_task coordinate business dependencies execution graph',
    'plan_task create dependency graph coordinated actions execute sealed work plan',
    'plan_task graph requirements dependencies',
    'plan_task schema',
    'how do I use work_call',
  ]) assert.equal(isHostStructuralPlanningControlLookup(query), true, query);
});

test('a query that also names an operation stays discovery', () => {
  for (const query of [
    'GITHUB_CREATE_A_PULL_REQUEST for plan_task',
    'plan_task space_set_data drafts',
    'work_call workflow_create exact schema',
    '[role:clause-0:read] Google Sheets batch get values for one cell using work_call',
  ]) assert.equal(isHostStructuralPlanningControlLookup(query), false, query);
});

test('ordinary prose about planning is not a control lookup', () => {
  assert.equal(isHostStructuralPlanningControlLookup('make a plan for the blog launch'), false);
});
