import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  CLARIFICATION_REVISION_SURE,
  checkClarificationAnswerCompleteness,
  proposeClarificationRevision,
  validatedClarificationAnswerCompleteness,
  validatedClarificationRevision,
  type ClarificationRevisionInput,
} from './clarification-revision.js';
import { semanticModelRoleForPurpose, completeViaConfiguredBrain } from './configured-brain-semantic-port.js';
import { modelUsageAttributionStorage, withModelUsageAttribution } from '../usage-log.js';
import {
  clarificationRevisionInputDigest,
  validatedClarificationStructuralDiagnostic,
} from './clarification-structural-diagnostic.js';
import {
  clarificationReferenceDigest,
  renderClarificationUnavailable,
} from '../harness/clarification-public-annotation.js';

const input: ClarificationRevisionInput = {
  sessionId: 'fixture-partial-clarification',
  sourceUserSeq: 41,
  rootTask: 'Prepare local review notes from a report. Hold changes until the source and escalation rule are clear.',
  deliveredQuestion: 'Which report? I suggest 6 notes per batch. What does the escalation label mean and when should it trigger?',
  deliveredOptions: [],
  acceptedReply: 'Use the weekly review report. Make 14 to 18 notes for this first batch. Can I attach the report?',
};

function proposal() {
  return {
    kind: 'revision',
    acknowledgment: 'I kept the weekly review report and your first batch of 14 to 18 notes.',
    question: 'What does the escalation label mean and when should it trigger?',
    options: [],
    decisions: [
      { id: 'source', questionQuote: 'Which report?', disposition: 'answered', claim: 'weekly review report',
        replyQuote: 'Use the weekly review report.', residualQuote: null },
      { id: 'batch', questionQuote: 'I suggest 6 notes per batch.', disposition: 'amended', claim: '14 to 18 notes for this first batch',
        replyQuote: 'Make 14 to 18 notes for this first batch.', residualQuote: null },
      { id: 'escalation', questionQuote: 'What does the escalation label mean and when should it trigger?', disposition: 'unresolved',
        claim: null, replyQuote: null, residualQuote: 'What does the escalation label mean and when should it trigger?' },
    ],
  };
}

function ports(raw: unknown = proposal(), noul = 0.99) {
  const calls: Array<{ lane: string; input: unknown }> = [];
  return {
    calls,
    complete: async (value: Parameters<NonNullable<Parameters<typeof proposeClarificationRevision>[1]>['complete']>[0]) => {
      calls.push({ lane: 'proposal', input: value });
      return { raw, modelIdentity: 'fixture-requested-quick', inputTokens: 101, outputTokens: 29, latencyMs: 3, usageRecorded: true };
    },
    evaluate: async (value: Parameters<NonNullable<Parameters<typeof proposeClarificationRevision>[1]>['evaluate']>[0]) => {
      calls.push({ lane: 'jev', input: value });
      return { ok: true as const, model: 'fixture-served-jev', answers: { grounded_revision: { type: 'noul' as const, noul } },
        usage: { input_tokens: 204, output_tokens: 1 }, decisionId: 'fixture-exact-decision' };
    },
  };
}

const optionInput: ClarificationRevisionInput = {
  sessionId: 'fixture-compound-visible-options', sourceUserSeq: 91,
  rootTask: 'Prepare a local batch report only after the source, quantity, timing and RGL definition and trigger are known.',
  deliveredQuestion: 'Which source and timing should I use? What does RGL mean and when should it trigger?',
  deliveredOptions: [
    'Use CEDAR BATCH LOG, 10–12 cases, and 2026-10-06 09:00 America/Los_Angeles; RGL still needs its meaning and trigger.',
    'Specify a different source, batch quantity, or time; supply the RGL meaning and trigger.',
  ],
  acceptedReply: 'Confirmed: use CEDAR BATCH LOG for the source and 2026-10-06 09:00 America/Los_Angeles for timing. Change the quantity to 14–16 cases. The rest is approved.',
};

function optionProposal() {
  return {
    kind: 'revision',
    acknowledgment: 'I kept CEDAR BATCH LOG and the timing, and recorded your change to 14–16 cases.',
    question: 'What does RGL mean and when should it trigger?', options: [],
    decisions: [
      { id: 'source', questionQuote: 'CEDAR BATCH LOG', disposition: 'answered', claim: 'CEDAR BATCH LOG',
        replyQuote: 'use CEDAR BATCH LOG for the source', residualQuote: null },
      { id: 'quantity', questionQuote: '10–12 cases', disposition: 'amended', claim: '14–16 cases',
        replyQuote: 'Change the quantity to 14–16 cases.', residualQuote: null },
      { id: 'timing', questionQuote: '2026-10-06 09:00 America/Los_Angeles', disposition: 'answered',
        claim: '2026-10-06 09:00 America/Los_Angeles',
        replyQuote: '2026-10-06 09:00 America/Los_Angeles for timing', residualQuote: null },
      { id: 'rgl', questionQuote: 'What does RGL mean and when should it trigger?', disposition: 'unresolved',
        claim: null, replyQuote: null, residualQuote: 'What does RGL mean and when should it trigger?' },
    ],
  };
}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

test('exact visible-option anchors preserve a compound amendment only after one independent check', async () => {
  const fixture = ports(optionProposal());
  const result = await proposeClarificationRevision(optionInput, fixture);
  assert.equal(result.status, 'proposed');
  if (result.status !== 'proposed') return;
  assert.deepEqual(fixture.calls.map((call) => call.lane), ['proposal', 'jev']);
  assert.equal(result.revision.anchorPolicy, 'question_and_visible_options_v1');
  assert.equal(result.revision.decisions[1]?.claim, '14–16 cases');
  assert.equal(result.revision.question, 'What does RGL mean and when should it trigger?');
  assert.equal(result.revision.decisions[3]?.claim, null, 'generic assent cannot define or trigger RGL');
  assert.deepEqual(validatedClarificationRevision(optionInput, result.revision), result.revision);
  const proposalCall = fixture.calls[0]!.input as { system: string };
  assert.match(proposalCall.system, /OR ONE exact deliveredOptions entry/);
  assert.match(proposalCall.system, /Never concatenate anchors/);
  const reviewCall = fixture.calls[1]!.input as { state: Record<string, unknown>; timeoutMs: number; decisionContext: Record<string, unknown> };
  assert.deepEqual(reviewCall.state.deliveredOptions, optionInput.deliveredOptions);
  assert.equal(reviewCall.state.acceptedReply, optionInput.acceptedReply);
  assert.equal(reviewCall.timeoutMs, 4_000);
  assert.equal(reviewCall.decisionContext.inputDigest, result.revision.inputDigest);
  assert.equal(reviewCall.decisionContext.proposalDigest, result.revision.proposalDigest);
  assert.equal(result.revision.inputDigest, sha({ sessionId: optionInput.sessionId, sourceUserSeq: optionInput.sourceUserSeq,
    rootTask: optionInput.rootTask, deliveredQuestion: optionInput.deliveredQuestion,
    deliveredOptions: [...optionInput.deliveredOptions], acceptedReply: optionInput.acceptedReply }));
});

