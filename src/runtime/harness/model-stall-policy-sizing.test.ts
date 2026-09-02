/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/model-stall-policy-sizing.test.ts
 *
 * First-content budgets scale with the prompt (owner rule 3, 2026-09-01): a
 * flat 150 s / 180 s read a 45k–100k-token prefill on a slow brain as a hang.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  FIRST_BYTE_SIZING_FREE_TOKENS,
  FIRST_BYTE_SIZING_MS_PER_10K_TOKENS,
  estimateRequestInputTokens,
  sizeFirstByteBudgetMs,
  sizedFirstByteStallMs,
  sizedBrainFalloverFirstByteMs,
  modelFirstByteStallMs,
  modelStreamStallMs,
} = await import('./model-stall-policy.js');

test('sizeFirstByteBudgetMs: free below 20k tokens, +10 s per 10k above, capped at the ceiling, disabled stays disabled', () => {
  assert.equal(sizeFirstByteBudgetMs(150_000, 0, 300_000), 150_000);
  assert.equal(sizeFirstByteBudgetMs(150_000, FIRST_BYTE_SIZING_FREE_TOKENS, 300_000), 150_000);
  assert.equal(sizeFirstByteBudgetMs(150_000, 60_000, 300_000), 150_000 + 4 * FIRST_BYTE_SIZING_MS_PER_10K_TOKENS);
  assert.equal(sizeFirstByteBudgetMs(150_000, 1_000_000, 300_000), 300_000, 'never past the stream wall');
  assert.equal(sizeFirstByteBudgetMs(0, 60_000, 300_000), 0, 'a disabled wall stays disabled');
  assert.equal(sizeFirstByteBudgetMs(150_000, Number.NaN, 300_000), 150_000);
});

test('the sized fallover budget stays strictly below the sized watchdog at every prompt size', () => {
  const watchdogBase = modelFirstByteStallMs();
  const streamWall = modelStreamStallMs();
  for (const chars of [1_000, 100_000, 400_000, 2_000_000, 8_000_000]) {
    const input = [{ role: 'user', content: 'x'.repeat(chars) }];
    const watchdog = sizedFirstByteStallMs(input);
    const fallover = sizedBrainFalloverFirstByteMs(150_000, input);
    assert.ok(watchdog >= watchdogBase, 'the watchdog only grows');
    assert.ok(watchdog <= streamWall, 'the watchdog never passes the stream wall');
    assert.ok(fallover < watchdog, `fallover ${fallover} must stay below the watchdog ${watchdog} at ${chars} chars`);
  }
  assert.equal(estimateRequestInputTokens([{ role: 'user', content: 'x'.repeat(40_000) }]) > 10_000, true);
  assert.equal(estimateRequestInputTokens(undefined), 1);
});
