/**
 * Claude Agent SDK lane wiring for the single delivery gate.
 *
 * Run: npx tsx --test src/runtime/harness/claude-agent-brain-one-gate-wiring.test.ts
 *
 * A repair verdict used to become `blocked` before the shared delivery gate
 * could see it. These tests drive the real Claude response boundary and prove
 * both answers from that gate remain connected: a source with no successful
 * work holds, while a source with successful work takes the disclose edge and
 * keeps the model-authored disclosure through the durable-state fallback.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-claude-one-gate-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-claude-one-gate\n', 'utf8');

const brain = await import('./claude-agent-brain.js');
const eventlog = await import('./eventlog.js');
const admission = await import('./expected-work-admission.js');
const contracts = await import('./expected-work-contract.js');
const audit = await import('./accepted-source-settlement-audit.js');
const delivery = await import('./delivery-committer.js');
const artifactLedger = await import('./artifact-ledger.js');
const { presentationEventFromCompletionData } = await import('./turn-outcome.js');

const {
  respondViaClaudeAgentSdkBrain,
  setClaudeAgentSdkBrainJudgeForTest,
  setClaudeAgentSdkBrainPostTurnHooksForTest,
  setClaudeAgentSdkBrainRunForTest,
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest,
  setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest,
  setClaudeAgentSdkBrainUnifiedPrimerForTest,
} = brain;
const UNAVAILABLE_TERMINAL_DELIVERY_JUDGE = {
  async resolveRoute() { return null; },
  async run() { throw new Error('unavailable fixture must not run'); },
} satisfies import('./terminal-delivery-judge.js').TerminalDeliveryJudgePort;

beforeEach(() => {
  eventlog.resetEventLog();
  artifactLedger._resetArtifactLedgerForTests();
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  delete process.env.CLEMMY_CLAUDE_SDK_JUDGE_MAX_CONTINUATIONS;
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE;
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(UNAVAILABLE_TERMINAL_DELIVERY_JUDGE);
  setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest(null);
  setClaudeAgentSdkBrainPostTurnHooksForTest(() => {});
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => ({
    objective: query,
    hits: [],
    perStore: {},
    answerability: 'insufficient',
    diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
  }));
});

after(() => {
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(null);
  setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest(null);
  setClaudeAgentSdkBrainPostTurnHooksForTest(null);
  setClaudeAgentSdkBrainUnifiedPrimerForTest(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

interface AcceptedTask {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
}

/** The Claude SDK observes native tool results at its own exact host boundary;
 * those calls never traverse the logical-settlement ledger. Mirror the
 * canonical event pair that boundary writes in production. */
function recordSuccessfulSdkBusinessResult(
  task: AcceptedTask,
  label: string,
): void {
  const called = eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: task.sourceUserSeq,
      tool: 'composio_execute_tool',
      callId: `toolu_${label}`,
      canonicalCallId: `toolu_${label}`,
      accounting: 'top_level',
      topologyRole: 'business',
      effect: 'read',
      toolSlug: 'APIFY_ACTOR_RUNS_GET',
    },
  });
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'tool',
    type: 'tool_returned',
    parentEventId: called.id,
    data: {
      sourceUserSeq: task.sourceUserSeq,
      tool: 'composio_execute_tool',
      callId: `toolu_${label}`,
      canonicalCallId: `toolu_${label}`,
      accounting: 'top_level',
      topologyRole: 'business',
      effect: 'read',
      toolSlug: 'APIFY_ACTOR_RUNS_GET',
      ok: true,
      successfulBusinessResult: true,
    },
  });
}

function freezeIncompleteWriteContract(task: AcceptedTask): void {
  const frozen = contracts.freezeActionExpectedWorkContract({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
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
  assert.ok(
    frozen.status === 'fixed' || frozen.status === 'replayed',
    `fixture precondition: ${JSON.stringify(frozen)}`,
  );
}

function recordUncertainWrite(
  task: AcceptedTask,
  label: string,
  irreversible: boolean,
): void {
  const data = {
    sourceUserSeq: task.sourceUserSeq,
    callId: `write_${label}`,
    canonicalCallId: `write_${label}`,
    preDispatch: true,
    irreversible,
    shapeKey: 'GOOGLESHEETS_VALUES_UPDATE',
    toolName: 'composio_execute_tool',
    targets: ['tracker!A1:E5'],
  };
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'system',
    type: 'external_write',
    data,
  });
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'system',
    type: 'external_write_orphaned',
    data,
  });
}

