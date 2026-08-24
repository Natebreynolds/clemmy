/**
 * Regression pins for the standard loop's pre-commit terminal-repair gate.
 *
 * Run:
 *   npx tsx --test src/runtime/harness/loop-delivery-one-gate-wiring.test.ts
 *
 * The shared committer already knows whether an unverified terminal must be
 * held or may be disclosed. These tests exercise the real runConversation
 * call site so a locally correct helper that the loop never asks cannot pass.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { Agent, type Runner } from '@openai/agents';
import { HostInterruptState } from './host-turn-runner.js';
import type { BoundaryJudgeRouting } from './debate-model.js';
import type {
  TerminalDeliveryJudgePort,
  TerminalDeliveryJudgeRequest,
} from './terminal-delivery-judge.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-loop-delivery-one-gate-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_VERIFY_DELIVERED = 'off';
process.env.HARNESS_TOOL_BRACKETS = 'off';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_CONFIRM_BEAT = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-loop-delivery-one-gate\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runConversation, runConversationFromResume } = await import('./loop.js');
const approvalRegistry = await import('./approval-registry.js');
const identities = await import('./attempt-identity.js');
const admission = await import('./expected-work-admission.js');
const dispatch = await import('./dispatch-ledger.js');
const settlement = await import('./attempt-settlement.js');
const audit = await import('./accepted-source-settlement-audit.js');
const delivery = await import('./delivery-committer.js');
const resultHandles = await import('./result-handle.js');
const terminalTools = await import('./terminal-tool.js');
const { withTerminalAuthoringEvidenceReceipt } = await import('../../tools/tool-registry.js');

const ASK = 'Read the source file, then write a local summary report.';
const ORIGINAL_REPLY = 'The source was read and the summary report is complete.';
const REPAIRED_REPLY = 'I read the source, but the summary write is still unverified.';
const JUDGED_REPLY = 'I read the source successfully. The summary write is not verified, so I am delivering the confirmed read result without claiming that file exists.';
const RESUME_INSTRUCTION = 'Write the missing summary file from the retained source result, then verify that exact path.';
const REPEATED_RESUME_ASK = 'I still cannot verify the summary file. Would you like me to retry that write or leave the confirmed read result as-is?';

function makeAgentStub(): Agent<any, any> {
  return {} as Agent<any, any>;
}

function makeRunnerStub(): Runner {
  return new EventEmitter() as unknown as Runner;
}

function completed(items: unknown[]) {
  return {
    history: items,
    lastResponseId: undefined,
    finalOutput: {
      summary: ORIGINAL_REPLY,
      reply: ORIGINAL_REPLY,
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  } as never;
}

function approvalRunState(
  _agent: Agent<any, any>,
  toolName: string,
): string {
  // Runner de-ownership (2026-08-18): paused turns persist HOST interrupt
  // state; the resume owner consumes the same duck-typed surface.
  return new HostInterruptState(
    [{ type: 'message', role: 'user', content: 'approve this' } as never],
    [{
      callId: `${toolName}_call`,
      name: toolName,
      rawItem: { name: toolName, arguments: '{}', callId: `${toolName}_call` },
    }],
  ).toString();
}

function proposal() {
  return {
    version: 1 as const,
    operations: [
      {
        id: 'read-source',
        effect: 'read' as const,
        coverage: 'single' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'write-report',
        effect: 'local_write' as const,
        coverage: null,
        dependsOn: ['read-source'],
        dataFrom: ['read-source'],
        cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
}

/** Freeze a two-operation action contract and settle its first requirement.
 * The intentionally missing write makes presentation repair run; whether the
 * read succeeded is the earned difference between DISCLOSE and HOLD. */
