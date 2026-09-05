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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-orchestrator-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

const {
  resetEventLog,
  createSession,
  listEvents,
  appendEvent,
  writeToolOutput,
} = await import('../runtime/harness/eventlog.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const pendingActions = await import('../runtime/harness/pending-actions.js');
const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const capabilityManifests = await import('../runtime/harness/capability-manifest.js');
const composioOperationSemantics = await import('../integrations/composio/operation-semantics.js');
const {
  formatAutoResolvedAskUserQuestionOutput,
  formatAwaitingUserInputFinalOutput,
} = await import('../runtime/harness/terminal-tool.js');
const { getPlanScope } = await import('./plan-scope.js');
const { saveProactivityPolicy } = await import('./proactivity-policy.js');
const {
  buildOrchestratorAgent,
  buildOrchestratorAgentForApprovalResume,
  OrchestratorDecisionSchema,
  buildRequestApprovalTool,
  buildAskUserQuestionTool,
  recentPriorUserInputsForScope,
  ORCHESTRATOR_INSTRUCTIONS,
  orchestratorInternalsForTest,
  userChoiceToolUseBehavior,
} = await import('./orchestrator.js');
const { resolveMcpToolScopeWithContinuity } = await import('../runtime/mcp-tool-scope.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const { boundAgentMcpToolScope } = await import('../runtime/mcp-tool-authority.js');
const { TOOL_JIT_CORE } = await import('./tool-jit.js');
const { RunContext, Usage } = await import('@openai/agents');
const { RouterModelProvider } = await import('../runtime/harness/router-model.js');
const { setClaudeAgentSdkWorkerRunForTest } = await import('../runtime/harness/claude-agent-worker.js');
const { summarizeWorkManifest } = await import('../runtime/harness/work-manifest.js');
const { _setInnerDispatchToolsForTests } = await import('../tools/inner-dispatch.js');
const { boundAgentCapabilityEnvelope, boundAgentCapabilityRevision } = await import('./capability-envelope.js');
const {
  markByoModelNotServed,
  clearByoNotServedForTest,
} = await import('../runtime/harness/byo-providers.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('../runtime/harness/brackets.js');

function installExactReversibleSheetCapability(): () => void {
  const prior = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const operationSemantics = composioOperationSemantics
    .documentedComposioManifestOperationSemantics('GOOGLESHEETS_SHEET_FROM_JSON');
  assert.ok(operationSemantics?.atomicInputContent, 'fixture must use the reviewed production Sheet semantics');
  const inputSchemaDigest = 'ab'.repeat(32);
  const outputSchemaDigest = 'cd'.repeat(32);
  const definitionFingerprint = 'ef'.repeat(32);
  const manifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: 'cap:test:googlesheets-sheet-from-json',
    providerKind: 'composio',
    operationId: 'GOOGLESHEETS_SHEET_FROM_JSON',
    providerIdentity: 'composio',
    providerVersion: 'fixture-provider-v1',
    operationVersion: 'fixture-operation-v1',
    definitionFingerprint,
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: inputSchemaDigest,
      providerOutputSchemaObserved: true,
      providerOutputSchemaDigest: outputSchemaDigest,
      semanticName: 'GOOGLESHEETS_SHEET_FROM_JSON',
      behaviorHints: {
        readOnly: false,
        destructive: false,
        idempotent: null,
        openWorld: null,
      },
    },
    effect: 'external_write',
    operationSemantics,
    destination: { family: 'googlesheets', posture: 'create_new' },
    accountId: 'ca_google_sheets_owner',
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'created_resource' },
    evidenceContract: {
      kinds: operationSemantics.atomicInputContent.evidence,
      readbackRequired: false,
    },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-29T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['create', 'destination'],
  });
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory([{
      capabilityId: manifest.manifestId,
      toolName: manifest.operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      effect: manifest.effect,
      destination: manifest.destination,
      account: manifest.accountId,
      advisoryRoles: manifest.advisoryRoles,
      manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
      providerKind: manifest.providerKind,
      providerInputSchemaDigest: inputSchemaDigest,
      liveFingerprint: manifest.definitionFingerprint,
      manifest,
      invoke: async () => ({}),
    }]),
  );
  return () => capabilityCatalogs.installHostCapabilityCatalogFactory(prior);
}

/**
 * Production no longer lets a bracketed tool mint settlement authority from a
 * session id alone: every wrapped dispatch needs the ACCEPTED SOURCE
 * (user_input_received) plus a PERSISTED TURN GRAPH for that accepted task.
 * Anchor the same exact identity the real turn spine establishes before
 * dispatch. Chat-session fixtures persist the graph shadow; the harness run
 * context then carries the identity into settlement.
 */
function anchorAcceptedTask(sessionId: string, text: string): { sourceUserSeq: number; turn: number } {
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const shadow = recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: source.seq, turn: source.turn },
  });
  if (!shadow) throw new Error('fixture could not persist a turn graph');
  return { sourceUserSeq: source.seq, turn: source.turn };
}

function withAnchoredDispatch<T>(
  sessionId: string,
  anchor: { sourceUserSeq: number; turn: number },
  work: () => Promise<T>,
): Promise<T> {
  return withHarnessRunContext(
    { sessionId, sourceUserSeq: anchor.sourceUserSeq, turn: anchor.turn, counter: new ToolCallsCounter(1_000) },
    work,
  ) as Promise<T>;
}

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
    assert.equal(
      agent.mcpServers.length,
      0,
      'the model SDK must not own an executable third-party MCP server',
    );
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

test('approval-resume agent keeps the exact connector scope captured with the parked RunState', async () => {
  resetEventLog();
  const session = HarnessSession.create({ kind: 'chat', channel: 'test' });
  const localOnlyScope = {
    reason: 'explicit local-only/no-external-tools instruction',
    allowedServerSlugs: [],
    toolPatterns: [],
    maxTools: 0,
  };
  session.saveInterruptState('opaque-run-state-for-agent-build-test', {
    mcpToolScope: localOnlyScope,
  });

  const agent = await buildOrchestratorAgentForApprovalResume({
    sessionId: session.id,
    allowToolJit: true,
  });
  const bound = boundAgentMcpToolScope(agent);

  assert.equal(bound.bound, true);
  assert.deepEqual(bound.scope, localOnlyScope);
  const scopeEvent = listEvents(session.id, { types: ['mcp_tool_scope'] }).at(-1);
  assert.equal(scopeEvent?.data.allowAll, false, 'approval resume must not widen a local-only turn to allowAll');
  assert.equal(scopeEvent?.data.maxTools, 0);
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
  // SDK normalises into <kind>GuardrailDefinitions. The interactive INPUT
  // rail is EMPTY by design (gate audit S3, 2026-07-23): policy_violation was
  // the last user-text keyword matcher — autonomy flags are enforced by
  // stripping tools in the autonomy lane, and chat sends are approval-gated.
  const inputNames = (agent.inputGuardrails ?? []).map((g) =>
    (g as { name?: string }).name,
  );
  const outputNames = (agent.outputGuardrails ?? []).map((g) =>
    (g as { name?: string }).name,
  );
  assert.equal(inputNames.length, 0);
  assert.ok(outputNames.includes('secret_leak'));
});

