import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const priorHome = process.env.CLEMENTINE_HOME;
const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-judge-verdict-repair-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(testHome, 'state'), { recursive: true });
const { Usage } = await import('@openai/agents');
const { runRoutedJudgeAttempt, parseCompletionVerdict } = await import('./objective-judge.js');
const { assessReviewCoverage, parseNeedsAllOf } = await import('./review-evidence-coverage.js');
const { MEMORY_REQUIREMENT_REVIEW_INSTRUCTIONS, parseMemoryRequirementPacket } = await import('./memory-completion-obligation.js');
const { closeEventLog } = await import('./eventlog.js');

after(() => {
  closeEventLog();
  rmSync(testHome, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = priorHome;
});

const LONG_REVIEW = [
  'Reviewing the three drafts against the checklist.',
  'Draft 1 uses home services terms, one call to action, 87 words, no banned phrases.',
  'Draft 2 uses legal terms, cites the Local Services Ads gap, 91 words.',
  'Draft 3 uses patient language, contrasts the ratings honestly, 79 words.',
  'All three name the market insight and end with the same question. Nothing was sent.',
].join('\n');

function scripted(texts: string[]): { model: Model; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const model: Model = {
    async getResponse(request): Promise<ModelResponse> {
      requests.push(request);
      const text = texts[Math.min(requests.length - 1, texts.length - 1)]!;
      return { output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, providerData: {} }] }], usage: new Usage(), responseId: `verdict-${requests.length}` };
    },
    async *getStreamedResponse() { throw Error('the judge must not stream'); },
  };
  return { model, requests };
}

const route = (model: Model) => ({
  model, modelId: 'fixture-flagship-judge', judgeFamily: 'claude' as const, brainFamily: 'byo' as const,
  transport: 'claude_subscription' as const,
  selfJudge: false, ownerSelectedJudge: true,
});

test('a reviewer that wrote a review without the verdict line is asked once for the line from its own words', async () => {
  const { model, requests } = scripted([LONG_REVIEW, 'DONE: all three drafts are present with To, Subject, Body and word counts, nothing sent']);
  const verdict = await runRoutedJudgeAttempt(route(model), 'Audit the accepted objective. Reply with EXACTLY ONE LINE.',
    'Objective: three cold emails for review. Delivered: three drafts with word counts. EVIDENCE PACKET: <sixteen thousand tokens of tool results>', parseCompletionVerdict);
  assert.equal(verdict.done, true);
  assert.match(verdict.reason, /three drafts/);
  assert.equal(requests.length, 2, 'exactly one re-ask');
  const repair = JSON.stringify(requests[1]!.input);
  assert.match(repair, /\[YOUR REVIEW\]/);
  assert.match(repair, /Draft 3 uses patient language/, 'the re-ask carries the reviewer\'s own review');
  assert.doesNotMatch(repair, /EVIDENCE PACKET/, 'the re-ask does not resend the evidence packet');
});

test('a reviewer that still gives no verdict fails with the head of what it wrote, never a silent unreadable', async () => {
  const { model, requests } = scripted([LONG_REVIEW, 'I already explained my assessment above in detail.']);
  await assert.rejects(
    runRoutedJudgeAttempt(route(model), 'Audit the accepted objective.', 'Objective: x. Delivered: y.', parseCompletionVerdict),
    (error: unknown) => error instanceof Error && /did not parse; it began: Reviewing the three drafts/.test(error.message),
  );
  assert.equal(requests.length, 2);
});

test('a verdict that parses the first time is never re-asked', async () => {
  const { model, requests } = scripted(['INCOMPLETE: two of three drafts are missing']);
  const verdict = await runRoutedJudgeAttempt(route(model), 'Audit.', 'Objective: x. Delivered: y.', parseCompletionVerdict);
  assert.equal(verdict.done, false);
  assert.equal(requests.length, 1);
});

 test('verdict repair preserves a late finding beyond the former excerpt boundary', async () => {
  const lateFinding = 'FINAL FINDING: the third draft is missing; the objective is incomplete.';
  const { model, requests } = scripted(['Detailed evidence assessment. '.repeat(300) + lateFinding, 'INCOMPLETE: third draft missing']);
  const verdict = await runRoutedJudgeAttempt(route(model), 'Audit.', 'Three drafts requested.', parseCompletionVerdict);
  assert.equal(verdict.done, false);
  assert.equal(requests.length, 2);
  assert.ok(JSON.stringify(requests[1]!.input).includes(lateFinding));
});


test('the judge reports the provider response model, including a verdict repair, rather than only the requested alias', async () => {
  const { model } = scripted([LONG_REVIEW, 'DONE: requested artifact verified']);
  const original = model.getResponse.bind(model);
  let count = 0;
  model.getResponse = async (request) => ({ ...await original(request),
    providerData: { model: ++count === 1 ? 'served-review-version' : 'served-verdict-version' } });
  const responders: string[] = [];
  const verdict = await runRoutedJudgeAttempt(route(model), 'Audit.', 'Objective.', parseCompletionVerdict,
    false, undefined, undefined, undefined, (id) => responders.push(id));
  assert.equal(verdict.done, true);
  assert.deepEqual(responders, ['served-review-version', 'served-verdict-version']);
});