function stageIncompleteAction(
  sessionId: string,
  readOutcome: 'failed' | 'succeeded',
  exactSourceUserSeq?: number,
) {
  const source = exactSourceUserSeq
    ? eventlog.listEvents(sessionId, { types: ['user_input_received'] })
      .find((event) => event.seq === exactSourceUserSeq)
    : eventlog.listEvents(sessionId, { types: ['user_input_received'] }).at(-1);
  assert.ok(source, 'runConversation accepted the exact source before invoking the model');
  assert.equal(
    admission.actionExpectedWorkState({ sessionId, sourceUserSeq: source.seq }).status,
    'required',
    'fixture must enter the standard action lane',
  );

  const acceptedTaskId = identities.acceptedTaskIdFor(sessionId, source.seq);
  const logicalToolCallId = `logical:loop-one-gate:${source.seq}`;
  const args = { path: 'fixtures/source.json' };
  const opened = dispatch.admitLogicalCall({
    identity: {
      sessionId,
      sourceUserSeq: source.seq,
      turn: source.turn,
      acceptedTaskId,
      logicalToolCallId,
    },
    tool: 'read_file',
    args,
  });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));

  const bound = admission.admitExpectedWorkInvocation({
    sessionId,
    sourceUserSeq: source.seq,
    logicalToolCallId,
    proposal: proposal(),
    requirementId: 'read-source',
    tool: 'read_file',
    args,
  });
  assert.equal(bound.status, 'bound', JSON.stringify(bound));

  const settled = settlement.settleToolAttempt({
    sessionId,
    sourceUserSeq: source.seq,
    turn: source.turn,
    lane: 'agents_runner',
    toolName: 'read_file',
    callId: logicalToolCallId,
    args,
    mutating: false,
    businessCall: true,
    requirementId: 'read-source',
    ...(readOutcome === 'succeeded'
      ? { result: { successful: true, data: { records: [{ id: 'row-1' }] }, complete: true } }
      : { thrown: new Error('fixture source read failed') }),
  });
  if (readOutcome === 'succeeded') {
    assert.equal(settled.outcome.kind, 'succeeded');
    const redeemed = resultHandles.redeemSuccessfulSettlementResultForHost({
      sessionId,
      sourceUserSeq: source.seq,
      acceptedTaskId,
      logicalToolCallId,
    });
    assert.equal(redeemed.status, 'ok', JSON.stringify(redeemed));
  } else {
    assert.notEqual(settled.outcome.kind, 'succeeded');
  }

  return { sourceUserSeq: source.seq };
}

function stageUncontractedReadAttempt(
  sessionId: string,
  outcome: 'failed' | 'succeeded',
  ordinal: number,
) {
  const source = eventlog.listEvents(sessionId, { types: ['user_input_received'] })
    .at(-1);
  assert.ok(source);
  const sourceUserSeq = source.seq;
  const logicalToolCallId = `logical:loop-terminal-resume:${sourceUserSeq}:${ordinal}`;
  const args = { path: 'fixtures/source.json' };
  const opened = dispatch.admitLogicalCall({
    identity: {
      sessionId,
      sourceUserSeq,
      turn: source.turn,
      acceptedTaskId: identities.acceptedTaskIdFor(sessionId, sourceUserSeq),
      logicalToolCallId,
    },
    tool: 'read_file',
    args,
  });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  const settled = settlement.settleToolAttempt({
    sessionId,
    sourceUserSeq,
    turn: source.turn,
    lane: 'agents_runner',
    toolName: 'read_file',
    callId: logicalToolCallId,
    args,
    mutating: false,
    businessCall: true,
    ...(outcome === 'succeeded'
      ? { result: { successful: true, data: { records: [{ id: 'row-1' }] } } }
      : { thrown: new Error('fixture read failed before the terminal resume') }),
  });
  if (outcome === 'succeeded') assert.equal(settled.outcome.kind, 'succeeded');
  else assert.notEqual(settled.outcome.kind, 'succeeded');
  return sourceUserSeq;
}

function recordIrreversibleUncertainWrite(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
}): void {
  const data = {
    sourceUserSeq: input.sourceUserSeq,
    callId: `write_loop_irreversible_${input.sourceUserSeq}`,
    canonicalCallId: `write_loop_irreversible_${input.sourceUserSeq}`,
    preDispatch: true,
    irreversible: true,
    shapeKey: 'OUTLOOK_SEND_EMAIL',
    toolName: 'composio_execute_tool',
    targets: ['recipient@example.test'],
  };
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    role: 'system',
    type: 'external_write',
    data,
  });
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    role: 'system',
    type: 'external_write_orphaned',
    data,
  });
}

function terminalJudgePort(
  output: unknown,
  inspect?: (request: TerminalDeliveryJudgeRequest) => void,
): TerminalDeliveryJudgePort {
  return {
    async resolveRoute() {
      return {
        model: {} as BoundaryJudgeRouting['model'],
        modelId: 'claude-haiku-4-5',
        judgeFamily: 'claude',
        brainFamily: 'codex',
        transport: 'claude_subscription',
        selfJudge: false,
      };
    },
    async run(request) {
      inspect?.(request);
      return output;
    },
  };
}

