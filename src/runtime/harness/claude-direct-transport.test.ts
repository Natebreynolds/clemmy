/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/claude-direct-transport.test.ts
 *
 * Direct Anthropic Messages transport — request construction and stream
 * reading, proven OFFLINE (no live call, no quota).
 *
 * The reason this module exists is that both vendored adapters delete the
 * frames that prove Claude is alive (@ai-sdk/anthropic drops `ping`; the agents
 * ai-sdk adapter accumulates `reasoning-delta` and emits nothing, with no
 * `'raw'` case to fall back on). These pins cover the parts that are ours.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentInputItem, ModelRequest } from '@openai/agents';
import {
  anthropicMessagesFromInput,
  anthropicOutputConfig,
  buildAnthropicMessagesBody,
  readAnthropicSseFrames,
} from './claude-direct-transport.js';
import { resolveModelCapability, CACHE_BREAK_SENTINEL } from './model-wire-registry.js';
import { applyClaudeEnvelope } from './claude-model.js';

const SONNET = resolveModelCapability('claude-sonnet-5');

function request(over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    input: 'hello',
    modelSettings: {},
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
    ...over,
  } as unknown as ModelRequest;
}

// ── input → messages ────────────────────────────────────────────────────────

test('a plain string input becomes one user message', () => {
  assert.deepEqual(anthropicMessagesFromInput('find the duplicates'), [
    { role: 'user', content: [{ type: 'text', text: 'find the duplicates' }] },
  ]);
  assert.deepEqual(anthropicMessagesFromInput('   '), [], 'empty input sends no message');
});

test('a tool call and its result land on the correct sides of the conversation', () => {
  const items = [
    { type: 'message', role: 'user', content: 'read the log tab' },
    { type: 'function_call', callId: 'call_1', name: 'sheets_read', arguments: '{"tab":"Log"}' },
    { type: 'function_call_result', callId: 'call_1', output: '34 rows' },
  ] as unknown as AgentInputItem[];

  assert.deepEqual(anthropicMessagesFromInput(items), [
    { role: 'user', content: [{ type: 'text', text: 'read the log tab' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'sheets_read', input: { tab: 'Log' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '34 rows' }] },
  ]);
});

// Anthropic's own ordering rule, and the highest-risk part of this module: a
// thinking block must PRECEDE the tool_use blocks it produced, inside ONE
// assistant message, with its signature echoed verbatim. Splitting them across
// messages, or emitting thinking after the call, is a 400 that kills the turn.
test('thinking precedes tool_use inside a single assistant message, signature intact', () => {
  const items = [
    { type: 'message', role: 'user', content: 'reconcile it' },
    {
      type: 'function_call', callId: 'call_a', name: 'slack_read', arguments: '{}',
    },
    {
      type: 'reasoning',
      content: [{ type: 'input_text', text: 'row 6 is a reply, not a request' }],
      providerData: { signature: 'sig-abc' },
    },
  ] as unknown as AgentInputItem[];

  const messages = anthropicMessagesFromInput(items);
  assert.equal(messages.length, 2);
  const turn = messages[1]!;
  assert.equal(turn.role, 'assistant');
  assert.equal(turn.content[0]?.type, 'thinking', 'thinking must come first even when it arrived last');
  assert.deepEqual(turn.content[0], {
    type: 'thinking',
    thinking: 'row 6 is a reply, not a request',
    signature: 'sig-abc',
  });
  assert.equal(turn.content[1]?.type, 'tool_use');
});

test('an unsigned thinking block is dropped rather than replayed', () => {
  // Anthropic only accepts thinking it signed; replaying an unsigned block is a
  // 400. Dropping it costs context, not the turn.
  const items = [
    { type: 'reasoning', content: [{ type: 'input_text', text: 'unsigned musing' }] },
    { type: 'function_call', callId: 'c1', name: 't', arguments: '{}' },
  ] as unknown as AgentInputItem[];
  const messages = anthropicMessagesFromInput(items);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]!.content.map((b) => b.type), ['tool_use']);
});

test('parallel tool calls stay in one assistant message with one thinking block', () => {
  const items = [
    { type: 'reasoning', content: [{ type: 'input_text', text: 'read both' }], providerData: { signature: 's' } },
    { type: 'function_call', callId: 'a', name: 'sheets', arguments: '{}' },
    { type: 'function_call', callId: 'b', name: 'slack', arguments: '{}' },
    { type: 'function_call_result', callId: 'a', output: 'rows' },
    { type: 'function_call_result', callId: 'b', output: 'msgs' },
  ] as unknown as AgentInputItem[];

  const messages = anthropicMessagesFromInput(items);
  assert.equal(messages.length, 2, 'one assistant turn, one user turn carrying both results');
  assert.deepEqual(messages[0]!.content.map((b) => b.type), ['thinking', 'tool_use', 'tool_use']);
  assert.deepEqual(messages[1]!.content.map((b) => b.type), ['tool_result', 'tool_result']);
});

test('malformed tool arguments become an empty object rather than killing the turn', () => {
  const items = [
    { type: 'function_call', callId: 'c', name: 't', arguments: '{not json' },
  ] as unknown as AgentInputItem[];
  const [msg] = anthropicMessagesFromInput(items);
  assert.deepEqual(msg!.content[0], { type: 'tool_use', id: 'c', name: 't', input: {} });
});

// ── body ────────────────────────────────────────────────────────────────────

