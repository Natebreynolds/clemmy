/**
 * Parity guard: the correction hook must be wired on EVERY brain lane. A memory
 * control on one lane only is the recurring two-lane-drift bug — this test fails
 * loudly if a new lane (or a refactor) drops the negative half of the credit loop.
 *
 * Run: npx tsx --test src/runtime/harness/correction-parity.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

const LANES = ['loop.ts', 'claude-agent-brain.ts', 'plan-first.ts'];

// Every brain lane must route its post-turn work through the ONE shared seam,
// so a new post-turn behavior wires in a single place and can never be dropped
// on a lane (the two-lane-drift bug).
for (const lane of LANES) {
  test(`${lane} runs post-turn hooks via the shared spine`, () => {
    const src = readFileSync(path.join(here, lane), 'utf8');
    assert.match(src, /runPostTurnHooks\(/, `${lane} must call the shared runPostTurnHooks seam`);
    assert.match(src, /from '\.\/post-turn\.js'/, `${lane} must import the shared post-turn spine`);
  });
}

// The seam itself must contain BOTH halves of the credit loop.
test('the post-turn spine runs correction detection AND auto-credit', () => {
  const src = readFileSync(path.join(here, 'post-turn.ts'), 'utf8');
  assert.match(src, /safeDetectCorrection\(/, 'the spine must run correction detection');
  assert.match(src, /autoCreditRecallRuns\(/, 'the spine must run auto-credit');
});

// No lane may reach past the seam and call a post-turn hook directly. This is
// what turns "call the shared seam" into an enforceable invariant: the resume
// path (which needs auto-credit but NOT correction) must still route through
// runPostTurnHooks with detectCorrection:false, never its own auto-credit call —
// otherwise a future hook added to the seam silently misses it.
for (const lane of LANES) {
  test(`${lane} does not bypass the seam with a direct hook call`, () => {
    const src = readFileSync(path.join(here, lane), 'utf8');
    assert.doesNotMatch(src, /\bautoCreditRecallRuns\s*\(/, `${lane} must not call auto-credit outside the seam`);
    assert.doesNotMatch(src, /\bsafeDetectCorrection\s*\(/, `${lane} must not call correction detection outside the seam`);
  });
}