test('legacy question-only receipts keep their original digest and cannot gain option-anchor admissibility', async () => {
  const questionResult = await proposeClarificationRevision(input, ports());
  const optionResult = await proposeClarificationRevision(optionInput, ports(optionProposal()));
  assert.equal(questionResult.status, 'proposed');
  assert.equal(optionResult.status, 'proposed');
  if (questionResult.status !== 'proposed' || optionResult.status !== 'proposed') return;
  const { anchorPolicy: _oldPolicy, ...legacyQuestion } = questionResult.revision;
  legacyQuestion.proposalDigest = sha({ version: 1, inputDigest: legacyQuestion.inputDigest, proposed: proposal() });
  assert.deepEqual(validatedClarificationRevision(input, legacyQuestion), legacyQuestion);
  assert.equal(validatedClarificationRevision(input, { ...legacyQuestion, anchorPolicy: 'question_and_visible_options_v1' }), null);
  const { anchorPolicy: _newPolicy, ...legacyOption } = optionResult.revision;
  legacyOption.proposalDigest = sha({ version: 1, inputDigest: legacyOption.inputDigest, proposed: optionProposal() });
  assert.equal(validatedClarificationRevision(optionInput, legacyOption), null, 'legacy guard remains question-only even with a matching legacy digest');
  assert.equal(validatedClarificationRevision(optionInput, { ...optionResult.revision, anchorPolicy: undefined }), null);
  assert.equal(validatedClarificationRevision(optionInput, { ...optionResult.revision, anchorPolicy: 'other_policy' }), null);
  assert.equal(validatedClarificationRevision(optionInput, { ...optionResult.revision, proposalDigest: legacyOption.proposalDigest }), null);
  assert.equal(validatedClarificationRevision(optionInput, { ...optionResult.revision, anchorPolicy: undefined,
    proposalDigest: sha({ version: 1, inputDigest: optionResult.revision.inputDigest, proposed: optionProposal() }) }), null);
});

test('structural diagnostics identify one finite local predicate without retaining source or model text', async (t) => {
  const p = optionProposal();
  const cases = [
    { name: 'invented quote', raw: { ...p, decisions: [{ ...p.decisions[0], questionQuote: 'PRIVATE_INVENTED_QUOTE' }, ...p.decisions.slice(1)] },
      reason: 'question_quote_unbound', decisionIndex: 0, anchorOrigin: null, optionIndex: null },
    { name: 'question and option concatenated', raw: { ...p, decisions: [{ ...p.decisions[0], questionQuote: `${optionInput.deliveredQuestion} CEDAR BATCH LOG` }, ...p.decisions.slice(1)] },
      reason: 'question_quote_unbound', decisionIndex: 0, anchorOrigin: null, optionIndex: null },
    { name: 'two options concatenated', raw: { ...p, decisions: [{ ...p.decisions[0], questionQuote: `${optionInput.deliveredOptions[0]} ${optionInput.deliveredOptions[1]}` }, ...p.decisions.slice(1)] },
      reason: 'question_quote_unbound', decisionIndex: 0, anchorOrigin: null, optionIndex: null },
    { name: 'root task quote', raw: { ...p, decisions: [{ ...p.decisions[0], questionQuote: 'Prepare a local batch report only' }, ...p.decisions.slice(1)] },
      reason: 'question_quote_unbound', decisionIndex: 0, anchorOrigin: null, optionIndex: null },
    { name: 'invented reply', raw: { ...p, decisions: [{ ...p.decisions[0], replyQuote: 'PRIVATE_INVENTED_REPLY' }, ...p.decisions.slice(1)] },
      reason: 'reply_quote_unbound', decisionIndex: 0, anchorOrigin: 'option', optionIndex: 0 },
    { name: 'duplicate ID', raw: { ...p, decisions: [...p.decisions, p.decisions[0]] },
      reason: 'duplicate_decision_id', decisionIndex: 4, anchorOrigin: 'option', optionIndex: 0 },
    { name: 'changed options', raw: { ...p, options: ['PRIVATE_CHANGED_OPTION'] },
      reason: 'options_changed', decisionIndex: null, anchorOrigin: null, optionIndex: null },
    { name: 'answered without reply', raw: { ...p, decisions: [{ ...p.decisions[0], replyQuote: null }, ...p.decisions.slice(1)] },
      reason: 'settled_fields_invalid', decisionIndex: 0, anchorOrigin: 'option', optionIndex: 0 },
    { name: 'answered with residual', raw: { ...p, decisions: [{ ...p.decisions[0], residualQuote: p.question }, ...p.decisions.slice(1)] },
      reason: 'settled_fields_invalid', decisionIndex: 0, anchorOrigin: 'option', optionIndex: 0 },
    { name: 'missing residual quote', raw: { ...p, decisions: [...p.decisions.slice(0, 3), { ...p.decisions[3], residualQuote: null }] },
      reason: 'residual_quote_unbound', decisionIndex: 3, anchorOrigin: 'question', optionIndex: null },
    { name: 'invented residual quote', raw: { ...p, decisions: [...p.decisions.slice(0, 3), { ...p.decisions[3], residualQuote: 'PRIVATE_RESIDUAL_QUOTE' }] },
      reason: 'residual_quote_unbound', decisionIndex: 3, anchorOrigin: 'question', optionIndex: null },
    { name: 'unresolved with claim', raw: { ...p, decisions: [...p.decisions.slice(0, 3), { ...p.decisions[3], claim: 'Invented definition' }] },
      reason: 'unresolved_fields_invalid', decisionIndex: 3, anchorOrigin: 'question', optionIndex: null },
    { name: 'binding without claimed answer', raw: { ...p, decisions: [...p.decisions.slice(0, 3), { ...p.decisions[3], disposition: 'binding_needed' }] },
      reason: 'binding_fields_invalid', decisionIndex: 3, anchorOrigin: 'question', optionIndex: null },
    { name: 'no residual decision', raw: { ...p, decisions: p.decisions.slice(0, 3) },
      reason: 'no_residual_decision', decisionIndex: null, anchorOrigin: null, optionIndex: null },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const fixture = ports(scenario.raw);
    const result = await proposeClarificationRevision(optionInput, fixture);
    assert.equal(result.status, 'unavailable');
    if (result.status !== 'unavailable') return;
    assert.equal(result.reason, 'interpretation_unbound');
    assert.deepEqual(fixture.calls.map((call) => call.lane), ['proposal']);
    assert.equal(result.diagnostic, undefined, 'local guard rejection is not a provider failure');
    assert.deepEqual(result.structuralDiagnostic, {
      version: 1, kind: 'clarification_structural_rejection', anchorPolicy: 'question_and_visible_options_v1',
      sessionId: optionInput.sessionId, sourceUserSeq: optionInput.sourceUserSeq,
      inputDigest: clarificationRevisionInputDigest(optionInput),
      proposalDigest: sha({ version: 1, inputDigest: clarificationRevisionInputDigest(optionInput), anchorPolicy: 'question_and_visible_options_v1', proposed: scenario.raw }),
      reason: scenario.reason, decisionIndex: scenario.decisionIndex, anchorOrigin: scenario.anchorOrigin, optionIndex: scenario.optionIndex,
    });
    assert.deepEqual(validatedClarificationStructuralDiagnostic(result.structuralDiagnostic, optionInput), result.structuralDiagnostic);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|CEDAR|cases|RGL|Los_Angeles|quote\":|claim\":|reply\":/);
  });
});