async function runIncompleteAction(
  readOutcome: 'failed' | 'succeeded',
  judgePort?: TerminalDeliveryJudgePort,
) {
  const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'loop one-gate pin' });
  let repairCalls = 0;
  let sourceUserSeq = 0;
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: session.id,
    input: ASK,
    maxSteps: 1,
    judgeCompletion: false,
    makeRunner: makeRunnerStub,
    runRunner: async (runner, _agent, items) => {
      // The scripted runner stands in for one real tool attempt. Count that
      // attempt through the same SDK hook the standard loop observes so the
      // zero-tool stall detector does not obscure the terminal under test.
      (runner as unknown as EventEmitter).emit('agent_tool_start');
      sourceUserSeq = stageIncompleteAction(session.id, readOutcome).sourceUserSeq;
      return completed(items);
    },
    terminalPresentationRepairPort: {
      async render() {
        repairCalls += 1;
        return REPAIRED_REPLY;
      },
    },
    terminalDeliveryJudgePort: judgePort ?? {
      async resolveRoute() { return null; },
      async run() { throw new Error('unavailable judge must not run'); },
    },
  });
  return { result, repairCalls, sessionId: session.id, sourceUserSeq };
}

async function runResumedIncompleteAction(direction: 'hold' | 'disclose') {
  const agent = new Agent({ name: 'ResumeOneGatePin', instructions: 'test' });
  const session = HarnessSession.create({
    kind: 'chat', channel: 'desktop', title: 'approval-resume one-gate pin',
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const toolName = 'approved_fixture_tool';
  session.saveInterruptState(approvalRunState(agent, toolName));
  const approval = approvalRegistry.register({
    sessionId: session.id,
    subject: 'run the exact approved fixture action',
    tool: toolName,
    args: {},
  });
  let repairCalls = 0;
  let sourceUserSeq = 0;
  let builtIdentity: { sessionId: string; sourceUserSeq: number; route: 'direct_reply' | 'retrieve' | 'act' } | undefined;
  const result = await runConversationFromResume({
    buildAgent: async (identity) => {
      builtIdentity = identity;
      return agent;
    },
    sessionId: session.id,
    approvalId: approval.approvalId,
    decision: 'approve',
    resolver: 'one-gate-pin',
    maxSteps: 2,
    makeRunner: makeRunnerStub,
    runRunner: async (runner, _agent, items) => {
      (runner as unknown as EventEmitter).emit('agent_tool_start');
      assert.ok(builtIdentity, 'the resume agent must be built from exact route authority before execution');
      sourceUserSeq = stageIncompleteAction(
        session.id,
        'succeeded',
        builtIdentity.sourceUserSeq,
      ).sourceUserSeq;
      if (direction === 'hold') {
        const source = eventlog.listEvents(session.id, { types: ['user_input_received'] }).at(-1)!;
        recordIrreversibleUncertainWrite({
          sessionId: session.id,
          sourceUserSeq,
          turn: source.turn,
        });
      }
      return completed(items);
    },
    terminalPresentationRepairPort: {
      async render() {
        repairCalls += 1;
        return REPAIRED_REPLY;
      },
    },
    terminalDeliveryJudgePort: {
      async resolveRoute() { return null; },
      async run() { throw new Error('unavailable judge must not run'); },
    },
  });
  assert.ok(builtIdentity, 'approval resume builds only after exact route admission');
  assert.ok(
    sourceUserSeq > 0,
    `approval resume must execute its saved SDK state: ${JSON.stringify(result)}`,
  );
  return {
    result,
    repairCalls,
    sessionId: session.id,
    sourceUserSeq: builtIdentity.sourceUserSeq,
    approvalId: approval.approvalId,
    builtIdentity,
  };
}

beforeEach(() => {
  eventlog.resetEventLog();
  settlement._resetAttemptSettlementStateForTests();
});

after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('loop calls terminal repair and holds when the source has no successful business work', async () => {
  const { result, repairCalls, sessionId, sourceUserSeq } = await runIncompleteAction('failed');
  const settlementAudit = audit.auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq });
  assert.equal(settlementAudit.status, 'unrecovered_failure', JSON.stringify(settlementAudit));
  assert.equal(settlementAudit.facts.businessSettlements, 1, JSON.stringify(settlementAudit));
  assert.equal(settlementAudit.facts.successfulBusinessSettlements, 0, JSON.stringify(settlementAudit));

  assert.equal(repairCalls, 1, 'the loop must call the sealed terminal-repair port');
  assert.equal(
    result.status,
    'blocked',
    'the compatibility status must reflect the loop-specific durable hold',
  );
  assert.equal(result.publicPresentation?.status, 'blocked');
  assert.equal(result.publicPresentation?.text, REPAIRED_REPLY);
});

