import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-catchup-decision-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const {
  queueWorkflowRun,
} = await import('../tools/workflow-run-queue.js');
const {
  listHeldWorkflowCatchupRuns,
  resumeWorkflowCatchupRun,
  skipWorkflowCatchupRun,
} = await import('./workflow-catchup-decision.js');
const {
  workflowRunCancellationRequested,
} = await import('./workflow-run-cancellation.js');

const DECISION_MODULE_URL = new URL('./workflow-catchup-decision.ts', import.meta.url).href;
const DECISION_CHILD_CODE = String.raw`
  import { existsSync, writeFileSync } from 'node:fs';
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const mod = await import(process.env.CLEM_DECISION_MODULE_URL);
  writeFileSync(process.env.CLEM_DECISION_READY, 'ready', 'utf-8');
  while (!existsSync(process.env.CLEM_DECISION_START)) Atomics.wait(wait, 0, 0, 10);
  try {
    const input = {
      runId: process.env.CLEM_DECISION_RUN_ID,
      expectedWorkflow: 'daily-brief',
    };
    const result = process.env.CLEM_DECISION_ACTION === 'resume'
      ? mod.resumeWorkflowCatchupRun(input)
      : mod.skipWorkflowCatchupRun(input);
    writeFileSync(process.env.CLEM_DECISION_RESULT, JSON.stringify({ status: result.status }), 'utf-8');
  } catch (error) {
    writeFileSync(process.env.CLEM_DECISION_RESULT, JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }), 'utf-8');
  }
`;

beforeEach(() => {
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
});

function writeReadyWorkflow(enabled = true): void {
  writeWorkflow('daily-brief', {
    name: 'Daily Brief',
    description: 'Build the daily brief.',
    enabled,
    trigger: { schedule: '0 9 * * *' },
    steps: [{ id: 'read', prompt: 'Read the latest notes.', sideEffect: 'read' }],
  });
}

function queueHeld(input: {
  slug?: string;
  workflowName?: string;
  firstDueAtMs?: number;
  scheduledAtMs?: number;
  missedCount?: number;
} = {}) {
  const slug = input.slug ?? 'daily-brief';
  const workflowName = input.workflowName ?? 'Daily Brief';
  const firstDueAtMs = input.firstDueAtMs ?? 60_000;
  const scheduledAtMs = input.scheduledAtMs ?? 180_000;
  return queueWorkflowRun(workflowName, {}, {
    source: 'schedule',
    idPrefix: 'sched',
    dedupe: false,
    catchupFire: true,
    catchupOccurrenceAtMs: firstDueAtMs,
    holdForCatchupDecision: true,
    workflowSlug: slug,
    catchupFirstDueAtMs: firstDueAtMs,
    catchupMissedCount: input.missedCount ?? 3,
    triggerReceiptId: `workflow-schedule:v1:${slug}:${scheduledAtMs}`,
  });
}

