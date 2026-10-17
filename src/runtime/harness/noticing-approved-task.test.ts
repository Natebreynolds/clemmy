import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { NoticingApprovedTaskPacket } from './noticing-approved-task.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-approved-noticing-task-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const log = await import('./eventlog.js');
const approved = await import('./noticing-approved-task.js');
const host = await import('./host-turn-runner.js');
const bridge = await import('./respond-bridge.js');
const outcomes = await import('./turn-outcome.js');
test.afterEach(() => bridge._setBridgeImplsForTests({}));
test.after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });
let sequence = 0;

function accepted() {
  const id = `noticing-context-${++sequence}`;
  const packet: NoticingApprovedTaskPacket = {
    version: 1,
    proposal: { id, checkInId: `chk-${id}`, title: 'Draft a controlled comparison',
      action: 'Read both controlled sources and save a draft comparison without sending it.',
      why: 'A prior source contradicts the amount; do not pick a winner without evidence.',
      evidence: ['source A: amount claimed', 'source B: contrary evidence; amount unknown'], goalId: 'fixture-goal',
      createdAt: '2026-10-16T00:00:00Z' },
    checkIn: { id: `chk-${id}`, question: 'Shall I draft the comparison?', contextSummary: `noticing:${id}`,
      answer: 'Yes — use my existing account.\nKeep the amount unknown; do not send anything.',
      answeredAt: '2026-10-16T00:01:00Z' },
    decision: { kind: 'do_it', instruction: 'Preserve both sources.' },
    constraints: { rules: ['Never substitute another provider or account.'],
      standingAnswers: [{ text: 'Do not send these drafts automatically.', about: 'draft comparisons', at: '2026-10-15T00:00:00Z' }] },
    goal: { id: 'fixture-goal', title: 'Compare the controlled sources', blockers: ['Amount remains unknown'] },
  };
  const digest = approved.noticingApprovedTaskDigest(packet);
  const requestId = `request:${id}`;
  const runId = `run:${id}`;
  const session = log.createSession({ id, kind: 'chat', channel: 'desktop' });
  const source = log.withEventPublicationTransaction(() => {
    log.claimHarnessChatRequestInTransaction(log.openEventLog(), { requestId, runId,
      sessionId: session.id, sinceSeq: 0, inputHash: digest });
    return log.acceptUserInputForRun({ sessionId: session.id, turn: 1, role: 'user', data: {
      text: packet.checkIn.answer, displayText: packet.checkIn.answer, runId, source: 'noticing_answer',
      noticingApprovedTask: { requestId, digest, packet },
    } });
  });
  return { session, source, packet, requestId, runId,
    identity: { sessionId: session.id, sourceUserSeq: source.seq } };
}

test('approved noticing task actual bridge and Jev objective consume the same complete frozen task across reopen', async () => {
  const f = accepted();
  let delivered: { input?: string; continuationSteer?: string; sourceUserSeq?: number; judgeCompletion?: boolean } | undefined;
  bridge._setBridgeImplsForTests({
    resolveTurnCandidates: (async () => ({ candidates: [], requirements: [], matches: [], pinnedTools: [], semanticApplied: false })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (input: { sessionId: string; sourceUserSeq: number; input: string; continuationSteer?: string; judgeCompletion?: boolean }) => {
      delivered = input;
      const identity = { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq, turn: 1 };
      return { sessionId: input.sessionId, status: 'completed', steps: 0, lastTurn: 1,
        publicPresentation: outcomes.presentationEventForOutcome({ version: 2, id: outcomes.turnOutcomeId(identity),
          identity, status: 'done', resumable: false, presentation: { kind: 'answer', text: 'Controlled fixture response.' } }) };
    }) as never,
  });
  await bridge.respondViaHarness('home', { sessionId: f.session.id, sourceUserSeq: f.source.seq,
    runId: f.runId, message: f.packet.checkIn.answer }, { turnEngine: 'host_v1', modelOverride: 'gpt-5.4' });
  assert.equal(delivered?.judgeCompletion, true, 'owner-approved proactive tasks retain normal chat completion review');
  assert.equal(delivered?.input, f.packet.checkIn.answer, 'the human message remains exact');
  assert.match(delivered?.continuationSteer ?? '', /Read both controlled sources and save a draft/);
  assert.match(delivered?.continuationSteer ?? '', /contrary evidence/);
  assert.match(delivered?.continuationSteer ?? '', /Never substitute another provider or account/);
  const objective = host.acceptedObjectiveForSource(f.identity)!;
  assert.match(objective, /Read both controlled sources and save a draft/);
  assert.match(objective, /Keep the amount unknown; do not send anything/);
  assert.match(objective, /Do not send these drafts automatically/);
  assert.match(objective, /Amount remains unknown/);
  const expected = approved.readAcceptedNoticingTask(f.identity);
  log.closeEventLog();
  assert.deepEqual(approved.readAcceptedNoticingTask(f.identity), expected);
  assert.equal(host.acceptedObjectiveForSource(f.identity), objective);
  assert.equal(log.listEvents(f.session.id, { types: ['user_input_received'] }).length, 1);
});