test('the real Codex hook-to-loop terminal publishes one host-proven workflow creation', async () => {
  const session = HarnessSession.create({
    kind: 'chat', channel: 'desktop', title: 'loop authoring evidence pin',
  });
  const reply = 'Created the disabled manual-only daily digest workflow.';
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: session.id,
    input: 'Create a disabled, unscheduled workflow named daily digest with one read-only step.',
    maxSteps: 1,
    judgeCompletion: false,
    makeRunner: makeRunnerStub,
    runRunner: async (runner, _agent, items) => {
      const details = {
        toolCall: {
          callId: 'call_codex_workflow_create',
          arguments: JSON.stringify({
            name: 'daily digest',
            description: 'Read the first five files.',
            steps: [{ id: 'list-files', sideEffect: 'read' }],
          }),
        },
      };
      (runner as unknown as EventEmitter).emit(
        'agent_tool_start',
        { context: { sessionId: session.id, turn: 1 } },
        { name: 'orchestrator' },
        { name: 'workflow_create' },
        details,
      );
      (runner as unknown as EventEmitter).emit(
        'agent_tool_end',
        { context: { sessionId: session.id, turn: 1 } },
        { name: 'orchestrator' },
        { name: 'workflow_create' },
        withTerminalAuthoringEvidenceReceipt(
          'workflow_create',
          'Created workflow "daily digest".',
        ),
        details,
      );
      return {
        ...completed(items),
        finalOutput: {
          summary: reply,
          reply,
          done: true,
          nextAction: 'completed',
          reason: null,
        },
      } as never;
    },
    terminalDeliveryJudgePort: {
      async resolveRoute() { return null; },
      async run() { throw new Error('host-proven authoring must not need the judge'); },
    },
  });

  const source = eventlog.listEvents(session.id, { types: ['user_input_received'] }).at(-1);
  assert.ok(source);
  const called = eventlog.listEvents(session.id, { types: ['tool_called'] });
  const returned = eventlog.listEvents(session.id, { types: ['tool_returned'] });
  assert.equal(called.length, 1);
  assert.equal(returned.length, 1);
  assert.equal(returned[0]!.parentEventId, called[0]!.id);
  assert.equal(returned[0]!.data.successfulAuthoringResult, true);
  const settlementAudit = audit.auditAcceptedSourceSettlementTruth({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(settlementAudit.status, 'clean', JSON.stringify(settlementAudit));
  assert.equal(settlementAudit.facts.successfulSdkAuthoringResults, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.publicPresentation?.status, 'done');
  assert.match(result.publicPresentation?.text ?? '', /daily digest/);
});

test('loop takes the sole deterministic HOLD edge for an irreversible uncertain write', async () => {
  const session = HarnessSession.create({
    kind: 'chat', channel: 'desktop', title: 'loop irreversible hold pin',
  });
  const hold = 'The send may have crossed the provider boundary, so it needs a human check before any retry.';
  let repairCalls = 0;
  let sourceUserSeq = 0;
  const previousMaxContinuations = process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
  // Exercise the publish-time HOLD itself. The ordinary positive continuation
  // budget first offers the running model a read-only reconciliation turn;
  // zero is the production-supported exhausted-budget shape at this terminal.
  process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = '0';
  try {
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: session.id,
      input: 'Read the source, send the result once, and write the local summary.',
      maxSteps: 1,
      judgeCompletion: false,
      makeRunner: makeRunnerStub,
      runRunner: async (runner, _agent, items) => {
        (runner as unknown as EventEmitter).emit('agent_tool_start');
        const staged = stageIncompleteAction(session.id, 'succeeded');
        sourceUserSeq = staged.sourceUserSeq;
        const source = eventlog.listEvents(session.id, { types: ['user_input_received'] }).at(-1)!;
        recordIrreversibleUncertainWrite({
          sessionId: session.id,
          sourceUserSeq,
          turn: source.turn,
        });
        return completed(items);
      },
      terminalPresentationRepairPort: {
        async render() {
          repairCalls += 1;
          return hold;
        },
      },
      terminalDeliveryJudgePort: {
        async resolveRoute() { return null; },
        async run() { throw new Error('unavailable judge must not run'); },
      },
    });

    const settlementAudit = audit.auditAcceptedSourceSettlementTruth({
      sessionId: session.id,
      sourceUserSeq,
    });
    assert.equal(settlementAudit.status, 'uncertain_write', JSON.stringify(settlementAudit));
    assert.equal(delivery.deliveryMustHoldForHuman(settlementAudit), true);
    assert.equal(repairCalls, 1, 'the exact loop terminal must spend the sealed repair');
    assert.equal(result.status, 'blocked');
    assert.equal(result.publicPresentation?.status, 'blocked');
    assert.equal(result.publicPresentation?.text, hold);
    const terminal = eventlog.listEvents(session.id, { types: ['conversation_completed'] }).at(-1);
    assert.equal(terminal?.data.blockedReason, 'authoritative_terminal_verification_incomplete');
    assert.equal(
      terminal?.data.deliveryDisclosure,
      undefined,
      'the direct irreversible HOLD must not be mislabeled as a disclosure',
    );
  } finally {
    if (previousMaxContinuations === undefined) {
      delete process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
    } else {
      process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = previousMaxContinuations;
    }
  }
});