function terminalFor(sessionId: string) {
  const events = eventlog.listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(events.length, 1, 'the Claude lane must commit exactly one public terminal');
  const data = events[0]!.data;
  const terminal = presentationEventFromCompletionData(data);
  assert.ok(terminal, 'the committed event carries a typed terminal presentation');
  return { terminal, data };
}

const REQUEST = 'Update the tracker with all five rows.';
const PROPOSED_REPLY = 'Updated the tracker with all five rows.';
const MODEL_HOLD = 'I could not verify that any tracker update landed, so this needs a human check.';
const MODEL_DISCLOSURE = 'I updated the five rows, but one formatting attempt could not be verified.';

test('Claude repair still reaches the shared HOLD when no business work succeeded', async () => {
  const sessionId = 'claude-one-gate-hold';
  let task: AcceptedTask | undefined;
  let repairCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    assert.ok(options.sourceUserSeq);
    task = { sessionId, sourceUserSeq: options.sourceUserSeq!, turn: 1 };
    assert.equal(
      admission.actionExpectedWorkState(task).status,
      'required',
      'fixture must reach the action terminal-repair boundary',
    );
    freezeIncompleteWriteContract(task);
    return {
      text: PROPOSED_REPLY,
      sessionId: 'sdk-hold',
      model: 'claude-test',
      toolUses: [],
    };
  });
  setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest({
    async render() {
      repairCalls += 1;
      assert.ok(task);
      const settlementAudit = audit.auditAcceptedSourceSettlementTruth(task!);
      assert.equal(settlementAudit.facts.successfulBusinessSettlements, 0);
      return MODEL_HOLD;
    },
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: REQUEST,
    sessionId,
    channel: 'desktop',
  });

  assert.equal(repairCalls, 1, 'the real Claude terminal called the sealed repair port');
  assert.equal(response.stoppedReason, 'unverified', 'a hold is not a question awaiting user input');
  assert.match(response.text, /not marking|verify/i);
  const { terminal } = terminalFor(sessionId);
  assert.equal(terminal.status, 'blocked');
  assert.equal(terminal.text, response.text);
});

test('Claude repair DISCLOSES when the shared gate sees successful work beside an incomplete requirement', async () => {
  const sessionId = 'claude-one-gate-disclose';
  let task: AcceptedTask | undefined;
  let repairCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    assert.ok(options.sourceUserSeq);
    task = { sessionId, sourceUserSeq: options.sourceUserSeq!, turn: 1 };
    assert.equal(
      admission.actionExpectedWorkState(task).status,
      'required',
      'fixture must reach the action terminal-repair boundary',
    );
    freezeIncompleteWriteContract(task);
    // This successful Claude-native business read is deliberately not the
    // missing write. It earns disclosure without pretending the frozen
    // requirement is done, and matches the live SDK carrier.
    recordSuccessfulSdkBusinessResult(task, 'successful-read');
    return {
      text: PROPOSED_REPLY,
      sessionId: 'sdk-disclose',
      model: 'claude-test',
      toolUses: [],
    };
  });
  setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest({
    async render() {
      repairCalls += 1;
      assert.ok(task);
      const settlementAudit = audit.auditAcceptedSourceSettlementTruth(task!);
      assert.equal(settlementAudit.status, 'clean', JSON.stringify(settlementAudit));
      assert.equal(settlementAudit.facts.successfulBusinessSettlements, 0);
      assert.equal(settlementAudit.facts.successfulSdkBusinessResults, 1);
      assert.equal(delivery.deliveryMustHoldForHuman(settlementAudit), false);
      return MODEL_DISCLOSURE;
    },
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: REQUEST,
    sessionId,
    channel: 'desktop',
  });

  assert.equal(repairCalls, 1, 'the real Claude terminal called the sealed repair port');
  assert.equal(
    response.stoppedReason,
    'unverified',
    'the Claude response reflects the committed blocked fallback, not its upstream done proposal',
  );
  assert.equal(
    response.text,
    MODEL_DISCLOSURE,
    'the model-authored disclosure replaces the generic harness disclosure',
  );
  const { terminal, data } = terminalFor(sessionId);
  // The durable accepted-task state machine still refuses to CLOSE a source
  // whose frozen write requirement is incomplete. The committer's documented
  // fallback therefore holds the terminal, but it must retain the model's own
  // disclosure instead of replacing it with canned harness prose.
  assert.equal(terminal.status, 'blocked');
  assert.equal(terminal.text, MODEL_DISCLOSURE);
  assert.equal(
    data.reason,
    'claude_agent_sdk_brain',
    'the durable row retains the proposing Claude lane while the disclosure marker records the fallback',
  );
  assert.match(String(data.blockedReason), /no observed operation is bound/i);
  assert.equal(
    data.deliveryDisclosure,
    'state_machine_hold',
    'the shared gate chose disclosure before durable authority refused to close',
  );
});

