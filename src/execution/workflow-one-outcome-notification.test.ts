/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-one-outcome-notification.test.ts
 *
 * One workflow run, one notification for its outcome. These pins drive the
 * real run drain (processWorkflowRuns) end to end; only the model loop, the
 * tone pass and the mid-run watcher are fixtures. The notify_user call is the
 * real tool handler.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-wf-one-outcome-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMENTINE_WORKFLOW_HARNESS_POLL_MS = '20';
// Cross the failure streak on the first failed run so one run shows the fold.
process.env.CLEMENTINE_WORKFLOW_ESCALATE_AFTER = '1';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-wf-one-outcome\n', 'utf8');

const {
  processWorkflowRuns,
  _setWorkflowHarnessLoopImplsForTests,
  _setWorkflowVoiceRewriteForTests,
  _setWorkflowWatcherForTests,
} = await import('./workflow-runner.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { queueWorkflowRun } = await import('../tools/workflow-run-queue.js');
const { recordStepResult } = await import('../tools/step-result-tool.js');
const { registerAutonomyActionTools } = await import('../tools/autonomy-action-tools.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { loadNotifications } = await import('../runtime/notifications.js');
const { readWorkflowEvents } = await import('./workflow-events.js');
const eventlog = await import('../runtime/harness/eventlog.js');

_setWorkflowWatcherForTests(async () => ({ onTrack: true, miss: '', steer: '' }));
_setWorkflowVoiceRewriteForTests(async (body: string) => ({ message: body, nothingHappened: false }));

test.after(() => {
  _setWorkflowHarnessLoopImplsForTests();
  _setWorkflowVoiceRewriteForTests(null);
  _setWorkflowWatcherForTests(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

type NotifyResult = { content?: Array<{ text?: string }> };
type NotifyHandler = (input: Record<string, unknown>) => Promise<NotifyResult>;
const toolHandlers = new Map<string, NotifyHandler>();
registerAutonomyActionTools({
  tool(name: string, _description: string, _schema: unknown, handler: NotifyHandler) {
    toolHandlers.set(name, handler);
  },
} as never);
const notifyUser = toolHandlers.get('notify_user')!;

function queueHandWrittenRun(workflowName: string, runId: string): void {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');
}

/** Every notification that belongs to this run, however it names it. */
function notificationsForRun(runId: string) {
  return loadNotifications().filter((row) =>
    row.metadata?.runId === runId || row.metadata?.workflowRunId === runId);
}

async function drain(): Promise<void> {
  await processWorkflowRuns({
    respond: async () => { throw new Error('legacy respond path must not run in this fixture'); },
  } as never);
}

function stepOf(sessionId: string): { runId: string; stepId: string } {
  const parts = sessionId.split(':');
  return { runId: parts[1] ?? '', stepId: parts.at(-1) ?? '' };
}

test('a clean run whose step told the owner its result has exactly one notification: that report', async () => {
  const workflowName = 'FRAMEWORK-TEST Morning Digest';
  writeWorkflow('framework-test-morning-digest', {
    name: workflowName,
    description: 'Fixture: a step that reports its own result.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'report', prompt: 'Tell the owner what changed overnight.', sideEffect: 'read' }],
  });
  const runId = 'framework-test-morning-digest-run';
  queueHandWrittenRun(workflowName, runId);
  const report = 'Three new accounts in the fixture ledger; nothing needs a reply.';
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (options: { sessionId: string }) => {
      const { runId: workflowRunId, stepId } = stepOf(options.sessionId);
      const receipt = await withToolOutputContext(
        { workflowRunId, sessionId: options.sessionId, stepId },
        () => notifyUser({ title: 'Morning digest', body: report, kind: 'workflow' }),
      );
      recordStepResult(options.sessionId, receipt.content?.[0]?.text ?? 'reported');
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'done', reply: 'done', done: true, nextAction: 'completed' },
      };
    }) as never,
  });
  try {
    await drain();
    const rows = notificationsForRun(runId);
    assert.equal(rows.length, 1, `one outcome, one notification (got: ${rows.map((row) => row.title).join(' | ')})`);
    const [only] = rows;
    assert.equal(only!.body, report, 'the notification carries the content');
    assert.equal(only!.silent, undefined, 'and it is the one that is delivered');
    assert.equal(only!.metadata?.workflow, workflowName, 'it names its workflow');
    assert.equal(only!.metadata?.runId, runId, 'and its run');
    assert.equal(only!.metadata?.runOutcome, 'completed');
    assert.equal(
      loadNotifications().some((row) => row.id === `workflow-${runId}-completed`),
      false,
      'no second record repeats the report',
    );
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }
});

