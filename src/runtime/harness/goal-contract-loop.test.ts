/**
 * Run: npx tsx --test src/runtime/harness/goal-contract-loop.test.ts
 *
 * Goal-contract loop integration (GOAL-CONTRACT-PLAN.md Phase 3): a chat
 * session with an ACTIVE parked goal validates self-declared completion
 * externally against the PARKED criteria.
 *   - fail → continuation with evidence → pass → goal satisfied
 *   - attempt budget exhausted → honest unmet note, goal stays ACTIVE
 *   - judgeFailedOpen → no retry spin, goal stays ACTIVE
 *   - casual turn (no work signal) → validator never runs
 *   - CLEMMY_GOAL_CONTRACT=off kill-switch → inert
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-goal-loop-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
process.env.HARNESS_TOOL_BRACKETS = 'off';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Runner } from '@openai/agents';

const { resetEventLog, listEvents } = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runConversation } = await import('./loop.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;
const {
  createDirectGoal, getPlanProposal, getActiveGoalForSession,
  surfacePlan, approvePlanProposal,
} = await import('../../agents/plan-proposals.js');
import type { GoalValidationResult } from '../../execution/goal-validate.js';

/** Surface + approve a 2-stage goal for the staged-loop tests. */
function makeStagedGoal(sessionId: string) {
  const p = surfacePlan({
    plan: {
      objective: 'build the Q2 brief and draft the emails',
      steps: [{ n: 1, action: 'work', rationale: 'r', verification: null }],
      successCriteria: ['A brief exists.', 'Drafts exist.'],
      stages: [
        { title: 'Research', criteria: ['A brief exists.'] },
        { title: 'Draft', criteria: ['Drafts exist.'] },
      ],
      risks: [], estimatedComplexity: 'large', recommendsTrackedExecution: true,
      needsUserInput: [], appliedInstructions: [],
    },
    originatingRequest: 'do the staged work',
    sessionId,
  });
  return approvePlanProposal(p.id, { allowedTools: [] })!;
}

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function makeRunnerStub(): Runner {
  return new EventEmitter() as unknown as Runner;
}
function makeAgentStub(): import('@openai/agents').Agent<any, any> {
  return {} as import('@openai/agents').Agent<any, any>;
}

/** A runner whose every turn simulates ONE tool call (so the zero-tool stall
 *  detector stays quiet and totalToolCalls opens the goal-validation gate)
 *  then declares done. Replies vary per pass so the identical-decision stall
 *  guard never trips. */
function doneRunner(replyBase: string): RunRunnerFn {
  let n = 0;
  return async (runner, _agent, items, opts) => {
    n += 1;
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: (opts as { context?: unknown }).context };
    ee.emit('agent_start', runContext, { name: 'Orchestrator' });
    ee.emit(
      'agent_tool_start',
      runContext,
      { name: 'Orchestrator' },
      { name: 'read_file' },
      { toolCall: { callId: `call_${n}`, arguments: '{}' } },
    );
    const reply = `${replyBase} (pass ${n})`;
    return {
      history: [
        ...items,
        { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply }] },
      ],
      lastResponseId: `resp_${n}`,
      finalOutput: { summary: 'internal log', reply, done: true, nextAction: 'completed' },
    };
  };
}

function failResult(detail: string): GoalValidationResult {
  return {
    pass: false,
    perCriterion: [{ criterion: 'Pursue the objective: build the brief', pass: false, method: 'judge', detail }],
    advice: `unmet: ${detail}`,
  };
}
const PASS_RESULT: GoalValidationResult = {
  pass: true,
  perCriterion: [{ criterion: 'Pursue the objective: build the brief', pass: true, method: 'judge', detail: 'artifact verified' }],
};

test('goal validation: fail → evidence continuation → pass → goal satisfied', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat', title: 'goal loop' });
  const goal = createDirectGoal({ objective: 'build the Q2 brief', sessionId: sess.id })!;
  assert.equal(goal.status, 'active');

  const validatorCalls: string[] = [];
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'get going on the brief',
    makeRunner: makeRunnerStub,
    runRunner: doneRunner("I'll finish compiling the brief next."),
    goalValidator: async (input) => {
      validatorCalls.push(input.objective);
      return validatorCalls.length === 1 ? failResult('no artifact produced yet') : PASS_RESULT;
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(validatorCalls.length, 2, 'failed validation re-entered the loop, then passed');
  assert.match(validatorCalls[0], /build the Q2 brief/, 'validator receives the PARKED objective');

  const after = getPlanProposal(goal.id)!;
  assert.equal(after.status, 'satisfied');
  assert.equal(after.attempt, 2);
  assert.equal(after.evidence!.length, 2);

  const validations = listEvents(sess.id, { types: ['goal_validation'] });
  assert.equal(validations.length, 2);
  assert.equal(validations[0].data.pass, false);
  assert.equal(validations[1].data.pass, true);
});

