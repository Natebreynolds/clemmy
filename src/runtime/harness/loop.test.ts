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
// This suite drives the loop with SCRIPTED runners that simulate tool calls by
// emitting agent_tool_start events (no real wrapped-tool invoke). Tool-call
// counting for those simulated calls comes from the loop's event-based fallback
// counter, which only registers when tool-brackets are OFF (when ON, the wrapped
// tool owns the counter — see loop.ts:1938). Brackets are now default-ON in
// production (24/7 keystone); pin them OFF here so the simulated-tool stall/judge
// tests keep counting. Brackets-ON behavior is covered by brackets.test.ts.
process.env.HARNESS_TOOL_BRACKETS = 'off';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent, RunContext, RunState, type AgentInputItem, type Runner } from '@openai/agents';

const { resetEventLog, requestKill, listEvents, createSession, appendEvent } = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runTurn, runConversation, resumePendingApproval, runConversationFromResume, isCodexAuthRevoked, normalizeError, buildStallRetryMessage, goalObjectiveString, toOrchestratorDecision } = await import('./loop.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;
const { BoundaryError } = await import('../boundary-error.js');
const { ToolCallsLimitExceeded } = await import('./brackets.js');
const { listEvents: listEventsForConv } = await import('./eventlog.js');
const approvalRegistry = await import('./approval-registry.js');
const { getPlanScope, isAutoApprovedByScope } = await import('../../agents/plan-scope.js');
const { rememberFact } = await import('../../memory/facts.js');

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

const COMPLEX_INPUT =
  'Pull my unread Outlook emails and the open Salesforce leads, then update each Airtable contact record and draft outreach for the warm ones';

test('buildStallRetryMessage: after a draft-only-skill block, steers to PRESENT the drafts — NOT "call a tool, no text"', () => {
  // Fix 4(b): the false stall-nudge gagged the model exactly when it should
  // present the drafts. After a present-for-approval refusal, the nudge must
  // tell it to reply with the drafts, not forbid text.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id, turn: 1, role: 'Clem', type: 'tool_returned',
    data: { tool: 'composio_execute_tool', result: 'Tool call refused by harness: GOAL_FIDELITY_CHECK_FAILED: ... PRESENT the drafted item(s) to the user as your reply now ... then ask "Good to send?"' },
  });
  const msg = buildStallRetryMessage(sess.id, { signal: 'A_zero_tools', userVisibleMessage: '', detail: {} } as never);
  assert.match(msg, /Reply to the user NOW with the drafted/i);
  assert.doesNotMatch(msg, /do not emit any text/i);
});

test('buildStallRetryMessage: a normal stall (no draft-only block) still demands a tool call', () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const msg = buildStallRetryMessage(sess.id, { signal: 'A_zero_tools', userVisibleMessage: '', detail: {} } as never);
  assert.match(msg, /call a tool/i);
});

test('W1a characterization: a transient model error with NO fallover factory surfaces the infra-recovery ask (today behavior)', async () => {
  // Pins the EXACT current behavior that the chat step-boundary fallover must
  // preserve when fallover does NOT apply (no rebuildAgentForBrain provided):
  // a transient BoundaryError → awaiting_user_input, source 'infra_error_recovery',
  // session stays active (not failed).
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async () => {
    throw BoundaryError.from(new Error('backend 529 overloaded'), {
      kind: 'model.overloaded', retryable: true, userMessage: 'The model backend hit a transient error (overloaded).',
    });
  };
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do a thing',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'transient error surfaces the ask when fallover does not apply');
  const asks = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
  assert.ok(
    asks.some((e) => (e.data as { source?: string } | undefined)?.source === 'infra_error_recovery'),
    'the ask is tagged infra_error_recovery',
  );
  assert.notEqual(sess.status, 'failed', 'session stays recoverable, not failed');
});

test('W1a: a transient error falls over to the next brain and completes (no ask)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const agentFor = (id: string) => ({ __brain: id }) as unknown as import('@openai/agents').Agent<any, any>;
  const rebuilt: string[] = [];
  const runRunner: RunRunnerFn = async (_runner, agent, items) => {
    if ((agent as { __brain?: string }).__brain !== 'brain-2') {
      throw BoundaryError.from(new Error('backend 529'), { kind: 'model.overloaded', retryable: true, userMessage: 'transient' });
    }
    return { history: items, lastResponseId: undefined, finalOutput: { summary: 'done on brain 2', reply: 'Answer from brain 2', done: true, nextAction: 'completed', reason: null } } as never;
  };
  const result = await runConversation({
    agent: agentFor('brain-1'),
    sessionId: sess.id,
    input: 'do a thing',
    makeRunner: makeRunnerStub,
    runRunner,
    falloverModelIds: ['brain-2'],
    rebuildAgentForBrain: async (id) => { rebuilt.push(id); return agentFor(id); },
  });
  assert.equal(result.status, 'completed', 'completes on the fallover brain');
  assert.deepEqual(rebuilt, ['brain-2'], 'rebuilt the agent once on the next brain');
  assert.equal(listEventsForConv(sess.id, { types: ['brain_fallover'] }).length, 1, 'one brain_fallover advisory');
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 0, 'no ask when fallover succeeds');
});

test('W1a: when every brain hits the transient error, fall through to the infra-recovery ask', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const agentFor = (id: string) => ({ __brain: id }) as unknown as import('@openai/agents').Agent<any, any>;
  const runRunner: RunRunnerFn = async () => {
    throw BoundaryError.from(new Error('backend 529'), { kind: 'model.overloaded', retryable: true, userMessage: 'transient' });
  };
  const result = await runConversation({
    agent: agentFor('brain-1'),
    sessionId: sess.id,
    input: 'do a thing',
    makeRunner: makeRunnerStub,
    runRunner,
    falloverModelIds: ['brain-2', 'brain-3'],
    rebuildAgentForBrain: async (id) => agentFor(id),
  });
  assert.equal(result.status, 'awaiting_user_input', 'exhausted brains → ask the user');
  assert.equal(listEventsForConv(sess.id, { types: ['brain_fallover'] }).length, 2, 'tried both fallover brains once each');
  const asks = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
  assert.ok(asks.some((e) => (e.data as { source?: string } | undefined)?.source === 'infra_error_recovery'), 'emits the same infra ask on exhaustion');
});

test('W1a: a transient error AFTER an external_write does NOT switch brains (no double-act) — it asks', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const agentFor = (id: string) => ({ __brain: id }) as unknown as import('@openai/agents').Agent<any, any>;
  let rebuilds = 0;
  const runRunner: RunRunnerFn = async (_runner, _agent, _items) => {
    // Simulate a side effect committing this turn, then a transient failure.
    appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'external_write', data: { tool: 'send_email' } });
    throw BoundaryError.from(new Error('backend 529 after the send'), { kind: 'model.overloaded', retryable: true, userMessage: 'transient' });
  };
  const result = await runConversation({
    agent: agentFor('brain-1'),
    sessionId: sess.id,
    input: 'send the email',
    makeRunner: makeRunnerStub,
    runRunner,
    falloverModelIds: ['brain-2'],
    rebuildAgentForBrain: async (id) => { rebuilds += 1; return agentFor(id); },
  });
  assert.equal(result.status, 'awaiting_user_input', 'must NOT re-run a turn that already wrote externally');
  assert.equal(rebuilds, 0, 'no brain rebuild after an external write');
  assert.equal(listEventsForConv(sess.id, { types: ['brain_fallover'] }).length, 0, 'no fallover advisory');
});

test('runTurn replays eventlog transcript when a Claude-only session has no SDK snapshot', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Draft the Acme renewal update and ask me before sending.' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: {
      reason: 'claude_agent_sdk_brain',
      reply: 'I drafted the Acme renewal update and am waiting for your approval before sending.',
    },
  });

  let seenItems: AgentInputItem[] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    seenItems = items;
    return {
      history: [...items, { role: 'assistant', content: 'Continuing from the Acme draft.' } as AgentInputItem],
      lastResponseId: undefined,
      finalOutput: 'Continuing from the Acme draft.',
    };
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'pick this back up',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const replay = seenItems.find((item) => {
    const record = item as { role?: unknown; content?: unknown };
    return record.role === 'system' &&
      typeof record.content === 'string' &&
      record.content.includes('[SESSION REPLAY]');
  }) as { content?: string } | undefined;
  assert.ok(replay?.content, 'standard harness lane injects the canonical eventlog replay');
  assert.match(replay.content, /USER: Draft the Acme renewal update/);
  assert.match(replay.content, /YOU: I drafted the Acme renewal update/);
  assert.doesNotMatch(replay.content, /USER: pick this back up/, 'current input is not duplicated into prior history');
});