test('the body carries the model, bounded max_tokens, system, tools and stream', () => {
  const body = buildAnthropicMessagesBody({
    request: request({
      systemInstructions: 'You are Clem.',
      tools: [{ name: 'sheets_read', description: 'read', parameters: { type: 'object' } }] as never,
    }),
    modelId: 'claude-sonnet-5',
    capability: SONNET,
  });
  assert.equal(body.model, 'claude-sonnet-5');
  assert.equal(body.max_tokens, SONNET.maxOutput);
  assert.equal(body.system, 'You are Clem.');
  assert.equal(body.stream, true);
  assert.deepEqual(body.tools, [
    { name: 'sheets_read', description: 'read', input_schema: { type: 'object' } },
  ]);
});

test('effort rides output_config only when the wire takes it', () => {
  // The classifier rates most turns 'simple', which maps to null and omits the
  // knob — that omission is what left thinking invisible on the ai-sdk path.
  assert.equal(anthropicOutputConfig(request({ modelSettings: { reasoning: { effort: 'none' } } as never }), SONNET), undefined);
  assert.deepEqual(anthropicOutputConfig(request({ modelSettings: { reasoning: { effort: 'medium' } } as never }), SONNET), { effort: 'medium' });
  // translateSettings speaks provider-level; that wins.
  assert.deepEqual(
    anthropicOutputConfig(
      request({ modelSettings: { providerData: { providerOptions: { anthropic: { effort: 'high' } } } } as never }),
      SONNET,
    ),
    { effort: 'high' },
  );
  // A wire with no effort knob never receives one (Haiku 4.5 400s on it).
  const haiku = resolveModelCapability('claude-haiku-4-5');
  assert.equal(anthropicOutputConfig(request({ modelSettings: { reasoning: { effort: 'high' } } as never }), haiku), undefined);
});

// ── SSE reading ─────────────────────────────────────────────────────────────

test('complete SSE frames are read and the partial tail is carried', () => {
  const chunk = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1"}}',
    '',
    'event: ping',
    'data: {"type":"ping"}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_de',
  ].join('\n');

  const { events, rest } = readAnthropicSseFrames(chunk);
  assert.deepEqual(events.map((e) => e.type), ['message_start', 'ping']);
  assert.ok(rest.includes('text_de'), 'the incomplete frame is carried, not guessed at');

  // The carried tail completes on the next chunk.
  const next = readAnthropicSseFrames(`${rest}lta","text":"hi"}}\n\n`);
  assert.deepEqual(next.events.map((e) => e.type), ['content_block_delta']);
  assert.equal(next.rest, '');
});

test('ping survives as an event — it is the proof the provider is still there', () => {
  // @ai-sdk/anthropic does `case "ping": return;`. That single line is why a
  // 200 held open for 152 s read as a dead brain.
  const { events } = readAnthropicSseFrames('event: ping\ndata: {"type":"ping"}\n\n');
  assert.deepEqual(events, [{ type: 'ping', data: { type: 'ping' } }]);
});

test('a malformed payload keeps its frame type instead of throwing', () => {
  const { events } = readAnthropicSseFrames('event: content_block_delta\ndata: {broken\n\n');
  assert.deepEqual(events.map((e) => e.type), ['content_block_delta']);
});

test('thinking deltas arrive as ordinary readable frames', () => {
  const { events } = readAnthropicSseFrames(
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,'
    + '"delta":{"type":"thinking_delta","thinking":"comparing row 6"}}\n\n',
  );
  assert.equal(events.length, 1);
  const delta = events[0]!.data.delta as { type?: string; thinking?: string };
  assert.equal(delta.type, 'thinking_delta');
  assert.equal(delta.thinking, 'comparing row 6');
});

// ── parity with the shipping path ───────────────────────────────────────────
// The direct body is only useful if the production envelope treats it the same
// way it treats the ai-sdk one. Measured against a real live request, which
// logged systemBlocks: 3, cacheBreakpoints: 1, systemCached: true.
test('the direct body reaches the wire with the same envelope shape as the ai-sdk path', () => {
  const system = `You are Clem, a careful operator.\n${'Stable policy text. '.repeat(400)}`
    + `${CACHE_BREAK_SENTINEL}\nVolatile turn context.`;
  const body = buildAnthropicMessagesBody({
    request: request({
      systemInstructions: system,
      input: [{ type: 'message', role: 'user', content: 'reconcile the Log tab' }] as never,
      modelSettings: { reasoning: { effort: 'medium' } } as never,
      tools: [{ name: 'sheets_read', description: 'read a tab', parameters: { type: 'object', properties: {} } }] as never,
    }),
    modelId: 'claude-sonnet-5',
    capability: SONNET,
  });

  const { body: enveloped } = applyClaudeEnvelope(
    { body: JSON.stringify(body), headers: {} } as never,
    'sk-ant-oat01-test',
  );
  const parsed = JSON.parse(String(enveloped)) as Record<string, unknown>;
  const blocks = (parsed.system ?? []) as Array<Record<string, unknown>>;

  assert.equal(blocks.length, 3, 'identity + stable + dynamic, as the live request carried');
  assert.equal(blocks.filter((b) => b.cache_control).length, 1, 'the stable prefix keeps its breakpoint');
  assert.ok(String(blocks[0]?.text ?? '').startsWith('You are Claude Code'),
    'the identity block must stay first — the subscription OAuth token depends on it');
  assert.ok(!JSON.stringify(parsed).includes(CACHE_BREAK_SENTINEL), 'the sentinel never reaches the wire');
  assert.deepEqual(parsed.output_config, { effort: 'medium' });
});
