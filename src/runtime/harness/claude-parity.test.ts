import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyClaudeEnvelope, buildClaudeSystemBlocks, claudeWireDebugEnabled, logClaudeRequestShape, logClaudeResponseUsage } from './claude-model.js';
import { resolveModelCapability, CACHE_BREAK_SENTINEL } from './model-wire-registry.js';

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const OPUS = resolveModelCapability('claude-opus-4-8');
const TOKEN = 'sk-ant-oat01-x';

function withParity(value: 'on' | 'off', fn: () => void): void {
  const prev = process.env.CLEMMY_MODEL_PARITY;
  process.env.CLEMMY_MODEL_PARITY = value;
  try { fn(); }
  finally {
    if (prev === undefined) delete process.env.CLEMMY_MODEL_PARITY;
    else process.env.CLEMMY_MODEL_PARITY = prev;
  }
}

// --- buildClaudeSystemBlocks (the split + cache boundary) -------------------

test('blocks: identity is ALWAYS block 0 (the OAuth-token invariant)', () => {
  const { blocks } = buildClaudeSystemBlocks('anything', OPUS, true);
  assert.equal((blocks[0] as any).text, IDENTITY);
  assert.equal((blocks[0] as any).cache_control, undefined, 'identity itself carries no breakpoint');
});

test('blocks: a sentinel split with a large stable prefix gets a cache_control breakpoint', () => {
  const stable = 'S'.repeat(20000); // ~5000 tokens > 4096 min
  const sys = `${stable}${CACHE_BREAK_SENTINEL}DYNAMIC`;
  const { blocks, systemCached } = buildClaudeSystemBlocks(sys, OPUS, true);
  assert.equal(systemCached, true);
  assert.equal((blocks[0] as any).text, IDENTITY);
  assert.equal((blocks[1] as any).text, stable);
  assert.deepEqual((blocks[1] as any).cache_control, { type: 'ephemeral' });
  assert.equal((blocks[2] as any).text, 'DYNAMIC');
  assert.equal((blocks[2] as any).cache_control, undefined, 'dynamic context stays uncached');
});

test('blocks: a stable prefix below cacheMinTokens is NOT cached (avoids the write premium for a 0% hit)', () => {
  const sys = `small role${CACHE_BREAK_SENTINEL}DYNAMIC`;
  const { blocks, systemCached } = buildClaudeSystemBlocks(sys, OPUS, true);
  assert.equal(systemCached, false);
  assert.equal((blocks[1] as any).cache_control, undefined);
});

test('blocks: no sentinel -> whole prompt is dynamic, system is NOT cached', () => {
  const { blocks, systemCached } = buildClaudeSystemBlocks('S'.repeat(20000), OPUS, true);
  assert.equal(systemCached, false);
  assert.equal((blocks[1] as any).cache_control, undefined);
});

test('blocks: any stray sentinel is stripped so it never reaches the wire', () => {
  const { blocks } = buildClaudeSystemBlocks(`a${CACHE_BREAK_SENTINEL}b${CACHE_BREAK_SENTINEL}c`, OPUS, true);
  for (const b of blocks) assert.equal((b as any).text.includes(CACHE_BREAK_SENTINEL), false);
});

test('blocks: an EMPTY system emits NO empty text block (Anthropic 400 guard) — identity only', () => {
  for (const sys of ['', '   ', undefined, null]) {
    const { blocks } = buildClaudeSystemBlocks(sys as unknown, OPUS, true);
    assert.equal(blocks.length, 1, 'identity-only system');
    assert.equal((blocks[0] as any).text, IDENTITY);
    for (const b of blocks) assert.notEqual((b as any).text, '', 'no empty text block reaches the wire');
  }
});

test('blocks: a sentinel-led prompt (empty stable prefix) emits identity + dynamic, no empty stable block', () => {
  const { blocks, systemCached } = buildClaudeSystemBlocks(`${CACHE_BREAK_SENTINEL}live only`, OPUS, true);
  assert.equal(systemCached, false);
  assert.deepEqual(blocks.map((b: any) => b.text), [IDENTITY, 'live only']);
  for (const b of blocks) assert.notEqual((b as any).text, '');
});

test('blocks: tools tokens count toward the cache-min gate (small stable + large tools -> cached)', () => {
  const smallStable = 'short role';
  const sys = `${smallStable}${CACHE_BREAK_SENTINEL}dyn`;
  // identity+stable alone is far under 4096 tokens; tools push the shared prefix over.
  const under = buildClaudeSystemBlocks(sys, OPUS, true, 0);
  assert.equal(under.systemCached, false, 'without tools, the small stable prefix is not cached');
  const over = buildClaudeSystemBlocks(sys, OPUS, true, 5000);
  assert.equal(over.systemCached, true, 'tools sharing the cached prefix push it over the minimum');
  assert.deepEqual((over.blocks[1] as any).cache_control, { type: 'ephemeral' });
});

