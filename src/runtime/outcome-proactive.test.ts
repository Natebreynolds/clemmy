/** Run: npx tsx --test src/runtime/outcome-proactive.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { shouldProactivelyReport } = await import('./outcome.js');

test('proactive report-back gate: idle chat sessions only', () => {
  assert.equal(shouldProactivelyReport('chat', null), true, 'no events at all → idle chat qualifies');
  assert.equal(shouldProactivelyReport('chat', 120_000), true, 'idle chat qualifies');
  assert.equal(shouldProactivelyReport('chat', 5_000), false, 'mid-turn chat must not get a colliding turn');
  assert.equal(shouldProactivelyReport('workflow', 120_000), false, 'workflow sessions never');
  assert.equal(shouldProactivelyReport('agent', 120_000), false);
  assert.equal(shouldProactivelyReport(null, 120_000), false);
});