test('loop calls terminal repair and takes the disclosure edge after real work succeeded', async () => {
  const { result, repairCalls, sessionId, sourceUserSeq } = await runIncompleteAction('succeeded');
  const settlementAudit = audit.auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq });
  assert.equal(settlementAudit.status, 'clean', JSON.stringify(settlementAudit));
  assert.equal(settlementAudit.facts.successfulBusinessSettlements, 1, JSON.stringify(settlementAudit));

  assert.equal(repairCalls, 1, 'the loop must call the sealed terminal-repair port');
  assert.equal(result.status, 'blocked');
  // The lane takes the disclose edge and asks the shared committer to publish
  // done. The accepted-task state machine still refuses to close an incomplete
  // frozen contract, so the committer correctly falls back to a hold. The
  // lane-level distinction remains observable in durable metadata: the shared
  // rule chose DISCLOSE first, then the accepted-task state machine sent the
  // unmanifested completion back to the hold. The returned run status follows
  // that durable authority and the authored text survives.
  assert.equal(result.publicPresentation?.status, 'blocked');
  assert.equal(
    result.publicPresentation?.text,
    REPAIRED_REPLY,
    'the model-authored disclosure must replace the stale done claim without a canned duplicate',
  );
  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.equal(terminal?.data.deliveryDisclosure, 'state_machine_hold');
});

test('approval-resume loop asks the shared gate and takes HOLD for an irreversible uncertain write', async () => {
  const { result, repairCalls, sessionId, sourceUserSeq, builtIdentity } = await runResumedIncompleteAction('hold');
  assert.equal(builtIdentity.route, 'act', 'resume construction receives the admitted action route');
  const settlementAudit = audit.auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq });
  assert.equal(settlementAudit.status, 'uncertain_write', JSON.stringify(settlementAudit));
  assert.equal(delivery.deliveryMustHoldForHuman(settlementAudit), true);
  assert.equal(repairCalls, 1, 'the approval-resume terminal called the sealed repair port');
  assert.equal(result.status, 'blocked');
  assert.equal(result.publicPresentation?.status, 'blocked');
  assert.equal(result.publicPresentation?.text, REPAIRED_REPLY);
  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.equal(
    terminal?.data.deliveryDisclosure,
    undefined,
    'the approval-resume HOLD is direct, not the disclosure fallback',
  );
  assert.equal(
    terminal?.data.blockedReason,
    'authoritative_terminal_verification_incomplete',
  );
});

test('approval-resume loop asks the shared gate and takes DISCLOSE after real work succeeded', async () => {
  const { result, repairCalls, sessionId, sourceUserSeq, builtIdentity } = await runResumedIncompleteAction('disclose');
  assert.equal(builtIdentity.route, 'act', 'resume construction receives the admitted action route');
  const settlementAudit = audit.auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq });
  assert.equal(settlementAudit.status, 'clean', JSON.stringify(settlementAudit));
  assert.equal(settlementAudit.facts.successfulBusinessSettlements, 1, JSON.stringify(settlementAudit));
  assert.equal(delivery.deliveryMustHoldForHuman(settlementAudit), false);
  assert.equal(repairCalls, 1, 'the approval-resume terminal called the sealed repair port');
  assert.equal(result.status, 'blocked');
  assert.equal(result.publicPresentation?.status, 'blocked');
  assert.equal(result.publicPresentation?.text, REPAIRED_REPLY);
  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.equal(
    terminal?.data.deliveryDisclosure,
    'state_machine_hold',
    'DISCLOSE reached the committer before incomplete durable authority forced its documented fallback',
  );
});

