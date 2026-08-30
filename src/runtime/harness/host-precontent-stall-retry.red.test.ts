/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/harness/host-precontent-stall-retry.red.test.ts
 *
 * OPEN-THE-GATES 5.1. Host-turn-runner swallowed ModelStreamStalledError as
 * blockedOutcome. loop.ts already retries pre-content stalls with no paid
 * request in flight. Live GLM/Grok first-content-timeout after tool_search
 * logged a Codex rescue hop then immediately blocked
 * (sess-desktop-8e7470 / 2bc15b). Retry the model step; the silenced brain
 * is already marked so rescue is preselected.
 *
 * Re-break two ways:
 *   (i)  immediate blockedOutcome on every ModelStreamStalledError
 *   (ii) retry a stall that still has a buffered paid request
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = new URL('./host-turn-runner.ts', import.meta.url);

function modelStepCatchBlock(src: string): string {
  const start = src.indexOf('step = await runOneModelStep(');
  const end = src.indexOf('// ADMIT BEFORE COMMIT.', start);
  assert.ok(start >= 0, 'host runner must retain the one-step model boundary');
  assert.ok(end > start, 'host runner must admit the response only after its stall catch');
  return src.slice(start, end);
}

test('NEGATIVE: a pre-content stall with no paid request in flight must retry the model step', () => {
  const src = readFileSync(SRC, 'utf8');
  assert.match(src, /remainingPreContentStallRetries/);
  assert.match(src, /error\.preContent/);
  assert.match(src, /!error\.bufferedProviderRequestInFlight/);
  assert.match(src, /stepIndex -= 1/);
});

test('re-break (i): the old catch blocked every stall', () => {
  const src = readFileSync(SRC, 'utf8');
  const catchBlock = modelStepCatchBlock(src);
  assert.match(catchBlock, /remainingPreContentStallRetries -= 1/);
  assert.match(catchBlock, /continue;/);
});

test('re-break (ii): a buffered paid request still fails closed', () => {
  const src = readFileSync(SRC, 'utf8');
  const catchBlock = modelStepCatchBlock(src);
  assert.match(catchBlock, /bufferedProviderRequestInFlight/);
  assert.match(catchBlock, /return blockedOutcome\(HOST_MODEL_STALL_BLOCKED_TEXT, 'model_stalled'\)/);
});
