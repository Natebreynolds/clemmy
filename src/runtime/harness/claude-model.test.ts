import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyClaudeEnvelope, withIdentityPrefix, ClaudeModelProvider, sanitizeClaudeInput, aisdkAcceptsReasoning, withClaudeInputSanitizer, getClaudeModel, resetClaudeModelCache } from './claude-model.js';
import { ClaudeHeadlessModel, setClaudeHeadlessCliAvailableForTest } from './claude-headless-model.js';

const ID = "You are Claude Code, Anthropic's official CLI for Claude.".replace('Claude', 'Claude'); // exact identity
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

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
    // CLI present → headless transport (claude -p print mode).
    setClaudeHeadlessCliAvailableForTest(true);
    resetClaudeModelCache();
    const headless = getClaudeModel('claude-opus-4-8');
    assert.ok(headless instanceof ClaudeHeadlessModel, 'CLI present → headless transport');

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
