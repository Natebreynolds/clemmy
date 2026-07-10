/**
 * Run: npx tsx --test src/runtime/harness/budget.test.ts
 *
 * Pure-function tests for the pre-flight token budget primitives.
 * No SDK, no DB, no I/O — these run in isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  estimateMessagesTokens,
  modelContextLimit,
  getEffectiveContextLimit,
  predictTurnCost,
  checkBudget,
  MINIMUM_CONTEXT_FLOOR,
} from './budget.js';

// ─── estimateTokens ───────────────────────────────────────────────

test('estimateTokens: empty / null input returns 0', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('estimateTokens: English prose uses ~4 chars/token', () => {
  const text = 'The quick brown fox jumps over the lazy dog.'; // 44 chars
  // 44 / 4 = 11
  assert.equal(estimateTokens(text), 11);
});

test('estimateTokens: JSON-shaped content uses ~3.5 chars/token (more tokens)', () => {
  const json = '{"name":"clementine","version":"0.5.18","facts":42}'; // 51 chars
  // 51 / 3.5 = ~15
  const estimate = estimateTokens(json);
  assert.ok(estimate >= 14 && estimate <= 16, `expected ~15, got ${estimate}`);
});

test('estimateTokens: leading whitespace doesn\'t fool the structured-detector', () => {
  const json = '   \n  {"key": "value"}';
  // Should still detect as structured (after trimStart)
  assert.ok(estimateTokens(json) > Math.ceil(json.length / 4), 'JSON ratio (smaller divisor) yields larger token count than text ratio');
});

// ─── estimateMessagesTokens ───────────────────────────────────────

test('estimateMessagesTokens: empty array is 0', () => {
  assert.equal(estimateMessagesTokens([]), 0);
});

test('estimateMessagesTokens: single string content + framing overhead', () => {
  const items = [{ role: 'user', content: 'hello world' }];
  // 'hello world' = 11 chars / 4 = 3 tokens + 4 framing = 7
  assert.equal(estimateMessagesTokens(items), 3 + 4);
});

test('estimateMessagesTokens: array-of-parts content', () => {
  const items = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'analyze this' },
        { type: 'text', text: 'and this too' },
      ],
    },
  ];
  // 'analyze this' (12 chars / 4 = 3) + 'and this too' (12/4 = 3) + 4 framing = 10
  assert.equal(estimateMessagesTokens(items), 3 + 3 + 4);
});

test('estimateMessagesTokens: unknown-shape parts get conservative JSON estimate', () => {
  const items = [
    { role: 'tool', content: [{ type: 'image', source: { data: 'abc' } }] },
  ];
  const tokens = estimateMessagesTokens(items);
  assert.ok(tokens > 4, 'must include something for the part beyond framing');
});

// ─── modelContextLimit ────────────────────────────────────────────

test('modelContextLimit: known frontier models', () => {
  assert.equal(modelContextLimit('gpt-5.4'), 200_000);
  assert.equal(modelContextLimit('gpt-5.4-mini'), 128_000);
  assert.equal(modelContextLimit('gpt-5.4-nano'), 64_000);
  assert.equal(modelContextLimit('codex-mini'), 200_000);
});

test('modelContextLimit: gpt-5.5 family caps at Codex-oauth 400K ceiling', () => {
  // 1M is API-KEY ONLY. Through Codex oauth (any tier) the
  // ceiling is 400K — that's what the budget gate must assume,
  // since the daemon is on AUTH_MODE=codex_oauth by default.
  assert.equal(modelContextLimit('gpt-5.5'), 400_000);
  assert.equal(modelContextLimit('gpt-5.5-codex'), 400_000);
  assert.equal(modelContextLimit('gpt-5.5-pro'), 400_000);
  assert.equal(modelContextLimit('gpt-5.5-mini'), 200_000);
});

test('modelContextLimit: gpt-5.6 family resolves before discovery docs catch up', () => {
  assert.equal(modelContextLimit('gpt-5.6'), 400_000);
  assert.equal(modelContextLimit('gpt-5.6-sol'), 400_000);
  assert.equal(modelContextLimit('gpt-5.6-terra'), 400_000);
  assert.equal(modelContextLimit('gpt-5.6-mini'), 200_000);
  assert.equal(modelContextLimit('gpt-5.6-sol-2026-07-09'), 400_000);
});

test('modelContextLimit: gpt-5.5 dated snapshot variant matches via prefix', () => {
  assert.equal(modelContextLimit('gpt-5.5-2026-04-23'), 400_000);
  assert.equal(modelContextLimit('gpt-5.5-codex-2026-05'), 400_000);
});

test('modelContextLimit: known Claude Agent SDK models do not warn/fall back as unknown', () => {
  assert.equal(modelContextLimit('claude-opus-4-8'), 200_000);
  assert.equal(modelContextLimit('claude-opus-4-8-2026-06'), 200_000);
  assert.equal(modelContextLimit('claude-sonnet-4-6'), 200_000);
  assert.equal(modelContextLimit('claude-fable-5'), 200_000);
});

test('modelContextLimit: prefix match for variants (longest-prefix wins)', () => {
  // gpt-5.4-mini-2026-05 should match the gpt-5.4-mini prefix, not gpt-5.4
  assert.equal(modelContextLimit('gpt-5.4-mini-2026-05'), 128_000);
  // gpt-5.4-2026-04-snapshot should match gpt-5.4
  assert.equal(modelContextLimit('gpt-5.4-2026-04-snapshot'), 200_000);
});

test('modelContextLimit: BYO providers (MiniMax / DeepSeek / GLM) resolve, longest-prefix wins', () => {
  assert.equal(modelContextLimit('MiniMax-M3'), 1_000_000);
  assert.equal(modelContextLimit('MiniMax-M2.7'), 200_000); // generic MiniMax
  assert.equal(modelContextLimit('deepseek-chat'), 128_000);
  // GLM 5.2 is a 1M-context flagship; lighter glm-* variants take the safe 128K floor.
  assert.equal(modelContextLimit('glm-5.2'), 1_000_000);
  assert.equal(modelContextLimit('glm-4.6'), 128_000); // generic glm
  assert.equal(modelContextLimit('glm-4.5-air'), 128_000); // generic glm
});

test('modelContextLimit: unknown model falls back to conservative default', () => {
  assert.equal(modelContextLimit('totally-made-up-model-xyz'), 128_000);
});

test('modelContextLimit: absent model id falls back silently to conservative default', () => {
  assert.equal(modelContextLimit(''), 128_000);
  assert.equal(modelContextLimit('   '), 128_000);
});

// ─── getEffectiveContextLimit (env override) ──────────────────────

test('getEffectiveContextLimit: env override wins over table', () => {
  const prev = process.env.CLEMMY_MODEL_CONTEXT_LIMIT_GPT_5_4;
  process.env.CLEMMY_MODEL_CONTEXT_LIMIT_GPT_5_4 = '500000';
  try {
    assert.equal(getEffectiveContextLimit('gpt-5.4'), 500_000);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_MODEL_CONTEXT_LIMIT_GPT_5_4;
    else process.env.CLEMMY_MODEL_CONTEXT_LIMIT_GPT_5_4 = prev;
  }
});

test('getEffectiveContextLimit: invalid env override is ignored (falls back to table)', () => {
  const prev = process.env.CLEMMY_MODEL_CONTEXT_LIMIT_GPT_5_4;
  process.env.CLEMMY_MODEL_CONTEXT_LIMIT_GPT_5_4 = 'not-a-number';
  try {
    assert.equal(getEffectiveContextLimit('gpt-5.4'), 200_000);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_MODEL_CONTEXT_LIMIT_GPT_5_4;
    else process.env.CLEMMY_MODEL_CONTEXT_LIMIT_GPT_5_4 = prev;
  }
});

// ─── predictTurnCost ──────────────────────────────────────────────

test('predictTurnCost: minimal turn (no tools) sums state + input + default output + default static overhead', () => {
  const cost = predictTurnCost({ currentStateTokens: 5_000, userInputTokens: 100 });
  // 5000 + 100 + 0 tools + 1500 default output + 20000 default static overhead = 26600
  assert.equal(cost, 26_600);
});

test('predictTurnCost: tool calls multiply by avg return size', () => {
  const cost = predictTurnCost({
    currentStateTokens: 1_000,
    userInputTokens: 50,
    plannedToolCallCount: 5,
    avgToolReturnTokens: 2_000,
    expectedOutputTokens: 1_000,
    staticOverheadTokens: 0, // disable for this test's math clarity
  });
  // 1000 + 50 + (5 * 2000) + 1000 + 0 = 12050
  assert.equal(cost, 12_050);
});

test('predictTurnCost: negative inputs clamped to 0 (defensive)', () => {
  const cost = predictTurnCost({
    currentStateTokens: -100,
    userInputTokens: -1,
    plannedToolCallCount: -3,
    staticOverheadTokens: 0,
  });
  // All clamped to 0; expectedOutput defaults to 1500
  assert.equal(cost, 1_500);
});

test('predictTurnCost: explicit static overhead is honored', () => {
  const cost = predictTurnCost({
    currentStateTokens: 1_000,
    userInputTokens: 50,
    staticOverheadTokens: 30_000,
  });
  // 30000 + 1000 + 50 + 0 + 1500 = 32550
  assert.equal(cost, 32_550);
});

test('predictTurnCost: env override wins over both default and explicit', () => {
  const prev = process.env.CLEMMY_PREFLIGHT_STATIC_OVERHEAD;
  process.env.CLEMMY_PREFLIGHT_STATIC_OVERHEAD = '50000';
  try {
    const cost = predictTurnCost({
      currentStateTokens: 1_000,
      userInputTokens: 50,
      staticOverheadTokens: 5_000, // ignored — env wins
    });
    // 50000 + 1000 + 50 + 1500 = 52550
    assert.equal(cost, 52_550);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_PREFLIGHT_STATIC_OVERHEAD;
    else process.env.CLEMMY_PREFLIGHT_STATIC_OVERHEAD = prev;
  }
});

// ─── checkBudget ──────────────────────────────────────────────────

test('checkBudget: well-under threshold returns ok', () => {
  const result = checkBudget({ predictedTokens: 10_000, modelId: 'gpt-5.4' });
  // 10000 / max(200000, 64000) = 5% → ok
  assert.equal(result.status, 'ok');
  assert.equal(result.effectiveLimit, 200_000);
  assert.ok(result.fractionUsed < 0.1);
});

test('checkBudget: above warn threshold returns warn', () => {
  const result = checkBudget({ predictedTokens: 160_000, modelId: 'gpt-5.4' });
  // 160000 / 200000 = 80% → above 75% warn, below 85% block
  assert.equal(result.status, 'warn');
});

test('checkBudget: above block threshold returns block', () => {
  const result = checkBudget({ predictedTokens: 190_000, modelId: 'gpt-5.4' });
  // 190000 / 200000 = 95% → block
  assert.equal(result.status, 'block');
});

test('checkBudget: small-context model uses FLOOR not raw limit', () => {
  // A model with limit < MINIMUM_CONTEXT_FLOOR uses the floor as
  // the threshold base, so warnings don't trip at trivial payloads.
  const result = checkBudget({
    predictedTokens: MINIMUM_CONTEXT_FLOOR / 2, // 32K
    modelId: 'gpt-5.4-nano', // 64K limit
  });
  // effectiveLimit = max(64000, 64000) = 64000
  // 32000 / 64000 = 50% → ok
  assert.equal(result.status, 'ok');
  assert.equal(result.effectiveLimit, MINIMUM_CONTEXT_FLOOR);
});

test('checkBudget: custom thresholds accepted', () => {
  const result = checkBudget({
    predictedTokens: 100_000,
    modelId: 'gpt-5.4',
    warnFraction: 0.4,
    blockFraction: 0.6,
  });
  // 100000 / 200000 = 50% → above 40% warn, below 60% block
  assert.equal(result.status, 'warn');
  assert.equal(result.warnFraction, 0.4);
  assert.equal(result.blockFraction, 0.6);
});

test('checkBudget: rejects invalid threshold ordering', () => {
  assert.throws(
    () => checkBudget({ predictedTokens: 1000, modelId: 'gpt-5.4', warnFraction: 0.8, blockFraction: 0.6 }),
    /blockFraction.*must be in/,
  );
});

test('checkBudget: rejects out-of-range warnFraction', () => {
  assert.throws(
    () => checkBudget({ predictedTokens: 1000, modelId: 'gpt-5.4', warnFraction: 1.5 }),
    /warnFraction must be in/,
  );
});

test('checkBudget: result.reason is human-readable and includes percentage', () => {
  const result = checkBudget({ predictedTokens: 100_000, modelId: 'gpt-5.4' });
  // 100000 / 200000 = 50%
  assert.match(result.reason, /50%/);
});

// 2026-07-08: the live BYO id "zai-org/GLM-5.2" (org-prefixed, mixed case) fell
// to the conservative 128K default — silently cutting GLM's usable window from
// 1M. Org-prefixed and case-variant ids must resolve to their table entry.
test('modelContextLimit: org-prefixed + mixed-case BYO ids resolve (zai-org/GLM-5.2 → 1M)', () => {
  assert.equal(modelContextLimit('zai-org/GLM-5.2'), 1_000_000);
  assert.equal(modelContextLimit('GLM-5.2'), 1_000_000);
  assert.equal(modelContextLimit('deepseek-ai/DeepSeek-V4'), 128_000, 'deepseek prefix still matches through the org form');
  // A genuinely unknown id still falls back conservatively.
  assert.equal(modelContextLimit('totally-unknown-model'), 128_000);
});
