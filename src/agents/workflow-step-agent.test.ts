/**
 * Run: npx tsx --test src/agents/workflow-step-agent.test.ts
 *
 * The safety contract of the constrained step agent: it CAN emit a
 * structured result, and it CANNOT re-trigger workflows / fan out /
 * message the user — the vectors behind the 2026-05-28 run-explosion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOW_STEP_TOOL_NAMES } from './workflow-step-agent.js';

test('step surface INCLUDES the structured-output channel + core action tools', () => {
  for (const name of [
    'workflow_step_result',
    'composio_execute_tool',
    'run_shell_command',
    'read_file',
    'memory_recall',
  ]) {
    assert.ok(WORKFLOW_STEP_TOOL_NAMES.has(name), `expected step surface to include ${name}`);
  }
});

test('step surface EXCLUDES recursion / fan-out / meta vectors', () => {
  // These are exactly what let a starved step re-queue its own workflow
  // (recursion) or escalate — must NOT be available to a step.
  for (const name of [
    'workflow_run',
    'workflow_create',
    'workflow_update',
    'workflow_delete',
    'workflow_schedule',
    'workflow_unschedule',
    'run_worker',
    'request_approval',
    'ask_user_question',
    'notify_user',
    'surface_plan',
  ]) {
    assert.equal(WORKFLOW_STEP_TOOL_NAMES.has(name), false, `step surface must NOT include ${name}`);
  }
});
