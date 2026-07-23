/**
 * Run: npx tsx --test src/memory/derive-title.test.ts
 *
 * Synthetic report-back turns ("[background task bg-x completed] …") must
 * become human titles, never leak their bracketed id prefix — including
 * stored titles that were clipped mid-head before the fix existed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTitle, humanizeReportBackTitle } from './derive-title.js';

test('report-back head with a title becomes "Background task: <headline>"', () => {
  const text = '[background task bg-mr440n9u-e1340 completed] Summarize the pipeline\n\nAll rows reconciled.\n\n(This ran in the background and just finished — continue from here.)';
  assert.equal(humanizeReportBackTitle(text), 'Background task: Summarize the pipeline');
  assert.equal(deriveTitle(text), 'Background task: Summarize the pipeline');
});

test('workflow-run head without a title falls back to the first body line', () => {
  const text = '[workflow run 1781852780491-3f66 FAILED]\n\nStep post_slack was blocked on approval.\n\n(This FAILED — it did NOT complete.)';
  assert.equal(humanizeReportBackTitle(text), 'Workflow run: Step post_slack was blocked on approval.');
});

test('a clipped stored title (no closing bracket) heals to the bare label', () => {
  assert.equal(humanizeReportBackTitle('[background task bg-mr440n9u-e1340'), 'Background task');
  assert.equal(humanizeReportBackTitle('[workflow run 1781852822512-f6615f co'), 'Workflow run');
});

test('non-report-back text passes through untouched', () => {
  assert.equal(humanizeReportBackTitle('can we send out the slack activity update please'), null);
  assert.equal(deriveTitle('please draft the follow-up email'), 'draft the follow-up email');
  assert.equal(deriveTitle('   ', 'New chat'), 'New chat');
  // Bracketed text that is not the synthetic prefix stays a normal title.
  assert.equal(humanizeReportBackTitle('[urgent] fix the report'), null);
});