// --- applyClaudeEnvelope end-to-end (parity on/off) ------------------------

test('envelope (parity on): a request with NO system key never emits an empty system block', () => {
  withParity('on', () => {
    const { body } = applyClaudeEnvelope(
      { body: JSON.stringify({ model: 'claude-opus-4-8', tools: [], messages: [] }) },
      TOKEN,
    );
    const parsed = JSON.parse(body as string);
    assert.equal(parsed.system.length, 1, 'identity-only');
    assert.equal(parsed.system[0].text, IDENTITY);
    assert.equal(JSON.stringify(parsed.system).includes('"text":""'), false);
  });
});

test('envelope (parity on): cached stable system blocks; effort is NOT written into the body', () => {
  withParity('on', () => {
    const stable = 'R'.repeat(20000);
    const sys = `${stable}${CACHE_BREAK_SENTINEL}live context`;
    const { body } = applyClaudeEnvelope(
      { body: JSON.stringify({ model: 'claude-opus-4-8', system: sys, tools: [], messages: [] }) },
      TOKEN,
    );
    const parsed = JSON.parse(body as string);
    assert.equal(parsed.system[0].text, IDENTITY);
    assert.deepEqual(parsed.system[1].cache_control, { type: 'ephemeral' });
    assert.equal(parsed.system[2].text, 'live context');
    // Effort travels via providerData/output_config at the SDK layer, NOT the
    // raw body rewrite — the envelope must not invent it.
    assert.equal('output_config' in parsed, false);
    assert.equal(parsed.max_tokens != null, true, 'max_tokens still defaulted');
  });
});

test('envelope (parity on): no sentinel -> cache the (large, stable) tools array instead', () => {
  withParity('on', () => {
    const bigTool = { name: 'big', description: 'D'.repeat(20000), input_schema: { type: 'object' } };
    const { body } = applyClaudeEnvelope(
      { body: JSON.stringify({ model: 'claude-opus-4-8', system: 'short role', tools: [bigTool], messages: [] }) },
      TOKEN,
    );
    const parsed = JSON.parse(body as string);
    assert.equal(parsed.system[0].text, IDENTITY);
    assert.equal(parsed.system[1].cache_control, undefined, 'short system not cached');
    assert.deepEqual(parsed.tools[parsed.tools.length - 1].cache_control, { type: 'ephemeral' });
  });
});

// --- opt-in wire diagnostics (off by default) ------------------------------

test('wire debug flag: OFF by default; on for 1/on/true', () => {
  const prev = process.env.CLEMMY_CLAUDE_WIRE_DEBUG;
  delete process.env.CLEMMY_CLAUDE_WIRE_DEBUG;
  assert.equal(claudeWireDebugEnabled(), false, 'diagnostics are opt-in');
  for (const v of ['1', 'on', 'true']) {
    process.env.CLEMMY_CLAUDE_WIRE_DEBUG = v;
    assert.equal(claudeWireDebugEnabled(), true);
  }
  process.env.CLEMMY_CLAUDE_WIRE_DEBUG = 'no';
  assert.equal(claudeWireDebugEnabled(), false);
  if (prev === undefined) delete process.env.CLEMMY_CLAUDE_WIRE_DEBUG;
  else process.env.CLEMMY_CLAUDE_WIRE_DEBUG = prev;
});

test('wire debug: request-shape + response-usage logging never throw (best-effort)', async () => {
  // request shape: valid body, malformed JSON, and non-string all tolerated
  logClaudeRequestShape(JSON.stringify({ model: 'claude-opus-4-8', system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }], output_config: { effort: 'high' } }));
  logClaudeRequestShape('{not json');
  logClaudeRequestShape(undefined);
  // response usage: a synthetic SSE carrying a cache-hit message_start
  const sse = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":8000,"output_tokens":0}}}\n\n';
  const stream = new Response(sse).body as ReadableStream<Uint8Array>;
  await logClaudeResponseUsage(stream); // resolves, never throws
  assert.ok(true);
});

test('envelope (parity off): legacy identity-prefix path, NO cache_control anywhere', () => {
  withParity('off', () => {
    const { body } = applyClaudeEnvelope(
      { body: JSON.stringify({ model: 'claude-opus-4-8', system: 'Be helpful.', tools: [], messages: [] }) },
      TOKEN,
    );
    const parsed = JSON.parse(body as string);
    assert.equal(parsed.system[0].text, IDENTITY);
    assert.equal(parsed.system[1].text, 'Be helpful.');
    assert.equal(JSON.stringify(parsed).includes('cache_control'), false, 'kill-switch removes all caching');
  });
});