test('approved noticing task rejects changed proposal, answer, run and request bindings instead of judging bare yes', () => {
  for (const change of ['proposal', 'answer', 'run', 'receipt'] as const) {
    const f = accepted();
    const data = structuredClone(f.source.data);
    const binding = data.noticingApprovedTask as { packet: NoticingApprovedTaskPacket; requestId: string };
    if (change === 'proposal') binding.packet.proposal.action = 'Send it to a different destination.';
    if (change === 'answer') data.text = 'Yes, send it.';
    if (change === 'run') data.runId = 'foreign-run';
    if (change === 'receipt') binding.requestId = 'missing-request';
    log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?').run(JSON.stringify(data), f.source.id);
    assert.throws(() => approved.readAcceptedNoticingTask(f.identity), /approved suggestion/);
    assert.equal(host.acceptedObjectiveForSource(f.identity), null, 'invalid context cannot become a bare-answer success objective');
  }
});

test('approved noticing task a copied packet on a later source cannot claim the original request', () => {
  const f = accepted();
  const later = log.appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received',
    data: structuredClone(f.source.data) });
  assert.throws(() => approved.readAcceptedNoticingTask({ sessionId: f.session.id, sourceUserSeq: later.seq }), /retained answer and task/);
  assert.ok(approved.readAcceptedNoticingTask(f.identity));
  const ordinary = log.appendEvent({ sessionId: f.session.id, turn: 3, role: 'user', type: 'user_input_received',
    data: { text: 'A different task does not inherit approval.' } });
  assert.equal(approved.readAcceptedNoticingTask({ sessionId: f.session.id, sourceUserSeq: ordinary.seq }), null);
});

test('approved noticing task malformed or synthetic context has no task authority', () => {
  for (const mutation of [{ synthetic: true }, { noticingApprovedTask: { packet: { version: 1 } } }, { source: 'outcome' }]) {
    const f = accepted();
    log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...f.source.data, ...mutation }), f.source.id);
    assert.throws(() => approved.readAcceptedNoticingTask(f.identity), /approved suggestion/);
  }
});