test('runTurn replays only newer Claude turns missing from an older OpenAI snapshot', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Summarize the Atlas kickoff notes.' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'openai_agents_harness', reply: 'Atlas kickoff summary is saved.' },
  });
  sess.recordTurnResult({
    history: [
      { role: 'user', content: 'Summarize the Atlas kickoff notes.' } as AgentInputItem,
      { role: 'assistant', content: 'Atlas kickoff summary is saved.' } as AgentInputItem,
    ],
    lastResponseId: undefined,
    turn: 1,
  });
  appendEvent({
    sessionId: sess.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Now draft the renewal email from that summary.' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 2,
    role: 'system',
    type: 'conversation_completed',
    data: {
      reason: 'claude_agent_sdk_brain',
      reply: 'I drafted the renewal email but did not send it.',
    },
  });

  let seenItems: AgentInputItem[] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    seenItems = items;
    return {
      history: [...items, { role: 'assistant', content: 'Continuing with the unsent renewal draft.' } as AgentInputItem],
      lastResponseId: undefined,
      finalOutput: 'Continuing with the unsent renewal draft.',
    };
  };

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'pick up the renewal draft',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const replay = seenItems.find((item) => {
    const record = item as { role?: unknown; content?: unknown };
    return record.role === 'system' &&
      typeof record.content === 'string' &&
      record.content.includes('[SESSION REPLAY]');
  }) as { content?: string } | undefined;
  assert.ok(replay?.content, 'newer Claude turn missing from the snapshot is replayed');
  assert.match(replay.content, /USER: Now draft the renewal email/);
  assert.match(replay.content, /YOU: I drafted the renewal email but did not send it/);
  assert.doesNotMatch(replay.content, /Summarize the Atlas kickoff notes/, 'older snapshot-backed user turn is not duplicated');
  assert.doesNotMatch(replay.content, /Atlas kickoff summary is saved/, 'older snapshot-backed assistant turn is not duplicated');
  assert.doesNotMatch(replay.content, /USER: pick up the renewal draft/, 'current input is not duplicated into prior history');
});

test('runTurn replays an unpaired awaiting_user_input question into a later brain turn', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Deploy the staging build.' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: { question: 'Which target should I deploy: staging or production?' },
  });

  let seenItems: AgentInputItem[] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    seenItems = items;
    return {
      history: [...items, { role: 'assistant', content: 'Continuing after deployment target answer.' } as AgentInputItem],
      lastResponseId: undefined,
      finalOutput: 'Continuing after deployment target answer.',
    };
  };

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'use staging',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const replay = seenItems.find((item) => {
    const record = item as { role?: unknown; content?: unknown };
    return record.role === 'system' &&
      typeof record.content === 'string' &&
      record.content.includes('[SESSION REPLAY]');
  }) as { content?: string } | undefined;
  assert.ok(replay?.content, 'the prior pause question is replayed');
  assert.match(replay.content, /USER: Deploy the staging build/);
  assert.match(replay.content, /YOU: Which target should I deploy/);
  assert.doesNotMatch(replay.content, /USER: use staging/, 'current answer is not duplicated into prior history');
});

test('normalizeError: a non-Error object never renders as "[object Object]" (the run_failed crash)', () => {
  // The exact class that produced "Something went wrong: [object Object]": a raw
  // provider error envelope thrown late in a model stream.
  assert.equal(normalizeError({ statusCode: 529 }), 'error (status 529)');
  assert.equal(normalizeError({ message: 'overloaded' }), 'overloaded');
  assert.equal(normalizeError({ error: 'rate limited' }), 'rate limited');
  assert.equal(normalizeError({ reason: 'upstream blip' }), 'upstream blip');
  // A bare object with no known field → JSON, never "[object Object]".
  assert.equal(normalizeError({ foo: 'bar' }), '{"foo":"bar"}');
  // Real Errors keep their message; primitives stringify normally.
  assert.equal(normalizeError(new Error('boom')), 'boom');
  assert.equal(normalizeError('plain string'), 'plain string');
  // The headline invariant: nothing the helper returns is the literal garbage.
  for (const v of [{ statusCode: 529 }, { a: 1 }, {}, null, undefined]) {
    assert.notEqual(normalizeError(v), '[object Object]');
  }
});

// ── FIX 1: goalObjectiveString — the continuation classifier input ──────────
test('goalObjectiveString: builds objective + success criteria from the parked plan', () => {
  const goal = {
    plan: {
      objective: 'Build outbound emails for every market-leader prospect',
      successCriteria: ['One email drafted per usable row', 'Rows without contacts skipped and listed'],
    },
  } as any;
  const out = goalObjectiveString(goal);
  assert.ok(out!.includes('Build outbound emails'), 'carries the objective');
  assert.ok(out!.includes('One email drafted per usable row'), 'carries the criteria (the multi-domain signal)');
});

test('goalObjectiveString: prefers approvedPlan over plan, and the CURRENT stage criteria when staged', () => {
  const goal = {
    plan: { objective: 'OLD', successCriteria: ['old'] },
    approvedPlan: { objective: 'Pull each prospect and draft outreach', successCriteria: ['all crit'] },
    stages: [
      { id: 's1', title: 'Stage 1', status: 'done', criteria: ['done crit'] },
      { id: 's2', title: 'Stage 2', status: 'pending', criteria: ['pull the sheet rows'] },
    ],
  } as any;
  const out = goalObjectiveString(goal);
  assert.ok(out!.startsWith('Pull each prospect'), 'uses approvedPlan objective');
  assert.ok(out!.includes('pull the sheet rows'), 'uses the CURRENT (pending) stage criteria');
  assert.ok(!out!.includes('done crit'), 'does not include a completed stage');
});

test('goalObjectiveString: null-safe when the plan has no objective (caller falls back to the literal input)', () => {
  assert.equal(goalObjectiveString({ plan: { objective: '', successCriteria: [] } } as any), undefined);
  assert.equal(goalObjectiveString({ plan: {} } as any), undefined);
  assert.equal(goalObjectiveString({} as any), undefined);
});

test('dynamic reasoning effort: real runTurn injects effort per turn (simple→none; interactive chat caps complex at medium)', async () => {
  // Exercises the ACTUAL loop.ts injection (not a hand-port). The explicit-flag
  // contract is owned by buildOrchestratorAgent (asserted in orchestrator.test);
  // here we verify the per-turn effort + the human-waiting cap.
  resetEventLog();
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => ({
    history: [...items, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
    lastResponseId: 'resp',
    finalOutput: { ok: true },
  });

  // Simple chat turn → none (byte-identical fastest path)
  const simpleAgent = makeAgentStub() as any;
  const s1 = HarnessSession.create({ kind: 'chat', title: 'effort-simple' });
  await runTurn({ agent: simpleAgent, sessionId: s1.id, input: "what's on my calendar today?", makeRunner: makeRunnerStub, runRunner });
  assert.equal(simpleAgent.modelSettings?.reasoning?.effort, 'none', 'simple → none');
  assert.equal(simpleAgent.modelSettings?.text?.verbosity, 'low', 'gpt-5 verbosity default preserved');
  assert.equal(listEvents(s1.id, { types: ['reasoning_effort'] })[0].data.effort, 'none');

  // Complex INTERACTIVE chat turn → capped at medium (a human is waiting)
  const chatAgent = makeAgentStub() as any;
  const s2 = HarnessSession.create({ kind: 'chat', title: 'effort-chat-complex' });
  await runTurn({ agent: chatAgent, sessionId: s2.id, input: COMPLEX_INPUT, makeRunner: makeRunnerStub, runRunner });
  assert.equal(chatAgent.modelSettings?.reasoning?.effort, 'medium', 'complex chat → medium (capped)');
  assert.equal(listEvents(s2.id, { types: ['reasoning_effort'] })[0].data.kind, 'chat');
});

test('dynamic reasoning effort: background (workflow) complex turn → high (no human waiting)', async () => {
  resetEventLog();
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => ({
    history: [...items, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
    lastResponseId: 'resp',
    finalOutput: { ok: true },
  });
  const wfAgent = makeAgentStub() as any;
  const sess = HarnessSession.create({ kind: 'workflow', title: 'effort-wf-complex' });
  await runTurn({ agent: wfAgent, sessionId: sess.id, input: COMPLEX_INPUT, makeRunner: makeRunnerStub, runRunner });
  assert.equal(wfAgent.modelSettings?.reasoning?.effort, 'high', 'complex workflow → high');
  assert.equal(listEvents(sess.id, { types: ['reasoning_effort'] })[0].data.effort, 'high');
});

test('dynamic reasoning effort: kill-switch off leaves the agent untouched (SDK default rides)', async () => {
  resetEventLog();
  const prev = process.env.CLEMMY_DYNAMIC_REASONING;
  process.env.CLEMMY_DYNAMIC_REASONING = 'off';
  try {
    const agent = makeAgentStub() as any;
    const sess = HarnessSession.create({ kind: 'chat', title: 'effort-off' });
    const runRunner: RunRunnerFn = async (_runner, _agent, items) => ({
      history: [...items, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
      lastResponseId: 'resp',
      finalOutput: { ok: true },
    });
    await runTurn({ agent, sessionId: sess.id, input: 'research and build a full audit of everything', makeRunner: makeRunnerStub, runRunner });
    assert.equal(agent.modelSettings, undefined, 'no modelSettings set when disabled');
    assert.equal(agent._modelSettingsExplicitlyConfigured, undefined, 'flag untouched when disabled');
    assert.equal(listEvents(sess.id, { types: ['reasoning_effort'] }).length, 0);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_DYNAMIC_REASONING;
    else process.env.CLEMMY_DYNAMIC_REASONING = prev;
  }
});

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

  // The honored kill is one-shot: the latch is consumed, so the user's
  // next message on the same session runs normally instead of being
  // assassinated by the stale row (live 2026-06-12 sess-mqbgayx6: a
  // post-Stop follow-up died on the leftover kill).
  const { isKillRequested, updateSession } = await import('./eventlog.js');
  assert.equal(isKillRequested(sess.id), false);
  updateSession(sess.id, { status: 'active' });
  let secondRunRan = false;
  const okRunner: RunRunnerFn = async (_r, _a, items) => {
    secondRunRan = true;
    return { history: items, lastResponseId: undefined, finalOutput: 'done' };
  };
  const second = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'follow-up after stop',
    makeRunner: makeRunnerStub,
    runRunner: okRunner,
  });
  assert.equal(secondRunRan, true);
  assert.notEqual(second.status, 'killed');
});

