import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveModelCapability,
  DEFAULT_CAPABILITY,
  modelParityEnabled,
  stripCacheBreakSentinel,
  restoreLegacyInstructionOrder,
  estimateTokens,
  CACHE_BREAK_SENTINEL,
  CACHE_MEMORY_APPEND_DELIM,
  CACHE_MEMORY_APPEND_SENTINEL,
  CACHE_MEMORY_CONTEXT_SENTINEL,
  CACHE_MEMORY_CONTEXT_DELIM,
  INSTRUCTION_CACHE_DELIM,
} from './model-wire-registry.js';

test('registry: live Claude brain (opus 4.8) resolves to anthropic effort + 4096 cache min', () => {
  const cap = resolveModelCapability('claude-opus-4-8');
  assert.equal(cap.apiShape, 'anthropic_messages');
  assert.equal(cap.cacheMinTokens, 4096, 'Opus 4.x cache minimum is 4096 (NOT 1024 — verified vs claude-api skill)');
  assert.equal(cap.thinkingMode, 'effort', 'Opus 4.7/4.8 use output_config.effort, NOT budget_tokens (which 400s)');
  assert.equal(cap.supportsEffort, true);
  assert.equal(cap.effortMap.high, 'high');
  assert.equal(cap.effortMap.medium, 'medium');
  assert.equal(
    cap.effortMap.none,
    'low',
    "tier 'none' must map to the enum floor, never null — omitting output_config.effort "
    + "selects the wire DEFAULT, which is 'high', so omission is the most expensive option",
  );
  assert.equal(cap.supportsPromptCache, true);
  assert.equal(cap.retryClass, 'anthropic');
});

test('registry: Fable 5 and Sonnet 4.6 have the 2048 cache minimum', () => {
  assert.equal(resolveModelCapability('claude-fable-5').cacheMinTokens, 2048);
  assert.equal(resolveModelCapability('claude-sonnet-4-6').cacheMinTokens, 2048);
});

test('registry: gpt-5 resolves to codex wire and does NOT use explicit cache breakpoints', () => {
  const cap = resolveModelCapability('gpt-5.4');
  assert.equal(cap.apiShape, 'codex_responses');
  assert.equal(cap.retryClass, 'codex');
  assert.equal(cap.supportsPromptCache, false, 'OpenAI/codex caches automatically — no breakpoint to emit');
});

test('registry: a BYO openai-compatible id resolves to the compat shape', () => {
  const cap = resolveModelCapability('deepseek-reasoner');
  assert.equal(cap.apiShape, 'openai_completions');
  assert.equal(cap.retryClass, 'openai_compat');
});

test('registry: an unknown id falls LOUD to conservative defaults (never a silent wrong assumption)', () => {
  const cap = resolveModelCapability('totally-made-up-model-9000');
  assert.equal(cap, DEFAULT_CAPABILITY);
  assert.equal(cap.family, 'unknown');
  assert.equal(cap.supportsPromptCache, false);
  assert.equal(cap.supportsEffort, false);
  // empty id also defaults
  assert.equal(resolveModelCapability('').family, 'unknown');
  assert.equal(resolveModelCapability(undefined).family, 'unknown');
});

test('parity flag: default ON; CLEMMY_MODEL_PARITY=off restores legacy', () => {
  const prev = process.env.CLEMMY_MODEL_PARITY;
  delete process.env.CLEMMY_MODEL_PARITY;
  assert.equal(modelParityEnabled(), true, 'validated behavior is the default');
  process.env.CLEMMY_MODEL_PARITY = 'off';
  assert.equal(modelParityEnabled(), false);
  process.env.CLEMMY_MODEL_PARITY = 'on';
  assert.equal(modelParityEnabled(), true);
  if (prev === undefined) delete process.env.CLEMMY_MODEL_PARITY;
  else process.env.CLEMMY_MODEL_PARITY = prev;
});

test('sentinel: stripCacheBreakSentinel replaces the marker with a plain separator; no-op without it', () => {
  const withSentinel = `ROLE\n\n${CACHE_BREAK_SENTINEL}\n\nDYNAMIC`;
  const stripped = stripCacheBreakSentinel(withSentinel);
  assert.equal(stripped.includes(CACHE_BREAK_SENTINEL), false, 'marker never reaches the wire');
  assert.match(stripped, /ROLE\n\n---\n\nDYNAMIC/);
  assert.equal(stripCacheBreakSentinel('no marker here'), 'no marker here');
  assert.equal(stripCacheBreakSentinel(undefined), '');
});