test('uncertain reversible committed-result salvage reaches repair and the shared DISCLOSE edge', async () => {
  const sessionId = 'claude-preterminal-salvage-disclose';
  const disclosure = 'I retrieved the current tracker state, but one reversible update has an unresolved provider result.';
  let sdkRuns = 0;
  let repairCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    sdkRuns += 1;
    assert.ok(options.sourceUserSeq);
    const task = { sessionId, sourceUserSeq: options.sourceUserSeq!, turn: 1 };
    freezeIncompleteWriteContract(task);
    recordSuccessfulSdkBusinessResult(task, 'salvage-read');
    recordUncertainWrite(task, 'salvage-reversible', false);
    throw new Error('The model\'s tool call could not be parsed (retry also failed).');
  });
  setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest({
    async render(packet) {
      repairCalls += 1;
      assert.match(packet.proposedReply, /provider result was lost/i);
      return disclosure;
    },
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Update the tracker after checking its current rows.',
    sessionId,
  });

  assert.equal(sdkRuns, 1, 'an ambiguous committed write is never replayed');
  assert.equal(repairCalls, 1, 'salvage uncertainty is not converted to a fake user question');
  assert.equal(response.stoppedReason, 'unverified', 'the durable state-machine fallback owns the response status');
  assert.equal(response.text, disclosure);
  const { terminal, data } = terminalFor(sessionId);
  assert.equal(terminal.status, 'blocked');
  assert.equal(terminal.text, disclosure);
  assert.equal(data.deliveryDisclosure, 'state_machine_hold');
  assert.ok(
    (data.verificationMissing as unknown[] | undefined)?.includes('external_write_result_unresolved'),
    'the salvage-specific concern reaches the shared committer',
  );
});

test('unresolved artifact verification reaches repair and the shared DISCLOSE edge', async () => {
  const sessionId = 'claude-preterminal-artifact-disclose';
  const documentId = 'doc_claude_gate_unverified_123';
  const disclosure = 'I created the brief, but I could not independently read back its exact document ID.';
  let sdkRuns = 0;
  let repairCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    sdkRuns += 1;
    assert.ok(options.sourceUserSeq);
    const task = { sessionId, sourceUserSeq: options.sourceUserSeq!, turn: 1 };
    const scope = artifactLedger.resolveArtifactRunScopeId(
      sessionId,
      options.artifactRunScopeId ?? options.trackerScopeId as string,
      options.sourceUserSeq,
    );
    if (sdkRuns === 1) {
      freezeIncompleteWriteContract(task);
      recordSuccessfulSdkBusinessResult(task, 'artifact-create');
      const intent = artifactLedger.artifactIntentForTool('composio_execute_tool', {
        tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT',
        arguments: JSON.stringify({ title: 'Gate parity brief' }),
      });
      assert.ok(intent);
      artifactLedger.claimArtifactSlot(sessionId, intent!, 'toolu_create_gate_brief', scope);
      artifactLedger.bindArtifactSlot(sessionId, intent!.slotKey, {
        resourceId: documentId,
        uri: `https://docs.google.com/document/d/${documentId}/edit`,
      }, 'toolu_create_gate_brief', scope);
      return {
        text: `Created the brief: https://docs.google.com/document/d/${documentId}/edit`,
        sessionId: 'sdk-artifact-create',
        model: 'claude-test',
        toolUses: ['mcp__clementine-local__composio_execute_tool'],
        artifactRunScopeId: scope,
      };
    }
    artifactLedger.verifyArtifactBindingFromToolResult(
      sessionId,
      scope,
      'composio_execute_tool',
      {
        tool_slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
        arguments: JSON.stringify({ document_id: documentId }),
      },
      { data: { document_id: 'different_document_id' } },
      'toolu_wrong_gate_readback',
      true,
    );
    return {
      text: 'The provider getter returned a different document.',
      sessionId: 'sdk-artifact-verify',
      model: 'claude-test',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
      artifactRunScopeId: scope,
    };
  });
  setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest({
    async render() {
      repairCalls += 1;
      return disclosure;
    },
  });

  const response = await respondViaClaudeAgentSdkBrain('background', {
    message: 'Create the brief in Google Docs.',
    sessionId,
  });

  assert.equal(sdkRuns, 2, 'the exact-ID verification query remains bounded to one attempt');
  assert.equal(repairCalls, 1, 'unresolved artifact state reaches terminal repair');
  assert.equal(response.stoppedReason, 'unverified');
  assert.equal(response.text, disclosure);
  assert.equal(artifactLedger.listUnverifiedRunArtifacts(sessionId).length, 1);
  const { data } = terminalFor(sessionId);
  assert.equal(data.deliveryDisclosure, 'state_machine_hold');
  assert.equal((data.artifactVerification as { status?: string } | undefined)?.status, 'pending');
  assert.ok(
    (data.verificationMissing as unknown[] | undefined)?.some((item) =>
      String(item).startsWith('artifact_readback:google_doc:')),
    'judge unavailability preserves the Claude-only artifact concern through commit',
  );
});

