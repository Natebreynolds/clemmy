import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStructuredOutputError, assistantItemText, __defaultRunRunner } from './loop.js';

// --- pure classifiers ------------------------------------------------------

test('isStructuredOutputError: JSON SyntaxError and ZodError are recoverable', () => {
  assert.equal(isStructuredOutputError(new SyntaxError('Unexpected token < in JSON')), true);
  assert.equal(isStructuredOutputError({ name: 'ZodError', issues: [] }), true);
  assert.equal(isStructuredOutputError({ issues: [{ path: ['done'] }] }), true);
});

test('isStructuredOutputError: the SDK wrapped "Invalid output type" ModelBehaviorError is recoverable', () => {
  // What MiniMax M3 actually triggered: SDK wraps the JSON.parse failure.
  assert.equal(isStructuredOutputError({ name: 'ModelBehaviorError', message: 'Invalid output type: Unexpected token \'<\', "<think>\\nI "... is not valid JSON' }), true);
  assert.equal(isStructuredOutputError({ name: 'ModelBehaviorError', message: 'Invalid output type: final assistant output failed schema validation.' }), true);
});

test('isStructuredOutputError: transport/auth/other errors are NOT recoverable', () => {
  assert.equal(isStructuredOutputError(new Error('network down')), false);
  assert.equal(isStructuredOutputError({ name: 'BoundaryError' }), false);
  assert.equal(isStructuredOutputError({ name: 'CodexModelError', status: 401 }), false);
  // a ModelBehaviorError that is NOT an output-parse failure must propagate
  assert.equal(isStructuredOutputError({ name: 'ModelBehaviorError', message: 'Agent tool called with invalid input' }), false);
  assert.equal(isStructuredOutputError(null), false);
  assert.equal(isStructuredOutputError('boom'), false);
});

test('assistantItemText: string content, text parts, and empties', () => {
  assert.equal(assistantItemText({ type: 'message', role: 'assistant', content: 'hi' } as never), 'hi');
  assert.equal(assistantItemText({ content: [{ type: 'output_text', text: 'a' }, { text: 'b' }] } as never), 'ab');
  assert.equal(assistantItemText({ content: [] } as never), null);
  assert.equal(assistantItemText(null), null);
  assert.equal(assistantItemText({ content: 123 } as never), null);
});

// --- integration: defaultRunRunner guard ----------------------------------

function makeRunner(cfg: {
  completed: Promise<void>;
  finalOutput?: unknown;
  finalOutputThrows?: unknown;
  history?: unknown[];
  interruptions?: unknown[];
  events?: unknown[];
}) {
  return {
    run: async () => ({
      history: cfg.history ?? [],
      lastResponseId: 'resp_1',
      get finalOutput() {
        if (cfg.finalOutputThrows) throw cfg.finalOutputThrows;
        return cfg.finalOutput;
      },
      interruptions: cfg.interruptions ?? [],
      rawResponses: [],
      state: { toString: () => 'state' },
      completed: cfg.completed,
      async *[Symbol.asyncIterator]() {
        for (const event of cfg.events ?? []) yield event;
      },
    }),
  };
}
const callRunner = (runner: unknown) =>
  __defaultRunRunner(runner as never, {} as never, [] as never, {} as never);
const callRunnerWithItems = (runner: unknown, items: unknown[]) =>
  __defaultRunRunner(runner as never, {} as never, items as never, {} as never);

test('guard: ZodError on completed → recovers raw assistant text, ends cleanly', async () => {
  const zodErr = Object.assign(new Error('invalid'), { name: 'ZodError', issues: [] });
  const runner = makeRunner({
    completed: Promise.reject(zodErr),
    history: [{ type: 'message', role: 'assistant', content: 'here is my answer' }],
  });
  const out = await callRunner(runner);
  assert.equal(out.finalOutput, 'here is my answer');
  assert.equal(out.hasInterruptions, false);
});

test('guard: JSON SyntaxError on completed → recovers from text-part content', async () => {
  const runner = makeRunner({
    completed: Promise.reject(new SyntaxError('Unexpected token } in JSON at position 12')),
    history: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"summary":"x"}' }] }],
  });
  const out = await callRunner(runner);
  assert.equal(out.finalOutput, '{"summary":"x"}');
});

test('guard: parse error with no recoverable text → safe fallback string', async () => {
  const runner = makeRunner({ completed: Promise.reject(new SyntaxError('bad')), history: [] });
  const out = await callRunner(runner);
  assert.match(out.finalOutput as string, /couldn't be structured/);
});

test('guard: parse error with empty history recovers active streamed text', async () => {
  const runner = makeRunner({
    completed: Promise.reject(new SyntaxError('bad')),
    history: [],
    events: [
      { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'Built the report ' } },
      { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'and saved it to disk.' } },
    ],
  });
  const out = await callRunner(runner);
  assert.equal(out.finalOutput, 'Built the report and saved it to disk.');
});

test('guard: parse recovery does not reuse stale assistant text from prior turns', async () => {
  const prior = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'make a site' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I would frame it as The Loop.' }] },
  ];
  const runner = makeRunner({
    completed: Promise.reject(new SyntaxError('bad')),
    history: [...prior, { type: 'function_call', callId: 'call_write', name: 'write_file', arguments: '{}' }],
  });
  const out = await callRunnerWithItems(runner, prior);
  assert.match(out.finalOutput as string, /couldn't be structured/);
  assert.doesNotMatch(out.finalOutput as string, /The Loop/);
});

test('guard: NON-parse error (transport) is re-thrown, never swallowed', async () => {
  const runner = makeRunner({ completed: Promise.reject(new Error('connection reset')) });
  await assert.rejects(() => callRunner(runner), /connection reset/);
});

test('guard: finalOutput getter throws ZodError → recovered', async () => {
  const runner = makeRunner({
    completed: Promise.resolve(),
    finalOutputThrows: { name: 'ZodError', issues: [] },
    history: [{ type: 'message', role: 'assistant', content: 'recovered after getter throw' }],
  });
  const out = await callRunner(runner);
  assert.equal(out.finalOutput, 'recovered after getter throw');
});

test('guard: happy path is unchanged (valid structured output passes through)', async () => {
  const decision = { summary: 's', reply: 'r', done: true, nextAction: 'completed' };
  const runner = makeRunner({ completed: Promise.resolve(), finalOutput: decision });
  const out = await callRunner(runner);
  assert.deepEqual(out.finalOutput, decision);
});