test('diagnostic projection rejects foreign source/input, open fields, unsafe indices and policy drift', async () => {
  const p = optionProposal();
  const result = await proposeClarificationRevision(optionInput, ports({ ...p, decisions: [{ ...p.decisions[0], replyQuote: null }, ...p.decisions.slice(1)] }));
  assert.equal(result.status, 'unavailable');
  if (result.status !== 'unavailable' || !result.structuralDiagnostic) return;
  const safe = result.structuralDiagnostic;
  for (const changed of [
    { ...optionInput, sessionId: 'foreign' }, { ...optionInput, sourceUserSeq: 92 },
    { ...optionInput, rootTask: `${optionInput.rootTask} changed` },
    { ...optionInput, deliveredQuestion: `${optionInput.deliveredQuestion} changed` },
    { ...optionInput, deliveredOptions: [...optionInput.deliveredOptions].reverse() },
    { ...optionInput, acceptedReply: `${optionInput.acceptedReply} changed` },
  ]) assert.equal(validatedClarificationStructuralDiagnostic(safe, changed), null);
  for (const bad of [
    { ...safe, version: 2 }, { ...safe, kind: 'provider_error' }, { ...safe, anchorPolicy: undefined },
    { ...safe, anchorPolicy: 'other_policy' }, { ...safe, inputDigest: 'a'.repeat(64) },
    { ...safe, proposalDigest: 'private proposal text' }, { ...safe, reason: 'raw private reason' },
    { ...safe, rawProposal: p }, { ...safe, error: 'PRIVATE_ERROR' }, { ...safe, questionQuote: 'PRIVATE_QUOTE' },
    { ...safe, decisionIndex: -1 }, { ...safe, decisionIndex: 8 }, { ...safe, decisionIndex: 0.5 },
    { ...safe, decisionIndex: null }, { ...safe, anchorOrigin: 'root_task' },
    { ...safe, anchorOrigin: null }, { ...safe, anchorOrigin: 'question' },
    { ...safe, optionIndex: null }, { ...safe, optionIndex: 2 }, { ...safe, optionIndex: 8 },
    { ...safe, reason: 'options_changed' }, { ...safe, reason: 'question_quote_unbound' },
  ]) assert.equal(validatedClarificationStructuralDiagnostic(bad, optionInput), null);
});

test('separately bound public notice is retained as history and cannot become a decision anchor', async () => {
  const annotated: ClarificationRevisionInput = { ...optionInput,
    deliveredPublicQuestion: renderClarificationUnavailable(optionInput.deliveredQuestion),
    deliveredQuestionAnnotation: {
      version: 1, kind: 'clarification_reading_unavailable', sessionId: optionInput.sessionId,
      sourceUserSeq: optionInput.sourceUserSeq - 1, parentPacketId: 'fixture-exact-parent',
      readingEventId: 'fixture-exact-reading',
      referenceSha256: clarificationReferenceDigest(optionInput.deliveredQuestion, optionInput.deliveredOptions),
    },
  };
  const p = optionProposal();
  const fixture = ports(p);
  const result = await proposeClarificationRevision(annotated, fixture);
  assert.equal(result.status, 'proposed');
  if (result.status !== 'proposed') return;
  assert.deepEqual(validatedClarificationRevision(annotated, result.revision), result.revision);
  assert.notEqual(result.revision.inputDigest, clarificationRevisionInputDigest(optionInput));
  const review = fixture.calls[1]!.input as { state: Record<string, unknown> };
  assert.equal(review.state.deliveredPublicQuestion, annotated.deliveredPublicQuestion);
  assert.deepEqual(review.state.deliveredQuestionAnnotation, annotated.deliveredQuestionAnnotation);
  const failed = await proposeClarificationRevision(annotated, ports({ ...p,
    decisions: [{ ...p.decisions[0], questionQuote: 'Your reply is recorded.' }, ...p.decisions.slice(1)] }));
  assert.equal(failed.status, 'unavailable');
  if (failed.status !== 'unavailable') return;
  assert.equal(failed.structuralDiagnostic?.reason, 'question_quote_unbound');
  assert.deepEqual(validatedClarificationStructuralDiagnostic(failed.structuralDiagnostic, annotated), failed.structuralDiagnostic);
  assert.equal(validatedClarificationStructuralDiagnostic(failed.structuralDiagnostic, optionInput), null);
  assert.equal(validatedClarificationRevision(optionInput, result.revision), null);
});

test('option anchors still require strict fields, residual coverage and independent Jev evidence', async () => {
  const p = optionProposal();
  const { questionQuote: _quote, ...missingQuote } = p.decisions[0]!;
  for (const raw of [
    { ...p, decisions: [missingQuote, ...p.decisions.slice(1)] },
    { ...p, anchorPolicy: 'question_and_visible_options_v1' },
    { ...p, decisions: [{ ...p.decisions[0], extra: 'authority' }, ...p.decisions.slice(1)] },
  ]) {
    const fixture = ports(raw);
    const result = await proposeClarificationRevision(optionInput, fixture);
    assert.deepEqual(result, { status: 'unavailable', stage: 'proposal', reason: 'interpretation_invalid' });
    assert.deepEqual(fixture.calls.map((call) => call.lane), ['proposal']);
  }
  for (const noul of [0.1, CLARIFICATION_REVISION_SURE - 0.001]) {
    const fixture = ports(p, noul);
    assert.deepEqual(await proposeClarificationRevision(optionInput, fixture), { status: 'no_revision', reason: 'not_grounded' });
    assert.deepEqual(fixture.calls.map((call) => call.lane), ['proposal', 'jev']);
  }
  const fixture = ports(p);
  assert.deepEqual(await proposeClarificationRevision(optionInput, { ...fixture, evaluate: async () => { throw new Error('PRIVATE_REVIEW_FAILURE'); } }),
    { status: 'unavailable', stage: 'review', reason: 'review_unavailable' });
  const result = await proposeClarificationRevision(optionInput, ports(p));
  if (result.status !== 'proposed') return assert.fail('expected a reviewed fixture receipt');
  assert.equal(validatedClarificationRevision(optionInput, { ...result.revision, review: undefined }), null);
  assert.equal(validatedClarificationRevision(optionInput, { ...result.revision, review: { ...result.revision.review, noul: 0.94 } }), null);
  const changed = { ...p, decisions: [{ ...p.decisions[0], questionQuote: 'PRIVATE_FORGED' }, ...p.decisions.slice(1)] };
  assert.equal(validatedClarificationRevision(optionInput, { ...result.revision, decisions: changed.decisions,
    proposalDigest: sha({ version: 1, inputDigest: result.revision.inputDigest, anchorPolicy: result.revision.anchorPolicy, proposed: changed }) }), null,
  'persisted validation applies the identical literal anchor guard even with a matching forged proposal digest');
});