test('restoreLegacyInstructionOrder: a no-memory turn suffix remains role-first', () => {
  const role = 'ROLE INSTRUCTIONS BODY';
  const turn = 'CURRENT TURN AUTHORITY';
  const assembledParity = `${role}${INSTRUCTION_CACHE_DELIM}${turn}`;
  assert.equal(restoreLegacyInstructionOrder(assembledParity), `${role}\n\n${turn}`);
  assert.equal(restoreLegacyInstructionOrder(assembledParity).includes(CACHE_BREAK_SENTINEL), false);
  // No sentinel → unchanged (sub-agent prompt that didn't pass through the assembler).
  assert.equal(restoreLegacyInstructionOrder('plain role only'), 'plain role only');
  assert.equal(restoreLegacyInstructionOrder(undefined), '');
});

test('layered restore appends externally-rendered Tool Memory exactly once', () => {
  const role = 'ROLE';
  const turn = 'CURRENT TURN AUTHORITY';
  const externalMemory = 'LEARNED TOOL MEMORY';
  const assembled = `${role}${INSTRUCTION_CACHE_DELIM}${turn}${CACHE_MEMORY_APPEND_DELIM}${externalMemory}`;
  const restored = restoreLegacyInstructionOrder(assembled);
  assert.equal(restored, `${role}\n\n${turn}\n\n${externalMemory}`);
  assert.equal(restored.split(externalMemory).length - 1, 1);
  assert.equal(restored.includes(CACHE_MEMORY_APPEND_SENTINEL), false);
});

test('layered restore keeps legacy memory-first order and strips both transport markers', () => {
  const role = 'ROLE';
  const turn = 'CURRENT TURN CATALOG';
  const memory = 'CURRENT MEMORY';
  const assembled = `${role}${INSTRUCTION_CACHE_DELIM}${turn}${CACHE_MEMORY_CONTEXT_DELIM}${memory}`;
  const restored = restoreLegacyInstructionOrder(assembled);
  assert.equal(restored, `${memory}\n\n---\n\n${role}\n\n${turn}`);
  assert.equal(restored.includes(CACHE_BREAK_SENTINEL), false);
  assert.equal(restored.includes(CACHE_MEMORY_CONTEXT_SENTINEL), false);
});

test('estimateTokens is roughly chars/4', () => {
  assert.equal(estimateTokens('a'.repeat(4000)), 1000);
});


// ─── The effort ladder must not invert ───────────────────────────────────────
//
// Live 2026-09-11: tier 'none' mapped to null, meaning "omit output_config".
// The comment said that let the model use its adaptive default; on this wire
// the default effort is 'high'. So the cheapest tier the harness can ask for
// produced the most expensive request on the wire — 3,817 output tokens in
// 45.6s to emit a 200-character clarifying question, while the SAME model in
// the SAME session at tier 'medium' answered in 3.3-4.2s per call on larger
// inputs. Omission is not a cheap default; it is an unasked-for maximum.

const EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high'] as const;
const WIRE_RANK: Record<string, number> = {
  low: 1, medium: 2, high: 3, xhigh: 4, max: 5,
};

test('registry: an effort-capable model never maps a tier to null (omission = provider default)', () => {
  for (const id of [
    'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-fable-5', 'claude-sonnet-4-6',
  ]) {
    const cap = resolveModelCapability(id);
    if (!cap.supportsEffort || cap.thinkingMode !== 'effort') continue;
    for (const tier of EFFORT_LADDER) {
      assert.notEqual(
        cap.effortMap[tier],
        null,
        `${id} tier '${tier}' omits effort — the wire then picks its own default, `
        + 'which this harness has not chosen and cannot bound',
      );
    }
  }
});

test('registry: mapped effort never decreases as the harness tier rises', () => {
  for (const id of [
    'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-fable-5', 'claude-sonnet-4-6',
  ]) {
    const cap = resolveModelCapability(id);
    if (!cap.supportsEffort || cap.thinkingMode !== 'effort') continue;
    let previous = 0;
    for (const tier of EFFORT_LADDER) {
      const mapped = cap.effortMap[tier];
      const rank = WIRE_RANK[String(mapped)] ?? -1;
      assert.ok(rank > 0, `${id} tier '${tier}' maps to an unknown wire value: ${String(mapped)}`);
      assert.ok(
        rank >= previous,
        `${id} tier '${tier}' maps DOWN the wire ladder — asking for more effort must never ask for less`,
      );
      previous = rank;
    }
  }
});

test('registry: a model with no effort knob still maps every tier to null', () => {
  // The inverse guard. Haiku 4.5 400s on output_config.effort at every level,
  // so omission is correct there and the null map is the point, not a bug.
  const cap = resolveModelCapability('claude-haiku-4-5');
  assert.equal(cap.supportsEffort, false);
  for (const tier of EFFORT_LADDER) assert.equal(cap.effortMap[tier], null);
});

