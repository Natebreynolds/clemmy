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
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const { HostInterruptState } = await import('../runtime/harness/host-turn-runner.js');
const { readWorkflowEvents } = await import('./workflow-events.js');

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

function deferredCeilingResult(sessionId: string, lastTurn: number, sourceUserSeq: number) {
  return loop._testOnly_reduceStandardConversationTerminal({
    result: ceilingResult(sessionId, lastTurn) as never,
    sourceUserSeq,
    deferToolCallsLimitTerminal: true,
  });
}

let settlementSerial = 0;
function settleFixtureBusinessRead(sessionId: string, sourceUserSeq: number): void {
  const source = eventlog.listEvents(sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === sourceUserSeq);
  assert.ok(source);
  settlementSerial += 1;
  const tool = 'read_file';
  const callId = `workflow-approval-read:${settlementSerial}`;
  eventlog.appendEvent({
    sessionId,
    turn: source.turn,
    role: 'tool',
    type: 'tool_called',
    data: { sourceUserSeq, tool, callId, accounting: 'top_level' },
  });
  eventlog.appendEvent({
    sessionId,
    turn: source.turn,
    role: 'tool',
    type: 'tool_returned',
    data: {
      sourceUserSeq,
      tool,
      callId,
      accounting: 'top_level',
      successfulBusinessResult: true,
      result: JSON.stringify({ successful: true, data: { rows: [{ id: 'approved-row' }] } }),
    },
  });
}

