import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { OpenAIChatCompletionsModel } from '@openai/agents-openai';
import { withTrace } from '@openai/agents-core';

// All calls below terminate at injected fakes, including the cached-client
// case. Require the repository's disposable-home boundary before imports.
if (process.env.CLEMMY_TEST_ISOLATED_HOME !== '1') throw new Error('Run through scripts/run-tests-isolated.mjs');
const { wrapCompletionsCreate, getByoModel, resetByoModelCache } = await import('./byo-model.js');
const { harnessRunContextStorage } = await import('./brackets.js');
const { acceptedSourceIdentity, readUsageEventsForDate, recordModelUsage, withModelUsageAttribution } = await import('../usage-log.js');
const { readAcceptedSourceUsage } = await import('../accepted-source-usage.js');
const log = await import('./eventlog.js');
type Body = Record<string, unknown>;
let count = 0;
function owner() {
  const sessionId = `byo-provenance-${++count}`;
  log.createSession({ id: sessionId, kind: 'chat' });
  const source = log.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Synthetic provenance fixture' } });
  return { sessionId, sourceUserSeq: source.seq, runAttemptId: `provenance-attempt-${count}` };
}
function rows(scope: ReturnType<typeof owner>) {
  return readUsageEventsForDate().filter(row => row.trace?.acceptedSource === acceptedSourceIdentity(scope.sessionId, scope.sourceUserSeq));
}
function run<T>(scope: ReturnType<typeof owner>, work: () => T): T {
  return harnessRunContextStorage.run(scope as never, work);
}
function completion(id: string, content = 'ready', model: string | undefined = 'glm-5.2') {
  return { id, created: 1, model, object: 'chat.completion',
    usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 80 } },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] };
}
const body = (extra: Body = {}): Body => ({ model: 'glm-5.3', messages: [{ role: 'user', content: 'fixture prompt must not enter provenance' }], ...extra });
async function drain(stream: unknown) { for await (const _chunk of stream as AsyncIterable<unknown>) { /* consume injected stream */ } }
function assertIdentity(row: ReturnType<typeof rows>[number], expectedSource: ReturnType<typeof owner>, id: string, backendId = 'zai-fixture') {
  assert.equal(row.source, expectedSource.sessionId);
  assert.equal(row.trace?.attemptId, expectedSource.runAttemptId);
  assert.equal(row.requestModel, 'glm-5.3');
  assert.equal(row.backendId, backendId);
  assert.equal(row.providerReportedModel, 'glm-5.2');
  assert.equal(row.model, 'glm-5.2', 'legacy grouping remains provider-reported');
  assert.equal(row.responseId, id);
  assert.equal(row.inputTokens, 100); assert.equal(row.cachedInputTokens, 80); assert.equal(row.outputTokens, 7);
  assert.equal(row.account, undefined, 'backend identity is never account or grant proof');
  assert.ok(!JSON.stringify(row).includes('fixture prompt'));
}
afterEach(() => { mock.restoreAll(); resetByoModelCache(); });

test('SDK providerData override is captured after the selected model, without qualifying a mismatch', async () => {
  const scope = owner(); const parent = owner(); let sentModel: unknown;
  const create = wrapCompletionsCreate(async params => { sentModel = params.model; return completion('sdk-override'); }, { backendId: 'zai-fixture' });
  const sdk = new OpenAIChatCompletionsModel({ chat: { completions: { create } } } as never, 'selected-model-pin');
  await withTrace('byo-provenance-fixture', () => withModelUsageAttribution({ sessionId: parent.sessionId, sourceUserSeq: parent.sourceUserSeq, role: 'brain' }, () => run(scope, () => sdk.getResponse({
    input: 'synthetic', modelSettings: { providerData: { model: 'glm-5.3' } }, tools: [], handoffs: [], outputType: 'text', tracing: false,
  } as never))));
  assert.equal(sentModel, 'glm-5.3'); assert.equal(rows(scope).length, 1); assert.equal(rows(parent).length, 0);
  assertIdentity(rows(scope)[0], scope, 'sdk-override');
  assert.equal(readAcceptedSourceUsage(scope)?.totals.uncachedWorkTokens, 27, 'identity metadata does not change debit');
});

