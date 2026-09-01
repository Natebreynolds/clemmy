/**
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/runtime/semantic-boundary/workflow-name-correction-continuation.test.ts
 *
 * Live 2026-08-31: the public question rendered visible shortcuts followed by
 * "Reply with a number or in your own words", but the semantic host snapshot
 * set allowFreeText=false solely because those shortcuts existed. The literal
 * correction "Sorry platform 49" was therefore classified ambiguous, the
 * durable A/Q/B packet stayed open, and the original run imperative was lost.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const PRIOR_HOME = process.env.CLEMENTINE_HOME;
const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-name-correction-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const eventlog = await import('../harness/eventlog.js');
const continuity = await import('../harness/task-continuity-runtime.js');
const taskContinuity = await import('../../memory/task-continuity.js');
const { commitTurnOutcome } = await import('../harness/delivery-committer.js');
const { turnOutcomeId } = await import('../harness/turn-outcome.js');
const { installTurnSemanticModelPort } = await import('./turn-semantic-port-registry.js');
const { typedClassificationFromLastInterpretation } = await import('./interpret-accepted-source.js');
const { snapshotFromAcceptedSource } = await import('./prepare-accepted-source.js');
const { primePrimaryModelPlanningCatalog } = await import('./admit-and-compile-accepted-source.js');
const { writeWorkflow } = await import('../../memory/workflow-store.js');
const { uniqueWorkflowRunRequest } = await import('../../tools/named-workflow-match.js');
const { tryHostDispatchNamedWorkflow } = await import('../harness/named-workflow-host-dispatch.js');
const {
  finalizePreparedWorkflowDispatchForSource,
  runConversation,
} = await import('../harness/loop.js');
const { exactOriginDeliveryTargetDigest } = await import('../exact-origin-delivery.js');
const { WORKFLOW_RUNS_DIR } = await import('../../tools/shared.js');

const PARENT = 'Run my platform 59 flow please';
const QUESTION = 'You asked me to run platform 59, but the exact saved workflow is platform-49-slack-channel-review. What should I do next?';
const OPTIONS = ['Show me its definition', 'Skip'];
const ANSWER = 'Sorry platform 49';
const REPLY_TARGET = { type: 'origin_chat' } as const;

test.after(() => {
  installTurnSemanticModelPort(null);
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
  if (PRIOR_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_HOME;
});

test('ordinary clarification shortcuts accept a bounded correction without granting option authority', async () => {
  writeWorkflow('platform-49-slack-channel-review', {
    name: 'Platform 49 Slack Channel Review',
    description: 'Review the Platform 49 Slack channel.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'main', prompt: 'Review the channel.' }],
  });
  writeWorkflow('team-activity-slack-updates', {
    name: 'Team Activity Slack Updates',
    description: 'Post a team update.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'main', prompt: 'Post the update.' }],
  });

  const session = eventlog.createSession({
    id: 'workflow-name-correction-continuation',
    kind: 'chat',
    channel: 'mobile',
    userId: 'workflow-correction-user',
  });
  const parentAttempt = eventlog.beginRunAttempt(session.id, { runId: 'workflow-correction-parent' });
  const parent = eventlog.recordRunAttemptUserInput(parentAttempt, {
    turn: 1,
    role: 'user',
    data: { text: PARENT, displayText: PARENT },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: parent.turn,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question: QUESTION,
      options: OPTIONS,
      purpose: 'clarification',
      sourceUserSeq: parent.seq,
    },
  });
  const parentIdentity = {
    sessionId: session.id,
    turn: parent.turn,
    sourceUserSeq: parent.seq,
  };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(parentIdentity),
    identity: parentIdentity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: QUESTION },
  });
  eventlog.finishRunAttempt(parentAttempt, 'completed');

  const open = taskContinuity.peekTaskContinuityPacket({ sessionId: session.id });
  assert.equal(open.status, 'available');
  if (open.status !== 'available') return;
  assert.deepEqual(open.packet.pause.options, OPTIONS);

  const answerAttempt = eventlog.beginRunAttempt(session.id, { runId: 'workflow-correction-answer' });
  const answer = eventlog.recordRunAttemptUserInput(answerAttempt, {
    turn: 2,
    role: 'user',
    data: {
      text: ANSWER,
      displayText: ANSWER,
      originReplyTarget: REPLY_TARGET,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(REPLY_TARGET),
    },
  });

  installTurnSemanticModelPort({
    async interpret(call) {
      const question = call.host.openQuestions[0];
      assert.ok(question, 'the exact durable clarification must reach the semantic host');
      assert.equal(question.question, QUESTION);
      assert.deepEqual(question.options.map((option) => option.label), OPTIONS);
      assert.equal(
        question.allowFreeText,
        true,
        'the semantic contract must match the delivered own-words promise',
      );
      return {
        raw: {
          version: 1,
          relation: 'answer_open_slot',
          targetGoal: {
            goalId: question.goalId,
            baseRevision: question.goalRevision,
          },
          goal: null,
          work: null,
          slotAnswers: [{
            kind: 'value',
            questionId: question.questionId,
            slotKey: question.slotKey,
            value: ANSWER,
          }],
          rationale: 'The user supplied a bounded correction to the open workflow-name slot.',
        },
        modelIdentity: 'deterministic-workflow-name-correction',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
  });

  const prepared = await continuity.prepareCheckedHostClarificationAnswer({
    sessionId: session.id,
    sourceUserSeq: answer.seq,
    turn: answer.turn,
    surface: 'home',
  });
  assert.equal(prepared, 'admitted');
  const typed = typedClassificationFromLastInterpretation(session.id, answer.seq);
  assert.deepEqual(typed, { disposition: 'provided' });

  const enriched = await continuity.enrichAcceptedRequestWithTaskContinuity({
    sessionId: session.id,
    sourceUserSeq: answer.seq,
    message: ANSWER,
  }, answer.seq, {
    continuationOnly: true,
    resolveCandidates: false,
    typedClassification: typed,
  });
  assert.equal(enriched.taskContinuation?.disposition, 'provided');
  assert.equal(enriched.taskContinuation?.selectedOption, undefined);
  assert.equal(enriched.taskContinuation?.parentInput, PARENT);
  assert.equal(enriched.taskContinuation?.question, QUESTION);
  assert.equal(enriched.taskContinuation?.answer, ANSWER);
  assert.match(enriched.semanticTaskInput ?? '', /\[parent-task\]\nRun my platform 59 flow please/);
  assert.match(enriched.semanticTaskInput ?? '', /\[user-answer\]\nSorry platform 49/);

  const consumed = taskContinuity.readConsumedTaskContinuityPacket({
    sessionId: session.id,
    consumingSourceUserSeq: answer.seq,
  });
  assert.equal(consumed.status, 'consumed');
  if (consumed.status === 'consumed') {
    assert.equal(consumed.resolution.disposition, 'provided');
    assert.equal(consumed.resolution.selectedOption, undefined);
  }
  assert.deepEqual(taskContinuity.peekTaskContinuityPacket({ sessionId: session.id }), { status: 'none' });

  const match = uniqueWorkflowRunRequest(enriched.semanticTaskInput);
  assert.ok(match, 'the checked A/Q/B semantic surface must retain enough identity to select the workflow');
  assert.equal(match?.slug, 'platform-49-slack-channel-review');
  assert.equal(match?.name, 'Platform 49 Slack Channel Review');

  const beforeModelRoutes = eventlog.listEvents(session.id, { types: ['turn_model_routed'] }).length;
  const dispatched = tryHostDispatchNamedWorkflow({
    sessionId: session.id,
    sourceUserSeq: answer.seq,
    userText: ANSWER,
    route: 'act',
  });
  assert.equal(dispatched.status, 'dispatched', JSON.stringify(dispatched));
  if (dispatched.status === 'dispatched') {
    assert.equal(dispatched.workflowName, 'Platform 49 Slack Channel Review');
    assert.ok(dispatched.runId);
  }
  assert.equal(
    existsSync(WORKFLOW_RUNS_DIR)
      ? readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json')).length
      : 0,
    1,
    'the consumed correction queues the exact workflow once through the shared host path',
  );
  assert.equal(
    eventlog.listEvents(session.id, { types: ['turn_model_routed'] }).length,
    beforeModelRoutes,
    'direct continuation dispatch spends no orchestrator model request',
  );
  assert.equal(
    eventlog.listEvents(session.id, { types: ['tool_called'] }).length,
    0,
    'the queue handoff invokes no provider tool',
  );
  assert.equal(
    eventlog.listEvents(session.id, { types: ['async_work_dispatch_prepared'] }).length,
    1,
    'the direct host edge prepares one exact source-bound queue handoff',
  );
  const finalized = finalizePreparedWorkflowDispatchForSource(session.id, answer.seq);
  assert.ok(finalized, 'the ordinary post-host reducer must publish the prepared handoff');
  assert.equal(
    eventlog.listEvents(session.id, { types: ['async_work_dispatched'] }).length,
    1,
    'the shared reducer records one exact workflow handoff without a model/provider call',
  );

  const unrelated = eventlog.createSession({
    id: 'workflow-name-correction-unconsumed',
    kind: 'chat',
    channel: 'mobile',
  });
  const unrelatedSource = eventlog.appendEvent({
    sessionId: unrelated.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: ANSWER,
      displayText: ANSWER,
      originReplyTarget: REPLY_TARGET,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(REPLY_TARGET),
    },
  });
  assert.deepEqual(tryHostDispatchNamedWorkflow({
    sessionId: unrelated.id,
    sourceUserSeq: unrelatedSource.seq,
    userText: ANSWER,
    route: 'act',
  }), {
    status: 'not_applicable',
    reason: 'typed_workflow_authority_required',
  });
  assert.equal(
    readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json')).length,
    1,
    'the same correction without an exact consumed packet grants no run authority',
  );
});

test('a low-level consumed provided row without an admitted semantic answer cannot queue a workflow', () => {
  writeWorkflow('platform-49-slack-channel-review', {
    name: 'Platform 49 Slack Channel Review',
    description: 'Review the Platform 49 Slack channel.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'main', prompt: 'Review the channel.' }],
  });
  const beforeRuns = existsSync(WORKFLOW_RUNS_DIR)
    ? readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json')).length
    : 0;
  const session = eventlog.createSession({
    id: 'workflow-name-correction-forged-consumption',
    kind: 'chat',
    channel: 'mobile',
  });
  const parent = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: PARENT, displayText: PARENT },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: { question: QUESTION, options: OPTIONS, purpose: 'clarification', sourceUserSeq: parent.seq },
  });
  const identity = { sessionId: session.id, turn: 1, sourceUserSeq: parent.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: QUESTION },
  });
  const answer = eventlog.appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: ANSWER, displayText: ANSWER },
  });
  const semanticInput = continuity.canonicalClarificationTaskInput({
    parentInput: PARENT,
    question: QUESTION,
    answer: ANSWER,
  });
  assert.ok(semanticInput);
  assert.equal(taskContinuity.consumeTaskContinuityPacket({
    sessionId: session.id,
    consumingSourceUserSeq: answer.seq,
    resolution: {
      resolverVersion: continuity.SEMANTIC_CLARIFICATION_RESOLVER_VERSION,
      disposition: 'provided',
      semanticInputHash: createHash('sha256').update(semanticInput!, 'utf8').digest('hex'),
    },
  }).status, 'consumed');
  assert.equal(
    eventlog.listEvents(session.id, { types: ['turn_semantics_interpreted'] }).length,
    0,
    'the low-level continuity store must not manufacture semantic authority',
  );
  assert.deepEqual(tryHostDispatchNamedWorkflow({
    sessionId: session.id,
    sourceUserSeq: answer.seq,
    userText: ANSWER,
    route: 'act',
  }), {
    status: 'not_applicable',
    reason: 'typed_workflow_authority_required',
  });
  assert.equal(
    existsSync(WORKFLOW_RUNS_DIR)
      ? readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json')).length
      : 0,
    beforeRuns,
  );
});

test('an ambiguous correction reoffers the exact question as an adjacent answerable successor', async () => {
  writeWorkflow('platform-49-slack-channel-review', {
    name: 'Platform 49 Slack Channel Review',
    description: 'Review the Platform 49 Slack channel.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'main', prompt: 'Review the channel.' }],
  });
  const session = eventlog.createSession({
    id: 'workflow-name-correction-reoffer',
    kind: 'chat',
    channel: 'mobile',
  });
  const parentAttempt = eventlog.beginRunAttempt(session.id, { runId: 'workflow-reoffer-parent' });
  const parent = eventlog.recordRunAttemptUserInput(parentAttempt, {
    turn: 1,
    role: 'user',
    data: { text: PARENT, displayText: PARENT },
  });
  const awaiting = eventlog.appendEvent({
    sessionId: session.id,
    turn: parent.turn,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: { question: QUESTION, options: OPTIONS, purpose: 'clarification', sourceUserSeq: parent.seq },
  });
  const parentIdentity = { sessionId: session.id, turn: parent.turn, sourceUserSeq: parent.seq };
  const parentTerminal = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(parentIdentity),
    identity: parentIdentity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: QUESTION },
  });
  eventlog.finishRunAttempt(parentAttempt, 'completed');
  const original = taskContinuity.peekTaskContinuityPacket({ sessionId: session.id });
  assert.equal(original.status, 'available');
  if (original.status !== 'available') return;
  assert.equal(original.packet.pause.question, QUESTION);
  assert.ok(awaiting.id && parentTerminal.event.id);

  const ambiguousText = 'Sorry platform';
  const ambiguousAttempt = eventlog.beginRunAttempt(session.id, { runId: 'workflow-reoffer-ambiguous' });
  const ambiguousSource = eventlog.recordRunAttemptUserInput(ambiguousAttempt, {
    turn: 2,
    role: 'user',
    data: {
      text: ambiguousText,
      displayText: ambiguousText,
      originReplyTarget: REPLY_TARGET,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(REPLY_TARGET),
    },
  });
  installTurnSemanticModelPort({
    async interpret(call) {
      const question = call.host.openQuestions[0];
      assert.ok(question);
      return {
        raw: {
          version: 1,
          relation: 'ambiguous',
          targetGoal: null,
          goal: null,
          work: null,
          slotAnswers: [],
          rationale: 'The correction is ambiguous and cannot nominate a unique goal.',
        },
        modelIdentity: 'deterministic-workflow-name-ambiguous',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
  });
  assert.equal(await continuity.prepareCheckedHostClarificationAnswer({
    sessionId: session.id,
    sourceUserSeq: ambiguousSource.seq,
    turn: ambiguousSource.turn,
    surface: 'home',
  }), 'admitted');
  const typed = typedClassificationFromLastInterpretation(session.id, ambiguousSource.seq);
  assert.deepEqual(typed, { keepOpen: true });
  const unresolved = await continuity.enrichAcceptedRequestWithTaskContinuity({
    sessionId: session.id,
    sourceUserSeq: ambiguousSource.seq,
    message: ambiguousText,
  }, ambiguousSource.seq, {
    continuationOnly: true,
    resolveCandidates: false,
    typedClassification: typed,
  });
  assert.equal(unresolved.taskContinuation, undefined);
  assert.deepEqual(tryHostDispatchNamedWorkflow({
    sessionId: session.id,
    sourceUserSeq: ambiguousSource.seq,
    userText: ambiguousText,
    route: 'act',
  }), { status: 'not_applicable', reason: 'typed_workflow_authority_required' });

  const unresolvedCatalog = await primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: ambiguousSource.seq,
  });
  assert.deepEqual(unresolvedCatalog, {
    ok: false,
    reason: 'durable accepted-source continuation is unresolved',
  });

  let agentBuilds = 0;
  const reoffered = await runConversation({
    sessionId: session.id,
    input: ambiguousText,
    sourceUserSeq: ambiguousSource.seq,
    reuseRecordedUserInput: true,
    turnEngine: 'host_v1',
    buildAgent: async () => {
      agentBuilds += 1;
      throw new Error('an unresolved clarification must stop before agent/model construction');
    },
  });
  assert.equal(reoffered.status, 'awaiting_user_input');
  assert.equal(agentBuilds, 0);
  const latestAwaiting = eventlog.listEvents(session.id, {
    types: ['awaiting_user_input'],
    desc: true,
    limit: 1,
  })[0];
  assert.equal(latestAwaiting?.data.question, QUESTION);
  assert.deepEqual(latestAwaiting?.data.options, OPTIONS);
  const successor = taskContinuity.peekTaskContinuityPacket({ sessionId: session.id });
  assert.equal(successor.status, 'available');
  if (successor.status !== 'available') return;
  assert.equal(successor.packet.originatingSourceUserSeq, ambiguousSource.seq);
  assert.equal(successor.packet.parentPacketId, original.packet.packetId);
  assert.equal(successor.packet.rootSourceUserSeq, parent.seq);
  assert.equal(successor.packet.pause.question, QUESTION);
  assert.deepEqual(successor.packet.pause.options, OPTIONS);
  assert.equal(
    eventlog.listEvents(session.id, { types: ['turn_model_routed', 'tool_called'] }).length,
    0,
    'reoffering the durable question spends neither an orchestrator model nor a provider call',
  );

  const correctedAttempt = eventlog.beginRunAttempt(session.id, { runId: 'workflow-reoffer-corrected' });
  const corrected = eventlog.recordRunAttemptUserInput(correctedAttempt, {
    turn: 3,
    role: 'user',
    data: { text: ANSWER, displayText: ANSWER },
  });
  installTurnSemanticModelPort({
    async interpret(call) {
      const question = call.host.openQuestions[0];
      assert.ok(question);
      return {
        raw: {
          version: 1,
          relation: 'answer_open_slot',
          targetGoal: { goalId: question!.goalId, baseRevision: question!.goalRevision },
          goal: null,
          work: null,
          slotAnswers: [{
            kind: 'value',
            questionId: question!.questionId,
            slotKey: question!.slotKey,
            value: ANSWER,
          }],
          rationale: 'The user supplied the exact corrected workflow identity.',
        },
        modelIdentity: 'deterministic-workflow-name-reoffer-correction',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
  });
  assert.equal(await continuity.prepareCheckedHostClarificationAnswer({
    sessionId: session.id,
    sourceUserSeq: corrected.seq,
    turn: corrected.turn,
    surface: 'home',
  }), 'admitted');
  const correctedTyped = typedClassificationFromLastInterpretation(session.id, corrected.seq);
  const resolved = await continuity.enrichAcceptedRequestWithTaskContinuity({
    sessionId: session.id,
    sourceUserSeq: corrected.seq,
    message: ANSWER,
  }, corrected.seq, {
    continuationOnly: true,
    resolveCandidates: false,
    typedClassification: correctedTyped,
  });
  assert.equal(resolved.taskContinuation?.disposition, 'provided');
  assert.equal(resolved.taskContinuation?.parentInput, PARENT);
  assert.equal(resolved.taskContinuation?.answer, ANSWER);
  assert.deepEqual(taskContinuity.peekTaskContinuityPacket({ sessionId: session.id }), { status: 'none' });
});

test('a legitimately new goal with open slots never clones the prior clarification', async () => {
  const session = eventlog.createSession({
    id: 'workflow-name-correction-new-goal',
    kind: 'chat',
    channel: 'mobile',
  });
  const parent = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: PARENT, displayText: PARENT },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: { question: QUESTION, options: OPTIONS, purpose: 'clarification', sourceUserSeq: parent.seq },
  });
  const identity = { sessionId: session.id, turn: 1, sourceUserSeq: parent.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: QUESTION },
  });
  const replacementText = 'Set up a new customer briefing instead';
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: replacementText, displayText: replacementText },
  });
  installTurnSemanticModelPort({
    async interpret() {
      return {
        raw: {
          version: 1,
          relation: 'new_goal',
          targetGoal: null,
          goal: {
            objective: replacementText,
            criteria: [{ id: 'briefing_ready', statement: 'The requested customer briefing is ready.' }],
            openSlots: [{
              slotKey: 'customer',
              question: 'Which customer is this briefing for?',
              options: [],
              allowFreeText: true,
            }],
            candidates: [],
          },
          work: null,
          slotAnswers: [],
          rationale: 'The user introduced a separate goal that needs one detail.',
        },
        modelIdentity: 'deterministic-workflow-new-goal',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
  });
  assert.equal(await continuity.prepareCheckedHostClarificationAnswer({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    surface: 'home',
  }), 'admitted');
  assert.deepEqual(typedClassificationFromLastInterpretation(session.id, source.seq), { keepOpen: true });
  assert.equal(continuity.unresolvedClarificationReofferForAcceptedSource({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }), null, 'new-goal open slots belong to the new goal and cannot reoffer the old workflow question');
});

test('exact terminal replay repairs a crash between public reoffer and successor persistence', async () => {
  const session = eventlog.createSession({
    id: 'workflow-name-correction-reoffer-replay',
    kind: 'chat',
    channel: 'mobile',
  });
  const parent = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: PARENT, displayText: PARENT },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: { question: QUESTION, options: OPTIONS, purpose: 'clarification', sourceUserSeq: parent.seq },
  });
  const parentIdentity = { sessionId: session.id, turn: 1, sourceUserSeq: parent.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(parentIdentity),
    identity: parentIdentity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: QUESTION },
  });
  const original = taskContinuity.peekTaskContinuityPacket({ sessionId: session.id });
  assert.equal(original.status, 'available');
  if (original.status !== 'available') return;

  const ambiguousText = 'Sorry platform';
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: ambiguousText, displayText: ambiguousText },
  });
  installTurnSemanticModelPort({
    async interpret(call) {
      const question = call.host.openQuestions[0];
      assert.ok(question);
      return {
        raw: {
          version: 1,
          relation: 'ambiguous',
          targetGoal: { goalId: question!.goalId, baseRevision: question!.goalRevision },
          goal: null,
          work: null,
          slotAnswers: [],
          rationale: 'The answer is not a unique workflow identity.',
        },
        modelIdentity: 'deterministic-workflow-reoffer-crash',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
  });
  assert.equal(await continuity.prepareCheckedHostClarificationAnswer({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    surface: 'home',
  }), 'admitted');
  const prepared = continuity.unresolvedClarificationReofferForAcceptedSource({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.ok(prepared);
  if (!prepared) return;
  const reask = eventlog.appendEvent({
    sessionId: session.id,
    turn: source.turn,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question: prepared.question,
      options: [...prepared.options],
      purpose: 'clarification',
      source: 'continuation_unresolved_reoffer',
      sourceUserSeq: source.seq,
      continuityParentPacketId: prepared.parentPacketId,
    },
  });
  const identity = { sessionId: session.id, turn: source.turn, sourceUserSeq: source.seq };
  const terminal = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: prepared.question },
  }, {
    legacyReason: 'awaiting_user_input',
    metadata: {
      steps: 0,
      reason: 'continuation_unresolved_reoffer',
      continuityParentPacketId: prepared.parentPacketId,
    },
  });
  assert.ok(reask.id && terminal.event.id);
  assert.equal(
    (taskContinuity.peekTaskContinuityPacket({ sessionId: session.id }) as { packet?: { packetId?: string } })
      .packet?.packetId,
    original.packet.packetId,
    'the simulated crash cut occurs before successor persistence',
  );

  let agentBuilds = 0;
  const replay = await runConversation({
    sessionId: session.id,
    input: ambiguousText,
    sourceUserSeq: source.seq,
    reuseRecordedUserInput: true,
    turnEngine: 'host_v1',
    buildAgent: async () => {
      agentBuilds += 1;
      throw new Error('exact terminal replay must not construct an agent');
    },
  });
  assert.equal(replay.status, 'awaiting_user_input');
  assert.equal(agentBuilds, 0);
  const repaired = taskContinuity.peekTaskContinuityPacket({ sessionId: session.id });
  assert.equal(repaired.status, 'available');
  if (repaired.status === 'available') {
    assert.equal(repaired.packet.originatingSourceUserSeq, source.seq);
    assert.equal(repaired.packet.parentPacketId, original.packet.packetId);
    assert.equal(repaired.packet.pause.question, QUESTION);
    assert.deepEqual(repaired.packet.pause.options, OPTIONS);
  }
});

test('a consumed free-text value cannot override the parent run with cancellation or management authority', () => {
  writeWorkflow('platform-49-slack-channel-review', {
    name: 'Platform 49 Slack Channel Review',
    description: 'Review the Platform 49 Slack channel.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'main', prompt: 'Review the channel.' }],
  });
  const beforeRuns = existsSync(WORKFLOW_RUNS_DIR)
    ? readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json')).length
    : 0;
  for (const [index, answerText] of [
    "Don't run platform 49",
    'Actually disable platform 49',
    'Show platform 49 definition',
  ].entries()) {
    const session = eventlog.createSession({
      id: `workflow-name-correction-conflict-${index}`,
      kind: 'chat',
      channel: 'mobile',
    });
    const parent = eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: PARENT, displayText: PARENT },
    });
    eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'Clem',
      type: 'awaiting_user_input',
      data: { question: QUESTION, options: OPTIONS, purpose: 'clarification', sourceUserSeq: parent.seq },
    });
    const identity = { sessionId: session.id, turn: 1, sourceUserSeq: parent.seq };
    commitTurnOutcome({
      version: 2,
      id: turnOutcomeId(identity),
      identity,
      status: 'needs_input',
      resumable: true,
      needs: { kind: 'input' },
      presentation: { kind: 'question', text: QUESTION },
    });
    const answer = eventlog.appendEvent({
      sessionId: session.id,
      turn: 2,
      role: 'user',
      type: 'user_input_received',
      data: {
        text: answerText,
        displayText: answerText,
        originReplyTarget: REPLY_TARGET,
        originReplyTargetDigest: exactOriginDeliveryTargetDigest(REPLY_TARGET),
      },
    });
    const semanticInput = continuity.canonicalClarificationTaskInput({
      parentInput: PARENT,
      question: QUESTION,
      answer: answerText,
    });
    assert.ok(semanticInput);
    const consumed = taskContinuity.consumeTaskContinuityPacket({
      sessionId: session.id,
      consumingSourceUserSeq: answer.seq,
      resolution: {
        resolverVersion: continuity.SEMANTIC_CLARIFICATION_RESOLVER_VERSION,
        disposition: 'provided',
        semanticInputHash: createHash('sha256').update(semanticInput!, 'utf8').digest('hex'),
      },
    });
    assert.equal(consumed.status, 'consumed');
    assert.deepEqual(tryHostDispatchNamedWorkflow({
      sessionId: session.id,
      sourceUserSeq: answer.seq,
      userText: answerText,
      route: 'act',
    }), {
      status: 'not_applicable',
      reason: 'typed_workflow_authority_required',
    }, answerText);
  }
  assert.equal(
    existsSync(WORKFLOW_RUNS_DIR)
      ? readdirSync(WORKFLOW_RUNS_DIR).filter((name) => name.endsWith('.json')).length
      : 0,
    beforeRuns,
    'B can correct identity but cannot negate or replace the parent action',
  );
});

test('free text does not widen approval/recovery gates or steal strategic meta actions', () => {
  const base = {
    sessionId: 'snapshot-only',
    sourceUserSeq: 1,
    acceptedText: ANSWER,
    audienceKey: 'audience',
    userId: 'user',
    conversationKey: 'conversation',
    policyRevision: '1'.repeat(64),
  };
  for (const kind of ['approval', 'recovery'] as const) {
    const snapshot = snapshotFromAcceptedSource({
      ...base,
      packet: {
        kind,
        question: 'Choose the exact control.',
        options: ['Approve', 'Reject'],
        originatingSourceUserSeq: 1,
      },
    });
    assert.equal(snapshot.openQuestions[0]?.allowFreeText, false, kind);
  }

  const clarification = snapshotFromAcceptedSource({
    ...base,
    packet: {
      kind: 'clarification',
      question: 'How should I continue?',
      options: ['Explain this recommendation', 'Customize it'],
      optionIntents: [
        { optionIndex: 0, action: 'explain' },
        { optionIndex: 1, action: 'customize' },
      ],
      originatingSourceUserSeq: 1,
    },
  });
  assert.equal(clarification.openQuestions[0]?.allowFreeText, true);
  assert.deepEqual(
    clarification.openQuestions[0]?.options.map((option) => option.metaAction),
    ['explain', 'customize'],
    'meta authority remains attached only to exact visible option ids',
  );
});
