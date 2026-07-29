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
import {
  WORKFLOW_STEP_BLOCKED_TOOL_NAMES,
  filterToolsForStep,
  buildWorkflowStepAgent,
  workflowStepExternalMcpScopeForLock,
  workflowStepToolUseBehavior,
} from './workflow-step-agent.js';
import { clearStepResult, recordStepResult } from '../tools/step-result-tool.js';

// A representative slice of the orchestrator's tool pool, including the
// work tools whose removal broke outlook-triage-hourly.
const SAMPLE_TOOLS = [
  { name: 'workflow_step_result' },
  { name: 'composio_status' },        // triage preflight — MUST survive
  { name: 'composio_execute_tool' },  // gateway to OUTLOOK_* etc. — MUST survive
  { name: 'notify_user' },            // triage's output channel — MUST survive
  { name: 'request_approval' },       // legacy in-prompt gate — MUST survive
  { name: 'read_file' },
  { name: 'workspace_artifact_query' },
  { name: 'run_shell_command' },      // sf CLI path — MUST survive
  { name: 'memory_recall' },
  { name: 'workflow_get' },           // harmless read — MUST survive
  // recursion / meta vectors — must be removed
  { name: 'workflow_run' },
  { name: 'workflow_create' },
  { name: 'agent_propose' },
  { name: 'create_agent' },
  { name: 'update_agent' },
  { name: 'delete_agent' },
  { name: 'delegate_task' },
  { name: 'run_worker' },
  { name: 'surface_plan' },
  { name: 'ask_user_question' },
  { name: 'create_tool' },
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
    'workspace_artifact_query',
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
    'agent_propose',
    'create_agent',
    'update_agent',
    'delete_agent',
    'delegate_task',
    'run_worker',
    'surface_plan',
    'ask_user_question',
    'create_tool',
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
  { name: 'read_file' },              // structural workflow-context hydration — MUST survive
  { name: 'workspace_artifact_query' }, // structural workflow-context query — MUST survive
];

