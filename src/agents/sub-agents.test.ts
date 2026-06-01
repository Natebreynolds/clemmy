/**
 * Run: npx tsx --test src/agents/sub-agents.test.ts
 *
 * Phase 3 (v0.5.16) — the 5 specialized sub-agents (Researcher /
 * Writer / Reviewer / Executor / Deployer) were removed after going
 * dormant under the single-agent prompt. These tests cover what
 * survives: Worker (parallel-fan-out leaf), defaultOrchestratorHandoffs
 * (now empty), isOrchestratorSlug (slug discriminator for autonomy-v2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkerAgent,
  defaultOrchestratorHandoffs,
  isOrchestratorSlug,
} from './sub-agents.js';

test('isOrchestratorSlug: clementine is the default orchestrator', () => {
  assert.equal(isOrchestratorSlug('clementine'), true);
});

test('isOrchestratorSlug: other slugs are not orchestrators by default', () => {
  assert.equal(isOrchestratorSlug('researcher'), false);
  assert.equal(isOrchestratorSlug('writer'), false);
  assert.equal(isOrchestratorSlug(''), false);
});

test('isOrchestratorSlug: env var opts other slugs in', () => {
  const original = process.env.AUTONOMY_ORCHESTRATOR_SLUGS;
  process.env.AUTONOMY_ORCHESTRATOR_SLUGS = 'project-lead, ops-pilot ';
  try {
    assert.equal(isOrchestratorSlug('project-lead'), true);
    assert.equal(isOrchestratorSlug('ops-pilot'), true);
    assert.equal(isOrchestratorSlug('random-agent'), false);
  } finally {
    if (original === undefined) delete process.env.AUTONOMY_ORCHESTRATOR_SLUGS;
    else process.env.AUTONOMY_ORCHESTRATOR_SLUGS = original;
  }
});

test('defaultOrchestratorHandoffs returns empty (single-agent mode)', async () => {
  const handoffs = await defaultOrchestratorHandoffs();
  assert.equal(handoffs.length, 0);
});

test('defaultOrchestratorHandoffs accepts the legacy options arg without throwing', async () => {
  // openai runtime still passes { requireWorkflowApprovalForExecution: true }
  // — the option is now a no-op but the signature must stay backward-compat.
  const handoffs = await defaultOrchestratorHandoffs({ requireWorkflowApprovalForExecution: true });
  assert.equal(handoffs.length, 0);
});

test('buildWorkerAgent returns a configured stateless leaf', async () => {
  const worker = await buildWorkerAgent();
  assert.equal(worker.name, 'Worker');
  assert.ok(worker.handoffDescription);
  assert.match(worker.handoffDescription, /worker|fan-out|parallel/i);
});

test('Worker is a LEAF (has no handoffs of its own)', async () => {
  const worker = await buildWorkerAgent();
  const handoffs = (worker as unknown as { handoffs?: unknown[] }).handoffs;
  assert.ok(!handoffs || (Array.isArray(handoffs) && handoffs.length === 0), 'Worker should be a leaf');
});

test('Worker instructions honor parent-planned packets and one retry', async () => {
  const worker = await buildWorkerAgent();
  const instructions = (worker as unknown as { instructions?: string }).instructions ?? '';

  assert.match(instructions, /\[WORKER JOB PACKET\]/);
  assert.match(instructions, /resolvedTools\/context\/instructions as authoritative/);
  assert.match(instructions, /do NOT rediscover those same capabilities/);
  assert.match(instructions, /retry that call ONCE/);
  assert.match(instructions, /Return a single line starting with "ERROR:"/);
});

test('Worker gets the full native surface minus only recursion/meta vectors (blocklist, not allowlist)', async () => {
  // Regression guard for the 2026-06-01 ungating: the worker surface used to
  // be a hard 20-name allowlist, so a worker dispatched to use a native tool
  // it wasn't pre-listed for couldn't see it ("the reader isn't exposed").
  // It's now a BLOCKLIST: full native surface minus recursion/meta/collision
  // vectors. Assert (a) the recovery + work tools are present, (b) a tool that
  // was NOT on the old allowlist is now reachable, (c) the blocked vectors stay
  // out.
  const worker = await buildWorkerAgent();
  const toolNames = new Set(
    ((worker as unknown as { tools?: Array<{ name?: string }> }).tools ?? []).map((t) => t.name),
  );

  // Recovery + core work tools the worker must have.
  for (const must of ['recall_tool_result', 'tool_output_query', 'composio_execute_tool', 'read_file', 'run_shell_command']) {
    assert.ok(toolNames.has(must), `worker must have ${must}`);
  }

  // Previously-gated native tools that are now reachable (proves un-gating).
  for (const nowReachable of ['execution_list', 'task_list']) {
    assert.ok(toolNames.has(nowReachable), `worker should now reach ${nowReachable}`);
  }

  // Recursion / meta / collision vectors that MUST stay blocked.
  for (const blocked of ['run_worker', 'workflow_run', 'workflow_create', 'add_cron_job', 'create_tool', 'ask_user_question', 'notify_user']) {
    assert.ok(!toolNames.has(blocked), `worker must NOT have ${blocked}`);
  }
});
