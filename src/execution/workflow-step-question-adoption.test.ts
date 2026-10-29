/** Consumer-side adoption/owner walls, based on workflow-step-capture-adoption
 * and workflow-runner-status fixtures. No real model, provider, or live app.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';

assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
assert.equal(process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS, '1');
assert.ok(process.env.CLEMENTINE_HOME);
const runner = await import('./workflow-runner.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const submissions = await import('../tools/step-result-tool.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { readWorkflowEvents } = await import('./workflow-events.js');
after(() => { runner._setWorkflowHarnessLoopImplsForTests(); eventlog.closeEventLog(); });

type Handler = (args: { data: string; ask_owner?: string }) => Promise<unknown>;
function registeredHandler(): Handler {
  let captured: Handler | undefined;
  const registrationOnlyServer = { tool(_name: string, _description: string, _schema: unknown, handler: Handler) { captured = handler; } };
  submissions.registerStepResultTool(registrationOnlyServer as unknown as Parameters<typeof submissions.registerStepResultTool>[0]);
  assert.ok(captured); return captured;
}
let serial = 0;
function fixture(label: string) {
  const runId = `controlled-question-${label}-${++serial}`;
  const slug = `controlled-question-${label}`;
  const step = { id: 'main', prompt: 'Ask the owner to choose copper or silver.', sideEffect: 'read' as const };
  const ctx = { workflow: { name: `Controlled question ${label}`, description: '', enabled: true, steps: [step], trigger: { manual: true } },
    workflowSlug: slug, runId, inputs: {}, stepOutputs: {}, assistant: { async respond() { throw new Error('legacy assistant is outside this fixture'); } },
    completedItems: new Map(), forEachFailures: [], qualityAdvisories: [],
  } as unknown as Parameters<typeof runner.executeStep>[1];
  return { runId, slug, step, ctx, sessionId: `workflow:${runId}:${step.id}` };
}
function acceptedSource(sessionId: string) {
  const sources = eventlog.listEvents(sessionId, { types: ['user_input_received'] });
  assert.equal(sources.length, 1, 'this fresh step execution must have one exact accepted source');
  return sources[0]!;
}
async function askActualHandler(sessionId: string, question: string) {
  const source = acceptedSource(sessionId);
  await withToolOutputContext({ sessionId, sourceUserSeq: source.seq, toolName: 'workflow_step_result' }, () =>
    registeredHandler()({ data: JSON.stringify({ draft: 'controlled preserved partial' }), ask_owner: question }));
  return source;
}
function cleanup(sessionId: string) {
  submissions.takeStepQuestion(sessionId); submissions.clearStepResult(sessionId); submissions.clearStepContract(sessionId);
  runner._setWorkflowHarnessLoopImplsForTests();
}

test('a genuine pending question survives an early blocked presentation and reaches the existing input boundary', async () => {
  const f = fixture('blocked');
  const question = 'Which controlled label should this step use?';
  let sourceSeq = 0;
  runner._setWorkflowHarnessLoopImplsForTests({ configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async () => {
      sourceSeq = (await askActualHandler(f.sessionId, question)).seq;
      return { sessionId: f.sessionId, status: 'blocked', steps: 1, lastTurn: 1,
        lastDecision: { reply: question, summary: question, done: true, nextAction: 'completed' } };
    }) as never });
  try {
    await assert.rejects(runner.executeStep(f.step, f.ctx), (error: unknown) => {
      assert.ok(error instanceof runner.WorkflowAwaitingInputSignal, 'question control must not be lost in the earlier blocked-disposition branch');
      assert.equal(error.state.question, question);
      assert.equal(error.state.sessionId, f.sessionId);
      assert.equal(error.state.questionId, `workflow-input:${f.runId}:${f.step.id}:${sourceSeq}`);
      return true;
    });
    assert.equal(readWorkflowEvents(f.slug, f.runId).some(event => event.kind === 'step_completed'), false, 'partial data is never a completed downstream result');
  } finally { cleanup(f.sessionId); }
});

for (const status of ['held', 'dispatched', 'killed'] as const) test(`an accepted question cannot bypass ${status} execution ownership`, async () => {
  const f = fixture(status);
  runner._setWorkflowHarnessLoopImplsForTests({ configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async () => {
      await askActualHandler(f.sessionId, 'This question does not override the execution owner.');
      return { sessionId: f.sessionId, status, steps: 1, lastTurn: 1,
        ...(status === 'held' ? { hold: { owner: 'host', wake: 'peer', reason: 'peer_in_progress' } } : {}) };
    }) as never });
  try {
    await assert.rejects(runner.executeStep(f.step, f.ctx), (error: unknown) => {
      assert.ok(!(error instanceof runner.WorkflowAwaitingInputSignal), 'the pending question cannot steal held/dispatched/cancelled work');
      if (status === 'held' || status === 'dispatched') assert.ok(error instanceof runner.WorkflowHarnessHeldSignal);
      else assert.match(String((error as Error)?.name ?? error), /cancel/i);
      return true;
    });
    assert.equal(readWorkflowEvents(f.slug, f.runId).some(event => event.kind === 'step_completed'), false);
  } finally { cleanup(f.sessionId); }
});

function appendSource(sessionId: string) {
  eventlog.createSession({ id: sessionId, kind: 'workflow' });
  return eventlog.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Controlled carrier authority fixture.' } });
}
function appendCarrier(sessionId: string, sourceSeq: number, value: unknown, control?: unknown) {
  return eventlog.appendEvent({ sessionId, turn: 1, role: 'system', type: 'workflow_step_result_captured',
    data: { sourceUserSeq: sourceSeq, value, ...(control !== undefined ? { control } : {}) } });
}
function attest(sessionId: string, sourceSeq: number, reason = 'workflow_step_result_captured') {
  return eventlog.appendEvent({ sessionId, turn: 1, role: 'system', type: 'conversation_completed',
    data: { sourceUserSeq: sourceSeq, reason, reply: 'Controlled retained step submission.', summary: 'Controlled retained step submission.', delivered: false } });
}

test('an unattested carrier and diagnostic previews grant no question recovery authority', () => {
  const sessionId = `controlled-question-unattested-${++serial}`;
  const source = appendSource(sessionId);
  // Explicit corruption/absence-of-proof fixture. No handler success is claimed.
  const question = 'An unattested carrier must remain unqualified.';
  appendCarrier(sessionId, source.seq, { blocked: true, reason: question }, { kind: 'ask_owner', question, partialData: { draft: 'not authoritative' } });
  eventlog.appendEvent({ sessionId, turn: 1, role: 'assistant', type: 'tool_called', data: {
    sourceUserSeq: source.seq, tool: 'workflow_step_result', callId: 'controlled-preview-only',
    arguments: JSON.stringify({ data: '{}', ask_owner: 'A diagnostic preview cannot supply terminal attestation.' }),
  } });
  eventlog.closeEventLog();
  assert.deepEqual(runner.durableCapturedStepResult(sessionId, new Set([source.seq])), { found: false, value: undefined });
});

test('a terminal for a different source cannot attest a question carrier', () => {
  const sessionId = `controlled-question-wrong-attestation-${++serial}`;
  const source = appendSource(sessionId);
  const other = eventlog.appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Different controlled request.' } });
  const question = 'Only this exact source can attest this carrier.';
  appendCarrier(sessionId, source.seq, { blocked: true, reason: question }, { kind: 'ask_owner', question, partialData: {} });
  attest(sessionId, other.seq);
  eventlog.closeEventLog();
  assert.deepEqual(runner.durableCapturedStepResult(sessionId, new Set([source.seq])), { found: false, value: undefined });
});

for (const [label, control] of [
  ['null', null],
  ['unknown-kind', { kind: 'future_question', question: 'Unknown control.', partialData: {} }],
  ['blank-question', { kind: 'ask_owner', question: '   ', partialData: {} }],
  ['missing-partial', { kind: 'ask_owner', question: 'Missing required partial data.' }],
] as const) test(`present ${label} control fails closed instead of becoming a completed result`, () => {
  const sessionId = `controlled-question-invalid-${label}-${++serial}`;
  const source = appendSource(sessionId);
  appendCarrier(sessionId, source.seq, { selected: 'must not be promoted' }, control);
  attest(sessionId, source.seq);
  eventlog.closeEventLog();
  assert.deepEqual(runner.durableCapturedStepResult(sessionId, new Set([source.seq])), { found: false, value: undefined });
});

test('historical normal carriers without outer control preserve null and empty result shapes', () => {
  for (const [label, value] of [['null', null], ['empty', '']] as const) {
    const sessionId = `controlled-question-legacy-${label}-${++serial}`;
    const source = appendSource(sessionId);
    appendCarrier(sessionId, source.seq, value);
    attest(sessionId, source.seq);
    eventlog.closeEventLog();
    assert.deepEqual(runner.durableCapturedStepResult(sessionId, new Set([source.seq])), { found: true, value });
  }
});


test('a later unattested question cannot borrow an earlier same-source terminal or resurrect prior success', () => {
  const sessionId = `controlled-question-terminal-order-${++serial}`;
  const source = appendSource(sessionId);
  appendCarrier(sessionId, source.seq, { selected: 'earlier copper result' });
  attest(sessionId, source.seq);
  const question = 'This later submission has no terminal of its own yet.';
  appendCarrier(sessionId, source.seq, { blocked: true, reason: question }, { kind: 'ask_owner', question, partialData: { draft: 'later unqualified partial' } });
  eventlog.closeEventLog();
  assert.deepEqual(runner.durableCapturedStepResult(sessionId, new Set([source.seq])), { found: false, value: undefined },
    'select the newest submission first, then require its later same-source attestation');
});

for (const [label, value] of [
  ['nonblocked-value', { selected: 'partial data cannot become a completed result' }],
  ['wrong-reason', { blocked: true, reason: 'A different question from another submission.' }],
] as const) test(`latest ${label} question control cannot fall back to older completed output`, () => {
  const sessionId = `controlled-question-contradictory-${label}-${++serial}`;
  const source = appendSource(sessionId);
  appendCarrier(sessionId, source.seq, { selected: 'prior copper output' });
  // One canonical terminal may attest this source. Both submissions precede
  // it; the reader must inspect the latest one before decoding its control.
  appendCarrier(sessionId, source.seq, value, { kind: 'ask_owner', question: 'The actual controlled question.', partialData: { draft: 'not final' } });
  attest(sessionId, source.seq);
  eventlog.closeEventLog();
  assert.deepEqual(runner.durableCapturedStepResult(sessionId, new Set([source.seq])), { found: false, value: undefined },
    'a contradictory newest carrier is unqualified; it cannot promote partial data or revive old output');
});


test('executeStep recovers an actual loop-produced question after local capture is cleared and the event store reopens', async () => {
  const f = fixture('durable-only');
  const question = 'Which controlled label should the restarted workflow use?';
  const partialData = { draft: 'controlled durable-only partial', fullTail: 'retain-durable-partial-'.repeat(700) };
  const { runConversation: realRunConversation } = await import('../runtime/harness/loop.js');
  let modelCalls = 0;
  let sourceSeq = 0;
  async function* stream(this: { getResponse: (request: unknown) => Promise<{ output: unknown[]; responseId: string; usage: Record<string, unknown> }> }, request: unknown) {
    const response = await this.getResponse(request);
    yield { type: 'response_started' } as never;
    yield { type: 'model', event: { type: 'finish', finishReason: 'stop' } } as never;
    yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
  }
  runner._setWorkflowHarnessLoopImplsForTests({ configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (request: Parameters<typeof realRunConversation>[0]) => {
      assert.equal(request.sessionId, f.sessionId);
      const source = acceptedSource(f.sessionId);
      sourceSeq = source.seq;
      assert.equal(request.sourceUserSeq, source.seq, 'the actual runner passes this exact accepted source to the real producer');
      const invoke = registeredHandler();
      const model = {
        async getResponse(_request: unknown) {
          modelCalls += 1;
          assert.ok(modelCalls <= 3, 'this deterministic provider fixture is bounded');
          if (modelCalls === 1) {
            await withToolOutputContext({ sessionId: f.sessionId, sourceUserSeq: source.seq, toolName: 'workflow_step_result' }, () =>
              invoke({ data: JSON.stringify(partialData), ask_owner: question }));
          }
          return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
            output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'This controlled step needs the owner selection.' }] }],
            responseId: `controlled-durable-owner-question-${modelCalls}` };
        },
        getStreamedResponse: stream,
      };
      // Keep the runner's real source/attempt binding, but replace only its
      // provider with the same deterministic host-v1 model used by the producer
      // fixture. A prebuilt empty agent must not bypass this buildAgent seam.
      const { agent: _prebuiltAgent, ...sourceBoundRequest } = request;
      const produced = await realRunConversation({ ...sourceBoundRequest, turnEngine: 'host_v1', maxTurns: 3, judgeCompletion: false,
        buildAgent: async () => ({ model, instructions: 'Execute only this controlled owner-question step.', tools: [] }) as never,
        makeRunner: () => {
          const legacy = new EventEmitter();
          (legacy as unknown as { run: () => never }).run = () => { throw new Error('legacy Runner.run is outside this fixture'); };
          return legacy as never;
        },
      });
      assert.equal(modelCalls, 1, 'the genuine question is already a capture, not a missing-result retry');
      const carriers = eventlog.listEvents(f.sessionId, { types: ['workflow_step_result_captured'] })
        .filter(row => row.data.sourceUserSeq === source.seq);
      assert.equal(carriers.length, 1, 'the real loop emitted the carrier; the consumer fixture does not fabricate one');
      assert.deepEqual(carriers[0]!.data.value, { blocked: true, reason: question });
      assert.deepEqual(carriers[0]!.data.control, { kind: 'ask_owner', question, partialData });
      const terminal = eventlog.listEvents(f.sessionId, { types: ['conversation_completed'] })
        .find(row => row.seq > carriers[0]!.seq && row.data.sourceUserSeq === source.seq && row.data.reason === 'workflow_step_result_captured');
      assert.ok(terminal, 'its own later exact-source terminal attests the real carrier');
      submissions.clearStepResult(f.sessionId);
      assert.equal(submissions.peekStepResult(f.sessionId).found, false);
      assert.equal(submissions.takeStepQuestion(f.sessionId), undefined, 'no local question remains for the runner fast path');
      eventlog.closeEventLog();
      return produced;
    }) as never });
  try {
    await assert.rejects(runner.executeStep(f.step, f.ctx), (error: unknown) => {
      assert.ok(error instanceof runner.WorkflowAwaitingInputSignal, 'durable-only question recovery must reach the runner input boundary');
      assert.equal(error.state.question, question);
      assert.equal(error.state.sessionId, f.sessionId);
      assert.equal(error.state.questionId, `workflow-input:${f.runId}:${f.step.id}:${sourceSeq}`);
      return true;
    });
    assert.equal(readWorkflowEvents(f.slug, f.runId).some(event => event.kind === 'step_completed'), false);
    const carriers = eventlog.listEvents(f.sessionId, { types: ['workflow_step_result_captured'] });
    assert.ok(JSON.stringify(carriers[0]?.data.control).length > 8_000, 'full partial data is retained but is not a completed output or a claimed resumed prompt');
  } finally { cleanup(f.sessionId); }
});
