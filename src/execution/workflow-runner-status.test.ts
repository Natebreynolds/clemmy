import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-status-'));
process.env.CLEMENTINE_HOME = tmp;
process.env.WORKFLOW_USE_HARNESS = 'on';
process.env.WORKFLOW_STEP_AGENT = 'off';
process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP = 'off';

const {
  executeStep,
  WorkflowHarnessBlockedSignal,
  WorkflowHarnessHeldSignal,
  _setWorkflowHarnessLoopImplsForTests,
  publishWorkflowRunTerminalForTest,
  workflowRunnerInternalsForTest,
} = await import('./workflow-runner.js');
const {
  getLatestRunAttempt,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');
const { readWorkflowEvents } = await import('./workflow-events.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const runEvents = await import('../runtime/run-events.js');

function fixture(label: string) {
  const runId = `wf-status-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const slug = `wf-status-${label}`;
  const step = {
    id: 'status_step',
    prompt: 'Read the source and return the result.',
    sideEffect: 'read' as const,
  };
  const ctx = {
    workflow: {
      name: `Status ${label}`,
      description: 'status consumer test',
      enabled: true,
      steps: [step],
      trigger: { manual: true },
    },
    workflowSlug: slug,
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: {
      async respond() { throw new Error('legacy assistant must not run'); },
    },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];
  return { runId, slug, step, ctx, sessionId: `workflow:${runId}:${step.id}` };
}

test.after(() => {
  _setWorkflowHarnessLoopImplsForTests();
  rmSync(tmp, { recursive: true, force: true });
});

test('workflow held result interrupts only the losing attempt and emits no completion/failure', async () => {
  resetEventLog();
  const f = fixture('held');
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async () => ({
      sessionId: f.sessionId,
      status: 'held',
      steps: 0,
      lastTurn: 1,
      hold: { owner: 'host', wake: 'peer', reason: 'peer_in_progress' },
    })) as never,
  });

  await assert.rejects(
    executeStep(f.step, f.ctx),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowHarnessHeldSignal);
      assert.deepEqual(error.state.hold, { owner: 'host', wake: 'peer', reason: 'peer_in_progress' });
      return true;
    },
  );
  assert.equal(getLatestRunAttempt(f.sessionId)?.status, 'interrupted');
  const events = readWorkflowEvents(f.slug, f.runId);
  assert.equal(events.filter((event) => event.kind === 'step_paused').length, 1);
  assert.equal(events.some((event) => event.kind === 'step_completed' || event.kind === 'step_failed'), false);
});

test('workflow blocked result remains a typed blocked boundary with no step completion', async () => {
  resetEventLog();
  const f = fixture('blocked');
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async () => ({
      sessionId: f.sessionId,
      status: 'blocked',
      steps: 0,
      lastTurn: 1,
      error: 'Exact capability authority is unavailable.',
    })) as never,
  });

  await assert.rejects(
    executeStep(f.step, f.ctx),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowHarnessBlockedSignal);
      assert.match(error.reason, /capability authority/);
      return true;
    },
  );
  const attempt = getLatestRunAttempt(f.sessionId);
  assert.notEqual(attempt?.status, 'completed');
  assert.ok(attempt?.finishedAt, 'the losing local attempt is durably closed');
  const events = readWorkflowEvents(f.slug, f.runId);
  assert.equal(events.filter((event) => event.kind === 'step_blocked').length, 1);
  assert.equal(events.some((event) => event.kind === 'step_completed' || event.kind === 'step_failed'), false);
});

test('workflow canonical writer persists blocked as blocked, never completed or error', () => {
  const runId = `wf-terminal-blocked-${Date.now()}`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const finishedAt = new Date().toISOString();
  const written = publishWorkflowRunTerminalForTest(filePath, {
    id: runId,
    workflow: 'Blocked Writer',
    status: 'blocked',
    finishedAt,
    error: 'Destination binding is unavailable.',
    needsAttention: true,
    blockedSteps: [{ stepId: 'bind_destination', reason: 'Destination binding is unavailable.' }],
  }, {
    workflowName: 'Blocked Writer',
    outcome: 'blocked',
    detail: 'The run is blocked on an exact destination binding.',
  });
  assert.equal(written.status, 'blocked');
  assert.equal(written.terminalOutcome, 'blocked');
  assert.equal(written.reportBack?.outcome, 'blocked');
  const durable = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  assert.equal(durable.status, 'blocked');
  assert.notEqual(durable.status, 'completed');
  assert.notEqual(durable.status, 'error');
});

test('workflow hold writer preserves a durable running owner contract without a terminal', () => {
  const runId = `wf-held-contract-${Date.now()}`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(filePath, JSON.stringify({
    id: runId,
    workflow: 'Held Writer',
    status: 'running',
    startedAt: new Date().toISOString(),
  }));
  const state = {
    stepId: 'read_source',
    sessionId: `workflow:${runId}:read_source`,
    observedAt: new Date().toISOString(),
    sourceStatus: 'held' as const,
    hold: { owner: 'host' as const, wake: 'peer' as const, reason: 'peer_in_progress' as const },
    recoveredContract: false,
  };
  const written = workflowRunnerInternalsForTest.persistWorkflowHarnessHold(filePath, state);
  assert.equal(written?.status, 'running');
  assert.deepEqual(written?.heldExecution, state);
  assert.equal(written?.finishedAt, undefined);
  assert.equal(written?.terminalOutcome, undefined);
});

test('activity run writer exposes a first-class blocked terminal event', () => {
  const id = `activity-blocked-${Date.now()}`;
  runEvents.startRun({
    id,
    sessionId: `session-${id}`,
    source: 'workflow',
    message: 'Run a blocked test.',
  });
  const blocked = runEvents.finishRun(id, {
    status: 'blocked',
    message: 'Exact capability authority is unavailable.',
    needsAttention: true,
  });
  assert.equal(blocked?.status, 'blocked');
  assert.ok(blocked?.completedAt);
  assert.equal(blocked?.events.at(-1)?.type, 'blocked');
  assert.equal(blocked?.events.some((event) => event.type === 'completed' || event.type === 'failed'), false);
});