test('an exact approval-resume retry replays its terminal without rebuilding or rerunning tools', async () => {
  const first = await runResumedIncompleteAction('hold');
  let rebuilds = 0;
  const replay = await runConversationFromResume({
    buildAgent: async () => {
      rebuilds += 1;
      throw new Error('terminal replay must not rebuild an agent');
    },
    sessionId: first.sessionId,
    sourceUserSeq: first.sourceUserSeq,
    approvalId: first.approvalId,
    decision: 'approve',
  });

  assert.equal(rebuilds, 0);
  assert.equal(replay.status, first.result.status);
  assert.deepEqual(replay.publicPresentation, first.result.publicPresentation);
  assert.equal(
    eventlog.listEvents(first.sessionId, { types: ['conversation_completed'] }).length,
    1,
    'one accepted approval source has one public terminal across retries',
  );
});

test('loop carries a different-family DELIVER verdict through the shared commit', async () => {
  let judgeCalls = 0;
  const { result, repairCalls, sessionId } = await runIncompleteAction(
    'succeeded',
    terminalJudgePort({
      verb: 'deliver',
      reason: 'the successful read is useful when the missing write is disclosed',
      publicText: JUDGED_REPLY,
    }, (request) => {
      judgeCalls += 1;
      assert.match(
        request.prompt,
        /Live continuation: UNAVAILABLE/,
        'a maxSteps:1 run must not offer a recovery turn after its sole step is spent',
      );
    }),
  );

  assert.equal(judgeCalls, 1);
  assert.equal(repairCalls, 0, 'a decided terminal judge must own the words without a second repair model');
  assert.equal(result.status, 'blocked');
  assert.equal(result.publicPresentation?.status, 'blocked');
  assert.equal(result.publicPresentation?.text, JUDGED_REPLY);
  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.equal(terminal?.data.terminalJudgeDisposition, 'deliver');
  assert.equal(terminal?.data.terminalJudgeReason, 'the successful read is useful when the missing write is disclosed');
  assert.equal(terminal?.data.terminalJudgeFamily, 'claude');
  assert.equal(terminal?.data.deliveryDisclosure, 'state_machine_hold');
  assert.equal(
    eventlog.listEvents(sessionId, { types: ['heartbeat'] })
      .some((event) => event.data.kind === 'terminal_delivery_resume'),
    false,
  );
});

test('a final-step RESUME verdict cannot consume the loop terminal', async () => {
  let judgeCalls = 0;
  const { result, repairCalls, sessionId } = await runIncompleteAction(
    'succeeded',
    terminalJudgePort({
      verb: 'resume',
      reason: 'one more exact read could close the terminal gap',
      recoveryInstruction: 'Read the retained source by exact path and bind that result to this accepted request.',
      askIfRepeated: REPEATED_RESUME_ASK,
    }, (request) => {
      judgeCalls += 1;
      assert.match(request.prompt, /Live continuation: UNAVAILABLE/);
    }),
  );

  assert.equal(judgeCalls, 1);
  assert.equal(repairCalls, 1, 'an impossible RESUME keeps the conservative authored fallback path');
  assert.equal(result.status, 'blocked');
  assert.equal(result.publicPresentation?.status, 'blocked');
  assert.equal(result.publicPresentation?.text, REPAIRED_REPLY);
  const terminals = eventlog.listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1, 'the final step must still commit exactly one public terminal');
  assert.equal(terminals[0]?.data.terminalJudgeDisposition, undefined);
  assert.equal(
    eventlog.listEvents(sessionId, { types: ['heartbeat'] })
      .some((event) => event.data.kind === 'terminal_delivery_resume'),
    false,
    'an unavailable recovery edge must not reopen the spent loop',
  );
});

