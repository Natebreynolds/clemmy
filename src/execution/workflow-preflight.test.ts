/**
 * Run: npx tsx --test src/execution/workflow-preflight.test.ts
 *
 * Side-effect-free runnability preflight (backs the DRY-RUN button +
 * promotion smoke-test). Composes checkWorkflowForWrite + missing-inputs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightWorkflow, renderPreflightReport } from './workflow-preflight.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';

function wf(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'demo',
    description: 'demo workflow',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'a', prompt: 'do a thing' }],
    ...overrides,
  } as WorkflowDefinition;
}

test('preflight: a clean workflow passes', () => {
  const r = preflightWorkflow(wf());
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.match(r.summary, /Preflight passed/);
});

test('preflight: a structurally-broken workflow fails (hand-off language)', () => {
  const r = preflightWorkflow(wf({ steps: [{ id: 'a', prompt: 'do it; a future turn will handle the rest' }] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 1);
  assert.match(r.summary, /blocking issue/);
});

test('preflight: missing run inputs are a heads-up, NOT a failure (workflow is still runnable)', () => {
  const def = wf({
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
    inputs: { segment: { type: 'string' } } as WorkflowDefinition['inputs'],
  });
  const r = preflightWorkflow(def, {}); // no inputs supplied
  assert.equal(r.ok, true);                       // structurally runnable
  assert.deepEqual(r.missingInputs, ['segment']); // but flagged
  assert.match(r.summary, /you'll need to supply "segment"/);
});

test('preflight: supplying the input clears the heads-up', () => {
  const def = wf({
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
    inputs: { segment: { type: 'string' } } as WorkflowDefinition['inputs'],
  });
  const r = preflightWorkflow(def, { segment: 'law firms' });
  assert.deepEqual(r.missingInputs, []);
});

test('renderPreflightReport: legible, and states nothing was executed', () => {
  const body = renderPreflightReport('demo', preflightWorkflow(wf()));
  assert.match(body, /✅ Dry-run preflight: demo/);
  assert.match(body, /no tools ran, nothing was sent/);
});