test('production call_tool admits a deferred built-in against the orchestrator sealed universe before dispatch', async () => {
  const session = createSession({ kind: 'chat', channel: 'test' });
  let dispatches = 0;
  _setInnerDispatchToolsForTests(new Map([['desktop_status', {
    name: 'desktop_status',
    invoke: async () => {
      dispatches += 1;
      return 'desktop-ok';
    },
  }]]));
  try {
    const agent = await buildOrchestratorAgent({
      sessionId: session.id,
      allowToolJit: true,
      userInput: 'prove the sealed capability boundary',
    });
    const envelope = boundAgentCapabilityEnvelope(agent);
    const before = boundAgentCapabilityRevision(agent);
    assert.ok(envelope, 'production agent did not bind a sealed capability universe');
    assert.ok(before, 'production agent did not bind an active capability revision');
    assert.ok(envelope!.capabilities.some((capability) => capability.name === 'desktop_status'));
    assert.equal(before!.bound.includes('desktop_status'), false, 'fixture must exercise a deferred capability');

    const callTool = (agent.tools ?? []).find((toolRef) => (toolRef as { name?: string }).name === 'call_tool') as unknown as {
      invoke: (context: unknown, input: string, details: unknown) => Promise<unknown>;
    } | undefined;
    assert.ok(callTool, 'schema-on-demand production surface omitted call_tool');
    const anchor = anchorAcceptedTask(session.id, 'prove the sealed capability boundary');
    const output = await withAnchoredDispatch(session.id, anchor, () => callTool!.invoke(
      { context: { sessionId: session.id, sourceUserSeq: anchor.sourceUserSeq, turn: anchor.turn } },
      JSON.stringify({ name: 'desktop_status', args_json: '{}' }),
      { toolCall: { callId: 'orchestrator-capability-admission' } },
    ));
    assert.equal(String(output), 'desktop-ok');
    assert.equal(dispatches, 1, 'admitted production call dispatched more or less than once');
    const after = boundAgentCapabilityRevision(agent)!;
    assert.equal(after.revision, before!.revision + 1);
    assert.deepEqual([...after.bound], [...before!.bound, 'desktop_status']);
  } finally {
    _setInnerDispatchToolsForTests(null);
  }
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

test('ask_user_question check-in receipts halt on the question, not the protocol id', () => {
  const question = 'Did you mean today, Saturday August 29, at 12:00 PM Pacific?';
  const result = userChoiceToolUseBehavior({}, [
    {
      type: 'function_output',
      tool: { name: 'ask_user_question' },
      output: 'Check-in created: chk-4b814f04. The user has been notified; you\'ll see their answer in your next cycle\'s inbox.',
      argumentsJson: JSON.stringify({ question, urgency: 'high' }),
    },
  ]);
  assert.equal(result.isFinalOutput, true);
  assert.equal(result.finalOutput, formatAwaitingUserInputFinalOutput(question));
  assert.doesNotMatch(String(result.finalOutput), /Check-in created/);
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
    'pending_action_queue', 'pending_action_list', 'pending_action_get', 'pending_action_execute', 'pending_action_record_result',
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
  assert.equal(
    toolNames.length,
    new Set(toolNames).size,
    'structural capabilities must not be duplicated by the registry-derived discovery surface',
  );
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
  // ROUTE-SCOPED CARRIERS. This guard builds ONE default surface, so it cannot
  // see a tool that exists only on another route. `work_call` is mounted only on
  // an accepted action turn, where it REPLACES call_tool as the sole business
  // carrier, and the instruction naming it is itself scoped to accepted actions
  // — so the promise is kept on the turn that hears it. That surface is pinned
  // elsewhere (standard-action-expected-work-production test 1: work_call
  // present, call_tool absent), which is what keeps this exemption from being a
  // hole. Keep the set to carriers a route genuinely swaps — anything else here
  // would be a real allowlist omission hiding behind an exemption.
  const ROUTE_SCOPED_CARRIERS = new Set(['work_call']);
  const mentioned = new Set<string>();
  for (const m of String(ORCHESTRATOR_INSTRUCTIONS).matchAll(/`([a-z][a-z0-9_]+)(?:\([^`]*)?`/g)) {
    const n = m[1];
    // require a '_' (tool-shaped) and exclude server-namespaced MCP names
    // (dataforseo__…) which are scope-dependent, not allowlist entries.
    if (n.includes('_') && !n.includes('__')) mentioned.add(n);
  }
  assert.ok(mentioned.size >= 30, `extraction sanity: expected 30+ instructed tool mentions, got ${mentioned.size}`);
  const missing = [...mentioned]
    .filter((n) => !surface.has(n) && !NON_TOOL_MENTIONS.has(n) && !ROUTE_SCOPED_CARRIERS.has(n))
    .sort();
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
    // Durable-opportunity capture is conditional on explicit schedule/reuse/
    // recovery evidence in the request; it persists review bytes only.
    'automation_opportunity_propose',
    'automation_opportunity_review_request',
    'automation_read_pilot_acquisition_list',
    'automation_read_pilot_request',
    'automation_read_pilot_workspace_create_request',
    'automation_read_pilot_workspace_list',
    'automation_recurrence_request',
    'memory_pin', 'memory_restore', 'memory_list_facts',
    'task_add', 'task_update', 'task_list',
    'background_tasks_recent', 'background_task_status', 'background_task_revise', 'dispatch_background_task',
    // Focus lifecycle is conditional and phrased explicitly by the user
    // ("done", "move on", "save this for later", "back to X"). Keep the
    // common get/set/update notebook surface core; retrieve these rarer state
    // transitions only when that lifecycle intent is present.
    'focus_activate', 'focus_clear', 'focus_park', 'focus_touch',
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
  assert.match(runWorker.description ?? '', /typed exact `externalMcpToolNames` array/);
  assert.match(runWorker.description ?? '', /resolvedTools carries schemas\/commands\/instructions but does not widen that lease/);
  // 2026-07-21 deterministic fan-out: `items` (nullable) joined the packet and
  // `item` became nullable — strict mode keeps both in `required` with null types.
  assert.deepEqual(runWorker.parameters?.required, [
    'objective',
    'item',
    'resolvedTools',
    'externalMcpToolNames',
    'context',
    'instructions',
    'expectedOutput',
    'intent',
    'model',
    'workManifest',
    // 2026-08-11 contracted fan-out: expectedWork carries the frozen-plan
    // requirement so workers bind instead of concluding a capability is
    // missing (nullable; strict mode keeps it in required).
    'expectedWork',
    'items',
  ]);
  assert.equal(runWorker.parameters?.additionalProperties, false);
  assert.ok(runWorker.parameters?.properties?.resolvedTools);
  assert.ok(runWorker.parameters?.properties?.intent);
  assert.ok(runWorker.parameters?.properties?.items);
  const manifestSchema = runWorker.parameters?.properties?.workManifest as {
    anyOf?: Array<{
      properties?: Record<string, {
        anyOf?: Array<{
          items?: {
            additionalProperties?: boolean;
            required?: string[];
          };
        }>;
      }>;
    }>;
  } | undefined;
  const aliasItems = manifestSchema?.anyOf?.[0]?.properties?.aliases?.anyOf?.[0]?.items;
  assert.equal(aliasItems?.additionalProperties, false);
  assert.deepEqual(aliasItems?.required, ['alias', 'itemId']);
  assert.equal(Object.hasOwn(runWorker.parameters?.properties ?? {}, 'input'), false);
});

test('orchestrator run_worker refuses a quantified successful subset before dispatch', async () => {
  resetEventLog();
  // The quantified-subset refusal keys on user_input_received +
  // fanout_policy_decision rows, never on session kind. The BRACKETED invoke
  // driven here additionally demands the chat-turn authority spine (accepted
  // source + persisted turn graph), which TurnGraph v1 contracts for chat
  // sessions only — so this fixture anchors a chat session.
  const session = createSession({ kind: 'chat', title: 'quantified subset' });
  const inputEvent = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Research these 10 prospects and summarize each one.' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: inputEvent.seq, turn: inputEvent.turn },
  }), 'fixture could not persist a turn graph for the accepted task');
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'turn_started',
    data: { sourceUserSeq: inputEvent.seq },
  });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'fanout_policy_decision',
    data: { sourceUserSeq: inputEvent.seq, detected: true, itemCount: 10 },
  });

  const agent = await buildOrchestratorAgent();
  const runWorker = (agent.tools ?? []).find((tool) => (tool as { name?: string }).name === 'run_worker') as {
    invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
  } | undefined;
  assert.ok(runWorker);
  const packet = {
    objective: 'Research each prospect for the parent batch.',
    item: null,
    items: Array.from({ length: 7 }, (_, index) => `prospect-${index + 1}`),
    resolvedTools: 'none needed',
    externalMcpToolNames: null,
    context: 'Fictional prospect identifiers.',
    instructions: 'Return one compact observation per assigned prospect.',
    expectedOutput: 'prospect id | observation',
    intent: null,
    workManifest: {
      id: 'prospects',
      contractVersion: '1',
      phase: 'research',
      mode: 'declare',
      phases: [{ id: 'research' }],
    },
  };
  const encoded = JSON.stringify(packet);
  const result = await withAnchoredDispatch(
    session.id,
    { sourceUserSeq: inputEvent.seq, turn: inputEvent.turn },
    () => runWorker.invoke(
      new RunContext({ sessionId: session.id, sourceUserSeq: inputEvent.seq }),
      encoded,
      {
        toolCall: {
          name: 'run_worker',
          callId: 'call_quantified_subset',
          arguments: encoded,
        },
      },
    ),
  );

  assert.match(String(result), /^ERROR:/);
  assert.match(String(result), /7\/10/);
  assert.equal(listEvents(session.id, { types: ['worker_started'] }).length, 0);
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

test('run_worker invokes the host Worker on the routed intent model (offline provider)', async (t) => {
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
      async *getStreamedResponse(request) {
        const response = await this.getResponse(request);
        yield { type: 'response_started' } as never;
        yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
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
    t.mock.method(RouterModelProvider.prototype, 'getModel', stubProvider.getModel.bind(stubProvider));

    const packet = {
      objective: 'Generate one design variation for the parent batch.',
      item: 'landing page hero',
      resolvedTools: 'none needed',
      externalMcpToolNames: null,
      context: 'Use the supplied brand brief.',
      instructions: 'Return one compact design direction.',
      expectedOutput: 'One sentence or ERROR: <reason>.',
      intent: 'design',
      workManifest: {
        id: 'design-variations',
        contractVersion: '1',
        phase: 'design',
        mode: 'declare',
        phases: [{ id: 'design' }],
      },
    };
    const input = JSON.stringify(packet);
    const anchor = anchorAcceptedTask(session.id, 'Generate one design variation for the landing page hero.');
    const result = await withAnchoredDispatch(session.id, anchor, () => runWorker.invoke(
      new RunContext({ sessionId: session.id }),
      input,
      {
        parentRunConfig: { modelProvider: stubProvider },
        toolCall: { name: 'run_worker', callId: 'call_worker_design', arguments: input },
      },
    ));

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
    const manifest = summarizeWorkManifest(session.id, 'design-variations');
    assert.equal(manifest?.total, 1);
    assert.equal(manifest?.phases[0]?.succeeded, 1);
    assert.equal(manifest?.evidenceCount, 1);

    // A restarted brain can legitimately rebuild the packet differently. The
    // durable logical item — not this call's packet hash — owns idempotency.
    const resumedPacket = {
      ...packet,
      instructions: 'After restart, return the same compact design direction without repeating completed work.',
      workManifest: {
        ...packet.workManifest,
        mode: 'reconcile',
      },
    };
    const resumedInput = JSON.stringify(resumedPacket);
    const resumed = await withAnchoredDispatch(session.id, anchor, () => runWorker.invoke(
      new RunContext({ sessionId: session.id }),
      resumedInput,
      {
        parentRunConfig: { modelProvider: stubProvider },
        toolCall: { name: 'run_worker', callId: 'call_worker_design_after_restart', arguments: resumedInput },
      },
    ));
    assert.match(String(resumed), /Durable receipt: this item was already complete/);
    assert.match(String(resumed), /No worker ran and no action was repeated/);
    assert.match(String(resumed), /worker finished on routed model/, 'the original persisted work-product is reused');
    assert.match(String(resumed), /Do not call run_worker again for this phase; synthesize the user-facing result now/);
    assert.equal(
      requestedModels.filter((model) => model === 'minimax-01').length,
      1,
      'a changed packet must not dispatch the completed logical item again',
    );
    assert.equal(listEvents(session.id, { types: ['worker_started'] }).length, 1);
    const resumedResults = listEvents(session.id, { types: ['worker_result'] });
    assert.equal(resumedResults.length, 2, 'reuse remains visible without becoming another execution');
    assert.match(String((resumedResults[1].data as { reason?: string }).reason), /durable manifest success/i);
    assert.equal(
      summarizeWorkManifest(session.id, 'design-variations')?.items[0]?.phases.design.attempts,
      2,
      'reuse does not manufacture another running/succeeded checkpoint pair',
    );

    // The long-horizon failure mode was batch-shaped: after a completed
    // manifest was requested again, the tool returned a generic "Batch
    // complete" banner, so the brain could not tell receipt reuse from fresh
    // execution and sometimes asked for the same batch repeatedly. Keep the
    // persisted outputs, but make terminal graph state explicit.
    const batchPacket = {
      ...packet,
      item: null,
      items: ['landing page variation a', 'landing page variation b'],
      workManifest: {
        id: 'design-batch',
        contractVersion: '1',
        phase: 'design',
        mode: 'declare',
        phases: [{ id: 'design' }],
      },
    };
    const batchInput = JSON.stringify(batchPacket);
    const firstBatch = await withAnchoredDispatch(session.id, anchor, () => runWorker.invoke(
      new RunContext({ sessionId: session.id }),
      batchInput,
      {
        parentRunConfig: { modelProvider: stubProvider },
        toolCall: { name: 'run_worker', callId: 'call_worker_design_batch', arguments: batchInput },
      },
    ));
    assert.match(String(firstBatch), /Batch complete: 2\/2 items succeeded/);
    const requestsAfterFirstBatch = requestedModels.length;

    const resumedBatchPacket = {
      ...batchPacket,
      instructions: 'Recover completed variations and synthesize without repeating work.',
      workManifest: {
        ...batchPacket.workManifest,
        mode: 'reconcile',
      },
    };
    const resumedBatchInput = JSON.stringify(resumedBatchPacket);
    const resumedBatch = await withAnchoredDispatch(session.id, anchor, () => runWorker.invoke(
      new RunContext({ sessionId: session.id }),
      resumedBatchInput,
      {
        parentRunConfig: { modelProvider: stubProvider },
        toolCall: { name: 'run_worker', callId: 'call_worker_design_batch_after_restart', arguments: resumedBatchInput },
      },
    ));
    assert.match(String(resumedBatch), /Durable receipt: all 2\/2 requested items were already complete/);
    assert.match(String(resumedBatch), /No worker ran and no action was repeated/);
    assert.match(String(resumedBatch), /complete "design" phase is already proven/);
    assert.match(String(resumedBatch), /Do not call run_worker again for this phase; synthesize the user-facing result now/);
    assert.equal(
      requestedModels.length,
      requestsAfterFirstBatch,
      'a fully completed manifest batch returns receipts without spawning another model',
    );
    assert.equal(
      listEvents(session.id, { types: ['worker_started'] })
        .filter((event) => String((event.data as { item?: string }).item).startsWith('landing page variation')).length,
      2,
      'only the original two batch workers ran',
    );
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('run_worker route and result telemetry use the effective post-repair BYO model', async (t) => {
  resetEventLog();
  clearByoNotServedForTest();
  const session = createSession({ kind: 'chat', title: 'run_worker repaired route truth' });
  const prev: Record<string, string | undefined> = {
    AUTH_MODE: process.env.AUTH_MODE,
    MODEL_ROUTING_MODE: process.env.MODEL_ROUTING_MODE,
    BYO_MODEL_BASE_URL: process.env.BYO_MODEL_BASE_URL,
    BYO_MODEL_API_KEY: process.env.BYO_MODEL_API_KEY,
    BYO_MODEL_ID: process.env.BYO_MODEL_ID,
    OPENAI_MODEL_WORKER: process.env.OPENAI_MODEL_WORKER,
    CLEMMY_MODEL_ROLES_REGISTRY: process.env.CLEMMY_MODEL_ROLES_REGISTRY,
    CLEMMY_MODEL_ROLES: process.env.CLEMMY_MODEL_ROLES,
    CLEMMY_WORKER_INTENT_ROUTING: process.env.CLEMMY_WORKER_INTENT_ROUTING,
  };
  const requestedModels: Array<string | undefined> = [];
  try {
    process.env.AUTH_MODE = 'api_key';
    process.env.MODEL_ROUTING_MODE = 'all_in';
    process.env.BYO_MODEL_BASE_URL = 'https://api.example.test';
    process.env.BYO_MODEL_API_KEY = 'k';
    process.env.BYO_MODEL_ID = 'glm-5.2';
    process.env.OPENAI_MODEL_WORKER = 'gpt-5.4';
    process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
    process.env.CLEMMY_MODEL_ROLES = '';
    process.env.CLEMMY_WORKER_INTENT_ROUTING = 'on';
    markByoModelNotServed('gpt-5.4');

    const stubModel: import('@openai/agents').Model = {
      async getResponse() {
        return {
          output: [{
            type: 'message',
            id: 'msg_worker_repaired',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'worker finished after route repair', providerData: {} }],
          }],
          usage: new Usage(),
          responseId: 'resp_worker_repaired',
        } as unknown as import('@openai/agents').ModelResponse;
      },
      async *getStreamedResponse(request) {
        const response = await this.getResponse(request);
        yield { type: 'response_started' } as never;
        yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
      },
    };
    const stubProvider: import('@openai/agents').ModelProvider = {
      getModel(modelName?: string) {
        requestedModels.push(modelName);
        return stubModel;
      },
    };

    const agent = await buildOrchestratorAgent();
    const runWorker = (agent.tools ?? []).find((tool) => (tool as { name?: string }).name === 'run_worker') as {
      invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
    } | undefined;
    assert.ok(runWorker);

    const packet = {
      objective: 'Produce one fictional SEO note.',
      item: 'Auric & Vale Law',
      resolvedTools: 'none needed',
      externalMcpToolNames: null,
      context: 'This is fictional.',
      instructions: 'Return one concise sentence.',
      expectedOutput: 'One sentence or ERROR: <reason>.',
      intent: 'research',
      workManifest: {
        id: 'repaired-worker-route',
        contractVersion: '1',
        phase: 'snapshot',
        mode: 'declare',
        phases: [{ id: 'snapshot' }],
      },
    };
    const input = JSON.stringify(packet);
    t.mock.method(RouterModelProvider.prototype, 'getModel', stubProvider.getModel.bind(stubProvider));
    const anchor = anchorAcceptedTask(session.id, 'Produce one fictional SEO note.');
    const result = await withAnchoredDispatch(session.id, anchor, () => runWorker.invoke(
      new RunContext({ sessionId: session.id }),
      input,
      {
        parentRunConfig: { modelProvider: stubProvider },
        toolCall: { name: 'run_worker', callId: 'call_worker_repaired', arguments: input },
      },
    ));

    assert.equal(result, 'worker finished after route repair');
    assert.deepEqual(requestedModels, ['glm-5.2']);

    const started = listEvents(session.id, { types: ['worker_started'] });
    assert.equal((started[0]?.data as { model?: string }).model, 'glm-5.2');
    assert.equal((started[0]?.data as { provider?: string }).provider, 'byo');

    const routed = listEvents(session.id, { types: ['worker_model_routed'] });
    assert.equal(routed.length, 1);
    assert.equal((routed[0].data as { modelId?: string }).modelId, 'glm-5.2');
    assert.equal((routed[0].data as { provider?: string }).provider, 'byo');
    assert.equal((routed[0].data as { transport?: string }).transport, 'host_harness');

    const results = listEvents(session.id, { types: ['worker_result'] });
    assert.equal(results.length, 1);
    assert.equal((results[0].data as { ok?: boolean }).ok, true);
    assert.equal((results[0].data as { model?: string }).model, 'glm-5.2');
  } finally {
    clearByoNotServedForTest();
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a Claude brain executes a durable Codex worker binding on the host worker lane', async (t) => {
  resetEventLog();
  const session = createSession({ kind: 'chat', title: 'claude brain codex worker route' });
  const authFile = path.join(TMP_HOME, 'state', 'auth.json');
  const prev: Record<string, string | undefined> = {
    AUTH_MODE: process.env.AUTH_MODE,
    CLAUDE_MODEL: process.env.CLAUDE_MODEL,
    MODEL_ROUTING_MODE: process.env.MODEL_ROUTING_MODE,
    CLEMMY_CLAUDE_AGENT_SDK_WORKER: process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKER,
    CLEMMY_MODEL_ROLES_REGISTRY: process.env.CLEMMY_MODEL_ROLES_REGISTRY,
    CLEMMY_MODEL_ROLES: process.env.CLEMMY_MODEL_ROLES,
    CLEMMY_WORKER_INTENT_ROUTING: process.env.CLEMMY_WORKER_INTENT_ROUTING,
  };
  const requestedModels: Array<string | undefined> = [];
  try {
    process.env.AUTH_MODE = 'claude_oauth';
    process.env.CLAUDE_MODEL = 'claude-sonnet-5';
    process.env.MODEL_ROUTING_MODE = 'off';
    process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKER = 'on';
    process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
    process.env.CLEMMY_WORKER_INTENT_ROUTING = 'on';
    process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{
      role: 'worker',
      modelId: 'gpt-5.4',
      whenIntent: 'research',
      scope: 'durable',
      source: 'settings',
    }]);
    writeFileSync(authFile, JSON.stringify({
      source: 'native',
      codexOauth: {
        accessToken: 'test-codex-access',
        refreshToken: 'test-codex-refresh',
        accountId: 'test-codex-account',
        lastRefresh: new Date().toISOString(),
      },
    }), 'utf8');
    setClaudeAgentSdkWorkerRunForTest(async () => {
      assert.fail('a Codex-bound worker must not enter the Claude Agent SDK lane');
    });

    const stubModel: import('@openai/agents').Model = {
      async getResponse() {
        return {
          output: [{
            type: 'message',
            id: 'msg_codex_worker_done',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'codex worker completed under claude brain', providerData: {} }],
          }],
          usage: new Usage(),
          responseId: 'resp_codex_worker_done',
        } as unknown as import('@openai/agents').ModelResponse;
      },
      async *getStreamedResponse(request) {
        const response = await this.getResponse(request);
        yield { type: 'response_started' } as never;
        yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
      },
    };
    const stubProvider: import('@openai/agents').ModelProvider = {
      getModel(modelName?: string) {
        requestedModels.push(modelName);
        return stubModel;
      },
    };

    const agent = await buildOrchestratorAgent();
    const runWorker = (agent.tools ?? []).find((tool) => (tool as { name?: string }).name === 'run_worker') as {
      invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
    } | undefined;
    assert.ok(runWorker, 'expected run_worker on the Claude-brain orchestrator surface');
    t.mock.method(RouterModelProvider.prototype, 'getModel', stubProvider.getModel.bind(stubProvider));

    const packet = {
      objective: 'Research one fictional account.',
      item: 'Cedar & Finch',
      resolvedTools: 'none needed',
      externalMcpToolNames: null,
      context: 'This is an offline routing proof.',
      instructions: 'Return one concise sentence.',
      expectedOutput: 'One sentence or ERROR: <reason>.',
      intent: 'research',
      workManifest: {
        id: 'claude-brain-codex-worker',
        contractVersion: '1',
        phase: 'research',
        mode: 'declare',
        phases: [{ id: 'research' }],
      },
    };
    const input = JSON.stringify(packet);
    const anchor = anchorAcceptedTask(session.id, 'Research one fictional account with the configured worker.');
    const result = await withAnchoredDispatch(session.id, anchor, () => runWorker.invoke(
      new RunContext({ sessionId: session.id }),
      input,
      {
        parentRunConfig: { modelProvider: stubProvider },
        toolCall: { name: 'run_worker', callId: 'call_claude_brain_codex_worker', arguments: input },
      },
    ));

    assert.equal(result, 'codex worker completed under claude brain');
    assert.deepEqual(requestedModels, ['gpt-5.4']);
    const started = listEvents(session.id, { types: ['worker_started'] });
    assert.equal((started[0]?.data as { model?: string }).model, 'gpt-5.4');
    assert.equal((started[0]?.data as { provider?: string }).provider, 'codex');
    const routed = listEvents(session.id, { types: ['worker_model_routed'] });
    assert.equal(routed.length, 1);
    assert.equal((routed[0].data as { modelId?: string }).modelId, 'gpt-5.4');
    assert.equal((routed[0].data as { provider?: string }).provider, 'codex');
    assert.equal((routed[0].data as { source?: string }).source, 'settings');
    assert.equal((routed[0].data as { matchedIntent?: string }).matchedIntent, 'research');
    assert.equal((routed[0].data as { transport?: string }).transport, 'host_harness');
    const results = listEvents(session.id, { types: ['worker_result'] });
    assert.equal(results.length, 1);
    assert.equal((results[0].data as { ok?: boolean }).ok, true);
    assert.equal((results[0].data as { model?: string }).model, 'gpt-5.4');
  } finally {
    setClaudeAgentSdkWorkerRunForTest(null);
    rmSync(authFile, { force: true });
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('fresh-host run_worker is enabled and invokes a worker before any plan is compiled', async () => {
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

    const acceptedText = 'Design one report section using the taste skill.';
    const anchor = anchorAcceptedTask(session.id, acceptedText);
    const { actionExpectedWorkRequired } = await import('../runtime/harness/expected-work-admission.js');
    assert.equal(actionExpectedWorkRequired({
      sessionId: session.id,
      sourceUserSeq: anchor.sourceUserSeq,
    }), false, 'fresh accepted input has no compiled expected-work contract');
    const agent = await buildOrchestratorAgent({
      sessionId: session.id,
      sourceUserSeq: anchor.sourceUserSeq,
      userInput: acceptedText,
      acceptedRoute: 'act',
      hostFreshPlanning: freshPlanningFixture(session.id, anchor.sourceUserSeq),
      allowedToolNames: ['run_worker', 'skill_read'],
      mcpToolScope: {
        authority: 'none',
        reason: 'local worker preparation needs no external capabilities',
        allowedServerSlugs: [],
        toolPatterns: [],
        maxTools: 0,
      },
    });
    // Use the SDK's filtered surface: agent.tools alone includes tools hidden
    // by isEnabled, which is why the original route-only test missed this wall.
    const runContext = new RunContext({ sessionId: session.id });
    const enabledTools = await agent.getAllTools(runContext);
    const runWorker = enabledTools.find((t) => t.name === 'run_worker') as {
      invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
    } | undefined;
    assert.ok(runWorker, 'local delegation must be enabled before plan_task');

    const packet = {
      objective: 'Design one report section using the taste skill.',
      item: 'report hero',
      resolvedTools: 'skill_read',
      externalMcpToolNames: null,
      context: 'Use the installed taste skill.',
      instructions: 'Call skill_read before writing the design.',
      expectedOutput: 'One compact design direction.',
      intent: 'design',
    };
    const input = JSON.stringify(packet);
    const result = await withAnchoredDispatch(session.id, anchor, () => runWorker.invoke(
      runContext,
      input,
      { toolCall: { name: 'run_worker', callId: 'call_worker_claude_design', arguments: input } },
    ));

    assert.equal(result, 'sdk worker used skill');
    assert.equal(captured.modelId.startsWith('claude-'), true);
    assert.match(captured.prompt, /WORKER JOB PACKET/);
    assert.ok(captured.allowedLocalMcpTools.includes('skill_read'));
    assert.equal(captured.sessionId, session.id);
    assert.equal(captured.sourceUserSeq, anchor.sourceUserSeq);
    assert.equal(captured.workerScope, true, 'delegation retains worker effect restrictions');
    assert.ok(captured.maxTurns > 0 && Number.isFinite(captured.maxTurns));
    assert.equal(captured.nativeMcpToolScope, null, 'enabling delegation retains the denied external scope');
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
    assert.equal(actionExpectedWorkRequired({
      sessionId: session.id,
      sourceUserSeq: anchor.sourceUserSeq,
    }), false, 'delegation must not manufacture a planning contract');
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
    externalMcpToolNames: null,
    context: 'Prior worker capped.',
    instructions: 'Do not retry capped work.',
    expectedOutput: 'One sentence or ERROR: <reason>.',
    intent: 'research',
  };
  const input = JSON.stringify(packet);
  const anchor = anchorAcceptedTask(session.id, 'Research one firm.');
  const result = await withAnchoredDispatch(session.id, anchor, () => runWorker.invoke(
    new RunContext({ sessionId: session.id }),
    input,
    { toolCall: { name: 'run_worker', callId: 'call_worker_capped', arguments: input } },
  ));

  assert.match(String(result), /^ERROR:/);
  const results = listEvents(session.id, { types: ['worker_result'] });
  assert.equal(results.length, 1);
  assert.equal((results[0].data as { item?: string }).item, 'Firm A - firm-a.example');
  assert.equal((results[0].data as { ok?: boolean }).ok, false);
  assert.equal((results[0].data as { toolCallId?: string }).toolCallId, 'call_worker_capped');
  assert.match(String((results[0].data as { reason?: string }).reason), /already exhausted/i);
  assert.equal(
    listEvents(session.id, { types: ['worker_started'] }).length,
    0,
    'a pre-run refusal is never rendered as a real worker execution',
  );
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

test('request_approval cannot auto-approve a reversible pending action owned by another session', async () => {
  resetEventLog();
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  const restoreCatalog = installExactReversibleSheetCapability();
  try {
    const owner = createSession({ kind: 'chat' });
    const foreign = createSession({ kind: 'chat' });
    const action = pendingActions.queuePendingAction({
      title: 'Create reviewed Sheet',
      summary: 'Create one exact reversible Google Sheet.',
      kind: 'external_write',
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: 'GOOGLESHEETS_SHEET_FROM_JSON',
        arguments: JSON.stringify({
          title: 'Proof',
          sheet_name: 'Results',
          sheet_json: [{ status: 'ready' }],
        }),
        connected_account_id: 'ca_google_sheets_owner',
      },
      sessionId: owner.id,
    });
    const args = {
      // This wording previously activated the local-save shortcut after the
      // foreign payload made requestApprovalRequiresHuman return false.
      subject: 'Save this Sheet recipe to memory',
      reason: 'Store the prepared Sheet recipe for later.',
      destructive: false,
      preview: null,
      pendingActionId: action.id,
    };
    const tool = buildRequestApprovalTool();
    const needsApproval = tool.needsApproval as unknown as (
      ctx: unknown,
      input: typeof args,
    ) => Promise<boolean>;

    assert.equal(
      await needsApproval({ context: { sessionId: foreign.id } }, args),
      true,
      'even YOLO cannot borrow an exact reversible action owned by another session',
    );
    const result = await invokeFunctionTool(tool, args, { sessionId: foreign.id, turn: 1 });
    assert.match(result, /different session|does not belong|refused/i);
    assert.equal(
      pendingActions.getPendingAction(action.id)?.status,
      'queued',
      'foreign-session invocation must not mutate approval state',
    );
    assert.equal(getPlanScope(foreign.id), null, 'foreign payload must not open a tool scope');
  } finally {
    restoreCatalog();
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
  }
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
  const restoreCatalog = installExactReversibleSheetCapability();
  try {
    const sess = createSession({ kind: 'chat' });
    const action = pendingActions.queuePendingAction({
      title: 'Create reviewed Sheet',
      summary: 'Create one exact reversible Google Sheet.',
      kind: 'external_write',
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: 'GOOGLESHEETS_SHEET_FROM_JSON',
        arguments: JSON.stringify({
          title: 'Proof',
          sheet_name: 'Results',
          sheet_json: [{ status: 'ready' }],
        }),
        connected_account_id: 'ca_google_sheets_owner',
      },
      sessionId: sess.id,
    });
    const args = {
      subject: 'Create one Google Sheet',
      reason: 'The user requested this exact reversible create.',
      destructive: false,
      preview: null,
      pendingActionId: action.id,
    };
    const tool = buildRequestApprovalTool();
    const needsApproval = tool.needsApproval as unknown as (ctx: unknown, input: typeof args) => Promise<boolean>;
    assert.equal(
      await needsApproval({ context: { sessionId: sess.id } }, args),
      false,
      'YOLO should auto-approve an exact manifest-proven reversible write in its owning session',
    );
    assert.equal(
      await needsApproval({ context: { sessionId: sess.id } }, { ...args, destructive: true }),
      true,
      'a destructive or high-risk declaration still requires the human even for the exact operation',
    );

    const ambiguous = pendingActions.queuePendingAction({
      title: 'Transform unknown provider blob',
      summary: 'The provider effect has no exact current semantic contract.',
      kind: 'external_write',
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: 'ACME_TRANSFORM_BLOB',
        arguments: JSON.stringify({ source: 'proof', destination: 'unknown' }),
        connected_account_id: 'ca_acme_owner',
      },
      sessionId: sess.id,
    });
    const ambiguousArgs = {
      subject: 'Transform provider blob',
      reason: 'The effect is not positively classified.',
      destructive: false,
      preview: null,
      pendingActionId: ambiguous.id,
    };
    assert.equal(
      await needsApproval({ context: { sessionId: sess.id } }, ambiguousArgs),
      true,
      'a name-shaped or model-described reversible write cannot replace exact manifest authority',
    );
    assert.equal(pendingActions.getPendingAction(ambiguous.id)?.approvedBy, null);

    const result = await invokeFunctionTool(tool, args, { sessionId: sess.id, turn: 3 });
    assert.match(result, /Auto-approved by YOLO mode/);
    const approved = pendingActions.getPendingAction(action.id);
    assert.equal(approved?.approvedBy, 'policy');
    assert.deepEqual(approved?.approvalEvidence, { kind: 'policy', scope: 'yolo' });
  } finally {
    restoreCatalog();
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
  }
});

// The SDK's tool() exposes `invoke(runContext, inputString)` rather
// than a raw execute. Tests drive the tool via invoke with a JSON
// args string, matching what the Runner does during a real run.
async function invokeFunctionTool(
  t: ReturnType<typeof buildRequestApprovalTool> | ReturnType<typeof buildAskUserQuestionTool>,
  args: Record<string, unknown>,
  ctx: { sessionId?: string; turn?: number; sourceUserSeq?: number },
): Promise<string> {
  const invoke = (t as unknown as {
    invoke: (runContext: unknown, inputJson: string) => Promise<string>;
  }).invoke;
  const runContext = { context: ctx };
  const result = await invoke(runContext, JSON.stringify(args));
  return typeof result === 'string' ? result : JSON.stringify(result);
}

function decodedToolOutput(result: string): unknown {
  try { return JSON.parse(result) as unknown; } catch { return result; }
}

async function invokeAskWithArbitration(
  t: ReturnType<typeof buildAskUserQuestionTool>,
  args: Record<string, unknown>,
  ctx: { sessionId?: string; turn?: number; sourceUserSeq?: number },
) {
  const receipt = await invokeFunctionTool(t, args, ctx);
  const terminal = userChoiceToolUseBehavior({ context: ctx }, [{
    type: 'function_output',
    tool: { name: 'ask_user_question' },
    output: decodedToolOutput(receipt),
  }]);
  return { receipt, terminal };
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

test('request_approval prose cannot mint an operation scope without an exact queued payload', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const t = buildRequestApprovalTool();
  const result = await invokeFunctionTool(
    t,
    {
      subject: 'Create 15 external draft records',
      reason: 'Create reviewable drafts without publishing them.',
      destructive: false,
      preview: {
        count: 15,
        samples: [
          {
            label: 'Draft',
            value: 'Example bounded preview',
            secondary: 'Destination: connected account',
          },
        ],
      },
      pendingActionId: null,
    },
    { sessionId: sess.id, turn: 4 },
  );
  assert.doesNotMatch(result, /Approved scope opened for/i);
  assert.equal(getPlanScope(sess.id), null, 'approval prose is not live operation authority');
});

test('ask_user_question preserves exact source provenance and a single typed clarification purpose', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const t = buildAskUserQuestionTool();
  const { receipt, terminal } = await invokeAskWithArbitration(
    t,
    { question: 'which environment?', options: ['staging', 'prod'], purpose: 'clarification' },
    { sessionId: sess.id, turn: 1, sourceUserSeq: 41 },
  );
  assert.doesNotMatch(receipt, /Question posted/i, 'a staged tool call must not claim public delivery');
  assert.deepEqual(decodedToolOutput(receipt), {
    kind: 'clementine.ask_user_question.candidate',
    status: 'staged',
    posted: false,
    question: 'which environment?',
    options: ['staging', 'prod'],
    purpose: 'clarification',
  });
  assert.equal(terminal.isFinalOutput, true);
  assert.equal(
    terminal.finalOutput,
    '[clementine:awaiting-user-input:final]\nwhich environment?',
  );

  const events = listEvents(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.question, 'which environment?');
  assert.deepEqual(events[0].data.options, ['staging', 'prod']);
  assert.equal(events[0].data.purpose, 'clarification');
  assert.equal(events[0].data.sourceUserSeq, 41);
});

test('a unique tool_search account-selection write asks instead of continuing to plan', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send James Marshall an Outlook calendar invite today at 2pm' },
  });
  const searchOutput = {
    query: 'create Outlook calendar event invite attendee',
    role_key: 'clause-0:write',
    results: [{
      name: 'OUTLOOK_CALENDAR_CREATE_EVENT',
      planningRefStatus: 'account_selection_required',
      accountChoices: ['calendar@scorpion.example', 'calendar@personal.example'],
    }, {
      name: 'OUTLOOK_CREATE_CALENDAR_EVENT',
      planningRefStatus: 'account_selection_required',
      accountChoices: ['calendar@scorpion.example', 'calendar@personal.example'],
    }],
  };
  const result = userChoiceToolUseBehavior(
    { context: { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq } },
    [{
      type: 'function_output',
      tool: { name: 'tool_search' },
      output: searchOutput,
      argumentsJson: JSON.stringify({
        query: searchOutput.query,
        role_key: searchOutput.role_key,
        limit: 8,
        cursor: null,
      }),
    }],
    {
      actionExpectedWork: true,
      accountSelectionRequirements: [{
        roleKey: searchOutput.role_key,
        text: 'Send James Marshall an Outlook calendar invite today at 2pm',
        resolved: false,
      }],
    },
  );
  assert.equal(result.isFinalOutput, true, 'the host must halt instead of looping plan_task');
  assert.match(String(result.finalOutput), /Which connected account should I use\?/);
  const events = listEvents(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.question, 'Which connected account should I use?');
  assert.deepEqual(events[0].data.options, [
    'calendar@scorpion.example',
    'calendar@personal.example',
  ]);
  assert.equal(events[0].data.purpose, 'clarification');
});

test('an informational catalog query never turns planning account blockers into a user question', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'List the connected Outlook accounts without reading or changing calendar data.' },
  });
  const result = userChoiceToolUseBehavior(
    { context: { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq } },
    [{
      type: 'function_output',
      tool: { name: 'tool_search' },
      output: {
        query: 'list connected Outlook accounts',
        results: [{
          name: 'OUTLOOK_CALENDAR_CREATE_EVENT',
          planningRefStatus: 'account_selection_required',
          accountChoices: ['calendar@scorpion.example', 'calendar@personal.example'],
        }],
      },
    }],
    { actionExpectedWork: false },
  );
  assert.equal(result.isFinalOutput, false, 'catalog facts stay model-visible when no action authority is active');
  assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 0);
});

function freshPlanningFixture(sessionId: string, sourceUserSeq: number) {
  return {
    authority: { scope: 'primary_model_planning_catalog_v1' },
    identity: { sessionId, sourceUserSeq },
    capabilities: [],
    digest: '0'.repeat(64),
    effectCeiling: 'external_write',
    withheld: [],
  } as never;
}

function unresolvedTurnCandidatesFixture(input: {
  roleKey: string;
  text: string;
  effect: 'read' | 'write';
}) {
  return {
    candidates: [],
    requirements: [{
      roleKey: input.roleKey,
      clauseIndex: 0,
      text: input.text,
      effect: input.effect,
      resolved: false,
      resolvedCapabilities: [],
    }],
    matches: [],
    pinnedTools: [],
    semanticApplied: false,
    roleScopedDiscovery: true,
  } as never;
}

function invokeBuiltAgentToolUseBehavior(
  agent: Awaited<ReturnType<typeof buildOrchestratorAgent>>,
  context: unknown,
  toolResults: Parameters<typeof userChoiceToolUseBehavior>[1],
) {
  const behavior = agent.toolUseBehavior;
  assert.equal(typeof behavior, 'function', 'fresh planning must install the production callback wrapper');
  return (behavior as unknown as typeof userChoiceToolUseBehavior)(context, toolResults);
}

function accountSelectionSearchResult(input: {
  query: string;
  roleKey: string;
  results: Array<Record<string, unknown>>;
}) {
  return {
    type: 'function_output',
    tool: { name: 'tool_search' },
    output: {
      query: input.query,
      role_key: input.roleKey,
      results: input.results,
    },
    argumentsJson: JSON.stringify({
      query: input.query,
      role_key: input.roleKey,
      limit: 8,
      cursor: null,
    }),
  } as const;
}

test('production fresh-host action callback halts on an exact task-required account ambiguity', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const acceptedText = 'Send James Marshall an Outlook calendar invite today at 2pm.';
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: acceptedText },
  });
  const roleKey = 'clause-0:write';
  const agent = await buildOrchestratorAgent({
    sessionId: sess.id,
    sourceUserSeq: source.seq,
    userInput: acceptedText,
    acceptedRoute: 'act',
    hostFreshPlanning: freshPlanningFixture(sess.id, source.seq),
    turnCandidates: unresolvedTurnCandidatesFixture({ roleKey, text: acceptedText, effect: 'write' }),
    allowedToolNames: ['tool_search'],
    mcpToolScope: {
      authority: 'none',
      reason: 'orchestrator account-question fixture',
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    },
  });
  const search = accountSelectionSearchResult({
    query: 'create Outlook calendar event invite attendee',
    roleKey,
    results: [{
      name: 'OUTLOOK_CALENDAR_CREATE_EVENT',
      planningRefStatus: 'account_selection_required',
      accountChoices: ['calendar@scorpion.example', 'calendar@personal.example'],
    }],
  });
  const result = invokeBuiltAgentToolUseBehavior(
    agent,
    { context: { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq } },
    [search],
  );
  assert.equal(result.isFinalOutput, true);
  assert.match(String(result.finalOutput), /Which connected account should I use\?/);
  assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 1);
});

test('production fresh-host retrieve callback leaves a relevant account blocker with the model', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const acceptedText = 'Tell me whether the Outlook calendar event capability is available without creating anything.';
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: acceptedText },
  });
  const roleKey = 'clause-0:read';
  const agent = await buildOrchestratorAgent({
    sessionId: sess.id,
    sourceUserSeq: source.seq,
    userInput: acceptedText,
    acceptedRoute: 'retrieve',
    hostFreshPlanning: freshPlanningFixture(sess.id, source.seq),
    turnCandidates: unresolvedTurnCandidatesFixture({ roleKey, text: acceptedText, effect: 'read' }),
    allowedToolNames: ['tool_search'],
    mcpToolScope: {
      authority: 'none',
      reason: 'orchestrator account-question retrieve fixture',
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    },
  });
  const result = invokeBuiltAgentToolUseBehavior(
    agent,
    { context: { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq } },
    [accountSelectionSearchResult({
      query: 'create Outlook calendar event invite attendee',
      roleKey,
      results: [{
        name: 'OUTLOOK_CALENDAR_CREATE_EVENT',
        planningRefStatus: 'account_selection_required',
        accountChoices: ['calendar@scorpion.example', 'calendar@personal.example'],
      }],
    })],
  );
  assert.equal(result.isFinalOutput, false);
  assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 0);
});

test('production fresh-host action callback ignores an unrelated uniform account blocker', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const acceptedText = 'Put the 100 scraped company accounts into a Google Sheet.';
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: acceptedText },
  });
  const roleKey = 'clause-0:write';
  const agent = await buildOrchestratorAgent({
    sessionId: sess.id,
    sourceUserSeq: source.seq,
    userInput: acceptedText,
    acceptedRoute: 'act',
    hostFreshPlanning: freshPlanningFixture(sess.id, source.seq),
    turnCandidates: unresolvedTurnCandidatesFixture({ roleKey, text: acceptedText, effect: 'write' }),
    allowedToolNames: ['tool_search'],
    mcpToolScope: {
      authority: 'none',
      reason: 'orchestrator unrelated-account-blocker fixture',
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    },
  });
  const result = invokeBuiltAgentToolUseBehavior(
    agent,
    { context: { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq } },
    [accountSelectionSearchResult({
      query: 'write scraped company accounts to a Google Sheet',
      roleKey,
      results: ['OUTLOOK_CALENDAR_CREATE_EVENT', 'OUTLOOK_CREATE_CALENDAR_EVENT'].map((name) => ({
        name,
        planningRefStatus: 'account_selection_required',
        accountChoices: ['calendar@scorpion.example', 'calendar@personal.example'],
      })),
    })],
  );
  assert.equal(result.isFinalOutput, false, 'an incidental provider page stays model-visible');
  assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 0);
});

test('live invite: one grounded recipient miss after exact current-text account selection asks once', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Can you send a calendar invite to James Marshall please using my Scorpion email for today at 5 PM and tell him we need to talk about the new project',
    },
  });
  const callId = 'call-live-james-recall';
  const args = JSON.stringify({ query: 'James Marshall email address contact identity' });
  const recalled = '[WHO/WHAT] James A. Marshall: person - mentioned 44 times; no exact recipient address stored';
  const called = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: source.seq,
      tool: 'memory_recall_all',
      callId,
      accounting: 'top_level',
      effect: 'read',
      arguments: args,
    },
  });
  writeToolOutput({
    sessionId: sess.id,
    callId,
    invocationNonce: `nonce-${callId}`,
    tool: 'memory_recall_all',
    output: recalled,
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_returned',
    parentEventId: called.id,
    data: {
      sourceUserSeq: source.seq,
      tool: 'memory_recall_all',
      callId,
      accounting: 'top_level',
      effect: 'read',
      result: recalled,
    },
  });

  const result = userChoiceToolUseBehavior(
    { context: { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq } },
    [{
      type: 'function_output',
      tool: { name: 'tool_search' },
      output: {
        query: 'create Outlook calendar event invite attendee',
        results: [
          'OUTLOOK_CALENDAR_CREATE_EVENT',
          'OUTLOOK_CALENDAR_CREATE_EVENT_ATTACHMENT',
          'OUTLOOK_CREATE_EVENT',
          'OUTLOOK_CALENDAR_CANCEL_EVENT',
          'OUTLOOK_CALENDAR_ACCEPT_EVENT',
          'OUTLOOK_CALENDAR_DELETE_EVENT',
          'OUTLOOK_CALENDAR_DECLINE_EVENT',
          'OUTLOOK_CALENDAR_UPDATE_EVENT',
        ].map((name) => ({
          name,
          planningRefStatus: 'account_selection_required',
          accountChoices: [
            'calendar@scorpion.example',
            'calendar@personal.example',
          ],
        })),
      },
    }, {
      type: 'function_output',
      tool: { name: 'memory_recall_all' },
      output: recalled,
      argumentsJson: args,
      runItem: { rawItem: { callId } },
    }] as Parameters<typeof userChoiceToolUseBehavior>[1],
  );

  assert.equal(result.isFinalOutput, true);
  assert.match(String(result.finalOutput), /exact email address or recipient ID.*James Marshall|James Marshall.*exact email address or recipient ID/i);
  const events = listEvents(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.purpose, 'clarification');
  assert.equal(events[0].data.sourceUserSeq, source.seq);
});

test('live invite-for three-result batch stages one recipient question before planning', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Can you send a calendar invite for James Marshall through my Scorpion mailbox please for today at 6:30 PM tell him we need to talk about the new AI project please',
    },
  });
  const memoryCallId = 'call-live-for-james-recall';
  const memoryArgs = JSON.stringify({
    limit: 10,
    objective: 'James Marshall contact email — send calendar invite about new AI project',
  });
  const recalled = [
    '[RELEVANT MEMORY — evidence-backed]',
    '- [FACT] Scorpion sellers include Bobby Romano (seller.record@example.com).',
    '- [WHO/WHAT] James A. Marshall: person · mentioned 44×',
  ].join('\n');
  const called = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: source.seq,
      tool: 'memory_recall_all',
      callId: memoryCallId,
      accounting: 'top_level',
      effect: 'read',
      arguments: memoryArgs,
    },
  });
  writeToolOutput({
    sessionId: sess.id,
    callId: memoryCallId,
    invocationNonce: `nonce-${memoryCallId}`,
    tool: 'memory_recall_all',
    output: recalled,
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_returned',
    parentEventId: called.id,
    data: {
      sourceUserSeq: source.seq,
      tool: 'memory_recall_all',
      callId: memoryCallId,
      accounting: 'top_level',
      effect: 'read',
      result: recalled,
    },
  });

  const capabilities = [
    ['OUTLOOK_CREATE_CALENDAR_EVENT_ATTACHMENT', 'cap:resolved:outlook_create_calendar_event_attachment'],
    ['OUTLOOK_CALENDAR_CREATE_EVENT', 'cap:resolved:outlook_calendar_create_event'],
    ['OUTLOOK_CREATE_CALENDAR_EVENT', 'cap:resolved:outlook_create_calendar_event'],
    ['OUTLOOK_CANCEL_CALENDAR_GROUP_CALENDAR_EVENT', 'cap:resolved:outlook_cancel_calendar_group_calendar_event'],
    ['OUTLOOK_CANCEL_CALENDAR_EVENT', 'cap:resolved:outlook_cancel_calendar_event'],
  ] as const;
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: {
      sourceUserSeq: source.seq,
      capabilities: capabilities.map(([identifier, capabilityRef]) => ({
        identifier,
        capabilityRef,
        effectClass: 'write',
        accountIdentity: 'ca_uDzrJqqniJFk',
        providerKind: 'composio',
      })),
    },
  });

  const result = userChoiceToolUseBehavior(
    { context: { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq } },
    [{
      type: 'function_output',
      tool: { name: 'memory_recall_all' },
      output: recalled,
      argumentsJson: memoryArgs,
      runItem: { rawItem: { callId: memoryCallId } },
    }, {
      type: 'function_output',
      tool: { name: 'tool_search' },
      output: {
        query: 'create Outlook calendar event with required attendee and send invite',
        results: capabilities.map(([name, capabilityRef]) => ({ name, capabilityRef })),
      },
      argumentsJson: JSON.stringify({
        cursor: 'null',
        limit: 5,
        query: 'create Outlook calendar event with required attendee and send invite',
        role_key: 'null',
      }),
      runItem: { rawItem: { callId: 'call-live-for-calendar-search' } },
    }, {
      type: 'function_output',
      tool: { name: 'tool_search' },
      output: 'Tool call refused by harness: discovery budget denied (new_call_requires_retry_epoch) on tool_search.',
      argumentsJson: JSON.stringify({
        cursor: 'null',
        limit: 5,
        query: 'run shell command to query Salesforce contacts via sf CLI',
        role_key: 'null',
      }),
      runItem: { rawItem: { callId: 'call-live-for-refused-search' } },
    }] as Parameters<typeof userChoiceToolUseBehavior>[1],
  );

  assert.equal(result.isFinalOutput, true, 'the complete first batch must halt before plan_task');
  assert.match(String(result.finalOutput), /James Marshall.*exact email address or recipient ID/i);
  const events = listEvents(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.purpose, 'clarification');
  assert.equal(events[0].data.sourceUserSeq, source.seq);
});

function appendRecipientReadResult(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  callId: string;
  output: string;
}) {
  const argumentsJson = JSON.stringify({ query: 'James Marshall email address contact identity' });
  const called = appendEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: input.sourceUserSeq,
      tool: 'memory_recall_all',
      callId: input.callId,
      accounting: 'top_level',
      effect: 'read',
      arguments: argumentsJson,
    },
  });
  writeToolOutput({
    sessionId: input.sessionId,
    callId: input.callId,
    invocationNonce: `nonce-${input.callId}`,
    tool: 'memory_recall_all',
    output: input.output,
  });
  appendEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    role: 'Clem',
    type: 'tool_returned',
    parentEventId: called.id,
    data: {
      sourceUserSeq: input.sourceUserSeq,
      tool: 'memory_recall_all',
      callId: input.callId,
      accounting: 'top_level',
      effect: 'read',
      result: input.output,
    },
  });
  return {
    type: 'function_output',
    tool: { name: 'memory_recall_all' },
    output: input.output,
    argumentsJson,
    runItem: { rawItem: { callId: input.callId } },
  } as const;
}

test('recipient clarification reopens a result-batch capabilityRef only through its same-source account', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send a calendar invite to James Marshall today at 5 PM.' },
  });
  const capabilities = [
    ['OUTLOOK_CALENDAR_CREATE_EVENT', 'cap:resolved:outlook_calendar_create_event'],
    ['OUTLOOK_CALENDAR_CANCEL_EVENT', 'cap:resolved:outlook_calendar_cancel_event'],
    ['OUTLOOK_CALENDAR_DELETE_EVENT', 'cap:resolved:outlook_calendar_delete_event'],
  ] as const;
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: {
      sourceUserSeq: source.seq,
      capabilities: capabilities.map(([identifier, capabilityRef]) => ({
        identifier,
        capabilityRef,
        accountIdentity: 'calendar@scorpion.example',
        providerKind: 'composio',
      })),
    },
  });
  const read = appendRecipientReadResult({
    sessionId: sess.id,
    sourceUserSeq: source.seq,
    turn: 1,
    callId: 'call-capability-james-recall',
    output: '[WHO/WHAT] James A. Marshall: person record; no exact recipient address stored',
  });
  const result = userChoiceToolUseBehavior(
    { context: { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq } },
    [{
      type: 'function_output',
      tool: { name: 'tool_search' },
      output: {
        results: capabilities.map(([name, capabilityRef]) => ({ name, capabilityRef })),
      },
    }, read],
  );
  assert.equal(result.isFinalOutput, true);
  assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 1);
});

test('recipient clarification never invents account authority from the public search row', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send a calendar invite to James Marshall today at 5 PM.' },
  });
  const capabilityRef = 'cap:resolved:outlook_calendar_create_event';
  const read = appendRecipientReadResult({
    sessionId: sess.id,
    sourceUserSeq: source.seq,
    turn: 1,
    callId: 'call-unproved-account-james-recall',
    output: '[WHO/WHAT] James A. Marshall: person record; no exact recipient address stored',
  });
  const result = userChoiceToolUseBehavior(
    { context: { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq } },
    [{
      type: 'function_output',
      tool: { name: 'tool_search' },
      output: {
        results: [{
          name: 'OUTLOOK_CALENDAR_CREATE_EVENT',
          capabilityRef,
          accountIdentity: 'model-supplied-placeholder@example.test',
        }],
      },
    }, read],
  );
  assert.equal(result.isFinalOutput, false);
  assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 0);
});

test('recipient clarification rejects capability sets reopened across mixed accounts', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send a calendar invite to James Marshall today at 5 PM.' },
  });
  const capabilities = [{
    identifier: 'OUTLOOK_CALENDAR_CREATE_EVENT',
    capabilityRef: 'cap:resolved:outlook_calendar_create_event',
    accountIdentity: 'calendar@scorpion.example',
  }, {
    identifier: 'OUTLOOK_CALENDAR_CANCEL_EVENT',
    capabilityRef: 'cap:resolved:outlook_calendar_cancel_event',
    accountIdentity: 'calendar@personal.example',
  }];
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: { sourceUserSeq: source.seq, capabilities },
  });
  const read = appendRecipientReadResult({
    sessionId: sess.id,
    sourceUserSeq: source.seq,
    turn: 1,
    callId: 'call-mixed-account-james-recall',
    output: '[WHO/WHAT] James A. Marshall: person record; no exact recipient address stored',
  });
  const result = userChoiceToolUseBehavior(
    { context: { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq } },
    [{
      type: 'function_output',
      tool: { name: 'tool_search' },
      output: {
        results: capabilities.map(({ identifier: name, capabilityRef }) => ({ name, capabilityRef })),
      },
    }, read],
  );
  assert.equal(result.isFinalOutput, false);
  assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 0);
});

test('recipient clarification rejects blocker sets with mixed account choices', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Send a calendar invite to James Marshall using my Scorpion email today at 5 PM.',
    },
  });
  const read = appendRecipientReadResult({
    sessionId: sess.id,
    sourceUserSeq: source.seq,
    turn: 1,
    callId: 'call-mixed-choices-james-recall',
    output: '[WHO/WHAT] James A. Marshall: person record; no exact recipient address stored',
  });
  const result = userChoiceToolUseBehavior(
    { context: { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq } },
    [{
      type: 'function_output',
      tool: { name: 'tool_search' },
      output: {
        results: [{
          name: 'OUTLOOK_CALENDAR_CREATE_EVENT',
          planningRefStatus: 'account_selection_required',
          accountChoices: [
            'calendar@scorpion.example',
            'calendar@personal.example',
          ],
        }, {
          name: 'OUTLOOK_CALENDAR_CANCEL_EVENT',
          planningRefStatus: 'account_selection_required',
          accountChoices: [
            'calendar@scorpion.example',
            'calendar@other.example',
          ],
        }],
      },
    }, read],
  );
  assert.equal(result.isFinalOutput, false);
  assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 0);
});

test('recipient clarification abstains when a large lookup suppresses tail evidence', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Send a calendar invite to James Marshall using my Scorpion email today at 5 PM.',
    },
  });
  const read = appendRecipientReadResult({
    sessionId: sess.id,
    sourceUserSeq: source.seq,
    turn: 1,
    callId: 'call-large-james-recall',
    output: `${'x'.repeat(100_100)}\nJames Marshall email: james.marshall@example.com`,
  });
  const result = userChoiceToolUseBehavior(
    { context: { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq } },
    [{
      type: 'function_output',
      tool: { name: 'tool_search' },
      output: {
        results: [{
          name: 'OUTLOOK_CALENDAR_CREATE_EVENT',
          planningRefStatus: 'account_selection_required',
          accountChoices: [
            'calendar@scorpion.example',
            'calendar@personal.example',
          ],
        }],
      },
    }, read],
  );
  assert.equal(result.isFinalOutput, false);
  assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 0);
});

test('request-echo-only read asks, while an exact target-bound identifier suppresses it', () => {
  for (const fixture of [{
    suffix: 'echo-only',
    output: 'James Marshall email address contact identity',
    asks: true,
  }, {
    suffix: 'target-identity',
    output: 'James Marshall email: james.marshall@example.com',
    asks: false,
  }]) {
    resetEventLog();
    const sess = createSession({ kind: 'chat' });
    const source = appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: {
        text: 'Send a calendar invite to James Marshall using my Scorpion email today at 5 PM.',
      },
    });
    const read = appendRecipientReadResult({
      sessionId: sess.id,
      sourceUserSeq: source.seq,
      turn: 1,
      callId: `call-${fixture.suffix}-james-recall`,
      output: fixture.output,
    });
    const result = userChoiceToolUseBehavior(
      { context: { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq } },
      [{
        type: 'function_output',
        tool: { name: 'tool_search' },
        output: {
          results: [{
            name: 'OUTLOOK_CALENDAR_CREATE_EVENT',
            planningRefStatus: 'account_selection_required',
            accountChoices: [
              'calendar@scorpion.example',
              'calendar@personal.example',
            ],
          }],
        },
      }, read],
    );
    assert.equal(result.isFinalOutput, fixture.asks, fixture.suffix);
    assert.equal(
      listEvents(sess.id, { types: ['awaiting_user_input'] }).length,
      fixture.asks ? 1 : 0,
      fixture.suffix,
    );
  }
});

test('recipient clarification abstains after the same source enters an effect or approval path', () => {
  for (const disqualifier of ['effect', 'approval'] as const) {
    resetEventLog();
    const sess = createSession({ kind: 'chat' });
    const source = appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: {
        text: 'Send a calendar invite to James Marshall using my Scorpion email today at 5 PM.',
      },
    });
    const read = appendRecipientReadResult({
      sessionId: sess.id,
      sourceUserSeq: source.seq,
      turn: 1,
      callId: `call-${disqualifier}-james-recall`,
      output: '[WHO/WHAT] James A. Marshall: person record; no exact recipient address stored',
    });
    if (disqualifier === 'effect') {
      appendEvent({
        sessionId: sess.id,
        turn: 1,
        role: 'Clem',
        type: 'tool_called',
        data: {
          sourceUserSeq: source.seq,
          tool: 'OUTLOOK_CALENDAR_CREATE_EVENT',
          callId: 'call-effect-entered',
          effect: 'external_write',
        },
      });
    } else {
      appendEvent({
        sessionId: sess.id,
        turn: 1,
        role: 'Clem',
        type: 'approval_requested',
        data: { subject: 'Create the calendar invitation' },
      });
    }
    const result = userChoiceToolUseBehavior(
      { context: { sessionId: sess.id, turn: 1, sourceUserSeq: source.seq } },
      [{
        type: 'function_output',
        tool: { name: 'tool_search' },
        output: {
          results: [{
            name: 'OUTLOOK_CALENDAR_CREATE_EVENT',
            planningRefStatus: 'account_selection_required',
            accountChoices: [
              'calendar@scorpion.example',
              'calendar@personal.example',
            ],
          }],
        },
      }, read],
    );
    assert.equal(result.isFinalOutput, false, disqualifier);
    assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 0, disqualifier);
  }
});

test('parallel ask_user_question candidates become one provider-ordered natural bundle with exact dedupe', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const t = buildAskUserQuestionTool();
  // Complete the crew call first, then the tracker call. Arbitration must use
  // the SDK's provider-ordered result array below, never completion timing.
  const crewReceipt = await invokeFunctionTool(
    t,
    {
      question: 'Who is the crew for the update, and where should they receive it?',
      options: ['Slack or Discord', 'Email', 'Specific names'],
      purpose: 'clarification',
    },
    { sessionId: sess.id, turn: 4 },
  );
  const trackerReceipt = await invokeFunctionTool(
    t,
    {
      question: 'Where does the Zephyr deal tracker live?',
      options: ['Spreadsheet', 'Notion', 'Salesforce'],
      purpose: 'clarification',
    },
    { sessionId: sess.id, turn: 4 },
  );
  assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 0, 'candidates do not race to publish');
  for (const receipt of [trackerReceipt, crewReceipt]) {
    assert.doesNotMatch(receipt, /Question posted/i);
    assert.equal((decodedToolOutput(receipt) as { posted?: unknown }).posted, false);
  }

  const trackerOutput = decodedToolOutput(trackerReceipt);
  const crewOutput = decodedToolOutput(crewReceipt);
  const result = userChoiceToolUseBehavior({ context: { sessionId: sess.id, turn: 4, sourceUserSeq: 73 } }, [
    { type: 'function_output', tool: { name: 'ask_user_question' }, output: trackerOutput },
    // Exact duplicate: one public question, never a repeated numbered item.
    { type: 'function_output', tool: { name: 'ask_user_question' }, output: trackerOutput },
    { type: 'function_output', tool: { name: 'ask_user_question' }, output: crewOutput },
  ]);
  assert.equal(result.isFinalOutput, true);
  const events = listEvents(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(events.length, 1);
  const question = String(events[0].data.question);
  assert.ok(question.indexOf('Where does the Zephyr deal tracker live?') < question.indexOf('Who is the crew'));
  assert.equal(question.match(/Where does the Zephyr deal tracker live\?/g)?.length, 1, 'exact duplicate was not rendered twice');
  assert.match(question, /1\. Where does the Zephyr deal tracker live\?[\s\S]*- Spreadsheet/);
  assert.match(question, /2\. Who is the crew[\s\S]*- Slack or Discord/);
  assert.equal(events[0].data.options, null, 'per-question choices stay inline instead of flattening ambiguously');
  assert.equal(events[0].data.bundled, true);
  assert.equal(events[0].data.purpose, 'clarification', 'homogeneous bundle projects its shared purpose');
  assert.equal(events[0].data.sourceUserSeq, 73);
  assert.equal((events[0].data.questions as unknown[]).length, 2);
  assert.match(String(result.finalOutput), /^\[clementine:awaiting-user-input:final\]\n[\s\S]*Zephyr[\s\S]*crew/);

  // Retrying arbitration for the same provider turn is idempotent.
  userChoiceToolUseBehavior({ context: { sessionId: sess.id, turn: 4 } }, [
    { type: 'function_output', tool: { name: 'ask_user_question' }, output: trackerOutput },
    { type: 'function_output', tool: { name: 'ask_user_question' }, output: crewOutput },
  ]);
  assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 1);
});

test('typed-plus-null ask_user_question bundle records mixed purpose and exact source provenance', async () => {
  resetEventLog();
  saveProactivityPolicy({ autoApproveScope: 'balanced' });
  const sess = createSession({ kind: 'chat' });
  const t = buildAskUserQuestionTool();
  const clarification = decodedToolOutput(await invokeFunctionTool(
    t,
    {
      question: 'Which environment contains the source data?',
      options: ['Staging', 'Production'],
      purpose: 'clarification',
    },
    { sessionId: sess.id, turn: 5, sourceUserSeq: 88 },
  ));
  const untyped = decodedToolOutput(await invokeFunctionTool(
    t,
    {
      question: 'What should the report title be?',
      options: null,
      purpose: null,
    },
    { sessionId: sess.id, turn: 5, sourceUserSeq: 88 },
  ));

  userChoiceToolUseBehavior({ context: { sessionId: sess.id, turn: 5, sourceUserSeq: 88 } }, [
    { type: 'function_output', tool: { name: 'ask_user_question' }, output: clarification },
    { type: 'function_output', tool: { name: 'ask_user_question' }, output: untyped },
  ]);

  const [event] = listEvents(sess.id, { types: ['awaiting_user_input'] });
  assert.ok(event);
  assert.equal(event.data.bundled, true);
  assert.equal(event.data.purpose, 'mixed');
  assert.equal(event.data.sourceUserSeq, 88);
  assert.deepEqual(
    (event.data.questions as Array<{ purpose?: unknown }>).map((question) => question.purpose),
    ['clarification', null],
  );
});

test('all-null ask_user_question bundle preserves null top-level purpose', async () => {
  resetEventLog();
  saveProactivityPolicy({ autoApproveScope: 'balanced' });
  const sess = createSession({ kind: 'chat' });
  const t = buildAskUserQuestionTool();
  const first = decodedToolOutput(await invokeFunctionTool(
    t,
    { question: 'Which workspace?', options: null, purpose: null },
    { sessionId: sess.id, turn: 6, sourceUserSeq: 89 },
  ));
  const second = decodedToolOutput(await invokeFunctionTool(
    t,
    { question: 'Which account?', options: null, purpose: null },
    { sessionId: sess.id, turn: 6, sourceUserSeq: 89 },
  ));

  userChoiceToolUseBehavior({ context: { sessionId: sess.id, turn: 6, sourceUserSeq: 89 } }, [
    { type: 'function_output', tool: { name: 'ask_user_question' }, output: first },
    { type: 'function_output', tool: { name: 'ask_user_question' }, output: second },
  ]);

  const [event] = listEvents(sess.id, { types: ['awaiting_user_input'] });
  assert.ok(event);
  assert.equal(event.data.bundled, true);
  assert.equal(event.data.purpose, null);
  assert.equal(event.data.sourceUserSeq, 89);
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
    const arbitration = userChoiceToolUseBehavior({ context: { sessionId: sess.id, turn: 1 } }, [{
      type: 'function_output',
      tool: { name: 'ask_user_question' },
      output: result,
    }]);
    assert.equal(arbitration.isFinalOutput, false, 'YOLO auto-resolution remains non-halting at arbitration');
    assert.equal(listEvents(sess.id, { types: ['awaiting_user_input'] }).length, 0, 'approval purpose must not halt');
    const notes = listEvents(sess.id, { types: ['autonomy_note'] });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].data.classifier, 'typed', 'declared purpose drives the typed path');
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
  }
});

test('parallel YOLO approval plus genuine clarification pauses only on the clarification', async () => {
  resetEventLog();
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const sess = createSession({ kind: 'chat' });
    const t = buildAskUserQuestionTool();
    const approval = await invokeFunctionTool(
      t,
      { question: 'Should I send the update once ready?', options: ['Yes', 'No'], purpose: 'approval' },
      { sessionId: sess.id, turn: 2 },
    );
    const clarification = await invokeFunctionTool(
      t,
      { question: 'Which team owns the destination channel?', options: ['Sales', 'Support'], purpose: 'clarification' },
      { sessionId: sess.id, turn: 2 },
    );
    const result = userChoiceToolUseBehavior({ context: { sessionId: sess.id, turn: 2 } }, [
      { type: 'function_output', tool: { name: 'ask_user_question' }, output: approval },
      { type: 'function_output', tool: { name: 'ask_user_question' }, output: decodedToolOutput(clarification) },
    ]);
    assert.equal(result.isFinalOutput, true);
    const asks = listEvents(sess.id, { types: ['awaiting_user_input'] });
    assert.equal(asks.length, 1);
    assert.equal(asks[0].data.question, 'Which team owns the destination channel?');
    assert.deepEqual(asks[0].data.options, ['Sales', 'Support']);
    assert.equal(listEvents(sess.id, { types: ['autonomy_note'] }).length, 1);
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
    const { receipt, terminal } = await invokeAskWithArbitration(
      t,
      { question: 'Should I send to the staging list or the prod list?', options: ['staging', 'prod'], purpose: 'clarification' },
      { sessionId: sess.id, turn: 1 },
    );
    assert.doesNotMatch(receipt, /Question posted/);
    assert.equal(terminal.isFinalOutput, true);
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
    const { receipt, terminal } = await invokeAskWithArbitration(
      t,
      { question: 'Which Salesforce environment should I read from, staging or prod?', options: ['staging', 'prod'], purpose: null },
      { sessionId: sess.id, turn: 1 },
    );
    assert.doesNotMatch(receipt, /Question posted/);
    assert.equal(terminal.isFinalOutput, true);
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
  await invokeAskWithArbitration(
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
    await invokeAskWithArbitration(
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
  assert.match(result, /No session was available to post it/);
  assert.doesNotMatch(result, /Question posted/);
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

test('typed decline keeps transcript context but does not reopen the parent Outlook scope', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', channel: 'discord' });
  seedUserInput(sess.id, 1, 'send the client email through Outlook');
  seedUserInput(sess.id, 2, 'No.');
  const common = {
    packetId: 'outlook-decline',
    parentSourceUserSeq: 1,
    consumingSourceUserSeq: 2,
    parentInput: 'send the client email through Outlook',
    question: 'Should I send it?',
    options: ['Yes', 'No'],
    retrievalQuery: ['send the client email through Outlook', 'Should I send it?', 'No.'].join('\n'),
    capabilities: [],
  };

  const declined = await buildOrchestratorAgent({
    userInput: 'No.',
    sessionId: sess.id,
    allowToolJit: true,
    taskContinuation: {
      ...common,
      answer: 'No.',
      disposition: 'declined',
    },
    taskContinuationResolved: true,
  });
  const declinedScope = boundAgentMcpToolScope(declined).scope;
  assert.deepEqual(declinedScope?.allowedServerSlugs ?? [], []);
  assert.equal(declinedScope?.maxTools ?? 0, 0);
  const declinedPolicies = listEvents(sess.id, { types: ['tool_policy_resolved'] });
  assert.ok(declinedPolicies.length > 0, 'decline records its explicit local tool boundary');
  assert.ok(
    declinedPolicies.every((event) => event.data.outputCount === 0),
    'decline advertises zero local tool schemas',
  );
  assert.ok(
    declinedPolicies.every((event) =>
      event.data.shortCircuitReason === 'declined_continuation'
      && event.data.semanticAcquisitionSkipped === true
      && event.data.schemaWarmSkipped === true
      && event.data.advertisedSchemaCount === 0
      && event.data.catalogCount === 0),
    'decline records positive proof that acquisition and schema work were bypassed',
  );
  assert.equal(
    listEvents(sess.id, { types: ['tool_search_scope'] }).length,
    0,
    'decline bypasses schema-on-demand catalog construction',
  );
  assert.equal(
    listEvents(sess.id, { types: ['tool_jit_scope'] }).length,
    0,
    'decline bypasses semantic JIT tool ranking',
  );

  const affirmed = await buildOrchestratorAgent({
    userInput: 'Yes.',
    sessionId: sess.id,
    allowToolJit: true,
    taskContinuation: {
      ...common,
      consumingSourceUserSeq: 3,
      answer: 'Yes.',
      disposition: 'affirmed',
      retrievalQuery: ['send the client email through Outlook', 'Should I send it?', 'Yes.'].join('\n'),
    },
    taskContinuationResolved: true,
  });
  const affirmedScope = boundAgentMcpToolScope(affirmed).scope;
  assert.ok((affirmedScope?.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)));
  assert.ok((affirmedScope?.maxTools ?? 0) > 0);
});

test('compound decline keeps the full conversational turn while scoping tools to only the independent new task', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', channel: 'discord' });
  const fullMessage = 'No—leave that Outlook email alone. Instead, what is 15 × 9?';
  const activeTaskInput = 'what is 15 × 9?';
  seedUserInput(sess.id, 1, 'send the client email through Outlook');
  seedUserInput(sess.id, 2, fullMessage);

  const agent = await buildOrchestratorAgent({
    userInput: fullMessage,
    sessionId: sess.id,
    allowToolJit: true,
    taskContinuation: {
      packetId: 'outlook-compound-decline',
      parentSourceUserSeq: 1,
      consumingSourceUserSeq: 2,
      parentInput: 'send the client email through Outlook',
      question: 'Should I send it?',
      options: ['Yes', 'No'],
      answer: fullMessage,
      disposition: 'declined_with_new_task',
      activeTaskInput,
      retrievalQuery: activeTaskInput,
      capabilities: [],
    },
    taskContinuationResolved: true,
  });

  const scope = boundAgentMcpToolScope(agent).scope;
  assert.deepEqual(scope?.allowedServerSlugs ?? [], []);
  assert.equal(
    (scope?.reason ?? '').toLowerCase().includes('outlook'),
    false,
    'the declined parent must not leak into fresh-task capability scope',
  );
  assert.ok(
    listEvents(sess.id, { types: ['tool_policy_resolved'] }).every((event) =>
      !JSON.stringify(event.data).toLowerCase().includes('outlook')),
    'private tool-policy evidence is derived from the arithmetic clause, not the visible parent decline',
  );
});

test('direct_reply accepted route skips factory, MCP, and capability hunt', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', channel: 'discord' });
  const agent = await buildOrchestratorAgent({
    userInput: "what's 2x2",
    sessionId: sess.id,
    acceptedRoute: 'direct_reply',
    allowToolJit: true,
  });
  const scope = boundAgentMcpToolScope(agent).scope;
  assert.deepEqual(scope?.allowedServerSlugs ?? [], []);
  assert.equal(scope?.maxTools ?? 0, 0);
  assert.match(scope?.reason ?? '', /direct_reply/);
  const policies = listEvents(sess.id, { types: ['tool_policy_resolved'] });
  assert.ok(policies.length > 0, 'direct_reply records its explicit local tool boundary');
  assert.ok(
    policies.every((event) =>
      event.data.shortCircuitReason === 'direct_reply'
      && event.data.semanticAcquisitionSkipped === true
      && event.data.schemaWarmSkipped === true
      && event.data.advertisedSchemaCount === 0
      && event.data.catalogCount === 0),
    'direct_reply records positive proof that acquisition and schema work were bypassed',
  );
  assert.equal(listEvents(sess.id, { types: ['tool_search_scope'] }).length, 0);
  assert.equal(listEvents(sess.id, { types: ['tool_jit_scope'] }).length, 0);
});

test('host-proven plain conversation ignores action-shaped scope and fanout residue but preserves telemetry', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', channel: 'discord' });
  seedUserInput(sess.id, 1, 'send Outlook emails to the 18 contacts');
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'assistant',
    type: 'conversation_step',
    data: {
      decision: {
        reply: 'I can send Outlook emails to all 18 contacts.',
        summary: 'Proposed an 18-contact email batch.',
      },
    },
  });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Thanks for explaining.' },
  });

  const agent = await buildOrchestratorAgent({
    userInput: 'Thanks for explaining.',
    sessionId: sess.id,
    sourceUserSeq: source.seq,
    acceptedRoute: 'direct_reply',
    allowToolJit: true,
    hostPlainConversation: true,
  });

  assert.deepEqual(agent.tools ?? [], [], 'the proof remains an exact zero-tool surface');
  const scope = boundAgentMcpToolScope(agent).scope;
  assert.equal(scope?.authority, 'none');
  assert.deepEqual(scope?.allowedServerSlugs ?? [], []);
  assert.equal(scope?.maxTools, 0);
  assert.doesNotMatch(
    await renderAgentInstructions(agent),
    /THIS TURN IS BATCH-SHAPED/,
    'stale batch residue cannot add an action-only fanout directive',
  );
  assert.equal(listEvents(sess.id, { types: ['mcp_tool_scope'] }).length, 1);
  assert.equal(listEvents(sess.id, { types: ['rubric_variant'] }).length, 1);
  assert.equal(listEvents(sess.id, { types: ['tool_policy_resolved'] }).length, 1);
});

test('near-action and affirmative follow-up without the host plain proof retain semantic scope and fanout', async () => {
  resetEventLog();
  const direct = createSession({ kind: 'chat', channel: 'discord' });
  const nearAction = await buildOrchestratorAgent({
    userInput: 'Email the limerick to Alex through Outlook.',
    sessionId: direct.id,
    allowToolJit: true,
  });
  assert.ok((nearAction.tools?.length ?? 0) > 0, 'near-action keeps its executable discovery surface');
  assert.ok(
    (boundAgentMcpToolScope(nearAction).scope?.allowedServerSlugs ?? [])
      .some((slug) => /outlook|microsoft/.test(slug)),
    'near-action keeps connector scope',
  );

  const followup = createSession({ kind: 'chat', channel: 'discord' });
  seedUserInput(followup.id, 1, 'send Outlook emails to the 18 contacts');
  appendEvent({
    sessionId: followup.id,
    turn: 1,
    role: 'assistant',
    type: 'conversation_step',
    data: {
      decision: {
        reply: 'Should I send Outlook emails to all 18 contacts?',
        summary: 'Asked to confirm an 18-contact email batch.',
      },
    },
  });
  seedUserInput(followup.id, 2, 'Yes.');
  const affirmed = await buildOrchestratorAgent({
    userInput: 'Yes.',
    sessionId: followup.id,
    allowToolJit: true,
    taskContinuation: {
      packetId: 'outlook-batch-affirmation',
      parentSourceUserSeq: 1,
      consumingSourceUserSeq: 2,
      parentInput: 'send Outlook emails to the 18 contacts',
      question: 'Should I send Outlook emails to all 18 contacts?',
      options: ['Yes', 'No'],
      answer: 'Yes.',
      disposition: 'affirmed',
      retrievalQuery: 'send Outlook emails to the 18 contacts\nYes.',
      capabilities: [],
    },
    taskContinuationResolved: true,
  });
  const affirmedScope = boundAgentMcpToolScope(affirmed).scope;
  assert.ok(
    (affirmedScope?.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)),
    'the scope-only prior-input read remains active without the proof',
  );
  assert.match(
    await renderAgentInstructions(affirmed),
    /THIS TURN IS BATCH-SHAPED:.*~18/i,
    'the fanout conversation read remains active without the proof',
  );
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
  const {
    ClaudeSdkProviderOverloadError,
    ClaudeSdkAuthExpiredError,
    ClaudeSdkCapacityExhaustedError,
  } = await import('../runtime/harness/claude-agent-sdk.js');
  const { AgentRuntimeCancelledError } = await import('../runtime/provider.js');

  // Typed committed-aware errors trust their flag: eligible only pre-commit
  // (a committed overload is salvaged by the SDK lane; a committed anything
  // must never be blindly re-driven — double-act).
  assert.equal(isCommitSafeWorkerFallover(new ClaudeSdkProviderOverloadError('529 overloaded', false)), true, 'uncommitted overload → fall over');
  assert.equal(isCommitSafeWorkerFallover(new ClaudeSdkProviderOverloadError('529 overloaded', true)), false, 'committed overload → never re-run (double-act)');
  assert.equal(isCommitSafeWorkerFallover(new ClaudeSdkAuthExpiredError('401 token expired', false)), true, 'uncommitted auth-expiry → fall over to a connected brain');
  assert.equal(isCommitSafeWorkerFallover(new ClaudeSdkAuthExpiredError('401 token expired', true)), false, 'committed auth-expiry → never re-run');
  assert.equal(isCommitSafeWorkerFallover(new ClaudeSdkCapacityExhaustedError('out of extra usage', false)), true, 'uncommitted scoped capacity → fall over');
  assert.equal(isCommitSafeWorkerFallover(new ClaudeSdkCapacityExhaustedError('out of extra usage', true)), false, 'committed scoped capacity → never re-run');
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
