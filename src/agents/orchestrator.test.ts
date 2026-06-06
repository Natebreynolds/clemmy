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
const { getPlanScope } = await import('./plan-scope.js');
const { saveProactivityPolicy } = await import('./proactivity-policy.js');
const {
  buildOrchestratorAgent,
  OrchestratorDecisionSchema,
  buildRequestApprovalTool,
  buildAskUserQuestionTool,
  recentPriorUserInputsForScope,
} = await import('./orchestrator.js');
const { resolveMcpToolScopeWithContinuity } = await import('../runtime/mcp-tool-scope.js');

test.after(() => {
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

test('Orchestrator builds the Clem single-agent with structured outputType', async () => {
  const agent = await buildOrchestratorAgent();
  assert.equal(agent.name, 'Clem');
  assert.ok(agent.outputType, 'expected structured outputType to be set');
  const parsed = (agent.outputType as z.ZodTypeAny).safeParse({
    summary: 'verified the structured output schema',
    reply: null,
    done: false,
    nextAction: 'awaiting_user_input',
    reason: null,
  });
  assert.equal(parsed.success, true);
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
    // Memory (read + write)
    'memory_recall', 'memory_search', 'memory_read', 'memory_remember', 'memory_list_facts',
    // Composio (discover + execute)
    'composio_search_tools', 'composio_execute_tool', 'composio_status',
    // Shell + filesystem
    'run_shell_command', 'write_file', 'read_file', 'list_files',
    // Workspace
    'workspace_config', 'workspace_info', 'workspace_list', 'workspace_roots',
    // Tasks + goals + executions
    'task_list', 'task_add', 'task_update',
    'goal_get', 'goal_update',
    'execution_list', 'execution_get', 'execution_update_step', 'execution_complete', 'execution_mark_blocked',
    // CLI discovery + probes
    'local_cli_list', 'local_cli_probe',
    // Tool-choice memoization
    'tool_choice_recall', 'tool_choice_remember', 'tool_choice_invalidate',
    // User profile (read + write)
    'user_profile_read', 'user_profile_update',
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
  assert.deepEqual(runWorker.parameters?.required, [
    'objective',
    'item',
    'resolvedTools',
    'context',
    'instructions',
    'expectedOutput',
  ]);
  assert.equal(runWorker.parameters?.additionalProperties, false);
  assert.ok(runWorker.parameters?.properties?.resolvedTools);
  assert.equal(Object.hasOwn(runWorker.parameters?.properties ?? {}, 'input'), false);
});

test('Orchestrator has NO handoffs in Phase 3 (single-agent architecture)', async () => {
  const agent = await buildOrchestratorAgent();
  const handoffs = agent.handoffs ?? [];
  assert.equal(handoffs.length, 0, `expected no handoffs, got ${handoffs.length}`);
});

test('request_approval triggers the SDK interrupt for external/destructive actions', async () => {
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
  // The exact production case from sess-mpbpih0u — must NOT pause.
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
    },
    { sessionId: sess.id, turn: 1 },
  );
  assert.match(result, /Auto-approved \(local save/);
  // No approval_requested event was emitted (the loop is what emits it, and
  // for auto-resolved calls the SDK never triggers the interrupt).
  const events = listEvents(sess.id, { types: ['approval_requested'] });
  assert.equal(events.length, 0);
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
    { subject: 'deploy to prod', reason: 'staging green', destructive: true, preview: null },
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
            value: 'Scorpion has been the best choice for us.',
            secondary: 'To: Pat Dunphy <pdunphy@example.com>',
          },
        ],
      },
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
