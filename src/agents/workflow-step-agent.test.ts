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
import { WORKFLOW_STEP_BLOCKED_TOOL_NAMES, filterToolsForStep, buildWorkflowStepAgent } from './workflow-step-agent.js';

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

// ── Feature A4: physically prune a bound step's tool surface ───────────────
import { lockToolsForStep, stepAllowedToolsLock, STEP_STRUCTURAL_BASELINE_TOOLS } from './workflow-step-agent.js';

const LOCK_SAMPLE = [
  { name: 'workflow_step_result' },   // structural output channel — MUST survive
  { name: 'notify_user' },            // structural report channel — MUST survive
  { name: 'recall_tool_result' },     // structural recall channel — MUST survive
  { name: 'tool_output_query' },      // structural recall channel — MUST survive
  { name: 'run_shell_command' },      // the cli family
  { name: 'composio_execute_tool' },  // drift gateway — pruned when locked
  { name: 'composio_status' },
  { name: 'read_file' },              // a non-family WORK tool — pruned when locked
];

test('A4: a cli-bound step is pruned to its family + structural channels (composio + work tools removed)', () => {
  const kept = new Set(lockToolsForStep(LOCK_SAMPLE, ['run_shell_command']).map((t) => t.name));
  assert.ok(kept.has('run_shell_command'), 'family kept');
  assert.ok(kept.has('workflow_step_result'), 'output channel always survives');
  assert.ok(kept.has('notify_user'), 'report channel survives — a triage step can still report');
  assert.ok(kept.has('recall_tool_result'), 'recall channel survives — can read back a clipped output');
  assert.ok(!kept.has('composio_execute_tool'), 'composio gateway pruned — cannot drift');
  assert.ok(!kept.has('composio_status'), 'composio status pruned');
  assert.ok(!kept.has('read_file'), 'non-family work tool pruned');
});

test('A4: a wildcard / empty / undefined allowedTools does NOT prune (full surface, no regression)', () => {
  for (const allowed of [undefined, [], ['*'], ['run_shell_command', '*']]) {
    assert.equal(stepAllowedToolsLock(allowed as string[] | undefined), false);
    assert.equal(lockToolsForStep(LOCK_SAMPLE, allowed as string[] | undefined).length, LOCK_SAMPLE.length);
  }
});

test('A4: the structural baseline (workflow_step_result) can never be pruned away', () => {
  // Even a lock that names a tool absent from the surface keeps the output channel.
  const kept = new Set(lockToolsForStep(LOCK_SAMPLE, ['some_mcp__tool']).map((t) => t.name));
  assert.ok(kept.has('workflow_step_result'));
  for (const t of STEP_STRUCTURAL_BASELINE_TOOLS) assert.ok(kept.has(t));
});

test('A4: a prefix family (composio_*) keeps the gateway for a composio-locked step', () => {
  const kept = new Set(lockToolsForStep(LOCK_SAMPLE, ['composio_*']).map((t) => t.name));
  assert.ok(kept.has('composio_execute_tool'));
  assert.ok(kept.has('composio_status'));
  assert.ok(kept.has('workflow_step_result'));
  assert.ok(!kept.has('run_shell_command'));
});

test('buildWorkflowStepAgent: per-step model override is honored (intent routing seam)', async () => {
  const dflt = await buildWorkflowStepAgent({});
  const routed = await buildWorkflowStepAgent({ model: 'claude-opus-4-8' });
  assert.equal(routed.model, 'claude-opus-4-8', 'an intent-routed step runs on the resolved model');
  assert.notEqual(dflt.model, 'claude-opus-4-8', 'unrouted step stays on the brain/primary');
});
