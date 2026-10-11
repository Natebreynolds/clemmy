import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectMultiItemIntent, detectMultiItemIntentFromConversation } from './multi-item-intent.js';

test('report quantities and unrelated work verbs do not declare independent jobs', () => {
  for (const input of [
    'Prepare a synthetic batch report at /tmp/clementine-fixtures/output/clarification-live/artifacts/compound-trigger-20b8bf6f/report.txt, with exactly five plain-text lines labeled Source:, RGL:, Quantity:, Timing:, and Trigger:. Before creating or changing any file, ask me to confirm source label CEDAR BATCH LOG, what RGL means and what condition triggers it, quantity 10–12 cases, and timing 2026-10-06 09:00 America/Los_Angeles. Hold file changes until every detail is settled. This report only describes RGL; do not run any batch action. This is a current task only; do not save standing memory, use the browser, send messages, change settings or modify other content.',
    'Write a local report. Before creating any file, ask me to confirm quantity 12 cases.',
    'Prepare the report. Quantity: 12 cases. Timing: tomorrow.',
    'Write a report. The order contains 12 cases.',
    'Write a report with quantity 12 cases.',
    'There are 12 firms in the report. I have two wording changes; research those changes.',
  ]) {
    assert.equal(detectMultiItemIntent(input).isMultiItem, false, input);
  }
});

test('quantity ranges and bounds cannot supply exact fanout cardinality', () => {
  for (const quantity of [
    '10-12', '10–12', '10—12', '10−12', '10‑12',
    '10 to 12', '10 through 12', 'between 10 and 12', 'between ten and 12',
    'ten to 12', 'from 10 to 12', 'up to 12', 'at least 12', 'at most 12',
  ]) {
    const input = `Research ${quantity} firms before creating the report.`;
    const intent = detectMultiItemIntent(input);
    assert.equal(intent.isMultiItem, false, input);
    assert.equal(intent.itemCount, 0, 'a bound is not an exact target count');
  }
});

test('exact targets, explicit per-item work and lists retain fanout despite incidental ranges', () => {
  for (const input of [
    'Research these 12 firms.',
    'Research 12 firms and summarize each one.',
    'I found these 12 firms. Should I research them next?',
    'Research these 12 firms; write 2–3 sentences for each.',
    'Create one report per case for these 12 cases.',
    'Tag each of these 12 records.',
    'Prepare one workspace, then research these 12 firms.',
    'Create one workspace and research these 12 firms.',
  ]) {
    const intent = detectMultiItemIntent(input);
    assert.equal(intent.isMultiItem, true, input);
    assert.equal(intent.itemCount, 12, input);
  }
  const listed = detectMultiItemIntent('Audit each target:\n1. North (10–12 staff)\n2. South\n3. East');
  assert.equal(listed.isMultiItem, true);
  assert.equal(listed.itemCount, 3);
  assert.deepEqual(listed.exactMembers, ['North (10–12 staff)', 'South', 'East']);
});

test('direct counted authoring still declares the exact independent outputs', () => {
  for (const [input, count] of [
    ['Write 12 reports.', 12],
    ['Generate 6 images.', 6],
    ['Draft 4 emails.', 4],
    ['Create 5 project plans.', 5],
  ] as const) {
    const intent = detectMultiItemIntent(input);
    assert.equal(intent.isMultiItem, true, input);
    assert.equal(intent.itemCount, count, input);
  }
});

test('a bare yes to a counted write proposal carries that batch; a fresh counted write still does not', () => {
  const proposal = ['Should I send Outlook emails to all 18 contacts?'];
  const affirmed = detectMultiItemIntentFromConversation('Yes.', proposal);
  assert.equal(affirmed.isMultiItem, true);
  assert.equal(affirmed.itemCount, 18);
  assert.equal(affirmed.carriedFromPrior, true);
  // The same counted write asked fresh keeps the 10-05 precision.
  assert.equal(detectMultiItemIntent('send Outlook emails to the 18 contacts').isMultiItem, false);
  // A range in the proposal is still not an exact set, even when affirmed.
  assert.equal(detectMultiItemIntentFromConversation('Yes.', ['Should I email 10–12 of the contacts?']).isMultiItem, false);
});
