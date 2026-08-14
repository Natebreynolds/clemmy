/**
 * The standard loop and Claude Agent SDK brain must reduce the same terminal
 * authority to the same public delivery.
 *
 * Run: npx tsx --test src/runtime/harness/terminal-delivery-lane-parity.test.ts
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import type { Agent, Runner } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-terminal-lane-parity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'claude_oauth';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
process.env.CLEMMY_CLAUDE_SDK_REFLECTION = 'off';
process.env.CLEMMY_CLAUDE_SDK_SESSION_HISTORY = 'off';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_INTERACTIVE_TOOL_ECONOMY = 'off';
process.env.CLEMMY_VERIFY_DELIVERED = 'off';
process.env.HARNESS_TOOL_BRACKETS = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-terminal-lane-parity\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runConversation } = await import('./loop.js');
const brain = await import('./claude-agent-brain.js');
const contracts = await import('./expected-work-contract.js');
const admission = await import('./expected-work-admission.js');
const audit = await import('./accepted-source-settlement-audit.js');
const { presentationEventFromCompletionData } = await import('./turn-outcome.js');

const REQUEST = 'Update the tracker with all five rows.';
const MODEL_REPLY = 'Updated the tracker with all five rows.';
const AUTHORED_DISCLOSURE = 'I updated all five rows, but I could not independently bind the provider result to the final verification record.';

function writeClaudeToken(): void {
  writeFileSync(path.join(TMP_HOME, 'state', 'claude-auth.json'), JSON.stringify({
    accessToken: 'sk-ant-oat01-terminal-lane-parity',
    refreshToken: 'refresh-terminal-lane-parity',
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes: ['user:inference'],
  }), 'utf8');
}

function fakeAgent(): Agent<any, any> {
  return {} as Agent<any, any>;
}

function makeRunner(): Runner {
  return new EventEmitter() as unknown as Runner;
}

function completedRun(items: unknown[]) {
  return {
    history: items,
    lastResponseId: undefined,
    finalOutput: {
      summary: MODEL_REPLY,
      reply: MODEL_REPLY,
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  } as never;
}

/**
 * The provider write succeeded at the Claude SDK's exact host return boundary,
 * but it never traversed the expected-work binding ledger. That is the live
 * unverified-but-complete shape: real work exists, terminal preparation cannot
 * bind it, and the shared gate should take the disclosure edge in either lane.
 */
function stageSdkCompletedUnverifiedWrite(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  label: string;
}): void {
  assert.equal(admission.actionExpectedWorkState(input).status, 'required');
  const frozen = contracts.freezeActionExpectedWorkContract({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    proposal: {
      version: 1,
      operations: [{
        id: 'update-tracker',
        effect: 'external_write',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
  });
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
  const callId = `toolu_lane_parity_${input.label}`;
  const called = eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: input.sourceUserSeq,
      tool: 'composio_execute_tool',
      callId,
      canonicalCallId: callId,
      accounting: 'top_level',
      topologyRole: 'business',
      effect: 'external_write',
      toolSlug: 'GOOGLESHEETS_UPDATE_ROW',
    },
  });
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    role: 'tool',
    type: 'tool_returned',
    parentEventId: called.id,
    data: {
      sourceUserSeq: input.sourceUserSeq,
      tool: 'composio_execute_tool',
      callId,
      canonicalCallId: callId,
      accounting: 'top_level',
      topologyRole: 'business',
      effect: 'external_write',
      toolSlug: 'GOOGLESHEETS_UPDATE_ROW',
      ok: true,
      successfulBusinessResult: true,
    },
  });
  const settlementAudit = audit.auditAcceptedSourceSettlementTruth(input);
  assert.equal(settlementAudit.status, 'clean', JSON.stringify(settlementAudit));
  assert.equal(settlementAudit.facts.successfulBusinessSettlements, 0);
  assert.equal(settlementAudit.facts.successfulSdkBusinessResults, 1);
}

function committedPresentation(sessionId: string) {
  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.ok(terminal);
  const presentation = presentationEventFromCompletionData(terminal.data);
  assert.ok(presentation);
  return presentation;
}

beforeEach(() => {
  writeClaudeToken();
  eventlog.resetEventLog();
  brain.setClaudeAgentSdkBrainRunForTest(null);
  brain.setClaudeAgentSdkBrainJudgeForTest(null);
  brain.setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest(null);
  brain.setClaudeAgentSdkBrainPostTurnHooksForTest(() => {});
  brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => ({
    objective: query,
    hits: [],
    perStore: {},
    answerability: 'insufficient',
    diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
  }));
});

