import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPreflightBlockMessage } from './loop.js';

// 2026-05-30: the preflight budget gate was demoted from an OVERRIDE
// ("you MUST propose_plan / do NOT fire tool calls") to ADVISORY context.
// Guardrails inform the agent's decision; they never make it. See
// [[feedback_guardrails_inform_not_override]]. These tests pin the new
// contract: default = heads-up that keeps the task moving; legacy block
// behavior is still reachable behind CLEMMY_PREFLIGHT_LEGACY_BLOCK=on.

test('preflight notice (default) is advisory, not a hard stop', () => {
  const prev = process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK;
  delete process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK;
  try {
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
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK;
    else process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK = prev;
  }
});

test('preflight notice mentions create_plan only as an OPTION', () => {
  const prev = process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK;
  delete process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK;
  try {
    const message = buildPreflightBlockMessage({
      predictedTokens: 100_000,
      blockFraction: 0.92,
      effectiveLimit: 50_000,
    });
    assert.match(message, /create_plan/);
    // framed as optional ("MAY"), never mandatory
    assert.match(message, /MAY/);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK;
    else process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK = prev;
  }
});

test('legacy block message still available behind opt-in env', () => {
  const prev = process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK;
  process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK = 'on';
  try {
    const message = buildPreflightBlockMessage({
      predictedTokens: 100_000,
      blockFraction: 0.85,
      effectiveLimit: 50_000,
    });
    assert.match(message, /You MUST call `propose_plan`/);
    assert.match(message, /Do NOT fire external tool calls/);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK;
    else process.env.CLEMMY_PREFLIGHT_LEGACY_BLOCK = prev;
  }
});
