/** Real registered submission handler + real host-v1 carrier/terminal producer.
 * The only model is a deterministic in-process fixture. No tool_called previews
 * are fabricated. Restart means clearing local submission state and reopening
 * the actual event store after the producer has committed its carrier/terminal.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';

assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
assert.equal(process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS, '1');
assert.ok(process.env.CLEMENTINE_HOME);
const { runConversation } = await import('./loop.js');
const { HarnessSession } = await import('./session.js');
const eventlog = await import('./eventlog.js');
const submissions = await import('../../tools/step-result-tool.js');
const { withToolOutputContext } = await import('./tool-output-context.js');
const { durableCapturedStepResult } = await import('../../execution/workflow-runner.js');
after(() => { eventlog.closeEventLog(); });

type Handler = (args: { data: string; ask_owner?: string }) => Promise<unknown>;
function handler(): Handler {
  let captured: Handler | undefined;
  submissions.registerStepResultTool({
    tool(_name: string, _description: string, _schema: unknown, run: Handler) { captured = run; },
  } as unknown as Parameters<typeof submissions.registerStepResultTool>[0]);
  assert.ok(captured); return captured;
}
const textMessage = (text: string) => ({ type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text }] });
async function* modelStream(this: { getResponse: (request: unknown) => Promise<{ output: unknown[]; responseId: string; usage: Record<string, unknown> }> }, request: unknown) {
  const response = await this.getResponse(request);
  yield { type: 'response_started' } as never;
  yield { type: 'model', event: { type: 'finish', finishReason: 'stop' } } as never;
  yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
}
let serial = 0;
let hostRunSerial = 0;
function newStep() {
  const session = HarnessSession.create({ kind: 'workflow', title: `Controlled owner-question producer ${++serial}` });
  submissions.registerStepContract(session.id, { type: 'object', required_keys: ['selected'] });
  return session;
}
function cleanup(sessionId: string) {
  submissions.clearStepResult(sessionId); submissions.takeStepQuestion(sessionId); submissions.clearStepContract(sessionId);
}
async function runHost(sessionId: string, submit?: (sourceUserSeq: number) => Promise<void>) {
  const invocation = ++hostRunSerial;
  let calls = 0;
  let sourceUserSeq = 0;
  const beforeSources = new Set(eventlog.listEvents(sessionId, { types: ['user_input_received'] }).map(row => row.seq));
  const model = {
    async getResponse(_request: unknown) {
      calls += 1;
      assert.ok(calls <= 3, 'the deterministic fixture cannot become an unbounded continuation');
      const accepted = eventlog.listEvents(sessionId, { types: ['user_input_received'] }).filter(row => !beforeSources.has(row.seq));
      assert.equal(accepted.length, 1, 'the real host must accept exactly one new source before invoking this fixture');
      const source = accepted[0]!;
      sourceUserSeq = source.seq;
      if (calls === 1 && submit) await submit(source.seq);
      return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output: [textMessage('This controlled workflow step is waiting for its result.')], responseId: `owner-question-fixture-${invocation}-${calls}` };
    },
    getStreamedResponse: modelStream,
  };
  const result = await runConversation({ sessionId, input: `Run controlled owner-question producer invocation ${invocation}.`,
    turnEngine: 'host_v1', maxTurns: 3, judgeCompletion: false,
    buildAgent: async () => ({ model, instructions: 'Complete only this controlled workflow step.', tools: [] }) as never,
    makeRunner: () => {
      const runner = new EventEmitter();
      (runner as unknown as { run: () => never }).run = () => { throw new Error('legacy Runner.run is outside this fixture'); };
      return runner as never;
    },
  });
  return { result, calls, sourceUserSeq };
}
function sourceCarriers(sessionId: string, sourceUserSeq: number) {
  return eventlog.listEvents(sessionId, { types: ['workflow_step_result_captured'] })
    .filter(row => row.data.sourceUserSeq === sourceUserSeq);
}
function assertProduced(sessionId: string, sourceUserSeq: number) {
  const carriers = sourceCarriers(sessionId, sourceUserSeq);
  assert.equal(carriers.length, 1, 'one real carrier must precede the exact source terminal');
  const terminals = eventlog.listEvents(sessionId, { types: ['conversation_completed'] })
    .filter(row => row.data.sourceUserSeq === sourceUserSeq && row.data.reason === 'workflow_step_result_captured');
  assert.equal(terminals.length, 1, 'the same source must attest the carrier');
  assert.ok(carriers[0]!.seq < terminals[0]!.seq);
  return carriers[0]!;
}
const question = 'Which controlled label should this workflow use: copper or silver?';
const partialData = { draft: 'controlled partial data', rows: [{ id: 1 }], retainedTail: 'preserve-full-partial-'.repeat(700) };

test('real handler question is captured once, legacy-blocked, source-attested and recovered with full partial data after reopen', async () => {
  const session = newStep();
  const invoke = handler();
  try {
    const run = await runHost(session.id, async sourceUserSeq => {
      await withToolOutputContext({ sessionId: session.id, sourceUserSeq, toolName: 'workflow_step_result' }, () =>
        invoke({ data: JSON.stringify(partialData), ask_owner: question }));
    });
    assert.equal(run.calls, 1, 'an accepted owner question must not trigger missing-result continuations');
    const carrier = assertProduced(session.id, run.sourceUserSeq);
    assert.deepEqual(carrier.data.value, { blocked: true, reason: question }, 'older readers see an honest block, never partial data as a result');
    assert.deepEqual(carrier.data.control, { kind: 'ask_owner', question, partialData });
    assert.ok(JSON.stringify(carrier.data.control).length > 8_000, 'this proof exceeds diagnostic argument clipping');
    assert.equal(submissions.peekStepResult(session.id).found, false);
    assert.deepEqual(submissions.takeStepResult(session.id), { found: false, value: undefined }, 'a false result query cannot consume question control');
    submissions.clearStepResult(session.id);
    eventlog.closeEventLog();
    const recovered = durableCapturedStepResult(session.id, new Set([run.sourceUserSeq]));
    assert.deepEqual(recovered, { found: true, value: { blocked: true, reason: question }, control: { kind: 'ask_owner', question, partialData } });
    assert.deepEqual(durableCapturedStepResult(session.id, new Set()), { found: false, value: undefined });
    assert.deepEqual(durableCapturedStepResult(`${session.id}-foreign`, new Set([run.sourceUserSeq])), { found: false, value: undefined });
  } finally { cleanup(session.id); }
});

test('later real plain result wins over an older attested question after reopen', async () => {
  const session = newStep();
  const invoke = handler();
  try {
    const first = await runHost(session.id, async sourceUserSeq => {
      await withToolOutputContext({ sessionId: session.id, sourceUserSeq, toolName: 'workflow_step_result' }, () =>
        invoke({ data: JSON.stringify(partialData), ask_owner: question }));
    });
    assertProduced(session.id, first.sourceUserSeq);
    submissions.clearStepResult(session.id);
    const value = { selected: 'copper', complete: true };
    const second = await runHost(session.id, async sourceUserSeq => {
      await withToolOutputContext({ sessionId: session.id, sourceUserSeq, toolName: 'workflow_step_result' }, () => invoke({ data: JSON.stringify(value) }));
    });
    assert.equal(second.calls, 1);
    const carrier = assertProduced(session.id, second.sourceUserSeq);
    assert.deepEqual(carrier.data.value, value);
    assert.equal(Object.hasOwn(carrier.data, 'control'), false, 'normal carrier bytes keep their existing shape');
    submissions.clearStepResult(session.id); eventlog.closeEventLog();
    assert.deepEqual(durableCapturedStepResult(session.id, new Set([first.sourceUserSeq, second.sourceUserSeq])), { found: true, value },
      'select the latest overall carrier before deciding whether it is a question');
  } finally { cleanup(session.id); }
});

test('payload-only ask_owner and control fields cannot forge host question metadata', async () => {
  const session = newStep();
  const invoke = handler();
  const value = { selected: 'copper', ask_owner: 'This is payload data, not a host question.',
    control: { kind: 'ask_owner', question: 'Payload cannot request parking.', partialData: { pretend: true } } };
  try {
    const run = await runHost(session.id, async sourceUserSeq => {
      await withToolOutputContext({ sessionId: session.id, sourceUserSeq, toolName: 'workflow_step_result' }, () => invoke({ data: JSON.stringify(value) }));
    });
    assert.equal(run.calls, 1);
    const carrier = assertProduced(session.id, run.sourceUserSeq);
    assert.deepEqual(carrier.data.value, value);
    assert.equal(Object.hasOwn(carrier.data, 'control'), false);
    assert.equal(submissions.takeStepQuestion(session.id), undefined);
    submissions.clearStepResult(session.id); eventlog.closeEventLog();
    assert.deepEqual(durableCapturedStepResult(session.id, new Set([run.sourceUserSeq])), { found: true, value });
  } finally { cleanup(session.id); }
});

for (const binding of ['missing', 'wrong'] as const) test(`a real handler question with ${binding} source binding cannot be attested under the current source`, async () => {
  const session = newStep();
  const invoke = handler();
  const old = eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'A separate earlier controlled request.' } });
  try {
    const run = await runHost(session.id, async sourceUserSeq => {
      assert.notEqual(old.seq, sourceUserSeq);
      await withToolOutputContext({ sessionId: session.id, ...(binding === 'wrong' ? { sourceUserSeq: old.seq } : {}), toolName: 'workflow_step_result' }, () =>
        invoke({ data: JSON.stringify(partialData), ask_owner: question }));
    });
    assert.equal(sourceCarriers(session.id, run.sourceUserSeq).length, 0, 'the loop cannot launder an unbound or foreign-source ask into current-source completion evidence');
    submissions.clearStepResult(session.id); eventlog.closeEventLog();
    assert.deepEqual(durableCapturedStepResult(session.id, new Set([run.sourceUserSeq])), { found: false, value: undefined });
  } finally { cleanup(session.id); }
});

test('a prior-source accepted question in a reused session cannot become a fresh-source carrier', async () => {
  const session = newStep();
  const invoke = handler();
  const old = eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'The prior controlled source.' } });
  try {
    await withToolOutputContext({ sessionId: session.id, sourceUserSeq: old.seq, toolName: 'workflow_step_result' }, () =>
      invoke({ data: JSON.stringify(partialData), ask_owner: question }));
    const run = await runHost(session.id);
    assert.notEqual(run.sourceUserSeq, old.seq);
    assert.equal(sourceCarriers(session.id, run.sourceUserSeq).length, 0);
    submissions.clearStepResult(session.id); eventlog.closeEventLog();
    assert.deepEqual(durableCapturedStepResult(session.id, new Set([run.sourceUserSeq])), { found: false, value: undefined });
  } finally { cleanup(session.id); }
});


test('a prior-source accepted normal result cannot be rebound as a fresh-source carrier', async () => {
  const session = newStep();
  const invoke = handler();
  const old = eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'The prior controlled normal-result source.' } });
  try {
    await withToolOutputContext({ sessionId: session.id, sourceUserSeq: old.seq, toolName: 'workflow_step_result' }, () =>
      invoke({ data: '{"selected":"old copper result"}' }));
    assert.equal(submissions.peekStepResult(session.id).found, true, 'the prior source did accept a normal result');
    const run = await runHost(session.id);
    assert.notEqual(run.sourceUserSeq, old.seq);
    assert.equal(sourceCarriers(session.id, run.sourceUserSeq).length, 0, 'normal owned results require the same exact-source fence as questions');
    submissions.clearStepResult(session.id); eventlog.closeEventLog();
    assert.deepEqual(durableCapturedStepResult(session.id, new Set([run.sourceUserSeq])), { found: false, value: undefined });
  } finally { cleanup(session.id); }
});
