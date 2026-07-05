/**
 * Run: npx tsx --test src/execution/controller.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunRequest, RunResult } from '../types.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-controller-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { ExecutionStore } = await import('./store.js');
const {
  processExecutionController,
  _setExecutionCompletionJudgeForTests,
} = await import('./controller.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');

const EXECUTIONS_FILE = path.join(TMP_HOME, 'state', 'executions.json');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test.beforeEach(() => {
  mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
  writeFileSync(EXECUTIONS_FILE, '[]', 'utf-8');
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  _setExecutionCompletionJudgeForTests(null);
});

function createExecution(overrides: Partial<Parameters<InstanceType<typeof ExecutionStore>['create']>[0]> = {}) {
  return new ExecutionStore().create({
    sessionId: `sess-controller-${Math.random().toString(36).slice(2, 8)}`,
    channel: 'cli',
    title: 'Send the report',
    objective: 'Send the finished report and provide the send receipt',
    reason: 'user asked for durable follow-through',
    startedFromMessage: 'send the report',
    confidence: 0.9,
    reasons: ['test'],
    ...overrides,
  });
}

function assistantWithResponses(responses: string[]) {
  const prompts: string[] = [];
  return {
    prompts,
    assistant: {
      getRuntime() {
        return {
          async run(request: RunRequest): Promise<RunResult> {
            prompts.push(request.prompt);
            const text = responses.shift();
            if (text === undefined) throw new Error('unexpected controller model call');
            return { text, sessionId: request.sessionId };
          },
          listPendingApprovals() { return []; },
          async resolveApproval() { throw new Error('not used'); },
        };
      },
    },
  };
}

test('controller mark_completed is rejected when the completion judge finds no evidence', async () => {
  const execution = createExecution();
  let judgeCalls = 0;
  _setExecutionCompletionJudgeForTests(async (objective, evidence) => {
    judgeCalls += 1;
    assert.match(objective, /Send the finished report/);
    assert.match(evidence, /send the report next/i);
    return { done: false, reason: 'no sent-message receipt or report artifact' };
  });

  const { assistant } = assistantWithResponses([
    JSON.stringify({
      summary: 'promised completion',
      actions: [{ type: 'mark_completed', summary: "I'll send the report next." }],
    }),
    JSON.stringify({
      summary: 'Completion gap remains open.',
      status: 'active',
      nextStep: 'Produce the send receipt and report artifact.',
      nextReviewMinutes: 30,
    }),
  ]);

  await processExecutionController(assistant as never);

  assert.equal(judgeCalls, 1);
  const updated = new ExecutionStore().get(execution.id);
  assert.equal(updated?.status, 'active');
  assert.match(updated?.lastAssistantSummary ?? '', /Completion gap remains open|Completion not accepted/);
  assert.ok(updated?.activity?.some((item) =>
    item.type === 'status' && /Completion not accepted/.test(item.message)
  ), 'completion-gate rejection should be recorded as activity');
});

test('controller mark_completed closes the execution when the completion judge passes', async () => {
  const execution = createExecution();
  _setExecutionCompletionJudgeForTests(async () => ({ done: true, reason: 'receipt and artifact present' }));
  const { assistant } = assistantWithResponses([
    JSON.stringify({
      summary: 'Report sent; receipt id msg_123 and report saved at /tmp/report.pdf.',
      actions: [{ type: 'mark_completed', summary: 'Report sent; receipt id msg_123 and report saved at /tmp/report.pdf.' }],
    }),
  ]);

  await processExecutionController(assistant as never);

  const updated = new ExecutionStore().get(execution.id);
  assert.equal(updated?.status, 'completed');
  assert.equal(updated?.blocker, undefined);
  assert.match(updated?.lastAssistantSummary ?? '', /msg_123/);
});

test('controller queue_workflow writes through the shared workflow queue', async () => {
  writeWorkflow('controller-follow-up', {
    name: 'controller-follow-up',
    description: 'Run the controller follow-up.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'run', prompt: 'Run the follow-up for {{input.url}}.' }],
  });
  const execution = createExecution({
    title: 'Run the controller workflow',
    objective: 'Queue the follow-up workflow with the supplied website.',
  });
  const { assistant } = assistantWithResponses([
    JSON.stringify({
      summary: 'Queued the follow-up workflow.',
      actions: [{
        type: 'queue_workflow',
        workflow: 'controller-follow-up',
        inputs: { website: ' https://example.com/controller ' },
      }],
    }),
    JSON.stringify({
      summary: 'Workflow queued; waiting for the run to finish.',
      status: 'active',
      nextReviewMinutes: 30,
    }),
  ]);

  await processExecutionController(assistant as never);

  const updated = new ExecutionStore().get(execution.id);
  assert.equal(updated?.workflowBindings?.length, 1);
  const binding = updated!.workflowBindings![0];
  assert.equal(binding.workflow, 'controller-follow-up');
  assert.equal(binding.status, 'queued');

  const records = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>)
    .filter((record) => record.workflow === 'controller-follow-up');
  assert.equal(records.length, 1);
  assert.equal(records[0].id, binding.runId);
  assert.equal(records[0].source, 'execution-controller');
  assert.deepEqual(records[0].inputs, {
    website: 'https://example.com/controller',
    url: 'https://example.com/controller',
  });
});

test('synthesis-driven completed status is rejected when judge validation fails', async () => {
  const store = new ExecutionStore();
  const execution = createExecution();
  store.addActivity({
    executionId: execution.id,
    key: 'task:t1:completed',
    type: 'task_completed',
    message: 'Task t1 completed, but no send receipt was produced.',
  });
  let judgeCalls = 0;
  _setExecutionCompletionJudgeForTests(async () => {
    judgeCalls += 1;
    return { done: false, reason: 'the final receipt is missing' };
  });

  const { assistant } = assistantWithResponses([
    JSON.stringify({
      summary: "I'll send the final receipt next.",
      status: 'completed',
      nextReviewMinutes: 30,
    }),
    JSON.stringify({
      summary: 'A completion-gap task was created.',
      status: 'active',
      nextStep: 'Wait for the completion-gap task.',
      nextReviewMinutes: 30,
    }),
  ]);

  await processExecutionController(assistant as never);

  assert.equal(judgeCalls, 1);
  const updated = new ExecutionStore().get(execution.id);
  assert.equal(updated?.status, 'active');
  assert.ok(updated?.activity?.some((item) =>
    item.type === 'status' && /Completion not accepted/.test(item.message)
  ), 'synthesis completion rejection should be recorded as activity');
});
