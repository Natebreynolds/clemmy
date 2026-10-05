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
