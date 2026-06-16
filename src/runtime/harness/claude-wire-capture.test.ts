/**
 * Request-capture smoke — the deterministic, OFFLINE proof that the parity layer
 * emits a wire-correct payload on the REAL assembled prompt (the actual
 * ORCHESTRATOR_INSTRUCTIONS + a realistic tool surface), not a synthetic stub.
 *
 * This closes the gap the mocked unit tests can't: they prove the LOGIC; this
 * proves the actual bytes that would hit the Anthropic / Codex wire are valid.
 * The only checks that still need a LIVE call are the cache-read hit and a real
 * 429 ride-through (see the live-smoke checklist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyClaudeEnvelope } from './claude-model.js';
import { buildCodexRequestBody } from './codex-model.js';
import { relaxRequestForCompatBackend } from './byo-model.js';
import { ORCHESTRATOR_INSTRUCTIONS } from '../../agents/orchestrator.js';
import { CACHE_BREAK_SENTINEL, INSTRUCTION_CACHE_DELIM } from './model-wire-registry.js';

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const TOKEN = 'sk-ant-oat01-x';

// A realistic per-turn dynamic context block (what renderHarnessMemoryContext
// emits): date + focus + a few facts. Kept modest so it stays well under the
// stable prefix — the realistic shape, not the realistic size, is what matters.
const DYNAMIC_CTX = [
  'Today is 2026-06-16 (Tuesday), local time 09:14 (America/Los_Angeles).',
  '## Current Focus',
  '- Auditing the Claude brain configuration.',
  '## Recently learned',
  '- The user prioritizes no-regression releases.',
].join('\n');

// What harnessInstructions(ORCHESTRATOR_INSTRUCTIONS)() emits with parity ON:
// STABLE role first, sentinel delimiter, DYNAMIC context last.
const ASSEMBLED_PARITY = `${ORCHESTRATOR_INSTRUCTIONS}${INSTRUCTION_CACHE_DELIM}${DYNAMIC_CTX}`;
// What it emitted BEFORE this change (parity off / legacy): dynamic first.
const ASSEMBLED_LEGACY = `${DYNAMIC_CTX}\n\n---\n\n${ORCHESTRATOR_INSTRUCTIONS}`;

// A realistic tool surface (~24 tools with descriptions + schemas). `count` can
// be raised to push the serialized tools array over a model's cacheMinTokens.
function realisticTools(count = 24): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${i}_do_a_thing`,
    description: `Tool ${i}: performs a representative operation with several documented parameters and a non-trivial description so the serialized schema has real bulk, mirroring the live MCP surface.`,
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'the entity to operate on' },
        options: { type: 'object', description: 'operation options', properties: { dryRun: { type: 'boolean' }, limit: { type: 'number' } } },
      },
      required: ['target'],
    },
  }));
}

function claudeBody(parity: 'on' | 'off', opts: { system?: unknown; tools?: unknown[] } = {}) {
  const prev = process.env.CLEMMY_MODEL_PARITY;
  process.env.CLEMMY_MODEL_PARITY = parity;
  try {
    const { body } = applyClaudeEnvelope(
      { body: JSON.stringify({
        model: 'claude-opus-4-8',
        system: opts.system ?? ASSEMBLED_PARITY,
        tools: opts.tools ?? realisticTools(),
        messages: [{ role: 'user', content: 'hi' }],
      }) },
      TOKEN,
    );
    return JSON.parse(body as string);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_MODEL_PARITY;
    else process.env.CLEMMY_MODEL_PARITY = prev;
  }
}

function countCacheControl(parsed: any): number {
  let n = 0;
  for (const b of parsed.system ?? []) if (b?.cache_control) n += 1;
  for (const t of parsed.tools ?? []) if (t?.cache_control) n += 1;
  return n;
}

test('sanity: the real ORCHESTRATOR_INSTRUCTIONS is large enough to be a cacheable Opus prefix (>4096 tokens)', () => {
  assert.ok(typeof ORCHESTRATOR_INSTRUCTIONS === 'string' && ORCHESTRATOR_INSTRUCTIONS.length > 16384,
    `expected >16384 chars (~4096 tokens), got ${ORCHESTRATOR_INSTRUCTIONS.length}`);
});

test('CLAUDE wire (parity on): identity-0, ONE breakpoint on the stable role block, dynamic last, no sentinel, no empty block', () => {
  const parsed = claudeBody('on');
  // identity invariant
  assert.equal(parsed.system[0].text, IDENTITY);
  assert.equal(parsed.system[0].cache_control, undefined);
  // stable role block carries the single breakpoint and is the real instructions
  assert.equal(parsed.system[1].text, ORCHESTRATOR_INSTRUCTIONS);
  assert.deepEqual(parsed.system[1].cache_control, { type: 'ephemeral' });
  // dynamic context is last and uncached
  assert.equal(parsed.system[2].text, DYNAMIC_CTX);
  assert.equal(parsed.system[2].cache_control, undefined);
  // exactly ONE breakpoint total (system caches the tools prefix too — no double)
  assert.equal(countCacheControl(parsed), 1, 'one breakpoint ≤ Anthropic max of 4; tools not double-cached');
  // the sentinel NEVER reaches the wire
  assert.equal((body(parsed)).includes(CACHE_BREAK_SENTINEL), false);
  // no empty text content block anywhere in system
  for (const b of parsed.system) assert.notEqual(b.text, '');
  // effort is a decorator/providerData concern — the envelope body must NOT carry it
  assert.equal('output_config' in parsed, false);
});

test('CLAUDE wire (parity off): legacy identity-prefix, NO cache_control, NO sentinel', () => {
  const parsed = claudeBody('off');
  assert.equal(parsed.system[0].text, IDENTITY);
  assert.equal(countCacheControl(parsed), 0, 'kill-switch removes all caching');
  assert.equal(body(parsed).includes(CACHE_BREAK_SENTINEL), false);
});

// The AI SDK sends `system` as an ARRAY of text blocks — this is the ACTUAL
// production wire shape (string cases above are a convenience). Prove it directly.
const ARRAY_SYSTEM = [{ type: 'text', text: ASSEMBLED_PARITY }];

test('CLAUDE wire (parity on, REAL array system): identity-0, one stable breakpoint, dynamic last, no sentinel/empty', () => {
  const parsed = claudeBody('on', { system: ARRAY_SYSTEM });
  assert.equal(parsed.system[0].text, IDENTITY);
  assert.equal(parsed.system[1].text, ORCHESTRATOR_INSTRUCTIONS);
  assert.deepEqual(parsed.system[1].cache_control, { type: 'ephemeral' });
  assert.equal(parsed.system[2].text, DYNAMIC_CTX);
  assert.equal(countCacheControl(parsed), 1);
  assert.equal(body(parsed).includes(CACHE_BREAK_SENTINEL), false);
  for (const b of parsed.system) assert.notEqual(b.text, '');
});

test('CLAUDE wire (parity off, REAL array system): array sentinel is stripped — never leaks to the wire', () => {
  const parsed = claudeBody('off', { system: ARRAY_SYSTEM });
  assert.equal(parsed.system[0].text, IDENTITY);
  assert.equal(countCacheControl(parsed), 0);
  assert.equal(body(parsed).includes(CACHE_BREAK_SENTINEL), false, 'array-shape sentinel stripped on the legacy path too');
});

test('CLAUDE wire (parity on, no-sentinel sub-agent + large tools): tools-array breakpoint, system uncached', () => {
  // A sub-agent turn (empty ctx) has no sentinel; the breakpoint moves to the
  // tools array. Needs a tool surface OVER Opus cacheMinTokens (4096) to cache.
  const tools = realisticTools(48);
  assert.ok(JSON.stringify(tools).length / 4 > 4096, 'tool surface must exceed the 4096-token min to be cacheable');
  const parsed = claudeBody('on', { system: [{ type: 'text', text: 'You are a focused sub-agent.' }], tools });
  assert.equal(parsed.system[0].text, IDENTITY);
  assert.equal(parsed.system[1].cache_control, undefined, 'short system is not cached');
  assert.deepEqual(parsed.tools[parsed.tools.length - 1].cache_control, { type: 'ephemeral' });
  assert.equal(countCacheControl(parsed), 1, 'exactly one breakpoint, on the tools array');
});

test('CODEX wire is BYTE-IDENTICAL to legacy (dynamic-first), sentinel-free — primary path unchanged for users', () => {
  const codex = buildCodexRequestBody('gpt-5.4', {
    systemInstructions: ASSEMBLED_PARITY, input: [], tools: [], handoffs: [], modelSettings: {},
  } as any);
  assert.equal(codex.instructions, ASSEMBLED_LEGACY, 'Codex instructions reconstruct the exact pre-parity order');
  assert.equal(codex.instructions.includes(CACHE_BREAK_SENTINEL), false);
});

test('BYO wire restores legacy order in the system message, sentinel-free', () => {
  const relaxed = relaxRequestForCompatBackend({
    model: 'deepseek-reasoner',
    messages: [{ role: 'system', content: ASSEMBLED_PARITY }, { role: 'user', content: 'hi' }],
  }) as any;
  assert.equal(relaxed.messages[0].content, ASSEMBLED_LEGACY);
  assert.equal(relaxed.messages[0].content.includes(CACHE_BREAK_SENTINEL), false);
});

function body(parsed: unknown): string {
  return JSON.stringify(parsed);
}