test('A4: a cli-bound step is pruned to its family + structural channels (composio + work tools removed)', () => {
  const kept = new Set(lockToolsForStep(LOCK_SAMPLE, ['run_shell_command']).map((t) => t.name));
  assert.ok(kept.has('run_shell_command'), 'family kept');
  assert.ok(kept.has('workflow_step_result'), 'output channel always survives');
  assert.ok(kept.has('notify_user'), 'report channel survives — a triage step can still report');
  assert.ok(kept.has('read_file'), 'workspace context hydration survives — large upstream artifacts can be read');
  assert.ok(kept.has('workspace_artifact_query'), 'workspace context query survives — large upstream artifacts can be sliced');
  assert.ok(kept.has('recall_tool_result'), 'recall channel survives — can read back a clipped output');
  assert.ok(!kept.has('composio_execute_tool'), 'composio gateway pruned — cannot drift');
  assert.ok(!kept.has('composio_status'), 'composio status pruned');
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

test('A4: locked structural/local steps attach no external MCP surface', () => {
  const fallback = { reason: 'legacy broad scope', allowAll: true };
  assert.equal(workflowStepExternalMcpScopeForLock(['workflow_step_result'], fallback, ['dataforseo']), null);
  assert.equal(workflowStepExternalMcpScopeForLock(['run_shell_command'], fallback, ['dataforseo']), null);
  assert.equal(workflowStepExternalMcpScopeForLock(['notify_user'], fallback, ['DataForSEO MCP Server']), null);
});

test('A4: unlocked steps preserve the caller MCP scope exactly', () => {
  const fallback = { reason: 'caller scope', allowedServerSlugs: ['dataforseo'], maxTools: 8 };
  assert.equal(workflowStepExternalMcpScopeForLock(undefined, fallback, ['firecrawl']), fallback);
  assert.equal(workflowStepExternalMcpScopeForLock([], fallback, ['firecrawl']), fallback);
  assert.equal(workflowStepExternalMcpScopeForLock(['*'], fallback, ['firecrawl']), fallback);
});

test('A4: MCP-looking locks narrow external MCP to the matching server family', () => {
  const dataforseo = workflowStepExternalMcpScopeForLock(
    ['dataforseo__labs_google_ranked_keywords'],
    undefined,
    ['DataForSEO MCP Server', 'firecrawl'],
  );
  assert.deepEqual(dataforseo?.allowedServerSlugs, ['dataforseo_mcp_server']);
  assert.ok(dataforseo?.toolPatterns?.some((pattern) => pattern.includes('ranked') && pattern.includes('keywords')));

  const firecrawl = workflowStepExternalMcpScopeForLock(
    ['mcp__firecrawl__scrape'],
    undefined,
    ['DataForSEO MCP Server', 'firecrawl'],
  );
  assert.deepEqual(firecrawl?.allowedServerSlugs, ['firecrawl']);
  assert.ok(firecrawl?.toolPatterns?.some((pattern) => pattern.includes('scrape')));
});

test('buildWorkflowStepAgent: per-step model override is honored (intent routing seam)', async () => {
  const dflt = await buildWorkflowStepAgent({});
  const routed = await buildWorkflowStepAgent({ model: 'claude-opus-4-8' });
  assert.equal(routed.model, 'claude-opus-4-8', 'an intent-routed step runs on the resolved model');
  assert.notEqual(dflt.model, 'claude-opus-4-8', 'unrouted step stays on the brain/primary');
});

test('buildWorkflowStepAgent: structural-only lock does not attach external MCP servers', async () => {
  const agent = await buildWorkflowStepAgent({ lockTools: ['workflow_step_result'] });
  assert.equal(agent.mcpServers.length, 0);
});

test('graph-added result-only authority is physical and identical on Claude and GLM routes', async () => {
  for (const model of ['claude-opus-4-8', 'glm-5.2']) {
    const agent = await buildWorkflowStepAgent({
      model,
      lockTools: ['*'],
      resultOnlyTools: true,
      userInput: 'Try to use any available work tool, then return a result.',
    });
    assert.deepEqual(
      agent.tools.map((toolRef) => toolRef.name),
      ['workflow_step_result'],
      `${model} must not inherit local tools, tool_search, call_tool, or wildcard authority`,
    );
    assert.equal(agent.mcpServers.length, 0, `${model} must not attach external MCP servers`);
  }
});

test('workflow_step_result stops the SDK inner loop only after the result was accepted', async () => {
  const sessionId = 'workflow-step-stop-test';
  clearStepResult(sessionId);
  const behavior = workflowStepToolUseBehavior(sessionId);
  assert.equal(typeof behavior, 'function');
  const toolResults = [{
    type: 'function_output',
    tool: { name: 'workflow_step_result' },
    output: 'Step result captured (42 chars).',
  }] as never;

  const rejected = await behavior({} as never, toolResults);
  assert.equal(rejected.isFinalOutput, false, 'a contract-refused submission must return to the model for repair');

  recordStepResult(sessionId, { blocked: true, reason: 'upstream unavailable' });
  const accepted = await behavior({} as never, toolResults);
  assert.equal(accepted.isFinalOutput, true, 'an accepted structural result terminates inside the same SDK turn');
  if (accepted.isFinalOutput) assert.match(accepted.finalOutput, /Step result captured/);
  clearStepResult(sessionId);
});

test('buildWorkflowStepAgent: unbound steps defer schemas but keep every tool callable on demand', async () => {
  const prior = process.env.CLEMMY_CODEX_TOOL_SEARCH;
  process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
  try {
    const agent = await buildWorkflowStepAgent({
      sessionId: 'workflow-schema-on-demand-test',
      userInput: 'Synthesize the supplied upstream evidence into three drafts.',
    });
    const names = new Set(agent.tools.map((toolRef) => toolRef.name));
    assert.ok(names.has('workflow_step_result'));
    assert.ok(names.has('tool_search'));
    assert.ok(names.has('call_tool'));
    assert.equal(names.has('task_add'), false, 'an unrelated schema is deferred, not paid on this step');
    assert.equal(agent.mcpServers.length, 0, 'broad external MCP schemas are reached on demand too');

    process.env.CLEMMY_CODEX_TOOL_SEARCH = 'off';
    const legacy = await buildWorkflowStepAgent({
      sessionId: 'workflow-full-surface-test',
      userInput: 'Synthesize the supplied upstream evidence into three drafts.',
    });
    const legacyNames = new Set(legacy.tools.map((toolRef) => toolRef.name));
    assert.ok(legacyNames.has('task_add'), 'the kill-switch restores the prior full surface');
    assert.equal(legacyNames.has('call_tool'), false, 'the dispatcher is only needed on the deferred surface');
  } finally {
    if (prior === undefined) delete process.env.CLEMMY_CODEX_TOOL_SEARCH;
    else process.env.CLEMMY_CODEX_TOOL_SEARCH = prior;
  }
});

test('buildWorkflowStepAgent: final output stays plain text even if the old revert flag is set', async () => {
  process.env.CLEMMY_WORKFLOW_STEP_PLAINTEXT_DECISION = 'off';
  try {
    const agent = await buildWorkflowStepAgent({});
    const outputType = agent.outputType as unknown;
    assert.ok(
      outputType == null || outputType === 'text' || typeof (outputType as { safeParse?: unknown }).safeParse !== 'function',
      'workflow steps should not require a second strict decision JSON envelope',
    );
  } finally {
    delete process.env.CLEMMY_WORKFLOW_STEP_PLAINTEXT_DECISION;
  }
});
