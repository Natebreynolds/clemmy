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