test('staged goal: validates one stage at a time, advances, then satisfies on the final pass', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat', title: 'staged goal' });
  const goal = makeStagedGoal(sess.id);
  assert.equal(goal.stages!.length, 2);

  const validatedCriteria: string[][] = [];
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'go',
    makeRunner: makeRunnerStub,
    runRunner: doneRunner('Stage work done'),
    goalValidator: async (input) => {
      validatedCriteria.push(input.successCriteria);
      return PASS_RESULT;
    },
  });

  assert.equal(result.status, 'completed');
  // Stage 1 criteria, then stage 2 criteria, then the full-criteria final pass.
  assert.equal(validatedCriteria.length, 3, 'two stages + one final full validation');
  assert.deepEqual(validatedCriteria[0], ['A brief exists.'], 'stage 1 criteria only');
  assert.deepEqual(validatedCriteria[1], ['Drafts exist.'], 'stage 2 criteria only');
  assert.deepEqual(validatedCriteria[2], ['A brief exists.', 'Drafts exist.'], 'final = full criteria');

  const after = getPlanProposal(goal.id)!;
  assert.equal(after.status, 'satisfied');
  assert.ok(after.stages!.every((s) => s.status === 'done'), 'every stage marked done');

  const validations = listEvents(sess.id, { types: ['goal_validation'] });
  assert.equal(validations[0].data.stageId, 's1');
  assert.equal(validations[1].data.stageId, 's2');
  assert.equal(validations[2].data.stageId, undefined, 'final pass is unstaged');
});

test('staged goal: a stage that fails retries WITHIN the stage and does not advance', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat', title: 'staged retry' });
  const goal = makeStagedGoal(sess.id);

  let calls = 0;
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'go',
    makeRunner: makeRunnerStub,
    runRunner: doneRunner('working stage 1'),
    goalValidator: async () => {
      calls += 1;
      // Fail stage 1 once, then pass everything (stage1, stage2, final).
      return calls === 1
        ? { pass: false, perCriterion: [{ criterion: 'A brief exists.', pass: false, method: 'judge', detail: 'no brief yet' }], advice: 'x' }
        : PASS_RESULT;
    },
  });

  const after = getPlanProposal(goal.id)!;
  assert.equal(after.status, 'satisfied');
  // The first stage took 2 validations (fail, pass) before advancing.
  assert.ok(calls >= 4, `expected ≥4 validations (stage1 fail+pass, stage2, final), got ${calls}`);
});

test('goal validation: attempt budget exhausted → honest unmet note, goal stays ACTIVE', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat', title: 'goal exhaust' });
  const goal = createDirectGoal({ objective: 'land the migration', sessionId: sess.id, maxAttempts: 1 })!;

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'go',
    makeRunner: makeRunnerStub,
    runRunner: doneRunner("I'm going to wrap up the migration now."),
    goalValidator: async () => failResult('no migration evidence'),
  });

  assert.equal(result.status, 'completed', 'exhaustion completes honestly instead of spinning');
  const after = getPlanProposal(goal.id)!;
  assert.equal(after.status, 'active', 'goal stays pinned for revival');
  assert.equal(after.attempt, 1);

  const completed = listEvents(sess.id, { types: ['conversation_completed'] });
  const last = completed[completed.length - 1];
  assert.match(String(last.data.summary), /unmet criteria/, 'the user SEES the unmet criteria');
});

test('goal validation: dead judge (judgeFailedOpen) never spins and never satisfies', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat', title: 'goal dead judge' });
  const goal = createDirectGoal({ objective: 'publish the report', sessionId: sess.id })!;

  let calls = 0;
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'go',
    makeRunner: makeRunnerStub,
    runRunner: doneRunner("I'll publish it shortly."),
    goalValidator: async () => {
      calls += 1;
      return { pass: false, judgeFailedOpen: true, perCriterion: [], advice: 'judge unavailable' };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(calls, 1, 'a dead judge does not retry-spin');
  assert.equal(getPlanProposal(goal.id)!.status, 'active', 'a dead judge can never auto-satisfy');
  const completed = listEvents(sess.id, { types: ['conversation_completed'] });
  assert.match(String(completed[completed.length - 1].data.summary), /could not be validated/);
});

test('goal validation gate: a casual no-work turn never triggers validation', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat', title: 'goal casual' });
  createDirectGoal({ objective: 'organize the offsite', sessionId: sess.id });

  let calls = 0;
  // Artifact-evidence reply, ZERO tool calls → neither promise-shaped nor
  // worked → the goal-validation gate stays closed.
  const casualRunner: RunRunnerFn = async (_runner, _agent, items) => ({
    history: [
      ...items,
      { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'It is 3pm.' }] },
    ],
    lastResponseId: 'resp_casual',
    finalOutput: { summary: 'answered the time', reply: 'It is 3pm.', done: true, nextAction: 'completed' },
  });
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'what time is it?',
    makeRunner: makeRunnerStub,
    runRunner: casualRunner,
    goalValidator: async () => { calls += 1; return PASS_RESULT; },
  });

  assert.equal(result.status, 'completed');
  assert.equal(calls, 0, 'no work signal → no validation');
  assert.equal(getActiveGoalForSession(sess.id)!.status, 'active', 'goal untouched');
});

test('kill-switch: CLEMMY_GOAL_CONTRACT=off makes the goal loop inert', async () => {
  resetEventLog();
  process.env.CLEMMY_GOAL_CONTRACT = 'off';
  try {
    const sess = HarnessSession.create({ kind: 'chat', title: 'goal off' });
    createDirectGoal({ objective: 'ship the feature', sessionId: sess.id });
    let calls = 0;
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'go',
      makeRunner: makeRunnerStub,
      runRunner: doneRunner("I'll ship it next."),
      goalValidator: async () => { calls += 1; return PASS_RESULT; },
    });
    assert.equal(result.status, 'completed');
    assert.equal(calls, 0, 'kill-switch disables validation entirely');
  } finally {
    delete process.env.CLEMMY_GOAL_CONTRACT;
  }
});
