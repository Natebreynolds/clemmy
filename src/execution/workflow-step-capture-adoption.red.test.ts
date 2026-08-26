/**
 * RED — a settled workflow_step_result is the step's deliverable; its ack echo
 * never is.
 *
 * Run: npx tsx --test src/execution/workflow-step-capture-adoption.red.test.ts
 *
 * Live regression 2026-08-23 (runs 1787745601613-p49r2 step `main`,
 * 1787745601613-trnr2 step `scrape_and_analyze`) — the capture-miss class,
 * back under the durable-activation machinery: the delivery committer demoted
 * a captured-result completion to a BLOCKED terminal, and the runner's blocked
 * branch threw BEFORE takeStepResult(), stranding the payload in the
 * process-local store and adopting the workflow_step_result tool's own ack
 * echo ("Step result captured (N chars).") as the run's blocked reason.
 * Identical stranding class as 2026-08-25, new thrower.
 *
 * Invariants under pin (the design intent both prior verdicts agreed on —
 * THE DELIVERABLE IS THE LOOP'S TERMINAL, a durable restart-surviving carrier):
 *  1. A step whose capture settled succeeded delivers the PAYLOAD as the step
 *     output even when the chat-plane terminal was demoted to blocked; the
 *     workflow lane's own settlement guard — not the presentation demotion —
 *     decides whether the STEP is blocked.
 *  2. A blocked verdict can never carry the capture's ack echo as its reason.
 *  3. The capture survives process loss: adoption reads the durable carrier
 *     written next to the conversation_completed terminal when the
 *     process-local store is empty (restart shape).
 *  4. The settlement walls stay: an uncertain irreversible external write in
 *     the step session still blocks the step — with the settlement reason,
 *     never the ack echo — and the payload is not silently promoted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-wf-capture-adoption-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMENTINE_WORKFLOW_HARNESS_POLL_MS = '20';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-wf-capture-adoption\n', 'utf8');

const {
  processWorkflowRuns,
  _setWorkflowHarnessLoopImplsForTests,
  _setWorkflowVoiceRewriteForTests,
  _setWorkflowWatcherForTests,
} = await import('./workflow-runner.js');
const { readWorkflowEvents } = await import('./workflow-events.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const { recordStepResult, clearStepResult } = await import('../tools/step-result-tool.js');

// The exact ack the tool returns to the MODEL — transport chrome, never a
// deliverable. Byte-identical to the live run records' error field.
const ACK_ECHO = 'Step result captured (313 chars).';
const ACK_ECHO_RE = /Step result captured \(\d+ chars\)\./;

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
  error?: string;
  needsAttention?: boolean;
  output?: unknown;
  blockedSteps?: Array<{ stepId?: string; reason?: string }>;
  reportBack?: { outcome?: string; detail?: string };
}

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

/** The exact accepted source the runner minted for this step session. */
function stepSource(sessionId: string) {
  const source = eventlog.listEvents(sessionId, { types: ['user_input_received'] })[0];
  assert.ok(source, `fixture precondition: the runner minted an accepted source for ${sessionId}`);
  return { sessionId, sourceUserSeq: source.seq, turn: source.turn };
}

async function drain(): Promise<void> {
  await processWorkflowRuns({
    respond: async () => { throw new Error('legacy respond path must not run in this fixture'); },
  } as never);
}

function assertNoAckEchoVerdict(record: TerminalRunRecord, label: string): void {
  assert.ok(
    !(record.error && ACK_ECHO_RE.test(record.error)),
    `${label}: the run's error is the capture tool's own ack echo — `
    + `error=${JSON.stringify(record.error)}`,
  );
  for (const blocked of record.blockedSteps ?? []) {
    assert.ok(
      !(blocked.reason && ACK_ECHO_RE.test(blocked.reason)),
      `${label}: blockedSteps[${JSON.stringify(blocked.stepId)}] adopted the ack echo as its reason — `
      + `reason=${JSON.stringify(blocked.reason)}`,
    );
  }
}

