/**
 * A planning turn may still talk, and recovery must offer what the mode allows.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/plan-mode-conversation.test.ts
 *
 * Live 2026-09-07, source 146042 (ten-account Sheet job, explicit Plan):
 *   146113  check_in — "Only 6 prospect accounts found for Tim"
 *   146114  PLAN_MODE_READ_ONLY: check_in cannot execute in Plan mode
 *   146115  the governor records a repair whose recoveryToolNames is [check_in]
 *   146116  continue / retry_available, TWO retries still remaining
 *   146121  blocked: control_no_progress_exhausted / recovery_surface_mismatch
 *
 * Prohibited, then prescribed, then the carrier she was using removed. Clem had
 * found six accounts and was trying to say so.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planModeCallRefusal } from './accepted-task-mode.js';

const PLAN = { version: 1, kind: 'plan' } as const;
const refusal = (toolName: string, args: unknown = {}) =>
  planModeCallRefusal({ mode: PLAN, toolName, args });

test('THE 146042 CASE: a mid-task progress note is allowed in Plan', () => {
  assert.equal(
    refusal('check_in', { message: 'Only 6 prospect accounts found for Tim; pulling activity next.' }),
    undefined,
    'narrating findings crosses no boundary',
  );
});

test('host-only tools the registry declares as WRITES stay refused', () => {
  // The ceiling is external consequence, not "is it host_only". Admitting the
  // whole host_only class would have let durable writes through.
  for (const name of ['memory_remember', 'focus_set', 'pending_action_queue']) {
    assert.ok(refusal(name, { text: 'x' }), `${name} must remain refused in Plan`);
  }
});

test('business writes are untouched', () => {
  for (const name of ['workflow_create', 'space_save', 'write_file']) {
    assert.ok(refusal(name, { name: 'x' }), `${name} must remain refused in Plan`);
  }
});

test('ordinary reads and the plan surface still pass', () => {
  assert.equal(refusal('read_file', { path: 'a.md' }), undefined);
  assert.equal(refusal('publish_plan', {}), undefined);
  assert.equal(refusal('run_worker', {}), undefined);
});

test('the refusal names the constraint, not an internal label', () => {
  const message = refusal('workflow_create', { name: 'x' }) ?? '';
  assert.match(message, /cannot execute in Plan mode/);
  assert.match(message, /publish_plan/, 'and points at the action that IS available');
});