test('partial answers and changed quantity become only a residual question after one independent check', async () => {
  const fixture = ports();
  const result = await proposeClarificationRevision(input, fixture);
  assert.equal(result.status, 'proposed');
  if (result.status !== 'proposed') return;
  assert.deepEqual(fixture.calls.map((call) => call.lane), ['proposal', 'jev']);
  assert.equal(result.revision.decisions[1]?.claim, '14 to 18 notes for this first batch');
  assert.doesNotMatch(result.revision.question, /6 notes|Which report/);
  assert.equal(result.revision.proposalModelIdentity, 'fixture-requested-quick');
  assert.equal(result.revision.review.modelIdentity, 'fixture-served-jev');
  assert.equal(result.revision.sourceDigest, result.revision.inputDigest);
  assert.deepEqual(validatedClarificationRevision(input, result.revision), result.revision);
  const checked = fixture.calls[1]!.input as { state: Record<string, unknown>; questions: Record<string, { instructions: string }> };
  assert.equal(checked.state.rootTask, input.rootTask);
  assert.equal(checked.state.acceptedReply, input.acceptedReply);
  assert.equal(checked.state.deliveredQuestion, input.deliveredQuestion);
  assert.match(checked.questions.grounded_revision!.instructions, /ALL independent required decisions/);
  assert.match(checked.questions.grounded_revision!.instructions, /Literal quotes alone do not prove entailment/);
});

test('a fully supplied but unbindable answer gets an honest focused binding question', async () => {
  const fullyAnswered = { ...input, deliveredQuestion: 'Which local folder should hold the notes?', acceptedReply: 'Use the review folder.' };
  const fixture = ports({ kind: 'revision', acknowledgment: 'I understood the review folder.',
    question: 'Which exact local path is the review folder?', options: [], decisions: [{ id: 'destination',
      questionQuote: fullyAnswered.deliveredQuestion, disposition: 'binding_needed', claim: 'review folder',
      replyQuote: fullyAnswered.acceptedReply, residualQuote: 'Which exact local path is the review folder?' }] });
  const result = await proposeClarificationRevision(fullyAnswered, fixture);
  assert.equal(result.status, 'proposed');
  if (result.status === 'proposed') assert.equal(result.revision.decisions[0]?.disposition, 'binding_needed');
});

test('source/session/question/options changes and forged or weakened receipts cannot replay a revision', async () => {
  const result = await proposeClarificationRevision(input, ports());
  assert.equal(result.status, 'proposed');
  if (result.status !== 'proposed') return;
  for (const changed of [
    { ...input, sessionId: 'other-session' }, { ...input, sourceUserSeq: 42 },
    { ...input, rootTask: `${input.rootTask} Remove a requirement.` },
    { ...input, deliveredQuestion: `${input.deliveredQuestion} Another question?` },
    { ...input, deliveredOptions: ['hidden option'] },
    { ...input, acceptedReply: `${input.acceptedReply} Change it again.` },
  ]) assert.equal(validatedClarificationRevision(changed, result.revision), null);
  for (const changed of [
    { ...result.revision, acknowledgment: 'Work started.' },
    { ...result.revision, proposalDigest: 'a'.repeat(64) },
    { ...result.revision, sourceDigest: 'a'.repeat(64) },
    { ...result.revision, review: { ...result.revision.review, noul: 0.94 } },
    { ...result.revision, review: undefined },
    { ...result.revision, approved: true },
  ]) assert.equal(validatedClarificationRevision(input, changed), null);
});

test('invented quotes, duplicate decisions and hidden options are rejected before a review call', async () => {
  const malformed = [
    { ...proposal(), decisions: [{ ...proposal().decisions[0], questionQuote: 'A question never asked' }] },
    { ...proposal(), decisions: [{ ...proposal().decisions[0], replyQuote: 'An answer never supplied' }] },
    { ...proposal(), decisions: [...proposal().decisions, proposal().decisions[0]] },
    { ...proposal(), options: ['Approve and execute'] },
    { ...proposal(), decisions: proposal().decisions.map((decision) => decision.id === 'escalation'
      ? { ...decision, residualQuote: 'A question not in the revision' } : decision) },
    { ...proposal(), decisions: proposal().decisions.slice(0, 2) },
    { ...proposal(), decisions: Array.from({ length: 9 }, () => proposal().decisions[0]) },
    { ...proposal(), operations: [{ effect: 'send' }] },
  ];
  for (const raw of malformed) {
    const fixture = ports(raw);
    const result = await proposeClarificationRevision(input, fixture);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(fixture.calls.map((call) => call.lane), ['proposal']);
  }
});

test('an independent low or invalid judgment cannot turn a semantically wrong proposal into a question revision', async () => {
  const wrong = { ...proposal(), acknowledgment: 'Your generic assent defined every missing fact.' };
  for (const noul of [0.02, CLARIFICATION_REVISION_SURE - 0.001]) {
    const fixture = ports(wrong, noul);
    assert.deepEqual(await proposeClarificationRevision(input, fixture), { status: 'no_revision', reason: 'not_grounded' });
    assert.equal(fixture.calls.length, 2);
  }
  for (const noul of [NaN, Infinity, 1.01]) {
    const fixture = ports(proposal(), noul);
    assert.deepEqual(await proposeClarificationRevision(input, fixture), { status: 'unavailable', stage: 'review', reason: 'review_invalid' });
  }
});

test('interpretation failure and unavailable Jev stay unavailable and never masquerade as user ambiguity', async () => {
  const fixture = ports();
  const failed = await proposeClarificationRevision(input, { ...fixture, complete: async () => { throw new Error('private provider detail'); } });
  assert.deepEqual(failed, { status: 'unavailable', stage: 'proposal', reason: 'interpretation_unavailable' });
  assert.equal(fixture.calls.length, 0);
  const invalid = await proposeClarificationRevision(input, ports({ kind: 'bad' }));
  assert.deepEqual(invalid, { status: 'unavailable', stage: 'proposal', reason: 'interpretation_invalid' });
  for (const reason of ['disabled', 'missing_key', 'timeout', 'malformed'] as const) {
    const unavailable = await proposeClarificationRevision(input, { ...ports(), evaluate: async () => ({ ok: false as const, reason }) });
    assert.deepEqual(unavailable, { status: 'unavailable', stage: 'review', reason: `review_${reason}` });
  }
});

test('the interpretation can decline a revision without inventing a question or paying for a judge', async () => {
  const fixture = ports({ kind: 'no_revision', reason: 'no_progress' });
  assert.deepEqual(await proposeClarificationRevision(input, fixture), { status: 'no_revision', reason: 'no_progress' });
  assert.equal(fixture.calls.length, 1);
});

test('bounds preserve the complete source or reject it without truncation and without calls', async () => {
  for (const changed of [
    { ...input, sourceUserSeq: 0 }, { ...input, rootTask: 'x'.repeat(20_001) },
    { ...input, deliveredQuestion: 'x'.repeat(4_001) }, { ...input, acceptedReply: 'x'.repeat(8_001) },
    { ...input, deliveredOptions: ['x'.repeat(501)] },
  ]) {
    const fixture = ports();
    assert.deepEqual(await proposeClarificationRevision(changed, fixture), {
      status: 'unavailable', stage: 'input', reason: 'exact_input_out_of_bounds',
    });
    assert.equal(fixture.calls.length, 0);
  }
});

