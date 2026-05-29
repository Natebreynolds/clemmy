/**
 * Run: npx tsx --test src/agents/workflow-step-agent.test.ts
 *
 * The safety contract of the constrained step agent: it KEEPS the
 * open-ended work-tool surface a real workflow step needs, and it REMOVES
 * only the recursion / fan-out / authoring / planning vectors behind the
 * 2026-05-28 run-explosion. (Blocklist, not whitelist — a whitelist
 * silently stripped composio_status + notify_user and broke
 * outlook-triage-hourly.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOW_STEP_BLOCKED_TOOL_NAMES, filterToolsForStep } from './workflow-step-agent.js';

// A representative slice of the orchestrator's tool pool, including the
// work tools whose removal broke outlook-triage-hourly.
const SAMPLE_TOOLS = [
  { name: 'workflow_step_result' },
  { name: 'composio_status' },        // triage preflight — MUST survive
  { name: 'composio_execute_tool' },  // gateway to OUTLOOK_* etc. — MUST survive
  { name: 'notify_user' },            // triage's output channel — MUST survive
  { name: 'request_approval' },       // legacy in-prompt gate — MUST survive
  { name: 'read_file' },
  { name: 'run_shell_command' },      // sf CLI path — MUST survive
  { name: 'memory_recall' },
  { name: 'workflow_get' },           // harmless read — MUST survive
  // recursion / meta vectors — must be removed
  { name: 'workflow_run' },
  { name: 'workflow_create' },
  { name: 'run_worker' },
  { name: 'surface_plan' },
  { name: 'ask_user_question' },
  { name: 'add_cron_job' },
];

test('step surface KEEPS the work tools real workflows need (triage regression)', () => {
  const kept = new Set(filterToolsForStep(SAMPLE_TOOLS).map((t) => t.name));
  for (const name of [
    'workflow_step_result',
    'composio_status',
    'composio_execute_tool',
    'notify_user',
    'request_approval',
    'run_shell_command',
    'read_file',
    'memory_recall',
    'workflow_get',
  ]) {
    assert.ok(kept.has(name), `step surface must KEEP ${name}`);
  }
});

test('step surface REMOVES recursion / fan-out / authoring / planning vectors', () => {
  const kept = new Set(filterToolsForStep(SAMPLE_TOOLS).map((t) => t.name));
  for (const name of [
    'workflow_run',
    'workflow_create',
    'run_worker',
    'surface_plan',
    'ask_user_question',
    'add_cron_job',
  ]) {
    assert.equal(kept.has(name), false, `step surface must REMOVE ${name}`);
    assert.ok(WORKFLOW_STEP_BLOCKED_TOOL_NAMES.has(name), `${name} must be in the blocklist`);
  }
});