function readRun(runId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), 'utf-8'),
  ) as Record<string, unknown>;
}

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function launchDecisionChild(input: {
  action: 'resume' | 'skip';
  runId: string;
  readyFile: string;
  startFile: string;
  resultFile: string;
}): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', DECISION_CHILD_CODE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      HOME: TMP_HOME,
      CLEMMY_LOCAL_EMBEDDINGS: 'off',
      CLEM_DECISION_MODULE_URL: DECISION_MODULE_URL,
      CLEM_DECISION_ACTION: input.action,
      CLEM_DECISION_RUN_ID: input.runId,
      CLEM_DECISION_READY: input.readyFile,
      CLEM_DECISION_START: input.startFile,
      CLEM_DECISION_RESULT: input.resultFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('held catch-ups list exact collapsed schedule metadata and Resume is an idempotent same-run CAS', () => {
  writeReadyWorkflow();
  const held = queueHeld();
  assert.equal(held.status, 'held');
  assert.ok(held.id);

  const listed = listHeldWorkflowCatchupRuns();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], {
    runId: held.id,
    workflowName: 'Daily Brief',
    workflowSlug: 'daily-brief',
    status: 'awaiting_catchup_decision',
    createdAt: listed[0].createdAt,
    heldAt: listed[0].createdAt,
    scheduledAtMs: 180_000,
    scheduledAt: new Date(180_000).toISOString(),
    firstDueAtMs: 60_000,
    firstDueAt: new Date(60_000).toISOString(),
    missedCount: 3,
    readiness: listed[0].readiness,
  });

  const resumed = resumeWorkflowCatchupRun({
    runId: held.id!,
    expectedWorkflow: 'daily-brief',
  });
  assert.equal(resumed.status, 'resumed');
  const canonical = readRun(held.id!);
  assert.equal(canonical.status, 'queued');
  assert.equal(canonical.catchupDisposition, 'resumed');
  assert.equal(typeof canonical.catchupDecidedAt, 'string');
  assert.equal(listHeldWorkflowCatchupRuns().length, 0);

  const replay = resumeWorkflowCatchupRun({
    runId: held.id!,
    expectedWorkflow: 'Daily Brief',
  });
  assert.equal(replay.status, 'already_resumed');
  assert.equal(skipWorkflowCatchupRun({
    runId: held.id!,
    expectedWorkflow: 'daily-brief',
  }).status, 'already_resumed');
});