test('a demoted blocked terminal adopts the settled capture: the payload, not its ack echo, becomes the step output', async () => {
  const workflowName = 'Capture Adoption Demoted Terminal';
  writeWorkflow('capture-adoption-demoted-terminal', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'main', prompt: 'Summarize the already available source note into the sheet record.', sideEffect: 'read' }],
  });
  const runId = 'capture-adoption-demoted-terminal-run';
  const runFile = queueRun(workflowName, runId);
  const payload = { spreadsheet_url: 'https://sheets.example/d/pin-adoption-1', appended_rows: 3 };

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string }) => {
      const sessionId = String(request.sessionId ?? '');
      // The capture settled succeeded inside the turn (tool_returned ok) …
      recordStepResult(sessionId, payload);
      // … and the delivery committer demoted the captured-result completion to
      // a blocked terminal whose only authored text is the tool's ack echo —
      // the exact live shape of run 1787745601613-p49r2 (seq 81163).
      return {
        sessionId,
        status: 'blocked',
        steps: 1,
        lastTurn: 1,
        lastDecision: { reply: ACK_ECHO, summary: ACK_ECHO, done: true, nextAction: 'completed' },
      };
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  const record = JSON.parse(readFileSync(runFile, 'utf-8')) as TerminalRunRecord;
  assertNoAckEchoVerdict(record, 'demoted terminal');
  assert.equal(
    record.status,
    'completed',
    'the step emitted and settled its structured deliverable; the chat-plane demotion must not discard it — '
    + `status=${JSON.stringify(record.status)} error=${JSON.stringify(record.error)}`,
  );
  const stepCompleted = readWorkflowEvents('capture-adoption-demoted-terminal', runId)
    .find((event) => event.kind === 'step_completed' && event.stepId === 'main');
  assert.ok(stepCompleted, 'the step must complete with its captured structured result');
  assert.match(
    JSON.stringify(stepCompleted),
    /sheets\.example\/d\/pin-adoption-1/,
    'the PAYLOAD — not the ack echo — is the step output',
  );
  assert.doesNotMatch(JSON.stringify(stepCompleted.output ?? ''), ACK_ECHO_RE);
});

test('a blocked step with no capture never reports the ack echo as its reason', async () => {
  const workflowName = 'Capture Adoption No Capture Block';
  writeWorkflow('capture-adoption-no-capture-block', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'main', prompt: 'Summarize the already available source note.', sideEffect: 'read' }],
  });
  const runId = 'capture-adoption-no-capture-block-run';
  const runFile = queueRun(workflowName, runId);

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string }) => {
      const sessionId = String(request.sessionId ?? '');
      clearStepResult(sessionId); // nothing captured — the block is genuine
      return {
        sessionId,
        status: 'blocked',
        steps: 1,
        lastTurn: 1,
        // An ack-shaped reply with no capture behind it must still never be
        // adopted as the block's explanation.
        lastDecision: { reply: 'Step result captured (4488 chars).', summary: 'Step result captured (4488 chars).' },
      };
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  const record = JSON.parse(readFileSync(runFile, 'utf-8')) as TerminalRunRecord;
  assert.equal(record.status, 'blocked', 'a genuine block without a deliverable stays blocked');
  assertNoAckEchoVerdict(record, 'no-capture block');
  assert.ok(
    (record.error ?? '').trim().length > 0,
    'the blocked run still explains itself with a real reason',
  );
});

