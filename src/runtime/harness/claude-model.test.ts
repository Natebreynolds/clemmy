import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyClaudeEnvelope,
  withIdentityPrefix,
  ClaudeModelProvider,
  sanitizeClaudeInput,
  aisdkAcceptsReasoning,
  withClaudeInputSanitizer,
  withClaudeRequestDefaults,
  getClaudeModel,
  resetClaudeModelCache,
  ClaudeTransportRoutingModel,
  rawClaudeUsageFields,
  withRawClaudeUsageRecording,
  extractClaudeThinkingText,
  watchClaudeThinkingForLiveness,
  claudeStreamEventKind,
  restoreClaudeWireToolNames,
} from './claude-model.js';
import { ClaudeHeadlessModel, setClaudeHeadlessCliAvailableForTest } from './claude-headless-model.js';
import { resolveModelCapability } from './model-wire-registry.js';
import { harnessRunContextStorage } from './brackets.js';
import type { RawClaudeStreamDiagnostic } from './claude-stream-diagnostics.js';

const ID = "You are Claude Code, Anthropic's official CLI for Claude.".replace('Claude', 'Claude'); // exact identity
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

test('raw Claude usage normalizes cached tokens for run budgets and efficiency telemetry', () => {
  const fields = rawClaudeUsageFields({
    usage: {
      inputTokens: 120,
      outputTokens: 8,
      totalTokens: 128,
      inputTokensDetails: [
        { cacheCreationInputTokens: 30 },
        { cacheReadInputTokens: 70 },
      ],
    },
    output: [],
    responseId: 'msg_raw_1',
  } as never);
  assert.deepEqual(fields, {
    inputTokens: 120,
    cachedInputTokens: 70,
    outputTokens: 8,
    totalTokens: 128,
    responseId: 'msg_raw_1',
  });
});

test('raw Claude streamed usage records the response.id correlation used by response_done events', async () => {
  const recorded: Array<Record<string, unknown>> = [];
  const response = {
    id: 'msg_stream_raw_1',
    usage: {
      inputTokens: 42,
      outputTokens: 7,
      totalTokens: 49,
    },
    output: [],
  };
  const inner = {
    getResponse: async () => response,
    getStreamedResponse: async function* () {
      yield { type: 'response_started' };
      yield { type: 'response_done', response };
    },
  };
  const wrapped = withRawClaudeUsageRecording(
    inner as never,
    'claude-opus-4-8',
    (entry) => recorded.push(entry as unknown as Record<string, unknown>),
  );

  const seen: unknown[] = [];
  for await (const event of wrapped.getStreamedResponse({} as never)) seen.push(event);

  assert.equal(seen.length, 2, 'the accounting decorator is stream-transparent');
  assert.equal(recorded.length, 1, 'one completed stream produces one usage event');
  assert.equal(recorded[0]?.responseId, 'msg_stream_raw_1');
  assert.equal(recorded[0]?.inputTokens, 42);
  assert.equal(recorded[0]?.outputTokens, 7);
});

test('raw Claude usage rows are inclusive: the adapter reports fresh input, cache writes and cache reads as one total', async () => {
  const { canonicalCacheAccounting } = await import('../usage-log.js');
  const recorded: Array<Record<string, unknown>> = [];
  // Anthropic reported input_tokens 4,229 and cache_read_input_tokens 9,688;
  // the adapter hands the harness the 13,917 total with the read broken out.
  const response = {
    id: 'msg_dialect_1',
    usage: {
      inputTokens: 13_917,
      outputTokens: 3,
      totalTokens: 13_920,
      inputTokensDetails: [{ cacheReadInputTokens: 9_688 }],
    },
    output: [],
  };
  const wrapped = withRawClaudeUsageRecording(
    { getResponse: async () => response, getStreamedResponse: async function* () { /* unused */ } } as never,
    'claude-opus-5',
    (entry) => recorded.push(entry as unknown as Record<string, unknown>),
  );
  await wrapped.getResponse({} as never);
  assert.equal(recorded[0]?.cacheDialect, 'inclusive');
  const canonical = canonicalCacheAccounting(recorded[0] as never);
  assert.equal(canonical.cachedReadTokens, 9_688);
  assert.equal(canonical.uncachedInputTokens, 4_229, 'uncached is the total minus what the cache served');
});

