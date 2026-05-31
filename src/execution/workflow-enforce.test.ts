/**
 * Run: npx tsx --test src/execution/workflow-enforce.test.ts
 *
 * Author/enable-time enforcement of the typed workflow contract.
 * Validation is UNCONDITIONAL (the WORKFLOW_TYPED_CONTRACT rollout flag was
 * removed 2026-05-31 — feedback_no_rollout_flags). Every error describes a
 * workflow that would already fail at run time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWorkflowForWrite, checkRunnabilityConstraints } from './workflow-enforce.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';

function wf(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'demo',
    description: 'demo workflow',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'a', prompt: 'do a thing' }],
    ...overrides,
  } as WorkflowDefinition;
}

test('checkWorkflowForWrite: a clean manual workflow validates ok', () => {
  const result = checkWorkflowForWrite(wf());
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('checkWorkflowForWrite: enabled send workflow without approval gate is rejected', () => {
  const offending = wf({
    steps: [{ id: 'send', prompt: 'send the emails to the leads' }],
  });
  const result = checkWorkflowForWrite(offending);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /approval gate/i);
});

// ─── runnability (the "can't author an unrunnable workflow" guarantee) ───

test('checkRunnabilityConstraints: schedule-only + required non-common input with no default → error', () => {
  // 'segment' is NOT in COMMON_WORKFLOW_INPUT_KEYS, so it has no auto-supply
  // path on a scheduled run — must be flagged.
  const def = wf({
    trigger: { schedule: '0 9 * * *' }, // schedule, no manual
    inputs: { segment: { type: 'string' } } as WorkflowDefinition['inputs'],
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
  });
  const errors = checkRunnabilityConstraints(def);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no default and no way to be supplied/i);
  assert.match(errors[0], /segment/);
});

test('checkRunnabilityConstraints: schedule-only + required COMMON input (url) is allowed (injectable)', () => {
  const def = wf({
    trigger: { schedule: '0 9 * * *' },
    steps: [{ id: 'a', prompt: 'audit {{input.url}}' }],
  });
  assert.deepEqual(checkRunnabilityConstraints(def), []);
});

test('checkRunnabilityConstraints: manual trigger never blocks a required input (caller supplies it)', () => {
  const def = wf({
    trigger: { manual: true },
    inputs: { segment: { type: 'string' } } as WorkflowDefinition['inputs'],
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
  });
  assert.deepEqual(checkRunnabilityConstraints(def), []);
});

test('checkRunnabilityConstraints: schedule-only + required input WITH a default is allowed', () => {
  const def = wf({
    trigger: { schedule: '0 9 * * *' },
    inputs: { segment: { type: 'string', default: 'enterprise' } } as WorkflowDefinition['inputs'],
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
  });
  assert.deepEqual(checkRunnabilityConstraints(def), []);
});

test('checkRunnabilityConstraints: schedule + manual together never blocks (a caller can pass inputs)', () => {
  const def = wf({
    trigger: { schedule: '0 9 * * *', manual: true },
    inputs: { segment: { type: 'string' } } as WorkflowDefinition['inputs'],
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
  });
  assert.deepEqual(checkRunnabilityConstraints(def), []);
});
