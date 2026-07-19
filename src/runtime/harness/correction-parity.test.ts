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

for (const lane of LANES) {
  test(`${lane} calls safeDetectCorrection alongside auto-credit`, () => {
    const src = readFileSync(path.join(here, lane), 'utf8');
    assert.match(src, /safeDetectCorrection\(/, `${lane} must invoke safeDetectCorrection`);
    assert.match(src, /from '\.\/correction-hook\.js'/, `${lane} must import the shared correction hook`);
  });
}