test('deferred checkpoint finalization requires the exact one-shot source-bound object', () => {
  const sessionId = 'workflow:deferred-limit-authority:step';
  eventlog.createSession({ id: sessionId, kind: 'workflow' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Collect the bounded rows.' },
  });
  const checkpoint = deferredCeilingResult(sessionId, 1, source.seq);

  assert.throws(() => loop.finalizeDeferredToolCallsLimitTerminal({
    checkpoint: { ...checkpoint },
    sourceUserSeq: source.seq,
    outcome: { kind: 'completed', text: 'forged copy' },
  }), /missing or forged/);
  assert.throws(() => loop.finalizeDeferredToolCallsLimitTerminal({
    checkpoint,
    sourceUserSeq: source.seq + 1,
    outcome: { kind: 'completed', text: 'wrong source' },
  }), /does not match this source/);
  assert.throws(() => loop.finalizeDeferredToolCallsLimitTerminal({
    checkpoint,
    sourceUserSeq: source.seq,
    outcome: { kind: 'completed', text: '   ' },
  }), /requires honest presentation text/);

  const finalized = loop.finalizeDeferredToolCallsLimitTerminal({
    checkpoint,
    sourceUserSeq: source.seq,
    outcome: { kind: 'limit_exceeded' },
  });
  assert.equal(finalized.publicPresentation?.needs?.kind, 'continue');
  assert.throws(() => loop.finalizeDeferredToolCallsLimitTerminal({
    checkpoint,
    sourceUserSeq: source.seq,
    outcome: { kind: 'limit_exceeded' },
  }), /already consumed/);
});

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
    steps: [{
      id: 'collect_rows',
      prompt: 'Collect every tracker row. Do not use memory for this request.',
      sideEffect: 'read',
    }],
  });
  const runId = 'ceiling-continue-collect-run';
  const runFile = queueRun(workflowName, runId);

  const activations: Array<{
    sessionId: string;
    input: string;
    sourceUserSeq?: number;
    reuseRecordedUserInput?: boolean;
    runAttemptId?: string;
    maxWallClockMs?: number;
    deferToolCallsLimitTerminal?: boolean;
    suppressAutomaticMemoryForRequest?: boolean;
  }> = [];
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: {
      sessionId?: string;
      input?: string;
      sourceUserSeq?: number;
      reuseRecordedUserInput?: boolean;
      runAttemptId?: string;
      maxWallClockMs?: number;
      deferToolCallsLimitTerminal?: boolean;
      suppressAutomaticMemoryForRequest?: boolean;
    }) => {
      const sessionId = String(request.sessionId ?? '');
      activations.push({
        sessionId,
        input: String(request.input ?? ''),
        sourceUserSeq: request.sourceUserSeq,
        reuseRecordedUserInput: request.reuseRecordedUserInput,
        runAttemptId: request.runAttemptId,
        maxWallClockMs: request.maxWallClockMs,
        deferToolCallsLimitTerminal: request.deferToolCallsLimitTerminal,
        suppressAutomaticMemoryForRequest: request.suppressAutomaticMemoryForRequest,
      });
      if (activations.length === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        const checkpoint = loop._testOnly_reduceStandardConversationTerminal({
          result: ceilingResult(sessionId, 1) as never,
          sourceUserSeq: request.sourceUserSeq!,
          deferToolCallsLimitTerminal: true,
        });
        assert.equal(checkpoint.publicPresentation, undefined);
        assert.equal(eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).length, 0,
          'no immutable source winner may exist between workflow activations');
        return checkpoint;
      }
      recordStepResult(sessionId, { ok: true, rows: [{ id: 'row-1' }, { id: 'row-2' }] });
      return loop._testOnly_reduceStandardConversationTerminal({
        result: {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 2,
        lastDecision: { summary: 'Collected all 300 rows.' },
        } as never,
        sourceUserSeq: request.sourceUserSeq!,
      });
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  assert.equal(
    activations.length,
    2,
    'the ceiling checkpoint was never resumed — the step parked instead of continuing',
  );
  assert.match(
    activations[1]!.input,
    /pick up where you left off/i,
    'the resume must re-enter through the one continue directive',
  );
  assert.ok(activations[0]!.sourceUserSeq && activations[0]!.sourceUserSeq! > 0);
  assert.equal(
    activations[1]!.sourceUserSeq,
    activations[0]!.sourceUserSeq,
    'the continuation must retain the exact accepted source identity',
  );
  assert.equal(activations[0]!.reuseRecordedUserInput, true);
  assert.equal(activations[1]!.reuseRecordedUserInput, true);
  assert.ok(activations[0]!.runAttemptId);
  assert.equal(
    activations[1]!.runAttemptId,
    activations[0]!.runAttemptId,
    'the continuation must retain the durable outer run attempt',
  );
  assert.equal(activations[0]!.deferToolCallsLimitTerminal, true);
  assert.equal(activations[1]!.deferToolCallsLimitTerminal, true);
  assert.equal(activations[0]!.suppressAutomaticMemoryForRequest, true);
  assert.equal(
    activations[1]!.suppressAutomaticMemoryForRequest,
    true,
    'the authored request-local memory opt-out must survive a fresh tool-limit activation',
  );
  assert.ok((activations[0]!.maxWallClockMs ?? 0) > 0);
  assert.ok((activations[1]!.maxWallClockMs ?? 0) > 0);
  assert.ok(
    activations[1]!.maxWallClockMs! < activations[0]!.maxWallClockMs!,
    'continuation must consume the original absolute deadline instead of reopening the step budget',
  );
  const sourceEvents = eventlog.listEvents(activations[0]!.sessionId, {
    types: ['user_input_received'],
  });
  assert.equal(sourceEvents.length, 1, 'continuation must not record a second accepted user source');
  assert.equal(sourceEvents[0]?.seq, activations[0]!.sourceUserSeq);
  const sourceTerminals = eventlog.listEvents(activations[0]!.sessionId, {
    types: ['conversation_completed'],
  });
  assert.equal(sourceTerminals.length, 1, 'success publishes the source winner only after continuation');
  assert.equal(sourceTerminals[0]?.data?.sourceUserSeq, activations[0]!.sourceUserSeq);
  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string };
  assert.equal(terminal.status, 'completed', `the resumed run must finish, got ${terminal.status}`);
});

