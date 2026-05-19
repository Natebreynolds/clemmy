/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-plan-store npx tsx --test src/planning/plan-store.test.ts
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-plan-store';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const { PlanStore } = await import('./plan-store.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  // PlanStore uses on-disk JSON; clear between tests.
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

test('string[] steps still work — verify is absent', () => {
  const plan = new PlanStore().create('write the docs', ['outline sections', 'draft content', 'review']);
  assert.equal(plan.steps.length, 3);
  for (const step of plan.steps) {
    assert.equal(step.verify, undefined, `step "${step.text}" should have no verify`);
  }
});

test('rich {text, verify} steps persist the verify check', () => {
  const plan = new PlanStore().create('ship the migration', [
    { text: 'write the migration file', verify: 'file exists at migrations/0042_add_x.sql' },
    { text: 'run migration locally', verify: 'psql shows the new column' },
    { text: 'deploy to staging' },
  ]);
  assert.equal(plan.steps[0].verify, 'file exists at migrations/0042_add_x.sql');
  assert.equal(plan.steps[1].verify, 'psql shows the new column');
  assert.equal(plan.steps[2].verify, undefined, 'omitted verify stays undefined, not empty string');
});

test('mixed string + rich shapes coexist in one plan', () => {
  const plan = new PlanStore().create('audit auth flow', [
    'read src/auth/*',
    { text: 'add token-rotation handler', verify: 'unit test covers 401 → refresh path' },
    'document the change',
  ]);
  assert.equal(plan.steps[0].verify, undefined);
  assert.equal(plan.steps[1].verify, 'unit test covers 401 → refresh path');
  assert.equal(plan.steps[2].verify, undefined);
});

test('whitespace-only verify is normalized to undefined (not stored)', () => {
  const plan = new PlanStore().create('p', [
    { text: 'do thing', verify: '   ' },
  ]);
  assert.equal(plan.steps[0].verify, undefined);
});

test('empty strings in steps array are filtered before build', () => {
  const plan = new PlanStore().create('p', ['', 'real step', '']);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].text, 'real step');
});