test('a restated verdict is asked for at low depth and the first output is reported to the host', async () => {
  const { model, requests } = scripted([LONG_REVIEW, 'DONE: all three drafts present']);
  const restated: string[] = [];
  const verdict = await runRoutedJudgeAttempt(route(model), 'Audit.', 'Objective: three drafts.', parseCompletionVerdict,
    false, undefined, undefined, 'high', undefined, { restated: (head) => restated.push(head) });
  assert.equal(verdict.done, true);
  assert.equal(requests[0]!.modelSettings.reasoning?.effort, 'high', 'the review itself keeps its requested depth');
  assert.equal(requests[1]!.modelSettings.reasoning?.effort, 'low', 'restating a verdict already reached decides nothing new');
  assert.equal(restated.length, 1);
  assert.match(restated[0]!, /^Reviewing the three drafts/);
});

test('completion repair returns coverage and exact memory bindings together without authorizing an uninspected source', async () => {
  const packet = { version: 1, kind: 'correct', corrections: [{ readCallId: 'call_memory_read',
    expectedDigest: 'a'.repeat(64), edits: [{ before: 'old synthetic convention', after: 'new synthetic convention' }] }],
    reason: 'The owner requested this exact retained correction.' };
  const prior = 'The requested correction names this retained observation. The records needed for the absence claim remain partly shown.\n'
    + `MEMORY_REQUIREMENT: ${JSON.stringify(packet)}`;
  const { model, requests } = scripted([prior,
    `DONE: Requested work reviewed.\nNEEDS ALL OF: call_records\nMEMORY_REQUIREMENT: ${JSON.stringify(packet)}`]);
  const parse = (output: unknown) => {
    const verdict = parseCompletionVerdict(output);
    return verdict ? { ...verdict, needsAllOf: parseNeedsAllOf(output), memoryRequirement: parseMemoryRequirementPacket(output) } : null;
  };
  const result = await runRoutedJudgeAttempt(route(model), `Audit. Reply with EXACTLY ONE LINE.\n${MEMORY_REQUIREMENT_REVIEW_INSTRUCTIONS}`,
    'Objective: controlled synthetic correction and records check. EVIDENCE PACKET: original evidence.', parse,
    true, undefined, undefined, undefined, undefined, undefined, { evidenceCoverage: true, memoryRequirement: true });
  assert.equal(requests.length, 2, 'one format repair returns the entire completion packet');
  assert.deepEqual(result.memoryRequirement, packet, 'the exact correction bindings come from the same repaired output');
  assert.deepEqual(result.needsAllOf, ['call_records']);
  const repair = requests[1]!;
  assert.match(String(repair.systemInstructions), /The earlier one-line rule applies to the verdict line/);
  assert.equal(String(repair.systemInstructions).split(MEMORY_REQUIREMENT_REVIEW_INSTRUCTIONS).length - 1, 1,
    'the exact existing static memory contract is present once');
  assert.match(JSON.stringify(repair.input), /NEEDS ALL OF.*MEMORY_REQUIREMENT/);
  assert.doesNotMatch(JSON.stringify(repair.input), /EVIDENCE PACKET/);
  assert.equal(repair.tools?.length ?? 0, 0, 'restatement gets no new lookup or effect authority');
  assert.equal(assessReviewCoverage({ results: [{ logicalToolCallId: 'call_records', toolName: 'provider_list',
    outcome: 'succeeded', status: 'verified', evidenceKind: 'source_result', contentComplete: false,
    sourceExhausted: true }], needsAllOf: result.needsAllOf }).status, 'insufficient',
  'a contract line does not invent the missing inspection receipt');
  assert.equal(assessReviewCoverage({ results: [{ logicalToolCallId: 'call_records', toolName: 'provider_list',
    outcome: 'succeeded', status: 'verified', evidenceKind: 'source_result', contentComplete: true }],
    needsAllOf: ['invented_ref'] }).status, 'insufficient', 'an unknown ref cannot authorize an acceptance');
});

test('a repaired verdict missing contract lines cannot borrow packets from the earlier review', async () => {
  const priorPacket = { version: 1, kind: 'unresolved', corrections: [], reason: 'The exact correction target was not inspected.' };
  const { model, requests } = scripted([`Review of an incomplete records check.\nNEEDS ALL OF: call_records\nMEMORY_REQUIREMENT: ${JSON.stringify(priorPacket)}`,
    'DONE: reviewed.']);
  const parse = (output: unknown) => {
    const verdict = parseCompletionVerdict(output);
    return verdict ? { ...verdict, needsAllOf: parseNeedsAllOf(output), memoryRequirement: parseMemoryRequirementPacket(output) } : null;
  };
  const result = await runRoutedJudgeAttempt(route(model), 'Audit.', 'Objective: synthetic memory correction.', parse,
    false, undefined, undefined, undefined, undefined, undefined, { evidenceCoverage: true, memoryRequirement: true });
  assert.equal(result.needsAllOf, null);
  assert.equal(result.memoryRequirement, null, 'no detached earlier assessment can authorize the repaired verdict');
  assert.ok(String(requests[1]!.systemInstructions).includes(MEMORY_REQUIREMENT_REVIEW_INSTRUCTIONS),
    'explicit memory restatement retains the exact static schema even through the direct attempt seam');
  assert.equal(assessReviewCoverage({ results: [{ logicalToolCallId: 'call_records', toolName: 'provider_list',
    outcome: 'succeeded', status: 'verified', evidenceKind: 'source_result', contentComplete: false }],
    needsAllOf: result.needsAllOf }).status, 'unattested', 'the ordinary coverage follow-up remains necessary');
});
