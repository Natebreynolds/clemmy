/**
 * Run: npx tsx --test src/runtime/harness/terminal-delivery-judge.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AcceptedSourceSettlementAudit } from './accepted-source-settlement-audit.js';
import type { BoundaryJudgeRouting } from './debate-model.js';
import {
  TERMINAL_DELIVERY_JUDGE_SYSTEM_PROMPT,
  buildTerminalDeliveryJudgePrompt,
  evaluateTerminalDelivery,
  parseTerminalDeliveryJudgeVerdict,
  type TerminalDeliveryJudgeInput,
  type TerminalDeliveryJudgePort,
  type TerminalDeliveryJudgeRequest,
} from './terminal-delivery-judge.js';

function audit(
  status: AcceptedSourceSettlementAudit['status'] = 'unrecovered_failure',
): AcceptedSourceSettlementAudit {
  return {
    status,
    reason: status === 'uncertain_write'
      ? 'one irreversible external write requires reconciliation'
      : 'one business call failure has no successful recovery',
    facts: {
      openLogicalCalls: 0,
      conflictingLogicalCalls: 0,
      startedDispatches: 0,
      businessSettlements: 2,
      successfulBusinessSettlements: 1,
      successfulSdkBusinessResults: 0,
      successfulSdkAuthoringResults: 0,
      unrecoveredBusinessFailures: status === 'unrecovered_failure' ? 1 : 0,
      confirmedWrites: 1,
      uncertainWrites: status === 'uncertain_write' ? 1 : 0,
      blockingUncertainWrites: status === 'uncertain_write' ? 1 : 0,
      successfulBusinessIdentities: [],
      unrecoveredBusinessFailureIdentities: [],
    },
  };
}

function input(overrides: Partial<TerminalDeliveryJudgeInput> = {}): TerminalDeliveryJudgeInput {
  return {
    objective: 'Create the tracker, fill all five rows, and email the verified link.',
    authoredText: 'I created the tracker and filled all five rows, but the email result is not verified.',
    deliveryConcern: {
      reason: 'the email receipt is not bound to the accepted task',
      missing: ['an exact provider send receipt'],
    },
    settlementAudit: audit(),
    priorConsecutiveResumes: 0,
    recoveryCapability: {
      liveContinuation: true,
      toolsAvailable: true,
      externalStateInspection: true,
    },
    ...overrides,
  };
}

function route(overrides: Partial<BoundaryJudgeRouting> = {}): BoundaryJudgeRouting {
  return {
    model: {} as BoundaryJudgeRouting['model'],
    modelId: 'claude-haiku-4-5',
    judgeFamily: 'claude',
    brainFamily: 'codex',
    transport: 'claude_subscription',
    selfJudge: false,
    ...overrides,
  };
}

function injectedPort(
  output: unknown,
  resolved: BoundaryJudgeRouting | null = route(),
  failure?: Error,
): {
  port: TerminalDeliveryJudgePort;
  resolveCalls(): number;
  runCalls(): number;
  request(): TerminalDeliveryJudgeRequest | null;
} {
  let resolves = 0;
  let runs = 0;
  let seen: TerminalDeliveryJudgeRequest | null = null;
  return {
    port: {
      async resolveRoute() {
        resolves += 1;
        return resolved;
      },
      async run(request) {
        runs += 1;
        seen = request;
        if (failure) throw failure;
        return output;
      },
    },
    resolveCalls: () => resolves,
    runCalls: () => runs,
    request: () => seen,
  };
}

test('parser accepts each exact verb and preserves judge-authored fields', () => {
  assert.deepEqual(parseTerminalDeliveryJudgeVerdict(JSON.stringify({
    verb: 'resume',
    reason: 'the readback can still be bound',
    recoveryInstruction: 'Read the created sheet by its retained spreadsheet identifier and bind that result.',
    askIfRepeated: 'I still cannot verify the created sheet. Would you like me to leave it as-is or try a different account?',
  })), {
    verb: 'resume',
    reason: 'the readback can still be bound',
    recoveryInstruction: 'Read the created sheet by its retained spreadsheet identifier and bind that result.',
    askIfRepeated: 'I still cannot verify the created sheet. Would you like me to leave it as-is or try a different account?',
  });
  assert.deepEqual(parseTerminalDeliveryJudgeVerdict('```json\n{"verb":"ask","reason":"account choice is required","publicText":"Which Google account should own the new sheet?"}\n```'), {
    verb: 'ask',
    reason: 'account choice is required',
    publicText: 'Which Google account should own the new sheet?',
  });
  assert.deepEqual(parseTerminalDeliveryJudgeVerdict({
    verb: 'DELIVER',
    reason: 'the completed rows are useful with a disclosed email uncertainty',
    publicText: 'The sheet is complete with all five rows. I could not verify that the email was delivered.',
  }), {
    verb: 'deliver',
    reason: 'the completed rows are useful with a disclosed email uncertainty',
    publicText: 'The sheet is complete with all five rows. I could not verify that the email was delivered.',
  });
});

test('parser rejects incomplete, generic, unknown, and unbounded verdicts without inventing text', () => {
  assert.equal(parseTerminalDeliveryJudgeVerdict({
    verb: 'resume',
    reason: 'retry',
    recoveryInstruction: 'Try again.',
    askIfRepeated: 'Should I stop?',
  }), null, 'RESUME needs a specific recovery instruction');
  assert.equal(parseTerminalDeliveryJudgeVerdict({ verb: 'ask', reason: 'need input' }), null);
  assert.equal(parseTerminalDeliveryJudgeVerdict({ verb: 'deliver', reason: 'done' }), null);
  assert.equal(parseTerminalDeliveryJudgeVerdict({
    verb: 'wait', reason: 'later', publicText: 'Please wait.',
  }), null);
  assert.equal(parseTerminalDeliveryJudgeVerdict(JSON.stringify({
    verb: 'ask', reason: 'x', publicText: 'y'.repeat(4_001),
  })), null);
});

test('prompt is bounded, names the audit floor and strike count, and asks for all three contracts', () => {
  const prompt = buildTerminalDeliveryJudgePrompt(input({
    objective: `Create the sheet. ${'o'.repeat(8_000)}`,
    authoredText: `Five rows are ready. ${'a'.repeat(10_000)}`,
    settlementAudit: audit('uncertain_write'),
    priorConsecutiveResumes: 1,
  }));
  assert.match(prompt, /Create the sheet/);
  assert.match(prompt, /Five rows are ready/);
  assert.match(prompt, /IRREVERSIBLE UNCERTAINTY: YES — ASK is mandatory/);
  assert.match(prompt, /Live continuation: AVAILABLE/);
  assert.match(prompt, /Tools during continuation: AVAILABLE/);
  assert.match(prompt, /Read-only external-state inspection: AVAILABLE/);
  assert.match(prompt, /Consecutive RESUME verdicts already honored: 1/);
  assert.ok(prompt.length < 20_000, `prompt was not bounded: ${prompt.length}`);
  assert.match(TERMINAL_DELIVERY_JUDGE_SYSTEM_PROMPT, /"verb":"resume"/);
  assert.match(TERMINAL_DELIVERY_JUDGE_SYSTEM_PROMPT, /"verb":"ask"/);
  assert.match(TERMINAL_DELIVERY_JUDGE_SYSTEM_PROMPT, /"verb":"deliver"/);
  assert.match(TERMINAL_DELIVERY_JUDGE_SYSTEM_PROMPT, /never ASK the user to inspect a provider/i);
  assert.match(TERMINAL_DELIVERY_JUDGE_SYSTEM_PROMPT, /specific read-only recovery instruction/i);
});

test('first RESUME returns one specific recovery edge through one tool-less call', async () => {
  const fixture = injectedPort({
    verb: 'resume',
    reason: 'the retained sheet id makes exact readback possible',
    recoveryInstruction: 'Read back the retained spreadsheet identifier and compare all five expected rows.',
    askIfRepeated: 'I still cannot verify the five rows. Should I leave the sheet untouched and give you its current link?',
  });
  const result = await evaluateTerminalDelivery(input(), { port: fixture.port, timeoutMs: 100 });
  assert.deepEqual(result, {
    status: 'decided',
    verb: 'resume',
    reason: 'the retained sheet id makes exact readback possible',
    recoveryInstruction: 'Read back the retained spreadsheet identifier and compare all five expected rows.',
    askIfRepeated: 'I still cannot verify the five rows. Should I leave the sheet untouched and give you its current link?',
    consecutiveResumeCount: 1,
    judge: { modelId: 'claude-haiku-4-5', judgeFamily: 'claude', brainFamily: 'codex' },
  });
  assert.equal(fixture.resolveCalls(), 1);
  assert.equal(fixture.runCalls(), 1);
  assert.deepEqual(fixture.request()?.tools, []);
  assert.equal(fixture.request()?.maxTurns, 1);
});

test('a second consecutive RESUME becomes ASK even after the recovery edge is spent', async () => {
  const askIfRepeated = 'The exact readback still failed. Which Google account should I use to inspect the sheet with you?';
  const fixture = injectedPort({
    verb: 'resume',
    reason: 'one more account-scoped read would otherwise be possible',
    recoveryInstruction: 'Read the retained sheet once through the account-scoped Sheets connection and bind its rows.',
    askIfRepeated,
  });
  const result = await evaluateTerminalDelivery(input({
    priorConsecutiveResumes: 1,
    recoveryCapability: {
      liveContinuation: false,
      toolsAvailable: true,
      externalStateInspection: true,
    },
  }), {
    port: fixture.port,
    timeoutMs: 100,
  });
  assert.deepEqual(result, {
    status: 'decided',
    verb: 'ask',
    reason: 'one more account-scoped read would otherwise be possible',
    publicText: askIfRepeated,
    consecutiveResumeCount: 0,
    escalatedFromResume: true,
    judge: { modelId: 'claude-haiku-4-5', judgeFamily: 'claude', brainFamily: 'codex' },
  });
  assert.equal(fixture.runCalls(), 1, 'the bound uses the one verdict; no escalation re-prompt occurs');
});

test('RESUME is unavailable unless the caller proves every recovery capability', async () => {
  const verdict = {
    verb: 'resume',
    reason: 'one exact inspection could close the gap',
    recoveryInstruction: 'Read the retained sheet by exact identifier and bind its current rows.',
    askIfRepeated: 'Which connected account should I use to inspect the retained sheet?',
  };
  const cases: Array<{
    name: string;
    recoveryCapability: TerminalDeliveryJudgeInput['recoveryCapability'];
  }> = [
    {
      name: 'no live continuation',
      recoveryCapability: {
        liveContinuation: false,
        toolsAvailable: true,
        externalStateInspection: true,
      },
    },
    {
      name: 'no tools',
      recoveryCapability: {
        liveContinuation: true,
        toolsAvailable: false,
        externalStateInspection: true,
      },
    },
    {
      name: 'no read-only inspection',
      recoveryCapability: {
        liveContinuation: true,
        toolsAvailable: true,
        externalStateInspection: false,
      },
    },
  ];

  for (const candidate of cases) {
    const fixture = injectedPort(verdict);
    const result = await evaluateTerminalDelivery(input({
      recoveryCapability: candidate.recoveryCapability,
    }), { port: fixture.port, timeoutMs: 100 });
    assert.deepEqual(result, {
      status: 'unavailable',
      cause: 'resume_unavailable',
      judge: { modelId: 'claude-haiku-4-5', judgeFamily: 'claude', brainFamily: 'codex' },
    }, candidate.name);
    assert.equal(fixture.runCalls(), 1, candidate.name);
    assert.equal('recoveryInstruction' in result, false, candidate.name);
  }
});

test('ASK and DELIVER return only their judge-authored public text', async () => {
  const askText = 'Which mailbox should receive the completed sheet link?';
  const askFixture = injectedPort({
    verb: 'ask', reason: 'the destination is not authorized', publicText: askText,
  });
  const askResult = await evaluateTerminalDelivery(input(), { port: askFixture.port, timeoutMs: 100 });
  assert.equal(askResult.status, 'decided');
  assert.equal(askResult.verb, 'ask');
  if (askResult.status === 'decided' && askResult.verb === 'ask') {
    assert.equal(askResult.publicText, askText);
  }

  const deliverText = 'The sheet contains all five rows at https://sheets.example/verified. The email was not attempted.';
  const deliverFixture = injectedPort({
    verb: 'deliver', reason: 'the verified sheet is complete and useful now', publicText: deliverText,
  });
  const deliverResult = await evaluateTerminalDelivery(input(), {
    port: deliverFixture.port,
    timeoutMs: 100,
  });
  assert.equal(deliverResult.status, 'decided');
  assert.equal(deliverResult.verb, 'deliver');
  if (deliverResult.status === 'decided' && deliverResult.verb === 'deliver') {
    assert.equal(deliverResult.publicText, deliverText);
  }
});

test('irreversible-uncertain audit accepts ASK but rejects any other verb as unavailable', async () => {
  const hardFloorInput = input({ settlementAudit: audit('uncertain_write') });
  const wrong = injectedPort({
    verb: 'deliver',
    reason: 'the rest of the work is useful',
    publicText: 'The sheet is complete; the email may have sent.',
  });
  const wrongResult = await evaluateTerminalDelivery(hardFloorInput, {
    port: wrong.port,
    timeoutMs: 100,
  });
  assert.deepEqual(wrongResult, {
    status: 'unavailable',
    cause: 'irreversible_floor_conflict',
    judge: { modelId: 'claude-haiku-4-5', judgeFamily: 'claude', brainFamily: 'codex' },
  });
  assert.equal('publicText' in wrongResult, false, 'wrong hard-floor verb cannot create user prose');

  const askText = 'Please check the Sent folder for the message to Alex before I try anything else.';
  const valid = injectedPort({
    verb: 'ask',
    reason: 'only a human can resolve whether the irreversible send occurred',
    publicText: askText,
  });
  const validResult = await evaluateTerminalDelivery(hardFloorInput, {
    port: valid.port,
    timeoutMs: 100,
  });
  assert.equal(validResult.status, 'decided');
  assert.equal(validResult.verb, 'ask');
  if (validResult.status === 'decided' && validResult.verb === 'ask') {
    assert.equal(validResult.publicText, askText);
  }
});

test('judge outage and invalid output are typed unavailable with no newly canned user text', async () => {
  const outage = injectedPort(null, route(), new Error('provider unavailable'));
  const outageResult = await evaluateTerminalDelivery(input(), { port: outage.port, timeoutMs: 100 });
  assert.equal(outageResult.status, 'unavailable');
  assert.equal(outageResult.cause, 'judge_error');
  assert.equal('publicText' in outageResult, false);
  assert.equal('askIfRepeated' in outageResult, false);
  assert.equal('recoveryInstruction' in outageResult, false);

  const invalid = injectedPort('I think you should probably deliver it.');
  const invalidResult = await evaluateTerminalDelivery(input(), { port: invalid.port, timeoutMs: 100 });
  assert.equal(invalidResult.status, 'unavailable');
  assert.equal(invalidResult.cause, 'invalid_verdict');
  assert.equal('publicText' in invalidResult, false);
});

test('a hung one-call judge times out as unavailable without a repair call', async () => {
  let runs = 0;
  const port: TerminalDeliveryJudgePort = {
    async resolveRoute() { return route(); },
    async run() {
      runs += 1;
      return await new Promise<unknown>(() => {});
    },
  };
  const result = await evaluateTerminalDelivery(input(), { port, timeoutMs: 5 });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.cause, 'timeout');
  assert.equal(runs, 1);
  assert.equal('publicText' in result, false);
});

test('no route, no model, self-judge, and same-family routes are unavailable before any model call', async () => {
  const cases: Array<{
    name: string;
    resolved: BoundaryJudgeRouting | null;
    cause: string;
  }> = [
    { name: 'no route', resolved: null, cause: 'no_route' },
    { name: 'no model', resolved: route({ model: null }), cause: 'no_model' },
    { name: 'self judge', resolved: route({ selfJudge: true }), cause: 'self_judge' },
    {
      name: 'same family despite an incorrect selfJudge tag',
      resolved: route({ judgeFamily: 'codex', brainFamily: 'codex', selfJudge: false }),
      cause: 'same_family',
    },
  ];
  for (const candidate of cases) {
    const fixture = injectedPort({
      verb: 'deliver', reason: 'must not run', publicText: 'must not surface',
    }, candidate.resolved);
    const result = await evaluateTerminalDelivery(input(), { port: fixture.port, timeoutMs: 100 });
    assert.equal(result.status, 'unavailable', candidate.name);
    assert.equal(result.cause, candidate.cause, candidate.name);
    assert.equal(fixture.runCalls(), 0, `${candidate.name} must be rejected before a judge call`);
  }
});