test('SDK-wrapped KillRequested during the run ends as a clean killed turn', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });

  // A kill that lands while a function tool is executing is thrown by the
  // tool bracket INSIDE the SDK, which re-wraps it as a plain Error — the
  // same envelope that hid ToolTimeout and ToolGuardrailEscalated. The
  // instanceof check alone misses it and the raw string reached the user.
  // Latch the kill INSIDE the run (after pre-flight) like a real Stop press.
  const runRunner: RunRunnerFn = async () => {
    requestKill(sess.id, 'stop pressed mid-tool');
    throw new Error(
      `Failed to run function tools: KillRequested: session ${sess.id} has a pending kill request`,
    );
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'scan everything',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'killed');
  const killEvents = listEvents(sess.id, { types: ['kill_requested'] });
  assert.ok(killEvents.some((ev) => (ev.data as { reason?: unknown }).reason === 'during run'));
  // No run_failed — the user sees Stopped, not the raw wrapped error.
  assert.equal(listEvents(sess.id, { types: ['run_failed'] }).length, 0);
  const reloaded = HarnessSession.load(sess.id);
  assert.equal(reloaded!.sessionRow.status, 'cancelled');
  // The latch is consumed here too.
  const { isKillRequested } = await import('./eventlog.js');
  assert.equal(isKillRequested(sess.id), false);
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
    // A genuinely non-transient error (no transport/HTTP-status signal) — must
    // still terminate as 'failed', NOT get routed to the retry prompt.
    throw new Error('unexpected null in planner output');
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do thing',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /unexpected null/);
  const failed = listEvents(sess.id, { types: ['run_failed'] });
  assert.equal(failed.length, 1);
  assert.match(String(failed[0].data.error), /unexpected null/);
  const reloaded = HarnessSession.load(sess.id);
  assert.equal(reloaded!.sessionRow.status, 'failed');
});

test('A2#3: an UNHANDLED model HTTP status (422) becomes a recoverable ask + brain-switch, not a dead session', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async () => {
    // A model-backend HTTP error the classifier doesn't specifically handle (not
    // 401/403/429/5xx). Previously → terminal run_failed (a dead turn). Now → recoverable
    // model.unknown → retry/switch/stop ask (fallover-eligible), session stays ACTIVE.
    throw { statusCode: 422, message: 'Unprocessable request' };
  };
  const result = await runTurn({
    agent: makeAgentStub(), sessionId: sess.id, input: 'do thing',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'recoverable — not a dead session');
  const reloaded = HarnessSession.load(sess.id);
  assert.notEqual(reloaded!.sessionRow.status, 'failed', 'session is NOT marked failed');
});