test('a tool ceiling returned by approval resume enters the same source-bound continuation loop', async () => {
  const workflowName = 'Approval Resume Ceiling';
  writeWorkflow('approval-resume-ceiling', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'approved_rows', prompt: 'Collect every approved tracker row.', sideEffect: 'read' }],
  });
  const runFile = queueRun(workflowName, 'approval-resume-ceiling-run');
  const ordinaryActivations: Array<Record<string, unknown>> = [];
  const resumeActivations: Array<Record<string, unknown>> = [];
  let approvalId = '';
  let approvalControlSourceUserSeq = 0;
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: {
      sessionId?: string;
      sourceUserSeq?: number;
      runAttemptId?: string;
      reuseRecordedUserInput?: boolean;
      deferToolCallsLimitTerminal?: boolean;
      maxWallClockMs?: number;
    }) => {
      ordinaryActivations.push({ ...request });
      const sessionId = String(request.sessionId ?? '');
      if (ordinaryActivations.length === 1) {
        settleFixtureBusinessRead(sessionId, request.sourceUserSeq!);
        const session = HarnessSession.load(sessionId);
        assert.ok(session);
        session.saveInterruptState(new HostInterruptState([], [{
          callId: 'approval-call-1',
          name: 'fixture_approval_tool',
          rawItem: {
            callId: 'approval-call-1',
            name: 'fixture_approval_tool',
            arguments: JSON.stringify({ scope: 'approved-rows' }),
          },
        }] as never, undefined, 'host_v1').toString());
        const approval = approvalRegistry.register({
          sessionId,
          subject: 'Read the approved rows',
          tool: 'fixture_approval_tool',
          args: { scope: 'approved-rows' },
        });
        approvalId = approval.approvalId;
        assert.equal(approvalRegistry.resolve(approvalId, 'approved', 'fixture-user').ok, true);
        return {
          sessionId,
          status: 'awaiting_approval',
          steps: 1,
          lastTurn: 1,
        };
      }
      assert.equal(eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).length, 0,
        'the approval-owned ceiling source has no terminal before its continuation');
      settleFixtureBusinessRead(sessionId, request.sourceUserSeq!);
      recordStepResult(sessionId, { ok: true, rows: [{ id: 'approved-row' }] });
      return loop._testOnly_reduceStandardConversationTerminal({
        result: {
          sessionId,
          status: 'completed',
          steps: 1,
          lastTurn: 3,
          lastDecision: { summary: 'Collected every approved row.' },
        } as never,
        sourceUserSeq: request.sourceUserSeq!,
      });
    }) as never,
    runConversationFromResume: (async (request: {
      sessionId: string;
      approvalId?: string;
      decision: 'approve' | 'reject' | 'approve_with_edits';
      runAttemptId?: string;
      deferToolCallsLimitTerminal?: boolean;
      maxWallClockMs?: number;
    }) => {
      resumeActivations.push({ ...request });
      approvalControlSourceUserSeq = loop._acceptResumeConversationInputForTest({
        sessionId: request.sessionId,
        approvalId: request.approvalId,
        decision: request.decision,
      });
      return deferredCeilingResult(request.sessionId, 2, approvalControlSourceUserSeq);
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  assert.equal(ordinaryActivations.length, 2);
  assert.equal(resumeActivations.length, 1);
  const initial = ordinaryActivations[0]!;
  const resumed = resumeActivations[0]!;
  const continued = ordinaryActivations[1]!;
  assert.equal(resumed.approvalId, approvalId);
  assert.equal(resumed.decision, 'approve');
  assert.ok(approvalControlSourceUserSeq > 0);
  assert.equal(continued.sourceUserSeq, approvalControlSourceUserSeq,
    'post-approval continuation reuses the accepted approval-control source');
  assert.notEqual(approvalControlSourceUserSeq, initial.sourceUserSeq,
    'the human approval is its own accepted control edge');
  assert.equal(resumed.runAttemptId, initial.runAttemptId);
  assert.equal(continued.runAttemptId, initial.runAttemptId);
  assert.equal(resumed.deferToolCallsLimitTerminal, true);
  assert.equal(continued.deferToolCallsLimitTerminal, true);
  assert.equal(continued.reuseRecordedUserInput, true);
  assert.ok(Number(resumed.maxWallClockMs) > 0);
  assert.ok(Number(continued.maxWallClockMs) > 0);
  const sessionId = String(initial.sessionId);
  const sources = eventlog.listEvents(sessionId, { types: ['user_input_received'] });
  assert.equal(sources.length, 2, 'approval resume adds one control source; its ceiling continuation adds none');
  const terminals = eventlog.listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.data?.sourceUserSeq, approvalControlSourceUserSeq);
  const completedStep = readWorkflowEvents('approval-resume-ceiling', 'approval-resume-ceiling-run')
    .find((event) => event.kind === 'step_completed' && event.stepId === 'approved_rows');
  assert.ok(completedStep);
  assert.notEqual((completedStep.output as { blocked?: unknown } | undefined)?.blocked, true,
    'the settlement guard must audit the approval-control source that owns the post-approval business read');
  assert.equal((JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string }).status, 'completed');
});