test('approved noticing task verified clarification keeps the whole proposal and a decline does not inherit it', async () => {
  const continuity = await import('./task-continuity-runtime.js');
  const { commitTurnOutcome } = await import('./delivery-committer.js');
  for (const decline of [false, true]) {
    const f = accepted();
    const question = 'Which existing folder should receive the draft?';
    const options = ['Existing fixture folder A', 'Existing fixture folder B'];
    log.appendEvent({ sessionId: f.session.id, turn: 1, role: 'Clem', type: 'awaiting_user_input',
      data: { sourceUserSeq: f.source.seq, question, options } });
    const identity = { ...f.identity, turn: 1 };
    commitTurnOutcome({ version: 2, id: outcomes.turnOutcomeId(identity), identity, status: 'needs_input',
      resumable: true, needs: { kind: 'input' }, presentation: { kind: 'question', text: question } });
    const answer = decline ? 'Never mind' : options[0]!;
    const source = log.acceptUserInputForRun({ sessionId: f.session.id, turn: 2, role: 'user', data: { text: answer } });
    const request = await continuity.enrichAcceptedRequestWithTaskContinuity({ sessionId: f.session.id,
      channel: 'desktop', message: answer }, source.seq, { continuationOnly: true,
      typedClassification: decline ? { disposition: 'declined' } : { disposition: 'selected', selectedOption: options[0]! } });
    assert.equal(request.taskContinuation?.parentSourceUserSeq, f.source.seq);
    assert.equal(request.taskContinuation?.disposition, decline ? 'declined' : 'selected');
    const objective = host.acceptedObjectiveForSource({ sessionId: f.session.id, sourceUserSeq: source.seq }) ?? '';
    if (decline) assert.doesNotMatch(objective, /\[approved-noticing-task:v1\]/);
    else {
      assert.match(objective, /Read both controlled sources and save a draft/);
      assert.match(objective, /Never substitute another provider or account/);
      assert.match(objective, /Existing fixture folder A/);
      log.closeEventLog();
      assert.equal(host.acceptedObjectiveForSource({ sessionId: f.session.id, sourceUserSeq: source.seq }), objective);

      // Q1 is already consumed when the task asks a genuinely new Q2. The
      // existing capsule deliberately roots that question at B1, not A.
      const secondQuestion = 'How should the conflicting amount appear in the draft?';
      const secondOptions = ['Keep the amount unknown', 'Use the claimed amount'];
      log.appendEvent({ sessionId: f.session.id, turn: source.turn, role: 'Clem', type: 'awaiting_user_input',
        data: { sourceUserSeq: source.seq, question: secondQuestion, options: secondOptions } });
      const secondIdentity = { sessionId: f.session.id, sourceUserSeq: source.seq, turn: source.turn };
      commitTurnOutcome({ version: 2, id: outcomes.turnOutcomeId(secondIdentity), identity: secondIdentity,
        status: 'needs_input', resumable: true, needs: { kind: 'input' },
        presentation: { kind: 'question', text: secondQuestion } });
      const secondAnswer = log.acceptUserInputForRun({ sessionId: f.session.id, turn: 3, role: 'user',
        data: { text: secondOptions[0] } });
      const secondRequest = await continuity.enrichAcceptedRequestWithTaskContinuity({ sessionId: f.session.id,
        channel: 'desktop', message: secondOptions[0]! }, secondAnswer.seq, { continuationOnly: true,
        typedClassification: { disposition: 'selected', selectedOption: secondOptions[0]! } });
      assert.equal(secondRequest.taskContinuation?.parentSourceUserSeq, source.seq, 'actual sequential Q2 roots at B1');
      const secondObjective = host.acceptedObjectiveForSource({ sessionId: f.session.id, sourceUserSeq: secondAnswer.seq }) ?? '';
      assert.match(secondObjective, /Read both controlled sources and save a draft/);
      assert.match(secondObjective, /Which existing folder should receive the draft/);
      assert.match(secondObjective, /Existing fixture folder A/);
      assert.match(secondObjective, /How should the conflicting amount appear/);
      assert.match(secondObjective, /Keep the amount unknown/);
      assert.match(secondObjective, /Never substitute another provider or account/);
      const restored = approved.readNoticingTaskThroughVerifiedClarifications({ sessionId: f.session.id,
        sourceUserSeq: secondAnswer.seq }, continuity.rehydrateConsumedClarificationContext);
      assert.match(restored?.context ?? '', /Existing fixture folder A/);
      log.closeEventLog();
      assert.equal(host.acceptedObjectiveForSource({ sessionId: f.session.id, sourceUserSeq: secondAnswer.seq }), secondObjective);
      assert.throws(() => approved.readNoticingTaskThroughVerifiedClarifications({ sessionId: f.session.id,
        sourceUserSeq: secondAnswer.seq }, input => {
          const context = continuity.rehydrateConsumedClarificationContext(input);
          return context ? { ...context, parentSourceUserSeq: input.sourceUserSeq } : null;
        }), /parent is inconsistent/);
      const tampered = structuredClone(f.source.data);
      (tampered.noticingApprovedTask as { packet: NoticingApprovedTaskPacket }).packet.proposal.action = 'A different task.';
      log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?').run(JSON.stringify(tampered), f.source.id);
      assert.equal(host.acceptedObjectiveForSource({ sessionId: f.session.id, sourceUserSeq: source.seq }), null);
      assert.equal(host.acceptedObjectiveForSource({ sessionId: f.session.id, sourceUserSeq: secondAnswer.seq }), null);
    }
  }
});