// --- reasoning_effort on openai_completions wires ---------------------------
// Regression: the compat relax used to recognize effort-capable models by a
// model-name pattern of its own, so a newly documented family was stripped
// until that adapter changed. The registry row is now the only declaration.

test('registry: a new openai_completions family that declares effort values is mapped by the real compat relax, no adapter change', async () => {
  const { __test__, DEFAULT_CAPABILITY: base } = await import('./model-wire-registry.js');
  const { relaxRequestForCompatBackend } = await import('./byo-model.js');
  const relax = (body: Record<string, unknown>) =>
    relaxRequestForCompatBackend({ messages: [{ role: 'user', content: 'hi' }], ...body }) as Record<string, unknown>;
  const row = {
    idMatch: /^fixture-reasoner-9$/,
    cap: {
      ...base,
      family: 'fixture-reasoner',
      supportsEffort: true,
      completionsEffortValues: ['minimal', 'high'] as const,
    },
  };
  // Before the row exists the id is an ordinary BYO model: the field is stripped.
  assert.equal('reasoning_effort' in relax({ model: 'fixture-reasoner-9', reasoning_effort: 'high' }), false);
  __test__.REGISTRY.unshift(row);
  try {
    assert.equal(relax({ model: 'fixture-reasoner-9', reasoning_effort: 'none' }).reasoning_effort, 'minimal',
      'a tier below every declared value becomes the cheapest');
    assert.equal(relax({ model: 'fixture-reasoner-9', reasoning_effort: 'minimal' }).reasoning_effort, 'minimal');
    assert.equal(relax({ model: 'fixture-reasoner-9', reasoning_effort: 'medium' }).reasoning_effort, 'minimal',
      'a tier between declared values rounds down, never up');
    assert.equal(relax({ model: 'fixture-reasoner-9', reasoning_effort: 'high' }).reasoning_effort, 'high');
    assert.equal('reasoning_effort' in relax({ model: 'fixture-reasoner-9', reasoning_effort: 'max' }), false,
      'a tier above every declared value is not translated');
    assert.equal(relax({
      model: 'fixture-reasoner-9', reasoning_effort: 'high',
      response_format: { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } },
    }).reasoning_effort, 'minimal', 'a structured call uses the cheapest declared value');
    assert.equal('reasoning_effort' in relax({ model: 'fixture-reasoner-9' }), false,
      'no harness decision leaves the wire default');
    assert.equal('thinking' in relax({ model: 'fixture-reasoner-9', reasoning_effort: 'low' }), false);
  } finally {
    const at = __test__.REGISTRY.indexOf(row);
    if (at >= 0) __test__.REGISTRY.splice(at, 1);
  }
});

test('registry: every declared completions effort value is a rung of the shared ladder, cheapest first, on the completions wire only', async () => {
  const { __test__ } = await import('./model-wire-registry.js');
  const ladder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  for (const { cap } of __test__.REGISTRY) {
    const values = cap.completionsEffortValues;
    if (!values) continue;
    assert.equal(cap.apiShape, 'openai_completions', `${cap.family} declares completions effort values on another wire`);
    assert.equal(cap.supportsEffort, true, `${cap.family} declares effort values but says it has no effort knob`);
    assert.ok(values.length > 0, `${cap.family} declares an empty vocabulary`);
    let previous = -1;
    for (const value of values) {
      const rank = ladder.indexOf(value);
      assert.ok(rank >= 0, `${cap.family} declares an off-ladder value ${value}`);
      assert.ok(rank > previous, `${cap.family} values must be listed cheapest first`);
      previous = rank;
    }
  }
});

test('registry: the reasoning Grok releases declare effort values; earlier and multi-agent releases do not', async () => {
  const { completionsReasoningEffort } = await import('./model-wire-registry.js');
  for (const id of ['grok-4.5', 'grok-4.6', 'grok-4.7', 'grok-4-7']) {
    assert.deepEqual(resolveModelCapability(id).completionsEffortValues, ['low', 'medium', 'high', 'xhigh'], id);
    assert.equal(resolveModelCapability(id).contextWindow, 256_000, `${id} keeps the family window`);
    assert.equal(resolveModelCapability(id).supportsPromptCache, true, `${id} keeps the family cache seed`);
    assert.equal(completionsReasoningEffort(id, 'xhigh', { structured: false }), 'xhigh');
  }
  for (const id of ['grok-4', 'grok-4.20-multi-agent', 'grok-3', 'deepseek-chat', 'glm-5.2', 'unknown-model-x']) {
    assert.equal(resolveModelCapability(id).completionsEffortValues, undefined, id);
    assert.equal(completionsReasoningEffort(id, 'high', { structured: false }), undefined, id);
    assert.equal(completionsReasoningEffort(id, 'high', { structured: true }), undefined, id);
  }
});