for (const shape of ['empty', 'refusal', 'text', 'tool'] as const) {
  test(`raw Claude diagnostics preserve real adapter ${shape} metadata without content or another request`, async () => {
    const { aisdk } = await import('@openai/agents-extensions/ai-sdk');
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    let calls = 0;
    const rawStop = shape === 'refusal' ? 'refusal' : shape === 'tool' ? 'tool_use' : 'end_turn';
    const blocks = [
      { type: 'message_start', message: { id: 'msg_diagnostic_fixture', type: 'message', role: 'assistant',
        model: 'claude-sonnet-5-20261005', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 42, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: shape === 'tool'
        ? { type: 'tool_use', id: 'toolu_fixture', name: 'read_file', input: {} }
        : { type: 'text', text: '' } },
      ...(shape === 'text' ? [{ type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'PRIVATE_TEXT_é' } }] : []),
      ...(shape === 'tool' ? [{ type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":"PRIVATE_TOOL_ARGUMENT"}' } }] : []),
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: rawStop, stop_sequence: null }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ];
    const provider = createAnthropic({ apiKey: 'fixture-only', fetch: async () => {
      calls += 1;
      return new Response(blocks.map((block) => `event: ${block.type}\ndata: ${JSON.stringify(block)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } });
    } });
    const usage: Array<Record<string, unknown>> = [];
    const diagnostics: RawClaudeStreamDiagnostic[] = [];
    const wrapped = withRawClaudeUsageRecording(aisdk(provider('claude-sonnet-5')), 'claude-sonnet-5',
      (entry) => usage.push(entry as unknown as Record<string, unknown>), () => {},
      (entry) => diagnostics.push(entry));
    const owner = { sessionId: 'claude-diagnostic-owner', sourceUserSeq: 44, turn: 2, runAttemptId: 'attempt:fixture' };
    const stream = harnessRunContextStorage.run(owner as never, () => wrapped.getStreamedResponse({
      input: 'PRIVATE_PROMPT', tools: [], handoffs: [], outputType: 'text', modelSettings: {}, tracing: false,
    } as never));
    // Creation owns attribution; a later drain must not rebind it or observe a
    // mutation to the original async-local context object.
    owner.sourceUserSeq = 999;
    const events: any[] = [];
    await harnessRunContextStorage.run({ sessionId: 'wrong-drain-owner', sourceUserSeq: 888 } as never, async () => {
      for await (const event of stream) events.push(event);
    });
    assert.equal(calls, 1);
    assert.equal(diagnostics.length, 1);
    assert.equal(usage.length, 1);
    const diagnostic = diagnostics[0]!;
    assert.equal(diagnostic.sessionId, 'claude-diagnostic-owner');
    assert.equal(diagnostic.sourceUserSeq, 44);
    assert.equal(diagnostic.turn, 2);
    assert.equal(diagnostic.attemptId, 'attempt:fixture');
    assert.equal(diagnostic.transport, 'raw_messages');
    assert.equal(diagnostic.settlement, 'completed');
    assert.equal(diagnostic.requestModel, 'claude-sonnet-5');
    assert.equal(diagnostic.providerReportedModel, 'claude-sonnet-5-20261005');
    assert.equal(diagnostic.responseId, 'msg_diagnostic_fixture');
    assert.equal(diagnostic.eventTypeCounts.response_done, 1);
    assert.equal(diagnostic.sawResponseDone, true);
    assert.equal(usage[0]?.model, 'claude-sonnet-5', 'existing usage grouping remains the requested model');
    assert.equal(usage[0]?.requestModel, 'claude-sonnet-5');
    assert.equal(usage[0]?.providerReportedModel, 'claude-sonnet-5-20261005');
    assert.equal(usage[0]?.sourceUserSeq, 44);
    assert.equal(usage[0]?.account, undefined, 'response metadata cannot invent a billed account');
    const done = events.find((event) => event.type === 'response_done').response;
    assert.equal(done.providerData.model, 'claude-sonnet-5-20261005');
    assert.deepEqual(done.providerData.finishReason, {
      unified: shape === 'refusal' ? 'content-filter' : shape === 'tool' ? 'tool-calls' : 'stop', raw: rawStop,
    });
    if (shape === 'text') {
      assert.equal(diagnostic.contentBytes.providerTextDelta, Buffer.byteLength('PRIVATE_TEXT_é'));
      assert.equal(diagnostic.contentBytes.outputTextDelta, Buffer.byteLength('PRIVATE_TEXT_é'));
      assert.equal(diagnostic.contentBytes.finalText, Buffer.byteLength('PRIVATE_TEXT_é'));
      assert.equal(done.output[0].content[0].text, 'PRIVATE_TEXT_é');
    } else {
      assert.equal(diagnostic.contentBytes.finalText, 0);
      if (shape === 'tool') {
        assert.equal(diagnostic.outputItemTypeCounts.function_call, 1);
        assert.equal(done.output[0].arguments, '{"path":"PRIVATE_TOOL_ARGUMENT"}');
      } else {
        assert.equal(diagnostic.eventTypeCounts['model.text-start'], 1);
        assert.equal(diagnostic.eventTypeCounts['model.text-end'], 1);
        assert.deepEqual(done.output, [], 'diagnostics do not manufacture output');
      }
    }
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_|fixture-only/);
  });
}

test('raw Claude diagnostics are bounded, source-bound, and best effort on errors or early close', async () => {
  const diagnostics: RawClaudeStreamDiagnostic[] = [];
  const failure = new Error('PRIVATE_ERROR');
  const metadataEvents = [
    { type: 'model', event: { type: 'response-metadata', modelId: 'https://PRIVATE_MODEL', id: 'PRIVATE_ID', metadata: 'PRIVATE_METADATA' } },
    { type: 'model', event: { type: 'finish', finishReason: { unified: 'PRIVATE_REASON', nested: 'PRIVATE_METADATA' } } },
    ...Array.from({ length: 100 }, (_, index) => ({ type: 'model', event: { type: `PRIVATE_EVENT_${index}` } })),
  ];
  const wrapped = withRawClaudeUsageRecording({
    getResponse: async () => { throw failure; },
    getStreamedResponse: async function* () { yield* metadataEvents; throw failure; },
  } as never, 'claude-sonnet-5', () => {}, () => {}, (entry) => diagnostics.push(entry));
  const create = () => harnessRunContextStorage.run({ sessionId: 'diagnostic-error', sourceUserSeq: 45 } as never,
    () => wrapped.getStreamedResponse({} as never));
  await assert.rejects(async () => { for await (const _ of create()) { /* consume */ } }, (error) => error === failure);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.settlement, 'error');
  assert.equal(diagnostics[0]?.eventTypeCounts['model.other'], 100);
  assert.equal(diagnostics[0]?.unrecognizedModelMetadata, true);
  assert.equal(diagnostics[0]?.unrecognizedFinishMetadata, true);
  assert.equal(diagnostics[0]?.providerReportedModel, undefined);
  assert.equal(diagnostics[0]?.finishReason, undefined);
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_/);
  assert.ok(JSON.stringify(diagnostics[0]).length < 2_000, 'unknown event names cannot grow the diagnostic vocabulary');
  for await (const _ of create()) break;
  assert.equal(diagnostics.length, 2, 'early close writes only one further record');
  assert.equal(diagnostics[1]?.settlement, 'closed');
  await assert.rejects(async () => { for await (const _ of wrapped.getStreamedResponse({} as never)) { /* no owner */ } });
  assert.equal(diagnostics.length, 2, 'unattributed streams cannot mint a source diagnostic');
  await assert.rejects(async () => {
    const invalidOwnerStream = harnessRunContextStorage.run({ sessionId: 'x'.repeat(300), sourceUserSeq: 47 } as never,
      () => wrapped.getStreamedResponse({} as never));
    for await (const _ of invalidOwnerStream) { /* consume */ }
  });
  assert.equal(diagnostics.length, 2, 'oversized source identities cannot create unbounded diagnostics');
  const brokenRecorder = withRawClaudeUsageRecording({
    getResponse: async () => { throw failure; },
    getStreamedResponse: async function* () { yield { type: 'response_done', response: { output: [], usage: {} } }; },
  } as never, 'claude-sonnet-5', () => {}, () => {}, () => { throw new Error('diagnostic persistence failed'); });
  const events: unknown[] = [];
  await harnessRunContextStorage.run({ sessionId: 'diagnostic-error', sourceUserSeq: 46 } as never, async () => {
    for await (const event of brokenRecorder.getStreamedResponse({} as never)) events.push(event);
  });
  assert.equal(events.length, 1, 'failed diagnostic storage cannot break a completed stream');
});

test('raw Claude metadata projection preserves existing final metadata and output bytes', async () => {
  const original = { id: 'msg_existing_fixture', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PRIVATE_TEXT' }] }],
    providerData: { model: 'claude-existing-fixture', finishReason: 'length', privateField: 'PRIVATE_METADATA' } };
  const before = JSON.stringify(original);
  const usage: Array<Record<string, unknown>> = [];
  const wrapped = withRawClaudeUsageRecording({
    getResponse: async () => original,
    getStreamedResponse: async function* () {
      yield { type: 'model', event: { type: 'response-metadata', id: original.id, modelId: 'claude-provider-fixture' } };
      yield { type: 'model', event: { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' } } };
      yield { type: 'response_done', response: original };
    },
  } as never, 'claude-request-fixture', (entry) => usage.push(entry as unknown as Record<string, unknown>), () => {});
  const events: any[] = [];
  for await (const event of wrapped.getStreamedResponse({} as never)) events.push(event);
  const done = events.find((event) => event.type === 'response_done').response;
  assert.equal(JSON.stringify(original), before, 'observation cannot mutate the inner response');
  assert.deepEqual(done.output, original.output);
  assert.equal(done.id, original.id);
  assert.equal(done.providerData.model, 'claude-existing-fixture');
  assert.equal(done.providerData.finishReason, 'length', 'do not erase an existing termination field');
  assert.equal(done.providerData.providerReportedModel, 'claude-provider-fixture');
  assert.equal(usage[0]?.requestModel, 'claude-request-fixture');
  assert.equal(usage[0]?.providerReportedModel, 'claude-provider-fixture');
});

test('raw Claude diagnostics persist once in the exact source trace and stay off the public event plane', async () => {
  const { createSession, appendEvent, listEvents } = await import('./eventlog.js');
  const { projectHarnessEventForPublic } = await import('./public-presentation.js');
  const session = createSession({ kind: 'chat', channel: 'test', title: 'Raw Claude metadata fixture' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'fixture' } });
  const wrapped = withRawClaudeUsageRecording({
    getResponse: async () => { throw new Error('unused'); },
    getStreamedResponse: async function* () {
      yield { type: 'model', event: { type: 'response-metadata', id: 'msg_persisted_fixture', modelId: 'claude-sonnet-5' } };
      yield { type: 'model', event: { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' } } };
      yield { type: 'response_done', response: { output: [], usage: {} } };
    },
  } as never, 'claude-sonnet-5', () => {}, () => {});
  await harnessRunContextStorage.run({ sessionId: session.id, sourceUserSeq: source.seq, turn: 1,
    runAttemptId: 'attempt:durable-fixture' } as never, async () => {
    for await (const _ of wrapped.getStreamedResponse({} as never)) { /* consume */ }
  });
  const rows = listEvents(session.id).filter((row) => row.type === 'model_stream_diagnostic');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.data.sourceUserSeq, source.seq);
  assert.equal(rows[0]?.data.attemptId, 'attempt:durable-fixture');
  assert.equal(rows[0]?.data.responseId, 'msg_persisted_fixture');
  assert.equal(rows[0]?.turn, 1);
  assert.equal(projectHarnessEventForPublic(rows[0]!), null, 'diagnostic metadata is never a public lifecycle event');
});

test('envelope: x-api-key is STRIPPED and OAuth Bearer is set (the billing guard)', () => {
  const { headers } = applyClaudeEnvelope({ headers: { 'x-api-key': 'sk-ant-api03-would-bill-api', 'content-type': 'application/json' } }, 'sk-ant-oat01-good');
  assert.equal(headers.has('x-api-key'), false, 'x-api-key must be removed → never API-bill');
  assert.equal(headers.get('authorization'), 'Bearer sk-ant-oat01-good');
  assert.match(headers.get('anthropic-beta') || '', /oauth-2025-04-20/);
  assert.equal(headers.get('content-type'), 'application/json', 'other headers preserved');
});

test('envelope: an existing anthropic-beta (e.g. thinking) is preserved alongside the oauth beta', () => {
  const { headers } = applyClaudeEnvelope({ headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } }, 'sk-ant-oat01-x');
  const beta = headers.get('anthropic-beta') || '';
  assert.match(beta, /oauth-2025-04-20/);
  assert.match(beta, /interleaved-thinking/);
});

test('envelope: the Claude-Code identity is injected into the request body system', () => {
  const { body } = applyClaudeEnvelope({ body: JSON.stringify({ model: 'claude-opus-4-8', system: 'Be helpful.', messages: [] }) }, 'sk-ant-oat01-x');
  const parsed = JSON.parse(body as string);
  assert.ok(Array.isArray(parsed.system));
  assert.equal(parsed.system[0].text, IDENTITY);
});

test('envelope: a missing max_tokens is filled (Anthropic requires it); a present one is left alone', () => {
  const filled = JSON.parse(applyClaudeEnvelope({ body: JSON.stringify({ model: 'x', messages: [] }) }, 'sk-ant-oat01-x').body as string);
  assert.equal(typeof filled.max_tokens, 'number');
  assert.ok(filled.max_tokens > 0);
  const kept = JSON.parse(applyClaudeEnvelope({ body: JSON.stringify({ model: 'x', messages: [], max_tokens: 512 }) }, 'sk-ant-oat01-x').body as string);
  assert.equal(kept.max_tokens, 512, 'harness-set max_tokens is not overridden');
});

test('Claude request defaults reach the adapter on both paths, preserve explicit values, and honor capability caps', async () => {
  const seen: Array<{ maxTokens?: number; temperature?: number }> = [];
  const inner = {
    getResponse: async (request: { modelSettings?: { maxTokens?: number; temperature?: number } }) => {
      seen.push({ ...request.modelSettings });
      return { output: [], usage: {} };
    },
    getStreamedResponse: async function* (request: { modelSettings?: { maxTokens?: number; temperature?: number } }) {
      seen.push({ ...request.modelSettings });
      yield { type: 'response_started' };
    },
  };

  const normal = withClaudeRequestDefaults(inner as never, resolveModelCapability('claude-sonnet-5'));
  await normal.getResponse({ input: 'default me' } as never);
  await normal.getResponse({
    input: 'preserve me',
    modelSettings: { maxTokens: 512, temperature: 0.2 },
  } as never);

  const capped = withClaudeRequestDefaults(inner as never, { maxOutput: 8_192 } as never);
  for await (const _ of capped.getStreamedResponse({ input: 'cap me' } as never)) {
    void _;
  }

  assert.deepEqual(seen, [
    { maxTokens: resolveModelCapability('claude-sonnet-5').maxOutput },
    { maxTokens: 512, temperature: 0.2 },
    { maxTokens: 8_192 },
  ]);
});

test('withIdentityPrefix: string / empty / array / already-prefixed', () => {
  assert.deepEqual(withIdentityPrefix(''), [{ type: 'text', text: IDENTITY }]);
  assert.deepEqual(withIdentityPrefix('hi'), [{ type: 'text', text: IDENTITY }, { type: 'text', text: 'hi' }]);
  const already = [{ type: 'text', text: IDENTITY + ' extra' }];
  assert.equal(withIdentityPrefix(already), already, 'not double-prefixed');
  const arr = [{ type: 'text', text: 'sys' }];
  const out = withIdentityPrefix(arr) as Array<{ text: string }>;
  assert.equal(out[0].text, IDENTITY);
  assert.equal(out[1].text, 'sys');
});

test('ClaudeModelProvider: constructs a Model; non-claude ids map to the brain model', () => {
  const p = new ClaudeModelProvider();
  const m1 = p.getModel('claude-opus-4-8');
  assert.equal(typeof (m1 as { getStreamedResponse?: unknown }).getStreamedResponse, 'function');
  // a gpt-5* tier name still yields a (Claude) Model — the whole harness runs on Claude
  const m2 = p.getModel('gpt-5.4');
  assert.equal(typeof (m2 as { getStreamedResponse?: unknown }).getStreamedResponse, 'function');
});

test('aisdkAcceptsReasoning: only string-text content is accepted (matches the adapter guard)', () => {
  assert.equal(aisdkAcceptsReasoning({ content: [{ text: 'I should…' }] }), true);
  assert.equal(aisdkAcceptsReasoning({ content: [] }), false, 'Codex reasoning: empty content array');
  assert.equal(aisdkAcceptsReasoning({}), false, 'no content at all');
  assert.equal(aisdkAcceptsReasoning({ content: [{ text: 42 }] }), false, 'non-string text');
});

test('sanitizeClaudeInput: drops ONLY the Codex-shaped reasoning that would crash the aisdk adapter', () => {
  const input = [
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'reasoning', content: [], encrypted_content: 'opaque' }, // Codex — would throw
    { type: 'reasoning', content: [{ text: 'visible thought' }] },   // well-formed — keep
    { type: 'function_call', name: 'focus_get', arguments: '{}' },
  ];
  const out = sanitizeClaudeInput(input) as Array<{ type: string }>;
  assert.equal(out.length, 3, 'one empty-content reasoning item dropped');
  assert.deepEqual(out.map((i) => i.type), ['message', 'reasoning', 'function_call']);
  // the surviving reasoning is the well-formed one
  const keptReasoning = out.find((i) => i.type === 'reasoning') as { content: Array<{ text: string }> };
  assert.equal(keptReasoning.content[0].text, 'visible thought');
});

test('sanitizeClaudeInput: a string input and a clean array are returned UNCHANGED (same reference)', () => {
  assert.equal(sanitizeClaudeInput('plain string input'), 'plain string input');
  const clean = [{ type: 'message', role: 'user', content: 'hi' }];
  assert.equal(sanitizeClaudeInput(clean), clean, 'no reasoning to strip → same array reference (no churn)');
});

test('withClaudeInputSanitizer: forwards SANITIZED input to the inner model on both paths', async () => {
  const seen: { getResponse?: unknown; getStreamed?: unknown } = {};
  const inner = {
    getResponse: async (req: { input?: unknown }) => { seen.getResponse = req.input; return { output: [], usage: {} } as never; },
    // eslint-disable-next-line require-yield
    getStreamedResponse: async function* (req: { input?: unknown }) { seen.getStreamed = req.input; },
  };
  const wrapped = withClaudeInputSanitizer(inner as never);
  const dirty = [
    { type: 'reasoning', content: [] },
    { type: 'message', role: 'user', content: 'go' },
  ];
  await wrapped.getResponse({ input: dirty } as never);
  for await (const _ of wrapped.getStreamedResponse({ input: dirty } as never)) { void _; }
  const r = seen.getResponse as Array<{ type: string }>;
  const s = seen.getStreamed as Array<{ type: string }>;
  assert.deepEqual(r.map((i) => i.type), ['message'], 'getResponse received sanitized input');
  assert.deepEqual(s.map((i) => i.type), ['message'], 'getStreamedResponse received sanitized input');
});

test('getClaudeModel: headless transport falls back to the raw_messages adapter when the `claude` CLI is missing', () => {
  const prevTransport = process.env.CLEMMY_CLAUDE_TRANSPORT;
  process.env.CLEMMY_CLAUDE_TRANSPORT = 'headless';
  try {
    // CLI present → the per-request TRANSPORT ROUTER (2026-07-24): text-only
    // requests ride headless; tool-bearing requests ride the raw Messages
    // adapter — the claude harness lane is always tool-capable now.
    setClaudeHeadlessCliAvailableForTest(true);
    resetClaudeModelCache();
    const routed = getClaudeModel('claude-opus-4-8');
    assert.ok(routed instanceof ClaudeTransportRoutingModel, 'CLI present → per-request transport router');

    // CLI missing → must NOT commit to headless (every turn would spawn ENOENT
    // with no auto-recovery); fall back to the raw Messages adapter, which uses
    // the same oat01 subscription token.
    setClaudeHeadlessCliAvailableForTest(false);
    resetClaudeModelCache();
    const fallback = getClaudeModel('claude-opus-4-8');
    assert.ok(!(fallback instanceof ClaudeHeadlessModel), 'CLI missing → raw_messages fallback, not headless');
    assert.equal(typeof (fallback as { getStreamedResponse?: unknown }).getStreamedResponse, 'function', 'fallback is a valid streaming Model');
  } finally {
    setClaudeHeadlessCliAvailableForTest(null);
    resetClaudeModelCache();
    if (prevTransport === undefined) delete process.env.CLEMMY_CLAUDE_TRANSPORT;
    else process.env.CLEMMY_CLAUDE_TRANSPORT = prevTransport;
  }
});

function envelopeBody(obj: Record<string, unknown>): Record<string, unknown> {
  const out = applyClaudeEnvelope({ body: JSON.stringify(obj) }, 'sk-ant-oat01-x');
  return JSON.parse(out.body as string) as Record<string, unknown>;
}

test('transcript caching: a large transcript gets a cache_control breakpoint on the last message (fusion re-send fix)', () => {
  const big = 'lorem ipsum dolor sit amet '.repeat(1000); // ~27K chars ≈ 6.8K tok > opus 4096 min
  const parsed = envelopeBody({
    model: 'claude-opus-4-8',
    system: 'Be helpful.',
    messages: [
      { role: 'user', content: big },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'tail' },
    ],
    max_tokens: 100,
  });
  const msgs = parsed.messages as Array<Record<string, unknown>>;
  const last = msgs[msgs.length - 1];
  // string content wrapped into a cacheable text block
  assert.ok(Array.isArray(last.content), 'last message content wrapped to a block array');
  const block = (last.content as Array<Record<string, unknown>>).at(-1)!;
  assert.deepEqual(block.cache_control, { type: 'ephemeral' });
});

test('transcript caching: harness system packets are hoisted BEFORE the breakpoint pass, so the marker lands on the last real message', () => {
  // Live 2026-09-01: the host lane appends role:'system' packets (context
  // packet, memory primer, one-shot directive) after the transcript. Placing
  // the breakpoint first put it on a packet that the hoist then removed from
  // `messages` — no transcript ever cached; every frame re-billed 40–90k.
  const big = 'lorem ipsum dolor sit amet '.repeat(1000);
  const parsed = envelopeBody({
    model: 'claude-sonnet-5',
    system: 'Be helpful.',
    messages: [
      { role: 'user', content: big },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'rows' }] },
      { role: 'system', content: 'context packet' },
      { role: 'system', content: 'memory primer' },
    ],
    max_tokens: 100,
  });
  const msgs = parsed.messages as Array<Record<string, unknown>>;
  assert.equal(msgs.length, 3, 'the packets left `messages`');
  assert.ok(msgs.every((m) => m.role !== 'system'));
  const last = msgs[msgs.length - 1]!;
  const lastBlock = (last.content as Array<Record<string, unknown>>).at(-1)!;
  assert.equal(lastBlock.type, 'tool_result');
  assert.deepEqual(lastBlock.cache_control, { type: 'ephemeral' }, 'the transcript breakpoint is on the newest real message');
  const sys = parsed.system as Array<Record<string, unknown>>;
  const sysText = sys.map((b) => String(b.text)).join('\n');
  assert.match(sysText, /context packet/);
  assert.match(sysText, /memory primer/);
  const markers = JSON.stringify(parsed).split('"cache_control"').length - 1;
  assert.ok(markers >= 1 && markers <= 4, `Anthropic allows at most 4 markers, got ${markers}`);
});

test('transcript caching: a SMALL transcript is NOT breakpointed (below cacheMinTokens — a wasted marker)', () => {
  const parsed = envelopeBody({
    model: 'claude-opus-4-8',
    system: 'Be helpful.',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
  });
  const last = (parsed.messages as Array<Record<string, unknown>>).at(-1)!;
  // untouched: still a plain string, no cache_control
  assert.equal(last.content, 'hi');
});

test('transcript caching: the whole prefix clears the minimum, not the messages alone (worker with tools + short transcript)', () => {
  // Live 10-02: an Opus worker sent 10 calls, 121k prompt tokens, 0 cached:
  // its ~3k-token tool list and short transcript each fell under the minimum
  // while the prefix the breakpoint caches (tools + system + messages) did not.
  const tools = Array.from({ length: 12 }, (_, i) => ({
    name: `tool_${i}`,
    description: 'Reads one record from the project store and returns its fields. '.repeat(14),
    input_schema: { type: 'object', properties: { id: { type: 'string', description: 'record id '.repeat(10) } } },
  }));
  const parsed = envelopeBody({
    model: 'claude-opus-4-8',
    system: 'You are a worker. '.repeat(220),
    tools,
    messages: [{ role: 'user', content: 'Do the task: '.repeat(450) }],
    max_tokens: 100,
  });
  // Each part is under Opus's 4,096-token minimum on its own; together they are not.
  assert.ok(JSON.stringify(parsed.tools).length / 4 < 4096 && JSON.stringify(parsed.messages).length / 4 < 4096);
  const last = (parsed.messages as Array<Record<string, unknown>>).at(-1)!;
  assert.ok(Array.isArray(last.content), 'the transcript breakpoint is placed');
  assert.deepEqual((last.content as Array<Record<string, unknown>>).at(-1)!.cache_control, { type: 'ephemeral' });
  const markers = JSON.stringify(parsed).split('"cache_control"').length - 1;
  assert.ok(markers >= 1 && markers <= 4, `Anthropic allows at most 4 markers, got ${markers}`);
});

void ID;

// The router's contract, unit-level: tools → raw adapter; text-only → headless.
test('ClaudeTransportRoutingModel picks the transport per request', async () => {
  const calls: string[] = [];
  const stub = (name: string) => ({
    async getResponse() { calls.push(`${name}:get`); return { output: [], usage: {} }; },
    async *getStreamedResponse() { calls.push(`${name}:stream`); yield { type: 'response_started' }; },
  });
  const router = new ClaudeTransportRoutingModel(stub('headless') as never, stub('raw') as never);
  await router.getResponse({ input: 'hi', tools: [], handoffs: [] } as never);
  await router.getResponse({ input: 'hi', tools: [{ name: 'run_shell_command' }], handoffs: [] } as never);
  for await (const _ of router.getStreamedResponse({ input: 'hi', tools: [], handoffs: [{}] } as never)) break;
  assert.deepEqual(calls, ['headless:get', 'raw:get', 'raw:stream']);
});

// ─── Assistant-terminal conversations gain a user continuation ───────────────
//
// Live 2026-08-25 (workflow continuation, claude-sonnet-5): the loop's
// auto-continue checkpoint left the conversation assistant-terminal, which
// Anthropic rejects on models without prefill support ("This model does not
// support assistant message prefill") while the Codex wire accepts — the
// same run shape worked on one family and killed the other.
test('envelope: an assistant-terminal conversation gains one neutral user continuation', () => {
  const shimmed = JSON.parse(applyClaudeEnvelope({ body: JSON.stringify({
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: 'do the work' },
      { role: 'assistant', content: 'checkpoint: partial progress' },
    ],
  }) }, 'sk-ant-oat01-x').body as string);
  const last = shimmed.messages[shimmed.messages.length - 1];
  assert.equal(last.role, 'user', 'the wire conversation must end with a user message');
  const untouched = JSON.parse(applyClaudeEnvelope({ body: JSON.stringify({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'do the work' }],
  }) }, 'sk-ant-oat01-x').body as string);
  assert.equal(untouched.messages.length, 1, 'a user-terminal conversation is left alone');
});

// Anthropic streams extended thinking as `thinking_delta` SSE events, but the
// aisdk adapter accumulates them into a local block and emits NO stream event
// (@openai/agents-extensions, `case 'reasoning-delta'`). The harness therefore
// could not tell a brain thinking hard from a dead one, and the fallover
// layer's first-content timeout — which it skips entirely once activity is
// seen — benched Sonnet 5 at 154,898 ms mid-reconciliation with no provider
// error (live 2026-09-03, platform-49 run 7). We own the fetch, so the liveness
// signal is read off the wire.
test('thinking deltas are recoverable from the raw Anthropic SSE', () => {
  const sse = [
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,'
      + '"delta":{"type":"thinking_delta","thinking":"Comparing row 6 against "}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,'
      + '"delta":{"type":"thinking_delta","thinking":"the 08/27 thread."}}',
    '',
  ].join('\n');
  assert.equal(extractClaudeThinkingText(sse), 'Comparing row 6 against the 08/27 thread.');
});

test('thinking extraction survives escapes and ignores non-thinking deltas', () => {
  const escaped = 'data: {"delta":{"type":"thinking_delta",'
    + '"thinking":"row 9 says \\"last 24 months\\"\\nnext: dates"}}';
  assert.equal(extractClaudeThinkingText(escaped), 'row 9 says "last 24 months"\nnext: dates');

  // Ordinary output text is NOT thinking and must not be captured.
  const textDelta = 'data: {"delta":{"type":"text_delta","text":"Here is what I found"}}';
  assert.equal(extractClaudeThinkingText(textDelta), '');

  // A chunk cut mid-escape yields nothing rather than throwing; the next chunk
  // carries it.
  assert.doesNotThrow(() => extractClaudeThinkingText(
    'data: {"delta":{"type":"thinking_delta","thinking":"trailing \\',
  ));
});

test('the wire tap stamps liveness and the reasoning tail onto the run context', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,'
      + '"delta":{"type":"thinking_delta","thinking":"Row 6 is Brian\'s answer, "}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,'
      + '"delta":{"type":"thinking_delta","thinking":"not Spencer\'s request."}}\n\n',
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const context: { privateModelActivityAt?: number; latestModelThinking?: string } = {};
  const before = Date.now();
  await watchClaudeThinkingForLiveness(stream, context);

  assert.ok(
    (context.privateModelActivityAt ?? 0) >= before,
    'a thinking delta must prove the brain is working — this is the signal the '
    + 'fallover layer uses to NOT bench it',
  );
  assert.match(String(context.latestModelThinking), /not Spencer's request\./);
});

test('the wire tap treats ordinary output as liveness but not as reasoning', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"answer"}}\n\n',
      ));
      controller.close();
    },
  });
  const context: {
    privateModelActivityAt?: number;
    latestModelThinking?: string;
    latestProviderStreamEvent?: string;
  } = {};
  await watchClaudeThinkingForLiveness(stream, context);
  assert.ok(context.privateModelActivityAt, 'any provider traffic proves the socket is being written to');
  assert.equal(context.latestProviderStreamEvent, 'content_block_delta');
  assert.equal(context.latestModelThinking, undefined, 'ordinary output is not reasoning');

  // No run context (a call outside a harness turn) must cancel cleanly.
  const orphan = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode('data: {}\n\n')); controller.close(); },
  });
  await assert.doesNotReject(() => watchClaudeThinkingForLiveness(orphan, undefined));
});

// Silence had three meanings and the harness collapsed them into "dead". The
// kind is what tells them apart after the fact: a provider holding the socket
// open without generating (run 8: a 200 held 152 s, ~190 output tokens, no
// non-2xx ever written to disk) is not a brain that died.
test('a keepalive-only stream is liveness, and names itself as a keepalive', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'));
      controller.close();
    },
  });
  const context: { privateModelActivityAt?: number; latestProviderStreamEvent?: string } = {};
  await watchClaudeThinkingForLiveness(stream, context);
  assert.ok(context.privateModelActivityAt, 'a keepalive proves the provider is still there');
  assert.equal(context.latestProviderStreamEvent, 'ping');
});

test('stream event kinds rank the most telling frame, and nothing is not liveness', () => {
  assert.equal(claudeStreamEventKind('data: {"delta":{"type":"thinking_delta"}}'), 'thinking_delta');
  assert.equal(claudeStreamEventKind('event: ping\ndata: {"type":"ping"}'), 'ping');
  assert.equal(claudeStreamEventKind('event: whatever\ndata: {}'), 'stream_frame');
  assert.equal(claudeStreamEventKind('   '), null, 'no frame is not liveness');
  assert.equal(claudeStreamEventKind('half a chunk with no frame yet'), null);
});


test('Claude wire preserves tuple contracts in the required schema dialect', async () => {
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const tuple = { type: 'array', items: [{ const: 'completed' }, { const: 'failed' }],
    additionalItems: false, minItems: 2 };
  const schema = { type: 'object', properties: { states: tuple }, required: ['states'],
    additionalProperties: false, examples: [{ items: ['payload data'] }] };
  for (const custom of [false, true]) {
    const tool = { name: 'fixture', description: 'tuple fixture', input_schema: schema };
    const envelope = applyClaudeEnvelope({ body: JSON.stringify({ model: 'fixture-model',
      messages: [{ role: 'user', content: 'test' }], tools: [custom ? { custom: tool } : tool] }) }, 'fixture-token');
    const body = JSON.parse(String(envelope.body));
    const actual = (custom ? body.tools[0].custom : body.tools[0]).input_schema;
    const ajv = new Ajv2020({ strict: false });
    assert.equal(ajv.validateSchema(actual), true, JSON.stringify(ajv.errors));
    const valid = ajv.compile(actual);
    for (const states of [['completed', 'failed']]) assert.equal(valid({ states }), true);
    for (const states of [[], ['completed'], ['failed', 'completed'], ['completed', 'failed', 'extra']]) {
      assert.equal(valid({ states }), false, JSON.stringify(states));
    }
    assert.deepEqual(actual.examples, schema.examples, 'instance examples are data, not schemas');
  }
});


test('a tool named with the mcp_ prefix goes on the Claude wire as mcp- and its calls come back under the real name', async () => {
  const request = {
    model: 'claude-opus-5-5',
    tools: [
      { name: 'mcp_status', description: 'Status.', input_schema: { type: 'object' } },
      { name: 'read_file', description: 'Read.', input_schema: { type: 'object' } },
      { name: 'mcp_add', description: 'Add.', input_schema: { type: 'object' } },
      { name: 'mcp-add', description: 'Already spelled that way.', input_schema: { type: 'object' } },
    ],
    tool_choice: { type: 'tool', name: 'mcp_status' },
    messages: [
      { role: 'user', content: 'Check.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp_status', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    ],
  };
  const { body, toolAliases } = applyClaudeEnvelope({ body: JSON.stringify(request) }, 'sk-ant-oat01-x');
  const wire = JSON.parse(body as string);
  assert.deepEqual(wire.tools.map((tool: { name: string }) => tool.name), ['mcp-status', 'read_file', 'mcp_add', 'mcp-add'],
    'only an unclaimed mcp- spelling is used');
  assert.equal(wire.tool_choice.name, 'mcp-status');
  assert.equal(wire.messages[1].content[0].name, 'mcp-status');
  assert.deepEqual([...toolAliases], [['mcp-status', 'mcp_status']]);
  assert.equal(applyClaudeEnvelope({ body: JSON.stringify({ model: 'x', tools: [{ name: 'read_file' }], messages: [] }) }, 'sk-ant-oat01-x').toolAliases.size, 0);

  // A streamed reply: the block start is split across chunks.
  const events = [
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"mcp-status","input":{}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"mcp-status\\"}"}}',
    '',
  ].join('\n');
  const bytes = new TextEncoder().encode(events);
  const streamed = new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes.slice(0, 70)); controller.enqueue(bytes.slice(70)); controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const restored = await restoreClaudeWireToolNames(streamed, toolAliases).text();
  assert.match(restored, /"name":"mcp_status"/);
  assert.doesNotMatch(restored, /"name":"mcp-status"/);
  assert.match(restored, /partial_json/, 'other events pass through');
  assert.match(restored, /mcp-status/, 'only the call name changes, not the arguments');

  const whole = new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'toolu_3', name: 'mcp-status', input: {} }] }),
    { headers: { 'content-type': 'application/json' } });
  const parsed = JSON.parse(await restoreClaudeWireToolNames(whole, toolAliases).text());
  assert.equal(parsed.content[1].name, 'mcp_status');
});
