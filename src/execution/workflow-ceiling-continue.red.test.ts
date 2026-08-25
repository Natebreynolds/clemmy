/**
 * RED — a per-turn tool-call ceiling is a CHECKPOINT, not an end.
 *
 * Run: npx tsx --test src/execution/workflow-ceiling-continue.red.test.ts
 *
 * Invariant under pin (budget-settings NEVER-RESTING contract): a run stops
 * only for a terminal outcome, a user-owned gate, a user stop, or zero
 * progress. Concretely:
 *   1. reduceStandardConversationTerminal must commit a continue-shaped
 *      RESUMABLE terminal for a limit_exceeded activation, so callers receive
 *      status 'limit_exceeded' — never a blocked park — while the durable
 *      resume-door label ('step_budget_parked') stays byte-identical for its
 *      structural consumers (continue-directive, session-reconcile, gateway).
 *   2. the workflow runner's continue loop must actually resume a step that
 *      parked on the tool-call ceiling (the ceiling only trips AFTER the
 *      limit's worth of settled calls — progress by construction) through the
 *      one continue directive, and finish the step.
 *   3. a zero-progress limit park must terminate immediately, and a ceiling
 *      that re-trips forever must stop at the continue cap — never spin.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-wf-ceiling-continue-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMENTINE_WORKFLOW_HARNESS_POLL_MS = '20';
// A tight cap keeps the never-progressing-ceiling case cheap while still
// proving the cap is what bounds it.
process.env.CLEMMY_CHAT_AUTO_CONTINUE_CAP = '3';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-wf-ceiling-continue\n', 'utf8');

const {
  processWorkflowRuns,
  _setWorkflowHarnessLoopImplsForTests,
  _setWorkflowVoiceRewriteForTests,
  _setWorkflowWatcherForTests,
} = await import('./workflow-runner.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { recordStepResult } = await import('../tools/step-result-tool.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const loop = await import('../runtime/harness/loop.js');

// No live judge / no live voice model in this hermetic file.
_setWorkflowWatcherForTests(async () => ({ onTrack: true, miss: '', steer: '' }));
_setWorkflowVoiceRewriteForTests(async (body: string) => ({ message: body, nothingHappened: false }));

test.after(() => {
  _setWorkflowHarnessLoopImplsForTests();
  _setWorkflowVoiceRewriteForTests(null);
  _setWorkflowWatcherForTests(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function queueRun(workflowName: string, runId: string): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');
  return runFile;
}

async function drain(): Promise<void> {
  await processWorkflowRuns({
    respond: async () => { throw new Error('legacy respond path must not run in this fixture'); },
  } as never);
}

/** The tool-call ceiling's honest conversation shape: the counter tripped
 * inside the turn, so no orchestrator step completed, but the limit's worth
 * of tool calls settled first. */
function ceilingResult(sessionId: string, lastTurn: number) {
  return {
    sessionId,
    status: 'limit_exceeded' as const,
    limitKind: 'tool_calls' as const,
    steps: 0,
    lastTurn,
    error: 'ToolCallsLimitExceeded: 64 tool calls per turn exceeded',
    lastDecision: { summary: 'Collected 64 of 300 rows so far.' },
  };
}

test('a limit_exceeded activation reduces to a continue-shaped resumable terminal', () => {
  const sessionId = 'workflow:ceiling-reduce-probe:collect';
  eventlog.createSession({ id: sessionId, kind: 'workflow' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Collect all 300 tracker rows.' },
  });

  const reduced = loop._testOnly_reduceStandardConversationTerminal({
    result: ceilingResult(sessionId, 1) as never,
    sourceUserSeq: source.seq,
  });

  assert.equal(
    reduced.status,
    'limit_exceeded',
    'a ceiling checkpoint was demoted to a non-resumable caller status — the '
    + "runner's continue loop can never receive it",
  );
  assert.equal(
    reduced.publicPresentation?.needs?.kind,
    'continue',
    'the committed terminal is not continue-shaped, so no consumer can see a resumable checkpoint',
  );
  assert.equal(reduced.publicPresentation?.resumable, true);

  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] })[0];
  assert.equal(
    terminal?.data?.reason,
    'step_budget_parked',
    'the structural resume-door label consumed by continue-directive/session-reconcile/gateway must not change',
  );
});

test('the runner resumes a step parked on the tool-call ceiling and completes it', async () => {
  const workflowName = 'Ceiling Continue Collect';
  writeWorkflow('ceiling-continue-collect', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'collect_rows', prompt: 'Collect every tracker row.', sideEffect: 'read' }],
  });
  const runId = 'ceiling-continue-collect-run';
  const runFile = queueRun(workflowName, runId);

  const activationInputs: string[] = [];
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string; input?: string }) => {
      const sessionId = String(request.sessionId ?? '');
      activationInputs.push(String(request.input ?? ''));
      if (activationInputs.length === 1) return ceilingResult(sessionId, 1);
      recordStepResult(sessionId, { ok: true, rows: [{ id: 'row-1' }, { id: 'row-2' }] });
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 2,
        lastDecision: { summary: 'Collected all 300 rows.' },
      };
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  assert.equal(
    activationInputs.length,
    2,
    'the ceiling checkpoint was never resumed — the step parked instead of continuing',
  );
  assert.match(
    activationInputs[1]!,
    /pick up where you left off/i,
    'the resume must re-enter through the one continue directive',
  );
  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string };
  assert.equal(terminal.status, 'completed', `the resumed run must finish, got ${terminal.status}`);
});

test('an untyped guardrail limit park terminates immediately instead of resuming', async () => {
  const workflowName = 'Ceiling Zero Progress';
  writeWorkflow('ceiling-zero-progress', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'spin_guard', prompt: 'Sync the tracker rows.', sideEffect: 'read' }],
  });
  const runId = 'ceiling-zero-progress-run';
  const runFile = queueRun(workflowName, runId);

  let activations = 0;
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string }) => {
      activations += 1;
      return {
        sessionId: String(request.sessionId ?? ''),
        // The identical-args guardrail escalation, in its REAL live shape:
        // stepIndex increments before runTurn, so the park arrives with
        // steps >= 1 and NO typed limitKind. A deliberate spin-stop on
        // mutating tools must stay stopped — only the typed tool-calls
        // ceiling is a resumable checkpoint.
        status: 'limit_exceeded',
        steps: 3,
        lastTurn: 1,
        error: 'I stopped because I kept calling `alpha_tracker_sync` with the same arguments and was not making progress.',
      };
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  assert.equal(activations, 1, `an untyped guardrail park must not resume (activations: ${activations})`);
  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string };
  assert.notEqual(terminal.status, 'completed');
  assert.notEqual(terminal.status, 'running');
});

test('a ceiling that re-trips without ever finishing stops at the continue cap', async () => {
  const workflowName = 'Ceiling Cap Bound';
  writeWorkflow('ceiling-cap-bound', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'cap_guard', prompt: 'Collect every tracker row.', sideEffect: 'read' }],
  });
  const runId = 'ceiling-cap-bound-run';
  const runFile = queueRun(workflowName, runId);

  let activations = 0;
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string }) => {
      activations += 1;
      return ceilingResult(String(request.sessionId ?? ''), activations);
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  // 1 initial activation + CLEMMY_CHAT_AUTO_CONTINUE_CAP resumes, then park.
  assert.equal(activations, 4, `the continue cap must bound a never-finishing ceiling (activations: ${activations})`);
  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string };
  assert.notEqual(terminal.status, 'completed');
  assert.notEqual(terminal.status, 'running');
});
