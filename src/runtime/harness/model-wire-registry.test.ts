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
  assert.equal(cap.effortMap.none, null, "tier 'none' omits effort (use the model's adaptive default)");
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

test('restoreLegacyInstructionOrder: rebuilds the EXACT pre-parity dynamic-first order (Codex byte-identity)', () => {
  const role = 'ROLE INSTRUCTIONS BODY';
  const ctx = 'DYNAMIC CONTEXT\n## Focus\n- x';
  const assembledParity = `${role}${INSTRUCTION_CACHE_DELIM}${ctx}`; // what the assembler emits, parity on
  const legacy = `${ctx}\n\n---\n\n${role}`; // what it emitted before
  assert.equal(restoreLegacyInstructionOrder(assembledParity), legacy);
  assert.equal(restoreLegacyInstructionOrder(assembledParity).includes(CACHE_BREAK_SENTINEL), false);
  // No sentinel → unchanged (sub-agent prompt that didn't pass through the assembler).
  assert.equal(restoreLegacyInstructionOrder('plain role only'), 'plain role only');
  assert.equal(restoreLegacyInstructionOrder(undefined), '');
});

test('estimateTokens is roughly chars/4', () => {
  assert.equal(estimateTokens('a'.repeat(4000)), 1000);
});
