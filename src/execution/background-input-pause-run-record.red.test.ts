/**
 * RED — a background input pause must be typed truth on the shared RunRecord.
 *
 * Run: npx tsx --test src/execution/background-input-pause-run-record.red.test.ts
 *
 * Invariant under pin: a REAL awaiting-input state is stored AS awaiting-input,
 * preserving the exact blocked question, its identity, the source, and the safe
 * next user action. The BackgroundTaskRecord already tells this truth (typed
 * status 'awaiting_input' + pendingQuestion/pendingQuestionId + outcomeSnapshot
 * nextAction — pinned green below). The shared RunRecord board flattens the
 * same pause into 'awaiting_approval' with only message/outputPreview, so every
 * RunRecord consumer sees a phantom approval with no question identity and no
 * next action (live 2026-08-11 class).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-bg-input-runrecord-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  createBackgroundTask,
  getBackgroundTask,
  processBackgroundTasks,
  _setBackgroundResponseExecutorForTests,
} = await import('./background-tasks.js');
const { getRun } = await import('../runtime/run-events.js');

_setBackgroundResponseExecutorForTests((assistant, request) => assistant.respond(request));

test.after(() => {
  _setBackgroundResponseExecutorForTests(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const QUESTION = 'Which quarter should the pipeline report cover — Q2 or Q3?';

/** Drive one worker turn that parks on a clarifying question, exactly like the
 * settle path receives it (stoppedReason 'awaiting-input', question as text). */
async function parkOnInput(): Promise<{ taskId: string; runId: string }> {
  const task = createBackgroundTask({
    title: 'Build the pipeline report',
    prompt: 'Build the quarterly pipeline report and file it in the tracker.',
  });
  const stubAssistant = {
    getRuntime() { return {} as never; },
    async respond(request: { message: string; sessionId: string }) {
      return {
        text: QUESTION,
        sessionId: request.sessionId,
        stoppedReason: 'awaiting-input' as const,
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processed = await processBackgroundTasks(stubAssistant as any, 1);
  assert.equal(processed, 1, 'fixture precondition: the queued task was processed');
  return { taskId: task.id, runId: `run-${task.id}` };
}

async function runOneWith(input: {
  title: string;
  prompt: string;
  text: string;
  stoppedReason: 'success' | 'token-budget';
}): Promise<{ taskId: string; runId: string }> {
  const task = createBackgroundTask({ title: input.title, prompt: input.prompt });
  const stubAssistant = {
    getRuntime() { return {} as never; },
    async respond(request: { sessionId: string }) {
      return {
        text: input.text,
        sessionId: request.sessionId,
        stoppedReason: input.stoppedReason,
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(await processBackgroundTasks(stubAssistant as any, 1), 1);
  return { taskId: task.id, runId: `run-${task.id}` };
}

test('GUARD — the background task record keeps the typed awaiting_input truth', async () => {
  const { taskId } = await parkOnInput();
  const parked = getBackgroundTask(taskId);
  assert.equal(parked?.status, 'awaiting_input', 'the task lane already stores the real state');
  assert.equal(parked?.pendingQuestion, QUESTION, 'the exact blocked question is preserved');
  assert.ok(parked?.pendingQuestionId, 'the question has durable identity for answer routing');
  assert.equal(parked?.outcomeSnapshot?.resumable, true, 'the pause is typed as resumable');
  assert.ok(
    (parked?.outcomeSnapshot?.nextAction ?? '').length > 0,
    'the safe next user action is typed on the task record',
  );
});

test('the RunRecord stores the input pause as awaiting_input, not awaiting_approval', async () => {
  const { runId } = await parkOnInput();
  const record = getRun(runId);
  assert.ok(record, 'fixture precondition: the background run has a RunRecord');

  // TARGET — the shared run board must tell the same typed truth as the task
  // record: this run is waiting on USER INPUT, not on an approval decision.
  assert.equal(
    String(record.status),
    'awaiting_input',
    'a background input pause is flattened to awaiting_approval on the RunRecord — '
    + 'every board/dashboard consumer sees a phantom approval instead of a question',
  );
});

test('the RunRecord preserves the blocked question identity and next action', async () => {
  const { taskId, runId } = await parkOnInput();
  const parked = getBackgroundTask(taskId);
  const questionId = parked?.pendingQuestionId ?? '';
  assert.ok(questionId, 'fixture precondition: the task minted a question id');

  const record = getRun(runId);
  assert.ok(record, 'fixture precondition: the background run has a RunRecord');

  // TARGET — the durable run record must reference the exact question identity
  // (and thereby the answer route). Today only message/outputPreview survive;
  // the questionId lives solely on the task record + notification metadata.
  assert.ok(
    JSON.stringify(record).includes(questionId),
    `the RunRecord carries no reference to the blocked question's identity ${questionId} — `
    + 'the pause cannot be answered or resumed from run-record truth alone',
  );
});

test('a verification-derived user dependency is awaiting_input on both task and RunRecord', async () => {
  const { taskId, runId } = await runOneWith({
    title: 'Read the account summary',
    prompt: 'Read the current account summary.',
    text: 'I cannot continue: permission denied. I need your credentials before I can proceed.',
    stoppedReason: 'success',
  });
  const task = getBackgroundTask(taskId);
  const run = getRun(runId);
  assert.equal(task?.status, 'awaiting_input', 'fixture precondition: verifier parked the task on the dependency');
  assert.equal(
    run?.status,
    'awaiting_input',
    'the verification-derived dependency wrote a phantom awaiting_approval RunRecord',
  );
  assert.equal(run?.pendingInput?.kind, 'clarifying_question');
  assert.equal(run?.pendingApprovalId, undefined);
});

test('a run-budget continuation is user input, never a phantom approval', async () => {
  const { taskId, runId } = await runOneWith({
    title: 'Long research pass',
    prompt: 'Research the account landscape thoroughly.',
    text: 'I reached this run budget after preserving the current research.',
    stoppedReason: 'token-budget',
  });
  assert.equal(getBackgroundTask(taskId)?.status, 'awaiting_continue');
  const run = getRun(runId);
  assert.equal(
    run?.status,
    'awaiting_input',
    'awaiting_continue was projected as an approval even though no approval id exists',
  );
  assert.equal(run?.pendingInput?.kind, 'continue_authorization');
  assert.equal(run?.pendingApprovalId, undefined);
});

test('an automatic objective re-anchor stays queued and never invents an approval', async () => {
  const { taskId, runId } = await runOneWith({
    title: 'Build the saved report',
    prompt: 'Create and save a report file with the complete findings.',
    text: 'I reviewed the requirements and am ready to build the report.',
    stoppedReason: 'success',
  });
  assert.equal(
    getBackgroundTask(taskId)?.status,
    'pending',
    'fixture precondition: the missing deliverable queued the objective-reanchored continuation',
  );
  const run = getRun(runId);
  assert.equal(
    run?.status,
    'queued',
    'the automatic continuation wrote awaiting_approval even though it needs no human decision',
  );
  assert.equal(run?.pendingApprovalId, undefined);
  assert.equal(run?.pendingInput, undefined);
});