test('two sequential approval pauses bind each current card despite cumulative history', async () => {
  const workflowName = 'Sequential Approval Resume';
  writeWorkflow('sequential-approval-resume', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'sequential_rows', prompt: 'Run two protected reads in sequence.', sideEffect: 'read' }],
  });
  const runFile = queueRun(workflowName, 'sequential-approval-resume-run');
  const priorParking = process.env.WORKFLOW_APPROVAL_PARKING;
  process.env.WORKFLOW_APPROVAL_PARKING = 'off';
  const resumedApprovalIds: string[] = [];
  let ordinaryCalls = 0;

  const installPause = (sessionId: string, suffix: 'first' | 'second'): string => {
    const session = HarnessSession.load(sessionId);
    assert.ok(session);
    const callId = `sequential-${suffix}-call`;
    const args = { scope: suffix };
    session.saveInterruptState(new HostInterruptState([], [{
      callId,
      name: 'fixture_approval_tool',
      rawItem: {
        callId,
        name: 'fixture_approval_tool',
        arguments: JSON.stringify(args),
      },
    }] as never, undefined, 'host_v1').toString());
    const row = approvalRegistry.register({
      sessionId,
      subject: `Protected ${suffix} read`,
      tool: 'fixture_approval_tool',
      args,
    });
    setTimeout(() => {
      approvalRegistry.resolve(row.approvalId, 'approved', 'fixture-user');
    }, 30);
    return row.approvalId;
  };

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string; sourceUserSeq?: number }) => {
      ordinaryCalls += 1;
      const sessionId = String(request.sessionId ?? '');
      installPause(sessionId, 'first');
      return {
        sessionId,
        status: 'awaiting_approval',
        steps: 1,
        lastTurn: 1,
      };
    }) as never,
    runConversationFromResume: (async (request: {
      sessionId: string;
      approvalId?: string;
      decision: 'approve' | 'reject' | 'approve_with_edits';
    }) => {
      assert.ok(request.approvalId);
      resumedApprovalIds.push(request.approvalId);
      const controlSource = loop._acceptResumeConversationInputForTest({
        sessionId: request.sessionId,
        approvalId: request.approvalId,
        decision: request.decision,
      });
      if (resumedApprovalIds.length === 1) {
        installPause(request.sessionId, 'second');
        return {
          sessionId: request.sessionId,
          status: 'awaiting_approval',
          steps: 1,
          lastTurn: 2,
        };
      }
      recordStepResult(request.sessionId, { ok: true, rows: ['first', 'second'] });
      return loop._testOnly_reduceStandardConversationTerminal({
        result: {
          sessionId: request.sessionId,
          status: 'completed',
          steps: 1,
          lastTurn: 3,
          lastDecision: { summary: 'Both protected reads completed.' },
        } as never,
        sourceUserSeq: controlSource,
      });
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
    if (priorParking === undefined) delete process.env.WORKFLOW_APPROVAL_PARKING;
    else process.env.WORKFLOW_APPROVAL_PARKING = priorParking;
  }

  assert.equal(ordinaryCalls, 1);
  assert.equal(resumedApprovalIds.length, 2);
  assert.notEqual(resumedApprovalIds[0], resumedApprovalIds[1]);
  assert.equal(new Set(resumedApprovalIds).size, 2);
  assert.equal((JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string }).status, 'completed');
});

