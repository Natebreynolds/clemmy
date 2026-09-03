/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-turn-runner-refusal-directive.test.ts
 *
 * A refusal must name its door. `host_control_requires_direct_first_class_call`
 * had no branch and returned the bare error, so three consecutive live runs on
 * 2026-09-03 re-issued the identical wrapped frame and died at the refusal
 * ceiling with a correct plan body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostFrameRefusalDirective } from './host-turn-runner.js';

test('the control-carrier refusal names the operation and the direct-call repair', () => {
  const text = hostFrameRefusalDirective('host_control_requires_direct_first_class_call', {
    offendingOperation: 'plan_task',
  });
  assert.match(text, /plan_task/, 'names the operation the model actually used');
  assert.match(text, /DIRECTLY/, 'states the repair');
  assert.match(text, /never wrapped in call_tool or work_call/, 'names the wrong envelope');
  assert.match(text, /arguments were not the problem/, 'tells the model its proposal survived');
  // The generic read door teaches work_call — the very wrapping being refused.
  assert.doesNotMatch(text, /Exact carrier: work_call/, 'must not steer back into the refused carrier');
});

test('it degrades without an operation name rather than emitting undefined', () => {
  const text = hostFrameRefusalDirective('host_control_requires_direct_first_class_call', {});
  assert.doesNotMatch(text, /undefined|null/);
  assert.match(text, /DIRECTLY/);
});
