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
const { runTurn } = await import('./loop.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;
const { ToolCallsLimitExceeded } = await import('./brackets.js');

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

test('previousResponseId is threaded into opts on the next turn', async () => {
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

  // Re-mark active between turns so the second turn isn't blocked.
  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'first',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  // The session is now "completed". Mark it active for a follow-up.
  const after1 = HarnessSession.load(sess.id)!;
  // (no public reopen helper yet — drop down to updateSession)
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
  assert.equal(seenOpts[0].previousResponseId, undefined, 'first turn has no prior');
  assert.equal(seenOpts[1].previousResponseId, 'resp_1', 'second turn passes back resp_1');
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