test('workflow approval resume fails closed when sibling cards are ambiguous', async () => {
  const workflowName = 'Approval Resume Ambiguous Siblings';
  writeWorkflow('approval-resume-ambiguous-siblings', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'ambiguous_rows', prompt: 'Run both protected reads.', sideEffect: 'read' }],
  });
  const runFile = queueRun(workflowName, 'approval-resume-ambiguous-siblings-run');
  let resumeCalls = 0;
  let stepSessionId = '';
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string }) => {
      stepSessionId = String(request.sessionId ?? '');
      const session = HarnessSession.load(stepSessionId);
      assert.ok(session);
      const calls = [
        { callId: 'sibling-call-a', name: 'fixture_approval_tool', arguments: JSON.stringify({ scope: 'a' }) },
        { callId: 'sibling-call-b', name: 'fixture_approval_tool', arguments: JSON.stringify({ scope: 'b' }) },
      ];
      session.saveInterruptState(new HostInterruptState([], calls.map((call) => ({
        callId: call.callId,
        name: call.name,
        rawItem: { ...call },
      })) as never, undefined, 'host_v1').toString());
      for (const call of calls) {
        const row = approvalRegistry.register({
          sessionId: stepSessionId,
          subject: `Protected ${call.callId}`,
          tool: call.name,
          args: JSON.parse(call.arguments) as Record<string, unknown>,
        });
        assert.equal(approvalRegistry.resolve(row.approvalId, 'approved', 'fixture-user').ok, true);
      }
      return {
        sessionId: stepSessionId,
        status: 'awaiting_approval',
        steps: 1,
        lastTurn: 1,
      };
    }) as never,
    runConversationFromResume: (async () => {
      resumeCalls += 1;
      throw new Error('ambiguous sibling authority reached resume');
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  assert.equal(resumeCalls, 0, 'no sibling card may be selected implicitly');
  assert.equal(eventlog.listEvents(stepSessionId, { types: ['user_input_received'] }).length, 1,
    'an ambiguous approval never mints a control source');
  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string; error?: string };
  assert.notEqual(terminal.status, 'completed');
  assert.match(terminal.error ?? '', /one exact resolved card|ambiguous/i);
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
  let stepSessionId = '';
  let sourceUserSeq = 0;
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string; sourceUserSeq?: number }) => {
      activations += 1;
      stepSessionId = String(request.sessionId ?? '');
      sourceUserSeq = Number(request.sourceUserSeq ?? 0);
      return deferredCeilingResult(stepSessionId, activations, sourceUserSeq);
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  // 1 initial activation + CLEMMY_CHAT_AUTO_CONTINUE_CAP resumes, then park.
  assert.equal(activations, 4, `the continue cap must bound a never-finishing ceiling (activations: ${activations})`);
  assert.equal(eventlog.listEvents(stepSessionId, { types: ['user_input_received'] }).length, 1);
  const sourceTerminals = eventlog.listEvents(stepSessionId, { types: ['conversation_completed'] });
  assert.equal(sourceTerminals.length, 1, 'cap exhaustion must close the accepted source exactly once');
  assert.equal(sourceTerminals[0]?.data?.sourceUserSeq, sourceUserSeq);
  assert.equal(sourceTerminals[0]?.data?.reason, 'step_budget_parked');
  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string };
  assert.notEqual(terminal.status, 'completed');
  assert.notEqual(terminal.status, 'running');
});

test('auto-continue disabled finalizes the deferred checkpoint without relaunching the model', async () => {
  const workflowName = 'Ceiling Continue Disabled';
  writeWorkflow('ceiling-continue-disabled', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'disabled_guard', prompt: 'Collect every tracker row.', sideEffect: 'read' }],
  });
  const runFile = queueRun(workflowName, 'ceiling-continue-disabled-run');
  const priorAutoContinue = process.env.HARNESS_AUTO_CONTINUE_ON_LIMIT;
  process.env.HARNESS_AUTO_CONTINUE_ON_LIMIT = 'off';
  let activations = 0;
  let stepSessionId = '';
  let sourceUserSeq = 0;
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string; sourceUserSeq?: number }) => {
      activations += 1;
      stepSessionId = String(request.sessionId ?? '');
      sourceUserSeq = Number(request.sourceUserSeq ?? 0);
      return deferredCeilingResult(stepSessionId, 1, sourceUserSeq);
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
    if (priorAutoContinue === undefined) delete process.env.HARNESS_AUTO_CONTINUE_ON_LIMIT;
    else process.env.HARNESS_AUTO_CONTINUE_ON_LIMIT = priorAutoContinue;
  }

  assert.equal(activations, 1);
  assert.equal(eventlog.listEvents(stepSessionId, { types: ['user_input_received'] }).length, 1);
  const sourceTerminals = eventlog.listEvents(stepSessionId, { types: ['conversation_completed'] });
  assert.equal(sourceTerminals.length, 1);
  assert.equal(sourceTerminals[0]?.data?.sourceUserSeq, sourceUserSeq);
  assert.equal(sourceTerminals[0]?.data?.reason, 'step_budget_parked');
  assert.notEqual((JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string }).status, 'completed');
});