test('a clean run without a step report has exactly one delivered outcome notification', async () => {
  const workflowName = 'FRAMEWORK-TEST Ledger Sweep';
  writeWorkflow('framework-test-ledger-sweep', {
    name: workflowName,
    description: 'Fixture: a read step with a plain result.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'sweep', prompt: 'Count the open fixture ledger rows.', sideEffect: 'read' }],
  });
  const runId = 'framework-test-ledger-sweep-run';
  queueHandWrittenRun(workflowName, runId);
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (options: { sessionId: string }) => {
      recordStepResult(options.sessionId, { openRows: 4 });
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'done', reply: 'done', done: true, nextAction: 'completed' },
      };
    }) as never,
  });
  try {
    await drain();
    const rows = notificationsForRun(runId);
    assert.deepEqual(rows.map((row) => row.id), [`workflow-${runId}-completed`]);
    assert.notEqual(rows[0]!.silent, true);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }
});

test('a send that runs on standing consent is run history, not a notification', async () => {
  const workflowName = 'FRAMEWORK-TEST Team Post';
  const slug = 'framework-test-team-post';
  writeWorkflow(slug, {
    name: workflowName,
    description: 'Fixture: an authored send step without a human gate.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'post', prompt: 'Post the fixture team update.', sideEffect: 'send' }],
  });
  const queued = queueWorkflowRun(workflowName, {});
  assert.ok(queued.id, `fixture precondition: the run queued (${queued.status}: ${queued.message ?? ''})`);
  const runId = queued.id!;
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (options: { sessionId: string }) => {
      recordStepResult(options.sessionId, { posted: true });
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'done', reply: 'done', done: true, nextAction: 'completed' },
      };
    }) as never,
  });
  try {
    await drain();
    const consent = readWorkflowEvents(slug, runId)
      .filter((event) => event.kind === 'approval_granted' && event.meta?.consent === 'standing');
    assert.equal(consent.length, 1, 'the consent is recorded once, in the run\'s own history');
    assert.deepEqual(consent[0]!.meta?.basis, ['authored_send']);
    assert.equal(consent[0]!.stepId, 'post');
    const rows = notificationsForRun(runId);
    assert.equal(
      rows.filter((row) => /without approval/i.test(row.title)).length,
      0,
      'no informational consent notice',
    );
    assert.equal(rows.length, 1, `one outcome, one notification (got: ${rows.map((row) => row.title).join(' | ')})`);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }
});

test('a run refused at preflight that crosses the failure streak says so in its one notification', async () => {
  const workflowName = 'FRAMEWORK-TEST Broken Chain';
  writeWorkflow('framework-test-broken-chain', {
    name: workflowName,
    description: 'Fixture: a step that depends on a step that does not exist.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'summarize', prompt: 'Summarize the fixture rows.', sideEffect: 'read', dependsOn: ['missing_step'] }],
  });
  const runId = 'framework-test-broken-chain-run';
  queueHandWrittenRun(workflowName, runId);
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async () => { throw new Error('a run refused at preflight never reaches a model'); }) as never,
  });
  try {
    await drain();
    const rows = notificationsForRun(runId);
    assert.equal(rows.length, 1, `one outcome, one notification (got: ${rows.map((row) => row.title).join(' | ')})`);
    assert.equal(rows[0]!.id, `workflow-${runId}-preflight`);
    assert.match(rows[0]!.body, /has now failed 1 times in a row\./, 'the crossed streak rides the outcome');
    assert.equal(rows[0]!.metadata?.escalated, true);
    assert.equal(
      loadNotifications().some((row) => row.id === `workflow-${workflowName}-escalated`),
      false,
      'no separate escalation notice',
    );
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }
});
