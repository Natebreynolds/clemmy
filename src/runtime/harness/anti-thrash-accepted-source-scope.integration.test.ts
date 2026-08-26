/**
 * Production-composition regression for accepted-source anti-thrash scope.
 *
 * A harness continuation (or an infra/fallover retry) advances the physical
 * turn, but it does not create new user authority. The write-runaway tracker
 * must therefore survive both that turn advance and a daemon restart. Only a
 * genuinely new accepted user source gets a fresh behavior window.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-anti-thrash-source-scope-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_GUARDRAIL_PERSIST = 'on';
process.env.CLEMMY_GUARDRAIL_EXACT_BLOCK = '5';
process.env.CLEMMY_GUARDRAIL_MUT_HALT = '8';
process.env.CLEMMY_GUARDRAIL_MUT_HALT_ENFORCE = 'on';
process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, RunContext, RunState, type Runner } from '@openai/agents';

const { resetEventLog } = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runConversation, runConversationFromResume } = await import('./loop.js');
const approvalRegistry = await import('./approval-registry.js');
const {
  ToolCallsCounter,
  guardrailScopeKey,
  harnessRunContextStorage,
} = await import('./brackets.js');
const {
  _resetAllTrackersForTests,
  _simulateRestartForTests,
  evaluateToolCall,
} = await import('./tool-guardrail.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;

function makeRunner(): Runner {
  return new EventEmitter() as unknown as Runner;
}

function makeAgent(): import('@openai/agents').Agent<any, any> {
  return {} as import('@openai/agents').Agent<any, any>;
}

function continuingDecision() {
  return {
    summary: 'The current accepted request has more internally-authored work to run.',
    reply: null,
    done: false,
    nextAction: 'awaiting_handoff_result' as const,
    reason: null,
  };
}

function completedDecision() {
  return {
    summary: 'The anti-thrash fixture completed.',
    reply: 'The anti-thrash fixture completed.',
    done: true,
    nextAction: 'completed' as const,
    reason: null,
  };
}

function approvalRunState(
  agent: import('@openai/agents').Agent<any, any>,
  toolName: string,
): string {
  const state = new RunState(new RunContext({}), 'approve this', agent, null);
  const json = state.toJSON() as Record<string, unknown>;
  json.currentStep = {
    type: 'next_step_interruption',
    data: {
      interruptions: [{
        rawItem: {
          type: 'function_call',
          name: toolName,
          callId: `${toolName}-call`,
          arguments: '{}',
        },
        toolName,
      }],
    },
  };
  return JSON.stringify(json);
}

test.beforeEach(() => {
  resetEventLog();
  _resetAllTrackersForTests();
});

test.after(() => {
  if (!process.env.CLEM_TEST_KEEP_HOME) {
    rmSync(TMP_HOME, { recursive: true, force: true });
  }
});

test('the fifth identical mutation blocks after a synthetic turn and daemon restart; only a new source resets it', async () => {
  const session = HarnessSession.create({
    id: 'anti-thrash-exact-across-continuation',
    kind: 'chat',
  });
  const args = { runId: 'same-logical-workflow' };
  const observedScopes: string[] = [];
  const observedSources: number[] = [];
  let fifth: ReturnType<typeof evaluateToolCall> | undefined;
  let runnerCalls = 0;

  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    runnerCalls += 1;
    const ctx = harnessRunContextStorage.getStore();
    assert.ok(ctx);
    assert.ok(Number.isSafeInteger(ctx.sourceUserSeq) && (ctx.sourceUserSeq ?? 0) > 0);
    const scope = guardrailScopeKey(ctx);
    observedScopes.push(scope);
    observedSources.push(ctx.sourceUserSeq as number);

    if (runnerCalls === 1) {
      for (let i = 0; i < 4; i += 1) {
        ctx.counter.increment();
        evaluateToolCall(scope, 'workflow_run', args, `exact-${i + 1}`);
      }
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: continuingDecision(),
      };
    }

    // Force the production SQLite path to be the authority for the second
    // physical turn, just as it is after a daemon/fallover recovery.
    _simulateRestartForTests(scope);
    ctx.counter.increment();
    fifth = evaluateToolCall(scope, 'workflow_run', args, 'exact-5');
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: completedDecision(),
    };
  };

  await runConversation({
    agent: makeAgent(),
    sessionId: session.id,
    input: 'Think through the anti-thrash behavior, then give me a short explanation.',
    maxSteps: 2,
    makeRunner,
    runRunner,
  });

  assert.equal(runnerCalls, 2, 'the first turn must produce one harness-authored continuation');
  assert.equal(new Set(observedSources).size, 1, 'both physical turns retain one accepted source');
  assert.equal(observedScopes[1], observedScopes[0], 'synthetic physical turns retain one behavior scope');
  assert.equal(fifth?.count, 5);
  assert.equal(fifth?.action, 'block');
  assert.equal(fifth?.rule, 'exact_args_repeat');

  let freshSourceDecision: ReturnType<typeof evaluateToolCall> | undefined;
  let freshSourceScope = '';
  let freshSourceSeq = 0;
  await runConversation({
    agent: makeAgent(),
    sessionId: session.id,
    input: 'Now start a genuinely new request and answer briefly.',
    maxSteps: 1,
    makeRunner,
    runRunner: async (_runner, _agent, items) => {
      const ctx = harnessRunContextStorage.getStore();
      assert.ok(ctx);
      freshSourceScope = guardrailScopeKey(ctx);
      freshSourceSeq = ctx.sourceUserSeq ?? 0;
      ctx.counter.increment();
      freshSourceDecision = evaluateToolCall(freshSourceScope, 'workflow_run', args, 'fresh-source-1');
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: completedDecision(),
      };
    },
  });

  assert.notEqual(freshSourceSeq, observedSources[0], 'the second user request owns new authority');
  assert.notEqual(freshSourceScope, observedScopes[0], 'a genuinely new source gets a fresh behavior scope');
  assert.equal(freshSourceDecision?.count, 1);
  assert.equal(freshSourceDecision?.action, 'allow');
});

test('the eighth distinct dangerous write halts after a synthetic turn and daemon restart', async () => {
  const session = HarnessSession.create({
    id: 'anti-thrash-distinct-across-continuation',
    kind: 'chat',
  });
  const observedScopes: string[] = [];
  const observedSources: number[] = [];
  let eighth: ReturnType<typeof evaluateToolCall> | undefined;
  let runnerCalls = 0;

  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    runnerCalls += 1;
    const ctx = harnessRunContextStorage.getStore();
    assert.ok(ctx);
    const scope = guardrailScopeKey(ctx);
    observedScopes.push(scope);
    observedSources.push(ctx.sourceUserSeq ?? 0);

    if (runnerCalls === 1) {
      for (let i = 1; i <= 7; i += 1) {
        ctx.counter.increment();
        evaluateToolCall(scope, 'composio_execute_tool', {
          tool_slug: 'GMAIL_SEND_EMAIL',
          arguments: JSON.stringify({ to: `recipient-${i}@example.invalid` }),
        }, `distinct-${i}`);
      }
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: continuingDecision(),
      };
    }

    _simulateRestartForTests(scope);
    ctx.counter.increment();
    eighth = evaluateToolCall(scope, 'composio_execute_tool', {
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: JSON.stringify({ to: 'recipient-8@example.invalid' }),
    }, 'distinct-8');
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: completedDecision(),
    };
  };

  await runConversation({
    agent: makeAgent(),
    sessionId: session.id,
    input: 'Think through the anti-thrash behavior, then give me a short explanation.',
    maxSteps: 2,
    toolCallsPerTurn: 12,
    makeRunner,
    runRunner,
  });

  assert.equal(runnerCalls, 2);
  assert.equal(new Set(observedSources).size, 1, 'the continuation retains accepted-source authority');
  assert.equal(observedScopes[1], observedScopes[0], 'the behavior scope survives the turn boundary');
  assert.equal(eighth?.count, 8);
  assert.equal(eighth?.action, 'halt');
  assert.equal(eighth?.rule, 'same_mut_tool_repeat');
});

test('an approved-state resume and its synthetic continuation retain the same durable behavior scope', async () => {
  const agent = new Agent({ name: 'AntiThrashResumeScope', instructions: 'test' });
  const session = HarnessSession.create({
    id: 'anti-thrash-approval-resume-continuation',
    kind: 'chat',
  });
  const approvedTool = 'anti_thrash_resume_fixture';
  session.saveInterruptState(approvalRunState(agent, approvedTool));
  const approval = approvalRegistry.register({
    sessionId: session.id,
    subject: 'Approve the exact anti-thrash fixture action.',
    tool: approvedTool,
    args: {},
  });
  const args = { runId: 'approved-resume-logical-workflow' };
  const observedScopes: string[] = [];
  const observedSources: number[] = [];
  let fifth: ReturnType<typeof evaluateToolCall> | undefined;
  let runnerCalls = 0;

  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    runnerCalls += 1;
    const ctx = harnessRunContextStorage.getStore();
    assert.ok(ctx);
    const scope = guardrailScopeKey(ctx);
    observedScopes.push(scope);
    observedSources.push(ctx.sourceUserSeq ?? 0);

    if (runnerCalls === 1) {
      for (let i = 0; i < 4; i += 1) {
        ctx.counter.increment();
        evaluateToolCall(scope, 'workflow_run', args, `resume-exact-${i + 1}`);
      }
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: continuingDecision(),
      };
    }

    _simulateRestartForTests(scope);
    ctx.counter.increment();
    fifth = evaluateToolCall(scope, 'workflow_run', args, 'resume-exact-5');
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: completedDecision(),
    };
  };

  await runConversationFromResume({
    agent,
    sessionId: session.id,
    approvalId: approval.approvalId,
    decision: 'approve',
    resolver: 'anti-thrash-test',
    maxSteps: 2,
    makeRunner,
    runRunner,
  });

  assert.equal(runnerCalls, 2);
  assert.equal(new Set(observedSources).size, 1, 'the approved state and continuation retain one accepted source');
  assert.ok(observedSources[0]! > 0);
  assert.equal(observedScopes[1], observedScopes[0]);
  assert.equal(fifth?.count, 5);
  assert.equal(fifth?.action, 'block');
});

test('accepted-source scoping preserves worker, nested-dispatch, and certified-batch isolation', () => {
  const direct = {
    sessionId: 'scope-shape',
    sourceUserSeq: 41,
    turn: 9,
    counter: new ToolCallsCounter(20),
    behaviorScopeId: 'scope-shape::source:41',
  };
  const directScope = guardrailScopeKey(direct);

  assert.equal(guardrailScopeKey({ ...direct, turn: 10 }), directScope);
  assert.notEqual(
    guardrailScopeKey({ ...direct, sourceUserSeq: 42, behaviorScopeId: 'scope-shape::source:42' }),
    directScope,
  );
  assert.equal(guardrailScopeKey({ ...direct, guardrailScopeId: 'worker:a' }), 'worker:a');
  assert.equal(guardrailScopeKey({ ...direct, guardrailScopeId: 'worker:b' }), 'worker:b');
  assert.notEqual(
    guardrailScopeKey({ ...direct, nestedDispatch: true }),
    directScope,
  );
  assert.notEqual(
    guardrailScopeKey({ ...direct, certifiedBatch: { batchId: 'batch-a', payloadHash: 'hash-a' } }),
    guardrailScopeKey({ ...direct, certifiedBatch: { batchId: 'batch-b', payloadHash: 'hash-b' } }),
  );
});
