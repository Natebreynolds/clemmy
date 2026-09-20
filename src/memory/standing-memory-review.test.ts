import assert from 'node:assert/strict';
import test from 'node:test';
import { explicitMemoryNeedsScopeReview, parseStandingMemoryReview } from './standing-memory-review.js';

test('explicit candidates with remaining clauses need scope review; complete claims do not', () => {
  assert.equal(explicitMemoryNeedsScopeReview('Remember that reports use minutes.', 'reports use minutes.'), false);
  assert.equal(explicitMemoryNeedsScopeReview('Remember reports use minutes!', 'reports use minutes'), false);
  assert.equal(explicitMemoryNeedsScopeReview('Remember reports should show completed items and show minutes.',
    'reports should show completed items'), true);
  assert.equal(explicitMemoryNeedsScopeReview('Remember reports use minutes. Then show today’s report.',
    'reports use minutes.'), true);
  assert.equal(explicitMemoryNeedsScopeReview('Read today’s report. Remember reports use minutes.',
    'reports use minutes.'), false);
});

test('a standing review keeps only the grounded future clause of a mixed task', () => {
  const clause = 'Every Monday, send the digest to my review list unless I cancel it.';
  const source = `Build a board now. ${clause} Use a blue heading on the board.`;
  const review = parseStandingMemoryReview(JSON.stringify({ scope: 'standing', text: clause, reason: 'Recurring request' }), source);
  assert.equal(review.text, clause);
  assert.doesNotMatch(review.text!, /board|blue/);
});

test('a task-only review cannot smuggle a candidate into durable memory', () => {
  assert.deepEqual(parseStandingMemoryReview({ scope: 'task', text: 'Always save the board', reason: 'Artifact requirement' }, 'Build a board'),
    { scope: 'task', reason: 'Artifact requirement' });
});

test('invented standing text and malformed classifications remain retryable errors', () => {
  const source = 'Build a board and always preserve its task filter.';
  for (const value of [null, {}, { scope: 'permanent', reason: 'guess' },
    { scope: 'standing', text: '', reason: 'empty' },
    { scope: 'standing', text: 'Always create a board for every request.', reason: 'invented' }]) {
    assert.throws(() => parseStandingMemoryReview(value, source));
  }
});
