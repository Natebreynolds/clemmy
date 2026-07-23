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
import { externalMcpScopeFromResolvedTools } from './external-mcp-scope-lock.js';

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

test('buildWorkerAgent honors an explicit routed model override', async () => {
  const worker = await buildWorkerAgent({ model: 'claude-opus-4-8' });
  assert.equal(worker.model, 'claude-opus-4-8');
});

test('buildWorkerAgent attaches no external MCP servers without an explicit parent scope or packet need', async () => {
  const worker = await buildWorkerAgent();
  assert.equal(worker.mcpServers.length, 0);
});

test('buildWorkerAgent preserves an explicit parent MCP scope', async () => {
  const worker = await buildWorkerAgent({
    mcpToolScope: { reason: 'parent scoped data work', allowedServerSlugs: ['dataforseo'], maxTools: 8 },
  });
  assert.equal(worker.mcpServers.length, 1);
});

test('worker resolvedTools derive external MCP only from exact native MCP slugs/server names', () => {
  assert.equal(externalMcpScopeFromResolvedTools('none needed', ['dataforseo']), null);
  assert.equal(externalMcpScopeFromResolvedTools('skill_read and read_file only', ['dataforseo']), null);
  assert.equal(
    externalMcpScopeFromResolvedTools('DATAFORSEO_GET_GOOGLE_HIST_BULK_TRAFFIC_EST_LIVE', ['dataforseo']),
    null,
    'Composio slugs should stay on composio_execute_tool, not attach native MCP',
  );

  const dataforseo = externalMcpScopeFromResolvedTools('`dataforseo__serp_organic_live_advanced`', ['dataforseo', 'firecrawl']);
  assert.deepEqual(dataforseo?.allowedServerSlugs, ['dataforseo']);
  assert.ok(dataforseo?.toolPatterns?.some((pattern) => pattern.includes('serp') && pattern.includes('organic')));

  const firecrawl = externalMcpScopeFromResolvedTools('mcp__firecrawl__scrape', ['dataforseo', 'firecrawl']);
  assert.deepEqual(firecrawl?.allowedServerSlugs, ['firecrawl']);
});

test('Worker is a LEAF (has no handoffs of its own)', async () => {
  const worker = await buildWorkerAgent();
  const handoffs = (worker as unknown as { handoffs?: unknown[] }).handoffs;
  assert.ok(!handoffs || (Array.isArray(handoffs) && handoffs.length === 0), 'Worker should be a leaf');
});

test('Worker instructions honor parent-planned packets and one retry', async () => {
  const worker = await buildWorkerAgent();
  // instructions is now a FUNCTION (it appends the origin session's pinned
  // Active Task when present). Invoke it with no session context → base
  // instructions, which must still carry the packet/retry rules verbatim.
  const instr = (worker as unknown as { instructions?: unknown }).instructions;
  const instructions = typeof instr === 'function'
    ? String(await (instr as (ctx: unknown, agent: unknown) => unknown)({ context: {} }, worker))
    : String(instr ?? '');

  assert.match(instructions, /\[WORKER JOB PACKET\]/);
  assert.match(instructions, /resolvedTools\/context\/instructions as authoritative/);
  assert.match(instructions, /do NOT rediscover those same capabilities/);
  assert.match(instructions, /retry that call ONCE/);
  assert.match(instructions, /Return a single line starting with "ERROR:"/);
});

test('Worker capability is the full native surface minus only recursion/meta vectors — schemas may tier, reach may not', async () => {
  // 2026-06-01 ungating (allowlist → blocklist) + 2026-07-23 schema-on-demand:
  // the worker's REACHABLE capability stays the full native surface minus
  // recursion/meta/collision vectors. Slim mode tiers SCHEMA EXPOSURE only —
  // deferred tools remain callable through call_tool + the catalog. Assert on
  // the union of first-class names and the catalog-taught reachable set.
  const worker = await buildWorkerAgent();
  const firstClass = new Set(
    ((worker as unknown as { tools?: Array<{ name?: string }> }).tools ?? []).map((t) => t.name),
  );
  const instructions = (worker as unknown as { instructions?: unknown }).instructions;
  const rendered = typeof instructions === 'function'
    ? String((instructions as (rc: unknown) => string)({ context: {} }))
    : String(instructions ?? '');
  const reachable = (name: string): boolean => firstClass.has(name) || rendered.includes(name);

  // Recovery + core work tools stay FIRST-CLASS (the high-frequency set).
  for (const must of ['recall_tool_result', 'tool_output_query', 'composio_execute_tool', 'read_file', 'run_shell_command']) {
    assert.ok(firstClass.has(must), `worker must have ${must} first-class`);
  }

  // Previously-gated native tools remain REACHABLE (first-class or catalog).
  for (const nowReachable of ['workspace_artifact_query', 'execution_list', 'task_list']) {
    assert.ok(reachable(nowReachable), `worker should reach ${nowReachable}`);
  }

  // Recursion / meta / collision vectors stay out of BOTH tiers.
  for (const blocked of ['run_worker', 'workflow_run', 'workflow_create', 'add_cron_job', 'create_tool', 'ask_user_question', 'notify_user']) {
    assert.ok(!firstClass.has(blocked), `worker must NOT have ${blocked} first-class`);
    assert.ok(!rendered.split('call_tool')[1]?.includes(`\n${blocked} `), `worker catalog must NOT offer ${blocked}`);
  }
});

// Worker schema-on-demand (2026-07-23): every worker used to carry the full
// ~140-tool schema surface — the dominant token multiplier on fan-outs
// (~15k schema tokens × 122 workers on the live 120-account run). Slim mode
// keeps the high-frequency core first-class and routes everything else via
// call_tool (identical gate battery) + a name catalog — capability parity by
// construction. Kill-switch pins both directions.
test('worker slim tools: small first-class surface + call_tool escape hatch; kill-switch restores full', async () => {
  const slim = await buildWorkerAgent();
  const slimTools = (slim as { tools?: Array<{ name?: string }> }).tools ?? [];
  const slimNames = new Set(slimTools.map((t) => t.name));
  assert.ok(slimTools.length <= 16, `slim surface stays small, got ${slimTools.length}`);
  assert.ok(slimNames.has('call_tool'), 'the universal dispatcher rides first-class');
  for (const core of ['composio_execute_tool', 'run_shell_command', 'write_file', 'recall_tool_result', 'tool_output_query']) {
    assert.ok(slimNames.has(core), `${core} stays first-class`);
  }
  const instructions = (slim as { instructions?: unknown }).instructions;
  const rendered = typeof instructions === 'function'
    ? String((instructions as (rc: unknown) => string)({ context: {} }))
    : String(instructions ?? '');
  assert.match(rendered, /call_tool\(name, args_json\)/, 'catalog block teaches the escape hatch');

  process.env.CLEMMY_WORKER_SLIM_TOOLS = 'off';
  try {
    const full = await buildWorkerAgent();
    const fullTools = (full as { tools?: Array<{ name?: string }> }).tools ?? [];
    assert.ok(fullTools.length > 60, `kill-switch restores the full surface, got ${fullTools.length}`);
  } finally {
    delete process.env.CLEMMY_WORKER_SLIM_TOOLS;
  }
});