after(() => {
  brain.setClaudeAgentSdkBrainRunForTest(null);
  brain.setClaudeAgentSdkBrainJudgeForTest(null);
  brain.setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest(null);
  brain.setClaudeAgentSdkBrainPostTurnHooksForTest(null);
  brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('the same unverified-but-complete shape delivers identically through both brain lanes', async () => {
  const standard = HarnessSession.create({
    id: 'terminal-lane-parity-standard', kind: 'chat', channel: 'desktop', title: 'standard parity',
  });
  let standardSourceUserSeq = 0;
  let standardRepairCalls = 0;
  const standardResult = await runConversation({
    agent: fakeAgent(),
    sessionId: standard.id,
    input: REQUEST,
    maxSteps: 1,
    judgeCompletion: false,
    makeRunner,
    runRunner: async (runner, _agent, items) => {
      (runner as unknown as EventEmitter).emit('agent_tool_start');
      const source = eventlog.listEvents(standard.id, { types: ['user_input_received'] }).at(-1)!;
      standardSourceUserSeq = source.seq;
      stageSdkCompletedUnverifiedWrite({
        sessionId: standard.id, sourceUserSeq: source.seq, turn: source.turn, label: 'standard',
      });
      return completedRun(items);
    },
    terminalPresentationRepairPort: {
      async render() {
        standardRepairCalls += 1;
        return AUTHORED_DISCLOSURE;
      },
    },
  });

  const claudeSessionId = 'terminal-lane-parity-claude';
  eventlog.createSession({ id: claudeSessionId, kind: 'chat', channel: 'desktop' });
  let claudeRepairCalls = 0;
  brain.setClaudeAgentSdkBrainRunForTest(async (options) => {
    assert.ok(options.sourceUserSeq);
    stageSdkCompletedUnverifiedWrite({
      sessionId: claudeSessionId, sourceUserSeq: options.sourceUserSeq!, turn: 1, label: 'claude',
    });
    return {
      text: MODEL_REPLY,
      sessionId: 'sdk-terminal-lane-parity',
      model: 'claude-sonnet-test',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
      successfulToolUses: ['GOOGLESHEETS_UPDATE_ROW'],
      stoppedReason: 'success',
    };
  });
  brain.setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest({
    async render() {
      claudeRepairCalls += 1;
      return AUTHORED_DISCLOSURE;
    },
  });
  const claudeResult = await brain.respondViaClaudeAgentSdkBrain('home', {
    message: REQUEST,
    sessionId: claudeSessionId,
    channel: 'desktop',
  });

  assert.equal(standardRepairCalls, 1, JSON.stringify({
    result: standardResult,
    events: eventlog.listEvents(standard.id).map((event) => ({ type: event.type, data: event.data })),
  }));
  assert.equal(claudeRepairCalls, 1);
  assert.equal(standardResult.status, 'awaiting_user_input', 'standard result follows the durable fallback hold');
  assert.equal(claudeResult.stoppedReason, 'unverified', 'Claude result follows the durable fallback hold');

  const standardPresentation = committedPresentation(standard.id);
  const claudePresentation = committedPresentation(claudeSessionId);
  // The durable accepted-task state machine still refuses to close an
  // incomplete contract, so both disclosure attempts correctly fall back to
  // the hold. The parity contract is identical status and identical authored
  // text—not a lane-specific canned replacement.
  assert.equal(standardPresentation.status, 'blocked');
  assert.equal(claudePresentation.status, 'blocked');
  assert.equal(standardPresentation.text, AUTHORED_DISCLOSURE);
  assert.equal(claudePresentation.text, AUTHORED_DISCLOSURE);
  assert.equal(standardPresentation.text, claudePresentation.text);
  const standardTerminal = eventlog.listEvents(standard.id, { types: ['conversation_completed'] }).at(-1)!;
  const claudeTerminal = eventlog.listEvents(claudeSessionId, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(standardTerminal.data.deliveryDisclosure, 'state_machine_hold');
  assert.equal(claudeTerminal.data.deliveryDisclosure, 'state_machine_hold');
  assert.ok(standardSourceUserSeq > 0);
});
