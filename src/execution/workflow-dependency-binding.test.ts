import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDependencyBinding } from './workflow-enforce.js';
import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';

/**
 * Author-time data-binding rule (checkDependencyBinding).
 *
 * `dependsOn` only ORDERS steps — it does NOT pass data. A step that
 * declares a dependency but never references its output (no
 * {{steps.<id>.output}} token, no inputs binding pulling steps.<id>) gets
 * an empty STEP CONTEXT and blocks at run time. These tests pin the rule
 * that refuses such a step at create/enable, plus the orderingOnlyDeps
 * escape hatch and the forEach/usesSkill/deterministic exemptions.
 */

function def(steps: WorkflowStepInput[]): WorkflowDefinition {
  return {
    name: 'test-wf',
    description: 'a test workflow definition',
    enabled: true,
    trigger: { manual: true },
    steps,
  };
}

test('dependsOn X + prompt references {{steps.X.output}} → no error', () => {
  const errors = checkDependencyBinding(
    def([
      { id: 'fetch', prompt: 'Fetch the data.' },
      { id: 'use', prompt: 'Summarize {{steps.fetch.output}} into bullets.', dependsOn: ['fetch'] },
    ]),
  );
  assert.deepEqual(errors, []);
});

test('dependsOn X + an inputs binding referencing steps.X → no error', () => {
  const errors = checkDependencyBinding(
    def([
      { id: 'fetch', prompt: 'Fetch the data.' },
      {
        id: 'use',
        prompt: 'Summarize the fetched rows.',
        dependsOn: ['fetch'],
        inputs: { rows: { from: 'steps.fetch.output.items' } } as WorkflowStepInput['inputs'],
      },
    ]),
  );
  assert.deepEqual(errors, []);
});

test('dependsOn X but references X nowhere → ERROR naming X + orderingOnlyDeps hint', () => {
  const errors = checkDependencyBinding(
    def([
      { id: 'fetch', prompt: 'Fetch the data.' },
      { id: 'use', prompt: 'Summarize the data into bullets.', dependsOn: ['fetch'] },
    ]),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Step "use" depends on "fetch"/);
  assert.match(errors[0], /orderingOnlyDeps/);
});

test('dependsOn X but X in orderingOnlyDeps → no error (escape works)', () => {
  const errors = checkDependencyBinding(
    def([
      { id: 'fetch', prompt: 'Fetch the data.' },
      {
        id: 'use',
        prompt: 'Do unrelated work that just needs fetch to have run first.',
        dependsOn: ['fetch'],
        orderingOnlyDeps: ['fetch'],
      },
    ]),
  );
  assert.deepEqual(errors, []);
});

test('forEach step dependsOn X with no reference → no error (exempt)', () => {
  const errors = checkDependencyBinding(
    def([
      { id: 'list', prompt: 'Build the list.' },
      { id: 'each', prompt: 'Process this account.', dependsOn: ['list'], forEach: '{{steps.list.output}}' },
    ]),
  );
  assert.deepEqual(errors, []);
});

test('usesSkill step dependsOn X with no reference → no error (exempt)', () => {
  const errors = checkDependencyBinding(
    def([
      { id: 'gather', prompt: 'Gather the inputs.' },
      { id: 'transform', prompt: 'Run the transform.', dependsOn: ['gather'], usesSkill: 'my-skill' },
    ]),
  );
  assert.deepEqual(errors, []);
});

test('deterministic step dependsOn X with no reference → no error (exempt)', () => {
  const errors = checkDependencyBinding(
    def([
      { id: 'gather', prompt: 'Gather the inputs.' },
      {
        id: 'script',
        prompt: 'Run the helper.',
        dependsOn: ['gather'],
        deterministic: { runner: 'scripts/run.ts' } as WorkflowStepInput['deterministic'],
      },
    ]),
  );
  assert.deepEqual(errors, []);
});

test('step with no dependsOn → no error', () => {
  const errors = checkDependencyBinding(
    def([{ id: 'solo', prompt: 'Just do the thing.' }]),
  );
  assert.deepEqual(errors, []);
});

test('real incident shape: one bound dep, one unbound dep → ERROR for the unbound dep only', () => {
  const errors = checkDependencyBinding(
    def([
      { id: 'enrich_missing_seo_once', prompt: 'Enrich SEO for missing accounts.' },
      { id: 'find_or_create_tracker', prompt: 'Find or create the tracker sheet.' },
      {
        id: 'upsert_account_rows',
        prompt: 'Upsert rows into the tracker {{steps.find_or_create_tracker.output}}.',
        dependsOn: ['enrich_missing_seo_once', 'find_or_create_tracker'],
      },
    ]),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Step "upsert_account_rows" depends on "enrich_missing_seo_once"/);
  assert.doesNotMatch(errors[0], /depends on "find_or_create_tracker"/);
});