test('a restart-stranded capture is adopted from the durable carrier next to the terminal', async () => {
  const workflowName = 'Capture Adoption Restart Carrier';
  writeWorkflow('capture-adoption-restart-carrier', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'main', prompt: 'Summarize the already available source note.', sideEffect: 'read' }],
  });
  const runId = 'capture-adoption-restart-carrier-run';
  const runFile = queueRun(workflowName, runId);
  const payload = { spreadsheet_url: 'https://sheets.example/d/pin-restart-2', appended_rows: 7 };

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string }) => {
      const sessionId = String(request.sessionId ?? '');
      const task = stepSource(sessionId);
      clearStepResult(sessionId); // the process-local store died with the old process
      // The durable carrier the loop writes at capture completion …
      eventlog.appendEvent({
        sessionId,
        turn: task.turn,
        role: 'system',
        type: 'workflow_step_result_captured' as never,
        data: { sourceUserSeq: task.sourceUserSeq, value: payload },
      });
      // … next to the demoted blocked terminal that attests the capture as
      // this conversation's deliverable (live shape: reason stays
      // workflow_step_result_captured on the demoted terminal).
      eventlog.appendEvent({
        sessionId,
        turn: task.turn,
        role: 'system',
        type: 'conversation_completed',
        data: {
          sourceUserSeq: task.sourceUserSeq,
          reason: 'workflow_step_result_captured',
          reply: ACK_ECHO,
          summary: ACK_ECHO,
          delivered: false,
          blockedReason: '1 irreversible external write(s) require reconciliation',
        },
      });
      return {
        sessionId,
        status: 'blocked',
        steps: 1,
        lastTurn: task.turn,
        lastDecision: { reply: ACK_ECHO, summary: ACK_ECHO },
      };
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  const record = JSON.parse(readFileSync(runFile, 'utf-8')) as TerminalRunRecord;
  assertNoAckEchoVerdict(record, 'restart carrier');
  assert.equal(
    record.status,
    'completed',
    'the durable carrier must survive process loss: adoption may not depend on the process-local store — '
    + `status=${JSON.stringify(record.status)} error=${JSON.stringify(record.error)}`,
  );
  const stepCompleted = readWorkflowEvents('capture-adoption-restart-carrier', runId)
    .find((event) => event.kind === 'step_completed' && event.stepId === 'main');
  assert.ok(stepCompleted, 'the step completes from the durable carrier');
  assert.match(JSON.stringify(stepCompleted), /sheets\.example\/d\/pin-restart-2/);
});

test('an uncertain irreversible write still blocks the step — with the settlement reason, never the ack echo', async () => {
  const workflowName = 'Capture Adoption Settlement Wall';
  writeWorkflow('capture-adoption-settlement-wall', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'scrape_and_analyze', prompt: 'Scrape the page and persist the analysis.', sideEffect: 'write' }],
  });
  const runId = 'capture-adoption-settlement-wall-run';
  const runFile = queueRun(workflowName, runId);
  const payload = { posts: [{ id: 'post-1', text: 'scraped' }] };

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: { sessionId?: string }) => {
      const sessionId = String(request.sessionId ?? '');
      const task = stepSource(sessionId);
      // A real business call happened this source (not a phantom completion) …
      eventlog.appendEvent({
        sessionId,
        turn: task.turn,
        role: 'Clem',
        type: 'tool_called',
        data: {
          sourceUserSeq: task.sourceUserSeq,
          tool: 'composio_execute_tool',
          callId: 'call-wall-1',
          arguments: JSON.stringify({ tool_slug: 'ALPHA_SCRAPER_RUN' }),
          accounting: 'top_level',
        },
      });
      // … and an irreversible external write reserved pre-dispatch never got a
      // success/failure terminal — the trnr2 shape (orphaned uncertainty).
      eventlog.appendEvent({
        sessionId,
        turn: task.turn,
        role: 'system',
        type: 'external_write',
        data: {
          shapeKey: 'platform_manage_connections',
          preDispatch: true,
          callId: 'call-wall-orphan',
          targets: ['workspace-alpha'],
          irreversible: true,
        },
      });
      recordStepResult(sessionId, payload);
      return {
        sessionId,
        status: 'blocked',
        steps: 1,
        lastTurn: task.turn,
        lastDecision: { reply: 'Step result captured (4488 chars).', summary: 'Step result captured (4488 chars).' },
      };
    }) as never,
  });
  try {
    await drain();
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  const record = JSON.parse(readFileSync(runFile, 'utf-8')) as TerminalRunRecord;
  assertNoAckEchoVerdict(record, 'settlement wall');
  // The wall holds: the run may not read as a CLEAN success while the step
  // session owns an unreconciled irreversible write.
  assert.ok(
    record.status !== 'completed' || record.needsAttention === true,
    `the settlement wall must survive capture adoption — status=${JSON.stringify(record.status)} `
    + `needsAttention=${JSON.stringify(record.needsAttention)}`,
  );
  // And whatever verdict it publishes explains itself in settlement terms.
  const verdictText = JSON.stringify([record.error, record.blockedSteps, record.reportBack]);
  assert.doesNotMatch(verdictText, ACK_ECHO_RE);
  assert.match(
    verdictText,
    /not complete yet|uncertain|reconcil/i,
    'the blocked verdict carries the settlement diagnosis, not a bare hold',
  );
});