test('a NON-Error transient throw (the [object Object] class) becomes a retry prompt, not a crash', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });

  const runRunner: RunRunnerFn = async () => {
    // Exactly the failure that produced "Something went wrong: [object Object]":
    // a raw provider envelope (NOT an Error) thrown late in the stream.
    throw { statusCode: 529, message: 'Overloaded' };
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do thing',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  // Fix 2: a transient infra error offers retry/switch/stop instead of dying.
  assert.ok(['completed', 'awaiting_user_input'].includes(result.status));
  // Fix 1: whatever is surfaced is READABLE — never the literal "[object Object]".
  assert.ok(!/\[object Object\]/.test(result.error ?? ''), 'error must be readable, not [object Object]');
  const failed = listEvents(sess.id, { types: ['run_failed'] });
  assert.equal(failed.length, 0, 'a recoverable transient error does NOT emit a terminal run_failed');
  const awaiting = listEvents(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(awaiting.length, 1);
  assert.match(String((awaiting[0].data as { question?: string }).question ?? ''), /retry/i);
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

test('runConversation: completed decision with empty reply is retried, not shown as an internal bug bubble', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let calls = 0;
  const inputs: string[] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    const last = items.at(-1) as { content?: string } | undefined;
    if (typeof last?.content === 'string') inputs.push(last.content);
    calls += 1;
    if (calls === 1) {
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: {
          summary: 'Greeted user; awaiting their request.',
          reply: null,
          done: true,
          nextAction: 'completed',
          reason: null,
        },
      };
    }
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'Greeted the user.',
        reply: 'Hey - what would you like to work on?',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'hey hey',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 2, 'one retry should recover the missing reply');
  assert.match(inputs.at(-1) ?? '', /reply` was empty/);
  const guardrails = listEventsForConv(sess.id, { types: ['guardrail_tripped'] });
  assert.ok(guardrails.some((e) => (e.data as { kind?: string }).kind === 'completed_without_reply'));
  const stepEvents = listEventsForConv(sess.id, { types: ['conversation_step'] });
  assert.equal(stepEvents.length, 1, 'the invalid empty-reply completion is retried before a visible step event');
  assert.doesNotMatch(JSON.stringify(stepEvents), /Greeted user; awaiting their request/);
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.summary, 'Hey - what would you like to work on?');
  assert.doesNotMatch(String(completed.data.summary), /marked the turn complete|Internal log|Greeted user/);
});

test('runConversation: exhausted empty-reply completion uses safe fallback, not internal diagnostic text', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    {
      finalOutput: {
        summary: 'Greeted user; awaiting their request.',
        reply: null,
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'hey hey',
    maxSteps: 1,
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.ok(['completed', 'awaiting_user_input'].includes(result.status));
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.summary, "I didn't produce a visible reply there. Please send that again and I'll retry.");
  assert.equal(completed.data.internalSummary, 'Greeted user; awaiting their request.');
  assert.equal(completed.data.missingReply, true);
  const step = listEventsForConv(sess.id, { types: ['conversation_step'] }).at(-1)!;
  assert.equal((step.data.decision as { summary?: string }).summary, "I didn't produce a visible reply there. Please send that again and I'll retry.");
  assert.doesNotMatch(String(completed.data.summary), /marked the turn complete|Internal log|Greeted user/);
});

test('runConversation: reuseRecordedUserInput skips a duplicate user_input row on provider fallover', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'retry this turn' },
  });
  const runner = scriptedRunner([
    {
      finalOutput: {
        summary: 'Recovered on fallback',
        reply: 'Recovered on fallback.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    },
  ]);

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'retry this turn',
    makeRunner: makeRunnerStub,
    runRunner: runner,
    reuseRecordedUserInput: true,
  });

  assert.equal(result.status, 'completed');
  const inputs = listEventsForConv(sess.id, { types: ['user_input_received'] });
  assert.equal(inputs.length, 1, 'fallback reused the Claude-recorded user input instead of duplicating it');
  assert.equal((inputs[0].data as { text?: string }).text, 'retry this turn');
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

test('runConversation: a DECISION-level awaiting (done:true + awaiting, NO ask_user_question) SYNTHESIZES the question event so surfaces deliver it (2026-06-14 Discord stranded-user fix)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async () => {
    // The model asks via its DECISION (reply carries the question) and sets
    // done:true + awaiting — but does NOT call ask_user_question, so it emits
    // NO awaiting_user_input event. Before the fix, Discord/SSE got nothing.
    return { history: [], lastResponseId: undefined, finalOutput: {
      summary: 'confirming which site', reply: 'Still on Stonemill Bakehouse, or another design?',
      done: true, nextAction: 'awaiting_user_input', reason: null } };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'finalize the website',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'still halts for the user');
  // The loop must have SYNTHESIZED an awaiting_user_input event carrying the
  // question so event-stream surfaces (Discord, desktop SSE) can render it.
  const askEvents = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(askEvents.length, 1, 'exactly one synthesized awaiting_user_input event');
  assert.match((askEvents[0].data as { question: string }).question, /Stonemill Bakehouse/);
  assert.equal((askEvents[0].data as { source?: string }).source, 'decision_awaiting');
});

test('runConversation: a DECISION-level awaiting_approval (no SDK interrupt) SYNTHESIZES a delivery event so surfaces are not stranded', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async () => {
    // The model self-reports awaiting_approval in its DECISION without an SDK
    // interrupt, so NO approval_requested event fires. Before the fix, every
    // event-stream surface rendered nothing (the symmetric awaiting hole).
    return { history: [], lastResponseId: undefined, finalOutput: {
      summary: 'need sign-off to send the batch', reply: 'Ready to send 12 emails — approve to proceed or tell me to stop?',
      done: true, nextAction: 'awaiting_approval', reason: null } };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'send the outreach batch',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'awaiting_approval', 'still halts for approval');
  const askEvents = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(askEvents.length, 1, 'exactly one synthesized delivery event');
  assert.match((askEvents[0].data as { question: string }).question, /approve to proceed/);
  assert.equal((askEvents[0].data as { source?: string }).source, 'decision_awaiting_approval');
});

test('runConversation: done:true + awaiting_handoff_result WITH prior tool work surfaces an ask, NOT a silent re-loop (Step 2 dead-end fix)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: opts.context };
    // Real (non-probe) tool work this turn → toolCalls > 0, so the stall
    // detectors do NOT fire (they only catch the ZERO-meaningful-tools case).
    // This is EXACTLY the dead-end they miss — without the Step 2 handler it
    // would fall through to CONTINUATION_INPUT and re-loop until a budget cap.
    ee.emit('agent_start', runContext, { name: 'Orchestrator' });
    ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, { name: 'write_file' },
      { toolCall: { callId: 'call_1', arguments: '{"path":"/tmp/x"}' } });
    const decision = {
      summary: 'wrote the file, now waiting on the executor',
      reply: 'I prepared the changes — should I apply them or adjust first?',
      done: true,
      nextAction: 'awaiting_handoff_result',
      reason: null,
    };
    ee.emit('agent_end', runContext, { name: 'Orchestrator' }, decision);
    return { history: items, lastResponseId: undefined, finalOutput: decision };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'apply the change', makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'surfaces an ask instead of silently re-looping');
  const asks = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(asks.length, 1, 'exactly one synthesized ask');
  assert.equal((asks[0].data as { source?: string }).source, 'decision_awaiting_handoff_terminal');
  assert.match((asks[0].data as { question: string }).question, /prepared the changes/);
  // And it was NOT treated as a stall (no retry into the tool-only nudge).
  assert.equal(listEventsForConv(sess.id, { types: ['stall_retry_attempted'] }).length, 0);
});

test('runConversation: a tool-driven ask (ask_user_question already emitted the event) is NOT double-emitted', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async () => {
    // ask_user_question tool already emitted the halting event this turn.
    appendEvent({ sessionId: sess.id, turn: 1, role: 'Clem', type: 'awaiting_user_input', data: { question: 'staging or prod?' } });
    return { history: [], lastResponseId: undefined, finalOutput: {
      summary: 'asked', reply: 'Staging or prod?', done: false, nextAction: 'awaiting_user_input', reason: null } };
  };
  await runConversation({ agent: makeAgentStub(), sessionId: sess.id, input: 'deploy it', makeRunner: makeRunnerStub, runRunner });
  const askEvents = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(askEvents.length, 1, 'no double-emit — the tool-emitted event is the only one');
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

test('objective judge: fail-open accepted completions are tagged in conversation_completed', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'done', reply: 'Done — report saved to /tmp/report.md', done: true, nextAction: 'completed', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'build me a research report on solar adoption',
    judgeCompletion: true,
    judgeFn: async () => ({ done: true, reason: 'judge timed out — accepting completion', failedOpen: true }),
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  const completed = listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.delivered, true);
  assert.equal((completed.data.verification as { failedOpen?: boolean } | undefined)?.failedOpen, true);
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

test('honest-completion: a blocked/error-stub final reply does NOT bank as completed', async () => {
  // The Done? trust-killer: a turn that ends "I can't proceed without your
  // approval" previously returned status=completed (false green). The ungated
  // blocked-text backstop converts it to the honest awaiting_user_input.
  const sess = HarnessSession.create({ kind: 'workflow' }); // non-opted-in lane (judge never runs)
  const runner = scriptedRunner([
    { finalOutput: { summary: 'blocked', reply: 'I cannot complete this task — I need your approval to send.', done: true, nextAction: 'completed', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'send the campaign',
    makeRunner: makeRunnerStub, runRunner: runner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'blocked reply must not report completed');
  const completed = listEvents(sess.id, { types: ['conversation_completed'] });
  assert.equal(completed.at(-1)!.data.delivered, false, 'event marked not-delivered');
  assert.ok(completed.at(-1)!.data.blockedReason, 'blockedReason recorded');
});

test('honest-completion: a promise-shaped final reply is judged before banking completion', async () => {
  const sess = HarnessSession.create({ kind: 'workflow' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'promised', reply: "I'll prep those contacts and get them over next.", done: true, nextAction: 'completed', reason: null } },
  ]);
  const judgeCalls: Array<{ objective: string; response: string }> = [];
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'prep the contacts',
    judgeFn: async (objective, response) => {
      judgeCalls.push({ objective, response });
      return { done: false, reason: 'no artifact produced' };
    },
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'promise-shaped reply must not false-green');
  assert.equal(judgeCalls.length, 1, 'promise-shaped completion used the delivery judge');
  assert.match(judgeCalls[0].objective, /prep the contacts/i);
  const completed = listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.delivered, false);
  assert.match(String(completed.data.blockedReason), /no artifact produced/i);
});

test('honest-completion: promise-shaped fail-open acceptance is tagged, not silently green', async () => {
  const sess = HarnessSession.create({ kind: 'workflow' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'promised', reply: "I'll prep those contacts and get them over next.", done: true, nextAction: 'completed', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'prep the contacts',
    judgeFn: async () => ({ done: true, reason: 'judge timed out — accepting completion', failedOpen: true }),
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  const completed = listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.delivered, true);
  assert.equal((completed.data.verification as { failedOpen?: boolean } | undefined)?.failedOpen, true);
});

test('done-invariant: done:true + nextAction:awaiting_user_input does NOT bank completed', async () => {
  // `done` and `nextAction` are independent schema fields; a contradictory
  // done:true + awaiting_user_input must honor the conservative awaiting state.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'contradiction', reply: 'All set!', done: true, nextAction: 'awaiting_user_input', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'do the thing',
    makeRunner: makeRunnerStub, runRunner: runner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'contradiction → honor awaiting, not completed');
  const trips = listEvents(sess.id, { types: ['guardrail_tripped'] }).filter((e) => e.data.kind === 'done_invariant');
  assert.equal(trips.length, 1, 'done_invariant guardrail recorded');
});

test('honest-completion: a normal delivered reply still completes (delivered:true)', async () => {
  const sess = HarnessSession.create({ kind: 'workflow' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'done', reply: 'Done — report saved to /tmp/report.md', done: true, nextAction: 'completed', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'build the report',
    makeRunner: makeRunnerStub, runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!.data.delivered, true);
});

test('honest-completion: the live RESUME path (runConversationFromResume) also guards blocked replies', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeBlockedTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-blocked' });
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [{
    toolName: 'composio_execute_tool', callId: 'c1', argumentsJson: JSON.stringify({ tool_slug: 'X', arguments: '{}' }),
  }]));
  approvalRegistry.register({ sessionId: sess.id, subject: 'one draft', tool: 'composio_execute_tool', args: {} });
  const runRunner: RunRunnerFn = async () => ({
    history: [], lastResponseId: undefined,
    finalOutput: { done: true, nextAction: 'completed', reply: 'I am blocked — I need your approval to proceed.', summary: 'blocked', reason: null },
  });
  const result = await runConversationFromResume({
    agent, sessionId: sess.id, decision: 'approve', resolver: 'unit-test',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'resume blocked reply must not bank completed');
  assert.equal(listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!.data.delivered, false);
});

test('runConversationFromResume: completed decision with empty reply is retried before surfacing', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeMissingReplyTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-missing-reply' });
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [{
    toolName: 'composio_execute_tool', callId: 'c1', argumentsJson: JSON.stringify({ tool_slug: 'X', arguments: '{}' }),
  }]));
  approvalRegistry.register({ sessionId: sess.id, subject: 'one draft', tool: 'composio_execute_tool', args: {} });
  let calls = 0;
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    calls += 1;
    if (calls === 1) {
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: {
          done: true,
          nextAction: 'completed',
          reply: null,
          summary: 'Resumed approval; awaiting user request.',
          reason: null,
        },
      };
    }
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        done: true,
        nextAction: 'completed',
        reply: 'Approved - continuing with the next step.',
        summary: 'Recovered missing reply.',
        reason: null,
      },
    };
  };

  const result = await runConversationFromResume({
    agent, sessionId: sess.id, decision: 'approve', resolver: 'unit-test',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 2);
  const guardrails = listEvents(sess.id, { types: ['guardrail_tripped'] });
  assert.ok(guardrails.some((e) => (e.data as { kind?: string; path?: string }).kind === 'completed_without_reply'
    && (e.data as { path?: string }).path === 'resume'));
  const completed = listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.summary, 'Approved - continuing with the next step.');
  assert.doesNotMatch(String(completed.data.summary), /marked the turn complete|Internal log|Resumed approval/);
});

test('honest-completion: RESUME path judges promise-shaped final replies before banking completion', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumePromiseTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-promise' });
  appendEvent({
    sessionId: sess.id,
    turn: 0,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'pull the latest records' },
  });
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [{
    toolName: 'composio_execute_tool', callId: 'c1', argumentsJson: JSON.stringify({ tool_slug: 'X', arguments: '{}' }),
  }]));
  approvalRegistry.register({ sessionId: sess.id, subject: 'one draft', tool: 'composio_execute_tool', args: {} });
  const runRunner: RunRunnerFn = async () => ({
    history: [], lastResponseId: undefined,
    finalOutput: { done: true, nextAction: 'completed', reply: "I'll pull those records next.", summary: 'promised', reason: null },
  });
  const judgeCalls: Array<{ objective: string; response: string }> = [];
  const result = await runConversationFromResume({
    agent, sessionId: sess.id, decision: 'approve', resolver: 'unit-test',
    judgeFn: async (objective, response) => {
      judgeCalls.push({ objective, response });
      return { done: false, reason: 'no records were returned' };
    },
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'resume promise-shaped reply must not bank completed');
  assert.equal(judgeCalls.length, 1);
  assert.match(judgeCalls[0].objective, /pull the latest records/i);
  const completed = listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.delivered, false);
  assert.match(String(completed.data.blockedReason), /no records were returned/i);
});

test('resume budget exit emits the PAIRED conversation_completed (bare limit event hangs the chat dock / Discord)', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeBudgetTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-budget' });
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [{
    toolName: 'composio_execute_tool', callId: 'c1', argumentsJson: JSON.stringify({ tool_slug: 'X', arguments: '{}' }),
  }]));
  approvalRegistry.register({ sessionId: sess.id, subject: 'one draft', tool: 'composio_execute_tool', args: {} });
  // The resumed turn (and every continuation) keeps working → the loop runs to maxSteps.
  const recurseForever = scriptedRunner([
    { finalOutput: { summary: 'still working', done: false, nextAction: 'awaiting_handoff_result', reason: null } },
  ]);
  const result = await runConversationFromResume({
    agent, sessionId: sess.id, decision: 'approve', resolver: 'unit-test',
    maxSteps: 3,
    makeRunner: makeRunnerStub, runRunner: recurseForever,
  });
  assert.equal(result.status, 'limit_exceeded');
  // The audit event AND the paired user-facing completion must BOTH be present —
  // the clients (chat.ts isTerminalEvent, console.ts SSE, Discord) treat a bare
  // conversation_limit_exceeded as NON-terminal and wait for the pair, so a bare
  // emit on the resume path hangs the surface until its idle/safety timeout.
  assert.ok(listEventsForConv(sess.id, { types: ['conversation_limit_exceeded'] }).length >= 1, 'audit limit event present');
  const paired = listEventsForConv(sess.id, { types: ['conversation_completed'] })
    .find((e) => (e.data as { reason?: unknown }).reason === 'awaiting_continue');
  assert.ok(paired, 'resume budget exit MUST emit a paired conversation_completed(reason=awaiting_continue)');
});

test('resume path: narration-deferral in a continuation turn is force-corrected (was an UNGUARDED path)', async () => {
  // Audit 2026-06-16, headline gap: runConversationFromResumeCore never called
  // evaluateStructuredDecisionStall, so EVERY stall detector (narration-deferral,
  // zero-tool false-completion) was bypassed the moment a user approved an action.
  // A post-approval continuation turn that narration-defers (awaiting_handoff_result,
  // zero tools) must now be force-corrected in the resume path too.
  resetEventLog();
  const agent = new Agent({ name: 'ResumeDeferralTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-deferral' });
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [{
    toolName: 'composio_execute_tool', callId: 'c1', argumentsJson: JSON.stringify({ tool_slug: 'X', arguments: '{}' }),
  }]));
  approvalRegistry.register({ sessionId: sess.id, subject: 'the pull', tool: 'composio_execute_tool', args: {} });
  let i = 0;
  const scripted: unknown[] = [
    // #1 the approved turn resumes; not done yet → drives the continuation loop.
    { done: false, nextAction: 'awaiting_handoff_result', reply: 'Approved — continuing.', summary: 'resumed after approval', reason: null },
    // #2 CONTINUATION narration-deferral with zero tools — must be caught in the resume path.
    { done: false, nextAction: 'awaiting_handoff_result', reply: 'On it — running the pull now. One sec.', summary: 'about to pull', reason: null },
    // #3 forced retry → clean completion (neutral reply that trips no detector).
    { done: true, nextAction: 'completed', reply: 'Here are the 12 records.', summary: 'Returned the records.', reason: null },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const o = scripted[i] ?? scripted[scripted.length - 1]; i += 1;
    return { history: items, lastResponseId: undefined, finalOutput: o };
  };
  const result = await runConversationFromResume({
    agent, sessionId: sess.id, decision: 'approve', resolver: 'unit-test',
    makeRunner: makeRunnerStub, runRunner,
  });
  const stuck = listEvents(sess.id, { types: ['stuck_detected'] });
  assert.ok(stuck.length >= 1, 'resume continuation narration-deferral must be caught');
  assert.equal((stuck[0].data as { kind: string }).kind, 'structured_narration_deferral');
  const resumeRetry = listEvents(sess.id, { types: ['stall_retry_attempted'] })
    .filter((e) => (e.data as { path?: string }).path === 'resume');
  assert.ok(resumeRetry.length >= 1, 'a resume-path stall retry fired');
  assert.equal(result.status, 'completed');
});

test('honest-completion: kill-switch off leaves blocked text completing (byte-identical)', async () => {
  const prev = process.env.CLEMMY_VERIFY_DELIVERED;
  process.env.CLEMMY_VERIFY_DELIVERED = 'off';
  try {
    const sess = HarnessSession.create({ kind: 'workflow' });
    const runner = scriptedRunner([
      { finalOutput: { summary: 'blocked', reply: 'I cannot complete this task without approval.', done: true, nextAction: 'completed', reason: null } },
    ]);
    const result = await runConversation({
      agent: makeAgentStub(), sessionId: sess.id, input: 'send it',
      makeRunner: makeRunnerStub, runRunner: runner,
    });
    assert.equal(result.status, 'completed', 'disabled → prior behavior');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_VERIFY_DELIVERED;
    else process.env.CLEMMY_VERIFY_DELIVERED = prev;
  }
});

test('objective judge: off by default for non-promise answer (no judgeCompletion opt-in)', async () => {
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
  assert.equal(judgeInvoked, false, 'plain delivered reply must not invoke the judge unless judgeCompletion is opted in');
});

test('objective judge: continuation budget caps retries, then delivery verifier blocks a remaining promise', async () => {
  // Pin the budget explicitly (default dropped 3→2 for token thrift, Phase 3) so
  // this is hermetic against the live .env and documents the knob.
  const prevMax = process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
  process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = '2';
  try {
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
    assert.equal(result.status, 'awaiting_user_input');
    assert.equal(judgeCalls, 3, '2 judge-forced continuations + 1 final delivery verification');
    assert.equal(result.steps, 3, '2 judge-forced continuations + the final not-delivered boundary');
    const completed = listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!;
    assert.equal(completed.data.delivered, false);
    assert.match(String(completed.data.blockedReason), /still nothing produced/i);
  } finally {
    if (prevMax === undefined) delete process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
    else process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = prevMax;
  }
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
        reply: 'All three steps complete; sheet created.',
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

test('runConversation: a non-envelope plain-text final output is a VALID completed reply (fail-open)', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ finalOutput: 'a plain string, not a Decision' }]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'whatever',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  // NEW CONTRACT (plain-text marker): any non-empty text without a marker is a
  // valid completed reply — never dropped as 'no_structured_output', never
  // retried as D_decision_unparsed.
  assert.equal(result.status, 'completed');
  const completedEvents = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.notEqual(completedEvents[0].data.reason, 'no_structured_output');
  assert.equal(completedEvents[0].data.reply, 'a plain string, not a Decision');
  const retries = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(
    retries.filter((e) => (e.data as { signal?: string }).signal === 'D_decision_unparsed').length,
    0,
    'non-empty output must never fire the D_decision_unparsed retry',
  );
});

// ─── Plain-text marker contract: parse table ──────────────────────────────
test('toOrchestratorDecision: plain-text marker parse table (ASK / CONTINUE / no-marker / case / whitespace)', () => {
  // No marker → the whole text is the completed, user-facing reply (fail-open).
  const plain = toOrchestratorDecision('Here is your answer: 42.');
  assert.equal(plain?.done, true);
  assert.equal(plain?.nextAction, 'completed');
  assert.equal(plain?.reply, 'Here is your answer: 42.');

  // ASK: marker → pause for the user; body is the question.
  const ask = toOrchestratorDecision('ASK: Which environment — staging or prod?');
  assert.equal(ask?.done, false);
  assert.equal(ask?.nextAction, 'awaiting_user_input');
  assert.equal(ask?.reply, 'Which environment — staging or prod?');

  // CONTINUE: marker → keep looping (not done, no user-facing reply).
  const cont = toOrchestratorDecision('CONTINUE: scraped page 1, fetching page 2');
  assert.equal(cont?.done, false);
  assert.equal(cont?.nextAction, 'awaiting_handoff_result');
  assert.equal(cont?.reply, null);

  // Lowercase marker (case-insensitive).
  const lower = toOrchestratorDecision('ask: what timezone?');
  assert.equal(lower?.nextAction, 'awaiting_user_input');
  assert.equal(lower?.reply, 'what timezone?');

  // Leading whitespace/newlines before the marker.
  const pad = toOrchestratorDecision('\n\n   CONTINUE: still working');
  assert.equal(pad?.nextAction, 'awaiting_handoff_result');
  assert.equal(pad?.done, false);

  // A model still emitting the JSON envelope is parsed as the decision (back-compat).
  const json = toOrchestratorDecision('{"summary":"s","reply":"Done.","done":true,"nextAction":"completed","reason":null}');
  assert.equal(json?.done, true);
  assert.equal(json?.reply, 'Done.');
});

test('toOrchestratorDecision: a 40KB no-marker body is ONE valid completed reply (never unparseable)', () => {
  const huge = 'The full report follows.\n\n' + 'x'.repeat(40_000);
  const decision = toOrchestratorDecision(huge);
  assert.ok(decision, 'a giant body must never parse to null');
  assert.equal(decision?.done, true);
  assert.equal(decision?.nextAction, 'completed');
  assert.equal(decision?.reply, huge, 'the entire body is the reply — not truncated, not dropped');
  // Summary is derived IN CODE (first sentence / ≤200 chars), never demanded.
  assert.ok((decision?.summary?.length ?? 0) <= 200);
});

test('toOrchestratorDecision: empty / recovery-sentinel output stays null (stall-retry path unchanged)', () => {
  assert.equal(toOrchestratorDecision(''), null);
  assert.equal(toOrchestratorDecision('   \n  '), null);
  assert.equal(
    toOrchestratorDecision("Clementine produced a response that couldn't be structured. Please ask again."),
    null,
    'the empty-turn sentinel stays null so the existing stall-retry path handles it',
  );
});

test('runConversation: synthetic parse retry classifies against the original tool-backed ask', async () => {
  resetEventLog();
  // The "scorpion" shorthand only scopes Outlook because the user has a
  // pinned-calendar constraint naming that label — seed it so this test
  // proves the full data-driven chain (constraint fact → label → tool scope).
  rememberFact({
    kind: 'constraint',
    content: 'For Scorpion calendar lookups, use Outlook connection ca_LoopTestRoute1 as the Scorpion calendar connection.',
  });
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: "Clementine produced a response that couldn't be structured. Please ask again." },
    {
      finalOutput: {
        summary: 'Recovered the Scorpion calendar check.',
        reply: 'Recovered with Outlook calendar tools available.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    },
  ]);

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Check my scorpion for tomorrow',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });

  assert.equal(result.status, 'completed');
  const packets = listEventsForConv(sess.id, { types: ['agent_context_packet'] });
  assert.ok(packets.length >= 2, 'expected original turn plus synthetic retry turn');
  const retryPacket = packets[1].data as {
    inputPreview?: string;
    toolScope?: { allowedServerSlugs?: string[]; reason?: string };
  };
  assert.match(retryPacket.inputPreview ?? '', /Check my scorpion for tomorrow/i);
  assert.ok(
    (retryPacket.toolScope?.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)),
    'retry must preserve Outlook calendar reach from the original user ask',
  );
});

test('runConversation: malformed decision AFTER real tool work RETRIES instead of dying (D_decision_unparsed)', async () => {
  // Repro from a live website build+deploy: the Orchestrator did real
  // tool work (loaded skills, wrote files) and then emitted the
  // deliverable (HTML) inline, breaking the structured-decision shape.
  // Before the fix the run died with reason 'no_structured_output' and
  // the user saw "produced a response that couldn't be structured" with
  // no recourse — even though work was in flight. The did-work-then-
  // malformed case must RETRY (re-prompt for the decision + next action)
  // so the task actually finishes. (Zero-tool malformed nulls still go
  // straight to no_structured_output — covered by the test above.)
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let call = 0;
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    call += 1;
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: opts.context };
    if (call === 1) {
      // Real tool work, then a malformed (non-Decision) finalOutput.
      ee.emit('agent_start', runContext, { name: 'Orchestrator' });
      ee.emit(
        'agent_tool_start',
        runContext,
        { name: 'Orchestrator' },
        { name: 'skill_read' },
        { toolCall: { callId: 'call_1', arguments: '{"name":"taste-skill"}' } },
      );
      ee.emit(
        'agent_tool_start',
        runContext,
        { name: 'Orchestrator' },
        { name: 'write_file' },
        { toolCall: { callId: 'call_2', arguments: '{"path":"/tmp/site/index.html"}' } },
      );
      const output = '<!doctype html><html><body>the whole site inlined instead of a decision</body></html>';
      ee.emit('agent_end', runContext, { name: 'Orchestrator' }, output);
      return { history: items, lastResponseId: undefined, finalOutput: output };
    }
    // Retry turn: now it issues the proper structured decision and finishes.
    const decision = {
      summary: 'Built and deployed the site',
      reply: 'Done — deployed to https://example.netlify.app',
      done: true,
      nextAction: 'completed',
      reason: null,
    };
    ee.emit('agent_start', runContext, { name: 'Orchestrator' });
    ee.emit('agent_end', runContext, { name: 'Orchestrator' }, decision);
    return { history: items, lastResponseId: undefined, finalOutput: decision };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'build and deploy a website',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  // NEW CONTRACT: the inline deliverable IS a valid reply — the run completes on
  // the FIRST turn with ZERO D_decision_unparsed retries (this is the exact
  // landing-page failure class the plain-text contract eliminates).
  const retries = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  const unparsed = retries.filter((e) => (e.data as { signal?: string }).signal === 'D_decision_unparsed');
  assert.equal(unparsed.length, 0, 'no unparseable-decision retry — inline output is delivered as the reply');

  assert.equal(result.status, 'completed');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.notEqual(
    completed[0].data.reason,
    'no_structured_output',
    'did-work-then-inline-deliverable completes, never dies with no_structured_output',
  );
  assert.match(String(completed[0].data.reply ?? ''), /the whole site inlined/);
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
  // NEW CONTRACT: a substantive terse reply is delivered as the completed reply,
  // not routed through the malformed 'no_structured_output' path.
  assert.notEqual(completedEvents[0].data.reason, 'sub_agent_stalled');
  assert.equal(completedEvents[0].data.reply, 'Added 5 rows to the sheet.');
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

test("runConversation: a zero-tool reflective TEXT reply is NOT flagged as a Signal A' stall", async () => {
  // Parity fix: when the model returns a PLAIN STRING (not an
  // OrchestratorDecision object) that is a reflective/alignment turn carrying
  // a stray future-tense "I'll", the TEXT-path detector (evaluateProgress
  // Signal A') must apply the same reflection suppression the structured path
  // already did. Before the fix this false-fired "announced work but didn't
  // call the tool" and forced a needless retry on a legitimate reply.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: "You're right — going forward I'll treat SEO data as raw metrics first." },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'correction: that seo data was too light',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.steps, 1, 'a reflective text reply must complete in one step, not retry');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 0, "a reflective text reply must not trip Signal A'");
});

test("runConversation: a zero-tool false-claim TEXT reply still fires Signal A' (no over-suppression)", async () => {
  // Positive control for the text path: a real fake-completion string ("Sent
  // the email …") carries no reflection markers, so the suppressor must NOT
  // shield it — the announcement stall must still fire.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: 'Sent the email to the team.' },
  ]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'send the email',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.ok(stuckEvents.length >= 1, 'a false completion claim in plain text must still be flagged');
  assert.equal((stuckEvents[0].data as { signal: string }).signal, 'A_zero_tools');
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
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'draft something',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  // NEW CONTRACT: a model still emitting the JSON envelope is PARSED into the
  // decision (a graceful transition), not flagged as a stall. Here the decision
  // is awaiting_user_input, so the run surfaces the question and pauses.
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.ok(
    !stuckEvents.some((e) => (e.data as { signal?: string }).signal === 'D_decision_json'),
    'a valid JSON decision is used, not flagged as a stall',
  );
  assert.equal(result.status, 'awaiting_user_input');
  const asks = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
  assert.ok(asks.length >= 1, 'the question was surfaced');
  assert.match(String((asks[0].data as { question?: string }).question ?? ''), /draft|ship it/i);
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

test('runConversation: narration-deferral (awaiting_handoff_result + 0 tools, no "unavailable" text) is force-corrected', async () => {
  // Live repro sess-mqhj058j (2026-06-16): user asked to pull 25 Salesforce
  // accounts (one `sf data query`). Claude replied "On it. Running the Market
  // Leader pull now — I'll pull 25." with done:false, nextAction:
  // awaiting_handoff_result, and ZERO tool calls — promising imminent action and
  // deferring to a phantom executor. The text does NOT claim tools are
  // unavailable, so the old detectors missed it and the loop auto-continued into
  // another narration turn. The narration-deferral guard must catch it and force
  // the actual tool action on the retry.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const scripted: unknown[] = [
    {
      summary: 'User confirmed criteria; proceeding to query Salesforce for 25 stale accounts',
      reply: 'On it. Running the Market Leader pull now — your owned accounts, no activity >15 days. I\'ll pull 25.',
      done: false,
      nextAction: 'awaiting_handoff_result',
      reason: 'Next step is querying Salesforce via the sf CLI.',
    },
    {
      summary: 'Ran sf data query and returned the 25 accounts.',
      reply: 'Pulled 25 accounts. Here they are: …',
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
    input: 'pull me 25 accounts from salesforce I have not contacted in 15 days',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'structured_narration_deferral');
  assert.equal((stuckEvents[0].data as { nextAction: string }).nextAction, 'awaiting_handoff_result');
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1);
});

test('runConversation: discover-then-defer (only tool_choice_recall/local_cli_list, no execution) is force-corrected', async () => {
  // Companion to the narration-deferral repro: turn 4 of sess-mqhj058j did ONLY
  // discovery (tool_choice_recall ×2 + local_cli_list) and then deferred again
  // with awaiting_handoff_result. Discovery-ritual tools are probes, so a
  // probe-only turn that defers is still the deferral anti-pattern and must be
  // force-corrected, not rewarded with a bland auto-continue.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const scripted: unknown[] = [
    {
      summary: 'Querying Salesforce via sf CLI for 25 owned market-leader accounts',
      reply: 'Pulling them now.',
      done: false,
      nextAction: 'awaiting_handoff_result',
      reason: 'Running the confirmed pull.',
    },
    {
      summary: 'Returned the account list after retry.',
      reply: 'Here are the 25 accounts: Acme, Globex, Initech, and 22 more.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  const runRunner: RunRunnerFn = async (runner, _a, items) => {
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    if (scriptIndex === 1) {
      // Discovery-only turn: two probe-classified discovery calls, no execution.
      for (const tool of ['tool_choice_recall', 'local_cli_list']) {
        (runner as unknown as EventEmitter).emit('agent_tool_start');
        appendEvent({
          sessionId: sess.id,
          turn: 1,
          role: 'Clem',
          type: 'tool_called',
          data: { tool, callId: `call_${tool}`, arguments: '{}' },
        });
      }
    }
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'continue the pull',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'structured_narration_deferral');
  assert.equal((stuckEvents[0].data as { onlyProbeTools: boolean }).onlyProbeTools, true);
});

test('runConversation: SILENT narration-deferral (awaiting_handoff_result, all text empty, 0 tools) is caught', async () => {
  // Audit 2026-06-16: the empty-`combined` early return in evaluateStructuredDecisionStall
  // fired BEFORE the narration-deferral check, so a wordless hold turn
  // ({nextAction:awaiting_handoff_result, reply:null, summary:'   '}) escaped into a
  // bland auto-continue. The silent-defer guard now catches it before the early return.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let i = 0;
  const scripted: unknown[] = [
    { summary: '   ', reply: null, reason: null, done: false, nextAction: 'awaiting_handoff_result' },
    { summary: 'Returned the records.', reply: 'Here are the 12 records.', done: true, nextAction: 'completed', reason: null },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const o = scripted[i] ?? scripted[scripted.length - 1]; i += 1;
    return { history: items, lastResponseId: undefined, finalOutput: o };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'pull it',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  const stuck = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuck.length, 1);
  assert.equal((stuck[0].data as { kind: string }).kind, 'structured_narration_deferral');
  assert.equal((stuck[0].data as { silent?: boolean }).silent, true);
});

test('runConversation: zero-tool ABANDONED claim with announcement is force-corrected (was bypassing the judge)', async () => {
  // Audit 2026-06-16: a bare "searched everywhere, abandoning" + zero tools banked as a
  // clean terminal WITHOUT the objective judge (which only runs on nextAction:completed)
  // or any blocked-text check. The zero-tool-claim branch now also fires on `abandoned`.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let i = 0;
  const scripted: unknown[] = [
    { summary: 'Could not find it; abandoning.', reply: 'I searched everywhere and am abandoning this — it is impossible to find.', done: true, nextAction: 'abandoned', reason: null },
    { summary: 'Returned the records.', reply: 'Here are the 12 records.', done: true, nextAction: 'completed', reason: null },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const o = scripted[i] ?? scripted[scripted.length - 1]; i += 1;
    return { history: items, lastResponseId: undefined, finalOutput: o };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'find the record',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  const stuck = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuck.length, 1);
  assert.equal((stuck[0].data as { kind: string }).kind, 'structured_zero_tool_claim');
  assert.equal((stuck[0].data as { nextAction: string }).nextAction, 'abandoned');
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

// BUG 1 (2026-06-15 Brooke email-find): a done:true completion that REPORTS the
// result of work done in PRIOR turns must NOT be flagged a zero-tool prose claim.
test('runConversation: done:true completion reporting PRIOR tool work is NOT a zero-tool stall (Brooke fix)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // Prior-turn substantive (non-probe) tool work — the real Outlook searches.
  appendEvent({
    sessionId: sess.id, turn: 0, role: 'Clem', type: 'tool_called',
    data: { tool: 'outlook_email_search', callId: 'c_prior', arguments: '{"query":"Brooke"}' },
  });
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({
    history: items, lastResponseId: undefined,
    finalOutput: {
      summary: 'Searched Outlook inbox and mailbox for Brooke this afternoon; no results.',
      reply: "I searched this afternoon and didn't find any email from Brooke — the only afternoon hit was Stripe at 12:18.",
      done: true, nextAction: 'completed', reason: null,
    },
  });
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'find the email from Brooke',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  // The false zero-tool stall must NOT fire (prior real work exists).
  assert.equal(listEventsForConv(sess.id, { types: ['stuck_detected'] }).length, 0);
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 0);
  // And the model's answer is delivered.
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.ok(completed.length >= 1);
  assert.match(String((completed.at(-1)!.data as { summary?: string }).summary ?? ''), /Brooke/);
});

test('runConversation: HARNESS_STALL_PRIOR_WORK=off restores the legacy zero-tool stall (kill-switch)', async () => {
  const prev = process.env.HARNESS_STALL_PRIOR_WORK;
  process.env.HARNESS_STALL_PRIOR_WORK = 'off';
  try {
    resetEventLog();
    const sess = HarnessSession.create({ kind: 'chat' });
    appendEvent({
      sessionId: sess.id, turn: 0, role: 'Clem', type: 'tool_called',
      data: { tool: 'outlook_email_search', callId: 'c0', arguments: '{}' },
    });
    const runRunner: RunRunnerFn = async (_r, _a, items) => ({
      history: items, lastResponseId: undefined,
      finalOutput: { summary: 'Searched Outlook for Brooke; no results.', reply: 'I searched and found nothing.', done: true, nextAction: 'completed', reason: null },
    });
    await runConversation({ agent: makeAgentStub(), sessionId: sess.id, input: 'find Brooke email', makeRunner: makeRunnerStub, runRunner });
    const stuck = listEventsForConv(sess.id, { types: ['stuck_detected'] });
    assert.ok(stuck.length >= 1, 'with the kill-switch off, the legacy stall fires again');
    assert.equal((stuck[0].data as { kind: string }).kind, 'structured_zero_tool_claim');
  } finally {
    if (prev === undefined) delete process.env.HARNESS_STALL_PRIOR_WORK; else process.env.HARNESS_STALL_PRIOR_WORK = prev;
  }
});

// BUG 2: a coherent answer that failed the STRICT decision parse is DELIVERED,
// not turned into the confusing "unable to make progress" prompt.
test('runConversation: a coherent reply that failed strict parse is salvaged + delivered (not a stuck prompt)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // A valid answer emitted as a JSON STRING — the strict parser rejects it
  // (typeof !== 'object') → D_decision_json carries the model's own reply.
  // Wording deliberately avoids past-tense action verbs so Signal A' (the
  // announcement-stall, checked first) does not pre-empt Signal D.
  const jsonString = JSON.stringify({
    summary: 'No email from Brooke is present in the inbox for this afternoon.',
    reply: "There's no email from Brooke this afternoon — the only afternoon item is a Stripe notification.",
    done: true, nextAction: 'completed', reason: null,
  });
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({ history: items, lastResponseId: undefined, finalOutput: jsonString });
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'find the email from Brooke',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  // NEW CONTRACT: the JSON envelope is parsed directly into the decision and its
  // reply delivered — no 'salvage' detour, no confusing "unable to make progress".
  assert.match(String(completed[0].data.reply ?? completed[0].data.summary ?? ''), /Brooke/);
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 0);
});

test('runConversation: a GENUINE punt (announcement, zero tools, no answer) is NEVER salvaged', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // An announcement with zero tools → A_zero_tools, NOT D_decision_json → the
  // salvage (gated on D_decision_json with a real reply) must never deliver it.
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({ history: items, lastResponseId: undefined, finalOutput: "I'll run the Outlook search now." });
  await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'do the thing',
    makeRunner: makeRunnerStub, runRunner,
  });
  const stuck = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.ok(stuck.some((e) => (e.data as { signal?: string }).signal === 'A_zero_tools'), 'a genuine punt is detected as a stall');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.ok(!completed.some((e) => (e.data as { reason?: string }).reason === 'decision_json_salvaged'), 'an announcement punt is never salvaged');
});

// 2026-06-15 (scorpion-mailbox Brooke): an EMPTY/unstructured turn (items:1,
// lastResponseId:null, zero tools) dropped straight to "couldn't be structured.
// Please ask again." with no retry. It must be re-prompted instead.
test('runConversation: an EMPTY zero-tool turn is RETRIED, then recovers (not dropped as "couldn\'t be structured")', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // The empty-response sentinel runTurn synthesizes for an items:1/lastResponseId:null model turn.
  const EMPTY_SENTINEL = "Clementine produced a response that couldn't be structured. Please ask again.";
  let i = 0;
  const scripted: unknown[] = [
    EMPTY_SENTINEL, // turn 1: empty model response
    { summary: 'Located the message.', reply: 'Found it — the email from Brooke arrived at 9:14am.', done: true, nextAction: 'completed', reason: null },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const output = scripted[i] ?? scripted[scripted.length - 1];
    i += 1;
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };
  const result = await runConversation({ agent: makeAgentStub(), sessionId: sess.id, input: 'find the email from Brooke', makeRunner: makeRunnerStub, runRunner });
  assert.equal(result.status, 'completed');
  const retries = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.ok(retries.some((e) => (e.data as { emptyOutput?: boolean }).emptyOutput === true), 'the empty turn was retried');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.match(String((completed.at(-1)!.data as { summary?: string }).summary ?? ''), /Brooke/);
  assert.ok(!completed.some((e) => (e.data as { reason?: string }).reason === 'no_structured_output'), 'did not give up with "couldn\'t be structured"');
});

test('runConversation: a PERSISTENTLY empty response exhausts retries then completes (bounded — no infinite loop)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const EMPTY_SENTINEL = "Clementine produced a response that couldn't be structured. Please ask again.";
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({ history: items, lastResponseId: undefined, finalOutput: EMPTY_SENTINEL });
  const result = await runConversation({ agent: makeAgentStub(), sessionId: sess.id, input: 'do the thing', makeRunner: makeRunnerStub, runRunner });
  assert.equal(result.status, 'completed');
  assert.ok(listEventsForConv(sess.id, { types: ['stall_retry_attempted'] }).length >= 1, 'it retried before giving up');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.ok(completed.some((e) => (e.data as { reason?: string }).reason === 'no_structured_output'), 'the fallback stands after retries exhaust');
});

test('runConversation: HARNESS_STALL_RETRY_EMPTY=off restores the immediate "couldn\'t be structured" (kill-switch)', async () => {
  const prev = process.env.HARNESS_STALL_RETRY_EMPTY;
  process.env.HARNESS_STALL_RETRY_EMPTY = 'off';
  try {
    resetEventLog();
    const sess = HarnessSession.create({ kind: 'chat' });
    const EMPTY_SENTINEL = "Clementine produced a response that couldn't be structured. Please ask again.";
    const runRunner: RunRunnerFn = async (_r, _a, items) => ({ history: items, lastResponseId: undefined, finalOutput: EMPTY_SENTINEL });
    await runConversation({ agent: makeAgentStub(), sessionId: sess.id, input: 'do the thing', makeRunner: makeRunnerStub, runRunner });
    // Kill-switch off → no empty-output retry → immediate no_structured_output.
    const retries = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] }).filter((e) => (e.data as { emptyOutput?: boolean }).emptyOutput === true);
    assert.equal(retries.length, 0);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_STALL_RETRY_EMPTY; else process.env.HARNESS_STALL_RETRY_EMPTY = prev;
  }
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

test('isCodexAuthRevoked: a real revoke marker is terminal; a BARE model 401 is NOT (refresh-and-retry, no brick)', async () => {
  const { markCodexAuthDead, clearCodexAuthDead, isCodexAuthDead } = await import('../auth-store.js');
  clearCodexAuthDead();
  assert.equal(isCodexAuthDead(), false, 'precondition: auth not latched dead');

  // Real revoke markers ARE terminal (these genuinely mean re-login).
  assert.equal(isCodexAuthRevoked(new Error('Encountered invalidated oauth token for user, failing request'), 'Encountered invalidated oauth token for user, failing request'), true);
  assert.equal(isCodexAuthRevoked({}, 'token_revoked'), true);
  assert.equal(isCodexAuthRevoked({ status: 401 }, 'Codex /responses returned 401: invalid_grant'), true, 'a 401 carrying a revoke marker is terminal');

  // THE FIX: a marker-less model 401 (access-token expiry / edge reject) must
  // NOT be classified as a revoke — streamCodex already force-refreshed+retried
  // it, so latching DEAD here is the bug that bricked users on a transient blip.
  assert.equal(isCodexAuthRevoked({ status: 401 }, 'Codex /responses returned 401 Unauthorized'), false, 'a bare 401 no longer bricks auth');

  // …unless auth is genuinely DEAD (the refresh token itself was rejected, which
  // latches DEAD inside refreshStoredNativeOAuth) — then even a bare 401 is terminal.
  markCodexAuthDead('refresh token revoked');
  assert.equal(isCodexAuthRevoked({ status: 401 }, 'Codex /responses returned 401 Unauthorized'), true, 'once DEAD-latched, surface re-auth');

  // 2026-07-07 regression: the DEAD latch is a fact about CODEX auth, not a
  // verdict on every error. While latched, a DIFFERENT brain's unrelated
  // failure must NOT be rebranded as "Codex sign-in expired" (observed live:
  // a GLM/Together run hard-failed with the Codex re-auth message while the
  // real error was a Together credit-limit 402 — terminal + cause masked).
  assert.equal(
    isCodexAuthRevoked({ status: 402 }, '402 Credit limit exceeded, please add credits'),
    false,
    'latched + non-auth-shaped (BYO 402) stays recoverable',
  );
  assert.equal(
    isCodexAuthRevoked(new Error('model backend timeout'), 'model backend timeout'),
    false,
    'latched + generic model error stays recoverable',
  );
  // …while codex-lane / auth-shaped errors still hit the latch.
  assert.equal(
    isCodexAuthRevoked({ status: 403 }, 'forbidden'),
    true,
    'latched + auth-shaped (403) surfaces re-auth',
  );
  clearCodexAuthDead();

  // Not auth: a 429 rate limit or a generic failure must NOT be misclassified.
  assert.equal(isCodexAuthRevoked({ status: 429 }, 'Codex /responses returned 429'), false);
  assert.equal(isCodexAuthRevoked(new Error('scripted_throw'), 'scripted_throw'), false);
  assert.equal(isCodexAuthRevoked(null, 'some tool failed'), false);
});

// ─── 2026-06-12: async workflow dispatch is a complete deliverable ───────────

test('dispatchedBackgroundWorkflowRun: detects a queued workflow_run this turn, not other turns/tools', async () => {
  const { dispatchedBackgroundWorkflowRun } = await import('./loop.js');
  const { writeToolOutput } = await import('./eventlog.js');
  const sess = createSession({ kind: 'chat' });

  // No calls at all → false.
  assert.equal(dispatchedBackgroundWorkflowRun(sess.id, 1), false);

  // A queued dispatch on turn 1.
  appendEvent({
    sessionId: sess.id, turn: 1, role: 'system', type: 'tool_called',
    data: { tool: 'workflow_run', callId: 'call_wfrun_1', arguments: '{"name":"x"}' },
  });
  writeToolOutput({
    sessionId: sess.id, callId: 'call_wfrun_1', tool: 'workflow_run',
    output: 'Queued "x" (run 123-abc) — it is now running in the BACKGROUND. Tell the user…',
  });
  assert.equal(dispatchedBackgroundWorkflowRun(sess.id, 1), true, 'queued dispatch this turn is detected');
  assert.equal(dispatchedBackgroundWorkflowRun(sess.id, 2), false, 'a different turn does not inherit the dispatch');

  // A workflow_run whose output is NOT a queue success (e.g. validation refusal) → false.
  const sess2 = createSession({ kind: 'chat' });
  appendEvent({
    sessionId: sess2.id, turn: 1, role: 'system', type: 'tool_called',
    data: { tool: 'workflow_run', callId: 'call_wfrun_2', arguments: '{"name":"y"}' },
  });
  writeToolOutput({
    sessionId: sess2.id, callId: 'call_wfrun_2', tool: 'workflow_run',
    output: 'Workflow "y" is disabled.',
  });
  assert.equal(dispatchedBackgroundWorkflowRun(sess2.id, 1), false, 'a refused dispatch still gets judged');
});

test('speed: a hanging embeddings provider cannot gate model dispatch (fire-and-forget recall vector)', async () => {
  // Live incident 2026-07-03: the OpenAI embeddings endpoint degraded (6s fetch
  // timeouts + retries) and, because the turn awaited Promise.all(primer,
  // primeTurnRecallVector), EVERY turn paid the full embed wait before the
  // model dispatched — 9.9s pre-brain on a greeting. The recall vector is an
  // opportunistic enrichment (TTL'd slot read at fact-recall time; late arrival
  // still helps, absence just drops the relevance term), so it must be
  // fire-and-forget. This pins that: an embed that NEVER resolves must not
  // delay the model beyond the primer's own bounded budget.
  resetEventLog();
  const { _setEmbeddingProviderForTest } = await import('../../memory/embeddings.js');
  const sess = HarnessSession.create({ kind: 'chat' });
  _setEmbeddingProviderForTest({
    name: 'hang',
    model: 'hang-test',
    dim: 4,
    embed: () => new Promise(() => { /* never resolves */ }),
  } as never);
  try {
    let modelDispatchedAtMs = 0;
    const startedAtMs = Date.now();
    const runRunner: RunRunnerFn = async (_agent, items) => {
      modelDispatchedAtMs = Date.now();
      return {
        history: items as never,
        lastResponseId: undefined,
        finalOutput: { summary: 'fast', reply: 'hi', done: true, nextAction: 'completed', reason: null },
      } as never;
    };
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'hello there',
      makeRunner: makeRunnerStub,
      runRunner,
    });
    assert.equal(result.status, 'completed');
    assert.ok(modelDispatchedAtMs > 0, 'model was dispatched');
    const preBrainMs = modelDispatchedAtMs - startedAtMs;
    // Pre-fix this waited on the hanging embed until the 15s assembly outer
    // race fired. Post-fix the wait is the primer's own bounded budget (800ms
    // hybrid race + fts overhead). 5s = generous CI headroom, far below 15s.
    assert.ok(preBrainMs < 5_000, `pre-brain wait gated by hanging embed: ${preBrainMs}ms`);
  } finally {
    _setEmbeddingProviderForTest(undefined as never);
  }
});
