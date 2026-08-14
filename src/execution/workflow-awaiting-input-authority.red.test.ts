/**
 * RED — a conversational answer belongs to one exact durable workflow
 * question. The classifier must see that question, and only the matching
 * run/step/origin may win the answer CAS.
 *
 * Run:
 *   npx tsx --test src/execution/workflow-awaiting-input-authority.red.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-input-authority-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { routeOpenQuestionPlan } = await import('../runtime/harness/plan-continuity.js');
const { Runner } = await import('@openai/agents');

const AUTHORITY_MODULE_URL = new URL('./workflow-awaiting-input.ts', import.meta.url).href;

interface PausedRecord {
  id: string;
  workflow: string;
  status: string;
  originSessionId: string;
  awaitingInput: {
    questionId: string;
    question: string;
    stepId: string;
    sessionId: string;
    sessionIdSuffix: string;
    askedAt: string;
    answer?: string;
  };
}

function writePaused(input: {
  runId: string;
  workflowName?: string;
  originSessionId: string;
  questionId: string;
  question?: string;
  stepId?: string;
}): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const record: PausedRecord = {
    id: input.runId,
    workflow: input.workflowName ?? 'Account Scope Workflow',
    status: 'awaiting_input',
    originSessionId: input.originSessionId,
    awaitingInput: {
      questionId: input.questionId,
      question: input.question ?? 'Should I use enterprise accounts or every account?',
      stepId: input.stepId ?? 'choose_scope',
      sessionId: `workflow:${input.runId}:${input.stepId ?? 'choose_scope'}`,
      sessionIdSuffix: input.stepId ?? 'choose_scope',
      askedAt: '2026-08-11T18:00:00.000Z',
    },
  };
  const file = path.join(WORKFLOW_RUNS_DIR, `${input.runId}.json`);
  writeFileSync(file, JSON.stringify(record), 'utf-8');
  return file;
}

function readPaused(file: string): PausedRecord {
  return JSON.parse(readFileSync(file, 'utf-8')) as PausedRecord;
}

test.beforeEach(() => {
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('the runtime classifier sees the exact stored question identity before admitting its answer', async () => {
  const originSessionId = 'discord:workflow-question-owner';
  const runId = 'question-aware-run';
  const questionId = 'workflow-input:question-aware-run:choose_scope:q1';
  const question = 'Should I use enterprise accounts or every account?';
  const file = writePaused({ runId, originSessionId, questionId, question });
  const prototype = Runner.prototype as unknown as {
    run: (...args: unknown[]) => Promise<{ finalOutput: unknown }>;
  };
  const originalRun = prototype.run;
  let prompt = '';
  prototype.run = async (...args: unknown[]) => {
    prompt = String(args[1] ?? '');
    return { finalOutput: 'ANSWERS' };
  };
  try {
    const routed = await routeOpenQuestionPlan({
      channel: originSessionId,
      sessionId: originSessionId,
      sourceUserSeq: 1,
      input: 'Use the enterprise accounts.',
    });
    assert.equal(routed.handled, true);
  } finally {
    prototype.run = originalRun;
  }

  assert.match(prompt, new RegExp(question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the classifier was asked about a fabricated input name instead of the exact question');
  assert.match(prompt, new RegExp(questionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the classifier did not receive the durable question identity');
  assert.match(prompt, new RegExp(runId), 'the classifier did not receive the owning run identity');
  assert.match(prompt, /choose_scope/, 'the classifier did not receive the owning step identity');
  const resumed = readPaused(file);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.awaitingInput.answer, 'Use the enterprise accounts.');
});

test('classifier outage leaves the workflow paused and lets the message continue conversationally', async () => {
  const originSessionId = 'discord:workflow-question-outage';
  const file = writePaused({
    runId: 'question-outage-run',
    originSessionId,
    questionId: 'workflow-input:question-outage-run:choose_scope:q1',
  });
  const prototype = Runner.prototype as unknown as {
    run: (...args: unknown[]) => Promise<{ finalOutput: unknown }>;
  };
  const originalRun = prototype.run;
  prototype.run = async () => { throw new Error('classifier unavailable'); };
  try {
    const routed = await routeOpenQuestionPlan({
      channel: originSessionId,
      sessionId: originSessionId,
      sourceUserSeq: 2,
      input: 'Also, what is on my calendar tomorrow?',
    });
    assert.equal(routed.handled, false,
      'an uncertain classifier result consumed an unrelated chat message as workflow authority');
  } finally {
    prototype.run = originalRun;
  }

  const stillPaused = readPaused(file);
  assert.equal(stillPaused.status, 'awaiting_input');
  assert.equal(stillPaused.awaitingInput.answer, undefined);
});

test('a classified unrelated next topic does not consume or alter the pending answer', async () => {
  const originSessionId = 'discord:workflow-question-new-topic';
  const file = writePaused({
    runId: 'question-new-topic-run',
    originSessionId,
    questionId: 'workflow-input:question-new-topic-run:choose_scope:q1',
  });
  const prototype = Runner.prototype as unknown as {
    run: (...args: unknown[]) => Promise<{ finalOutput: unknown }>;
  };
  const originalRun = prototype.run;
  prototype.run = async () => ({ finalOutput: 'NEW_TOPIC' });
  try {
    const routed = await routeOpenQuestionPlan({
      channel: originSessionId,
      sessionId: originSessionId,
      sourceUserSeq: 3,
      input: 'What meetings do I have tomorrow?',
    });
    assert.equal(routed.handled, false);
    assert.equal(routed.kind, 'new_topic');
  } finally {
    prototype.run = originalRun;
  }
  assert.equal(readPaused(file).status, 'awaiting_input');
  assert.equal(readPaused(file).awaitingInput.answer, undefined);
});

test('duplicate question ids cannot redirect an answer into another origin run', async () => {
  const questionId = 'workflow-input:collision:choose_scope:q1';
  const foreignFile = writePaused({
    runId: 'a-foreign-run',
    workflowName: 'Foreign Workflow',
    originSessionId: 'discord:foreign-origin',
    questionId,
  });
  const ownedFile = writePaused({
    runId: 'z-owned-run',
    workflowName: 'Owned Workflow',
    originSessionId: 'discord:owned-origin',
    questionId,
  });
  const prototype = Runner.prototype as unknown as {
    run: (...args: unknown[]) => Promise<{ finalOutput: unknown }>;
  };
  const originalRun = prototype.run;
  prototype.run = async () => ({ finalOutput: 'ANSWERS' });
  try {
    const routed = await routeOpenQuestionPlan({
      channel: 'discord:owned-origin',
      sessionId: 'discord:owned-origin',
      sourceUserSeq: 3,
      input: 'Use enterprise accounts.',
    });
    assert.equal(routed.handled, true);
  } finally {
    prototype.run = originalRun;
  }

  assert.equal(readPaused(foreignFile).status, 'awaiting_input',
    'question-id-only resolution resumed another origin\'s workflow');
  assert.equal(readPaused(ownedFile).status, 'running',
    'the answer did not resume the exact run selected under origin authority');
});

test('two cross-process answers to the same exact question have one CAS winner', async () => {
  const runId = 'concurrent-answer-run';
  const originSessionId = 'discord:concurrent-answer-origin';
  const questionId = `workflow-input:${runId}:choose_scope:q1`;
  const file = writePaused({ runId, originSessionId, questionId });
  const childCode = String.raw`
    const { writeFileSync } = await import('node:fs');
    const mod = await import(process.env.CLEM_INPUT_AUTHORITY_MODULE);
    const result = mod.queueWorkflowRunInputResolution({
      runId: process.env.CLEM_RUN_ID,
      questionId: process.env.CLEM_QUESTION_ID,
      stepId: 'choose_scope',
      originSessionId: process.env.CLEM_ORIGIN_ID,
      answer: process.env.CLEM_ANSWER,
    });
    writeFileSync(process.env.CLEM_RESULT_FILE, JSON.stringify(result), 'utf-8');
  `;
  const launch = (answer: string, resultFile: string) => spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', childCode],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLEMENTINE_HOME: TMP_HOME,
        CLEM_INPUT_AUTHORITY_MODULE: AUTHORITY_MODULE_URL,
        CLEM_RUN_ID: runId,
        CLEM_QUESTION_ID: questionId,
        CLEM_ORIGIN_ID: originSessionId,
        CLEM_ANSWER: answer,
        CLEM_RESULT_FILE: resultFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const firstResult = path.join(TMP_HOME, 'concurrent-first.result.json');
  const secondResult = path.join(TMP_HOME, 'concurrent-second.result.json');
  const first = launch('Use enterprise accounts.', firstResult);
  const second = launch('Use every account.', secondResult);
  const collect = async (child: ReturnType<typeof launch>, resultFile: string) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const [code] = await once(child, 'close') as [number | null];
    assert.equal(code, 0, stderr);
    return JSON.parse(readFileSync(resultFile, 'utf-8')) as { status: string };
  };
  const results = await Promise.all([
    collect(first, firstResult),
    collect(second, secondResult),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['queued', 'stale']);
  assert.equal(readPaused(file).status, 'running');
  assert.ok(
    ['Use enterprise accounts.', 'Use every account.'].includes(readPaused(file).awaitingInput.answer ?? ''),
    'the winning answer was not durably bound',
  );
});