test('native and assembled reply streams retain the dispatch source when consumed in another source', async () => {
  for (const nativeChatCompletionsStream of [true, false]) {
    const scope = owner(); const other = owner(); const id = `stream-${nativeChatCompletionsStream}`;
    const create = wrapCompletionsCreate(async params => {
      assert.equal(params.model, 'glm-5.3');
      return (async function* () {
        yield { id, created: 1, model: 'glm-5.2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ready' }, finish_reason: null }] };
        yield { id, created: 1, model: 'glm-5.2', object: 'chat.completion.chunk', usage: completion(id).usage, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      })();
    }, { backendId: 'zai-fixture', nativeChatCompletionsStream });
    const stream = await run(scope, () => create(body({ stream: true })));
    await run(other, () => drain(stream));
    assert.equal(rows(scope).length, 1); assert.equal(rows(other).length, 0); assertIdentity(rows(scope)[0], scope, id);
  }
});

test('plain and buffered structured repairs retain separate response IDs and the same final request identity', async () => {
  for (const stream of [false, true]) {
    const scope = owner(); let calls = 0;
    const create = wrapCompletionsCreate(async params => {
      calls++; assert.equal(params.model, 'glm-5.3'); assert.equal(params.stream, false);
      return completion(`repair-${stream}-${calls}`, calls === 1 ? 'no parseable json here' : '{"done":true}');
    }, { backendId: 'zai-fixture' });
    const result = await run(scope, () => create(body({ stream, response_format: { type: 'json_schema', json_schema: {
      name: 'fixture', strict: true, schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] },
    } } })));
    if (stream) await drain(result);
    assert.equal(calls, 2); assert.equal(rows(scope).length, 2);
    rows(scope).forEach((row, index) => assertIdentity(row, scope, `repair-${stream}-${index + 1}`));
    assert.equal(readAcceptedSourceUsage(scope)?.totals.uncachedWorkTokens, 54);
  }
});

test('a missing response model stays unavailable while the legacy request fallback remains intact', async () => {
  const scope = owner();
  const create = wrapCompletionsCreate(async () => ({ ...completion('missing-model'), model: undefined }));
  await run(scope, () => create(body()));
  const [row] = rows(scope);
  assert.equal(row.model, 'glm-5.3'); assert.equal(row.requestModel, 'glm-5.3');
  assert.equal(row.providerReportedModel, undefined); assert.equal(row.backendId, undefined);
  assert.equal(row.account, undefined); assert.equal(row.responseId, 'missing-model');
});

test('final request identity is an immutable scalar snapshot and provenance rejects content or URLs', async () => {
  const scope = owner();
  const create = wrapCompletionsCreate(async params => {
    assert.equal(params.model, 'glm-5.3'); params.model = 'changed-after-dispatch'; return completion('snapshot');
  }, { backendId: 'zai-fixture' });
  await run(scope, () => create(body())); assertIdentity(rows(scope)[0], scope, 'snapshot');
  const malformed = owner();
  recordModelUsage({ sessionId: malformed.sessionId, sourceUserSeq: malformed.sourceUserSeq, model: 'legacy-model',
    requestModel: 'https://example.invalid/private?token=synthetic', backendId: 'Bearer synthetic-secret', providerReportedModel: 'raw prompt\ncontent',
    inputTokens: 10, outputTokens: 1, cacheDialect: 'inclusive', responseId: 'malformed-provenance' });
  const [row] = rows(malformed);
  assert.equal(row.requestModel, undefined); assert.equal(row.backendId, undefined); assert.equal(row.providerReportedModel, undefined);
  assert.ok(!JSON.stringify(row).includes('synthetic-secret')); assert.ok(!JSON.stringify(row).includes('https:'));
});