test('Resume rechecks the admitted definition readiness and leaves a blocked occurrence held', () => {
  writeWorkflow('scripted-brief', {
    name: 'Scripted Brief',
    description: 'Build with an authored helper.',
    enabled: true,
    trigger: { schedule: '0 9 * * *' },
    steps: [{ id: 'merge', prompt: 'Merge evidence.', deterministic: { runner: 'missing.py' } }],
  });
  const held = queueHeld({ slug: 'scripted-brief', workflowName: 'Scripted Brief' });
  assert.equal(held.status, 'held');
  assert.equal(held.readiness?.ok, false);

  const blocked = resumeWorkflowCatchupRun({
    runId: held.id!,
    expectedWorkflow: 'scripted-brief',
  });
  assert.equal(blocked.status, 'blocked_readiness');
  assert.equal(readRun(held.id!).status, 'awaiting_catchup_decision');
  assert.equal(readRun(held.id!).catchupDisposition, 'held');
  assert.equal(workflowRunCancellationRequested(held.id!), false);

  const scripts = path.join(WORKFLOWS_DIR, 'scripted-brief', 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(path.join(scripts, 'missing.py'), 'print(\"ready\")\n', 'utf-8');
  const changedCode = resumeWorkflowCatchupRun({
    runId: held.id!,
    expectedWorkflow: 'scripted-brief',
  });
  assert.equal(changedCode.status, 'definition_conflict',
    'changing admitted authored code requires a fresh run instead of executing mixed revisions');
  assert.equal(readRun(held.id!).status, 'awaiting_catchup_decision');
});

test('Resume rejects meaningful workflow definition drift and leaves the admitted occurrence held', () => {
  const edits = [
    {
      label: 'step prompt',
      apply: () => writeWorkflow('daily-brief', {
        name: 'Daily Brief',
        description: 'Build the daily brief.',
        enabled: true,
        trigger: { schedule: '0 9 * * *' },
        steps: [{ id: 'read', prompt: 'Read the edited notes.', sideEffect: 'read' }],
      }),
    },
    {
      label: 'workflow input contract',
      apply: () => writeWorkflow('daily-brief', {
        name: 'Daily Brief',
        description: 'Build the daily brief.',
        enabled: true,
        trigger: { schedule: '0 9 * * *' },
        inputs: { account: { type: 'string', required: true } },
        steps: [{ id: 'read', prompt: 'Read the latest notes.', sideEffect: 'read' }],
      }),
    },
    {
      label: 'tool authority',
      apply: () => writeWorkflow('daily-brief', {
        name: 'Daily Brief',
        description: 'Build the daily brief.',
        enabled: true,
        trigger: { schedule: '0 9 * * *' },
        allowedTools: ['composio_gmail_search'],
        steps: [{ id: 'read', prompt: 'Read the latest notes.', sideEffect: 'read' }],
      }),
    },
  ];

  for (const [index, edit] of edits.entries()) {
    rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
    rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
    writeReadyWorkflow();
    const held = queueHeld({ scheduledAtMs: 420_000 + index * 60_000 });
    edit.apply();

    const result = resumeWorkflowCatchupRun({
      runId: held.id!,
      expectedWorkflow: 'daily-brief',
    });
    assert.equal(result.status, 'definition_conflict', edit.label);
    assert.match(result.message, /definition changed/i, edit.label);
    assert.equal(readRun(held.id!).status, 'awaiting_catchup_decision', edit.label);
    assert.equal(readRun(held.id!).catchupDisposition, 'held', edit.label);
    assert.equal(workflowRunCancellationRequested(held.id!), false, edit.label);
  }
});

test('Resume allows schedule-only edits because they govern future occurrences', () => {
  writeReadyWorkflow();
  const held = queueHeld({ scheduledAtMs: 600_000 });
  writeWorkflow('daily-brief', {
    name: 'Daily Brief',
    description: 'Build the daily brief.',
    enabled: true,
    trigger: { schedule: '30 10 * * 1-5', timezone: 'America/New_York' },
    steps: [{ id: 'read', prompt: 'Read the latest notes.', sideEffect: 'read' }],
  });

  const result = resumeWorkflowCatchupRun({
    runId: held.id!,
    expectedWorkflow: 'daily-brief',
  });
  assert.equal(result.status, 'resumed');
  assert.equal(readRun(held.id!).status, 'queued');
  assert.equal(readRun(held.id!).catchupDisposition, 'resumed');
});

test('Resume leaves held occurrences in place when their current workflow is disabled or deleted', () => {
  writeReadyWorkflow();
  const disabledHeld = queueHeld({ scheduledAtMs: 240_000 });
  writeReadyWorkflow(false);
  const disabled = resumeWorkflowCatchupRun({
    runId: disabledHeld.id!,
    expectedWorkflow: 'daily-brief',
  });
  assert.equal(disabled.status, 'disabled');
  assert.equal(readRun(disabledHeld.id!).status, 'awaiting_catchup_decision');

  writeReadyWorkflow();
  const deletedHeld = queueHeld({ scheduledAtMs: 300_000 });
  rmSync(path.join(WORKFLOWS_DIR, 'daily-brief'), { recursive: true, force: true });
  const deleted = resumeWorkflowCatchupRun({
    runId: deletedHeld.id!,
    expectedWorkflow: 'Daily Brief',
  });
  assert.equal(deleted.status, 'workflow_not_found');
  assert.equal(readRun(deletedHeld.id!).status, 'awaiting_catchup_decision');
});

test('Skip terminalizes only a still-held occurrence and is idempotent without claiming effects after Resume', () => {
  writeReadyWorkflow();
  const held = queueHeld();
  const skipped = skipWorkflowCatchupRun({
    runId: held.id!,
    expectedWorkflow: 'daily-brief',
  });
  assert.equal(skipped.status, 'skipped');
  const canonical = readRun(held.id!);
  assert.equal(canonical.status, 'cancelled');
  assert.equal(canonical.catchupDisposition, 'skipped');
  assert.match(String(canonical.error), /before any workflow step ran/i);
  assert.equal(workflowRunCancellationRequested(held.id!), true);
  assert.equal(listHeldWorkflowCatchupRuns().length, 0);

  assert.equal(skipWorkflowCatchupRun({
    runId: held.id!,
    expectedWorkflow: 'Daily Brief',
  }).status, 'already_skipped');
  assert.equal(resumeWorkflowCatchupRun({
    runId: held.id!,
    expectedWorkflow: 'daily-brief',
  }).status, 'already_skipped');

  const resumedHeld = queueHeld({ scheduledAtMs: 360_000 });
  assert.equal(resumeWorkflowCatchupRun({
    runId: resumedHeld.id!,
    expectedWorkflow: 'daily-brief',
  }).status, 'resumed');
  assert.equal(skipWorkflowCatchupRun({
    runId: resumedHeld.id!,
    expectedWorkflow: 'daily-brief',
  }).status, 'already_resumed');
  assert.equal(readRun(resumedHeld.id!).status, 'queued');
  assert.equal(workflowRunCancellationRequested(resumedHeld.id!), false);
});

test('concurrent cross-process Resume and Skip serialize to one authoritative decision', async () => {
  writeReadyWorkflow();
  const held = queueHeld({ scheduledAtMs: 660_000 });
  const nonce = `${process.pid}-${Date.now()}`;
  const startFile = path.join(TMP_HOME, `decision-${nonce}.start`);
  const resumeReady = path.join(TMP_HOME, `decision-${nonce}.resume.ready`);
  const skipReady = path.join(TMP_HOME, `decision-${nonce}.skip.ready`);
  const resumeResult = path.join(TMP_HOME, `decision-${nonce}.resume.json`);
  const skipResult = path.join(TMP_HOME, `decision-${nonce}.skip.json`);
  const resume = launchDecisionChild({
    action: 'resume',
    runId: held.id!,
    readyFile: resumeReady,
    startFile,
    resultFile: resumeResult,
  });
  const skip = launchDecisionChild({
    action: 'skip',
    runId: held.id!,
    readyFile: skipReady,
    startFile,
    resultFile: skipResult,
  });

  try {
    await Promise.all([waitForFile(resumeReady), waitForFile(skipReady)]);
    writeFileSync(startFile, 'go', 'utf-8');
    const [[resumeCode], [skipCode]] = await Promise.all([
      once(resume, 'close') as Promise<[number | null]>,
      once(skip, 'close') as Promise<[number | null]>,
    ]);
    assert.equal(resumeCode, 0);
    assert.equal(skipCode, 0);
    const resumeOutcome = JSON.parse(readFileSync(resumeResult, 'utf-8')) as {
      status?: string;
      error?: string;
    };
    const skipOutcome = JSON.parse(readFileSync(skipResult, 'utf-8')) as {
      status?: string;
      error?: string;
    };
    assert.equal(resumeOutcome.error, undefined);
    assert.equal(skipOutcome.error, undefined);

    const canonical = readRun(held.id!);
    if (resumeOutcome.status === 'resumed') {
      assert.equal(skipOutcome.status, 'already_resumed');
      assert.equal(canonical.status, 'queued');
      assert.equal(canonical.catchupDisposition, 'resumed');
      assert.equal(workflowRunCancellationRequested(held.id!), false);
    } else {
      assert.equal(resumeOutcome.status, 'already_skipped');
      assert.equal(skipOutcome.status, 'skipped');
      assert.equal(canonical.status, 'cancelled');
      assert.equal(canonical.catchupDisposition, 'skipped');
      assert.equal(workflowRunCancellationRequested(held.id!), true);
    }
  } finally {
    if (resume.exitCode === null && resume.signalCode === null) resume.kill('SIGKILL');
    if (skip.exitCode === null && skip.signalCode === null) skip.kill('SIGKILL');
    for (const file of [startFile, resumeReady, skipReady, resumeResult, skipResult]) {
      rmSync(file, { force: true });
    }
  }
});

test('catch-up decisions fail closed on a cross-workflow request', () => {
  writeReadyWorkflow();
  const held = queueHeld();
  assert.equal(resumeWorkflowCatchupRun({
    runId: held.id!,
    expectedWorkflow: 'some-other-workflow',
  }).status, 'workflow_mismatch');
  assert.equal(skipWorkflowCatchupRun({
    runId: held.id!,
    expectedWorkflow: 'some-other-workflow',
  }).status, 'workflow_mismatch');
  assert.equal(readRun(held.id!).status, 'awaiting_catchup_decision');
  assert.equal(workflowRunCancellationRequested(held.id!), false);
});
