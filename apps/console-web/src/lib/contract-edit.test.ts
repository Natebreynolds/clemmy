/** Run: npx tsx --test apps/console-web/src/lib/contract-edit.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListInput, validateContractDraft, OBJECTIVE_MAX_CHARS } from './contract-edit.js';

test('list input: one item per line, bullets stripped, caps surfaced as warnings', () => {
  const parsed = parseListInput('- Every row cites a source\n\n• Board ready before standup\n', 'Done when');
  assert.deepEqual(parsed.items, ['Every row cites a source', 'Board ready before standup']);
  assert.deepEqual(parsed.warnings, []);

  const overflow = parseListInput(Array.from({ length: 14 }, (_, i) => `item ${i}`).join('\n'), 'Done when');
  assert.equal(overflow.items.length, 12);
  assert.match(overflow.warnings[0], /first 12 items/);

  const long = parseListInput('x'.repeat(600), 'Always preserve');
  assert.equal(long.items[0].length, 500);
  assert.match(long.warnings[0], /shortened/);
});

test('an over-limit purpose is REJECTED with a message, never silently truncated', () => {
  const v = validateContractDraft({
    objective: 'x'.repeat(OBJECTIVE_MAX_CHARS + 1),
    criteriaText: '',
    invariantsText: '',
    hadContract: true,
  });
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /1201 characters/);
  assert.equal(v.patch, null);
});

test('blank purpose means "unchanged" on an existing contract, but is an error when none exists', () => {
  const existing = validateContractDraft({ objective: '  ', criteriaText: 'a\nb', invariantsText: '', hadContract: true });
  assert.equal(existing.ok, true);
  assert.deepEqual(existing.patch, { successCriteria: ['a', 'b'], invariants: [] });
  assert.ok(!('objective' in existing.patch!), 'blank objective is omitted, not sent as empty');

  const fresh = validateContractDraft({ objective: '', criteriaText: 'a', invariantsText: '', hadContract: false });
  assert.equal(fresh.ok, false);
  assert.match(fresh.errors[0], /purpose is required/i);
});

test('explicit empty lists clear (server semantics: [] clears, omission preserves)', () => {
  const v = validateContractDraft({ objective: 'Keep the board ready.', criteriaText: '', invariantsText: '', hadContract: true });
  assert.equal(v.ok, true);
  assert.deepEqual(v.patch, { objective: 'Keep the board ready.', successCriteria: [], invariants: [] });
});
