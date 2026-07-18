import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-bg-transition-race-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_BACKGROUND = 'off';

const backgroundTasks = await import('./background-tasks.js');
const MODULE_URL = pathToFileURL(path.join(process.cwd(), 'src/execution/background-tasks.ts')).href;

after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const START_CHILD_CODE = `
  import { existsSync, writeFileSync } from 'node:fs';
  const mod = await import(process.env.CLEM_BG_MODULE_URL);
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  mod._setBackgroundTaskStartCasHookForTests(() => {
    writeFileSync(process.env.CLEM_BG_OBSERVED, 'pending');
    while (!existsSync(process.env.CLEM_BG_RELEASE)) Atomics.wait(waitCell, 0, 0, 5);
  });
  const result = mod.markBackgroundTaskRunning(process.env.CLEM_BG_TASK_ID);
  writeFileSync(process.env.CLEM_BG_RESULT, JSON.stringify({ status: result?.status ?? null }));
`;

const CANCEL_CHILD_CODE = `
  import { writeFileSync } from 'node:fs';
  const mod = await import(process.env.CLEM_BG_MODULE_URL);
  const result = mod.cancelBackgroundTask(process.env.CLEM_BG_TASK_ID, 'Cancelled by adversarial race test.');
  writeFileSync(process.env.CLEM_BG_RESULT, JSON.stringify({ status: result?.status ?? null }));
`;

const SETTLE_CHILD_CODE = `
  import { existsSync, writeFileSync } from 'node:fs';
  const mod = await import(process.env.CLEM_BG_MODULE_URL);
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  mod._setBackgroundTaskSettlementCasHookForTests(() => {
    writeFileSync(process.env.CLEM_BG_OBSERVED, 'running');
    while (!existsSync(process.env.CLEM_BG_RELEASE)) Atomics.wait(waitCell, 0, 0, 5);
  });
  const result = mod.markBackgroundTaskDone(process.env.CLEM_BG_TASK_ID, process.env.CLEM_BG_DONE_RESULT);
  writeFileSync(process.env.CLEM_BG_RESULT, JSON.stringify({ status: result?.status ?? null }));
`;

const RESOLVE_INPUT_CHILD_CODE = `
  import { existsSync, writeFileSync } from 'node:fs';
  const mod = await import(process.env.CLEM_BG_MODULE_URL);
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  mod._setBackgroundTaskResolutionCasHookForTests(() => {
    writeFileSync(process.env.CLEM_BG_OBSERVED, 'awaiting_input');
    while (!existsSync(process.env.CLEM_BG_RELEASE)) Atomics.wait(waitCell, 0, 0, 5);
  });
  const result = mod.queueBackgroundTaskInputResolution(process.env.CLEM_BG_QUESTION_ID, 'stale answer');
  writeFileSync(process.env.CLEM_BG_RESULT, JSON.stringify({ status: result?.status ?? null }));
`;