test('loop tells the judge a live agent can inspect external state, resumes, and publishes after the exact read settlement', async () => {
  const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'loop terminal resume pin' });
  let runnerCalls = 0;
  let judgeCalls = 0;
  let sourceUserSeq = 0;
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: session.id,
    input: ASK,
    maxSteps: 3,
    judgeCompletion: false,
    makeRunner: makeRunnerStub,
    runRunner: async (runner, _agent, items) => {
      runnerCalls += 1;
      (runner as unknown as EventEmitter).emit('agent_tool_start');
      stageUncontractedReadAttempt(
        session.id,
        runnerCalls === 1 ? 'failed' : 'succeeded',
        runnerCalls,
      );
      return completed(items);
    },
    terminalPresentationRepairPort: {
      async render() { throw new Error('a decided judge must not call terminal repair'); },
    },
    terminalDeliveryJudgePort: {
      async resolveRoute() {
        return {
          model: {} as BoundaryJudgeRouting['model'], modelId: 'claude-haiku-4-5',
          judgeFamily: 'claude', brainFamily: 'codex', transport: 'claude_subscription', selfJudge: false,
        };
      },
      async run(request) {
        judgeCalls += 1;
        const canRecover = [
          'Live continuation: AVAILABLE',
          'Tools during continuation: AVAILABLE',
          'Read-only external-state inspection: AVAILABLE',
        ].every((fact) => request.prompt.includes(fact));
        if (!canRecover) {
          return {
            verb: 'ask',
            reason: 'the judge was not told the running agent can inspect the provider',
            publicText: 'Please inspect the provider state for me.',
          };
        }
        return {
          verb: 'resume',
          reason: 'the live agent can close the evidence gap by inspection',
          recoveryInstruction: 'Use the available read tool to inspect the exact retained provider target and bind that observation to this accepted request.',
          askIfRepeated: REPEATED_RESUME_ASK,
        };
      },
    },
  });

  assert.equal(runnerCalls, 2, 'RESUME must reopen the live loop exactly once');
  assert.equal(judgeCalls, 1, 'the closed gap must not be judged again');
  assert.equal(
    result.status,
    'completed',
    JSON.stringify(eventlog.listEvents(session.id, { types: ['run_failed'] }).at(-1)?.data),
  );
  assert.equal(result.publicPresentation?.status, 'done');
  assert.equal(result.publicPresentation?.text, ORIGINAL_REPLY);
});

test('terminal RESUME stays inside the accepted turn and does not replay its conversational preflight', async () => {
  const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'loop terminal preflight identity pin' });
  const { _setOpennessJudgeForTests } = await import('./turn-openness.js');
  let runnerCalls = 0;
  let judgeCalls = 0;
  let authorCalls = 0;
  const painted: string[] = [];
  _setOpennessJudgeForTests(async () => null);
  try {
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: session.id,
      input: 'Create a new Google Sheet containing one fixture row.',
      maxSteps: 3,
      judgeCompletion: false,
      makeRunner: makeRunnerStub,
      runRunner: async (runner, _agent, items) => {
        runnerCalls += 1;
        (runner as unknown as EventEmitter).emit('agent_tool_start');
        stageUncontractedReadAttempt(
          session.id,
          runnerCalls === 1 ? 'failed' : 'succeeded',
          runnerCalls,
        );
        return completed(items);
      },
      preflightConversationPort: {
        async render(packet) {
          authorCalls += 1;
          assert.equal(packet.kind, 'proceed');
          return 'I have the Sheet request and I’m starting it now.';
        },
      },
      onConversationPreamble: async (text) => {
        painted.push(text);
        return { status: 'delivered' };
      },
      terminalPresentationRepairPort: {
        async render() { throw new Error('a decided judge must not call terminal repair'); },
      },
      terminalDeliveryJudgePort: {
        async resolveRoute() {
          return {
            model: {} as BoundaryJudgeRouting['model'], modelId: 'claude-haiku-4-5',
            judgeFamily: 'claude', brainFamily: 'codex', transport: 'claude_subscription', selfJudge: false,
          };
        },
        async run() {
          judgeCalls += 1;
          return {
            verb: 'resume',
            reason: 'one exact read can close the terminal evidence gap',
            recoveryInstruction: 'Query the task status. If the Sheet is missing, create the new Google Sheet now and email the link.',
            askIfRepeated: REPEATED_RESUME_ASK,
          };
        },
      },
    });

    const runFailures = eventlog.listEvents(session.id, { types: ['run_failed'] });
    assert.equal(
      runFailures.length,
      0,
      JSON.stringify(runFailures.at(-1)?.data),
    );
    assert.equal(runnerCalls, 2, 'the recovery directive must reach the execution model');
    assert.equal(judgeCalls, 1);
    assert.equal(result.status, 'completed');
    assert.equal(result.publicPresentation?.status, 'done');
    assert.equal(authorCalls, 1, 'only the real accepted user input authors a conversational opening');
    assert.deepEqual(painted, ['I have the Sheet request and I’m starting it now.']);
    assert.equal(eventlog.listEvents(session.id, { types: ['conversation_preamble'] }).length, 1);
    assert.equal(
      eventlog.listEvents(session.id, { types: ['turn_preflight_decision'] })
        .filter((event) => event.data.phase === 'align').length,
      1,
      'the internal RESUME directive must not mint a competing ALIGN identity',
    );
  } finally {
    _setOpennessJudgeForTests(null);
  }
});

