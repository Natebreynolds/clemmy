/**
 * RED — the workflow run terminal must reconcile with the settlement spine.
 *
 * Run: npx tsx --test src/execution/workflow-terminal-settlement-truth.red.test.ts
 *
 * Invariant under pin: a workflow controller may not declare success while the
 * runtime truth of its own step sessions contradicts it. At terminal:
 *   - a step whose durable logical settlement says `unsupported_capability`
 *     cannot project `succeeded`/report `done` just because the model emitted a
 *     clean workflow_step_result (caller boolean),
 *   - zero open logical calls / started physical dispatches is a terminal
 *     precondition,
 *   - an external write recorded pre-dispatch with NO success confirmation is
 *     UNCERTAIN and must surface in the run report, not read as a clean done.
 *
 * Today the run terminal derives success purely from model-supplied step
 * outputs (shape/prose heuristics) and never reads logical_call_settlements,
 * logical_tool_calls, physical_dispatches, or the external-write ledger for its
 * `workflow:<runId>:<stepId>` sessions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-wf-terminal-truth-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMENTINE_WORKFLOW_HARNESS_POLL_MS = '20';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-wf-terminal-truth\n', 'utf8');

const {
  processWorkflowRuns,
  auditWorkflowRunSettlementTruth,
  _setWorkflowHarnessLoopImplsForTests,
  _setWorkflowVoiceRewriteForTests,
  _setWorkflowWatcherForTests,
} = await import('./workflow-runner.js');
const { deriveWorkflowTerminalOutcome } = await import('./workflow-terminal-outcome.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const identities = await import('../runtime/harness/attempt-identity.js');
const dispatch = await import('../runtime/harness/dispatch-ledger.js');
const shadow = await import('../runtime/graph/turn-graph-shadow.js');
const outcomes = await import('../runtime/harness/attempt-outcome.js');
const settlements = await import('../runtime/harness/logical-call-settlement-store.js');
const { resolveWriteEvidence } = await import('../runtime/harness/work-report.js');
const { recordStepResult } = await import('../tools/step-result-tool.js');
const { getRun } = await import('../runtime/run-events.js');

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

interface TerminalRunRecord {
  status?: string;
  terminalOutcome?: string;
  needsAttention?: boolean;
  output?: unknown;
  reportBack?: { outcome?: string; detail?: string };
}

function queueRun(workflowName: string, runId: string, originSessionId?: string): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
    ...(originSessionId ? { originSessionId } : {}),
  }), 'utf-8');
  return runFile;
}

/** The exact accepted source the runner minted for this step session. */
function stepSource(sessionId: string) {
  const source = eventlog.listEvents(sessionId, { types: ['user_input_received'] })[0];
  assert.ok(source, `fixture precondition: the runner minted an accepted source for ${sessionId}`);
  return {
    sessionId,
    sourceUserSeq: source.seq,
    turn: source.turn,
    acceptedTaskId: identities.acceptedTaskIdFor(sessionId, source.seq),
  };
}

async function drain(): Promise<void> {
  await processWorkflowRuns({
    respond: async () => { throw new Error('legacy respond path must not run in this fixture'); },
  } as never);
}

test('a step settled unsupported_capability cannot project a succeeded run, whatever the model claimed', async () => {
  const workflowName = 'Settlement Truth One Step';
  writeWorkflow('settlement-truth-one-step', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'pull_records', prompt: 'Pull the current alpha records.', sideEffect: 'read' }],
  });
  const runId = 'settlement-truth-one-step-run';
  const runFile = queueRun(workflowName, runId);

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string }) => {
      const sessionId = String(request.sessionId ?? '');
      const task = stepSource(sessionId);
      const logicalToolCallId = 'logical:unsupported-pull';
      const begun = dispatch.beginPhysicalDispatch({
        identity: {
          ...task,
          logicalToolCallId,
          physicalDispatchId: 'dispatch:unsupported-pull',
          ordinal: 0,
        },
        tool: 'alpha_records_search',
        args: { query: 'all records' },
      });
      assert.equal(begun.status, 'inserted', `fixture precondition: ${JSON.stringify(begun)}`);
      if (begun.status !== 'inserted') throw new Error('fixture dispatch not admitted');
      assert.equal(dispatch.settlePhysicalDispatch({
        identity: begun.identity,
        tool: 'alpha_records_search',
        outcome: 'returned',
      }).status, 'inserted');
      const settled = settlements.commitLogicalCallSettlement({
        identity: { ...task, logicalToolCallId },
        contract: { toolName: 'alpha_records_search', args: { query: 'all records' } },
        execution: { kind: 'provider_execution' },
        result: { payload: { successful: false, error: 'operation not implemented' } },
        // http 501 → 'unsupported_capability' (structured evidence).
        outcome: outcomes.classifyAttemptOutcome({ httpStatus: 501 }),
        recovery: { businessCall: true, mutating: false },
        observer: { lane: 'composio', turn: task.turn },
      });
      assert.equal(settled.status, 'committed', `fixture precondition: ${JSON.stringify(settled)}`);
      // The model's caller-supplied success boolean, contradicting the ledger.
      recordStepResult(sessionId, { ok: true, records: [{ id: 'alpha-1' }] });
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'Pulled 1 record.' },
      };
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  // FIXTURE PROOF — the step session's durable settlement says unsupported.
  const stepSessionId = `workflow:${runId}:pull_records`;
  const row = eventlog.openEventLog().prepare(`
    SELECT state, outcome_kind FROM logical_tool_calls WHERE session_id = ?
  `).get(stepSessionId) as { state: string; outcome_kind: string } | undefined;
  assert.deepEqual(row, { state: 'settled', outcome_kind: 'unsupported_capability' });

  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as TerminalRunRecord;
  assert.equal(terminal.status && ['completed', 'completed_with_errors', 'error'].includes(terminal.status), true,
    `fixture precondition: the run reached a business terminal, got ${terminal.status}`);

  // TARGET — the projected run outcome may not be 'succeeded' while the only
  // settled call of its only step is unsupported_capability.
  assert.notEqual(
    deriveWorkflowTerminalOutcome(terminal),
    'succeeded',
    'the run projected succeeded from the model-supplied workflow_step_result while the '
    + `step session's settlement ledger says unsupported_capability — reportBack.outcome=`
    + `${JSON.stringify(terminal.reportBack?.outcome)}`,
  );
});

