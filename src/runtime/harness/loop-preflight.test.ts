import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPreflightBlockMessage } from './loop.js';

// 2026-05-30: the preflight budget gate was demoted from an OVERRIDE
// ("you MUST propose_plan / do NOT fire tool calls") to ADVISORY context.
// Guardrails inform the agent's decision; they never make it. See
// [[feedback_guardrails_inform_not_override]]. The CLEMMY_PREFLIGHT_LEGACY_BLOCK
// opt-in to the old hard-stop was RETIRED in the 2026-07-09 subtraction pass
// (the advisory default has been the validated behavior since 2026-05-30) —
// these tests pin the advisory contract as the ONE behavior.

test('preflight notice is advisory, not a hard stop', () => {
  const message = buildPreflightBlockMessage({
    predictedTokens: 100_000,
    blockFraction: 0.92,
    effectiveLimit: 50_000,
  });
  // It informs about the budget...
  assert.match(message, /CONTEXT BUDGET NOTICE/);
  // ...explicitly tells the agent to keep working...
  assert.match(message, /guidance, not a stop|keep moving|proceed if the work is worth it/i);
  // ...and does NOT issue the old hard override.
  assert.doesNotMatch(message, /You MUST call `propose_plan`/);
  assert.doesNotMatch(message, /Do NOT fire (external )?tool calls in this turn/);
});

test('preflight notice mentions create_plan only as an OPTION', () => {
  const message = buildPreflightBlockMessage({
    predictedTokens: 100_000,
    blockFraction: 0.92,
    effectiveLimit: 50_000,
  });
  assert.match(message, /create_plan/);
  // framed as optional ("MAY"), never mandatory
  assert.match(message, /MAY/);
});

test('the retired CLEMMY_PREFLIGHT_LEGACY_BLOCK env no longer resurrects the hard stop', () => {
  const prev = process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK;
  process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK = 'on';
  try {
    const message = buildPreflightBlockMessage({
      predictedTokens: 100_000,
      blockFraction: 0.85,
      effectiveLimit: 50_000,
    });
    // The flag is inert now — the message stays advisory, never the old override.
    assert.match(message, /guidance, not a stop/);
    assert.doesNotMatch(message, /You MUST call `propose_plan`/);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK;
    else process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK = prev;
  }
});
