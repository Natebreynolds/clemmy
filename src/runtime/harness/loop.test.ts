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
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-harness-loop-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AgentInputItem, Runner } from '@openai/agents';

const { resetEventLog, requestKill, listEvents, createSession } = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runTurn, runConversation } = await import('./loop.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;
const { ToolCallsLimitExceeded } = await import('./brackets.js');
const { listEvents: listEventsForConv } = await import('./eventlog.js');
const approvalRegistry = await import('./approval-registry.js');

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

test('completed run snapshots conversation and emits run_completed', async () => {
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
  assert.equal(reloaded!.sessionRow.status, 'completed');
  // user turn input was recorded
  const userInputs = listEvents(sess.id, { types: ['user_input_received'] });
  assert.equal(userInputs.length, 1);
  assert.equal(userInputs[0].data.text, 'do the thing');
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
  const tripped = listEvents(sess.id, { types: ['guardrail_tripped'] });
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
        summary: 'created the README in one shot',
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