test('a run terminal with a STARTED physical dispatch in a step session is not clean succeeded', async () => {
  const workflowName = 'Open Dispatch One Step';
  writeWorkflow('open-dispatch-one-step', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'sync_tracker', prompt: 'Sync the tracker rows.', sideEffect: 'read' }],
  });
  const runId = 'open-dispatch-one-step-run';
  const runFile = queueRun(workflowName, runId);

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string }) => {
      const sessionId = String(request.sessionId ?? '');
      const task = stepSource(sessionId);
      // A paid crossing that never came back: dispatch started, never settled.
      const begun = dispatch.beginPhysicalDispatch({
        identity: {
          ...task,
          logicalToolCallId: 'logical:open-sync',
          physicalDispatchId: 'dispatch:open-sync',
          ordinal: 0,
        },
        tool: 'alpha_tracker_sync',
        args: { rows: 40 },
      });
      assert.equal(begun.status, 'inserted', `fixture precondition: ${JSON.stringify(begun)}`);
      recordStepResult(sessionId, { ok: true, synced: 40 });
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'Synced the tracker.' },
      };
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  // FIXTURE PROOF — an in-flight crossing survives into the terminal window.
  const stepSessionId = `workflow:${runId}:sync_tracker`;
  const open = eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND state = 'open') AS openCalls,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND state = 'started') AS startedDispatches
  `).get(stepSessionId, stepSessionId) as { openCalls: number; startedDispatches: number };
  assert.deepEqual(open, { openCalls: 1, startedDispatches: 1 });

  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as TerminalRunRecord;
  const projected = deriveWorkflowTerminalOutcome(terminal);

  // TARGET — zero open calls/dispatches is a terminal precondition: a run that
  // still owns a started crossing may not read as a clean success.
  assert.ok(
    !(projected === 'succeeded' && terminal.needsAttention !== true),
    'the run projected a CLEAN succeeded terminal while its step session still owns an '
    + 'OPEN logical call with a started physical dispatch — open work must be reconciled '
    + `(or flagged) before terminal; projected=${JSON.stringify(projected)}`,
  );
});

test('an unconfirmed pre-dispatch external write must surface in the run report, not read as done', async () => {
  const workflowName = 'Uncertain Send One Step';
  writeWorkflow('uncertain-send-one-step', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'send_update', prompt: 'Send the account update email.', sideEffect: 'send' }],
  });
  const runId = 'uncertain-send-one-step-run';
  const runFile = queueRun(workflowName, runId);

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string }) => {
      const sessionId = String(request.sessionId ?? '');
      const task = stepSource(sessionId);
      // A real tool call happened (so this is not a phantom completion) …
      eventlog.appendEvent({
        sessionId,
        turn: task.turn,
        role: 'system',
        type: 'tool_called',
        data: {
          tool: 'composio_execute_tool',
          callId: 'call-send-1',
          arguments: JSON.stringify({ tool_slug: 'ALPHA_SEND_EMAIL' }),
        },
      });
      // … and the write ledger recorded the reservation, but NO success row —
      // the transport died before confirmation, so the send is UNCERTAIN.
      eventlog.appendEvent({
        sessionId,
        turn: task.turn,
        role: 'system',
        type: 'external_write',
        data: {
          shapeKey: 'email_send',
          preDispatch: true,
          callId: 'call-send-1',
          targets: ['casey@example.com'],
          irreversible: true,
        },
      });
      // The model claims the send happened.
      recordStepResult(sessionId, { ok: true, sent: true, messageId: 'msg-20260811-01' });
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'Sent the account update to Casey.' },
      };
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  // FIXTURE PROOF — by the host's own write-evidence semantics this send is
  // uncertain: one pre-dispatch reservation, zero confirmations.
  const stepSessionId = `workflow:${runId}:send_update`;
  const evidence = resolveWriteEvidence(eventlog.listEvents(stepSessionId, { limit: 500 }));
  assert.equal(evidence.confirmed.length, 0, 'fixture precondition: nothing confirms the send');
  assert.equal(evidence.uncertain.length, 1, 'fixture precondition: the reservation is uncertain');

  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as TerminalRunRecord;

  // TARGET — external writes reconcile with their evidence at terminal: an
  // uncertain irreversible send may not be reported as a clean done.
  assert.ok(
    terminal.reportBack?.outcome !== 'done' || terminal.needsAttention === true,
    'the run reported a clean done while the only external write of its send step is '
    + 'UNCERTAIN (external_write preDispatch with no external_write_succeeded) — the '
    + 'report was derived from the model claim, not the write ledger; '
    + `reportBack=${JSON.stringify(terminal.reportBack?.outcome)} needsAttention=${JSON.stringify(terminal.needsAttention)}`,
  );
});

test('a later accepted source cannot hide an older in-flight crossing in the same workflow step', () => {
  const runId = 'settlement-history-run';
  const sessionId = `workflow:${runId}:sync_records`;
  eventlog.createSession({ id: sessionId, kind: 'workflow' });
  const oldSource = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'First attempt.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId, turn: oldSource.turn, sourceUserSeq: oldSource.seq },
  }), 'fixture precondition: first accepted source has a durable graph');
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId,
      sourceUserSeq: oldSource.seq,
      turn: oldSource.turn,
      acceptedTaskId: identities.acceptedTaskIdFor(sessionId, oldSource.seq),
      logicalToolCallId: 'logical:older-open-crossing',
      physicalDispatchId: 'dispatch:older-open-crossing',
      ordinal: 0,
    },
    tool: 'alpha_records_search',
    args: { query: 'current records' },
  });
  assert.equal(begun.status, 'inserted', `fixture precondition: ${JSON.stringify(begun)}`);

  // A later retry/source with no contradictory state is not authority to make
  // the older paid crossing disappear. The run-level audit must inspect the
  // whole accepted-source history, not only MAX(seq) for the step session.
  eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Retry.' },
  });

  const audit = auditWorkflowRunSettlementTruth(runId);
  assert.equal(audit.clean, false, `older open crossing was hidden: ${JSON.stringify(audit)}`);
  assert.ok(audit.reasons.some((reason: string) => reason.includes('remain open')), JSON.stringify(audit));
});

test('a settlement-audit downgrade still converges the shared RunRecord to terminal needs-attention', async () => {
  const workflowName = 'Terminal Audit Downgrade Workflow';
  writeWorkflow('terminal-audit-downgrade-workflow', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'summarize',
      prompt: 'Summarize the already available account note.',
      sideEffect: 'read',
      output: { type: 'object' },
    }],
  });
  const runId = 'terminal-audit-downgrade-run';
  const runFile = queueRun(workflowName, runId);

  // A separate child session in this exact workflow run owns a write whose
  // fate is unresolved. The ordinary step can finish, but the RUN cannot report
  // clean success until this hard blocker is reconciled.
  const orphanSession = `workflow:${runId}:orphan_write`;
  eventlog.createSession({ id: orphanSession, kind: 'workflow' });
  const orphanSource = eventlog.appendEvent({
    sessionId: orphanSession,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Persist the update.' },
  });
  eventlog.appendEvent({
    sessionId: orphanSession,
    turn: orphanSource.turn,
    role: 'system',
    type: 'external_write',
    data: {
      shapeKey: 'UPDATE_RECORD',
      preDispatch: true,
      canonicalCallId: 'call-terminal-audit-orphan',
      targets: ['record-alpha'],
    },
  });

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string }) => {
      const sessionId = String(request.sessionId ?? '');
      recordStepResult(sessionId, { summary: 'Account note summarized.' });
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'Account note summarized.' },
      };
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  const durable = JSON.parse(readFileSync(runFile, 'utf-8')) as TerminalRunRecord;
  assert.equal(durable.status, 'completed', 'fixture precondition: the workflow file published a business terminal');
  assert.equal(durable.needsAttention, true, 'the unresolved write must downgrade clean completion');
  const shared = getRun(runId);
  assert.equal(
    shared?.status,
    'completed',
    'writeRunRecord downgraded the terminal envelope internally, then the caller returned before finishRun and left the shared card running forever',
  );
  assert.equal(shared?.needsAttention, true);
});
