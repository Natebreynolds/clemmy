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
} from './claude-model.js';
import { ClaudeHeadlessModel, setClaudeHeadlessCliAvailableForTest } from './claude-headless-model.js';
import { resolveModelCapability } from './model-wire-registry.js';

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
    { maxTokens: 16_384 },
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