test('approved noticing task checked partial-answer chain keeps earlier account target and no-send restrictions', async () => {
  const continuity = await import('./task-continuity-runtime.js');
  const store = await import('../../memory/task-continuity.js');
  const revision = await import('../semantic-boundary/clarification-revision.js');
  const { commitTurnOutcome } = await import('./delivery-committer.js');
  const { reofferUnresolvedAcceptedSourceClarification } = await import('./loop.js');
  const f = accepted();
  const question = 'Which account and target folder should I use? What is the report marker?';
  const partialText = 'Use the existing fixture account and folder A only; never switch account or send. I will supply the marker next.';
  const residual = 'What is the report marker?';
  function reading(source: typeof f.source, raw: Record<string, unknown>, valid = true) {
    log.openEventLog().prepare(`INSERT OR REPLACE INTO turn_semantics_dispositions
      (session_id, source_user_seq, participation, outcome, created_at) VALUES (?, ?, 'participated', ?, ?)`)
      .run(f.session.id, source.seq, valid ? 'admitted' : 'blocked', new Date().toISOString());
    const event = log.appendEvent({ sessionId: f.session.id, turn: source.turn, role: 'system', type: 'turn_semantics_interpreted',
      data: { purpose: 'turn_semantics', sourceUserSeq: source.seq, inputHash: 'a', audienceHash: 'b',
        policyRevision: 'c', validationOutcome: valid ? 'admitted' : 'invalid', raw } });
    log.openEventLog().prepare(`INSERT INTO turn_semantics_claims
      (session_id, source_user_seq, owner, created_at, event_id, input_hash, audience_hash, policy_revision)
      VALUES (?, ?, 'fixture', ?, ?, 'a', 'b', 'c')`).run(f.session.id, source.seq, new Date().toISOString(), event.id);
  }
  log.appendEvent({ sessionId: f.session.id, turn: 1, role: 'Clem', type: 'awaiting_user_input',
    data: { sourceUserSeq: f.source.seq, question, options: [] } });
  const identity = { ...f.identity, turn: 1 };
  commitTurnOutcome({ version: 2, id: outcomes.turnOutcomeId(identity), identity, status: 'needs_input',
    resumable: true, needs: { kind: 'input' }, presentation: { kind: 'question', text: question } });
  const partial = log.acceptUserInputForRun({ sessionId: f.session.id, turn: 2, role: 'user', data: { text: partialText } });
  reading(partial, { version: 1, relation: 'ambiguous', targetGoal: null, goal: null, work: null, slotAnswers: [] }, false);
  continuity._setOpenQuestionReplyClassifierForTests(async () => ({ kind: 'answers', confidence: 0.99, failedOpen: false }));
  continuity._setClarificationRevisionProposerForTests(input => revision.proposeClarificationRevision(input, {
    complete: async () => ({ raw: { kind: 'revision',
      acknowledgment: 'I kept the existing fixture account, folder A, and no-send restriction.', question: residual, options: [],
      decisions: [
        { id: 'binding', questionQuote: 'Which account and target folder should I use?', disposition: 'answered',
          claim: 'Existing fixture account and folder A only; no switching or sending.',
          replyQuote: 'Use the existing fixture account and folder A only; never switch account or send.', residualQuote: null },
        { id: 'marker', questionQuote: 'What is the report marker?', disposition: 'unresolved', claim: null,
          replyQuote: null, residualQuote: residual },
      ] }, modelIdentity: 'fixture-reader', inputTokens: 1, outputTokens: 1, latencyMs: 1, usageRecorded: true }),
    evaluate: async () => ({ ok: true, model: 'fixture-checker', answers: { grounded_revision: { type: 'noul', noul: 0.99 } },
      usage: { input_tokens: 1, output_tokens: 1 }, decisionId: 'fixture-grounding' }),
  }));
  continuity._setClarificationAnswerCompletenessForTests(input => revision.checkClarificationAnswerCompleteness(input, async () => ({
    ok: true, model: 'fixture-checker', answers: { complete_answer: { type: 'noul', noul: input.acceptedReply === partialText ? 0.05 : 0.99 } },
    usage: { input_tokens: 1, output_tokens: 1 }, decisionId: 'fixture-completeness',
  })));
  try {
    assert.equal((await continuity.classifyUnsettledOpenQuestionReply({ sessionId: f.session.id, sourceUserSeq: partial.seq }))?.route, 'revise');
    assert.equal(reofferUnresolvedAcceptedSourceClarification({ sessionId: f.session.id, sourceUserSeq: partial.seq,
      turn: partial.turn })?.status, 'awaiting_user_input');
    const pending = store.peekTaskContinuityPacket({ sessionId: f.session.id });
    assert.equal(pending.status, 'available');
    if (pending.status !== 'available') return;
    assert.equal(pending.packet.rootSourceUserSeq, f.source.seq);
    const finalText = 'Use the marker FIXTURE-ONLY.';
    const final = log.acceptUserInputForRun({ sessionId: f.session.id, turn: 3, role: 'user', data: { text: finalText } });
    const slot = pending.packet.pause.slot!;
    reading(final, { version: 1, relation: 'answer_open_slot', targetGoal: { goalId: slot.goalId, baseRevision: slot.revision },
      goal: null, work: null, slotAnswers: [{ kind: 'value', questionId: slot.questionId, slotKey: slot.slotKey, value: finalText }] });
    assert.equal((await continuity.classifyUnsettledOpenQuestionReply({ sessionId: f.session.id, sourceUserSeq: final.seq }))?.route, 'settled');
    const resolved = await continuity.enrichAcceptedRequestWithTaskContinuity({ sessionId: f.session.id, message: finalText }, final.seq,
      { continuationOnly: true, resolveCandidates: false, typedClassification: { disposition: 'provided' } });
    assert.equal(resolved.taskContinuation?.parentSourceUserSeq, f.source.seq, 'the verified chain jumps straight to A');
    assert.match(resolved.taskContinuation?.parentInput ?? '', /never switch account or send/);
    const source = { sessionId: f.session.id, sourceUserSeq: final.seq };
    const task = approved.readNoticingTaskThroughVerifiedClarifications(source, continuity.rehydrateConsumedClarificationContext);
    assert.ok(task?.context.includes(partialText), 'earlier literal amendments survive the direct-root jump');
    const objective = host.acceptedObjectiveForSource(source)!;
    assert.match(objective, /Read both controlled sources and save a draft/);
    assert.match(objective, /existing fixture account and folder A only; never switch account or send/);
    assert.match(objective, /FIXTURE-ONLY/);
    log.closeEventLog();
    assert.equal(host.acceptedObjectiveForSource(source), objective);
  } finally {
    continuity._setOpenQuestionReplyClassifierForTests(null);
    continuity._setClarificationRevisionProposerForTests(null);
    continuity._setClarificationAnswerCompletenessForTests(null);
  }
});