test('offered options must be free text or exact unchanged host-visible options', async () => {
  const withOptions = { ...input, deliveredOptions: ['Local path', 'Attached file'] };
  assert.equal((await proposeClarificationRevision(withOptions, ports({ ...proposal(), options: [...withOptions.deliveredOptions] }))).status, 'proposed');
  for (const options of [['Attached file', 'Local path'], ['Local path'], ['New option']]) {
    assert.equal((await proposeClarificationRevision(withOptions, ports({ ...proposal(), options }))).status, 'unavailable');
  }
});

test('proposal and review carry exact accepted-source accounting without inheriting another attempt', async () => {
  const observed: unknown[] = [];
  const fixture = ports();
  await withModelUsageAttribution({ sessionId: 'different-session', sourceUserSeq: 12, attemptId: 'other-attempt' }, () =>
    proposeClarificationRevision(input, {
      complete: async (value) => { observed.push(modelUsageAttributionStorage.getStore()); return fixture.complete(value); },
      evaluate: async (value) => { observed.push(modelUsageAttributionStorage.getStore()); return fixture.evaluate(value); },
    }));
  assert.equal(observed.length, 2);
  for (const context of observed as Array<{ sessionId: string; sourceUserSeq: number; attemptId?: string }>) {
    assert.equal(context.sessionId, input.sessionId);
    assert.equal(context.sourceUserSeq, input.sourceUserSeq);
    assert.equal(context.attemptId, undefined);
  }
});

test('production proposal uses the configured Quick role and does not retry on the brain', async () => {
  assert.equal(semanticModelRoleForPurpose('clarification_revision'), 'quick');
  const { setDefaultModelProvider } = await import('@openai/agents');
  const { RouterModelProvider } = await import('../harness/router-model.js');
  const models: string[] = [];
  setDefaultModelProvider({ getModel(modelId) { models.push(String(modelId)); throw new Error('fixture transport unavailable'); } });
  try {
    await assert.rejects(completeViaConfiguredBrain({ purpose: 'clarification_revision',
      system: 'fixture', user: '{}', schemaName: 'ClarificationRevisionV1' }));
    assert.equal(models.length, 1, 'one selected role request, no brain fallback');
  } finally { setDefaultModelProvider(new RouterModelProvider()); }
});

type CapturedWireRequest = {
  response_format?: { type?: string; json_schema?: { schema?: Record<string, unknown> } };
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: unknown[];
};

/** The real Runner serializes outputType and the real BYO adapter translates
 * it; only the final network create function is replaced with a local fake. */
async function withRevisionWireCapture(
  content: string | ((request: Record<string, unknown>, options: unknown) => Promise<unknown>),
  run: (capture: { sdk: CapturedWireRequest[]; backend: CapturedWireRequest[]; selectedModels: string[] }) => Promise<void>,
) {
  const { setDefaultModelProvider } = await import('@openai/agents');
  const { OpenAIChatCompletionsModel } = await import('@openai/agents-openai');
  const { RouterModelProvider } = await import('../harness/router-model.js');
  const { wrapCompletionsCreate } = await import('../harness/byo-model.js');
  const capture = { sdk: [] as CapturedWireRequest[], backend: [] as CapturedWireRequest[], selectedModels: [] as string[] };
  const create = wrapCompletionsCreate(async (request, options) => {
    capture.backend.push(structuredClone(request));
    if (typeof content === 'function') return content(request, options);
    return {
      id: `clarification-wire-${capture.backend.length}`, object: 'chat.completion', created: 1,
      model: request.model,
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    };
  });
  const client = { baseURL: 'http://clarification-wire.invalid', chat: { completions: {
    create: async (request: Record<string, unknown>, options?: unknown) => {
      capture.sdk.push(structuredClone(request));
      return create(request, options);
    },
  } } };
  setDefaultModelProvider({ getModel(modelId) {
    capture.selectedModels.push(String(modelId));
    return new OpenAIChatCompletionsModel(client as never, String(modelId));
  } });
  try { await run(capture); }
  finally { setDefaultModelProvider(new RouterModelProvider()); }
}

test('clarification wire reaches the real SDK and BYO schema path before a checked revision', async () => {
  const revision = proposal();
  await withRevisionWireCapture(JSON.stringify({ result: revision }), async (capture) => {
    const review = ports();
    const result = await proposeClarificationRevision(input, { ...review, complete: completeViaConfiguredBrain });
    assert.equal(capture.sdk[0]?.response_format?.type, 'json_schema', 'the actual SDK must serialize the requested schema');
    const schema = capture.sdk[0]?.response_format?.json_schema?.schema;
    assert.equal(schema?.type, 'object');
    assert.deepEqual(schema?.required, ['result']);
    assert.equal(schema?.additionalProperties, false);
    const resultSchema = (schema?.properties as Record<string, unknown>)?.result;
    assert.match(JSON.stringify(resultSchema), /"revision"/);
    assert.match(JSON.stringify(resultSchema), /"no_revision"/);
    assert.match(JSON.stringify(resultSchema), /"questionQuote"/);
    assert.equal(capture.backend[0]?.response_format?.type, 'json_object');
    const system = capture.backend[0]?.messages?.find((item) => item.role === 'system');
    assert.match(String(system?.content), /JSON Schema/);
    assert.match(String(system?.content), /"result"[\s\S]*"questionQuote"/);
    assert.equal(capture.selectedModels.length, 1, 'one selected Quick proposal, no brain fallback');
    assert.equal(capture.sdk.length, 1);
    assert.equal(capture.backend.length, 1, 'a conforming revision needs no transport repair');
    assert.ok(!capture.backend[0]?.tools?.length, 'revision evidence cannot execute tools');
    assert.equal(result.status, 'proposed');
    assert.deepEqual(review.calls.map((entry) => entry.lane), ['jev'], 'the original independent grounding check still runs');
    if (result.status !== 'proposed') return;
    assert.deepEqual(result.revision.decisions, revision.decisions);
    assert.equal(result.revision.question, revision.question);
    assert.equal(result.revision.decisions[1]?.claim, '14 to 18 notes for this first batch');
    assert.deepEqual(validatedClarificationRevision(input, result.revision), result.revision);
  });
});

test('clarification wire preserves the no_revision alternative without review or retry', async () => {
  await withRevisionWireCapture(JSON.stringify({ result: { kind: 'no_revision', reason: 'no_progress' } }), async (capture) => {
    const review = ports();
    assert.deepEqual(await proposeClarificationRevision(input, { ...review, complete: completeViaConfiguredBrain }),
      { status: 'no_revision', reason: 'no_progress' });
    assert.equal(review.calls.length, 0);
    assert.equal(capture.selectedModels.length, 1);
    assert.equal(capture.backend.length, 1);
  });
});

