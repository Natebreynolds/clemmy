/** Run: node scripts/run-tests-isolated.mjs src/tools/workflow-disabled-names-a-door.test.ts
 *
 * A disabled or missing saved workflow must not end the turn.
 *
 * "Disabled" means do not run this saved DEFINITION — never "do not do this
 * work". Live 2026-09-03 run 29: a cold request matched a saved workflow, the
 * model was told only `Workflow "<name>" is disabled.`, and the turn ended on
 * that sentence with ZERO business calls on a request it was fully equipped to
 * carry out directly. Tenth instance that day of one property: the harness
 * holds the answer and does not say it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ADMIT = readFileSync(new URL('./admit-named-workflow-run.ts', import.meta.url), 'utf8');
const QUEUE = readFileSync(new URL('./workflow-run-queue.ts', import.meta.url), 'utf8');

for (const [label, src] of [['admit', ADMIT], ['queue', QUEUE]]) {
  test(`${label}: a disabled workflow names the direct door`, () => {
    // Match on the message fragments, not one contiguous phrase: the strings
    // are template concatenations split across lines.
    const i = src.indexOf('so it will not be run');
    assert.ok(i > 0, 'the disabled refusal must name that only the DEFINITION is off');
    const block = src.slice(i, i + 600);
    assert.match(block, /block the request/, 'the work is still doable');
    assert.match(block, /tool_search/, 'and the door is named');
  });
}

test('admit: a missing workflow also names the direct door', () => {
  const i = ADMIT.indexOf('not found.');
  assert.ok(i > 0);
  const block = ADMIT.slice(i, i + 500);
  assert.match(block, /block the work/, 'absence is not incapacity');
  assert.match(block, /tool_search/, 'and the door is named');
});
