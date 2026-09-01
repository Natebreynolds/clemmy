/**
 * Exact Q/B strategic-continuation regressions for the north-star Workspace
 * journey. Literal meta choices travel through the configured semantic-model
 * adapter, checked proposal admission, durable graph projection, and the real
 * host question tool. No test injects keepOpen/provided classifications.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/journeys/northstar-strategic-meta-continuations.host-e2e.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-northstar-meta-host-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_TOOL_JIT = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_BRAIN_FALLOVER = 'off';
process.env.CLEMMY_AUTH_FALLOVER = 'off';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-northstar-meta-host\n', 'utf8');

const PROMPT = 'Hey Clem can you scape the top recent news about local LLM processing and help me write a content calendar and 5 social post using the marketing skills. Drop all this in a workspace so i can see it.';
const QUESTION = 'I recommend a practical, credible series for technical builders: LinkedIn + X, five posts across three weeks, focused on local-LLM product decisions. A) Accept this direction  Q) Explain the rationale  B) Customize audience, channels, voice, or cadence.';
const OPTIONS = Object.freeze([
  'A) Accept this direction',
  'Q) Explain the rationale',
  'B) Customize audience, channels, voice, or cadence',
]);
const RATIONALE_REASK = 'This direction keeps the topic useful rather than trend-chasing: technical builders can act on concrete privacy, latency, fallback, and evaluation tradeoffs; LinkedIn supports the fuller evidence, while X carries the sharp takeaway. A) Accept this direction  Q) Explain the rationale  B) Customize audience, channels, voice, or cadence.';
const CUSTOM_QUESTION = 'Tell me your preferred audience, channels, voice, and cadence in one reply. For example: audience = IT leaders; channels = LinkedIn; voice = evidence-led; cadence = 3/week for 3 weeks.';
const CUSTOM_DETAILS = 'audience = IT leaders; channels = LinkedIn; voice = evidence-led; cadence = 3/week for 3 weeks';

const eventlog = await import('../runtime/harness/eventlog.js');
const continuity = await import('../runtime/harness/task-continuity-runtime.js');
const taskContinuity = await import('../memory/task-continuity.js');
const semanticInterpretation = await import('../runtime/semantic-boundary/interpret-accepted-source.js');
const semanticPorts = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const configuredSemantic = await import('../runtime/semantic-boundary/configured-brain-semantic-port.js');
const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const capabilityManifestStores = await import('../runtime/harness/capability-manifest-store.js');
const { buildOrchestratorAgent } = await import('../agents/orchestrator.js');
const { runTurn } = await import('../runtime/harness/loop.js');
const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
const { presentationEventFromCompletionData, turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');

after(() => {
  semanticPorts.installTurnSemanticModelPort(null);
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  capabilityManifestStores.installCapabilityManifestStore(null);
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

function functionCall(callId: string, name: string, args: Record<string, unknown>) {
  return { type: 'function_call', callId, name, arguments: JSON.stringify(args) };
}

async function* modelStream(
  this: { getResponse: (request: unknown) => Promise<Record<string, unknown>> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = Array.isArray(response.output) ? response.output : [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: { type: 'finish', finishReason: output.some((item) => item.type === 'function_call') ? 'tool_calls' : 'stop' },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as never;
}

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('the legacy SDK runner must remain unreachable');
  };
  return runner;
}

function toolsOn(request: unknown): string[] {
  return ((request as { tools?: Array<{ name?: string }> }).tools ?? [])
    .map((tool) => tool.name ?? '')
    .filter(Boolean);
}

async function askThroughHost(input: {
  sessionId: string;
  source: { seq: number; turn: number };
  userInput: string;
  semanticSteer?: string;
  question: string;
  options: readonly string[];
  history: readonly unknown[];
  callId: string;
  expectedMetaAction?: MetaAction;
}): Promise<ReturnType<typeof continuity.persistCommittedClarificationContinuity>> {
  let modelCalls = 0;
  const model = {
    async getResponse(request: unknown) {
      modelCalls += 1;
      assert.equal(modelCalls, 1);
      const tools = toolsOn(request);
      const serialized = JSON.stringify(request);
      assert.ok(tools.includes('ask_user_question'));
      assert.equal(tools.some((name) => (
        name === 'work_call' || name === 'composio_execute_tool' || name === 'space_save'
      )), false, 'a strategy-only turn exposes no research or write carrier');
      if (input.expectedMetaAction) {
        const modelItems = ((request as { input?: Array<{ role?: string; content?: unknown }> }).input ?? []);
        const textOf = (item: { content?: unknown }): string => typeof item.content === 'string'
          ? item.content
          : JSON.stringify(item.content ?? '');
        const literalUserItems = modelItems.filter((item) => (
          item.role === 'user' && textOf(item) === input.userInput
        ));
        assert.equal(literalUserItems.length, 1,
          'the byte-exact literal Q/B remains the one current user item');
        const systemMaterial = modelItems.filter((item) => item.role === 'system').map(textOf).join('\n');
        const userMaterial = modelItems.filter((item) => item.role === 'user').map(textOf).join('\n');
        assert.match(systemMaterial, /\[task-continuation-meta:v1\]/,
          'the admitted meta discriminator reaches the provider only as transient system material');
        assert.doesNotMatch(userMaterial, /\[task-continuation-meta:v1\]/,
          'the private capsule never replaces or contaminates user-authored history');
        assert.match(systemMaterial, /\[task-continuation-meta:v1\]/);
        assert.match(systemMaterial, new RegExp(`\\[meta-action\\]\\n${input.expectedMetaAction}`));
        assert.match(systemMaterial, /scape the top recent news/i,
          'the checked meta directive carries the original root objective to the host model');
        assert.match(systemMaterial, input.expectedMetaAction === 'explain'
          ? /reoffer the same exact visible options/i
          : /audience, channels, voice, and cadence/i);
      }
      return {
        responseId: `${input.callId}-response`,
        output: [functionCall(input.callId, 'ask_user_question', {
          question: input.question,
          options: [...input.options],
          purpose: 'clarification',
        })],
      };
    },
    getStreamedResponse: modelStream,
  };
  const agent = await buildOrchestratorAgent({
    userInput: input.userInput,
    sessionId: input.sessionId,
    sourceUserSeq: input.source.seq,
    allowedToolNames: ['ask_user_question'],
    allowToolJit: true,
    mcpToolScope: {
      authority: 'none', reason: 'strategy question performs no external work',
      allowedServerSlugs: [], toolPatterns: [], maxTools: 0,
    },
    model: model as never,
  });
  const outcome = await runTurn({
    agent: agent as never,
    sessionId: input.sessionId,
    input: input.userInput,
    ...(input.semanticSteer
      ? {
          semanticTaskInput: input.semanticSteer,
          continuationSteer: input.semanticSteer,
        }
      : {}),
    sourceUserSeq: input.source.seq,
    reuseRecordedUserInput: true,
    turnEngine: 'host_v1',
    maxTurns: 2,
    makeRunner: throwingRunner as never,
  });
  assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
  assert.match(String(outcome.finalOutput), /awaiting-user-input:final/);
  const terminal = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId({
      sessionId: input.sessionId,
      turn: input.source.turn,
      sourceUserSeq: input.source.seq,
    }),
    identity: {
      sessionId: input.sessionId,
      turn: input.source.turn,
      sourceUserSeq: input.source.seq,
    },
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: input.question },
  });
  return continuity.persistCommittedClarificationContinuity({
    terminalEvent: terminal.event,
    presentation: terminal.presentation,
  });
}

type MetaAction = 'explain' | 'customize';

function installLiteralMetaModel(expectedText: 'Q' | 'B', action: MetaAction) {
  const calls: Array<{ system: string; user: Record<string, unknown> }> = [];
  semanticPorts.installTurnSemanticModelPort(configuredSemantic.configuredBrainSemanticPort(async (input) => {
    assert.equal(input.purpose, 'turn_semantics');
    const user = JSON.parse(input.user) as {
      acceptedText: string;
      host: {
        resumableGoals: Array<{ goalId: string; baseRevision: number }>;
        openQuestions: Array<{
          questionId: string;
          slotKey: string;
          question: string;
          options: Array<{ optionId: string; label: string; metaAction?: MetaAction }>;
        }>;
      };
    };
    calls.push({ system: input.system, user: user as unknown as Record<string, unknown> });
    assert.equal(user.acceptedText, expectedText);
    const goal = user.host.resumableGoals[0];
    const question = user.host.openQuestions[0];
    assert.ok(goal && question, 'the semantic model sees the exact durable open question');
    assert.equal(question.question.replace(/\s+/g, ' '), QUESTION.replace(/\s+/g, ' '));
    const visible = question.options.find((option) => option.metaAction === action);
    assert.ok(visible, `the durable host view exposes one ${action} meta option`);
    assert.equal(visible.label, action === 'explain' ? OPTIONS[1] : OPTIONS[2]);
    return {
      raw: {
        version: 1,
        relation: 'answer_open_slot',
        targetGoal: { goalId: goal.goalId, baseRevision: goal.baseRevision },
        goal: null,
        work: null,
        slotAnswers: [{
          kind: 'meta',
          questionId: question.questionId,
          slotKey: question.slotKey,
          optionId: visible.optionId,
          action,
        }],
        rationale: `The literal ${expectedText} is the visible ${action} meta-choice, not slot content.`,
      },
      modelIdentity: `deterministic-meta-${action}`,
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    };
  }));
  return calls;
}

function installLiteralValueModel(expectedText: string, expectedQuestion: string) {
  semanticPorts.installTurnSemanticModelPort(configuredSemantic.configuredBrainSemanticPort(async (input) => {
    assert.equal(input.purpose, 'turn_semantics');
    const user = JSON.parse(input.user) as {
      acceptedText: string;
      host: {
        resumableGoals: Array<{ goalId: string; baseRevision: number }>;
        openQuestions: Array<{ questionId: string; slotKey: string; question: string; allowFreeText: boolean }>;
      };
    };
    assert.equal(user.acceptedText, expectedText);
    const goal = user.host.resumableGoals[0];
    const question = user.host.openQuestions[0];
    assert.ok(goal && question);
    assert.equal(question.question, expectedQuestion);
    assert.equal(question.allowFreeText, true);
    return {
      raw: {
        version: 1,
        relation: 'answer_open_slot',
        targetGoal: { goalId: goal.goalId, baseRevision: goal.baseRevision },
        goal: null,
        work: null,
        slotAnswers: [{
          kind: 'value', questionId: question.questionId,
          slotKey: question.slotKey, value: expectedText,
        }],
        rationale: 'The user supplied the requested bundled strategy values.',
      },
      modelIdentity: 'deterministic-custom-values',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    };
  }));
}

function installForgedMetaModel(
  expectedText: string,
  mutate: (input: {
    targetGoal: { goalId: string; baseRevision: number };
    slotAnswer: Record<string, unknown>;
  }) => {
    targetGoal: { goalId: string; baseRevision: number };
    slotAnswer: Record<string, unknown>;
  },
) {
  semanticPorts.installTurnSemanticModelPort(configuredSemantic.configuredBrainSemanticPort(async (input) => {
    const user = JSON.parse(input.user) as {
      acceptedText: string;
      host: {
        resumableGoals: Array<{ goalId: string; baseRevision: number }>;
        openQuestions: Array<{
          questionId: string;
          slotKey: string;
          options: Array<{ optionId: string; metaAction?: MetaAction }>;
        }>;
      };
    };
    assert.equal(user.acceptedText, expectedText);
    const goal = user.host.resumableGoals[0];
    const question = user.host.openQuestions[0];
    const visible = question?.options.find((option) => option.metaAction === 'explain');
    assert.ok(goal && question && visible);
    const forged = mutate({
      targetGoal: { goalId: goal.goalId, baseRevision: goal.baseRevision },
      slotAnswer: {
        kind: 'meta',
        questionId: question.questionId,
        slotKey: question.slotKey,
        optionId: visible.optionId,
        action: 'explain',
      },
    });
    return {
      raw: {
        version: 1,
        relation: 'answer_open_slot',
        targetGoal: forged.targetGoal,
        goal: null,
        work: null,
        slotAnswers: [forged.slotAnswer],
        rationale: 'Adversarial malformed or stale meta proposal.',
      },
      modelIdentity: 'deterministic-forged-meta',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    } as never;
  }));
}

async function openStrategySession(sessionId: string) {
  const session = eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'mobile' });
  const root = eventlog.appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: PROMPT, displayText: PROMPT },
  });
  const packet = await askThroughHost({
    sessionId,
    source: root,
    userInput: PROMPT,
    question: QUESTION,
    options: OPTIONS,
    history: [{ type: 'message', role: 'user', content: PROMPT }],
    callId: `${sessionId}-strategy`,
  });
  assert.ok(packet);
  return { session, root, packet };
}

function assertNoBusinessIo(sessionId: string): void {
  const db = eventlog.openEventLog();
  const physical = db.prepare(`
    SELECT p.tool_name
      FROM physical_dispatches p
     WHERE p.session_id = ?
  `).all(sessionId) as Array<{ tool_name: string }>;
  assert.deepEqual(physical.filter((row) => (
    /work_call|composio_execute_tool|space_save|firecrawl|web_search/i.test(row.tool_name)
  )), [], 'meta-choice turns perform zero provider/research/write I/O');
  assert.equal(eventlog.listEvents(sessionId).filter((event) => (
    event.type === 'tool_called'
    && /work_call|composio_execute_tool|space_save/.test(String(event.data.tool ?? ''))
  )).length, 0);
}

test('literal Q is an admitted explain meta-choice that reoffers the same strategy with zero effects', { timeout: 30_000 }, async () => {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
  capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
  const { session, root, packet: originalPacket } = await openStrategySession('northstar-meta-q');
  const q = eventlog.appendEvent({
    sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Q', displayText: 'Q' },
  });
  const semanticCalls = installLiteralMetaModel('Q', 'explain');
  const admitted = await continuity.prepareCheckedHostClarificationAnswer({
    sessionId: session.id, sourceUserSeq: q.seq, turn: q.turn,
    surface: 'home',
  });
  assert.equal(admitted, 'admitted', JSON.stringify({
    interpretation: semanticInterpretation.readPersistedSemanticInterpretation(session.id, q.seq),
  }));
  const typed = semanticInterpretation.typedClassificationFromLastInterpretation(session.id, q.seq);
  assert.deepEqual(typed, {
    keepOpen: true,
    metaAction: 'explain',
    questionId: originalPacket!.pause.slot?.questionId,
    slotKey: originalPacket!.pause.slot?.slotKey,
    optionId: 'opt-2',
  });
  assert.match(semanticCalls[0]?.system ?? '', /explain.*customize.*meta-choice/i,
    'the production semantic system teaches the model that Q/B are typed meta-actions');
  const stillOpen = await continuity.enrichAcceptedRequestWithTaskContinuity({
    sessionId: session.id, sourceUserSeq: q.seq, message: 'Q',
  }, q.seq, { typedClassification: typed });
  assert.equal(stillOpen.taskContinuation, undefined);
  assert.equal(taskContinuity.peekTaskContinuityPacket({ sessionId: session.id }).status, 'available');

  const successor = await askThroughHost({
    sessionId: session.id,
    source: q,
    userInput: 'Q',
    semanticSteer: stillOpen.semanticTaskInput,
    question: RATIONALE_REASK,
    options: OPTIONS,
    history: [
      { type: 'message', role: 'user', content: PROMPT },
      { type: 'message', role: 'assistant', content: QUESTION },
      { type: 'message', role: 'user', content: 'Q' },
    ],
    callId: 'northstar-explain-reask',
    expectedMetaAction: 'explain',
  });
  assert.ok(successor);
  const linked = successor as typeof successor & {
    rootSourceUserSeq?: number;
    parentPacketId?: string;
  };
  assert.equal(linked.originatingSourceUserSeq, q.seq, 'the successor question remains adjacent to its next answer');
  assert.equal(linked.rootSourceUserSeq, root.seq, 'the original objective remains the semantic root');
  assert.equal(linked.parentPacketId, originalPacket!.packetId, 'the rationale reask is a typed packet successor');
  assert.deepEqual(linked.pause.options, OPTIONS);
  assert.equal(linked.pause.slot?.goalId, originalPacket!.pause.slot?.goalId);
  assert.equal(linked.pause.slot?.revision, originalPacket!.pause.slot?.revision);
  assert.equal(linked.pause.slot?.questionId, originalPacket!.pause.slot?.questionId);
  assert.equal(linked.pause.slot?.slotKey, originalPacket!.pause.slot?.slotKey);
  const successorTerminal = eventlog.listEvents(session.id, { types: ['conversation_completed'] })
    .find((event) => event.data.sourceUserSeq === q.seq);
  assert.ok(successorTerminal);
  const successorPresentation = presentationEventFromCompletionData(successorTerminal.data);
  assert.ok(successorPresentation);
  const replayedSuccessor = continuity.persistCommittedClarificationContinuity({
    terminalEvent: successorTerminal,
    presentation: successorPresentation,
  });
  assert.equal(replayedSuccessor?.packetId, linked.packetId,
    'replaying the exact committed Q reask adopts the existing packet');
  eventlog.closeEventLog();
  eventlog.openEventLog();
  const reopened = taskContinuity.peekTaskContinuityPacket({ sessionId: session.id });
  assert.equal(reopened.status, 'available');
  if (reopened.status === 'available') assert.equal(reopened.packet.packetId, linked.packetId);
  const packetCount = (eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM task_continuity_packets WHERE session_id = ?
  `).get(session.id) as { n: number }).n;
  assert.equal(packetCount, 2, 'restart/replay creates no duplicate continuation packet');
  assertNoBusinessIo(session.id);
});

test('literal B opens one bundled customization slot; details resume the original objective before action', { timeout: 30_000 }, async () => {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
  capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
  const { session, root, packet: originalPacket } = await openStrategySession('northstar-meta-b');
  const b = eventlog.appendEvent({
    sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'B', displayText: 'B' },
  });
  installLiteralMetaModel('B', 'customize');
  const admittedB = await continuity.prepareCheckedHostClarificationAnswer({
    sessionId: session.id, sourceUserSeq: b.seq, turn: b.turn,
    surface: 'home',
  });
  assert.equal(admittedB, 'admitted', JSON.stringify({
    interpretation: semanticInterpretation.readPersistedSemanticInterpretation(session.id, b.seq),
  }));
  const typedB = semanticInterpretation.typedClassificationFromLastInterpretation(session.id, b.seq);
  assert.deepEqual(typedB, {
    keepOpen: true,
    metaAction: 'customize',
    questionId: originalPacket!.pause.slot?.questionId,
    slotKey: originalPacket!.pause.slot?.slotKey,
    optionId: 'opt-3',
  });
  const stillOpen = await continuity.enrichAcceptedRequestWithTaskContinuity({
    sessionId: session.id, sourceUserSeq: b.seq, message: 'B',
  }, b.seq, { typedClassification: typedB });
  assert.match(stillOpen.semanticTaskInput ?? '', /\[meta-action\]\ncustomize/);
  assertNoBusinessIo(session.id);

  const customizationPacket = await askThroughHost({
    sessionId: session.id,
    source: b,
    userInput: 'B',
    semanticSteer: stillOpen.semanticTaskInput,
    question: CUSTOM_QUESTION,
    options: [],
    history: [
      { type: 'message', role: 'user', content: PROMPT },
      { type: 'message', role: 'assistant', content: QUESTION },
      { type: 'message', role: 'user', content: 'B' },
    ],
    callId: 'northstar-customize-bundle',
    expectedMetaAction: 'customize',
  });
  assert.ok(customizationPacket);
  const linked = customizationPacket as typeof customizationPacket & {
    rootSourceUserSeq?: number;
    parentPacketId?: string;
  };
  assert.equal(linked.originatingSourceUserSeq, b.seq);
  assert.equal(linked.rootSourceUserSeq, root.seq);
  assert.equal(linked.parentPacketId, originalPacket!.packetId);
  assert.equal(linked.pause.question, CUSTOM_QUESTION);
  assert.deepEqual(linked.pause.options, []);

  const details = eventlog.appendEvent({
    sessionId: session.id, turn: 3, role: 'user', type: 'user_input_received',
    data: { text: CUSTOM_DETAILS, displayText: CUSTOM_DETAILS },
  });
  installLiteralValueModel(CUSTOM_DETAILS, CUSTOM_QUESTION);
  const admittedDetails = await continuity.prepareCheckedHostClarificationAnswer({
    sessionId: session.id, sourceUserSeq: details.seq, turn: details.turn,
    surface: 'home',
  });
  assert.equal(admittedDetails, 'admitted');
  const typedDetails = semanticInterpretation.typedClassificationFromLastInterpretation(
    session.id,
    details.seq,
  );
  assert.deepEqual(typedDetails, { disposition: 'provided' });
  const resumed = await continuity.enrichAcceptedRequestWithTaskContinuity({
    sessionId: session.id, sourceUserSeq: details.seq, message: CUSTOM_DETAILS,
  }, details.seq, { typedClassification: typedDetails, resolveCandidates: false });
  assert.equal(resumed.taskContinuationResolved, true);
  assert.equal(resumed.taskContinuation?.parentSourceUserSeq, root.seq);
  assert.equal(resumed.taskContinuation?.consumingSourceUserSeq, details.seq);
  assert.equal(resumed.taskContinuation?.parentInput, PROMPT);
  assert.equal(resumed.taskContinuation?.question, CUSTOM_QUESTION);
  assert.equal(resumed.taskContinuation?.answer, CUSTOM_DETAILS);
  assert.equal(resumed.taskContinuation?.disposition, 'provided');
  assert.match(resumed.semanticTaskInput ?? '', /scape the top recent news/i);
  assert.match(resumed.semanticTaskInput ?? '', /audience = IT leaders/i);
  assert.deepEqual(taskContinuity.peekTaskContinuityPacket({ sessionId: session.id }), { status: 'none' });

  assertNoBusinessIo(session.id);
});

test('malformed, stale, hidden, and action-mismatched meta proposals fail closed with zero effects', { timeout: 30_000 }, async () => {
  const cases: Array<{
    name: string;
    mutate: Parameters<typeof installForgedMetaModel>[1];
  }> = [
    {
      name: 'missing-option-id',
      mutate: ({ targetGoal, slotAnswer }) => {
        const { optionId: _missing, ...withoutOption } = slotAnswer;
        return { targetGoal, slotAnswer: withoutOption };
      },
    },
    {
      name: 'stale-goal-revision',
      mutate: ({ targetGoal, slotAnswer }) => ({
        targetGoal: { ...targetGoal, baseRevision: targetGoal.baseRevision + 1 },
        slotAnswer,
      }),
    },
    {
      name: 'foreign-question',
      mutate: ({ targetGoal, slotAnswer }) => ({
        targetGoal,
        slotAnswer: { ...slotAnswer, questionId: 'question-foreign' },
      }),
    },
    {
      name: 'foreign-slot',
      mutate: ({ targetGoal, slotAnswer }) => ({
        targetGoal,
        slotAnswer: { ...slotAnswer, slotKey: 'slot-foreign' },
      }),
    },
    {
      name: 'hidden-option',
      mutate: ({ targetGoal, slotAnswer }) => ({
        targetGoal,
        slotAnswer: { ...slotAnswer, optionId: 'opt-hidden' },
      }),
    },
    {
      name: 'action-mismatch',
      mutate: ({ targetGoal, slotAnswer }) => ({
        targetGoal,
        slotAnswer: { ...slotAnswer, action: 'customize' },
      }),
    },
  ];
  for (const [index, fixture] of cases.entries()) {
    eventlog.resetEventLog();
    capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
    capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
    const { session, packet } = await openStrategySession(`northstar-meta-negative-${index}`);
    const source = eventlog.appendEvent({
      sessionId: session.id,
      turn: 2,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Q', displayText: 'Q' },
    });
    installForgedMetaModel('Q', fixture.mutate);
    const admitted = await continuity.prepareCheckedHostClarificationAnswer({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: source.turn,
      surface: 'home',
    });
    assert.equal(admitted, 'blocked', fixture.name);
    const refusedTyped = semanticInterpretation.typedClassificationFromLastInterpretation(
      session.id,
      source.seq,
    );
    assert.ok(
      refusedTyped === null
      || ('keepOpen' in refusedTyped && refusedTyped.keepOpen === true && !refusedTyped.metaAction),
      fixture.name,
    );
    const stillOpen = taskContinuity.peekTaskContinuityPacket({ sessionId: session.id });
    assert.equal(stillOpen.status, 'available', fixture.name);
    if (stillOpen.status === 'available') assert.equal(stillOpen.packet.packetId, packet!.packetId);
    assertNoBusinessIo(session.id);
  }
});
