/**
 * Run: npx tsx --test src/runtime/builtin-workflows.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'clemmy-builtin-workflows-test-'));
process.env.CLEMENTINE_HOME = path.join(tmp, 'home');
mkdirSync(process.env.CLEMENTINE_HOME, { recursive: true });

const {
  ensureBuiltInWorkflows,
  OBJECTIVE_EXECUTION_WORKFLOW_SLUG,
  OBJECTIVE_EXECUTION_WORKFLOW_NAME,
} = await import('./builtin-workflows.js');
const { readWorkflow } = await import('../memory/workflow-store.js');
const { validateWorkflowDefinition } = await import('../execution/workflow-validator.js');

test.after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('ensureBuiltInWorkflows seeds the generic objective execution loop once', () => {
  const first = ensureBuiltInWorkflows();
  assert.deepEqual(first.installed, [OBJECTIVE_EXECUTION_WORKFLOW_SLUG]);
  assert.deepEqual(first.skipped, []);

  const second = ensureBuiltInWorkflows();
  assert.deepEqual(second.installed, []);
  assert.deepEqual(second.skipped, [OBJECTIVE_EXECUTION_WORKFLOW_SLUG]);

  const entry = readWorkflow(OBJECTIVE_EXECUTION_WORKFLOW_SLUG);
  assert.ok(entry, 'workflow should read back');
  assert.equal(entry!.data.name, OBJECTIVE_EXECUTION_WORKFLOW_NAME);
  assert.equal(entry!.data.enabled, true);
  assert.equal(entry!.data.allowSends, false);
  assert.ok(entry!.data.goal?.objective, 'workflow should pin a run-level goal');
  assert.ok((entry!.data.goal?.successCriteria ?? []).length >= 4, 'workflow should declare concrete success criteria');

  for (const required of ['objective', 'context', 'success_target', 'time_horizon', 'review_policy']) {
    assert.ok(entry!.data.inputs?.[required], `missing input ${required}`);
  }

  const byId = new Map(entry!.data.steps.map((step) => [step.id, step]));
  assert.equal(byId.get('persist_operating_record')?.dependsOn?.includes('operating_plan'), true);
  assert.ok(byId.get('persist_operating_record')?.allowedTools?.includes('goal_upsert'));
  assert.equal(byId.get('execute_work_item')?.forEach, 'operating_plan');
  assert.equal(byId.get('execute_work_item')?.sideEffect, 'write');

  const external = byId.get('execute_approved_external_action');
  assert.ok(external, 'approved external action step exists');
  assert.equal(external!.forEach, 'prepare_approval_packet');
  assert.equal(external!.requiresApproval, true);
  assert.equal(external!.sideEffect, 'send');
  assert.match(external!.approvalPreview ?? '', /externally visible/);

  const validation = validateWorkflowDefinition(entry!.data);
  assert.deepEqual(validation.errors, []);
  assert.ok(
    existsSync(path.join(entry!.dir, 'references', 'operating-principles.md')),
    'operating principles should be installed with the workflow',
  );

  const haystack = JSON.stringify(entry!.data).toLowerCase();
  assert.equal(/instagram|linkedin|hashtags|caption/.test(haystack), false, 'built-in should not hard-code a specific channel domain');
});