test('clarification wire rejects malformed, extra-key and unenveloped answers before grounding', async (t) => {
  for (const scenario of [
    { name: 'malformed JSON', content: '{', physicalCalls: 2 },
    { name: 'missing envelope', content: JSON.stringify(proposal()), physicalCalls: 2 },
    { name: 'extra envelope key', content: JSON.stringify({ result: proposal(), approved: true }), physicalCalls: 1 },
    { name: 'extra union key', content: JSON.stringify({ result: { ...proposal(), approved: true } }), physicalCalls: 1 },
    { name: 'incomplete revision', content: JSON.stringify({ result: { kind: 'revision' } }), physicalCalls: 1 },
  ]) await t.test(scenario.name, async () => {
    await withRevisionWireCapture(scenario.content, async (capture) => {
      const review = ports();
      const result = await proposeClarificationRevision(input, { ...review, complete: completeViaConfiguredBrain });
      assert.equal(result.status, 'unavailable');
      assert.equal(review.calls.length, 0, 'invalid wire data never reaches grounding or becomes a revision');
      assert.equal(capture.selectedModels.length, 1, 'no replacement proposal or brain fallback');
      assert.equal(capture.sdk.length, 1, 'the semantic port makes one SDK request');
      assert.equal(capture.backend.length, scenario.physicalCalls,
        'the existing BYO parse/shape repair allowance is measured separately from the single semantic proposal');
    });
  });
});

test('clarification wire leaves existing object-schema requests and results unenveloped', async () => {
  const raw = { verdict: 'uncertain', proposalDigest: 'a'.repeat(64) };
  await withRevisionWireCapture(JSON.stringify(raw), async (capture) => {
    const result = await completeViaConfiguredBrain({ purpose: 'turn_semantics_account_selection',
      schemaName: 'SourceAccountJudgeV1', system: 'Original object-schema instructions.', user: '{}' });
    assert.deepEqual(result.raw, raw);
    const schema = capture.sdk[0]?.response_format?.json_schema?.schema;
    assert.equal(schema?.type, 'object');
    assert.deepEqual(schema?.required, ['verdict', 'proposalDigest']);
    assert.ok(!Object.hasOwn(schema?.properties as object, 'result'));
    assert.equal(capture.sdk[0]?.messages?.find((item) => item.role === 'system')?.content,
      'Original object-schema instructions.');
    assert.equal(capture.selectedModels.length, 1);
    assert.equal(capture.backend.length, 1);
  });
});

test('clarification wire rejection retains unrecorded usage without double-counting recorded usage', async (t) => {
  const { Runner } = await import('@openai/agents');
  const { createSession, appendEvent, getSessionTokensUsed } = await import('../harness/eventlog.js');
  const { readUsageEventsForDate, recordModelUsage } = await import('../usage-log.js');
  for (const adapterRecords of [false, true]) await t.test(`adapter accounting=${adapterRecords}`, async () => {
    const session = createSession({ kind: 'chat' });
    const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
      data: { text: 'Keep the settled answers and clarify what remains.' } });
    const attemptId = `fixture-wire-rejection-${source.seq}`;
    const original = Runner.prototype.run;
    let selectedModel: string | undefined;
    let calls = 0;
    // Exercise the completion boundary with a reported result that did not
    // pass wire validation. No adapter/network call is needed for this seam.
    Runner.prototype.run = (async (agent: { model?: unknown }) => {
      calls++;
      selectedModel = String(agent.model);
      if (adapterRecords) recordModelUsage({ sessionId: 'unknown', model: selectedModel,
        cacheDialect: 'inclusive', inputTokens: 17, outputTokens: 5 });
      return { finalOutput: { result: { kind: 'revision' } },
        state: { usage: { inputTokens: 17, outputTokens: 5 } } };
    }) as unknown as typeof Runner.prototype.run;
    try {
      await withModelUsageAttribution({ sessionId: session.id, sourceUserSeq: source.seq, attemptId }, () =>
        assert.rejects(completeViaConfiguredBrain({ purpose: 'clarification_revision',
          system: 'fixture', user: '{}', schemaName: 'ClarificationRevisionV1' }),
        { name: 'ZodError' }));
    } finally { Runner.prototype.run = original; }
    const rows = readUsageEventsForDate().filter((row) => row.source === session.id);
    assert.equal(calls, 1, 'strict rejection cannot issue another proposal');
    assert.equal(rows.length, 1, 'rejected output still costs once, with or without adapter accounting');
    assert.equal(rows[0]?.model, selectedModel);
    assert.equal(rows[0]?.trace?.acceptedSource, `${session.id}:${source.seq}`);
    assert.equal(rows[0]?.trace?.attemptId, attemptId);
    assert.equal(rows[0]?.channel, 'semantic:clarification_revision');
    assert.equal(rows[0]?.role, undefined, 'semantic interpretation retains its existing undeclared usage role');
    assert.equal(rows[0]?.inputTokens, 17);
    assert.equal(rows[0]?.outputTokens, 5);
    assert.equal(getSessionTokensUsed(session.id), 22);
  });
});

test('residual adequacy keeps a definition-only reply incomplete and checks a full answer without granting execution', async () => {
  const question = 'What does the escalation label mean and when should it trigger?';
  const cases = [
    { reply: 'It means priority indicator.', noul: 0.04, expected: 'incomplete' },
    { reply: 'It means priority indicator. Trigger it when a callback is requested. Make the first batch exactly 18 notes.', noul: 0.99, expected: 'complete' },
  ];
  for (const scenario of cases) {
    const current = { ...input, sourceUserSeq: 42, deliveredQuestion: question, acceptedReply: scenario.reply };
    let calls = 0;
    const result = await checkClarificationAnswerCompleteness(current, async (posted) => {
      calls++;
      const state = posted.state as { acceptedReply: string; deliveredQuestion: string; rootTask: string };
      assert.equal(state.acceptedReply, current.acceptedReply);
      assert.equal(state.deliveredQuestion, question);
      assert.equal(state.rootTask, input.rootTask);
      assert.deepEqual(Object.keys(posted.questions), ['complete_answer']);
      assert.match(posted.questions.complete_answer!.instructions, /EVERY still-required decision/);
      assert.match(posted.questions.complete_answer!.instructions, /definition without its requested trigger is incomplete/);
      assert.match(posted.questions.complete_answer!.instructions, /Do not demand that the user repeat those settled facts/);
      assert.match(posted.questions.complete_answer!.instructions, /Do not select or mint a slot answer/);
      return { ok: true, model: 'fixture-served-jev', answers: { complete_answer: { type: 'noul', noul: scenario.noul } },
        usage: { input_tokens: 31, output_tokens: 1 }, decisionId: 'fixture-completeness-check' };
    });
    assert.equal(calls, 1);
    assert.equal(result.status, scenario.expected);
    if (result.status === 'unavailable') continue;
    assert.deepEqual(validatedClarificationAnswerCompleteness(current, result.receipt), result);
    assert.deepEqual(Object.keys(result.receipt).sort(), ['inputDigest', 'purpose', 'review', 'sourceDigest', 'version']);
    assert.equal(result.receipt.review.modelIdentity, 'fixture-served-jev');
  }
});