test('an exhausted absolute deadline finalizes the checkpoint without opening another time window', async () => {
  const workflowName = 'Ceiling Absolute Deadline';
  writeWorkflow('ceiling-absolute-deadline', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'deadline_guard', prompt: 'Collect every tracker row.', sideEffect: 'read' }],
  });
  const runFile = queueRun(workflowName, 'ceiling-absolute-deadline-run');
  let activations = 0;
  let stepSessionId = '';
  let sourceUserSeq = 0;
  let initialWallClockMs = 0;
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    stepWallClockMs: 2_000,
    runConversation: (async (request: {
      sessionId?: string;
      sourceUserSeq?: number;
      maxWallClockMs?: number;
    }) => {
      activations += 1;
      stepSessionId = String(request.sessionId ?? '');
      sourceUserSeq = Number(request.sourceUserSeq ?? 0);
      initialWallClockMs = Number(request.maxWallClockMs ?? 0);
      await new Promise<void>((resolve) => setTimeout(resolve, 2_100));
      return deferredCeilingResult(stepSessionId, 1, sourceUserSeq);
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  assert.equal(activations, 1, 'an exhausted deadline cannot launch a continuation activation');
  assert.ok(initialWallClockMs > 0 && initialWallClockMs <= 2_000);
  const sourceTerminals = eventlog.listEvents(stepSessionId, { types: ['conversation_completed'] });
  assert.equal(sourceTerminals.length, 1);
  assert.equal(sourceTerminals[0]?.data?.sourceUserSeq, sourceUserSeq);
  assert.equal(sourceTerminals[0]?.data?.reason, 'step_budget_parked');
  assert.notEqual((JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string }).status, 'completed');
});

test('a settlement-guarded capture finalizes a capped checkpoint as success exactly once', async () => {
  const workflowName = 'Ceiling Captured Result';
  writeWorkflow('ceiling-captured-result', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'captured_rows', prompt: 'Collect every tracker row.', sideEffect: 'read' }],
  });
  const runFile = queueRun(workflowName, 'ceiling-captured-result-run');
  let activations = 0;
  let stepSessionId = '';
  let sourceUserSeq = 0;
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string; sourceUserSeq?: number }) => {
      activations += 1;
      stepSessionId = String(request.sessionId ?? '');
      sourceUserSeq = Number(request.sourceUserSeq ?? 0);
      assert.equal(eventlog.listEvents(stepSessionId, { types: ['conversation_completed'] }).length, 0,
        'no intermediate ceiling activation may claim the accepted source winner');
      if (activations === 4) {
        recordStepResult(stepSessionId, { ok: true, rows: [{ id: 'captured-row' }] });
      }
      return deferredCeilingResult(stepSessionId, activations, sourceUserSeq);
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  assert.equal(activations, 4);
  assert.equal(eventlog.listEvents(stepSessionId, { types: ['user_input_received'] }).length, 1);
  const sourceTerminals = eventlog.listEvents(stepSessionId, { types: ['conversation_completed'] });
  assert.equal(sourceTerminals.length, 1, 'guarded capture publishes one eventual accepted-source terminal');
  assert.equal(sourceTerminals[0]?.data?.sourceUserSeq, sourceUserSeq);
  assert.equal(sourceTerminals[0]?.data?.reason, 'success');
  assert.equal(eventlog.getSession(stepSessionId)?.status, 'completed');
  assert.equal((JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string }).status, 'completed');
});
