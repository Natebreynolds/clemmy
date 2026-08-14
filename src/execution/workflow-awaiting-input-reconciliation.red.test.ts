/**
 * RED — the canonical awaiting_input run record is a durable presentation
 * outbox. Boot/tick reconciliation must rebuild every user-visible projection
 * after a crash without executing the workflow or duplicating the question.
 *
 * Run:
 *   npx tsx --test src/execution/workflow-awaiting-input-reconciliation.red.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-input-reconcile-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMENTINE_WORKFLOW_HARNESS_POLL_MS = '20';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-workflow-input-reconcile\n', 'utf8');

const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const {
  processWorkflowRuns,
  reconcilePendingWorkflowRuns,
  _setWorkflowHarnessLoopImplsForTests,
} = await import('./workflow-runner.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const { startRun, getRun } = await import('../runtime/run-events.js');
const { listNotifications } = await import('../runtime/notifications.js');
const { setProactiveReportFireForTest } = await import('../runtime/outcome.js');

const runId = 'crash-window-awaiting-input-run';
const workflowName = 'Crash Window Workflow';
const originSessionId = 'discord:crash-window-origin';
const questionId = `workflow-input:${runId}:choose_scope:q1`;
const question = 'Should I use enterprise accounts or every account?';

test.after(() => {
  _setWorkflowHarnessLoopImplsForTests();
  setProactiveReportFireForTest(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('boot repair projects a crash-persisted question exactly once and never executes it', async () => {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'awaiting_input',
    originSessionId,
    inputs: {},
    createdAt: '2026-08-11T18:00:00.000Z',
    startedAt: '2026-08-11T18:00:01.000Z',
    awaitingInput: {
      questionId,
      question,
      stepId: 'choose_scope',
      sessionId: `workflow:${runId}:choose_scope`,
      sessionIdSuffix: 'choose_scope',
      askedAt: '2026-08-11T18:00:02.000Z',
    },
  }), 'utf-8');

  eventlog.createSession({ id: originSessionId, kind: 'chat', channel: 'discord' });
  startRun({
    id: runId,
    sessionId: originSessionId,
    channel: 'discord',
    source: 'workflow',
    title: workflowName,
    message: 'Run the crash-window workflow.',
  });
  setProactiveReportFireForTest(async () => undefined);

  // Simulate daemon boot after the process died immediately after the one
  // canonical awaiting_input write. Running the hook twice proves replay.
  reconcilePendingWorkflowRuns();
  reconcilePendingWorkflowRuns();

  const activity = getRun(runId);
  assert.equal(activity?.status, 'awaiting_input',
    'boot saw canonical awaiting_input but did not rebuild the shared run projection');
  assert.equal(activity?.pendingInput?.kind, 'workflow_clarification');
  assert.equal(
    activity?.pendingInput?.kind === 'workflow_clarification'
      ? activity.pendingInput.questionId
      : undefined,
    questionId,
  );
  assert.equal(
    activity?.events.filter((event) =>
      event.type === 'input_required'
      && event.data?.pendingInput
      && JSON.stringify(event.data.pendingInput).includes(questionId)
    ).length,
    1,
    'replaying the durable outbox duplicated the shared input-required event',
  );

  assert.equal(
    listNotifications(1_000).filter((notification) => notification.id === questionId).length,
    1,
    'the exact stable question notification was lost or duplicated',
  );
  const originQuestions = eventlog.listEvents(originSessionId, { types: ['user_input_received'], limit: 100 })
    .filter((event) =>
      event.data.synthetic === true
      && event.data.source === 'outcome'
      && event.data.sourceId === `${runId}#input-${questionId}`
    );
  assert.equal(originQuestions.length, 1,
    'restart repair did not idempotently deliver the exact question into its origin conversation');

  let executions = 0;
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async () => {
      executions += 1;
      throw new Error('an awaiting-input run must not execute');
    }) as never,
  });
  await processWorkflowRuns({ respond: async () => ({ text: 'must not run' }) } as never);
  assert.equal(executions, 0, 'projection repair re-executed the paused workflow');

  const canonical = JSON.parse(readFileSync(runFile, 'utf-8')) as {
    status?: string;
    awaitingInput?: { questionId?: string; answer?: string };
  };
  assert.equal(canonical.status, 'awaiting_input');
  assert.equal(canonical.awaitingInput?.questionId, questionId);
  assert.equal(canonical.awaitingInput?.answer, undefined);
});