test('completeness replay binds exact input and distinguishes its proof from a question revision', async () => {
  const result = await checkClarificationAnswerCompleteness(input, async () => ({ ok: true,
    model: 'fixture-jev', answers: { complete_answer: { type: 'noul', noul: 0.99 } },
    usage: { input_tokens: 30, output_tokens: 1 }, decisionId: 'literal-completeness-check' }));
  assert.equal(result.status, 'complete');
  if (result.status === 'unavailable') return;
  for (const changed of [
    { ...input, sourceUserSeq: 42 }, { ...input, sessionId: 'another-owner' },
    { ...input, deliveredQuestion: 'Another required decision?' },
    { ...input, deliveredOptions: ['hidden option'] },
    { ...input, acceptedReply: 'A different accepted reply' },
    { ...input, rootTask: 'A different root task' },
  ]) assert.equal(validatedClarificationAnswerCompleteness(changed, result.receipt), null);
  for (const changed of [
    { ...result.receipt, review: undefined },
    { ...result.receipt, sourceDigest: 'a'.repeat(64) },
    { ...result.receipt, purpose: 'clarification_revision_v1' },
    { ...result.receipt, approved: true },
    { ...result.receipt, review: { ...result.receipt.review, noul: NaN } },
  ]) assert.equal(validatedClarificationAnswerCompleteness(input, changed), null);
  // A lower literal retained score cannot replay as complete, even if a
  // caller separately persists a purported complete status beside it.
  assert.equal(validatedClarificationAnswerCompleteness(input, { ...result.receipt,
    review: { ...result.receipt.review, noul: 0.8 } })?.status, 'incomplete');
  const revised = await proposeClarificationRevision(input, ports());
  if (revised.status === 'proposed') assert.equal(validatedClarificationAnswerCompleteness(input, revised.revision), null);
});

test('failed or invalid completeness review remains unavailable with one call and no repair', async () => {
  for (const reason of ['disabled', 'missing_key', 'timeout', 'malformed'] as const) {
    let calls = 0;
    assert.deepEqual(await checkClarificationAnswerCompleteness(input, async () => {
      calls++; return { ok: false, reason };
    }), { status: 'unavailable', reason: `review_${reason}` });
    assert.equal(calls, 1);
  }
  for (const noul of [NaN, Infinity, -0.1, 1.01]) {
    assert.deepEqual(await checkClarificationAnswerCompleteness(input, async () => ({ ok: true, model: 'fixture-jev',
      answers: { complete_answer: { type: 'noul', noul } }, usage: { input_tokens: 10, output_tokens: 1 } })),
    { status: 'unavailable', reason: 'review_invalid' });
  }
  assert.deepEqual(await checkClarificationAnswerCompleteness(input, async () => { throw new Error('private provider detail'); }),
    { status: 'unavailable', reason: 'review_unavailable' });
});

test('completeness rejects oversized exact inputs without calling Jev and attributes a valid call to its exact source', async () => {
  let called = 0;
  assert.deepEqual(await checkClarificationAnswerCompleteness({ ...input, acceptedReply: 'x'.repeat(8_001) }, async () => {
    called++; throw new Error('unreachable');
  }), { status: 'unavailable', reason: 'exact_input_out_of_bounds' });
  assert.equal(called, 0);
  await withModelUsageAttribution({ sessionId: 'unrelated-source', sourceUserSeq: 7, attemptId: 'unrelated-attempt' }, () =>
    checkClarificationAnswerCompleteness(input, async () => {
      const attribution = modelUsageAttributionStorage.getStore();
      assert.equal(attribution?.sessionId, input.sessionId);
      assert.equal(attribution?.sourceUserSeq, input.sourceUserSeq);
      assert.equal(attribution?.attemptId, undefined);
      return { ok: true, model: 'fixture-jev', answers: { complete_answer: { type: 'noul', noul: 0.99 } },
        usage: { input_tokens: 10, output_tokens: 1 } };
    }));
});


test('clarification diagnostics retain only source-bound failure facts from the actual SDK and BYO boundary', async (t) => {
  const { APIError } = await import('openai');
  const { _setQuickCheckDeadlineMsForTests } = await import('./configured-brain-semantic-port.js');
  for (const scenario of [
    { name: 'own deadline', kind: 'deadline', phase: 'sdk_run', returned: false, recorded: false,
      content: async (_request: Record<string, unknown>, options: unknown): Promise<unknown> => new Promise((_, reject) => {
        const signal = (options as { signal: AbortSignal }).signal;
        if (signal.aborted) reject(new Error('PRIVATE_ABORT_DETAIL'));
        else signal.addEventListener('abort', () => reject(new Error('PRIVATE_ABORT_DETAIL')), { once: true });
      }), calls: 1 },
    { name: 'provider status', kind: 'http_error', phase: 'sdk_run', returned: false, recorded: false,
      content: async (): Promise<unknown> => { throw new APIError(429, { message: 'PRIVATE_PROVIDER_BODY' }, 'PRIVATE_PROVIDER_DETAIL', new Headers()); }, calls: 1 },
    { name: 'forged status', kind: 'unknown', phase: 'sdk_run', returned: false, recorded: false,
      content: async (): Promise<unknown> => { throw Object.assign(new Error('PRIVATE_UNKNOWN'), { status: 401, name: 'APIError', diagnostic: { kind: 'deadline' } }); }, calls: 1 },
    { name: 'malformed JSON', kind: 'sdk_output_invalid', phase: 'sdk_output_validation', returned: false, recorded: true, content: '{PRIVATE_INVALID', calls: 2 },
    { name: 'invalid SDK shape', kind: 'sdk_output_invalid', phase: 'sdk_output_validation', returned: false, recorded: true,
      content: JSON.stringify({ result: { kind: 'revision', private: 'PRIVATE_SCHEMA' } }), calls: 1 },
  ]) await t.test(scenario.name, async () => {
    _setQuickCheckDeadlineMsForTests(scenario.name === 'own deadline' ? 50 : null);
    try {
      await withRevisionWireCapture(scenario.content, async (capture) => {
        const fixture = ports();
        const result = await withModelUsageAttribution({ sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq, attemptId: 'fixture-diagnostic-attempt' }, () =>
          proposeClarificationRevision(input, { ...fixture, complete: completeViaConfiguredBrain }));
        assert.equal(result.status, 'unavailable');
        const diagnostic = (result as { diagnostic?: Record<string, unknown> }).diagnostic;
        assert.deepEqual(diagnostic, {
          version: 1, sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq, attemptId: 'fixture-diagnostic-attempt',
          kind: scenario.kind, phase: scenario.phase, deadlineFired: scenario.name === 'own deadline',
          sdkRunStarted: true, sdkRunReturned: scenario.returned, usageRecordedAtFailure: scenario.recorded,
          ...(scenario.name === 'provider status' ? { httpStatus: 429 } : {}),
        });
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|APIError|stack|message|token|prompt/i);
        assert.equal(capture.sdk.length, 1, 'one semantic SDK invocation');
        assert.equal(capture.backend.length, scenario.calls, 'only the pre-existing bounded BYO repair allowance');
        assert.equal(capture.selectedModels.length, 1, 'no brain substitution or second semantic proposal');
        assert.equal(fixture.calls.length, 0, 'failed output cannot reach grounding');
      });
    } finally { _setQuickCheckDeadlineMsForTests(null); }
  });
});

