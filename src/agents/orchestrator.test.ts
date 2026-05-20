/**
 * Run: npx tsx --test src/agents/orchestrator.test.ts
 *
 * Static contracts the Orchestrator must keep — no Runner invocation
 * (that needs OpenAI credentials). We verify the structural promises:
 *   - Orchestrator constructs with the right name and output schema
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

const { resetEventLog, createSession, listEvents } = await import('../runtime/harness/eventlog.js');
const {
  buildOrchestratorAgent,
  OrchestratorDecisionSchema,
  buildRequestApprovalTool,
  buildAskUserQuestionTool,
} = await import('./orchestrator.js');

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

test('Orchestrator is named "Orchestrator" with structured outputType', async () => {
  const agent = await buildOrchestratorAgent();
  assert.equal(agent.name, 'Orchestrator');
  // The outputType wires through; we recognize the schema reference.
  assert.equal(agent.outputType, OrchestratorDecisionSchema);
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

test('Orchestrator tools are deliberation + read-only discovery/memory tools', async () => {
  // composio_search_tools is read-only — it queries Composio for
  // matching action slugs but doesn't mutate anything. Including it
  // on the Orchestrator lets it own the "find the right tool"
  // decision in code instead of via a Researcher detour. The
  // execute counterpart (composio_execute_tool) is NOT here — it
  // stays on the Executor side of the handoff so the
  // zero-action-tools discipline holds for the Orchestrator.
  const agent = await buildOrchestratorAgent();
  const toolNames = (agent.tools ?? []).map((t) => (t as { name?: string }).name).sort();
  assert.deepEqual(
    toolNames,
    [
      'ask_user_question',
      'composio_search_tools',
      'desktop_status',
      'draft_plan',
      'local_cli_list',
      'local_cli_probe',
      'request_approval',
      'skill_list',
      'skill_read',
      'tool_choice_invalidate',
      'tool_choice_recall',
      'tool_choice_remember',
    ].sort(),
  );
  assert.equal(toolNames.includes('composio_execute_tool'), false);
  assert.equal(toolNames.includes('run_shell_command'), false);
  assert.equal(toolNames.includes('write_file'), false);
});

test('Orchestrator hands off to the five sub-agents by name', async () => {
  const agent = await buildOrchestratorAgent();
  const handoffNames = (agent.handoffs ?? []).map((h) => {
    const obj = h as { name?: string; agent?: { name?: string } };
    return obj.name ?? obj.agent?.name ?? '';
  });
  assert.ok(handoffNames.includes('Researcher'), `missing Researcher in ${handoffNames}`);
  assert.ok(handoffNames.includes('Writer'), `missing Writer in ${handoffNames}`);
  assert.ok(handoffNames.includes('Reviewer'), `missing Reviewer in ${handoffNames}`);
  assert.ok(handoffNames.includes('Executor'), `missing Executor in ${handoffNames}`);
  assert.ok(handoffNames.includes('Deployer'), `missing Deployer in ${handoffNames}`);
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
    { subject: 'deploy to prod', reason: 'staging green', destructive: true },
    { sessionId: sess.id, turn: 3 },
  );
  assert.match(result, /Approved: deploy to prod/);
  // No approval_requested event from execute — the loop owns that.
  const events = listEvents(sess.id, { types: ['approval_requested'] });
  assert.equal(events.length, 0);
});

test('ask_user_question emits awaiting_user_input with options', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const t = buildAskUserQuestionTool();
  const result = await invokeFunctionTool(
    t,
    { question: 'which environment?', options: ['staging', 'prod'] },
    { sessionId: sess.id, turn: 1 },
  );
  assert.match(result, /Question posted/);

  const events = listEvents(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.question, 'which environment?');
  assert.deepEqual(events[0].data.options, ['staging', 'prod']);
});

test('deliberation tools no-op silently when no sessionId is on the context', async () => {
  // Tools must not throw when called outside the harness (e.g. via
  // the SDK's playground or a unit test).
  resetEventLog();
  const t = buildAskUserQuestionTool();
  const result = await invokeFunctionTool(
    t,
    { question: 'is anyone listening?', options: null },
    {},
  );
  assert.match(result, /Question posted/);
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
