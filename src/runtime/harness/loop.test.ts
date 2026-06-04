/**
 * Run: npx tsx --test src/runtime/harness/loop.test.ts
 *
 * Contracts the harness loop must keep:
 *   - completed run snapshots history + lastResponseId on the session
 *     and emits run_completed
 *   - kill switch set before the call short-circuits and emits
 *     kill_requested + cancelled status
 *   - ToolCallsLimitExceeded raised by the bracket bubbles up as
 *     a guardrail_tripped event + limit_exceeded status
 *   - interruption (approval pause) saves serialized RunState to the
 *     session and returns awaiting_approval
 *   - generic run error emits run_failed and marks the session failed
 *   - turn number increments across calls
 *   - previousResponseId is passed back into opts on the next turn
 *
 * No real Runner is constructed for these tests; we inject makeRunner
 * (returns a Node EventEmitter stub) and runRunner (synthesizes a
 * RunOutcome). That keeps the loop test fast and offline.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-harness-loop-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
mkdirSync(path.join(TMP_HOME, 'vault', '02-Projects'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'vault', '02-Projects', 'salesforce-prospecting.md'),
  [
    '# Salesforce prospecting',
    '',
    'User has durable Salesforce prospecting context: prioritize stale untouched accounts, use Salesforce CLI data first, enrich with SEO signals, and draft careful outbound sequences only after reviewing the source account facts.',
  ].join('\n'),
  'utf-8',
);

// v0.5.19 F4 — the new default behavior on stall-retry exhaustion is
// to convert into a synthetic `ask_user_question` (status flips to
// 'awaiting_user_input'). The existing tests in this file exercise
// the LEGACY terminate-on-stall path (`sub_agent_stalled` reason,
// status='completed') which is still supported via the revert flag.
// Set the flag here so the legacy assertions remain valid AND set
// MAX_STALL_RETRIES=1 (the pre-v0.5.19 default) so the retry-count
// tests stay accurate. End-to-end coverage of the NEW default lives
// in scripts/verify-long-running.mjs → stall-converts-to-question.
process.env.HARNESS_STALL_ASK_USER = 'off';
process.env.HARNESS_MAX_STALL_RETRIES = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent, RunContext, RunState, type AgentInputItem, type Runner } from '@openai/agents';

const { resetEventLog, requestKill, listEvents, createSession, appendEvent } = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runTurn, runConversation, resumePendingApproval, isCodexAuthRevoked } = await import('./loop.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;
const { ToolCallsLimitExceeded } = await import('./brackets.js');
const { listEvents: listEventsForConv } = await import('./eventlog.js');
const approvalRegistry = await import('./approval-registry.js');
const { getPlanScope, isAutoApprovedByScope } = await import('../../agents/plan-scope.js');

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// Returns a Node EventEmitter cast to Runner. The loop only uses its
// on/off shape, so this stands in for a real Runner.
function makeRunnerStub(): Runner {
  const ee = new EventEmitter();
  return ee as unknown as Runner;
}

// A minimal Agent stub. The loop never inspects its internals; only
// the runRunner sees the agent.
function makeAgentStub(): import('@openai/agents').Agent<any, any> {
  return {} as import('@openai/agents').Agent<any, any>;
}

function makeApprovalRunState(agent: import('@openai/agents').Agent<any, any>, toolName: string): string {
  return makeApprovalRunStateWithInterruptions(agent, [
    { toolName, argumentsJson: '{}', callId: `${toolName}_call` },
  ]);
}

function makeApprovalRunStateWithInterruptions(
  agent: import('@openai/agents').Agent<any, any>,
  interruptions: Array<{ toolName: string; argumentsJson?: string; callId?: string }>,
): string {
  const state = new RunState(new RunContext({}), 'approve this', agent, null);
  const json = state.toJSON() as Record<string, unknown>;
  json.currentStep = {
    type: 'next_step_interruption',
    data: {
      interruptions: interruptions.map((interruption, index) => ({
        rawItem: {
          type: 'function_call',
          name: interruption.toolName,
          callId: interruption.callId ?? `${interruption.toolName}_call_${index}`,
          arguments: interruption.argumentsJson ?? '{}',
        },
        toolName: interruption.toolName,
      })),
    },
  };
  return JSON.stringify(json);
}

test('completed chat run snapshots conversation, emits run_completed, leaves session active', async () => {
  // Chat sessions are inherently multi-turn — the user types again. The
  // loop emits run_completed + conversation_completed (the chat dock
  // watches for those to clear THINKING…), but the session row status
  // stays 'active' so the next user message can run a new turn under
  // the same session. Before this fix the row flipped to 'completed'
  // on every turn end, stranding the chat dock.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat', title: 'completed' });

  const runRunner: RunRunnerFn = async (_runner, _agent, items, _opts) => {
    return {
      history: [
        ...items,
        {
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'done' }],
        },
      ],
      lastResponseId: 'resp_1',
      finalOutput: { ok: true },
    };
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do the thing',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.turn, 1);
  assert.deepEqual(result.finalOutput, { ok: true });

  const completions = listEvents(sess.id, { types: ['run_completed'] });
  assert.equal(completions.length, 1);

  const reloaded = HarnessSession.load(sess.id);
  assert.ok(reloaded);
  assert.equal(reloaded!.previousResponseId(), 'resp_1');
  assert.equal(reloaded!.sessionRow.status, 'active', 'chat sessions stay active between turns');
  // user turn input was recorded
  const userInputs = listEvents(sess.id, { types: ['user_input_received'] });
  assert.equal(userInputs.length, 1);
  assert.equal(userInputs[0].data.text, 'do the thing');
});

test('runTurn persists latest native Codex compaction item for replay when flag is enabled', async () => {
  resetEventLog();
  const previousFlag = process.env.CLEMMY_CODEX_NATIVE_COMPACTION;
  process.env.CLEMMY_CODEX_NATIVE_COMPACTION = '1';
  try {
    const sess = HarnessSession.create({ kind: 'chat', title: 'native compaction' });
    const runRunner: RunRunnerFn = async (_runner, _agent, items, _opts) => {
      const assistantMessage = {
        id: 'msg_after_compaction',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'I will continue from the compacted state.' }],
      } as unknown as AgentInputItem;
      return {
        history: [
          ...items,
          {
            id: 'fc_1',
            type: 'function_call',
            callId: 'call_1',
            name: 'expensive_tool',
            arguments: '{}',
            status: 'completed',
          } as unknown as AgentInputItem,
          {
            type: 'function_call_result',
            callId: 'call_1',
            output: { type: 'text', text: 'large tool result' },
            status: 'completed',
          } as unknown as AgentInputItem,
          assistantMessage,
        ],
        lastResponseId: 'resp_compacted',
        finalOutput: { done: false, nextAction: 'completed', summary: 'compacted' },
        rawResponses: [
          { output: [{ type: 'compaction', id: 'cmp_old', encrypted_content: 'old-state' }] },
          { output: [{ type: 'compaction', id: 'cmp_new', encrypted_content: 'new-state' }] },
        ],
      };
    };

    const result = await runTurn({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'continue the long run',
      makeRunner: makeRunnerStub,
      runRunner,
    });

    assert.equal(result.status, 'completed');
    const replay = HarnessSession.load(sess.id)?.toInputItems() ?? [];
    assert.equal(replay.length, 2);
    assert.equal((replay[0] as { type?: string }).type, 'compaction');
    assert.equal((replay[0] as { id?: string }).id, 'cmp_new');
    assert.equal((replay[0] as { encrypted_content?: string }).encrypted_content, 'new-state');
    assert.equal((replay[1] as { role?: string }).role, 'assistant');

    const events = listEvents(sess.id, { types: ['native_compaction_applied'] });
    assert.equal(events.length, 1);
    assert.equal(events[0].data.previousItems, 4);
    assert.equal(events[0].data.nextItems, 2);
    assert.equal(events[0].data.compactionItemsSeen, 2);
    assert.equal(events[0].data.latestCompactionId, 'cmp_new');
  } finally {
    if (previousFlag == null) {
      delete process.env.CLEMMY_CODEX_NATIVE_COMPACTION;
    } else {
      process.env.CLEMMY_CODEX_NATIVE_COMPACTION = previousFlag;
    }
  }
});

test('completed workflow run flips session status to completed (one-shot)', async () => {
  // Workflow / execution / agent sessions represent a single step or
  // task. Marking the row 'completed' here is correct so the dashboard's
  // Live Runs filter doesn't keep showing them.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'workflow', title: 'workflow-step' });

  const runRunner: RunRunnerFn = async (_runner, _agent, items, _opts) => ({
    history: [
      ...items,
      {
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'done' }],
      },
    ],
    lastResponseId: 'resp_w',
    finalOutput: { ok: true },
  });

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do the workflow step',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const reloaded = HarnessSession.load(sess.id);
  assert.ok(reloaded);
  assert.equal(reloaded!.sessionRow.status, 'completed', 'workflow sessions are one-shot');
});

// P0-4: even for one-shot workflow sessions, the row must NOT flip to
// 'completed' while an approval is still pending. Otherwise the reaper
// false-reaps the paused approval and the user-action surface
// disappears mid-flight. The shipped guard at loop.ts:1080 + :1394 is
// `kind !== 'chat' && !approvalRegistry.hasPending(sessionId)`.
test('workflow run with a pending approval stays active (P0-4 guard)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'workflow', title: 'paused-workflow' });

  // Register a pending approval BEFORE the turn ends, mimicking a
  // tool call that handed off to the approval bus mid-turn.
  approvalRegistry.register({
    sessionId: sess.id,
    subject: 'mock approval gate',
    tool: 'request_approval',
  });

  const runRunner: RunRunnerFn = async (_runner, _agent, items) => ({
    history: [
      ...items,
      { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done' }] },
    ],
    lastResponseId: 'resp_paused',
    finalOutput: { ok: true },
  });

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'kick off workflow',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const reloaded = HarnessSession.load(sess.id);
  assert.ok(reloaded);
  assert.equal(
    reloaded!.sessionRow.status,
    'active',
    'pending approval must keep workflow session active; do not mark completed mid-pause',
  );
});

test('previousResponseId is NOT passed to the SDK (codex requires full history each turn)', async () => {
  // Codex enforces `store: false`, so the server never persists
  // responses we could refer back to. Passing previousResponseId
  // to the SDK opt would flip it into delta-only mode
  // (ServerConversationTracker), and codex would 400 every
  // continuation call with "No tool call found for function call
  // output". Instead the harness inlines the full conversation
  // history into `items` every turn.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const seenOpts: Record<string, unknown>[] = [];

  const runRunner: RunRunnerFn = async (_r, _a, items, opts) => {
    seenOpts.push({ ...opts });
    return {
      history: [
        ...items,
        { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] },
      ],
      lastResponseId: `resp_${seenOpts.length}`,
      finalOutput: 'ok',
    };
  };

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'first',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  const after1 = HarnessSession.load(sess.id)!;
  const { updateSession } = await import('./eventlog.js');
  updateSession(after1.id, { status: 'active' });

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'second',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(seenOpts.length, 2);
  assert.equal(seenOpts[0].previousResponseId, undefined, 'first turn never sets prior');
  assert.equal(seenOpts[1].previousResponseId, undefined, 'second turn also never sets prior — full history is inlined into items instead');
});

test('runTurn injects a transient memory primer before the first model response', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let filteredInput: AgentInputItem[] = [];

  const runRunner: RunRunnerFn = async (_runner, _agent, items, opts) => {
    const filter = opts.callModelInputFilter as
      | ((args: { modelData: { input: AgentInputItem[]; instructions?: string } }) => { input: AgentInputItem[]; instructions?: string })
      | undefined;
    assert.equal(typeof filter, 'function', 'expected harness to pass callModelInputFilter');
    filteredInput = filter!({ modelData: { input: items, instructions: 'base instructions' } }).input;
    return {
      history: [
        ...items,
        { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] },
      ],
      lastResponseId: undefined,
      finalOutput: 'ok',
    };
  };

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'can you help me with some Salesforce prospecting',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const primer = filteredInput.find((item) =>
    (item as { role?: unknown }).role === 'system'
    && typeof (item as { content?: unknown }).content === 'string'
    && ((item as { content: string }).content.includes('[MEMORY PRIMER]')),
  ) as { content: string } | undefined;
  assert.ok(primer, 'expected memory primer to be appended to model input');
  assert.match(primer.content, /memory search ran/i);
  assert.match(primer.content, /Salesforce prospecting/i);
  assert.match(primer.content, /stale untouched accounts/i);

  const primerEvents = listEvents(sess.id, { types: ['turn_memory_primer'] });
  assert.equal(primerEvents.length, 1);
  assert.equal(primerEvents[0].data.injected, true);
  assert.ok((primerEvents[0].data.hitCount as number) > 0);
});

test('turn numbers monotonically increment across runs', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({
    history: items,
    lastResponseId: undefined,
    finalOutput: '',
  });

  const r1 = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'a',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  const { updateSession } = await import('./eventlog.js');
  updateSession(sess.id, { status: 'active' });
  const r2 = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'b',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  updateSession(sess.id, { status: 'active' });
  const r3 = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'c',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(r1.turn, 1);
  assert.equal(r2.turn, 2);
  assert.equal(r3.turn, 3);
});

test('kill switch set before the call short-circuits with kill_requested', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  requestKill(sess.id, 'test stop');

  const runRunner: RunRunnerFn = async () => {
    throw new Error('should not be called');
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do work',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'killed');
  const killEvents = listEvents(sess.id, { types: ['kill_requested'] });
  assert.equal(killEvents.length, 1);
  const reloaded = HarnessSession.load(sess.id);
  assert.equal(reloaded!.sessionRow.status, 'cancelled');
});

test('ToolCallsLimitExceeded thrown by run surfaces as guardrail_tripped', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });

  const runRunner: RunRunnerFn = async () => {
    throw new ToolCallsLimitExceeded(8);
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'busy loop',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'limit_exceeded');
  // Filter to the specific kind — v0.5.18 preflight gate now emits
  // an additional guardrail_tripped(kind:preflight_budget_check) per
  // turn for observability, so a length:1 assertion is too tight.
  const tripped = listEvents(sess.id, { types: ['guardrail_tripped'] })
    .filter((ev) => (ev.data as { kind?: unknown }).kind === 'tool_calls_limit');
  assert.equal(tripped.length, 1);
  assert.equal(tripped[0].data.kind, 'tool_calls_limit');
  assert.equal(tripped[0].data.limit, 8);
  const reloaded = HarnessSession.load(sess.id);
  assert.equal(reloaded!.sessionRow.status, 'failed');
});

test('interruption saves serialized RunState and returns awaiting_approval', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });

  const runRunner: RunRunnerFn = async () => ({
    history: [],
    lastResponseId: undefined,
    finalOutput: undefined,
    hasInterruptions: true,
    serializedState: '{"$schema":1,"items":[]}',
  });

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'deploy now',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_approval');
  const reloaded = HarnessSession.load(sess.id);
  assert.equal(reloaded!.loadInterruptState(), '{"$schema":1,"items":[]}');
  const paused = listEvents(sess.id, { types: ['run_paused'] });
  assert.equal(paused.length, 1);
});

test('interruption emits approval_requested per interrupted tool call with parsed args', async () => {
  // The SDK skips a tool's execute() when needsApproval=true, so the
  // loop — not the tool body — must record approval_requested. Drive
  // a fake interruption shaped like a real RunToolApprovalItem.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });

  const runRunner: RunRunnerFn = async () => ({
    history: [],
    lastResponseId: undefined,
    finalOutput: undefined,
    hasInterruptions: true,
    serializedState: '{"$schema":1,"items":[]}',
    interruptions: [
      {
        toolName: 'request_approval',
        rawArgs: '{"subject":"deploy to prod","destructive":true}',
        args: { subject: 'deploy to prod', destructive: true },
      },
    ],
  });

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'ship it',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const approvals = listEvents(sess.id, { types: ['approval_requested'] });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].data.tool, 'request_approval');
  assert.equal(approvals[0].data.subject, 'deploy to prod');
  assert.deepEqual(approvals[0].data.args, { subject: 'deploy to prod', destructive: true });
});

test('interruption registers Discord channel id for approval routing', async () => {
  resetEventLog();
  const sess = HarnessSession.create({
    kind: 'chat',
    channel: 'discord',
    metadata: { channelId: 'discord-channel-123' },
  });

  const runRunner: RunRunnerFn = async () => ({
    history: [],
    lastResponseId: undefined,
    finalOutput: undefined,
    hasInterruptions: true,
    serializedState: '{"$schema":1,"items":[]}',
    interruptions: [
      {
        toolName: 'request_approval',
        rawArgs: '{"subject":"send outreach"}',
        args: { subject: 'send outreach' },
      },
    ],
  });

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'send it',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const rows = approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'discord');
  assert.equal(rows[0].channelId, 'discord-channel-123');
});

test('resume resolves the approval rows present before the resumed run requests a new approval', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-approval' });
  sess.saveInterruptState(makeApprovalRunState(agent, 'old_tool'));
  const oldApproval = approvalRegistry.register({
    sessionId: sess.id,
    subject: 'old pending approval',
    tool: 'old_tool',
  });

  const runRunner: RunRunnerFn = async () => ({
    history: [],
    lastResponseId: undefined,
    finalOutput: undefined,
    hasInterruptions: true,
    serializedState: makeApprovalRunState(agent, 'new_tool'),
    interruptions: [
      {
        toolName: 'new_tool',
        rawArgs: '{"subject":"new pending approval"}',
        args: { subject: 'new pending approval' },
      },
    ],
  });

  const result = await resumePendingApproval({
    agent,
    sessionId: sess.id,
    decision: 'approve',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_approval');
  const allRows = approvalRegistry.listPending({ sessionId: sess.id, status: 'any' });
  const resolvedOld = allRows.find((row) => row.approvalId === oldApproval.approvalId);
  assert.equal(resolvedOld?.status, 'resolved');
  assert.equal(resolvedOld?.resolution, 'approved');
  assert.equal(resolvedOld?.resolver, 'unit-test');

  const pendingRows = approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' });
  assert.equal(pendingRows.length, 1);
  assert.equal(pendingRows[0].tool, 'new_tool');
  assert.equal(pendingRows[0].subject, 'new_tool: new pending approval');

  const approvalEvents = listEvents(sess.id, { types: ['approval_resolved', 'approval_requested'] });
  assert.deepEqual(approvalEvents.map((event) => event.type), [
    'approval_resolved',
    'approval_requested',
  ]);
});

test('resume opens a slug-scoped plan scope after approving a Composio external mutation batch', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeBatchApprovalTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-batch-approval' });
  const draftArgs = [
    { tool_slug: 'SALESFORCE_CREATE_TASK', arguments: JSON.stringify({ account_id: 'a', subject: 'A' }) },
    { tool_slug: 'SALESFORCE_CREATE_TASK', arguments: JSON.stringify({ account_id: 'b', subject: 'B' }) },
  ];
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, draftArgs.map((args, index) => ({
    toolName: 'composio_execute_tool',
    callId: `draft_call_${index}`,
    argumentsJson: JSON.stringify(args),
  }))));
  for (const [index, args] of draftArgs.entries()) {
    approvalRegistry.register({
      sessionId: sess.id,
      subject: `Create Outlook draft ${index + 1}`,
      tool: 'composio_execute_tool',
      args,
    });
  }

  const runRunner: RunRunnerFn = async () => ({
    history: [],
    lastResponseId: undefined,
    finalOutput: { ok: true },
  });

  const result = await resumePendingApproval({
    agent,
    sessionId: sess.id,
    decision: 'approve',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const scope = getPlanScope(sess.id);
  assert.deepEqual(scope?.allowedTools, ['composio_execute_tool']);
  assert.deepEqual(scope?.allowedComposioSlugs, ['SALESFORCE_CREATE_TASK']);
  assert.equal(
    isAutoApprovedByScope(sess.id, 'composio_execute_tool', { tool_slug: 'SALESFORCE_CREATE_TASK' }),
    true,
  );
  assert.equal(
    isAutoApprovedByScope(sess.id, 'composio_execute_tool', { tool_slug: 'OUTLOOK_SEND_EMAIL' }),
    false,
  );
});

test('resume opens an exact-tool scope after approving a direct external mutation batch', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeDirectExternalBatchTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-direct-external-batch' });
  const toolName = 'slack_post_message';
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [
    { toolName, callId: 'slack_call_1', argumentsJson: JSON.stringify({ channel: 'sales', text: 'A' }) },
    { toolName, callId: 'slack_call_2', argumentsJson: JSON.stringify({ channel: 'sales', text: 'B' }) },
  ]));
  for (let index = 0; index < 2; index++) {
    approvalRegistry.register({
      sessionId: sess.id,
      subject: `Post Slack message ${index + 1}`,
      tool: toolName,
      args: { channel: 'sales', text: String(index) },
    });
  }

  const runRunner: RunRunnerFn = async () => ({
    history: [],
    lastResponseId: undefined,
    finalOutput: { ok: true },
  });

  const result = await resumePendingApproval({
    agent,
    sessionId: sess.id,
    decision: 'approve',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const scope = getPlanScope(sess.id);
  assert.deepEqual(scope?.allowedTools, [toolName]);
  assert.equal(isAutoApprovedByScope(sess.id, toolName, { channel: 'sales', text: 'C' }), true);
  assert.equal(isAutoApprovedByScope(sess.id, 'run_shell_command', { command: 'echo nope' }), false);
});

test('resume does not open a scoped plan scope for non-external or single-call approvals', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeSingleApprovalTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-single-approval' });
  const args = { tool_slug: 'OUTLOOK_CREATE_DRAFT', arguments: JSON.stringify({ to: 'a@example.com', subject: 'A' }) };
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [{
    toolName: 'composio_execute_tool',
    callId: 'draft_call_1',
    argumentsJson: JSON.stringify(args),
  }]));
  approvalRegistry.register({
    sessionId: sess.id,
    subject: 'Create one Outlook draft',
    tool: 'composio_execute_tool',
    args,
  });

  const runRunner: RunRunnerFn = async () => ({
    history: [],
    lastResponseId: undefined,
    finalOutput: { ok: true },
  });

  const result = await resumePendingApproval({
    agent,
    sessionId: sess.id,
    decision: 'approve',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.equal(getPlanScope(sess.id), null);

  resetEventLog();
  const shellSess = HarnessSession.create({ kind: 'chat', title: 'resume-shell-batch' });
  shellSess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [
    { toolName: 'run_shell_command', callId: 'shell_call_1', argumentsJson: JSON.stringify({ command: 'touch a' }) },
    { toolName: 'run_shell_command', callId: 'shell_call_2', argumentsJson: JSON.stringify({ command: 'touch b' }) },
  ]));
  for (let index = 0; index < 2; index++) {
    approvalRegistry.register({
      sessionId: shellSess.id,
      subject: `Run shell command ${index + 1}`,
      tool: 'run_shell_command',
      args: { command: `touch ${index}` },
    });
  }

  const shellResult = await resumePendingApproval({
    agent,
    sessionId: shellSess.id,
    decision: 'approve',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(shellResult.status, 'completed');
  assert.equal(getPlanScope(shellSess.id), null);
});

test('interruption with no rich args falls back to the tool name as subject', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });

  const runRunner: RunRunnerFn = async () => ({
    history: [],
    lastResponseId: undefined,
    finalOutput: undefined,
    hasInterruptions: true,
    serializedState: '{}',
    interruptions: [{ toolName: 'cx_zendesk_create_ticket', rawArgs: 'not json', args: null }],
  });

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'open the ticket',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const approvals = listEvents(sess.id, { types: ['approval_requested'] });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].data.subject, 'cx_zendesk_create_ticket');
});

test('generic run error emits run_failed and marks the session failed', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });

  const runRunner: RunRunnerFn = async () => {
    throw new Error('network exploded');
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do thing',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /network exploded/);
  const failed = listEvents(sess.id, { types: ['run_failed'] });
  assert.equal(failed.length, 1);
  assert.match(String(failed[0].data.error), /network exploded/);
  const reloaded = HarnessSession.load(sess.id);
  assert.equal(reloaded!.sessionRow.status, 'failed');
});

test('throws when sessionId does not exist', async () => {
  resetEventLog();
  await assert.rejects(
    () =>
      runTurn({
        agent: makeAgentStub(),
        sessionId: 'sess-unknown',
        input: 'x',
        makeRunner: makeRunnerStub,
        runRunner: async () => ({ history: [], lastResponseId: undefined, finalOutput: '' }),
      }),
    /unknown session/,
  );
});

test('the agent input passed to runRunner includes user input + replay', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // pre-seed a prior turn snapshot
  sess.recordTurnResult({
    history: [{ role: 'user', content: 'prior turn' }],
    lastResponseId: 'resp_prior',
    turn: 0,
  });
  // re-activate so the loop will run
  const { updateSession } = await import('./eventlog.js');
  updateSession(sess.id, { status: 'active' });

  let captured: AgentInputItem[] = [];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    captured = items;
    return {
      history: items,
      lastResponseId: 'resp_next',
      finalOutput: '',
    };
  };

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'follow-up',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  // Two items: prior + new user input.
  assert.equal(captured.length, 2);
  const last = captured[captured.length - 1];
  assert.ok('role' in last && last.role === 'user');
  assert.equal('content' in last ? last.content : '', 'follow-up');
});

test('hooks are detached after the run (no listener leak)', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });

  const ee = new EventEmitter();
  const makeRunner = (): Runner => ee as unknown as Runner;
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({
    history: items,
    lastResponseId: undefined,
    finalOutput: '',
  });

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'hi',
    makeRunner,
    runRunner,
  });

  // After the run, no listeners should remain.
  for (const name of [
    'agent_start',
    'agent_end',
    'agent_handoff',
    'agent_tool_start',
    'agent_tool_end',
  ]) {
    assert.equal(ee.listenerCount(name), 0, `${name} listeners leaked`);
  }
});

// ---------- runConversation (auto-continuation) ----------
//
// runConversation wraps runTurn() in a loop that recurses when the
// Orchestrator's structured decision sets done=false. These tests
// drive the wrapper with scripted RunRunner outputs so each "turn"
// returns whatever decision shape the scenario needs, without
// touching the SDK or the model.

interface ScriptedTurn {
  finalOutput?: unknown;
  status?: 'completed' | 'interrupt' | 'throw';
  delayMs?: number;
}

function scriptedRunner(turns: ScriptedTurn[]): RunRunnerFn {
  let i = 0;
  return async () => {
    const turn = turns[i++] ?? turns[turns.length - 1];
    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    if (turn.status === 'throw') throw new Error('scripted_throw');
    if (turn.status === 'interrupt') {
      return {
        history: [],
        lastResponseId: undefined,
        finalOutput: undefined,
        hasInterruptions: true,
        serializedState: '{}',
      };
    }
    return {
      history: [],
      lastResponseId: undefined,
      finalOutput: turn.finalOutput,
    };
  };
}

test('runConversation: stops on first completed decision', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    {
      finalOutput: {
        summary: 'Answered the user directly',
        reply: 'The README should include setup, usage, and test commands.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'write a README',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 1);
  assert.equal(result.lastDecision?.done, true);

  const events = listEventsForConv(sess.id, { types: ['conversation_step', 'conversation_completed'] });
  assert.equal(events.filter((e) => e.type === 'conversation_step').length, 1);
  assert.equal(events.filter((e) => e.type === 'conversation_completed').length, 1);
});

test('runConversation: YOLO auto-resolved ask (autonomy_note + stray nextAction:awaiting_user_input) CONTINUES, never stuck', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let call = 0;
  const runRunner: RunRunnerFn = async () => {
    call += 1;
    if (call === 1) {
      // Simulate the ask_user_question tool auto-resolving under YOLO this turn:
      // it emits a non-halting autonomy_note (NOT awaiting_user_input)…
      appendEvent({
        sessionId: sess.id, turn: 1, role: 'Clem', type: 'autonomy_note',
        data: { autoResolved: 'yolo-standing-approval', question: 'send the rest?' },
      });
      // …but the model STILL sets nextAction:awaiting_user_input (the stray).
      return { history: [], lastResponseId: undefined, finalOutput: {
        summary: 'asked for sign-off (auto-resolved under YOLO)', reply: null,
        done: false, nextAction: 'awaiting_user_input', reason: null } };
    }
    return { history: [], lastResponseId: undefined, finalOutput: {
      summary: 'sent the remaining emails', reply: 'Sent the rest of the R&R emails.',
      done: true, nextAction: 'completed', reason: null } };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'send the rest',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed', 'must NOT strand on awaiting_user_input after a YOLO auto-proceed');
  assert.ok(call >= 2, 'the loop ran a second turn instead of halting');
  const reconciled = listEventsForConv(sess.id, { types: ['heartbeat'] })
    .some((e) => (e.data as { kind?: string } | undefined)?.kind === 'yolo_proceed_reconciled');
  assert.equal(reconciled, true, 'emits the yolo_proceed_reconciled telemetry');
});

test('runConversation: a GENUINE awaiting_user_input (no autonomy_note) still HALTS (no over-suppression)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async () => {
    // Genuine clarification: emits the halting event, NO autonomy_note.
    appendEvent({
      sessionId: sess.id, turn: 1, role: 'Clem', type: 'awaiting_user_input',
      data: { question: 'staging or prod?' },
    });
    return { history: [], lastResponseId: undefined, finalOutput: {
      summary: 'need to know which environment', reply: 'Staging or prod?',
      done: false, nextAction: 'awaiting_user_input', reason: null } };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'deploy it',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'genuine clarification must still halt');
});

test('objective judge: gates premature completion and continues (action intent)', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'Said what I would do', reply: 'Here is what I would do to build the report.', done: true, nextAction: 'completed', reason: null } },
    { finalOutput: { summary: 'Built the report', reply: 'Done — report saved to /tmp/report.md', done: true, nextAction: 'completed', reason: null } },
  ]);
  const judgeCalls: string[] = [];
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'build me a research report on solar adoption',
    judgeCompletion: true,
    judgeFn: async (_objective, response) => {
      judgeCalls.push(response);
      return judgeCalls.length === 1 ? { done: false, reason: 'no artifact produced yet' } : { done: true, reason: 'report saved' };
    },
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 2, 'judge forced a second step before completing');
  assert.equal(judgeCalls.length, 2);
});

test('objective judge: does NOT fire for a non-action (lookup) intent', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'answered', reply: 'Paris.', done: true, nextAction: 'completed', reason: null } },
  ]);
  let judgeInvoked = false;
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'what is the capital of France',
    judgeCompletion: true,
    judgeFn: async () => { judgeInvoked = true; return { done: false, reason: 'x' }; },
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 1);
  assert.equal(judgeInvoked, false, 'lookup intent must not invoke the objective judge');
});

test('objective judge: off by default (no judgeCompletion opt-in)', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'said what I would do', reply: 'Here is what I would do.', done: true, nextAction: 'completed', reason: null } },
  ]);
  let judgeInvoked = false;
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'build me a research report on solar adoption',
    judgeFn: async () => { judgeInvoked = true; return { done: false, reason: 'x' }; },
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(judgeInvoked, false, 'judge must not run unless judgeCompletion is opted in');
});

test('objective judge: continuation budget caps at 3, then accepts the model\'s done', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const premature = { finalOutput: { summary: 'promised again', reply: 'I will do it.', done: true, nextAction: 'completed', reason: null } };
  const runner = scriptedRunner([premature, premature, premature, premature, premature]);
  let judgeCalls = 0;
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'build me a research report on solar adoption',
    judgeCompletion: true,
    judgeFn: async () => { judgeCalls++; return { done: false, reason: 'still nothing produced' }; },
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(judgeCalls, 3, 'judge fires up to the continuation budget then stops gating');
  assert.equal(result.steps, 4, '3 judge-forced continuations + the accepted 4th completion');
});

test('runConversation: recurses through done=false steps until done=true', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    {
      finalOutput: {
        summary: 'handed off to Researcher for step 1',
        done: false,
        nextAction: 'awaiting_handoff_result',
        reason: null,
      },
    },
    {
      finalOutput: {
        summary: 'handed off to Executor for step 2',
        done: false,
        nextAction: 'awaiting_handoff_result',
        reason: null,
      },
    },
    {
      finalOutput: {
        summary: 'all three steps complete, sheet created',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'find 20 accounts, scrape, build a sheet',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 3);
  assert.equal(result.lastDecision?.done, true);

  const stepEvents = listEventsForConv(sess.id, { types: ['conversation_step'] });
  assert.equal(stepEvents.length, 3);
  assert.equal(stepEvents[0].data.step, 1);
  assert.equal(stepEvents[1].data.step, 2);
  assert.equal(stepEvents[2].data.step, 3);
});

test('runConversation: stops with awaiting_user_input when the orchestrator asks', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    {
      finalOutput: {
        summary: 'need clarification before I can proceed',
        done: false,
        nextAction: 'awaiting_user_input',
        reason: null,
      },
    },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do something ambiguous',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'awaiting_user_input');
  assert.equal(result.steps, 1);
});

test('runConversation: propagates SDK-level awaiting_approval status from runTurn', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ status: 'interrupt' }]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'deploy to prod',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'awaiting_approval');
  assert.equal(result.steps, 1);
});

test('runConversation: bails out at maxSteps when the orchestrator keeps recursing', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const recurseForever = scriptedRunner([
    {
      finalOutput: {
        summary: 'still working',
        done: false,
        nextAction: 'awaiting_handoff_result',
        reason: null,
      },
    },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do the thing',
    maxSteps: 3,
    makeRunner: makeRunnerStub,
    runRunner: recurseForever,
  });
  assert.equal(result.status, 'limit_exceeded');
  assert.equal(result.steps, 3);
  const limitEvents = listEventsForConv(sess.id, { types: ['conversation_limit_exceeded'] });
  assert.equal(limitEvents.length, 1);
  assert.equal(limitEvents[0].data.reason, 'max_steps');
});

test('runConversation: bails out at maxWallClockMs', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  // Each turn sleeps 20ms; with maxWallClockMs=10 the first turn
  // already exceeds the budget, so the loop should stop after one
  // step.
  const slow = scriptedRunner([
    {
      delayMs: 20,
      finalOutput: {
        summary: 'still working',
        done: false,
        nextAction: 'awaiting_handoff_result',
        reason: null,
      },
    },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do the thing',
    maxSteps: 99,
    maxWallClockMs: 10,
    makeRunner: makeRunnerStub,
    runRunner: slow,
  });
  assert.equal(result.status, 'limit_exceeded');
  const limitEvents = listEventsForConv(sess.id, { types: ['conversation_limit_exceeded'] });
  assert.equal(limitEvents[0].data.reason, 'wall_clock');
});

test('runConversation: abandoned nextAction marks the conversation completed', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    {
      finalOutput: {
        summary: 'the request is impossible without admin access',
        done: false,
        nextAction: 'abandoned',
        reason: 'no admin role',
      },
    },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do an impossible thing',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  const completedEvents = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.equal(completedEvents[0].data.reason, 'abandoned_by_orchestrator');
});

test('runConversation: a malformed finalOutput counts as completed without recursion', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ finalOutput: 'a plain string, not a Decision' }]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'whatever',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 1);
  const completedEvents = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.equal(completedEvents[0].data.reason, 'no_structured_output');
});

test('runConversation: sub-agent stall ("Continuing." with zero tool calls) is flagged as sub_agent_stalled', async () => {
  // Repro: Orchestrator hands off to Executor, Executor returns the
  // single word "Continuing." and makes zero tool calls. Without the
  // detector the user sees "Continuing." as the bot's reply and waits
  // forever. With it, the conversation_completed event reports the
  // stall explicitly so Discord/chat dock can render a clear failure.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ finalOutput: 'Continuing.' }]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'continue this',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  const completedEvents = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.equal(completedEvents[0].data.reason, 'sub_agent_stalled');
  assert.match(
    completedEvents[0].data.summary as string,
    /sub-agent ended its turn without taking any action/,
  );
  assert.equal(
    (completedEvents[0].data.stallDetail as { rawOutput: string }).rawOutput,
    'Continuing.',
  );
});

test('runConversation: future-tense sub-agent stall after discovery tools is flagged', async () => {
  // Repro from Discord "what desktop version are you running":
  // Orchestrator made discovery/memory tool calls, handed off to
  // Executor, then Executor only said "I'll check..." and made zero
  // post-handoff tool calls. Total run tool calls were non-zero, so
  // the older detector missed it and the user saw a promise that never
  // completed.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: opts.context };
    ee.emit('agent_start', runContext, { name: 'Orchestrator' });
    ee.emit(
      'agent_tool_start',
      runContext,
      { name: 'Orchestrator' },
      { name: 'local_cli_list' },
      { toolCall: { callId: 'call_1', arguments: '{"filter":"defaults"}' } },
    );
    ee.emit(
      'agent_tool_start',
      runContext,
      { name: 'Orchestrator' },
      { name: 'tool_choice_remember' },
      { toolCall: { callId: 'call_2', arguments: '{"intent":"local.desktop.version"}' } },
    );
    ee.emit('agent_handoff', runContext, { name: 'Orchestrator' }, { name: 'Executor' });
    ee.emit('agent_start', runContext, { name: 'Executor' });
    const output = 'I\u2019ll check the installed desktop app version from the local app bundle metadata.';
    ee.emit('agent_end', runContext, { name: 'Executor' }, output);
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: output,
    };
  };

  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'what desktop version are you running',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const completedEvents = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.equal(completedEvents[0].data.reason, 'sub_agent_stalled');
  assert.match(
    completedEvents[0].data.summary as string,
    /announced work it was about to do but didn't actually call the tool/,
  );
  const detail = completedEvents[0].data.stallDetail as {
    totalToolCalls: number;
    afterHandoff: { to: string; toolCallsAfterHandoff: number };
  };
  assert.equal(detail.totalToolCalls, 2);
  assert.equal(detail.afterHandoff.to, 'Executor');
  assert.equal(detail.afterHandoff.toolCallsAfterHandoff, 0);
});

test('runConversation: a short SUBSTANTIVE reply is NOT flagged as a stall', async () => {
  // Counter-test: short reply but not on the stall whitelist. Should be
  // surfaced as a normal summary so we don't drown real terse answers
  // in the same "agent gave up" message.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ finalOutput: 'Added 5 rows to the sheet.' }]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'add the rows',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const completedEvents = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.equal(completedEvents[0].data.reason, 'no_structured_output');
  assert.equal(completedEvents[0].data.summary, 'Added 5 rows to the sheet.');
});

// ─── T2.2 — generalized stall detector signals ─────────────────

test('runConversation: stuck_detected fires Signal A when zero tools + generic ack', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ finalOutput: 'OK.' }]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do work',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  // The harness retries once on stall (HARNESS_MAX_STALL_RETRIES=1
  // default); the retry stalls too with this scripted runner, so the
  // detector fires twice. What matters here is that the FIRST signal
  // is correctly classified — that's the detector's contract.
  assert.ok(stuckEvents.length >= 1, 'expected at least one stuck_detected event');
  assert.equal((stuckEvents[0].data as { signal: string }).signal, 'A_zero_tools');
});

test('runConversation: a zero-tool ACKNOWLEDGMENT turn is NOT flagged as a stall', async () => {
  // Live regression (sess-mpzre9m2, turn 7): the user gave correction feedback;
  // the model correctly replied "You're right … going forward I'll treat SEO as
  // raw metrics" with done=true, nextAction=completed, 0 tool calls. The stray
  // "I'll" tripped STALL_ANNOUNCEMENT_PATTERN and the harness force-injected
  // "prose, not an action — call a tool now", derailing the alignment turn. The
  // reflection suppressor must let a genuine conversational reply through.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: {
      summary: 'Acknowledged the two corrections and aligned on next steps',
      reply: "You're right on both. I put them in the wrong table, and going forward I'll treat SEO as raw metrics first.",
      done: true, nextAction: 'completed', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'two issues to correct: wrong table, and that seo data is too light',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 1, 'an acknowledgment reply must complete in one step, not retry');
  const falseClaims = listEventsForConv(sess.id, { types: ['stuck_detected'] })
    .filter((e) => (e.data as { kind?: string }).kind === 'structured_zero_tool_claim');
  assert.equal(falseClaims.length, 0, 'a conversational acknowledgment must not be a zero-tool claim stall');
});

test('runConversation: a zero-tool FALSE completion claim still fires the stall (no over-suppression)', async () => {
  // Positive control: a real fake-completion ("Sent the email …") carries none
  // of the reflection markers, so the suppressor must NOT shield it.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: {
      summary: 'claimed the email was sent', reply: 'Sent the email to the team.',
      done: true, nextAction: 'completed', reason: null } },
  ]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'send the email',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const claims = listEventsForConv(sess.id, { types: ['stuck_detected'] })
    .filter((e) => (e.data as { kind?: string }).kind === 'structured_zero_tool_claim');
  assert.ok(claims.length >= 1, 'a false completion claim with zero tools must still be flagged');
});

test('runConversation: Signal D fires when sub-agent emits OrchestratorDecision JSON', async () => {
  // Pattern: model over-conforms to schema and the SDK passes the
  // JSON through as a plain string. Today extractFallbackSummary
  // recovered the reply silently; the detector now ALSO flags it so
  // ops can see how often this happens.
  const sess = HarnessSession.create({ kind: 'chat' });
  const decisionJson = JSON.stringify({
    summary: 'I drafted a workflow but did not finalize',
    reply: 'Here is the draft — want me to ship it?',
    done: false,
    nextAction: 'awaiting_user_input',
  });
  const runner = scriptedRunner([{ finalOutput: decisionJson }]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'draft something',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  // Like Signal A above: the auto-retry causes the detector to fire
  // once per stalled turn. Assert the first signal is classified
  // correctly — the retry-count assertion is in the new
  // "stall triggers one auto-retry" test below.
  assert.ok(stuckEvents.length >= 1);
  assert.equal((stuckEvents[0].data as { signal: string }).signal, 'D_decision_json');
  // The visible summary should be the model's reply (since it had a
  // usable one) — surfaced through the detector instead of silently
  // returned as-is.
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.match(completed[0].data.summary as string, /draft|ship it/i);
});

test('runConversation: a real "Added 5 rows" reply does NOT fire any stall signal', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ finalOutput: 'Added 5 rows to the sheet.' }]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'go',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 0);
});

test('runConversation: "Transferred to Executor" false claim is flagged (regression: sess-mpeu2wmk)', async () => {
  // Repro from 2026-05-21 sess-mpeu2wmk-4785eded turn 2: after the
  // stall_retry_attempted hook re-prompted the Executor for a multi-
  // step Composio + Salesforce chain, the model emitted:
  //   "Transferred to Executor to run the actual workflow now."
  // The first broadened pattern landed in v0.4.32 caught "Handed off"
  // but missed "Transferred to" — the model just swapped synonyms.
  // The user saw a fabricated reply that lied about doing the work.
  // The pattern set now covers transfer/route/dispatch/delegate/
  // launch/trigger/forward verbs in both past- and present-progressive
  // tense; this test pins one of them.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    {
      finalOutput: 'Transferred to Executor to run the actual workflow now.',
    },
  ]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do the multi-step thing',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.ok(stuckEvents.length >= 1, 'expected "Transferred to" false claim to fire stuck_detected');
  assert.equal((stuckEvents[0].data as { signal: string }).signal, 'A_zero_tools');
});

test('runConversation: past-tense FALSE CLAIM with zero tools is flagged (regression: sess-mper69si)', async () => {
  // Repro from 2026-05-21 sess-mper69si-1a163ec1 turn 2:
  // After the retry hook re-prompted the Executor with a clear
  // "act now" directive, the model produced past-tense narrative
  // claiming the work was done without calling a tool:
  //   "Handed off the exact Outlook action for execution with the
  //    required tool slug and arguments."
  // The original future-tense-only regex missed this and surfaced
  // the false claim to the user as a real reply. Broadening
  // STALL_ANNOUNCEMENT_PATTERN to past-tense verbs catches it
  // honestly so the user sees a failure message instead of a lie.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    {
      finalOutput:
        'Handed off the exact Outlook action for execution with the required tool slug and arguments.',
    },
  ]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'find that email',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.ok(stuckEvents.length >= 1, 'expected past-tense false claim to fire stuck_detected');
  assert.equal((stuckEvents[0].data as { signal: string }).signal, 'A_zero_tools');

  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.equal(completed[0].data.reason, 'sub_agent_stalled');
});

test('runConversation: stall triggers one auto-retry; retry success completes conversation normally', async () => {
  // Repro from the 2026-05-20 sess-mpepwb5r-348980f6 trace:
  // Orchestrator did discovery + tool_choice_remember + handoff with
  // structured toolCall, Executor announced "I'll search Outlook..."
  // with zero post-handoff tool calls. Detector caught it, but the
  // conversation died with sub_agent_stalled and the user saw the
  // "announced work but didn't call the tool" error message.
  //
  // Fix E hooks the stall detector to one auto-retry with a synthetic
  // "act now" message. If the retry succeeds (model emits a tool call
  // on the second pass), the conversation completes normally and the
  // user never sees the stall failure.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // Pre-seed an Orchestrator handoff event so buildStallRetryMessage()
  // can find the structured toolCall and surface it in the retry.
  const { appendEvent } = await import('./eventlog.js');
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'orchestrator',
    type: 'handoff',
    data: {
      to: 'Executor',
      input: {
        directive: 'Search Nate’s Outlook for emails from Marlow today.',
        toolCall: {
          slug: 'OUTLOOK_LIST_MESSAGES',
          args: '{"user_id":"me","folder":"allfolders","search":"Marlow","top":25}',
          rationale: 'Pre-resolved by Orchestrator after discovery.',
        },
      },
    },
  });

  // First turn stalls (announcement, zero tools). Second turn returns
  // a real reply — simulates the retry working. The scripted runner
  // walks turns sequentially, so the retry hits the second entry.
  let scriptIndex = 0;
  const scripted = [
    'I’ll search Outlook for “Marlow” and check whether anything came in today.',
    'Found 1 email from Marlowe Rary today, subject "Account question".',
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'A prospect emailed me today Marlow can you find that',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  // The conversation completed (NOT stalled out).
  assert.equal(result.status, 'completed');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.notEqual(completed[0].data.reason, 'sub_agent_stalled', 'retry should have prevented sub_agent_stalled');

  // The retry event was logged for observability.
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1, 'expected exactly one stall_retry_attempted event');
  const retryData = retryEvents[0].data as {
    attempt: number;
    maxRetries: number;
    signal: string;
    rawOutput: string;
  };
  assert.equal(retryData.attempt, 1);
  assert.equal(retryData.signal, 'A_zero_tools');
  assert.match(retryData.rawOutput, /search Outlook for/);

  // The retry message that drove turn 2 should mention the slug the
  // Orchestrator pre-resolved — the model gets the action inlined.
  const userInputs = listEventsForConv(sess.id, { types: ['user_input_received'] });
  assert.ok(userInputs.length >= 2, 'expected the retry to inject a synthetic user input');
  assert.match(userInputs[1].data.text as string, /OUTLOOK_LIST_MESSAGES/, 'retry message should inline the pre-resolved slug');
});

test('runConversation: existing-work stall retry forces focus and memory before asking user', async () => {
  // Repro class from sess-mposxsah-8b67f103: the user referenced a
  // known prior creative project ("gala silet acution animation post"),
  // but the first model response asked for a file/path without trying
  // focus or memory. On the retry, that shape should be treated as a
  // reference to existing work, so ask_user_question is only allowed
  // after focus/memory fail to find a target.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: 'I’ll edit the gala silent auction animation post now.' },
    { finalOutput: 'I found the gala-reel project in memory and loaded it.' },
  ]);

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Hey can we work on edits for the gala silet acution animation post please',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });

  assert.equal(result.status, 'completed');
  const userInputs = listEventsForConv(sess.id, { types: ['user_input_received'] });
  assert.ok(userInputs.length >= 2, 'expected a synthetic stall-retry input');
  const retryText = userInputs[1].data.text as string;
  assert.match(retryText, /existing work/i);
  assert.match(retryText, /gala silet acution animation post/i);
  assert.match(retryText, /focus_get/);
  assert.match(retryText, /memory_search or memory_recall/);
  assert.doesNotMatch(
    retryText,
    /call ask_user_question instead of producing announcement text/,
    'existing-work retry must not use the generic ask-user escape hatch first',
  );
});

test('runConversation: fresh stall retry keeps generic ask-user fallback', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: 'I’ll write a quick greeting now.' },
    { finalOutput: 'Hello there.' },
  ]);

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'write a quick greeting',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });

  assert.equal(result.status, 'completed');
  const userInputs = listEventsForConv(sess.id, { types: ['user_input_received'] });
  assert.ok(userInputs.length >= 2, 'expected a synthetic stall-retry input');
  const retryText = userInputs[1].data.text as string;
  assert.match(retryText, /call ask_user_question instead of producing announcement text/);
  assert.doesNotMatch(retryText, /existing work/i);
  assert.doesNotMatch(retryText, /memory_search or memory_recall/);
});

test('runConversation: stall retry that ALSO stalls falls through to sub_agent_stalled', async () => {
  // Negative case: scripted runner stalls on every turn, so the retry
  // also stalls. Budget exhausts, the original failure surfaces as
  // today's behavior. Documents that the retry doesn't mask genuine
  // model failure — it only absorbs intermittent ones.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ finalOutput: 'I’ll do that now.' }]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'go',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.equal(completed[0].data.reason, 'sub_agent_stalled');
  // Retry was attempted once before giving up.
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1);
});

test('runConversation: structured false tool-unavailable decision is retried', async () => {
  // Repro from the native compaction desktop smoke, 2026-05-27:
  // Clem had file/shell/search tools on the agent, but returned a
  // structured OrchestratorDecision saying it needed a "tool-enabled
  // run" and asked the user to resend continue. That strands long
  // autonomous tasks in a user-input state even though the runtime is
  // healthy. Treat that as the same zero-tool stall class and retry
  // with an action-only nudge.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const scripted: unknown[] = [
    {
      summary: 'Need to continue the local file test but no tools are available.',
      reply:
        'I need tool access in this turn to create/read the local files. Please resend continue in a tool-enabled run.',
      done: false,
      nextAction: 'awaiting_user_input',
      reason: 'No commentary/tool calls were available in this turn.',
    },
    {
      summary: 'All set after retry.',
      reply: 'Done after retry.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'create the native-compaction proof files',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'structured_tool_unavailable');

  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1);

  const userInputs = listEventsForConv(sess.id, { types: ['user_input_received'] });
  assert.ok(userInputs.length >= 2, 'expected retry to inject a synthetic user input');
  assert.match(userInputs[1].data.text as string, /tool surface is available/i);
});

test('runConversation: structured tool-unavailable after only probe tools is retried', async () => {
  // Live desktop repro, 2026-05-27: after native compaction Clem called
  // workspace_roots, then claimed local/file tools were unavailable and
  // asked the user to continue in another tool-enabled turn. A single
  // probe call is not meaningful progress; retry instead of stranding.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const scripted: unknown[] = [
    {
      summary:
        'Could not continue tool execution because the available tool surface in this turn does not include the required local/file tools.',
      reply:
        'I am blocked because the local/file tool surface I need to write the markdown report is not available in this turn.',
      done: false,
      nextAction: 'awaiting_user_input',
      reason: 'Need a follow-up turn with local/file tools available to complete the report write.',
    },
    {
      summary: 'All set after probe-only retry.',
      reply: 'Done after retry.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  const runRunner: RunRunnerFn = async (runner, _a, items) => {
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    if (scriptIndex === 1) {
      (runner as unknown as EventEmitter).emit('agent_tool_start');
      appendEvent({
        sessionId: sess.id,
        turn: 1,
        role: 'Clem',
        type: 'tool_called',
        data: { tool: 'workspace_roots', callId: 'call_probe', arguments: '{}' },
      });
    }
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'finish the SEO audit report',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'structured_tool_unavailable');
  assert.equal((stuckEvents[0].data as { onlyProbeTools: boolean }).onlyProbeTools, true);
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1);
});

test('runConversation: structured awaiting_handoff_result tool-runtime stall is retried', async () => {
  // Live desktop repro, 2026-05-27: the Orchestrator returned
  // nextAction=awaiting_handoff_result with zero tool calls and said it
  // needed the "tool runtime" / "no executable tool results". That is
  // not a legitimate handoff; retry with an action-only nudge.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const scripted: unknown[] = [
    {
      summary:
        'Need to run the Market Leader workflow with tools, but this turn only had a handoff summary and no executable tool results.',
      reply:
        'I need the tool runtime to continue this properly: query Salesforce, gather SEO signals, write the markdown report, then request one approval before creating drafts.',
      done: false,
      nextAction: 'awaiting_handoff_result',
      reason: 'Proceed by calling Salesforce/SEO/file/approval tools in the next tool-enabled step.',
    },
    {
      summary: 'All set after handoff retry.',
      reply: 'Done after retry.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'run the Market Leader workflow',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'structured_tool_unavailable');
  assert.equal((stuckEvents[0].data as { nextAction: string }).nextAction, 'awaiting_handoff_result');
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1);
});

test('runConversation: structured abandoned tool-unavailable decision is retried', async () => {
  // Same failure as above, but the model may use nextAction=abandoned
  // instead of awaiting_user_input. That should not bypass recovery
  // when the reason is a false "tool surface unavailable" claim.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const scripted: unknown[] = [
    {
      summary: 'Prepared to create files but local file tools are unavailable.',
      reply: 'I do not have the local file/web tool surface available in this turn.',
      done: true,
      nextAction: 'abandoned',
      reason: 'Required local file and web-search tools were not available in the active tool surface.',
    },
    {
      summary: 'All set after abandoned retry.',
      reply: 'Done after retry.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'create the native-compaction proof files',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'structured_tool_unavailable');
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1);
});

test('runConversation: structured zero-tool completion claim is retried', async () => {
  // Repro from the native compaction desktop smoke, 2026-05-27:
  // Clem returned a structured "Done — created files, searched web"
  // answer with toolCalls=0 and no artifacts on disk. Structured
  // output should not bypass the same zero-tool false-claim guard
  // used for plain-text sub-agent stalls.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const scripted: unknown[] = [
    {
      summary: 'Created the local proof files, verified them, searched for a web source, and confirmed completion.',
      reply: 'Done — created 3 files and searched the web source.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
    {
      summary: 'Completed after retry with actual tool calls.',
      reply: 'Done after retry.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'create files and search the web',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'structured_zero_tool_claim');
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1);
});

test('runConversation: propagates run_failed status when a turn throws', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ status: 'throw' }]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do the thing',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /scripted_throw/);
});

test('isCodexAuthRevoked: detects 401/token_revoked and ignores unrelated errors', () => {
  // CodexModelError-shaped: carries status 401
  assert.equal(isCodexAuthRevoked({ status: 401 }, 'Codex /responses returned 401 Unauthorized'), true);
  // CodexRuntimeError-shaped: message-only signal
  assert.equal(isCodexAuthRevoked(new Error('Encountered invalidated oauth token for user, failing request'), 'Encountered invalidated oauth token for user, failing request'), true);
  assert.equal(isCodexAuthRevoked({}, 'token_revoked'), true);
  // Not auth: a 429 rate limit or a generic failure must NOT be misclassified
  assert.equal(isCodexAuthRevoked({ status: 429 }, 'Codex /responses returned 429'), false);
  assert.equal(isCodexAuthRevoked(new Error('scripted_throw'), 'scripted_throw'), false);
  assert.equal(isCodexAuthRevoked(null, 'some tool failed'), false);
});
