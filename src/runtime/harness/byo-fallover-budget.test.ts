/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/byo-fallover-budget.test.ts
 *
 * A hung BYO brain must fall over, not kill the turn.
 *
 * The regression was invisible: `brainFalloverFirstByteMsForProvider` returned
 * undefined for BYO, for a real reason — the BYO adapter completes
 * non-streaming and emits one synthetic chunk, so its "first byte" IS the whole
 * completion and a 60s deadline would falsely fail healthy long work.
 *
 * But undefined did not mean "no deadline". It meant no FALLOVER deadline while
 * the loop's own first-byte watchdog still applied. So a hung BYO provider hit
 * the watchdog, retried the SAME dead brain, and the turn died without the
 * chain ever being consulted. Live 2026-08-28: three model.transport_timeout
 * retries against one provider and a dead turn, with a healthy Codex and Claude
 * sitting unused in the chain.
 *
 * The invariant is an ORDERING one, which is why it is pinned rather than left
 * to a comment: the fallover budget must fire BEFORE the watchdog, for every
 * provider. Above the watchdog, fallover is unreachable by construction.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { brainFalloverFirstByteMsForProvider } = await import('./router-model.js');
const { modelFirstByteStallMs } = await import('./model-stall-policy.js');

test('every provider has a fallover budget — undefined disables fallover entirely', () => {
  for (const provider of ['byo', 'codex', 'claude'] as const) {
    const budget = brainFalloverFirstByteMsForProvider(provider);
    assert.equal(typeof budget, 'number',
      `${provider} has no fallover budget, so a hang cannot switch brains — it can only die`);
    assert.ok((budget as number) > 0, `${provider} budget must be positive`);
  }
});

test('THE ORDERING INVARIANT: fallover fires strictly before the loop watchdog', () => {
  // If the budget meets or exceeds the watchdog, the watchdog kills the turn
  // first and the chain is never consulted. That is the exact shape of the
  // live failure, and it is silent — the turn just dies.
  const watchdog = modelFirstByteStallMs();
  assert.ok(watchdog > 0, 'the watchdog must be active for this pin to mean anything');
  for (const provider of ['byo', 'codex', 'claude'] as const) {
    const budget = brainFalloverFirstByteMsForProvider(provider) as number;
    assert.ok(budget < watchdog,
      `${provider}: fallover budget ${budget}ms >= watchdog ${watchdog}ms — the watchdog would kill `
      + 'the turn before the chain could switch brains, disabling fallover for a silent hang');
  }
});

test('BYO gets MORE headroom than a streaming brain, because its first byte is the whole completion', () => {
  // The original concern was real and must not be lost: a short deadline would
  // falsely fail healthy long BYO work. The answer is a longer budget, not none.
  const byo = brainFalloverFirstByteMsForProvider('byo') as number;
  const codex = brainFalloverFirstByteMsForProvider('codex') as number;
  assert.ok(byo > codex,
    `BYO budget ${byo}ms should exceed the streaming budget ${codex}ms — its first byte is the `
    + 'full completion, so it legitimately needs longer before being judged hung');
});

test('a transport timeout is fallover-eligible, so the budget has somewhere to go', async () => {
  // The budget only matters if the resulting error actually advances the chain.
  // Both halves must hold: a deadline that fires, and an error class that moves.
  const { isFalloverError } = await import('./fallback-model.js');
  const { BoundaryError } = await import('../boundary-error.js');
  for (const kind of ['model.transport_timeout', 'model.empty_completion', 'model.overloaded']) {
    assert.equal(
      isFalloverError(new BoundaryError({ kind, retryable: true, userMessage: 'x', operatorMessage: 'x' } as never)),
      true,
      `${kind} must advance the chain; otherwise the budget fires and nothing happens`,
    );
  }
});
