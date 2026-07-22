/**
 * Run: npx tsx --test src/agents/orchestrator.test.ts
 *
 * Static contracts the Orchestrator must keep — no Runner invocation
 * (that needs OpenAI credentials). We verify the structural promises:
 *   - Clem constructs with the right name and output schema
 *   - It exposes ONLY deliberation/discovery tools (zero action tools)
 *   - Handoffs include the five sub-agents
 *   - inputGuardrails + outputGuardrails are wired to the harness
 *     registry (policy_violation, secret_leak)
 *   - request_approval has needsApproval=true → the SDK pauses
 *   - request_approval emits approval_requested
 *   - ask_user_question emits awaiting_user_input
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-orchestrator-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

const { resetEventLog, createSession, listEvents, appendEvent } = await import('../runtime/harness/eventlog.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const pendingActions = await import('../runtime/harness/pending-actions.js');
const { formatAutoResolvedAskUserQuestionOutput } = await import('../runtime/harness/terminal-tool.js');
const { getPlanScope } = await import('./plan-scope.js');
const { saveProactivityPolicy } = await import('./proactivity-policy.js');
const {
  buildOrchestratorAgent,
  OrchestratorDecisionSchema,
  buildRequestApprovalTool,
  buildAskUserQuestionTool,
  recentPriorUserInputsForScope,
  ORCHESTRATOR_INSTRUCTIONS,
  orchestratorInternalsForTest,
  userChoiceToolUseBehavior,
} = await import('./orchestrator.js');
const { resolveMcpToolScopeWithContinuity } = await import('../runtime/mcp-tool-scope.js');
const { TOOL_JIT_CORE } = await import('./tool-jit.js');
const { RunContext, Usage } = await import('@openai/agents');
const { setClaudeAgentSdkWorkerRunForTest } = await import('../runtime/harness/claude-agent-worker.js');

async function renderAgentInstructions(agent: { instructions?: unknown }): Promise<string> {
  const instr = agent.instructions;
  if (typeof instr === 'function') {
    return String(await (instr as (ctx: unknown, agent: unknown) => unknown)({ context: {} }, agent));
  }
  return String(instr ?? '');
}

test.after(() => {
  setClaudeAgentSdkWorkerRunForTest(null);
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('OrchestratorDecisionSchema accepts a minimal valid decision', () => {
  const parsed = OrchestratorDecisionSchema.parse({
    summary: 'handed off to executor to write the README',
    done: false,
    nextAction: 'awaiting_handoff_result',
    reason: null,
  });
  assert.equal(parsed.done, false);
  assert.equal(parsed.nextAction, 'awaiting_handoff_result');
});

test('OrchestratorDecisionSchema rejects short summaries', () => {
  assert.throws(() =>
    OrchestratorDecisionSchema.parse({
      summary: 'x',
      done: true,
      nextAction: 'completed',
      reason: null,
    }),
  );
});

test('OrchestratorDecisionSchema rejects unknown nextAction values', () => {
  assert.throws(() =>
    OrchestratorDecisionSchema.parse({
      summary: 'doing fine',
      done: false,
      nextAction: 'jazz_hands',
      reason: null,
    }),
  );
});

test('Orchestrator builds Clem with the plain-text decision contract even if the old revert flag is set', async () => {
  process.env.CLEMMY_PLAINTEXT_DECISION = 'off';
  try {
    const agent = await buildOrchestratorAgent();
    assert.equal(agent.name, 'Clem');
    // The old emergency revert is intentionally ignored. The model ends its
    // turn with plain text + an optional marker, so a turn can never fail only
    // because the final JSON envelope drifted.
    const outputType = agent.outputType as unknown;
    assert.ok(
      outputType == null || outputType === 'text' || typeof (outputType as { safeParse?: unknown }).safeParse !== 'function',
      'expected no structured decision schema under the plain-text contract',
    );
  } finally {
    delete process.env.CLEMMY_PLAINTEXT_DECISION;
  }
});

test('Orchestrator instructions stay dynamic and include same-session completed actions', async () => {
  const session = createSession({ kind: 'chat', channel: 'test' });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'CRM_UPDATE', targets: ['record:acct-42'] },
  });

  const agent = await buildOrchestratorAgent({ sessionId: session.id });
  assert.equal(typeof agent.instructions, 'function', 'instructions must remain a live renderer, not a stringified function');

  const instructions = await renderAgentInstructions(agent);
  assert.match(instructions, /# Persistent Context/);
  assert.match(instructions, /## Completed Actions This Conversation/);
  assert.match(instructions, /ALREADY DONE in THIS conversation/);
  assert.match(instructions, /CRM_UPDATE/);
  assert.match(instructions, /record:acct-42/);
  assert.doesNotMatch(instructions, /function harnessInstructions|=> `?\$?\{?baseInstructions/);
});

test('Orchestrator is built with explicit modelSettings so the SDK honors per-turn reasoning effort', async () => {
  // The dynamic-reasoning feature mutates agent.modelSettings.reasoning.effort
  // each turn, but the SDK only honors agent.modelSettings when it was set at
  // CONSTRUCTION (it flips a private explicit flag then). If this contract
  // breaks — construction stops seeding modelSettings, or the SDK renames the
  // flag — the whole feature silently goes inert. This is the guard.
  const agent = await buildOrchestratorAgent();
  assert.equal(
    (agent as unknown as { hasExplicitModelSettings(): boolean }).hasExplicitModelSettings(),
    true,
    'SDK must report explicit modelSettings, else per-turn effort is ignored',
  );
  assert.ok(agent.modelSettings?.reasoning, 'reasoning settings seeded at construction');
  assert.equal((agent.modelSettings as { text?: { verbosity?: string } }).text?.verbosity, 'low');
});

test('Orchestrator carries the harness guardrails', async () => {
  const agent = await buildOrchestratorAgent();
  // SDK normalises into <kind>GuardrailDefinitions; we just confirm
  // each registry guardrail name shows up.
  const inputNames = (agent.inputGuardrails ?? []).map((g) =>
    (g as { name?: string }).name,
  );
  const outputNames = (agent.outputGuardrails ?? []).map((g) =>
    (g as { name?: string }).name,
  );
  assert.ok(inputNames.includes('policy_violation'));
  assert.ok(!inputNames.includes('missing_capability'));
  assert.ok(outputNames.includes('secret_leak'));
});

test('Orchestrator: model override rides through (workflow-step worker-model routing on the gated loop)', async () => {
  // Dormant capability: absent ⇒ MODELS.primary (byte-identical); present ⇒ the
  // agent runs on the requested model so a converted forEach step keeps its
  // cheaper worker model instead of being forced to primary.
  const dflt = await buildOrchestratorAgent();
  const overridden = await buildOrchestratorAgent({ model: 'gpt-5.4-mini' });
  assert.notEqual(dflt.model, 'gpt-5.4-mini', 'default is not the override');
  assert.equal(overridden.model, 'gpt-5.4-mini', 'override is honored');
});

test('Orchestrator: user-choice tools terminate only when they really pause', async () => {
  const agent = await buildOrchestratorAgent();
  assert.equal(agent.toolUseBehavior, userChoiceToolUseBehavior);
  const result = (name: string, output: string) => userChoiceToolUseBehavior({}, [
    { type: 'function_output', tool: { name }, output },
  ]);
  assert.equal(result('ask_user_question', 'Question posted: Which environment? Awaiting user reply.').isFinalOutput, true);
  // offer_background stripped 2026-07-22 — a stray tool with that name no longer halts.
  assert.equal(result('offer_background', 'Offer posted. STOP now.').isFinalOutput, false);
  assert.equal(
    result('ask_user_question', formatAutoResolvedAskUserQuestionOutput('Proceed now.')).isFinalOutput,
    false,
  );
  for (const phrase of ['standing approval', 'NOT pausing', 'not waiting']) {
    assert.equal(
      result('ask_user_question', `Question posted: What does "${phrase}" mean here? Awaiting user reply.`).isFinalOutput,
      true,
      `clarification containing ${phrase} must remain terminal`,
    );
  }
});

test('Orchestrator: excludeToolNames narrows the harness surface (unblocks architect/autonomy on the one loop)', async () => {
  // The capability that lets narrowed-surface callers (workflow architect hides
  // workflow_* mutators; autonomy excludes external writes) ride the GATED
  // harness loop instead of the legacy ungated core. Additive: absent ⇒ full.
  const full = await buildOrchestratorAgent();
  const fullNames = new Set((full.tools ?? []).map((t) => (t as { name?: string }).name));
  assert.ok(fullNames.has('composio_execute_tool') && fullNames.has('workflow_run'), 'baseline has the tools');

  const exclude = ['composio_execute_tool', 'workflow_create', 'workflow_update', 'workflow_set_enabled', 'workflow_delete', 'workflow_run'];
  const narrowed = await buildOrchestratorAgent({ excludeToolNames: exclude });
  const narrowedNames = (narrowed.tools ?? []).map((t) => (t as { name?: string }).name);
  for (const ex of exclude) assert.ok(!narrowedNames.includes(ex), `${ex} excluded`);
  // Non-excluded tools survive (e.g. memory + planner still present).
  assert.ok(narrowedNames.includes('memory_recall'), 'unrelated tools untouched');
  // And the full surface is genuinely unchanged when nothing is excluded.
  assert.equal((await buildOrchestratorAgent({ excludeToolNames: [] })).tools?.length, full.tools?.length);
});

test('Orchestrator is now the single agent — carries the union of all action tools (Phase 3)', async () => {
  // Phase 3 architecture (2026-05-20): no more sub-agent split. The
  // Orchestrator IS the agent — it has discovery + memory + workspace
  // + shell + composio + executions + tasks + plans + notes + git +
  // profile all on one surface. Approval gating stays at the per-tool
  // level via decideToolApproval() in tool-taxonomy.ts.
  //
  // Why: sub-agent .asTool() wrappers broke around approval pause/
  // resume (the child sub-agent completed with empty output). Multi-
  // step work degenerated into approve-fabricate-loop. The single-
  // agent shape removes that failure class entirely.
  const agent = await buildOrchestratorAgent();
  const toolNames = (agent.tools ?? []).map((t) => (t as { name?: string }).name).filter(Boolean).sort();
  // Don't pin the exact set — the surface will grow as the registry
  // adds tools. Pin the CORE capabilities the single-agent shape
  // requires for the north-star workflow ("get request → search
  // memory → call tools → done").
  const required = [
    // Memory (read + write + standing-instruction lifecycle). pin/forget/
    // restore must ALL be present: memory_forget refuses a pinned fact and
    // routes recovery through memory_pin pinned=false → memory_forget →
    // memory_restore; a missing link dead-ends that path and pushes the model
    // to raw SQL (2026-06-12 regression guard).
    'memory_recall', 'memory_search', 'memory_read', 'memory_remember', 'memory_list_facts',
    'memory_forget', 'memory_pin', 'memory_restore', 'memory_self_heal',
    // Composio (discover + execute)
    'composio_search_tools', 'composio_execute_tool', 'composio_status',
    // Shell + filesystem
    'run_shell_command', 'write_file', 'read_file', 'list_files',
    // Workspace
    'workspace_info', 'workspace_list', 'workspace_roots',
    // Workspaces (Spaces) authoring — must be on the orchestrator surface so the
    // workspace dock / re-engage turn can actually edit + refresh a space
    // (regression guard: these were registered but omitted from discoveryTools,
    // so the dock self-reported "space_save is not exposed in this run").
    'space_save', 'space_refresh', 'space_get', 'space_edit_view', 'space_list',
    // Team-agent coordination — same allowlist-omission class as Spaces/workflows.
    // These are registered local tools; the chat orchestrator must expose them so
    // "create two agents and delegate" does not fall back to raw files/shell.
    'team_list', 'team_request', 'create_agent', 'update_agent', 'delegate_task', 'check_delegation',
    // Pending-action queue — prepare exact approval-bound payloads before asking
    // once and executing after approval.
    'pending_action_queue', 'pending_action_list', 'pending_action_get', 'pending_action_record_result',
    // Tasks + goals + executions
    'task_list', 'task_add', 'task_update',
    'goal_upsert', 'goal_list',
    'execution_list', 'execution_get', 'execution_update_step', 'execution_complete', 'execution_mark_blocked',
    // CLI discovery + probes
    'local_cli_list', 'local_cli_probe',
    // Tool-choice memoization
    'tool_choice_recall', 'tool_choice_remember', 'tool_choice_invalidate',
    // User profile (read)
    'user_profile_read',
    // Conversation tools
    'ask_user_question', 'request_approval', 'notify_user',
    // Planning
    'draft_plan', 'share_plan',
  ];
  for (const name of required) {
    assert.ok(toolNames.includes(name), `expected single-agent surface to include ${name}, got: ${toolNames.join(',')}`);
  }
  // Sub-agent run_* tools removed in Phase 3 — EXCEPT run_worker,
  // which is the stateless parallel-fan-out primitive (kept because
  // it doesn't have the approval-pause/.asTool() composition issue
  // the other sub-agents had).
  assert.ok(toolNames.includes('run_worker'), 'run_worker should remain available for parallel fan-out');
  for (const name of ['run_researcher', 'run_writer', 'run_reviewer', 'run_executor', 'run_deployer']) {
    assert.equal(toolNames.includes(name), false, `${name} should be removed in Phase 3`);
  }
});

test('every tool the instructions tell the model to call is ON the surface (allowlist-omission guard)', async () => {
  // THIRD-occurrence bug class (spaces 2026-05-?, workflows 2026-05-21,
  // recall/focus 2026-06-11): the instructions name a tool, the allowlist
  // omits it, the model truthfully reports "isn't exposed in this run" and
  // stalls. Live: every clipped tool result says `call recall_tool_result(…)`
  // but ALL 286 historical calls came from workflow steps — chat could never
  // make one. This test extracts every backticked snake_case name from the
  // instructions and asserts it resolves on the BUILT agent's tool surface.
  // Adding a new instructed tool without allowlisting it fails HERE, not in
  // a live session.
  const agent = await buildOrchestratorAgent();
  const surface = new Set((agent.tools ?? []).map((t) => (t as { name?: string }).name));
  // Backticked names that are NOT tools: decision-enum values + event types
  // the instructions legitimately reference. Keep this list as small as the
  // instructions allow — every entry is a name the model might try to call.
  const NON_TOOL_MENTIONS = new Set(['awaiting_approval', 'awaiting_user_input', 'tool_called']);
  const mentioned = new Set<string>();
  for (const m of String(ORCHESTRATOR_INSTRUCTIONS).matchAll(/`([a-z][a-z0-9_]+)(?:\([^`]*)?`/g)) {
    const n = m[1];
    // require a '_' (tool-shaped) and exclude server-namespaced MCP names
    // (dataforseo__…) which are scope-dependent, not allowlist entries.
    if (n.includes('_') && !n.includes('__')) mentioned.add(n);
  }
  assert.ok(mentioned.size >= 30, `extraction sanity: expected 30+ instructed tool mentions, got ${mentioned.size}`);
  const missing = [...mentioned].filter((n) => !surface.has(n) && !NON_TOOL_MENTIONS.has(n)).sort();
  assert.deepEqual(missing, [], `instructions promise tools the surface does not expose: ${missing.join(', ')}`);

  // The clip/digest RECOVERY tools are instructed at RUNTIME by the digest
  // footer (tool-output-digest.ts), NOT in ORCHESTRATOR_INSTRUCTIONS — so the
  // scan above can't catch them. A chat turn that clips a large tool result
  // (e.g. `sf data query` → 25 records) MUST be able to call them, or the
  // Runner hard-fails "Tool <x> not found in agent". (2026-06-18: tool_output_query
  // was on the worker/planner/workflow-step allowlists but never the chat one.)
  for (const recallTool of ['recall_tool_result', 'tool_output_query']) {
    assert.ok(surface.has(recallTool), `clip/digest recovery tool ${recallTool} must be on the chat surface (the digest footer tells the model to call it)`);
  }
});

test('JIT classification guard: every rubric-named built-in is consciously CORE or JIT-able-allowed', async () => {
  // Closes the audit gap (crosscheck-test-never-exercises-jit): the cross-check
  // above runs with JIT OFF, so it can't catch that CLEMMY_TOOL_JIT=on could DROP a
  // tool the rubric imperatively names. There is no mid-run acquisition for built-in
  // tools yet, so a dropped instructed tool revives the "instructed-but-absent" stall.
  // Guarantee instead: every rubric-named built-in is EITHER in TOOL_JIT_CORE (never
  // dropped) OR in JITABLE_ALLOWED — a curated set of CONDITIONAL, intent-evident tools
  // the user's own message names, which semantic retrieval brings back. A NEW rubric
  // tool fails here until it's classified, so the contract can't silently rot.
  const agent = await buildOrchestratorAgent();
  const surface = new Set((agent.tools ?? []).map((t) => (t as { name?: string }).name));
  const NON_TOOL_MENTIONS = new Set(['awaiting_approval', 'awaiting_user_input', 'tool_called']);
  // Conditional / intent-evident tools the rubric names that are SAFE to JIT-drop:
  // the user's message names the domain (workflow / space / task / goal / browser /
  // background / app status / cache forget), so semantic retrieval surfaces them.
  const JITABLE_ALLOWED = new Set<string>([
    'workflow_create', 'workflow_run', 'workflow_run_status', 'workflow_update', 'workflow_schedule',
    'memory_pin', 'memory_restore', 'memory_list_facts',
    'task_add', 'task_update', 'task_list',
    'background_tasks_recent', 'background_task_status', 'dispatch_background_task',
    // hold/resume are intent-evident ("hold it for later" / "pick up X") and held
    // tasks are named in the persistent context, so semantic retrieval surfaces them.
    'hold_task_for_later', 'resume_held_task',
    'workspace_list', 'workspace_info',
    'create_agent', 'update_agent', 'team_request', 'delegate_task',
  ]);
  const mentioned = new Set<string>();
  for (const m of String(ORCHESTRATOR_INSTRUCTIONS).matchAll(/`([a-z][a-z0-9_]+)(?:\([^`]*)?`/g)) {
    const n = m[1];
    if (n.includes('_') && !n.includes('__')) mentioned.add(n);
  }
  // Only classify names that are ACTUALLY built-in tools on the surface.
  const rubricBuiltins = [...mentioned].filter((n) => surface.has(n) && !NON_TOOL_MENTIONS.has(n));
  const unclassified = rubricBuiltins
    .filter((n) => !TOOL_JIT_CORE.has(n) && !JITABLE_ALLOWED.has(n))
    .sort();
  assert.deepEqual(
    unclassified,
    [],
    `rubric names these built-in tools but they are neither in TOOL_JIT_CORE nor JITABLE_ALLOWED — ` +
      `classify each (CORE if needed every-turn/for-correctness, JITABLE_ALLOWED if conditional+intent-evident): ${unclassified.join(', ')}`,
  );
});

test('run_worker requires a structured parent-planned job packet', async () => {
  const agent = await buildOrchestratorAgent();
  const runWorker = (agent.tools ?? []).find((t) => (t as { name?: string }).name === 'run_worker') as {
    description?: string;
    parameters?: {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  } | undefined;

  assert.ok(runWorker, 'expected run_worker on orchestrator surface');
  assert.match(runWorker.description ?? '', /structured parent-planned job packet/);
  assert.match(runWorker.description ?? '', /exact resolved tool slugs/);
  // 2026-07-21 deterministic fan-out: `items` (nullable) joined the packet and
  // `item` became nullable — strict mode keeps both in `required` with null types.
  assert.deepEqual(runWorker.parameters?.required, [
    'objective',
    'item',
    'resolvedTools',
    'context',
    'instructions',
    'expectedOutput',
    'intent',
    'items',
  ]);
  assert.equal(runWorker.parameters?.additionalProperties, false);
  assert.ok(runWorker.parameters?.properties?.resolvedTools);
  assert.ok(runWorker.parameters?.properties?.intent);
  assert.ok(runWorker.parameters?.properties?.items);
  assert.equal(Object.hasOwn(runWorker.parameters?.properties ?? {}, 'input'), false);
});

test('chat run_worker intent routing resolves the per-intent worker model', () => {
  const prev: Record<string, string | undefined> = {
    AUTH_MODE: process.env.AUTH_MODE,
    MODEL_ROUTING_MODE: process.env.MODEL_ROUTING_MODE,
    BYO_MODEL_BASE_URL: process.env.BYO_MODEL_BASE_URL,
    BYO_MODEL_API_KEY: process.env.BYO_MODEL_API_KEY,
    BYO_MODEL_ID: process.env.BYO_MODEL_ID,
    CLEMMY_MODEL_ROLES_REGISTRY: process.env.CLEMMY_MODEL_ROLES_REGISTRY,
    CLEMMY_MODEL_ROLES: process.env.CLEMMY_MODEL_ROLES,
    CLEMMY_WORKER_INTENT_ROUTING: process.env.CLEMMY_WORKER_INTENT_ROUTING,
  };
  try {
    process.env.AUTH_MODE = 'codex_oauth';
    delete process.env.MODEL_ROUTING_MODE;
    process.env.BYO_MODEL_BASE_URL = 'https://api.example.test';
    process.env.BYO_MODEL_API_KEY = 'k';
    process.env.BYO_MODEL_ID = 'minimax-01';
    process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
    process.env.CLEMMY_WORKER_INTENT_ROUTING = 'on';
    process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
      { role: 'worker', modelId: 'minimax-01', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
    ]);

    const route = orchestratorInternalsForTest.resolveChatWorkerModel({ item: 'landing page hero', intent: 'design' });
    assert.equal(route.model, 'minimax-01');
    assert.equal(route.trace?.seam, 'chat');
    assert.equal(route.trace?.matchedIntent, 'design');
    assert.equal(route.trace?.provider, 'byo');
    assert.equal(route.trace?.source, 'chat-rule');
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('chat run_worker intent routing kill-switch keeps legacy role-wide worker', () => {
  const prev = process.env.CLEMMY_WORKER_INTENT_ROUTING;
  try {
    process.env.CLEMMY_WORKER_INTENT_ROUTING = 'off';
    const route = orchestratorInternalsForTest.resolveChatWorkerModel({ item: 'landing page hero', intent: 'design' });
    assert.equal(route.model, undefined);
    assert.equal(route.trace, undefined);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_WORKER_INTENT_ROUTING;
    else process.env.CLEMMY_WORKER_INTENT_ROUTING = prev;
  }
});

test('run_worker invokes the nested Worker on the routed intent model (offline SDK path)', async () => {
  resetEventLog();
  const session = createSession({ kind: 'chat', title: 'run_worker intent route' });
  const prev: Record<string, string | undefined> = {
    AUTH_MODE: process.env.AUTH_MODE,
    MODEL_ROUTING_MODE: process.env.MODEL_ROUTING_MODE,
    BYO_MODEL_BASE_URL: process.env.BYO_MODEL_BASE_URL,
    BYO_MODEL_API_KEY: process.env.BYO_MODEL_API_KEY,
    BYO_MODEL_ID: process.env.BYO_MODEL_ID,
    CLEMMY_MODEL_ROLES_REGISTRY: process.env.CLEMMY_MODEL_ROLES_REGISTRY,
    CLEMMY_MODEL_ROLES: process.env.CLEMMY_MODEL_ROLES,
    CLEMMY_WORKER_INTENT_ROUTING: process.env.CLEMMY_WORKER_INTENT_ROUTING,
  };
  const requestedModels: Array<string | undefined> = [];
  try {
    process.env.AUTH_MODE = 'codex_oauth';
    delete process.env.MODEL_ROUTING_MODE;
    process.env.BYO_MODEL_BASE_URL = 'https://api.example.test';
    process.env.BYO_MODEL_API_KEY = 'k';
    process.env.BYO_MODEL_ID = 'minimax-01';
    process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
    process.env.CLEMMY_WORKER_INTENT_ROUTING = 'on';
    process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
      { role: 'worker', modelId: 'minimax-01', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
    ]);

    const stubModel: import('@openai/agents').Model = {
      async getResponse() {
        return {
          output: [{
            type: 'message',
            id: 'msg_worker_done',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'worker finished on routed model', providerData: {} }],
          }],
          usage: new Usage(),
          responseId: 'resp_worker_done',
        } as unknown as import('@openai/agents').ModelResponse;
      },
      async *getStreamedResponse() {
        throw new Error('not used in this test');
      },
    };
    const stubProvider: import('@openai/agents').ModelProvider = {
      getModel(modelName?: string) {
        requestedModels.push(modelName);
        return stubModel;
      },
    };

    const agent = await buildOrchestratorAgent();
    const runWorker = (agent.tools ?? []).find((t) => (t as { name?: string }).name === 'run_worker') as {
      invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
    } | undefined;
    assert.ok(runWorker, 'expected run_worker on orchestrator surface');

    const packet = {
      objective: 'Generate one design variation for the parent batch.',
      item: 'landing page hero',
      resolvedTools: 'none needed',
      context: 'Use the supplied brand brief.',
      instructions: 'Return one compact design direction.',
      expectedOutput: 'One sentence or ERROR: <reason>.',
      intent: 'design',
    };
    const input = JSON.stringify(packet);
    const result = await runWorker.invoke(
      new RunContext({ sessionId: session.id }),
      input,
      {
        parentRunConfig: { modelProvider: stubProvider },
        toolCall: { name: 'run_worker', callId: 'call_worker_design', arguments: input },
      },
    );

    assert.equal(result, 'worker finished on routed model');
    assert.ok(requestedModels.includes('minimax-01'), `expected nested Worker to request minimax-01, got ${requestedModels.join(', ')}`);
    const routed = listEvents(session.id, { types: ['worker_model_routed'] });
    assert.equal(routed.length, 1);
    assert.equal((routed[0].data as { modelId?: string }).modelId, 'minimax-01');
    assert.equal((routed[0].data as { seam?: string }).seam, 'chat');
    const results = listEvents(session.id, { types: ['worker_result'] });
    assert.equal(results.length, 1);
    assert.equal((results[0].data as { item?: string }).item, 'landing page hero');
    assert.equal((results[0].data as { ok?: boolean }).ok, true);
    assert.equal((results[0].data as { model?: string }).model, 'minimax-01');
    assert.equal((results[0].data as { toolCallId?: string }).toolCallId, 'call_worker_design');
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('run_worker routes Claude workers through the Claude Agent SDK worker path', async () => {
  resetEventLog();
  const session = createSession({ kind: 'chat', title: 'claude sdk worker route' });
  const prev: Record<string, string | undefined> = {
    AUTH_MODE: process.env.AUTH_MODE,
    CLEMMY_CLAUDE_AGENT_SDK_WORKER: process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKER,
    CLEMMY_WORKER_INTENT_ROUTING: process.env.CLEMMY_WORKER_INTENT_ROUTING,
  };
  let captured: any;
  try {
    process.env.AUTH_MODE = 'claude_oauth';
    process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKER = 'on';
    process.env.CLEMMY_WORKER_INTENT_ROUTING = 'on';
    setClaudeAgentSdkWorkerRunForTest(async (options) => {
      captured = options;
      return {
        text: 'sdk worker used skill',
        sessionId: 'sdk-worker-session',
        model: 'claude-sonnet-4-6',
        toolUses: ['mcp__clementine-local__skill_read'],
      };
    });

    const agent = await buildOrchestratorAgent();
    const runWorker = (agent.tools ?? []).find((t) => (t as { name?: string }).name === 'run_worker') as {
      invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
    } | undefined;
    assert.ok(runWorker, 'expected run_worker on orchestrator surface');

    const packet = {
      objective: 'Design one report section using the taste skill.',
      item: 'report hero',
      resolvedTools: 'skill_read',
      context: 'Use the installed taste skill.',
      instructions: 'Call skill_read before writing the design.',
      expectedOutput: 'One compact design direction.',
      intent: 'design',
    };
    const input = JSON.stringify(packet);
    const result = await runWorker.invoke(
      new RunContext({ sessionId: session.id }),
      input,
      { toolCall: { name: 'run_worker', callId: 'call_worker_claude_design', arguments: input } },
    );

    assert.equal(result, 'sdk worker used skill');
    assert.equal(captured.modelId.startsWith('claude-'), true);
    assert.match(captured.prompt, /WORKER JOB PACKET/);
    assert.ok(captured.allowedLocalMcpTools.includes('skill_read'));
    const routed = listEvents(session.id, { types: ['worker_model_routed'] });
    const sdkEvent = routed.find((event) => (event.data as { transport?: string }).transport === 'claude_agent_sdk_worker');
    assert.ok(sdkEvent, 'expected SDK worker telemetry event');
    assert.deepEqual((sdkEvent.data as { toolUses?: string[] }).toolUses, ['mcp__clementine-local__skill_read']);
    const results = listEvents(session.id, { types: ['worker_result'] });
    assert.equal(results.length, 1);
    assert.equal((results[0].data as { item?: string }).item, 'report hero');
    assert.equal((results[0].data as { ok?: boolean }).ok, true);
    assert.equal((results[0].data as { model?: string }).model, 'claude-sonnet-4-6');
    assert.deepEqual((results[0].data as { toolUses?: string[] }).toolUses, ['mcp__clementine-local__skill_read']);
  } finally {
    setClaudeAgentSdkWorkerRunForTest(null);
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('run_worker emits worker_result ok=false when an already-capped item is refused before respawn', async () => {
  resetEventLog();
  const session = createSession({ kind: 'chat', title: 'capped worker result' });
  appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'system',
    type: 'worker_capped',
    data: { callId: 'call_old', item: 'Firm A - firm-a.example' },
  });
  const agent = await buildOrchestratorAgent();
  const runWorker = (agent.tools ?? []).find((t) => (t as { name?: string }).name === 'run_worker') as {
    invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
  } | undefined;
  assert.ok(runWorker, 'expected run_worker on orchestrator surface');

  const packet = {
    objective: 'Research one firm.',
    item: 'Firm A - firm-a.example',
    resolvedTools: 'none needed',
    context: 'Prior worker capped.',
    instructions: 'Do not retry capped work.',
    expectedOutput: 'One sentence or ERROR: <reason>.',
    intent: 'research',
  };
  const input = JSON.stringify(packet);
  const result = await runWorker.invoke(
    new RunContext({ sessionId: session.id }),
    input,
    { toolCall: { name: 'run_worker', callId: 'call_worker_capped', arguments: input } },
  );

  assert.match(String(result), /^ERROR:/);
  const results = listEvents(session.id, { types: ['worker_result'] });
  assert.equal(results.length, 1);
  assert.equal((results[0].data as { item?: string }).item, 'Firm A - firm-a.example');
  assert.equal((results[0].data as { ok?: boolean }).ok, false);
  assert.equal((results[0].data as { toolCallId?: string }).toolCallId, 'call_worker_capped');
  assert.match(String((results[0].data as { reason?: string }).reason), /already exhausted/i);
});

test('Orchestrator has NO handoffs in Phase 3 (single-agent architecture)', async () => {
  const agent = await buildOrchestratorAgent();
  const handoffs = agent.handoffs ?? [];
  assert.equal(handoffs.length, 0, `expected no handoffs, got ${handoffs.length}`);
});

test('request_approval triggers the SDK interrupt for external/destructive actions', async () => {
  // Supervised posture: the default is now 'yolo' (Autonomous, 2026-07-20) which
  // auto-approves reversible external writes (e.g. a Salesforce create). This test
  // asserts the request_approval gate FLAGS those actions, so pin Supervised.
  saveProactivityPolicy({ autoApproveScope: 'strict' });
  const t = buildRequestApprovalTool();
  assert.equal(t.name, 'request_approval');
  const needsFn = t.needsApproval as unknown as (
    ctx: unknown,
    input: { subject: string; reason: string | null; destructive: boolean },
  ) => Promise<boolean>;
  // External mutation — should pause for human approval.
  assert.equal(
    await needsFn({}, { subject: 'Send email to customer', reason: 'Outreach', destructive: false }),
    true,
  );
  // Destructive remote action — should pause.
  assert.equal(
    await needsFn({}, { subject: 'Delete remote record', reason: null, destructive: true }),
    true,
  );
  // Composio write — should pause.
  assert.equal(
    await needsFn({}, { subject: 'Create Salesforce account', reason: null, destructive: false }),
    true,
  );
});

test('YOLO never auto-approves an unlinked email action phrased as a verb', async () => {
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const t = buildRequestApprovalTool();
    const needsFn = t.needsApproval as unknown as (
      ctx: unknown,
      input: {
        subject: string;
        reason: string | null;
        destructive: boolean;
        preview: null;
        pendingActionId: null;
      },
    ) => Promise<boolean>;

    for (const subject of ['Email the customer', 'E-mail the customer']) {
      assert.equal(
        await needsFn({}, {
          subject,
          reason: null,
          destructive: false,
          preview: null,
          pendingActionId: null,
        }),
        true,
        `${subject} must retain the human approval floor without pending-action metadata`,
      );
    }

    assert.equal(
      await needsFn({}, {
        subject: 'Save the email template to memory',
        reason: null,
        destructive: false,
        preview: null,
        pendingActionId: null,
      }),
      false,
      'email used as a noun in a local save remains reversible',
    );
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
  }
});

test('request_approval auto-resolves local saves so user-initiated memory writes do not stall', async () => {
  // Repro: orchestrator was gating "save salesforce CLI rule to memory" behind
  // an approval prompt even though the action was local and the user had just
  // asked for it. The "approve" reply landed on a different paused session
  // and the rule never made it into the vault, so the agent kept re-asking
  // the same context question across sessions.
  const t = buildRequestApprovalTool();
  const needsFn = t.needsApproval as unknown as (
    ctx: unknown,
    input: { subject: string; reason: string | null; destructive: boolean },
  ) => Promise<boolean>;
  // The exact orchestrator-continuation regression shape — must NOT pause.
  assert.equal(
    await needsFn({}, {
      subject: 'Save Salesforce access rule to memory',
      reason: 'Store user preference that Salesforce work should use the CLI by default',
      destructive: false,
    }),
    false,
  );
  // Other local-save phrasings the model commonly produces — none should pause.
  for (const subject of [
    'Remember this fact',
    'Add a task to TASKS.md',
    'Update a goal',
    'Save workflow draft',
    'Persist note to vault',
  ]) {
    assert.equal(
      await needsFn({}, { subject, reason: null, destructive: false }),
      false,
      `local-save should auto-approve: ${subject}`,
    );
  }
});

test('request_approval execute carries auto-approval reason when the action was local', async () => {
  // When the runtime guard auto-resolves, the execute payload should make
  // that explicit so the orchestrator's next decision knows it can proceed
  // without re-confirming.
  const t = buildRequestApprovalTool();
  const sess = createSession({ kind: 'chat' });
  const result = await invokeFunctionTool(
    t,
    {
      subject: 'Save Salesforce CLI rule to memory',
      reason: 'User preference',
      destructive: false,
      preview: null,
      pendingActionId: null,
    },
    { sessionId: sess.id, turn: 1 },
  );
  assert.match(result, /Auto-approved \(local save/);
  // No approval_requested event was emitted (the loop is what emits it, and
  // for auto-resolved calls the SDK never triggers the interrupt).
  const events = listEvents(sess.id, { types: ['approval_requested'] });
  assert.equal(events.length, 0);
});

test('request_approval human resume preserves linked pending-action provenance', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const action = pendingActions.queuePendingAction({
    title: 'Send queued proof',
    summary: 'Send one proof email after approval.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: { composioSlug: 'GMAIL_SEND_EMAIL', arguments: { to: 'proof@example.com' } },
    sessionId: sess.id,
  });
  const args = {
    subject: 'Send queued proof',
    reason: 'The exact payload is ready.',
    destructive: false,
    preview: null,
    pendingActionId: action.id,
  };
  const approval = approvalRegistry.register({
    sessionId: sess.id,
    subject: args.subject,
    tool: 'request_approval',
    args,
  });
  assert.equal(pendingActions.getPendingAction(action.id)?.status, 'approval_requested');
  assert.equal(approvalRegistry.resolve(approval.approvalId, 'approved', 'unit-test-human').ok, true);
  assert.equal(pendingActions.getPendingAction(action.id)?.approvedBy, 'human');

  const result = await invokeFunctionTool(buildRequestApprovalTool(), args, { sessionId: sess.id, turn: 2 });
  assert.match(result, /Queued action .* is approved/);
  assert.match(result, /pending_action_execute/);
  assert.match(result, /Do NOT call pending_action_get/);
  const resumed = pendingActions.getPendingAction(action.id);
  assert.equal(resumed?.approvedBy, 'human');
  assert.deepEqual(resumed?.approvalEvidence, { kind: 'card', approvalId: approval.approvalId });
});

test('request_approval opens the queued composio tool_slug scope without reconstructing it', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const action = pendingActions.queuePendingAction({
    title: 'Create exact calendar invite',
    summary: 'Create the exact reviewed invite.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: { tool_slug: 'OUTLOOK_CREATE_EVENT', arguments: JSON.stringify({ attendees: ['person@example.com'] }) },
    sessionId: sess.id,
  });
  const args = {
    subject: 'Create exact calendar invite',
    reason: 'Reviewed invite payload.',
    destructive: false,
    preview: null,
    pendingActionId: action.id,
  };
  const approval = approvalRegistry.register({ sessionId: sess.id, subject: args.subject, tool: 'request_approval', args });
  approvalRegistry.resolve(approval.approvalId, 'approved', 'unit-test-human');

  const result = await invokeFunctionTool(buildRequestApprovalTool(), args, { sessionId: sess.id, turn: 2 });
  assert.match(result, /pending_action_execute/);
  assert.match(result, /Approved scope opened for OUTLOOK_CREATE_EVENT/);
  assert.deepEqual(getPlanScope(sess.id)?.allowedComposioSlugs, ['OUTLOOK_CREATE_EVENT']);
});

test('request_approval mints policy provenance only on a true YOLO auto-approval', async () => {
  resetEventLog();
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const sess = createSession({ kind: 'chat' });
    const action = pendingActions.queuePendingAction({
      title: 'Create queued draft',
      summary: 'Create one reversible Outlook draft.',
      kind: 'external_write',
      toolName: 'composio_execute_tool',
      payload: { composioSlug: 'OUTLOOK_CREATE_DRAFT', arguments: { subject: 'Proof' } },
      sessionId: sess.id,
    });
    const args = {
      subject: 'Create one Outlook draft',
      reason: 'The user requested the reversible draft.',
      destructive: false,
      preview: null,
      pendingActionId: action.id,
    };
    const tool = buildRequestApprovalTool();
    const needsApproval = tool.needsApproval as unknown as (ctx: unknown, input: typeof args) => Promise<boolean>;
    assert.equal(await needsApproval({}, args), false, 'YOLO should auto-approve this reversible write');

    const result = await invokeFunctionTool(tool, args, { sessionId: sess.id, turn: 3 });
    assert.match(result, /Auto-approved by YOLO mode/);
    const approved = pendingActions.getPendingAction(action.id);
    assert.equal(approved?.approvedBy, 'policy');
    assert.deepEqual(approved?.approvalEvidence, { kind: 'policy', scope: 'yolo' });
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
  }
});

// The SDK's tool() exposes `invoke(runContext, inputString)` rather
// than a raw execute. Tests drive the tool via invoke with a JSON
// args string, matching what the Runner does during a real run.
async function invokeFunctionTool(
  t: ReturnType<typeof buildRequestApprovalTool> | ReturnType<typeof buildAskUserQuestionTool>,
  args: Record<string, unknown>,
  ctx: { sessionId?: string; turn?: number },
): Promise<string> {
  const invoke = (t as unknown as {
    invoke: (runContext: unknown, inputJson: string) => Promise<string>;
  }).invoke;
  const runContext = { context: ctx };
  const result = await invoke(runContext, JSON.stringify(args));
  return typeof result === 'string' ? result : JSON.stringify(result);
}

// offer_background ceremony stripped 2026-07-22 — backgrounding is the desktop
// button + a plain prose ask routed to dispatch_background_task (charter item 13).

test('request_approval execute returns an "approved" acknowledgement after resume', async () => {
  // execute() only runs after the user approves — at that point the
  // SDK resumes the run and feeds the return value back to the model.
  // The approval_requested event is emitted by the loop (loop.test.ts),
  // not by the tool body.
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const t = buildRequestApprovalTool();
  const result = await invokeFunctionTool(
    t,
    { subject: 'deploy to prod', reason: 'staging green', destructive: true, preview: null, pendingActionId: null },
    { sessionId: sess.id, turn: 3 },
  );
  assert.match(result, /Approved: deploy to prod/);
  // No approval_requested event from execute — the loop owns that.
  const events = listEvents(sess.id, { types: ['approval_requested'] });
  assert.equal(events.length, 0);
});

test('request_approval execute opens a slug-scoped plan scope for Outlook draft batches', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const t = buildRequestApprovalTool();
  const result = await invokeFunctionTool(
    t,
    {
      subject: 'Create 15 personalized Outlook drafts',
      reason: 'Write draft emails into Outlook for review, without sending.',
      destructive: false,
      preview: {
        count: 15,
        samples: [
          {
            label: 'Draft',
            value: 'Acme has been the best choice for us.',
            secondary: 'To: Pat Dunphy <pdunphy@example.com>',
          },
        ],
      },
      pendingActionId: null,
    },
    { sessionId: sess.id, turn: 4 },
  );
  assert.match(result, /Approved scope opened for OUTLOOK_CREATE_DRAFT/);
  const scope = getPlanScope(sess.id);
  assert.deepEqual(scope?.allowedTools, ['composio_execute_tool']);
  assert.deepEqual(scope?.allowedComposioSlugs, ['OUTLOOK_CREATE_DRAFT']);
});

test('ask_user_question emits awaiting_user_input with options', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const t = buildAskUserQuestionTool();
  const result = await invokeFunctionTool(
    t,
    { question: 'which environment?', options: ['staging', 'prod'], purpose: null },
    { sessionId: sess.id, turn: 1 },
  );
  assert.match(result, /Question posted/);

  const events = listEvents(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.question, 'which environment?');
  assert.deepEqual(events[0].data.options, ['staging', 'prod']);
});

test('ask_user_question publishes at most one pause per provider turn', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const t = buildAskUserQuestionTool();
  await invokeFunctionTool(
    t,
    { question: 'Which environment?', options: ['staging', 'prod'], purpose: 'clarification' },
    { sessionId: sess.id, turn: 4 },
  );
  await invokeFunctionTool(
    t,
    { question: 'Which environment should I use?', options: ['staging', 'prod'], purpose: 'clarification' },
    { sessionId: sess.id, turn: 4 },
  );
  assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 1);
});

// ─── YOLO: approval-purpose ask_user_question must NOT halt; clarification must ───
// Typed `purpose` is the PRIMARY signal (reliable); the regex is the BACKSTOP
// when purpose is omitted (so this is strictly ≥ the v0.5.60 regex-only fix).

test('YOLO + purpose:"approval" does NOT halt — proceeds (typed signal)', async () => {
  resetEventLog();
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const sess = createSession({ kind: 'chat' });
    const t = buildAskUserQuestionTool();
    const result = await invokeFunctionTool(
      t,
      { question: 'Want me to send the rest of the R&R emails now?', options: ['Yes', 'No'], purpose: 'approval' },
      { sessionId: sess.id, turn: 1 },
    );
    assert.match(result, /standing approval|NOT pausing/i);
    assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 0, 'approval purpose must not halt');
    const notes = listEvents(sess.id, { types: ['autonomy_note'] });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].data.classifier, 'typed', 'declared purpose drives the typed path');
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
  }
});

test('YOLO + purpose:"clarification" still HALTS even in YOLO (she can still ask)', async () => {
  resetEventLog();
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const sess = createSession({ kind: 'chat' });
    const t = buildAskUserQuestionTool();
    // Note: this text is approval-SHAPED by the regex (has "send" + "should I"),
    // so this proves the TYPED clarification signal overrides the regex — a real
    // clarification is never auto-proceeded just because of its wording.
    const result = await invokeFunctionTool(
      t,
      { question: 'Should I send to the staging list or the prod list?', options: ['staging', 'prod'], purpose: 'clarification' },
      { sessionId: sess.id, turn: 1 },
    );
    assert.match(result, /Question posted/);
    assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 1, 'typed clarification halts even in YOLO');
    assert.equal(listEvents(sess.id, { types: ['autonomy_note'] }).length, 0);
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
  }
});

test('YOLO + purpose:null + approval-shaped text → regex BACKSTOP proceeds (>= v0.5.60)', async () => {
  resetEventLog();
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const sess = createSession({ kind: 'chat' });
    const t = buildAskUserQuestionTool();
    // The live incident question, with purpose omitted (null) — the regex catches it.
    const result = await invokeFunctionTool(
      t,
      {
        question: 'I’m blocked on the approved R&R email copy. Do you want me to use a specific prior template, or should I create the Outlook drafts first for review instead of sending live?',
        options: ['Use prior template and send', 'Create drafts for review'],
        purpose: null,
      },
      { sessionId: sess.id, turn: 1 },
    );
    assert.match(result, /standing approval|NOT pausing/i);
    assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 0);
    const notes = listEvents(sess.id, { types: ['autonomy_note'] });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].data.classifier, 'regex-backstop', 'omitted purpose falls back to the regex');
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
  }
});

test('YOLO + purpose:null + genuine info text → halts (regex correctly declines)', async () => {
  resetEventLog();
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const sess = createSession({ kind: 'chat' });
    const t = buildAskUserQuestionTool();
    const result = await invokeFunctionTool(
      t,
      { question: 'Which Salesforce environment should I read from, staging or prod?', options: ['staging', 'prod'], purpose: null },
      { sessionId: sess.id, turn: 1 },
    );
    assert.match(result, /Question posted/);
    assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 1);
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
  }
});

test('non-YOLO (balanced) + purpose:"approval" still halts (no default-user regression)', async () => {
  resetEventLog();
  saveProactivityPolicy({ autoApproveScope: 'balanced' });
  const sess = createSession({ kind: 'chat' });
  const t = buildAskUserQuestionTool();
  await invokeFunctionTool(
    t,
    { question: 'Should I send the rest of the emails now?', options: ['Yes send', 'No'], purpose: 'approval' },
    { sessionId: sess.id, turn: 1 },
  );
  assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 1, 'balanced is byte-identical: still halts');
});

test('kill-switch off → YOLO + purpose:"approval" halts (revert path)', async () => {
  resetEventLog();
  const prev = process.env.CLEMMY_YOLO_NO_APPROVAL_HALT;
  process.env.CLEMMY_YOLO_NO_APPROVAL_HALT = 'off';
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const sess = createSession({ kind: 'chat' });
    const t = buildAskUserQuestionTool();
    await invokeFunctionTool(
      t,
      { question: 'Want me to send them now?', options: null, purpose: 'approval' },
      { sessionId: sess.id, turn: 1 },
    );
    assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 1, 'kill-switch off → halts');
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
    if (prev === undefined) delete process.env.CLEMMY_YOLO_NO_APPROVAL_HALT;
    else process.env.CLEMMY_YOLO_NO_APPROVAL_HALT = prev;
  }
});

test('ask_user_question tool description names the purpose param + both values', () => {
  const t = buildAskUserQuestionTool();
  const desc = (t as unknown as { description?: string }).description ?? '';
  assert.match(desc, /purpose/);
  assert.match(desc, /clarification/);
  assert.match(desc, /approval/);
});

test('deliberation tools no-op silently when no sessionId is on the context', async () => {
  // Tools must not throw when called outside the harness (e.g. via
  // the SDK's playground or a unit test).
  resetEventLog();
  const t = buildAskUserQuestionTool();
  const result = await invokeFunctionTool(
    t,
    { question: 'is anyone listening?', options: null, purpose: null },
    {},
  );
  assert.match(result, /Question posted/);
});

// ─── Continuity-aware tool scope: the orchestrator reads prior turns from the
// eventlog so a keyword-less confirmation inherits the active scope (the
// verified "chatbot feel" incident: every iteration turn dropped the tools). ───

function seedUserInput(sessionId: string, turn: number, text: string): void {
  appendEvent({ sessionId, turn, role: 'user', type: 'user_input_received', data: { text } });
}

test('recentPriorUserInputsForScope: returns prior turns newest-first, excluding the current input', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', channel: 'discord' });
  seedUserInput(sess.id, 1, 'draft the outlook emails to the 44 contacts');
  seedUserInput(sess.id, 2, 'make the tone a bit more playful');
  seedUserInput(sess.id, 3, "let's get them ready"); // the current turn
  const prior = recentPriorUserInputsForScope(sess.id, "let's get them ready");
  assert.equal(prior.includes("let's get them ready"), false, 'excludes the current turn');
  assert.deepEqual(prior, ['make the tone a bit more playful', 'draft the outlook emails to the 44 contacts']);
});

test('continuity end-to-end: a bare confirmation inherits the active Outlook scope from the eventlog (the incident)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', channel: 'discord' });
  seedUserInput(sess.id, 1, 'draft the outlook emails to the 44 contacts'); // had tool intent
  seedUserInput(sess.id, 2, "let's get them ready"); // keyword-less confirmation
  const prior = recentPriorUserInputsForScope(sess.id, "let's get them ready");
  const scope = resolveMcpToolScopeWithContinuity({ userInput: "let's get them ready", priorUserInputs: prior });
  assert.ok((scope.maxTools ?? 0) > 0, 'tools are no longer stripped on the confirmation turn');
  assert.ok((scope.allowedServerSlugs ?? []).some((s) => /outlook|microsoft/.test(s)));
  assert.match(scope.reason, /continuity/);
});

test('continuity cross-session: a NEW session inherits scope via the continuation lineage', () => {
  resetEventLog();
  const prior = createSession({ kind: 'chat', channel: 'discord' });
  seedUserInput(prior.id, 1, 'draft the outlook emails to the 44 contacts');
  const current = createSession({ kind: 'chat', channel: 'discord' });
  // This session has only a keyword-less turn, but it continues the prior one.
  appendEvent({
    sessionId: current.id, turn: 0, role: 'system', type: 'cross_session_prefix',
    data: { priorSessionIds: [prior.id], sessionsIncluded: 1, totalChars: 0, text: '' },
  });
  seedUserInput(current.id, 1, "let's get them ready");
  const inherited = recentPriorUserInputsForScope(current.id, "let's get them ready");
  assert.ok(inherited.includes('draft the outlook emails to the 44 contacts'), 'walks the lineage when this session has no prior intent');
  const scope = resolveMcpToolScopeWithContinuity({ userInput: "let's get them ready", priorUserInputs: inherited });
  assert.ok((scope.allowedServerSlugs ?? []).some((s) => /outlook|microsoft/.test(s)));
});

test('OrchestratorDecision: nextAction enum covers the harness states the loop expects', () => {
  // This is documentation-as-test: the loop matches on these strings
  // to decide whether to recurse, mark complete, or pause. Drift here
  // means a follow-up turn might mis-route.
  const expected = z.enum([
    'awaiting_user_input',
    'awaiting_approval',
    'awaiting_handoff_result',
    'completed',
    'abandoned',
  ]);
  for (const value of expected.options) {
    assert.doesNotThrow(() =>
      OrchestratorDecisionSchema.parse({
        summary: 'enum coverage check',
        done: value === 'completed',
        nextAction: value,
        reason: null,
      }),
    );
  }
});

test('isCommitSafeWorkerFallover: mirrors the chat-lane eligibility ladder (2026-07-20 parity widening)', async () => {
  const { isCommitSafeWorkerFallover } = await import('./orchestrator.js');
  const { ClaudeSdkProviderOverloadError, ClaudeSdkAuthExpiredError } = await import('../runtime/harness/claude-agent-sdk.js');
  const { AgentRuntimeCancelledError } = await import('../runtime/provider.js');

  // Typed committed-aware errors trust their flag: eligible only pre-commit
  // (a committed overload is salvaged by the SDK lane; a committed anything
  // must never be blindly re-driven — double-act).
  assert.equal(isCommitSafeWorkerFallover(new ClaudeSdkProviderOverloadError('529 overloaded', false)), true, 'uncommitted overload → fall over');
  assert.equal(isCommitSafeWorkerFallover(new ClaudeSdkProviderOverloadError('529 overloaded', true)), false, 'committed overload → never re-run (double-act)');
  assert.equal(isCommitSafeWorkerFallover(new ClaudeSdkAuthExpiredError('401 token expired', false)), true, 'uncommitted auth-expiry → fall over to a connected brain');
  assert.equal(isCommitSafeWorkerFallover(new ClaudeSdkAuthExpiredError('401 token expired', true)), false, 'committed auth-expiry → never re-run');
  // The generic committed=true guard covers FUTURE typed errors too, not just
  // the two named classes.
  const committedish = Object.assign(new Error('flaky thing'), { committed: true });
  assert.equal(isCommitSafeWorkerFallover(committedish), false, 'ANY error carrying committed=true → never re-run');

  // Generic terminal errors (5xx, timeout, SDK throw) ARE eligible — parity
  // with isChatBrainFalloverEligible: the re-run happens in the SAME parent
  // session, so the duplicate-send hard wall blocks a re-send of any committed
  // irreversible write. Before 2026-07-20 these hard-failed the item while
  // every other lane fell over.
  assert.equal(isCommitSafeWorkerFallover(new Error('some generic 500')), true, 'generic terminal error → fall over (dup-send wall protects the re-run)');
  assert.equal(isCommitSafeWorkerFallover(new Error('missing required field actorId')), true);

  // NEVER an intentional stop: a user cancel/kill is not a brain failure.
  assert.equal(isCommitSafeWorkerFallover(new AgentRuntimeCancelledError('cancelled')), false, 'user cancel → never fall over');
  const killShaped = new Error('session x has a pending kill request');
  killShaped.name = 'KillRequested';
  assert.equal(isCommitSafeWorkerFallover(killShaped), false, 'kill-shaped error name → never fall over');

  // Non-Error junk stays ineligible.
  assert.equal(isCommitSafeWorkerFallover('string error'), false);
  assert.equal(isCommitSafeWorkerFallover(undefined), false);
});