test('the fresh-write floor reaches repair and the shared DISCLOSE edge after other successful business work', async () => {
  const sessionId = 'claude-preterminal-fresh-write-disclose';
  const disclosure = 'I read the current tracker successfully, but I could not verify that the requested update landed.';
  let repairCalls = 0;
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'on';
  process.env.CLEMMY_CLAUDE_SDK_JUDGE_MAX_CONTINUATIONS = '0';
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'fixture' }));
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    assert.ok(options.sourceUserSeq);
    const task = { sessionId, sourceUserSeq: options.sourceUserSeq!, turn: 1 };
    freezeIncompleteWriteContract(task);
    recordSuccessfulSdkBusinessResult(task, 'fresh-write-read');
    return {
      text: 'Updated Google Sheets with the latest values.',
      sessionId: 'sdk-fresh-write',
      model: 'claude-test',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
      successfulToolUses: ['APIFY_ACTOR_RUNS_GET'],
    };
  });
  setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest({
    async render() {
      repairCalls += 1;
      return disclosure;
    },
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Update Google Sheets now with the latest values.',
    sessionId,
  });

  assert.equal(repairCalls, 1, 'a missing fresh-write receipt no longer becomes an early input pause');
  assert.equal(response.stoppedReason, 'unverified');
  assert.equal(response.text, disclosure);
  const { data } = terminalFor(sessionId);
  assert.equal(data.deliveryDisclosure, 'state_machine_hold');
  assert.match(String(data.verificationDetail), /external-write receipt/i);
  assert.ok(
    (data.verificationMissing as unknown[] | undefined)?.some((item) =>
      String(item).startsWith('fresh_external_write:')),
    'judge unavailability preserves the Claude-only fresh-write concern through commit',
  );
});

test('mixed real-tool and narrated-tool work reaches repair and the shared DISCLOSE edge', async () => {
  const sessionId = 'claude-preterminal-mixed-tool-disclose';
  const disclosure = 'I completed the tracker read, but the final recorded-state closeout did not execute.';
  const narrated = [
    'I will close the execution record now.',
    '<invoke name="execution_complete">',
    '<parameter name="id">exec_gate_pin</parameter>',
    '</invoke>',
  ].join('\n');
  let repairCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    assert.ok(options.sourceUserSeq);
    const task = { sessionId, sourceUserSeq: options.sourceUserSeq!, turn: 1 };
    freezeIncompleteWriteContract(task);
    recordSuccessfulSdkBusinessResult(task, 'mixed-real-read');
    return {
      text: narrated,
      sessionId: 'sdk-mixed-tool',
      model: 'claude-test',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
      successfulToolUses: ['APIFY_ACTOR_RUNS_GET'],
    };
  });
  setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest({
    async render(packet) {
      repairCalls += 1;
      assert.doesNotMatch(
        packet.proposedReply,
        /<invoke|<parameter/i,
        'judge unavailability never sends raw tool protocol through the public repair port',
      );
      assert.match(packet.proposedReply, /did not produce a usable final reply/i);
      return disclosure;
    },
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Read the tracker and close the execution record.',
    sessionId,
  });

  assert.equal(repairCalls, 1, 'mixed narration reaches repair instead of manufacturing a question');
  assert.equal(response.stoppedReason, 'unverified');
  assert.equal(response.text, disclosure);
  assert.doesNotMatch(response.text, /invoke|parameter/i);
  const { data } = terminalFor(sessionId);
  assert.equal(data.deliveryDisclosure, 'state_machine_hold');
});

