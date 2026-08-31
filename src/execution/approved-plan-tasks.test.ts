/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/approved-plan-tasks.test.ts
 *
 * Approval-to-background admission is a two-store transaction. These tests
 * kill it at each durable boundary, cross a real process restart, and race
 * independent processes so one accepted plan can never disappear or fork.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-approved-plan-admission-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_BG_GOAL_CONTRACT = 'on';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAN_MODULE = path.join(REPO_ROOT, 'src/agents/plan-proposals.ts');
const ADMISSION_MODULE = path.join(REPO_ROOT, 'src/execution/approved-plan-tasks.ts');

const plans = await import('../agents/plan-proposals.js');
const admissions = await import('./approved-plan-tasks.js');
const tasks = await import('./background-tasks.js');
const notifications = await import('../runtime/notifications.js');
const runs = await import('../runtime/run-events.js');

function aPlan(overrides: Record<string, unknown> = {}) {
  return {
    objective: 'Prepare the exact quarterly customer-health brief.',
    steps: [
      {
        n: 1,
        action: 'Read the approved customer-health inputs.',
        rationale: 'Use the agreed source of truth.',
        verification: 'Every account in the approved input appears once.',
      },
      {
        n: 2,
        action: 'Write the quarterly customer-health brief.',
        rationale: 'Produce the requested deliverable.',
        verification: 'The brief covers every agreed success criterion.',
      },
    ],
    successCriteria: ['A complete quarterly customer-health brief is saved.'],
    risks: [],
    estimatedComplexity: 'significant' as const,
    recommendsTrackedExecution: true,
    needsUserInput: [],
    appliedInstructions: [],
    externalSends: null,
    ...overrides,
  };
}

function surface(suffix: string, options: { sessionId?: string } = {}) {
  return plans.surfacePlan({
    plan: aPlan(),
    originatingRequest: `Prepare the quarterly health brief for ${suffix}.`,
    sessionId: options.sessionId,
    channel: 'desktop',
  });
}

function fencedJson(output: string): unknown {
  const match = /<<<([\s\S]*?)>>>/.exec(output);
  if (!match) throw new Error(`Child returned no fenced result: ${output}`);
  return JSON.parse(match[1]);
}