test('configured backend identity partitions cached clients even with identical endpoint, key and model', async () => {
  const backend = { configured: true, baseURL: 'https://provenance-fixture.invalid/v1', apiKey: 'synthetic-same-key', primaryId: 'glm-5.3', judgeId: 'glm-5.3' };
  let calls = 0;
  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)); assert.equal(sent.model, 'glm-5.3'); calls++;
    const response = completion(`cached-${calls}`);
    if (sent.stream) return new Response(`data: ${JSON.stringify({ ...response, object: 'chat.completion.chunk', choices: [
      { index: 0, delta: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' },
    ] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  });
  const request = { input: 'synthetic', modelSettings: {}, tools: [], handoffs: [], outputType: 'text', tracing: false } as never;
  const first = getByoModel('glm-5.3', { ...backend, providerId: 'backend-one' });
  const second = getByoModel('glm-5.3', { ...backend, providerId: 'backend-two' });
  assert.notEqual(first, second);
  assert.equal(first, getByoModel('glm-5.3', { ...backend, providerId: 'backend-one' }));
  const one = owner(), two = owner();
  await run(one, () => first.getResponse(request)); await run(two, () => second.getResponse(request));
  assertIdentity(rows(one)[0], one, 'cached-1', 'backend-one'); assertIdentity(rows(two)[0], two, 'cached-2', 'backend-two');
  assert.ok(!JSON.stringify([...rows(one), ...rows(two)]).includes(backend.apiKey));
});

test('prompt-layout probes carry their own dispatched model and backend without inheriting the triggering source', async (t) => {
  const { INSTRUCTION_CACHE_DELIM } = await import('./model-wire-registry.js');
  const { _resetPromptLayoutForTest, PROMPT_LAYOUT_PROBE_ROUNDS, readPromptLayoutVerdict } = await import('./byo-prompt-layout.js');
  _resetPromptLayoutForTest();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scope = owner(); const baseURL = 'https://provenance-probe-fixture.invalid/v1'; let calls = 0;
  try {
    const create = wrapCompletionsCreate(async params => {
      assert.equal(params.model, 'glm-5.3'); calls++;
      // The probe's callback must retain the sent model, not a mutable body.
      params.model = 'changed-after-dispatch'; return completion(`probe-${calls}`);
    }, { backendId: 'probe-backend', promptLayout: { baseURL } });
    await withModelUsageAttribution({ sessionId: scope.sessionId, sourceUserSeq: scope.sourceUserSeq, role: 'brain' }, () => run(scope, () => create(body({
      messages: [{ role: 'system', content: `fixture stable policy${INSTRUCTION_CACHE_DELIM}fixture turn context` }, { role: 'user', content: 'synthetic' }],
    }))));
    for (let i = 0; i < 16; i++) {
      for (let turn = 0; turn < 40; turn++) await Promise.resolve();
      t.mock.timers.tick(4_000);
    }
    for (let turn = 0; turn < 40; turn++) await Promise.resolve();
    assert.ok(readPromptLayoutVerdict(baseURL, 'glm-5.3'));
    const probes = readUsageEventsForDate().filter(row => row.source === 'prompt-layout-probe' && row.backendId === 'probe-backend');
    assert.equal(probes.length, PROMPT_LAYOUT_PROBE_ROUNDS * 4 + 1);
    assert.equal(rows(scope).length, 1, 'probe spend must not be charged to the triggering source');
    for (const probe of probes) {
      assert.equal(probe.requestModel, 'glm-5.3'); assert.equal(probe.providerReportedModel, 'glm-5.2');
      assert.equal(probe.trace?.acceptedSource, undefined); assert.equal(probe.trace?.attemptId, undefined);
      assert.equal(probe.account, undefined); assert.ok(probe.responseId?.startsWith('probe-'));
    }
  } finally { t.mock.timers.reset(); _resetPromptLayoutForTest(); }
});

test('failed, unreported-usage and legacy raw stream-fallback calls remain explicit provenance gaps', async () => {
  const scope = owner();
  const failed = wrapCompletionsCreate(async () => { throw Object.assign(new Error('synthetic refusal'), { status: 400 }); }, { backendId: 'zai-fixture' });
  await assert.rejects(run(scope, () => failed(body())));
  const noUsage = wrapCompletionsCreate(async () => ({ ...completion('no-usage'), usage: undefined }), { backendId: 'zai-fixture' });
  await run(scope, () => noUsage(body()));
  const fallback = wrapCompletionsCreate(async params => {
    if (params.stream === false) throw Object.assign(new Error('synthetic shape refusal'), { status: 400 });
    return (async function* () { yield { ...completion('raw-fallback'), object: 'chat.completion.chunk' }; })();
  }, { backendId: 'zai-fixture' });
  await drain(await run(scope, () => fallback(body({ stream: true, response_format: { type: 'json_schema', json_schema: { name: 'fixture', schema: { type: 'object' } } } }))));
  assert.equal(rows(scope).length, 0, 'additive provenance never invents usage or certifies these unrecorded paths');
});


// Real accepted owners and actual SDK producers exercise the public lazy boundary.
function nominalBridgeOwner() {
  assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
  const sessionId = `sess-byo-nominal-${++count}`;
  log.createSession({ id: sessionId, kind: 'chat', channel: 'test' });
  const attempt = log.beginRunAttempt(sessionId);
  const source = log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user',
    data: { text: 'Synthetic BYO invocation accounting control.' } });
  return { sessionId, sourceUserSeq: source.seq, runAttemptId: attempt.attemptId, attempt };
}
function nominalBridgeUnder<T>(scope: ReturnType<typeof nominalBridgeOwner>, work: () => T): T {
  return withModelUsageAttribution({ sessionId: scope.sessionId, sourceUserSeq: scope.sourceUserSeq,
    attemptId: scope.runAttemptId, role: 'brain', channel: 'test:byo-nominal' }, () => run(scope, work));
}
const nominalBridgeRequest = { input: 'Synthetic BYO invocation accounting control.', modelSettings: {},
  tools: [], handoffs: [], outputType: 'text', tracing: false } as never;
function nominalBridgeModel(t: { after: (work: () => void) => void }, providerId = 'zai', id = 'nominal-provider',
  script?: (url: unknown, init?: RequestInit) => Promise<Response>) {
  const parity = process.env.CLEMMY_MODEL_PARITY;
  process.env.CLEMMY_MODEL_PARITY = 'on';
  t.after(() => { if (parity === undefined) delete process.env.CLEMMY_MODEL_PARITY; else process.env.CLEMMY_MODEL_PARITY = parity; });
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.ok(String(url).startsWith('https://nominal-byo-fixture.invalid/'), 'unexpected network target refuses');
    if (script) return script(url, init);
    const sent = JSON.parse(String(init?.body)); assert.equal(sent.model, 'glm-5.3');
    const result = completion(id);
    if (!sent.stream) return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    const start = { ...result, object: 'chat.completion.chunk', usage: undefined,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ready' }, finish_reason: null }] };
    const end = { ...result, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(start)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  });
  return getByoModel('glm-5.3', { configured: true, baseURL: 'https://nominal-byo-fixture.invalid/v1',
    apiKey: 'synthetic-no-auth', providerId, primaryId: 'glm-5.3', judgeId: 'glm-5.3' });
}
async function nominalBridgeDone(stream: AsyncIterable<unknown>): Promise<unknown> {
  let original: unknown;
  for await (const item of stream) {
    const event = item as { type?: string; response?: unknown };
    if (event.type === 'response_done') original = event.response;
  }
  assert.ok(original, 'actual SDK response_done is required'); return original;
}

for (const mode of ['buffered', 'native_stream', 'assembled_stream'] as const) {
  test(`BYO nominal bridge supported public same-owner ${mode} retains original UUID separately from provider ID`, async t => {
    const scope = nominalBridgeOwner(); const id = `nominal-${mode}-${count}`;
    const { completedModelResponseBinding } = await import('./model-response-binding.js');
    const { withModelResilienceTelemetry } = await import('./resilient-model.js');
    const events: Array<{ readonly type: string; readonly callId: string; readonly outcome?: string }> = [];
    try {
      const model = nominalBridgeModel(t, mode === 'native_stream' ? 'zai' : 'minimax', id);
      const original = await nominalBridgeUnder(scope, () => withModelResilienceTelemetry(event => { events.push(event); }, async () =>
        mode === 'buffered' ? model.getResponse(nominalBridgeRequest)
          : nominalBridgeDone(model.getStreamedResponse(nominalBridgeRequest))));
      const binding = completedModelResponseBinding(original)!; assert.ok(binding);
      const [row] = rows(scope); assert.equal(rows(scope).length, 1);
      assertIdentity(row, scope, id, mode === 'native_stream' ? 'zai' : 'minimax');
      assert.equal(row.trace?.modelCallId, binding.modelCallId); assert.notEqual(row.responseId, binding.modelCallId);
      assert.equal(binding.physicalAttempt, 1); assert.equal(completedModelResponseBinding({ ...(original as object) }), undefined);
      assert.equal(events.filter(e => e.type === 'call_started').length, 1);
      assert.equal(events.find(e => e.type === 'call_started')?.callId, binding.modelCallId);
      assert.equal(events.find(e => e.type === 'call_finished')?.outcome, 'returned');
      const { listOperationalEvents } = await import('../operational-telemetry.js');
      const operational = listOperationalEvents({ source: 'model', type: 'model_call_completed', sessionId: scope.sessionId, limit: 5 });
      assert.equal(operational.length, 1); assert.equal(operational[0].modelCallId, binding.modelCallId);
      assert.equal(operational[0].payload.responseId, id, 'provider ID stays in its distinct payload field');
    } finally { log.finishRunAttempt(scope.attempt, 'completed'); }
  });
}

test('BYO nominal bridge required public A-create then B-drain cannot attribute the original call to B', async t => {
  const a = nominalBridgeOwner(), b = nominalBridgeOwner();
  try {
    const model = nominalBridgeModel(t, 'zai', `public-lazy-${count}`);
    const { withModelResilienceTelemetry } = await import('./resilient-model.js');
    const originalEvents: string[] = [], foreignEvents: string[] = [];
    const stream = nominalBridgeUnder(a, () => withModelResilienceTelemetry(e => originalEvents.push(e.type), () => model.getStreamedResponse(nominalBridgeRequest)));
    assert.equal(rows(a).length, 0, 'public creation must not start provider work');
    assert.equal(originalEvents.length, 0);
    await nominalBridgeUnder(b, () => withModelResilienceTelemetry(e => foreignEvents.push(e.type), () => nominalBridgeDone(stream)));
    assert.equal(originalEvents.filter(x => x === 'call_started').length, 1);
    assert.equal(foreignEvents.length, 0, 'foreign drainer cannot acquire the original observer');
    assert.equal(rows(a).length, 1, 'the original public owner A must own its usage');
    assert.equal(rows(b).length, 0, 'a drainer cannot become original accounting owner');
  } finally { log.finishRunAttempt(a.attempt, 'completed'); log.finishRunAttempt(b.attempt, 'completed'); }
});

for (const phase of ['retired_before_create', 'retired_before_record'] as const) {
  test(`BYO nominal bridge ${phase} keeps measured quantities and original owner with UUID unknown`, async () => {
    const a = nominalBridgeOwner(), b = nominalBridgeOwner();
    const transport = await import('./model-transport-observation.js');
    const id = `retired-provider-${phase}-${count}`;
    const scope = nominalBridgeUnder(a, () => transport.createModelTransportAttempt(`retired-local-${count}`, 1, transport.captureModelTransportUsageOwner()));
    let release!: () => void, entered!: () => void;
    const atWire = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const create = wrapCompletionsCreate(async () => { entered(); await hold; return completion(id); }, { backendId: 'zai-fixture' });
    try {
      if (phase === 'retired_before_create') transport.finishModelTransportAttempt(scope, 'cancelled');
      const result = nominalBridgeUnder(b, () => transport.withModelTransportAttempt(scope, () => create(body())));
      await atWire;
      if (phase === 'retired_before_record') transport.finishModelTransportAttempt(scope, 'cancelled');
      release(); const output = await result;
      assert.equal((output as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content, 'ready');
      const [row] = rows(a); assert.equal(rows(a).length, 1); assert.equal(rows(b).length, 0);
      assertIdentity(row, a, id); assert.equal(row.trace?.modelCallId, undefined, 'retirement cannot certify a UUID');
    } finally { release?.(); log.finishRunAttempt(a.attempt, 'completed'); log.finishRunAttempt(b.attempt, 'completed'); }
  });
}

for (const mode of ['unsupported', 'captured_empty'] as const) {
  test(`BYO nominal bridge present ${mode} scope cannot adopt foreign chat or workflow B`, async () => {
    const b = nominalBridgeOwner(); const transport = await import('./model-transport-observation.js');
    const { withWorkflowUsageAttribution } = await import('../workflow-usage-context.js');
    const id = `unowned-provider-${mode}-${count}`;
    const scope = mode === 'unsupported'
      ? { modelCallId: `forged-local-${count}`, physicalAttempt: 1, purpose: 'brain' as const,
          owner: { sessionId: b.sessionId, sourceUserSeq: b.sourceUserSeq, runAttemptId: b.runAttemptId, accountingParent: false } }
      : transport.createModelTransportAttempt(`empty-local-${count}`, 1, transport.captureUnavailableModelTransportOwner());
    try {
      const create = wrapCompletionsCreate(async () => completion(id), { backendId: 'zai-fixture' });
      await nominalBridgeUnder(b, () => withWorkflowUsageAttribution('foreign-workflow-b', () =>
        transport.withModelTransportAttempt(scope, () => create(body()))));
      const matches = readUsageEventsForDate().filter(row => row.responseId === id); assert.equal(matches.length, 1);
      const [row] = matches; assert.equal(row.source, 'byo:unowned'); assert.equal(row.kind, 'other');
      assert.equal(row.trace?.acceptedSource, undefined); assert.equal(row.trace?.attemptId, undefined);
      assert.equal(row.trace?.modelCallId, undefined); assert.equal(row.role, undefined); assert.equal(row.runId, undefined);
      assert.equal(row.inputTokens, 100); assert.equal(row.cachedInputTokens, 80); assert.equal(row.outputTokens, 7);
      assert.equal(row.account, undefined); assert.equal(rows(b).length, 0);
    } finally { log.finishRunAttempt(b.attempt, 'completed'); }
  });
}

test('BYO nominal bridge shared provider IDs retain both real SDK invocations and quantity rows', async t => {
  const a = nominalBridgeOwner(); const { completedModelResponseBinding } = await import('./model-response-binding.js');
  try {
    const id = `shared-provider-${count}`; const model = nominalBridgeModel(t, 'zai', id);
    const originals = await nominalBridgeUnder(a, () => Promise.all([1, 2].map(() => model.getResponse(nominalBridgeRequest))));
    const ids = originals.map(original => completedModelResponseBinding(original)?.modelCallId);
    assert.equal(new Set(ids).size, 2); assert.ok(ids.every(Boolean));
    const recorded = rows(a); assert.equal(recorded.length, 2);
    assert.equal(new Set(recorded.map(row => row.trace?.modelCallId)).size, 2);
    assert.ok(recorded.every(row => row.responseId === id && ids.includes(row.trace?.modelCallId)));
    assert.equal(recorded.reduce((sum, row) => sum + row.inputTokens, 0), 200);
    assert.equal(recorded.reduce((sum, row) => sum + row.outputTokens, 0), 14);
  } finally { log.finishRunAttempt(a.attempt, 'completed'); }
});

test('BYO public empty entry cannot adopt the later accepted drainer', async t => {
  const b = nominalBridgeOwner(); const id = `empty-public-${count}`;
  const { modelUsageAttributionStorage } = await import('../usage-log.js');
  try {
    const model = nominalBridgeModel(t, 'zai', id);
    const stream = modelUsageAttributionStorage.run({ sessionId: 'unknown', sourceUserSeq: 0 }, () => model.getStreamedResponse(nominalBridgeRequest));
    await nominalBridgeUnder(b, () => nominalBridgeDone(stream));
    const matches = readUsageEventsForDate().filter(row => row.responseId === id);
    assert.equal(matches.length, 1); assert.equal(matches[0].source, 'byo:unowned');
    assert.equal(matches[0].trace?.modelCallId, undefined); assert.equal(matches[0].trace?.acceptedSource, undefined);
    assert.equal(matches[0].inputTokens, 100); assert.equal(matches[0].outputTokens, 7); assert.equal(rows(b).length, 0);
  } finally { log.finishRunAttempt(b.attempt, 'completed'); }
});

test('BYO public harness-only entry retains A across B drain, but present-empty accounting never falls back', async t => {
  const a = nominalBridgeOwner(), b = nominalBridgeOwner();
  const { modelUsageAttributionStorage } = await import('../usage-log.js');
  try {
    const model = nominalBridgeModel(t, 'zai', `harness-public-${count}`);
    const stream = modelUsageAttributionStorage.run(undefined as never, () => run(a, () => model.getStreamedResponse(nominalBridgeRequest)));
    await nominalBridgeUnder(b, () => nominalBridgeDone(stream));
    assert.equal(rows(a).length, 1); assert.equal(rows(b).length, 0);
    assert.equal(rows(a)[0].trace?.modelCallId, undefined, 'unknown legacy role cannot certify a main-call UUID');
    assert.equal(rows(a)[0].trace?.attemptId, a.runAttemptId);
    const unowned = modelUsageAttributionStorage.run({ sessionId: 'unknown', sourceUserSeq: 0 }, () => run(a, () => model.getStreamedResponse(nominalBridgeRequest)));
    await nominalBridgeUnder(b, () => nominalBridgeDone(unowned));
    assert.equal(rows(a).length, 1); assert.equal(rows(b).length, 0);
    assert.equal(readUsageEventsForDate().filter(row => row.responseId === `harness-public-${count}` && row.source === 'byo:unowned').length, 1);
  } finally { log.finishRunAttempt(a.attempt, 'completed'); log.finishRunAttempt(b.attempt, 'completed'); }
});

test('BYO public entry snapshots original prompt counts and mutable accounting before foreign drain', async t => {
  const a = nominalBridgeOwner(), b = nominalBridgeOwner();
  const { modelUsageAttributionStorage } = await import('../usage-log.js');
  const { completedModelResponseBinding } = await import('./model-response-binding.js');
  try {
    const id = `mutated-public-${count}`, model = nominalBridgeModel(t, 'zai', id);
    const context = { sessionId: a.sessionId, sourceUserSeq: a.sourceUserSeq, attemptId: a.runAttemptId, role: 'brain' as const };
    const components = { system: 40, history: 60 };
    const stream = modelUsageAttributionStorage.run(context, () => harnessRunContextStorage.run({ ...a, promptComponents: components } as never,
      () => model.getStreamedResponse(nominalBridgeRequest)));
    context.sessionId = b.sessionId; context.sourceUserSeq = b.sourceUserSeq; context.attemptId = b.runAttemptId;
    components.system = 999;
    const original = await nominalBridgeUnder(b, () => nominalBridgeDone(stream));
    const [row] = rows(a); assert.equal(rows(a).length, 1); assert.equal(rows(b).length, 0);
    assert.equal(row.trace?.modelCallId, completedModelResponseBinding(original)?.modelCallId);
    assert.equal(row.promptComponents?.system, 40); assert.equal(row.promptComponents?.history, 60);
  } finally { log.finishRunAttempt(a.attempt, 'completed'); log.finishRunAttempt(b.attempt, 'completed'); }
});

test('BYO public retry, failed fallback, cancel and missing usage keep distinct local outcomes without invented token rows', async t => {
  const a = nominalBridgeOwner(), b = nominalBridgeOwner();
  const { withModelTransportRecorder } = await import('./model-transport-observation.js');
  const { completedModelResponseBinding } = await import('./model-response-binding.js');
  let mode: 'retry' | 'failed' | 'success' | 'no-usage' = 'retry', fetches = 0;
  const local: Readonly<Record<string, unknown>>[] = [];
  try {
    const script = async (_url: unknown, init?: RequestInit) => {
      fetches++;
      if (mode === 'failed' || (mode === 'retry' && fetches === 1)) return new Response(JSON.stringify({ error: { message: 'Synthetic fixture refusal' } }),
        { status: mode === 'failed' ? 400 : 500, headers: { 'content-type': 'application/json' } });
      const sent = JSON.parse(String(init?.body));
      const result = completion(`outcome-${fetches}`);
      if (mode === 'no-usage') delete (result as Partial<typeof result>).usage;
      if (!sent.stream) return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
      return new Response(`data: ${JSON.stringify({ ...result, object: 'chat.completion.chunk', choices: [{ index: 0,
        delta: { content: 'ready' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    const model = nominalBridgeModel(t, 'zai', `outcomes-public-${count}`, script);
    const under = <T>(work: () => T) => withModelTransportRecorder(row => local.push(row), () => nominalBridgeUnder(a, work));
    const stream = under(() => model.getStreamedResponse(nominalBridgeRequest));
    const original = await nominalBridgeUnder(b, () => nominalBridgeDone(stream));
    assert.equal(fetches, 2); assert.equal(rows(a).length, 1); assert.equal(rows(b).length, 0);
    assert.equal(completedModelResponseBinding(original)?.physicalAttempt, 2);
    assert.deepEqual(local.filter(row => row.phase === 'adapter_attempt_finished').map(row => row.outcome), ['failed', 'returned']);
    assert.equal(rows(a)[0].inputTokens, 100); assert.equal(rows(a)[0].outputTokens, 7);
    mode = 'failed'; await assert.rejects(under(() => model.getResponse(nominalBridgeRequest)));
    assert.equal(rows(a).length, 1, 'a failed route has unknown usage, not a zero debit');
    mode = 'success'; await under(() => model.getResponse(nominalBridgeRequest));
    assert.equal(rows(a).length, 2, 'a later successful route records its own separate invocation');
    assert.notEqual(rows(a)[0].trace?.modelCallId, rows(a)[1].trace?.modelCallId);
    const abort = new AbortController();
    const cancelled = under(() => model.getStreamedResponse({ ...(nominalBridgeRequest as Record<string, unknown>), signal: abort.signal } as never));
    abort.abort(); const before = fetches;
    await assert.rejects(nominalBridgeUnder(b, () => nominalBridgeDone(cancelled)));
    assert.equal(fetches, before); assert.equal(rows(a).length, 2);
    mode = 'no-usage'; await under(() => model.getResponse(nominalBridgeRequest));
    assert.equal(rows(a).length, 2, 'a completion lacking usage cannot fabricate quantities');
    assert.ok(local.some(row => row.phase === 'adapter_attempt_finished' && row.outcome === 'failed'));
  } finally { log.finishRunAttempt(a.attempt, 'completed'); log.finishRunAttempt(b.attempt, 'completed'); }
});

test('a background job outside any turn keeps its own job accounting, and invents no turn', async () => {
  const transport = await import('./model-transport-observation.js');
  const { runMemoryJob } = await import('../../memory/memory-work-journal.js');
  const id = `background-job-${++count}`;
  const create = wrapCompletionsCreate(async () => completion(id), { backendId: 'zai-fixture' });
  await runMemoryJob('learn', { source: { kind: 'schedule' } }, async () => {
    const scope = transport.createModelTransportAttempt(`background-local-${count}`, 1, transport.captureModelTransportUsageOwner());
    await transport.withModelTransportAttempt(scope, () => create(body()));
  }, () => ({ outcome: 'nothing_new' }));
  const matches = readUsageEventsForDate().filter(row => row.responseId === id);
  assert.equal(matches.length, 1);
  const [row] = matches;
  assert.equal(row.channel, 'memory:learn');
  assert.equal(row.kind, 'background');
  assert.match(String(row.source), /^memory:learn:/);
  assert.equal(row.trace?.acceptedSource, undefined, 'no turn is invented');
  assert.equal(row.inputTokens, 100); assert.equal(row.outputTokens, 7);
});
