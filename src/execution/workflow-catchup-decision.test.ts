import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
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