test('genuine questions and approval pauses remain needs-input terminals', async () => {
  let repairCalls = 0;
  let terminalJudgeResolveCalls = 0;
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest({
    async resolveRoute() {
      terminalJudgeResolveCalls += 1;
      return null;
    },
    async run() { throw new Error('a native interaction stop must not be judged'); },
  });
  setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest({
    async render() {
      repairCalls += 1;
      return 'This repair must not run for a genuine pause.';
    },
  });

  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Which Google Sheet should I update?',
    sessionId: 'sdk-genuine-question',
    model: 'claude-test',
    toolUses: [],
    stoppedReason: 'awaiting-input',
  }));
  const question = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Update my Google Sheet.',
    sessionId: 'claude-preserve-genuine-question',
  });
  assert.equal(question.stoppedReason, 'awaiting-input');
  assert.equal(question.text, 'Which Google Sheet should I update?');
  assert.equal(terminalFor('claude-preserve-genuine-question').terminal.status, 'needs_input');

  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Please approve the irreversible send before I continue.',
    sessionId: 'sdk-genuine-approval',
    model: 'claude-test',
    toolUses: [],
    stoppedReason: 'pending-approval',
  }));
  const approval = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Send the approved announcement.',
    sessionId: 'claude-preserve-genuine-approval',
  });
  assert.equal(approval.stoppedReason, 'pending-approval');
  assert.equal(approval.text, 'Please approve the irreversible send before I continue.');
  assert.equal(terminalFor('claude-preserve-genuine-approval').terminal.status, 'needs_input');
  assert.equal(repairCalls, 0, 'real interaction stops never enter completion repair');
  assert.equal(terminalJudgeResolveCalls, 0, 'real interaction stops never enter terminal delivery judging');
});

test('an irreversible uncertain committed result still takes the shared HOLD edge', async () => {
  const sessionId = 'claude-preterminal-irreversible-hold';
  const hold = 'The send may have crossed the provider boundary, so it requires a human check before any retry.';
  let task: AcceptedTask | undefined;
  let repairCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    assert.ok(options.sourceUserSeq);
    task = { sessionId, sourceUserSeq: options.sourceUserSeq!, turn: 1 };
    freezeIncompleteWriteContract(task);
    recordSuccessfulSdkBusinessResult(task, 'irreversible-read');
    recordUncertainWrite(task, 'irreversible-send', true);
    throw new Error('The model\'s tool call could not be parsed (retry also failed).');
  });
  setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest({
    async render() {
      repairCalls += 1;
      assert.ok(task);
      const settlementAudit = audit.auditAcceptedSourceSettlementTruth(task!);
      assert.equal(settlementAudit.status, 'uncertain_write');
      assert.equal(delivery.deliveryMustHoldForHuman(settlementAudit), true);
      return hold;
    },
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Send the announcement after checking the tracker.',
    sessionId,
  });

  assert.equal(repairCalls, 1);
  assert.equal(response.stoppedReason, 'unverified');
  assert.equal(response.text, hold);
  const { terminal, data } = terminalFor(sessionId);
  assert.equal(terminal.status, 'blocked');
  assert.equal(data.deliveryDisclosure, undefined, 'a direct human hold is not mislabeled as disclosure');
  assert.equal(data.blockedReason, 'authoritative_terminal_verification_incomplete');
});

test('a mixed narrated-tool turn with zero successful business results still HOLDs', async () => {
  const sessionId = 'claude-preterminal-zero-success-hold';
  const hold = 'No business result succeeded, so there is nothing complete to qualify with a disclosure.';
  let task: AcceptedTask | undefined;
  let repairCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    assert.ok(options.sourceUserSeq);
    task = { sessionId, sourceUserSeq: options.sourceUserSeq!, turn: 1 };
    freezeIncompleteWriteContract(task);
    // A tool-use summary alone is not a successful Claude business result.
    // The exact host-bound tool_returned carrier is deliberately absent.
    return {
      text: '<invoke name="execution_complete"><parameter name="id">never-ran</parameter></invoke>',
      sessionId: 'sdk-zero-success-mixed',
      model: 'claude-test',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
    };
  });
  setClaudeAgentSdkBrainTerminalPresentationRepairPortForTest({
    async render() {
      repairCalls += 1;
      assert.ok(task);
      const settlementAudit = audit.auditAcceptedSourceSettlementTruth(task!);
      assert.equal(settlementAudit.facts.successfulBusinessSettlements, 0);
      assert.equal(settlementAudit.facts.successfulSdkBusinessResults, 0);
      return hold;
    },
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Update the tracker and close the execution record.',
    sessionId,
  });

  assert.equal(repairCalls, 1);
  assert.equal(response.stoppedReason, 'unverified');
  assert.match(response.text, /No business result succeeded|later tool call was printed instead of executed|not marking/i);
  assert.doesNotMatch(response.text, /<invoke|<parameter/i);
  const { terminal, data } = terminalFor(sessionId);
  assert.equal(terminal.status, 'blocked');
  assert.equal(data.deliveryDisclosure, undefined);
  assert.match(String(data.blockedReason), /no observed operation is bound/i);
});