test('clarification diagnostics distinguish final envelope validation and reject source or attempt reuse', async () => {
  const { Runner } = await import('@openai/agents');
  const original = Runner.prototype.run;
  let captured: unknown;
  let calls = 0;
  Runner.prototype.run = (async () => { calls++; return { finalOutput: { result: { kind: 'revision' } },
    state: { usage: { inputTokens: 17, outputTokens: 5 } } }; }) as unknown as typeof Runner.prototype.run;
  try {
    await withModelUsageAttribution({ sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq, attemptId: 'fixture-envelope-attempt' }, async () => {
      const fixture = ports();
      const result = await proposeClarificationRevision(input, { ...fixture, complete: async (request) => {
        try { return await completeViaConfiguredBrain(request); } catch (error) { captured = error; throw error; }
      } });
      assert.equal(result.status, 'unavailable');
      assert.deepEqual((result as { diagnostic?: unknown }).diagnostic, { version: 1, sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq, attemptId: 'fixture-envelope-attempt', kind: 'wire_envelope_invalid',
        phase: 'wire_envelope_validation', deadlineFired: false, sdkRunStarted: true, sdkRunReturned: true, usageRecordedAtFailure: true });
      assert.equal(fixture.calls.length, 0);
    });
    for (const scope of [
      { sessionId: 'other-session', sourceUserSeq: input.sourceUserSeq, attemptId: 'fixture-envelope-attempt' },
      { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq + 1, attemptId: 'fixture-envelope-attempt' },
      { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq, attemptId: 'other-attempt' },
    ]) {
      const result = await withModelUsageAttribution(scope, () => proposeClarificationRevision({ ...input,
        sessionId: scope.sessionId, sourceUserSeq: scope.sourceUserSeq }, { ...ports(), complete: async () => { throw captured; } }));
      assert.deepEqual(result, { status: 'unavailable', stage: 'proposal', reason: 'interpretation_unavailable' });
    }
    assert.equal(calls, 1);
  } finally { Runner.prototype.run = original; }
});

test('annotated clarification keeps literal public history separate and binds both texts to its receipts', async () => {
  const { clarificationReferenceDigest, renderClarificationUnavailable } = await import('../harness/clarification-public-annotation.js');
  const annotation = { version: 1 as const, kind: 'clarification_reading_unavailable' as const,
    sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq - 1, parentPacketId: 'fixture-parent',
    readingEventId: 'fixture-reading', referenceSha256: clarificationReferenceDigest(input.deliveredQuestion, input.deliveredOptions) };
  const annotated = { ...input, deliveredPublicQuestion: renderClarificationUnavailable(input.deliveredQuestion),
    deliveredQuestionAnnotation: annotation };
  const fixture = ports();
  const result = await proposeClarificationRevision(annotated, fixture);
  assert.equal(result.status, 'proposed');
  assert.equal(fixture.calls.length, 2);
  const request = fixture.calls[0]!.input as { user: string; system: string };
  const state = JSON.parse(request.user);
  assert.equal(state.deliveredPublicQuestion, annotated.deliveredPublicQuestion);
  assert.equal(state.deliveredQuestion, input.deliveredQuestion);
  assert.match(request.system, /not the entire public message/);
  const review = fixture.calls[1]!.input as { state: Record<string, unknown> };
  assert.equal(review.state.deliveredPublicQuestion, annotated.deliveredPublicQuestion);
  if (result.status !== 'proposed') return;
  assert.deepEqual(validatedClarificationRevision(annotated, result.revision), result.revision);
  assert.equal(validatedClarificationRevision(input, result.revision), null, 'annotation identity is part of exact revision binding');
  assert.equal(validatedClarificationRevision({ ...annotated, deliveredQuestionAnnotation: {
    ...annotation, readingEventId: 'other-reading' } }, result.revision), null);
  const checked = await checkClarificationAnswerCompleteness(annotated, async () => ({ ok: true, model: 'fixture-jev',
    answers: { complete_answer: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 2, output_tokens: 1 } }));
  assert.equal(checked.status, 'complete');
  if (checked.status === 'complete') assert.equal(validatedClarificationAnswerCompleteness(input, checked.receipt), null);
});

test('annotated clarification rejects mismatched public provenance without clipping or model calls', async () => {
  const { clarificationReferenceDigest, renderClarificationUnavailable, MAX_CLARIFICATION_PUBLIC_CHARS } = await import('../harness/clarification-public-annotation.js');
  const reference = 'Q'.repeat(3990) + ' LAST RULE';
  assert.equal(reference.length, 4000);
  const annotation = { version: 1 as const, kind: 'clarification_reading_unavailable' as const,
    sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq - 1, parentPacketId: 'fixture-parent',
    readingEventId: 'fixture-reading', referenceSha256: clarificationReferenceDigest(reference, []) };
  const annotated = { ...input, deliveredQuestion: reference, deliveredPublicQuestion: renderClarificationUnavailable(reference),
    deliveredQuestionAnnotation: annotation };
  assert.equal(annotated.deliveredPublicQuestion.length, MAX_CLARIFICATION_PUBLIC_CHARS);
  const fixture = ports({ kind: 'no_revision', reason: 'no_progress' });
  assert.equal((await proposeClarificationRevision(annotated, fixture)).status, 'no_revision');
  const captured = JSON.parse((fixture.calls[0]!.input as { user: string }).user);
  assert.equal(captured.deliveredQuestion, reference);
  assert.equal(captured.deliveredPublicQuestion, annotated.deliveredPublicQuestion);
  for (const changed of [
    { ...annotated, deliveredPublicQuestion: undefined },
    { ...annotated, deliveredQuestionAnnotation: undefined },
    { ...annotated, deliveredPublicQuestion: annotated.deliveredPublicQuestion + 'x' },
    { ...annotated, deliveredQuestion: reference + 'x' },
    { ...annotated, deliveredQuestionAnnotation: { ...annotation, sessionId: 'wrong' } },
    { ...annotated, deliveredQuestionAnnotation: { ...annotation, sourceUserSeq: input.sourceUserSeq } },
    { ...annotated, deliveredQuestionAnnotation: { ...annotation, referenceSha256: 'a'.repeat(64) } },
  ]) {
    const forbidden = ports();
    assert.deepEqual(await proposeClarificationRevision(changed, forbidden),
      { status: 'unavailable', stage: 'input', reason: 'exact_input_out_of_bounds' });
    assert.equal(forbidden.calls.length, 0);
  }
});

test('clarification diagnostic projection rejects arbitrary fields and inconsistent or coerced facts', async () => {
  const { validatedClarificationFailureDiagnostic } = await import('./clarification-failure-diagnostic.js');
  const source = { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq };
  const safe = { version: 1, ...source, kind: 'unknown', phase: 'sdk_run',
    deadlineFired: false, sdkRunStarted: true, sdkRunReturned: false };
  assert.deepEqual(validatedClarificationFailureDiagnostic(safe, source), safe);
  for (const bad of [
    { ...safe, message: 'PRIVATE_BODY' }, { ...safe, response: { content: 'PRIVATE_BODY' } },
    { ...safe, kind: { toString: () => 'unknown' } }, { ...safe, phase: ['sdk_run'] },
    { ...safe, sourceUserSeq: input.sourceUserSeq + 1 }, { ...safe, sessionId: 'foreign' },
    { ...safe, kind: 'deadline' }, { ...safe, deadlineFired: true },
    { ...safe, kind: 'http_error', httpStatus: 200 }, { ...safe, httpStatus: 429 },
    { ...safe, sdkRunReturned: true }, { ...safe, phase: 'model_selection' },
    { ...safe, kind: 'wire_envelope_invalid' }, { ...safe, kind: 'sdk_output_invalid' },
  ]) assert.equal(validatedClarificationFailureDiagnostic(bad, source), null);
});
