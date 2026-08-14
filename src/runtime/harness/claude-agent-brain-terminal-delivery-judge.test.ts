/**
 * Claude SDK live-lane wiring for the independent terminal delivery judge.
 *
 * Run: npx tsx --test --test-force-exit \
 *   src/runtime/harness/claude-agent-brain-terminal-delivery-judge.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import type { BoundaryJudgeRouting } from './debate-model.js';
import type { ClaudeAgentSdkRunResult } from './claude-agent-sdk.js';
import type {
  TerminalDeliveryJudgePort,
  TerminalDeliveryJudgeRequest,
} from './terminal-delivery-judge.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-claude-terminal-judge-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-claude-terminal-judge\n', 'utf8');

const brain = await import('./claude-agent-brain.js');
const eventlog = await import('./eventlog.js');
const admission = await import('./expected-work-admission.js');
const contracts = await import('./expected-work-contract.js');
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

const INITIAL_MIXED = [
  'I found the setup for the joke and will close the record now.',
  '<invoke name="execution_complete">',
  '<parameter name="id">exec_terminal_judge</parameter>',
  '</invoke>',
].join('\n');
const RECOVERED_TEXT = 'Why did the spreadsheet cross the road? To get to the other cell.';

function differentFamilyRoute(overrides: Partial<BoundaryJudgeRouting> = {}): BoundaryJudgeRouting {
  return {
    model: {} as BoundaryJudgeRouting['model'],
    modelId: 'gpt-5.4-mini-terminal-judge-test',
    judgeFamily: 'codex',
    brainFamily: 'claude',
    transport: 'codex_responses',
    selfJudge: false,
    ...overrides,
  };
}

function judgeFixture(
  outputs: readonly unknown[],
  route: BoundaryJudgeRouting | null = differentFamilyRoute(),
): {
  port: TerminalDeliveryJudgePort;
  resolveCalls(): number;
  runCalls(): number;
  requests(): readonly TerminalDeliveryJudgeRequest[];
} {
  let resolves = 0;
  let runs = 0;
  const requests: TerminalDeliveryJudgeRequest[] = [];
  return {
    port: {
      async resolveRoute() {
        resolves += 1;
        return route;
      },
      async run(request) {
        requests.push(request);
        const output = outputs[Math.min(runs, Math.max(0, outputs.length - 1))];
        runs += 1;
        return output;
      },
    },
    resolveCalls: () => resolves,
    runCalls: () => runs,
    requests: () => requests,
  };
}

function mixedSdkResult(sessionId: string, text = INITIAL_MIXED) {
  return {
    text,
    sessionId: `sdk-${sessionId}`,
    model: 'claude-test',
    toolUses: ['mcp__clementine-local__memory_recall_all'],
    successfulToolUses: ['memory_recall_all'],
    stoppedReason: 'success' as const,
  };
}

function concernOnlySdkResult(sessionId: string): ClaudeAgentSdkRunResult & {
  preterminalDeliveryConcern: {
    reason: string;
    missing: string[];
  };
} {
  return {
    text: 'I could not verify the terminal account from this run.',
    sessionId: `sdk-${sessionId}`,
    model: 'claude-test',
    toolUses: [],
    stoppedReason: 'success',
    preterminalDeliveryConcern: {
      reason: 'the terminal account is incomplete',
      missing: ['terminal_account_incomplete'],
    },
  };
}

function recordSuccessfulSdkBusinessResult(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
}): void {
  const callId = `toolu_terminal_judge_${input.sourceUserSeq}`;
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
      effect: 'read',
      toolSlug: 'GOOGLESHEETS_BATCH_GET',
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
      effect: 'read',
      toolSlug: 'GOOGLESHEETS_BATCH_GET',
      ok: true,
      successfulBusinessResult: true,
    },
  });
}

function recordConfirmedWrite(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
}): void {
  const data = {
    sourceUserSeq: input.sourceUserSeq,
    callId: `write_terminal_judge_${input.sourceUserSeq}`,
    canonicalCallId: `write_terminal_judge_${input.sourceUserSeq}`,
    shapeKey: 'OUTLOOK_SEND_EMAIL',
    toolName: 'composio_execute_tool',
    targets: ['recipient@example.test'],
  };
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    role: 'tool',
    type: 'external_write',
    data,
  });
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    role: 'tool',
    type: 'external_write_succeeded',
    data,
  });
}

function terminalFor(sessionId: string) {
  const events = eventlog.listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(events.length, 1, 'exactly one public terminal is committed');
  const event = events[0]!;
  const presentation = presentationEventFromCompletionData(event.data);
  assert.ok(presentation);
  return { event, presentation };
}

beforeEach(() => {
  eventlog.resetEventLog();
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  process.env.CLEMMY_CLAUDE_SDK_SESSION_HISTORY = 'off';
  process.env.CLEMMY_UNIFIED_RECALL = 'off';
  process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
  process.env.CLEMMY_INTERACTIVE_TOOL_ECONOMY = 'off';
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(null);
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

test('RESUME reopens the existing SDK continuation once and publishes when that closes the gap', async () => {
  const sessionId = 'claude-terminal-judge-resume-closes';
  const recoveryInstruction = 'Replace the printed closeout with a normal final answer in your own voice now.';
  const judge = judgeFixture([{
    verb: 'resume',
    reason: 'one local presentation repair can close the gap',
    recoveryInstruction,
    askIfRepeated: 'The final answer still did not render. Would you like me to leave the recorded work as-is?',
  }]);
  let sdkCalls = 0;
  const sdkPrompts: string[] = [];
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(judge.port);
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    sdkCalls += 1;
    sdkPrompts.push(options.prompt);
    return sdkCalls === 1
      ? mixedSdkResult(sessionId)
      : { text: RECOVERED_TEXT, sessionId: 'sdk-resumed', model: 'claude-test', toolUses: [] };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Tell me one short spreadsheet joke.',
    sessionId,
  });

  assert.equal(sdkCalls, 2, 'one initial SDK run plus exactly one judge-authorized continuation');
  assert.equal(judge.resolveCalls(), 1);
  assert.equal(judge.runCalls(), 1);
  assert.match(sdkPrompts[1] ?? '', new RegExp(recoveryInstruction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(response.stoppedReason, 'success');
  assert.equal(response.text, RECOVERED_TEXT);
  const { event, presentation } = terminalFor(sessionId);
  assert.equal(presentation.status, 'done');
  assert.equal(presentation.text, RECOVERED_TEXT);
  assert.equal(event.data.terminalJudgeDisposition, 'resume');
  assert.equal(event.data.terminalJudgeFamily, 'codex');
  assert.equal(event.data.terminalJudgeResumeCount, 1);
});

test('a second consecutive RESUME becomes the judge-authored ASK without a second continuation', async () => {
  const sessionId = 'claude-terminal-judge-second-resume-asks';
  const askIfRepeated = 'The closeout still did not execute. Should I leave the recorded work as-is?';
  const resume = {
    verb: 'resume',
    reason: 'the closeout can be retried without repeating business work',
    recoveryInstruction: 'Render a plain final answer without printing any tool protocol or repeating business work.',
    askIfRepeated,
  };
  const judge = judgeFixture([resume, resume]);
  let sdkCalls = 0;
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(judge.port);
  setClaudeAgentSdkBrainRunForTest(async () => {
    sdkCalls += 1;
    return mixedSdkResult(sessionId, sdkCalls === 1 ? INITIAL_MIXED : `${INITIAL_MIXED}\nStill unresolved.`);
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Tell me one short spreadsheet joke.',
    sessionId,
  });

  assert.equal(sdkCalls, 2, 'the second RESUME verdict is not allowed to reopen the SDK again');
  assert.equal(judge.runCalls(), 2);
  assert.equal(response.stoppedReason, 'awaiting-input');
  assert.equal(response.text, askIfRepeated);
  const { event, presentation } = terminalFor(sessionId);
  assert.equal(presentation.status, 'needs_input');
  assert.equal(presentation.text, askIfRepeated);
  assert.equal(event.data.terminalJudgeDisposition, 'ask');
  assert.equal(event.data.terminalJudgeResumeCount, 0);
  const awaiting = eventlog.listEvents(sessionId, { types: ['awaiting_user_input'] }).at(-1);
  assert.equal(awaiting?.data.source, 'terminal_delivery_judge');
  assert.equal(awaiting?.data.question, askIfRepeated);
});

test('ASK publishes exactly the judge-authored question and does not resume the SDK', async () => {
  const sessionId = 'claude-terminal-judge-asks';
  const publicText = 'Which account should I use before I inspect the remaining record?';
  const judge = judgeFixture([{
    verb: 'ask',
    reason: 'the account choice belongs to the user',
    publicText,
  }]);
  let sdkCalls = 0;
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(judge.port);
  setClaudeAgentSdkBrainRunForTest(async () => {
    sdkCalls += 1;
    return mixedSdkResult(sessionId);
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Tell me one short spreadsheet joke.',
    sessionId,
  });

  assert.equal(sdkCalls, 1);
  assert.equal(judge.runCalls(), 1);
  assert.equal(response.stoppedReason, 'awaiting-input');
  assert.equal(response.text, publicText);
  const { event, presentation } = terminalFor(sessionId);
  assert.equal(presentation.status, 'needs_input');
  assert.equal(presentation.text, publicText);
  assert.equal(event.data.terminalJudgeDisposition, 'ask');
  assert.equal(event.data.terminalJudgeReason, 'the account choice belongs to the user');
});

test('DELIVER publishes exact judge prose with durable disposition metadata', async () => {
  const sessionId = 'claude-terminal-judge-delivers';
  const publicText = 'I found the requested setup, but the recorded closeout did not execute; no external action was repeated.';
  const judge = judgeFixture([{
    verb: 'deliver',
    reason: 'the useful result can be shown with its precise caveat',
    publicText,
  }]);
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(judge.port);
  setClaudeAgentSdkBrainRunForTest(async () => concernOnlySdkResult(sessionId));

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Tell me one short spreadsheet joke.',
    sessionId,
  });

  assert.equal(response.stoppedReason, 'success');
  assert.equal(response.text, publicText);
  const { event, presentation } = terminalFor(sessionId);
  assert.equal(presentation.status, 'done');
  assert.equal(presentation.text, publicText, 'the committer does not append or replace judge-authored disclosure');
  assert.equal(event.data.terminalJudgeDisposition, 'deliver');
  assert.equal(event.data.terminalJudgeReason, 'the useful result can be shown with its precise caveat');
  assert.equal(event.data.terminalJudgeFamily, 'codex');
  assert.equal(event.data.terminalJudgeResumeCount, 0);
  assert.equal(event.data.deliveryDisclosure, 'unverified_completion');
});

test('confirmed-write salvage reaches the judge and publishes only judge-authored terminal prose', async () => {
  const sessionId = 'claude-terminal-judge-confirmed-salvage';
  const publicText = 'The email was sent once to recipient@example.test, but I could not confirm whether the rest of the request was complete.';
  const judge = judgeFixture([{
    verb: 'deliver',
    reason: 'the confirmed write can be reported without inventing completion',
    publicText,
  }]);
  let sdkCalls = 0;
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(judge.port);
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    sdkCalls += 1;
    assert.ok(options.sourceUserSeq);
    recordConfirmedWrite({
      sessionId,
      sourceUserSeq: options.sourceUserSeq!,
      turn: 1,
    });
    throw new Error('The model\'s tool call could not be parsed (retry also failed).');
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Send the email once, then report what happened.',
    sessionId,
  });

  assert.equal(sdkCalls, 1, 'confirmed external work is never replayed during salvage');
  assert.equal(judge.runCalls(), 1, 'confirmed-write salvage cannot bypass terminal judging');
  assert.match(judge.requests()[0]?.prompt ?? '', /terminal_account_missing_after_confirmed_write/);
  assert.match(judge.requests()[0]?.prompt ?? '', /already went through/i, 'the ledger summary is judge context');
  assert.equal(response.stoppedReason, 'success');
  assert.equal(response.text, publicText);
  assert.doesNotMatch(response.text, /model errored|nothing was duplicated/i, 'harness salvage prose is not the public default');
  const { event, presentation } = terminalFor(sessionId);
  assert.equal(presentation.status, 'done');
  assert.equal(presentation.text, publicText);
  assert.equal(event.data.terminalJudgeDisposition, 'deliver');
});

test('an empty SDK completion reaches the judge as missing_reply instead of becoming done', async () => {
  const sessionId = 'claude-terminal-judge-missing-reply';
  const publicText = 'I did not get a final response from the model. Would you like me to continue from the recorded turn?';
  const judge = judgeFixture([{
    verb: 'ask',
    reason: 'the model supplied no terminal account',
    publicText,
  }]);
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(judge.port);
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: '',
    sessionId: `sdk-${sessionId}`,
    model: 'claude-test',
    toolUses: [],
    stoppedReason: 'success',
  }));

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Give me a concise answer.',
    sessionId,
  });

  assert.equal(judge.runCalls(), 1);
  const judgePrompt = judge.requests()[0]?.prompt ?? '';
  assert.match(judgePrompt, /missing_reply/);
  assert.match(judgePrompt, /MODEL-AUTHORED TERMINAL ACCOUNT ===\n\(empty\)/);
  assert.equal(response.stoppedReason, 'awaiting-input');
  assert.equal(response.text, publicText);
  assert.doesNotMatch(response.text, /no reply produced/i);
  const { event, presentation } = terminalFor(sessionId);
  assert.equal(presentation.status, 'needs_input');
  assert.equal(presentation.text, publicText);
  assert.equal(event.data.terminalJudgeDisposition, 'ask');
});

test('DELIVER still returns the durable blocked authority when the state machine cannot close', async () => {
  const sessionId = 'claude-terminal-judge-deliver-state-hold';
  const publicText = 'I read the current rows, but I could not bind the requested update to a verified write receipt.';
  const judge = judgeFixture([{
    verb: 'deliver',
    reason: 'the completed read is useful with the missing-write caveat',
    publicText,
  }]);
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(judge.port);
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    assert.ok(options.sourceUserSeq);
    const task = { sessionId, sourceUserSeq: options.sourceUserSeq!, turn: 1 };
    assert.equal(admission.actionExpectedWorkState(task).status, 'required');
    const frozen = contracts.freezeActionExpectedWorkContract({
      ...task,
      proposal: {
        version: 1,
        operations: [{
          id: 'update-sheet',
          effect: 'external_write',
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        }],
        universes: [],
      },
    });
    assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
    recordSuccessfulSdkBusinessResult({
      sessionId,
      sourceUserSeq: options.sourceUserSeq!,
      turn: 1,
    });
    return mixedSdkResult(sessionId);
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Update Google Sheets now after reading the current rows.',
    sessionId,
  });

  assert.equal(response.stoppedReason, 'unverified', 'the committed blocked winner outranks the judge done proposal');
  assert.equal(response.text, publicText);
  const { event, presentation } = terminalFor(sessionId);
  assert.equal(presentation.status, 'blocked');
  assert.equal(presentation.text, publicText);
  assert.equal(event.data.terminalJudgeDisposition, 'deliver');
  assert.equal(event.data.deliveryDisclosure, 'state_machine_hold');
});

test('same-family judge unavailability preserves the conservative hold fallback', async () => {
  const sessionId = 'claude-terminal-judge-unavailable';
  const judge = judgeFixture([{
    verb: 'deliver',
    reason: 'must never run',
    publicText: 'must never publish',
  }], differentFamilyRoute({
    modelId: 'claude-same-family-test',
    judgeFamily: 'claude',
    brainFamily: 'claude',
    transport: 'claude_subscription',
  }));
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(judge.port);
  setClaudeAgentSdkBrainRunForTest(async () => mixedSdkResult(sessionId));

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Tell me one short spreadsheet joke.',
    sessionId,
  });

  assert.equal(judge.resolveCalls(), 1);
  assert.equal(judge.runCalls(), 0, 'same-family route is refused before a model call');
  assert.equal(response.stoppedReason, 'unverified');
  assert.doesNotMatch(response.text, /invoke|parameter|must never publish/i);
  const { event, presentation } = terminalFor(sessionId);
  assert.equal(presentation.status, 'blocked');
  assert.equal(event.data.terminalJudgeDisposition, undefined);
  assert.ok(
    (event.data.verificationMissing as unknown[] | undefined)?.includes('narrated_tool_call_not_executed'),
    'judge unavailability does not clear the Claude-only delivery concern',
  );
});
