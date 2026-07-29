/**
 * Red-first delegation-evidence contracts for the execution controller.
 *
 * Run:
 *   npx tsx --test src/execution/controller-delegation-evidence.test.ts
 *
 * A durable completion row is transport, not proof. These tests pin the
 * distinction and the actor/evidence attribution that must survive folding.
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunRequest, RunResult } from '../types.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-controller-delegation-evidence-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { ExecutionStore } = await import('./store.js');
const { processExecutionController, _setExecutionCompletionJudgeForTests } = await import('./controller.js');
const { PlanStore } = await import('../planning/plan-store.js');
const { DELEGATIONS_DIR } = await import('../tools/shared.js');
const {
  appendEvent,
  createSession,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');

const EXECUTIONS_FILE = path.join(TEST_HOME, 'state', 'executions.json');
const PLANS_FILE = path.join(TEST_HOME, 'state', 'plans.json');

interface DelegationSeed {
  id: string;
  toAgent: string;
  result: string;
  completedBy: string;
  onBehalfOf?: string;
  resultEvidence: 'model_prose';
}

function neutralAssistant(): unknown {
  const text = JSON.stringify({
    summary: 'Observed the delegation update; keep the execution active.',
    status: 'active',
    nextStep: 'Wait for verified completion evidence.',
    nextReviewMinutes: 30,
    actions: [{ type: 'noop' }],
  });
  return {
    getRuntime() {
      return {
        async run(request: RunRequest): Promise<RunResult> {
          return { text, sessionId: request.sessionId };
        },
        listPendingApprovals() {
          return [];
        },
        async resolveApproval() {
          throw new Error('not used');
        },
      };
    },
  };
}

function completionClaimingAssistant(): unknown {
  const text = JSON.stringify({
    summary: 'The delegation says it is complete, so close the execution.',
    status: 'completed',
    nextReviewMinutes: 30,
  });
  return {
    getRuntime() {
      return {
        async run(request: RunRequest): Promise<RunResult> {
          return { text, sessionId: request.sessionId };
        },
        listPendingApprovals() {
          return [];
        },
        async resolveApproval() {
          throw new Error('not used');
        },
      };
    },
  };
}

function seedExecutionWithCompletedDelegation(
  seed: DelegationSeed,
  options: {
    withPlan?: boolean;
    bindingAlreadyCompleted?: boolean;
    objective?: string;
    successCriteria?: string;
    planStepText?: string;
    delegationTask?: string;
    expectedOutput?: string;
    sessionId?: string;
    sourceUserSeq?: number;
  } = {},
): { executionId: string; planId?: string; planStepId?: string } {
  const plans = new PlanStore();
  const plan = options.withPlan
    ? plans.create('Delegated evidence plan', [
        options.planStepText ?? 'Produce and verify the delegated result',
      ])
    : undefined;
  const store = new ExecutionStore();
  const execution = store.create({
    sessionId: options.sessionId ?? `controller-delegation-${seed.id}`,
    channel: 'cli',
    title: 'Complete delegated work truthfully',
    objective: options.objective
      ?? 'Finish the delegated work with verified evidence and accurate attribution.',
    reason: 'release evidence contract',
    startedFromMessage: 'finish the delegated work',
    confidence: 0.95,
    reasons: ['test'],
    sourceUserSeq: options.sourceUserSeq,
    planId: plan?.id,
    nextStep: plan?.steps[0]?.text,
    successCriteria: options.successCriteria,
  });
  const now = new Date().toISOString();
  const delegationTask = options.delegationTask ?? 'Produce the verified result.';
  const expectedOutput = options.expectedOutput ?? 'A result with independent evidence.';
  store.update(execution.id, {
    delegationBindings: [{
      delegationId: seed.id,
      toAgent: seed.toAgent,
      task: delegationTask,
      expectedOutput,
      planStepId: plan?.steps[0]?.id,
      status: options.bindingAlreadyCompleted ? 'completed' : 'pending',
      createdAt: now,
      updatedAt: now,
      ...(options.bindingAlreadyCompleted ? { result: seed.result } : {}),
    }],
  });

  const dir = path.join(DELEGATIONS_DIR, seed.toAgent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${seed.id}.json`), JSON.stringify({
    id: seed.id,
    fromAgent: 'clementine',
    toAgent: seed.toAgent,
    task: delegationTask,
    expectedOutput,
    status: 'completed',
    result: seed.result,
    resultEvidence: seed.resultEvidence,
    completedBy: seed.completedBy,
    ...(seed.onBehalfOf ? { onBehalfOf: seed.onBehalfOf } : {}),
    createdAt: now,
    updatedAt: now,
  }, null, 2), 'utf-8');

  return {
    executionId: execution.id,
    planId: plan?.id,
    planStepId: plan?.steps[0]?.id,
  };
}

beforeEach(() => {
  mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
  writeFileSync(EXECUTIONS_FILE, '[]', 'utf-8');
  writeFileSync(PLANS_FILE, '[]', 'utf-8');
  rmSync(DELEGATIONS_DIR, { recursive: true, force: true });
  resetEventLog();
  _setExecutionCompletionJudgeForTests(null);
});

after(() => {
  _setExecutionCompletionJudgeForTests(null);
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('model_prose external-effect report does not mark its bound plan step done', async () => {
  const seeded = seedExecutionWithCompletedDelegation({
    id: 'model-prose-plan',
    toAgent: 'proof-analyst',
    result: 'The model says the work is finished.',
    resultEvidence: 'model_prose',
    completedBy: 'proof-analyst',
  }, {
    withPlan: true,
    objective: 'Send the finished report to the customer.',
    successCriteria: 'A fresh sent-message receipt exists for this execution.',
    planStepText: 'Send the finished report and verify the sent-message receipt.',
    delegationTask: 'Send the finished report to the customer.',
    expectedOutput: 'The provider sent-message receipt.',
  });

  await processExecutionController(neutralAssistant() as never);

  const plan = new PlanStore().get(seeded.planId!);
  const step = plan?.steps.find((item) => item.id === seeded.planStepId);
  assert.equal(
    step?.status,
    'in_progress',
    'model prose may be recorded, but it is not evidence that satisfies a plan step',
  );
});

test('model_prose external-effect report cannot close even when synthesis and its judge over-credit it', async () => {
  const seeded = seedExecutionWithCompletedDelegation({
    id: 'model-prose-execution',
    toAgent: 'proof-analyst',
    result: 'The model says the whole objective is complete.',
    resultEvidence: 'model_prose',
    completedBy: 'proof-analyst',
  }, {
    withPlan: true,
    objective: 'Send the finished report to the customer.',
    successCriteria: 'A fresh sent-message receipt exists for this execution.',
    planStepText: 'Send the finished report and verify the sent-message receipt.',
    delegationTask: 'Send the finished report to the customer.',
    expectedOutput: 'The provider sent-message receipt.',
  });
  _setExecutionCompletionJudgeForTests(async () => ({
    done: true,
    reason: 'the synthesis treated the delegation prose as completion evidence',
  }));

  await processExecutionController(completionClaimingAssistant() as never);

  const execution = new ExecutionStore().get(seeded.executionId);
  assert.equal(
    execution?.status,
    'active',
    'a deterministic evidence boundary must override an optimistic synthesis/judge pair',
  );
  const plan = new PlanStore().get(seeded.planId!);
  const step = plan?.steps.find((item) => item.id === seeded.planStepId);
  assert.equal(step?.status, 'in_progress');
});

test('model_prose delegation cannot close a planless execution through synthesis', async () => {
  const seeded = seedExecutionWithCompletedDelegation({
    id: 'planless-synthesis-prose',
    toAgent: 'proof-analyst',
    result: 'I report that every objective is complete.',
    resultEvidence: 'model_prose',
    completedBy: 'proof-analyst',
  }, {
    objective: 'Send the finished report to the customer.',
    successCriteria: 'A fresh sent-message receipt exists for this execution.',
  });
  _setExecutionCompletionJudgeForTests(async () => ({
    done: true,
    reason: 'optimistic judge accepted model prose',
  }));

  await processExecutionController(completionClaimingAssistant() as never);

  const execution = new ExecutionStore().get(seeded.executionId);
  assert.equal(
    execution?.status,
    'active',
    'delegation verification is deterministic even when there is no plan-step gate',
  );
  assert.match(execution?.nextStep ?? '', /verif/i);
});

test('an unrelated sheet receipt cannot verify a delegated send claim', async () => {
  const sessionId = 'controller-delegation-correlation';
  createSession({ id: sessionId, kind: 'chat', title: 'delegation evidence correlation' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the report and update the tracking sheet.' },
  });
  const seeded = seedExecutionWithCompletedDelegation({
    id: 'send-vs-sheet',
    toAgent: 'proof-analyst',
    result: 'I sent the report to the customer.',
    resultEvidence: 'model_prose',
    completedBy: 'proof-analyst',
  }, {
    sessionId,
    sourceUserSeq: source.seq,
    objective: 'Send the finished report to the customer and update the tracking spreadsheet.',
    successCriteria: 'Both the sent-message receipt and spreadsheet update receipt are present.',
    delegationTask: 'Send the finished report to the customer.',
    expectedOutput: 'The provider sent-message receipt.',
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: {
      callId: 'sheet-only',
      shapeKey: 'GOOGLESHEETS_VALUES_UPDATE',
      targets: ['Tracker!A2:B2'],
    },
  });
  _setExecutionCompletionJudgeForTests(async () => ({
    done: true,
    reason: 'optimistic judge incorrectly treated one write as proof of both effects',
  }));

  await processExecutionController(completionClaimingAssistant() as never);

  const execution = new ExecutionStore().get(seeded.executionId);
  assert.equal(
    execution?.status,
    'active',
    'a confirmed sheet write is not correlated evidence for the delegated email/send effect',
  );
  assert.match(execution?.nextStep ?? '', /external write|verify/i);
});

test('a matching send receipt can ground a delegated send report', async () => {
  const sessionId = 'controller-delegation-matching-receipt';
  createSession({ id: sessionId, kind: 'chat', title: 'matching delegation receipt' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the report.' },
  });
  const seeded = seedExecutionWithCompletedDelegation({
    id: 'send-with-send',
    toAgent: 'proof-analyst',
    result: 'I sent the report to the customer.',
    resultEvidence: 'model_prose',
    completedBy: 'proof-analyst',
  }, {
    sessionId,
    sourceUserSeq: source.seq,
    objective: 'Send the finished report to the customer.',
    successCriteria: 'A fresh sent-message receipt exists for this execution.',
    delegationTask: 'Send the finished report to the customer.',
    expectedOutput: 'The provider sent-message receipt.',
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: {
      callId: 'email-send',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      targets: ['customer@example.com'],
    },
  });
  _setExecutionCompletionJudgeForTests(async () => ({
    done: true,
    reason: 'the matching provider send receipt and objective evidence are present',
  }));

  await processExecutionController(completionClaimingAssistant() as never);

  assert.equal(
    new ExecutionStore().get(seeded.executionId)?.status,
    'completed',
    'matching action-family evidence keeps the world-effect path satisfiable',
  );
});

test('analysis delegation can satisfy its non-mutating bound acceptance criterion', async () => {
  const seeded = seedExecutionWithCompletedDelegation({
    id: 'accepted-analysis',
    toAgent: 'proof-analyst',
    result: 'Analysis deliverable: risks are scope, timing, and rollback.',
    resultEvidence: 'model_prose',
    completedBy: 'proof-analyst',
  }, {
    withPlan: true,
    planStepText: 'Analyze the supplied migration notes and identify three risks.',
    delegationTask: 'Analyze the supplied migration notes.',
    expectedOutput: 'Three named risks with concise rationale.',
  });
  _setExecutionCompletionJudgeForTests(async () => ({
    done: true,
    reason: 'the completed plan acceptance criterion independently accepts the analysis deliverable',
  }));

  await processExecutionController(completionClaimingAssistant() as never);

  const execution = new ExecutionStore().get(seeded.executionId);
  assert.equal(
    execution?.status,
    'completed',
    'reported cognitive work itself can satisfy a non-mutating bound criterion before objective judging',
  );
  const step = new PlanStore().get(seeded.planId!)?.steps.find((item) => item.id === seeded.planStepId);
  assert.equal(step?.status, 'done', 'the cognitive report advances its matching non-mutating plan step');
});

test('model_prose delegation cannot close through a direct controller mark_completed action', async () => {
  const seeded = seedExecutionWithCompletedDelegation({
    id: 'direct-controller-prose',
    toAgent: 'proof-analyst',
    result: 'I report that the objective is complete.',
    resultEvidence: 'model_prose',
    completedBy: 'proof-analyst',
  }, {
    objective: 'Send the finished report to the customer.',
    successCriteria: 'A fresh sent-message receipt exists for this execution.',
  });
  _setExecutionCompletionJudgeForTests(async () => ({
    done: true,
    reason: 'optimistic judge accepted model prose',
  }));
  const assistant = {
    getRuntime() {
      return {
        async run(request: RunRequest): Promise<RunResult> {
          const text = request.channel === 'execution-synthesis'
            ? JSON.stringify({
                summary: 'The result was reported but remains verification-required.',
                status: 'active',
                nextStep: 'Verify the delegation result.',
              })
            : JSON.stringify({
                summary: 'Close it directly.',
                actions: [{ type: 'mark_completed', summary: 'Reported result accepted.' }],
              });
          return { text, sessionId: request.sessionId };
        },
        listPendingApprovals() { return []; },
        async resolveApproval() { throw new Error('not used'); },
      };
    },
  };

  await processExecutionController(assistant as never);

  const execution = new ExecutionStore().get(seeded.executionId);
  assert.equal(
    execution?.status,
    'active',
    'direct controller completion uses the same deterministic delegation-evidence precheck as synthesis',
  );
});

test('sync backfills evidence and actor provenance even when status and result are unchanged', async () => {
  const seeded = seedExecutionWithCompletedDelegation({
    id: 'provenance-backfill',
    toAgent: 'proof-analyst',
    result: 'A reported result.',
    resultEvidence: 'model_prose',
    completedBy: 'clementine',
    onBehalfOf: 'proof-analyst',
  }, { bindingAlreadyCompleted: true });

  await processExecutionController(neutralAssistant() as never);

  const binding = new ExecutionStore().get(seeded.executionId)?.delegationBindings?.[0];
  assert.deepEqual(
    {
      resultEvidence: binding?.resultEvidence,
      completedBy: binding?.completedBy,
      onBehalfOf: binding?.onBehalfOf,
    },
    {
      resultEvidence: 'model_prose',
      completedBy: 'clementine',
      onBehalfOf: 'proof-analyst',
    },
    'fold equality includes every provenance field, not only status/result',
  );
});

test('delegation completion activity preserves actual actor and evidence provenance', async () => {
  const seeded = seedExecutionWithCompletedDelegation({
    id: 'on-behalf-attribution',
    toAgent: 'proof-analyst',
    result: 'Clementine wrote this result herself.',
    resultEvidence: 'model_prose',
    completedBy: 'clementine',
    onBehalfOf: 'proof-analyst',
  });

  await processExecutionController(neutralAssistant() as never);

  const execution = new ExecutionStore().get(seeded.executionId);
  const activity = execution?.activity?.find((item) =>
    item.key === 'delegation:on-behalf-attribution:completed'
  );
  assert.ok(activity, 'precondition: controller folded the completion transition');
  assert.deepEqual(
    {
      completedBy: activity.metadata?.completedBy,
      onBehalfOf: activity.metadata?.onBehalfOf,
      resultEvidence: activity.metadata?.resultEvidence,
    },
    {
      completedBy: 'clementine',
      onBehalfOf: 'proof-analyst',
      resultEvidence: 'model_prose',
    },
    'the folded activity must retain who acted, on whose behalf, and how the result is grounded',
  );
});

test('delegation completion activity does not claim the assignee acted when Clementine did', async () => {
  const seeded = seedExecutionWithCompletedDelegation({
    id: 'on-behalf-message',
    toAgent: 'proof-analyst',
    result: 'Clementine wrote this result herself.',
    resultEvidence: 'model_prose',
    completedBy: 'clementine',
    onBehalfOf: 'proof-analyst',
  });

  await processExecutionController(neutralAssistant() as never);

  const execution = new ExecutionStore().get(seeded.executionId);
  const activity = execution?.activity?.find((item) =>
    item.key === 'delegation:on-behalf-message:completed'
  );
  assert.ok(activity, 'precondition: controller folded the completion transition');
  assert.match(activity.message, /clementine/i, 'the user-facing activity names the real actor');
  assert.match(
    activity.message,
    /reported|verification required/i,
    'model prose is described as reported and verification-required',
  );
  assert.doesNotMatch(
    activity.message,
    /completed delegated work/i,
    'unverified model prose must not be phrased as verified completion',
  );
  assert.doesNotMatch(
    activity.message,
    /^proof-analyst completed delegated work/i,
    'the assignee must not receive credit for work Clementine performed on its behalf',
  );
});
