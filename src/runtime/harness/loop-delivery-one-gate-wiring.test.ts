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
import type { Agent, Runner } from '@openai/agents';
import type { BoundaryJudgeRouting } from './debate-model.js';
import type { TerminalDeliveryJudgePort } from './terminal-delivery-judge.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-loop-delivery-one-gate-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_VERIFY_DELIVERED = 'off';
process.env.HARNESS_TOOL_BRACKETS = 'off';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-loop-delivery-one-gate\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runConversation } = await import('./loop.js');
const identities = await import('./attempt-identity.js');
const admission = await import('./expected-work-admission.js');
const dispatch = await import('./dispatch-ledger.js');
const settlement = await import('./attempt-settlement.js');
const audit = await import('./accepted-source-settlement-audit.js');
const resultHandles = await import('./result-handle.js');

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
function stageIncompleteAction(sessionId: string, readOutcome: 'failed' | 'succeeded') {
  const source = eventlog.listEvents(sessionId, { types: ['user_input_received'] }).at(-1);
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

function terminalJudgePort(output: unknown): TerminalDeliveryJudgePort {
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
    async run() {
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
    'awaiting_user_input',
    'the loop-specific hold branch must run, not merely rely on the downstream committer',
  );
  assert.equal(result.publicPresentation?.status, 'blocked');
  assert.equal(result.publicPresentation?.text, REPAIRED_REPLY);
});

test('loop calls terminal repair and takes the disclosure edge after real work succeeded', async () => {
  const { result, repairCalls, sessionId, sourceUserSeq } = await runIncompleteAction('succeeded');
  const settlementAudit = audit.auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq });
  assert.equal(settlementAudit.status, 'clean', JSON.stringify(settlementAudit));
  assert.equal(settlementAudit.facts.successfulBusinessSettlements, 1, JSON.stringify(settlementAudit));

  assert.equal(repairCalls, 1, 'the loop must call the sealed terminal-repair port');
  assert.equal(result.status, 'awaiting_user_input');
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

test('loop carries a different-family DELIVER verdict through the shared commit', async () => {
  const { result, repairCalls, sessionId } = await runIncompleteAction(
    'succeeded',
    terminalJudgePort({
      verb: 'deliver',
      reason: 'the successful read is useful when the missing write is disclosed',
      publicText: JUDGED_REPLY,
    }),
  );

  assert.equal(repairCalls, 0, 'a decided terminal judge must own the words without a second repair model');
  assert.equal(result.status, 'awaiting_user_input');
  assert.equal(result.publicPresentation?.status, 'blocked');
  assert.equal(result.publicPresentation?.text, JUDGED_REPLY);
  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.equal(terminal?.data.terminalJudgeDisposition, 'deliver');
  assert.equal(terminal?.data.terminalJudgeReason, 'the successful read is useful when the missing write is disclosed');
  assert.equal(terminal?.data.terminalJudgeFamily, 'claude');
  assert.equal(terminal?.data.deliveryDisclosure, 'state_machine_hold');
});

test('loop honors one RESUME and publishes the brain answer after that continuation closes the gap', async () => {
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
      async run() {
        judgeCalls += 1;
        return {
          verb: 'resume',
          reason: 'one local write can close the remaining contract',
          recoveryInstruction: RESUME_INSTRUCTION,
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