function child(
  code: string,
  taskId: string,
  result: string,
  extraEnv: Record<string, string> = {},
): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEM_BG_MODULE_URL: MODULE_URL,
      CLEM_BG_TASK_ID: taskId,
      CLEM_BG_RESULT: result,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForFiles(files: string[], timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!files.every(existsSync)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${files.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForChild(proc: ChildProcess): Promise<void> {
  let stderr = '';
  proc.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const [code] = await once(proc, 'close') as [number | null];
  assert.equal(code, 0, stderr);
}

test('pending->running CAS: cancellation that commits after a starter observation cannot be overwritten', async () => {
  const task = backgroundTasks.createBackgroundTask({
    title: 'Start/cancel race',
    prompt: 'do not begin after cancellation wins',
    source: 'daemon',
  });
  const observed = path.join(TMP_HOME, `${task.id}.observed`);
  const release = path.join(TMP_HOME, `${task.id}.release`);
  const startResult = path.join(TMP_HOME, `${task.id}.start-result`);
  const cancelResult = path.join(TMP_HOME, `${task.id}.cancel-result`);

  const starter = child(START_CHILD_CODE, task.id, startResult, {
    CLEM_BG_OBSERVED: observed,
    CLEM_BG_RELEASE: release,
  });
  await waitForFiles([observed]);

  const canceller = child(CANCEL_CHILD_CODE, task.id, cancelResult);
  await waitForChild(canceller);
  assert.equal(JSON.parse(readFileSync(cancelResult, 'utf-8')).status, 'aborted');

  writeFileSync(release, 'continue');
  await waitForChild(starter);
  assert.equal(JSON.parse(readFileSync(startResult, 'utf-8')).status, null, 'stale starter loses its CAS');
  assert.equal(backgroundTasks.getBackgroundTask(task.id)?.status, 'aborted');
});

test('pending->running CAS: two processes that observed pending produce one starter', async () => {
  const task = backgroundTasks.createBackgroundTask({
    title: 'Double-start race',
    prompt: 'execute exactly once',
    source: 'daemon',
  });
  const release = path.join(TMP_HOME, `${task.id}.release`);
  const contenders = ['a', 'b'].map((label) => {
    const observed = path.join(TMP_HOME, `${task.id}.${label}.observed`);
    const result = path.join(TMP_HOME, `${task.id}.${label}.result`);
    return {
      observed,
      result,
      proc: child(START_CHILD_CODE, task.id, result, {
        CLEM_BG_OBSERVED: observed,
        CLEM_BG_RELEASE: release,
      }),
    };
  });

  await waitForFiles(contenders.map(({ observed }) => observed));
  writeFileSync(release, 'continue');
  await Promise.all(contenders.map(({ proc }) => waitForChild(proc)));

  const statuses = contenders.map(({ result }) => JSON.parse(readFileSync(result, 'utf-8')).status);
  assert.equal(statuses.filter((status) => status === 'running').length, 1);
  assert.equal(statuses.filter((status) => status === null).length, 1);
  assert.equal(backgroundTasks.getBackgroundTask(task.id)?.status, 'running');
});

test('worker-settlement CAS: cancellation after a completion observation cannot be overwritten', async () => {
  const task = backgroundTasks.createBackgroundTask({
    title: 'Settle/cancel race',
    prompt: 'do not report completion after cancellation wins',
    source: 'daemon',
  });
  assert.equal(backgroundTasks.markBackgroundTaskRunning(task.id)?.status, 'running');
  const observed = path.join(TMP_HOME, `${task.id}.settle-observed`);
  const release = path.join(TMP_HOME, `${task.id}.settle-release`);
  const settleResult = path.join(TMP_HOME, `${task.id}.settle-result`);
  const cancelResult = path.join(TMP_HOME, `${task.id}.settle-cancel-result`);
  const longResult = 'completion that must lose the cancellation race '.repeat(200);

  const settler = child(SETTLE_CHILD_CODE, task.id, settleResult, {
    CLEM_BG_OBSERVED: observed,
    CLEM_BG_RELEASE: release,
    CLEM_BG_DONE_RESULT: longResult,
  });
  await waitForFiles([observed]);

  const canceller = child(CANCEL_CHILD_CODE, task.id, cancelResult);
  await waitForChild(canceller);
  assert.equal(JSON.parse(readFileSync(cancelResult, 'utf-8')).status, 'cancelling');

  writeFileSync(release, 'continue');
  await waitForChild(settler);
  assert.equal(JSON.parse(readFileSync(settleResult, 'utf-8')).status, null);
  assert.equal(backgroundTasks.getBackgroundTask(task.id)?.status, 'cancelling');
  assert.equal(
    existsSync(path.join(TMP_HOME, 'state', 'background-tasks', `${task.id}.result.md`)),
    false,
    'a completion that loses the CAS creates no full-result artifact',
  );
});

test('worker-owned park and terminal writers all refuse a committed cancellation', () => {
  const transitions: Array<(id: string) => unknown> = [
    (id) => backgroundTasks.markBackgroundTaskDone(id, 'stale done'),
    (id) => backgroundTasks.markBackgroundTaskBlocked(id, 'stale blocked', 'stale blocked'),
    (id) => backgroundTasks.markBackgroundTaskAwaitingInput(id, 'stale-q', 'stale question'),
    (id) => backgroundTasks.markBackgroundTaskAwaitingApproval(id, 'stale-approval', 'stale approval'),
    (id) => backgroundTasks.markBackgroundTaskAwaitingContinue(id, 'stale budget park', 'stale partial'),
    (id) => backgroundTasks.markBackgroundTaskFailed(id, 'stale failure', 'failed'),
    (id) => backgroundTasks.markBackgroundTaskFailed(id, 'stale interruption', 'interrupted'),
  ];

  for (const [index, transition] of transitions.entries()) {
    const task = backgroundTasks.createBackgroundTask({
      title: `Protected settlement ${index}`,
      prompt: 'preserve cancellation authority',
      source: 'daemon',
    });
    backgroundTasks.markBackgroundTaskRunning(task.id);
    assert.equal(backgroundTasks.cancelBackgroundTask(task.id, 'Cancellation owns settlement.')?.status, 'cancelling');
    assert.equal(transition(task.id), null);
    assert.equal(backgroundTasks.getBackgroundTask(task.id)?.status, 'cancelling');
  }
});

test('parked-resolution CAS: cancellation after question observation prevents resurrection', async () => {
  const task = backgroundTasks.createBackgroundTask({
    title: 'Resolve/cancel race',
    prompt: 'do not resume after cancellation wins',
    source: 'daemon',
  });
  const questionId = `question-${task.id}`;
  assert.equal(
    backgroundTasks.markBackgroundTaskAwaitingInput(task.id, questionId, 'Which scope?')?.status,
    'awaiting_input',
  );
  const observed = path.join(TMP_HOME, `${task.id}.resolve-observed`);
  const release = path.join(TMP_HOME, `${task.id}.resolve-release`);
  const resolveResult = path.join(TMP_HOME, `${task.id}.resolve-result`);
  const cancelResult = path.join(TMP_HOME, `${task.id}.resolve-cancel-result`);

  const resolver = child(RESOLVE_INPUT_CHILD_CODE, task.id, resolveResult, {
    CLEM_BG_OBSERVED: observed,
    CLEM_BG_RELEASE: release,
    CLEM_BG_QUESTION_ID: questionId,
  });
  await waitForFiles([observed]);

  const canceller = child(CANCEL_CHILD_CODE, task.id, cancelResult);
  await waitForChild(canceller);
  assert.equal(JSON.parse(readFileSync(cancelResult, 'utf-8')).status, 'aborted');

  writeFileSync(release, 'continue');
  await waitForChild(resolver);
  assert.equal(JSON.parse(readFileSync(resolveResult, 'utf-8')).status, null);
  assert.equal(backgroundTasks.getBackgroundTask(task.id)?.status, 'aborted');
});

test('approval and continue resolvers also reject cancellation in their observation-to-CAS window', () => {
  const approvalTask = backgroundTasks.createBackgroundTask({ title: 'Approval race', prompt: 'wait', source: 'daemon' });
  backgroundTasks.markBackgroundTaskAwaitingApproval(approvalTask.id, 'approval-race', 'approve?');
  backgroundTasks._setBackgroundTaskResolutionCasHookForTests(() => {
    backgroundTasks._setBackgroundTaskResolutionCasHookForTests(null);
    backgroundTasks.cancelBackgroundTask(approvalTask.id, 'Cancelled before approval resolution committed.');
  });
  assert.equal(backgroundTasks.queueBackgroundTaskApprovalResolution('approval-race', true), null);
  assert.equal(backgroundTasks.getBackgroundTask(approvalTask.id)?.status, 'aborted');

  const continueTask = backgroundTasks.createBackgroundTask({ title: 'Continue race', prompt: 'wait', source: 'daemon' });
  backgroundTasks.markBackgroundTaskAwaitingContinue(continueTask.id, 'budget', 'partial');
  backgroundTasks._setBackgroundTaskResolutionCasHookForTests(() => {
    backgroundTasks._setBackgroundTaskResolutionCasHookForTests(null);
    backgroundTasks.cancelBackgroundTask(continueTask.id, 'Cancelled before continue committed.');
  });
  assert.equal(backgroundTasks.queueBackgroundTaskContinue(continueTask.id), null);
  assert.equal(backgroundTasks.getBackgroundTask(continueTask.id)?.status, 'aborted');
  backgroundTasks._setBackgroundTaskResolutionCasHookForTests(null);
});