function runChild(source: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLEMENTINE_HOME: TEST_HOME,
        CLEMMY_BG_GOAL_CONTRACT: 'on',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Child exited ${code}: ${stdout}\n${stderr}`));
        return;
      }
      try {
        resolve(fencedJson(stdout));
      } catch (error) {
        reject(new Error(`${String(error)}\nstdout=${stdout}\nstderr=${stderr}`));
      }
    });
  });
}

function taskNotifications(taskId: string) {
  return notifications.listNotifications(1_000)
    .filter((item) => item.id === `background-${taskId}-queued`);
}

function planQueuedNotifications(proposalId: string) {
  return notifications.listNotifications(1_000)
    .filter((item) => item.id === `plan-proposal-${proposalId}-queued`);
}

test('crash after approval write recovers the exact edited plan in a fresh process', async () => {
  const proposal = surface('approval-write crash');
  const editedPlan = aPlan({
    objective: 'Prepare the edited, user-approved customer-health brief.',
    steps: [{
      n: 1,
      action: 'Use only the edited approved source list.',
      rationale: 'The user narrowed the plan before approval.',
      verification: 'No account outside the edited list appears.',
    }],
    successCriteria: ['The edited approved brief is saved.'],
  });
  const crash = await runChild(`
    const plans = await import(${JSON.stringify(PLAN_MODULE)});
    const admissions = await import(${JSON.stringify(ADMISSION_MODULE)});
    plans._setBackgroundApprovalWriteFaultForTests(() => { throw new Error('simulated approval-write crash'); });
    let error = null;
    try {
      admissions.approvePlanAndQueueBackgroundTask(${JSON.stringify(proposal.id)}, {
        editedPlan: ${JSON.stringify(editedPlan)},
        allowedTools: [],
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    process.stdout.write('<<<' + JSON.stringify({ error }) + '>>>');
  `) as { error: string | null };
  assert.match(crash.error ?? '', /approval-write crash/);

  const durable = plans.getPlanProposal(proposal.id)!;
  const taskId = admissions.approvedPlanBackgroundTaskId(proposal.id);
  assert.equal(durable.status, 'approved');
  assert.equal(durable.backgroundAdmission?.taskId, taskId);
  assert.equal(durable.backgroundAdmission?.completedAt, undefined);
  assert.equal(tasks.getBackgroundTask(taskId), null, 'no task existed at the simulated crash boundary');

  const recovery = await runChild(`
    const admissions = await import(${JSON.stringify(ADMISSION_MODULE)});
    const result = admissions.reconcileApprovedPlanTaskAdmissions();
    process.stdout.write('<<<' + JSON.stringify(result) + '>>>');
  `) as admissions.ApprovedPlanAdmissionReconcileResult;
  assert.equal(recovery.materialized, 1);
  assert.equal(recovery.completed, 1);

  const task = tasks.getBackgroundTask(taskId)!;
  assert.ok(task);
  assert.match(task.prompt, /edited, user-approved customer-health brief/);
  assert.match(task.prompt, /Use only the edited approved source list/);
  assert.doesNotMatch(task.prompt, /Write the quarterly customer-health brief/);
  assert.equal(runs.getRun(`run-${taskId}`)?.status, 'queued');
  assert.equal(planQueuedNotifications(proposal.id).length, 1);
  assert.equal(taskNotifications(taskId).length, 1);
  assert.ok(plans.getPlanProposal(proposal.id)?.backgroundAdmission?.completedAt);
});

test('crash after task write repairs run and notification projections exactly once', async () => {
  const proposal = surface('task-write crash', { sessionId: 'sess-task-write-crash' });
  const taskId = admissions.approvedPlanBackgroundTaskId(proposal.id);
  tasks._setBackgroundTaskCreationFaultForTests(() => {
    throw new Error('simulated task-write crash');
  });
  try {
    assert.throws(
      () => admissions.approvePlanAndQueueBackgroundTask(proposal.id, { allowedTools: [] }),
      /task-write crash/,
    );
  } finally {
    tasks._setBackgroundTaskCreationFaultForTests(null);
  }

  assert.ok(tasks.getBackgroundTask(taskId), 'the durable task write precedes the fault');
  assert.equal(runs.getRun(`run-${taskId}`), undefined, 'run projection is after the fault');
  assert.equal(planQueuedNotifications(proposal.id).length, 0, 'plan queued projection is after the fault');
  assert.equal(taskNotifications(taskId).length, 0, 'task queued projection is after the fault');
  assert.equal(plans.getPlanProposal(proposal.id)?.backgroundAdmission?.completedAt, undefined);

  await runChild(`
    const admissions = await import(${JSON.stringify(ADMISSION_MODULE)});
    const first = admissions.reconcileApprovedPlanTaskAdmissions();
    const second = admissions.reconcileApprovedPlanTaskAdmissions();
    process.stdout.write('<<<' + JSON.stringify({ first, second }) + '>>>');
  `);

  const run = runs.getRun(`run-${taskId}`)!;
  assert.equal(run.status, 'queued');
  assert.equal(run.events.filter((event) => event.type === 'queued_background').length, 1);
  assert.equal(planQueuedNotifications(proposal.id).length, 1);
  assert.equal(taskNotifications(taskId).length, 1);
  assert.equal(
    tasks.listBackgroundTasks({ includeArchived: true }).filter((task) => task.id === taskId).length,
    1,
  );
});

test('two processes and a sequential double-click all rejoin one task and one projection set', async () => {
  const proposal = surface('double click', { sessionId: 'sess-approved-plan-double-click' });
  const invoke = `
    const admissions = await import(${JSON.stringify(ADMISSION_MODULE)});
    const result = admissions.approvePlanAndQueueBackgroundTask(${JSON.stringify(proposal.id)}, { allowedTools: [] });
    process.stdout.write('<<<' + JSON.stringify({ taskId: result?.task.id ?? null }) + '>>>');
  `;
  const [left, right] = await Promise.all([runChild(invoke), runChild(invoke)]) as Array<{ taskId: string | null }>;
  const expectedTaskId = admissions.approvedPlanBackgroundTaskId(proposal.id);
  assert.equal(left.taskId, expectedTaskId);
  assert.equal(right.taskId, expectedTaskId);

  const replay = admissions.approvePlanAndQueueBackgroundTask(proposal.id, { allowedTools: [] });
  assert.equal(replay?.task.id, expectedTaskId);
  assert.equal(
    tasks.listBackgroundTasks({ includeArchived: true }).filter((task) => task.id === expectedTaskId).length,
    1,
  );
  assert.equal(planQueuedNotifications(proposal.id).length, 1);
  assert.equal(taskNotifications(expectedTaskId).length, 1);
  assert.equal(
    runs.getRun(`run-${expectedTaskId}`)?.events.filter((event) => event.type === 'queued_background').length,
    1,
  );
  assert.equal(
    plans.listPlanProposals({ status: 'all', sessionId: `background:${expectedTaskId}` })
      .filter((goal) => goal.origin?.kind === 'background').length,
    1,
    'replay did not mint a second background goal contract',
  );
});

test('concurrent Approve and Reject have one truthful winner', async () => {
  const proposal = surface('decision race', { sessionId: 'sess-approved-plan-decision-race' });
  const approveSource = `
    const admissions = await import(${JSON.stringify(ADMISSION_MODULE)});
    const result = admissions.approvePlanAndQueueBackgroundTask(${JSON.stringify(proposal.id)}, { allowedTools: [] });
    process.stdout.write('<<<' + JSON.stringify({ taskId: result?.task.id ?? null }) + '>>>');
  `;
  const rejectSource = `
    const plans = await import(${JSON.stringify(PLAN_MODULE)});
    const result = plans.rejectPlanProposal(${JSON.stringify(proposal.id)}, 'concurrent rejection');
    process.stdout.write('<<<' + JSON.stringify({ status: result?.status ?? null }) + '>>>');
  `;
  const [approved, rejected] = await Promise.all([
    runChild(approveSource),
    runChild(rejectSource),
  ]) as [{ taskId: string | null }, { status: string | null }];

  const final = plans.getPlanProposal(proposal.id)!;
  const taskId = admissions.approvedPlanBackgroundTaskId(proposal.id);
  if (final.status === 'rejected') {
    assert.equal(rejected.status, 'rejected');
    assert.equal(approved.taskId, null);
    assert.equal(tasks.getBackgroundTask(taskId), null);
  } else {
    assert.ok(final.status === 'approved' || final.status === 'active');
    assert.equal(approved.taskId, taskId);
    assert.equal(rejected.status, null, 'a stale Reject reported success after approval won');
    assert.equal(plans.rejectPlanProposal(proposal.id, 'stale replay'), null);
    assert.ok(tasks.getBackgroundTask(taskId));
  }
});

test('rejected, superseded, and needs-input plans never materialize a task', () => {
  const rejected = surface('rejected negative');
  assert.equal(plans.rejectPlanProposal(rejected.id, 'do not run')?.status, 'rejected');
  assert.equal(admissions.approvePlanAndQueueBackgroundTask(rejected.id), null);
  assert.equal(tasks.getBackgroundTask(admissions.approvedPlanBackgroundTaskId(rejected.id)), null);

  const superseded = surface('superseded negative');
  assert.equal(plans.supersedePlanProposal(superseded.id, 'replacement-plan')?.status, 'superseded');
  assert.equal(admissions.approvePlanAndQueueBackgroundTask(superseded.id), null);
  assert.equal(tasks.getBackgroundTask(admissions.approvedPlanBackgroundTaskId(superseded.id)), null);

  const asking = plans.surfaceAskingPlan({
    plan: aPlan({ needsUserInput: ['Which customer segment should the brief cover?'] }),
    originatingRequest: 'Prepare a customer-health brief after I choose the segment.',
    sessionId: 'sess-needs-input-negative',
    channel: 'desktop',
  });
  assert.equal(admissions.approvePlanAndQueueBackgroundTask(asking.id), null);
  assert.equal(tasks.getBackgroundTask(admissions.approvedPlanBackgroundTaskId(asking.id)), null);
});

test('an unfinished admission superseded before recovery remains inert', () => {
  const sessionId = 'sess-superseded-admission';
  const proposal = surface('superseded after crash', { sessionId });
  plans._setBackgroundApprovalWriteFaultForTests(() => {
    throw new Error('approval persisted, process died');
  });
  try {
    assert.throws(
      () => admissions.approvePlanAndQueueBackgroundTask(proposal.id, { allowedTools: [] }),
      /process died/,
    );
  } finally {
    plans._setBackgroundApprovalWriteFaultForTests(null);
  }
  assert.equal(plans.activateGoal(proposal.id, { origin: { kind: 'chat' } })?.status, 'active');

  const replacement = surface('replacement winner', { sessionId });
  assert.equal(plans.approvePlanProposal(replacement.id, { allowedTools: [] })?.status, 'active');
  assert.equal(plans.getPlanProposal(proposal.id)?.status, 'superseded');

  const reconciliation = admissions.reconcileApprovedPlanTaskAdmissions();
  assert.ok(reconciliation.skipped >= 1);
  assert.equal(
    tasks.getBackgroundTask(admissions.approvedPlanBackgroundTaskId(proposal.id)),
    null,
    'superseded accepted-plan intent was incorrectly resurrected',
  );
});

test('daemon boot and ordinary background tick both repair admissions before worker drain', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'src/daemon/runner.ts'), 'utf-8');
  const calls = [...source.matchAll(/reconcileApprovedPlanTaskAdmissions\(\)/g)].map((match) => match.index!);
  assert.equal(calls.length, 2, 'admission recovery must have one boot pass and one ordinary-tick pass');
  const interrupt = source.indexOf('const interrupted = interruptStaleRunningBackgroundTasks();');
  assert.ok(calls[0] < interrupt, 'boot repairs admission before background restart/task handling');
  const drain = source.indexOf('const drainBackgroundTasks = () => {');
  const process = source.indexOf("withDaemonRuntimePhase('daemon.timer.background_tasks'", drain);
  assert.ok(calls[1] > drain && calls[1] < process, 'ordinary tick repairs admission before dispatch');
});