test('a successful background-dispatch control receipt transfers the foreground without terminal re-judgment', async () => {
  const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'loop background control receipt pin' });
  const { _setOpennessJudgeForTests } = await import('./turn-openness.js');
  let runnerCalls = 0;
  let judgeCalls = 0;
  _setOpennessJudgeForTests(async () => null);
  try {
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: session.id,
      input: 'Create a new Google Sheet containing one fixture row and email me the link.',
      maxSteps: 3,
      judgeCompletion: true,
      makeRunner: makeRunnerStub,
      runRunner: async (runner, _agent, items) => {
        runnerCalls += 1;
        (runner as unknown as EventEmitter).emit('agent_tool_start');
        const source = eventlog.listEvents(session.id, { types: ['user_input_received'] }).at(-1)!;
        eventlog.appendEvent({
          sessionId: session.id,
          turn: source.turn,
          role: 'Clem',
          type: 'tool_called',
          data: {
            sourceUserSeq: source.seq,
            tool: 'dispatch_background_task',
            effectiveTool: 'dispatch_background_task',
            accounting: 'top_level',
            effect: 'read',
            callId: `dispatch-control-${source.seq}`,
          },
        });
        return {
          history: items,
          lastResponseId: undefined,
          finalOutput: terminalTools.formatControlReceiptFinalOutput(
            'I handed the Sheet and email work to the durable background runner, and I’ll report back here when it finishes.',
          ),
        } as never;
      },
      preflightConversationPort: {
        async render() { return 'I have the Sheet and email handoff in mind and I’m starting now.'; },
      },
      terminalDeliveryJudgePort: {
        async resolveRoute() {
          return {
            model: {} as BoundaryJudgeRouting['model'], modelId: 'claude-haiku-4-5',
            judgeFamily: 'claude', brainFamily: 'codex', transport: 'claude_subscription', selfJudge: false,
          };
        },
        async run() {
          judgeCalls += 1;
          return {
            verb: 'resume',
            reason: 'the child has not yet produced its writes',
            recoveryInstruction: 'Poll the child until it finishes.',
            askIfRepeated: 'The child is still running. Should I poll it again?',
          };
        },
      },
    });

    assert.equal(runnerCalls, 1, 'the successful dispatch already transferred execution ownership');
    assert.equal(judgeCalls, 0, 'a control receipt is not an incomplete foreground completion candidate');
    assert.equal(result.status, 'completed');
    assert.equal(result.publicPresentation?.status, 'transferred');
    assert.match(result.publicPresentation?.text ?? '', /durable background runner/i);
    assert.equal(
      eventlog.listEvents(session.id, { types: ['heartbeat'] })
        .some((event) => event.data.kind === 'terminal_delivery_resume'),
      false,
    );
  } finally {
    _setOpennessJudgeForTests(null);
  }
});

test('loop turns a second consecutive RESUME into the judge-authored ASK', async () => {
  const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'loop terminal two-strike pin' });
  let runnerCalls = 0;
  let judgeCalls = 0;
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: session.id,
    input: ASK,
    maxSteps: 3,
    judgeCompletion: false,
    makeRunner: makeRunnerStub,
    runRunner: async (runner, _agent, items) => {
      runnerCalls += 1;
      (runner as unknown as EventEmitter).emit('agent_tool_start');
      if (runnerCalls === 1) stageIncompleteAction(session.id, 'succeeded');
      return completed(items);
    },
    terminalPresentationRepairPort: {
      async render() { throw new Error('a decided judge must not call terminal repair'); },
    },
    terminalDeliveryJudgePort: {
      async resolveRoute() {
        return {
          model: {} as BoundaryJudgeRouting['model'], modelId: 'claude-haiku-4-5',
          judgeFamily: 'claude', brainFamily: 'codex', transport: 'claude_subscription', selfJudge: false,
        };
      },
      async run() {
        judgeCalls += 1;
        return {
          verb: 'resume',
          reason: 'the same local write remains the only gap',
          recoveryInstruction: RESUME_INSTRUCTION,
          askIfRepeated: REPEATED_RESUME_ASK,
        };
      },
    },
  });

  assert.equal(runnerCalls, 2);
  assert.equal(judgeCalls, 2);
  assert.equal(result.status, 'awaiting_user_input');
  assert.equal(result.publicPresentation?.status, 'needs_input');
  assert.equal(result.publicPresentation?.text, REPEATED_RESUME_ASK);
  const terminal = eventlog.listEvents(session.id, { types: ['conversation_completed'] }).at(-1);
  assert.equal(terminal?.data.terminalJudgeDisposition, 'ask');
  assert.equal(terminal?.data.terminalJudgeResumeCount, 0);
});
