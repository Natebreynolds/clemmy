import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canSkipMemoryConflictReview, includeUnembeddedConflictCandidates } from './conflict-candidate-coverage.js';

const fact = (id: number, kind = 'project', active = true) => ({ id, kind, active });

test('a fresh unembedded match prevents false novelty despite a full low-cosine result', () => {
  const semantic = [1, 2, 3, 4, 5].map(id => ({ fact: fact(id), sim: 0.3 }));
  const result = includeUnembeddedConflictCandidates(semantic, [fact(6)], new Set([1, 2, 3, 4, 5]), 'project');
  assert.equal(result.length, 6);
  assert.deepEqual(result[5], { fact: fact(6), sim: null });
  assert.equal(canSkipMemoryConflictReview(result, 0.6), false);
  assert.equal(semantic.length, 5);
});

test('supplemental coverage preserves kind, active state, uniqueness, and bounds', () => {
  const semantic = [{ fact: fact(1), sim: 0.4 }];
  const lexical = [fact(1), fact(2), fact(3, 'user'), fact(4, 'project', false), fact(5), fact(5), fact(6), fact(7)];
  assert.deepEqual(includeUnembeddedConflictCandidates(semantic, lexical, new Set([1, 2]), 'project', 2)
    .map(item => item.fact.id), [1, 5, 6]);
});

test('novelty skips review only when every candidate has a known low similarity', () => {
  assert.equal(canSkipMemoryConflictReview([{ sim: 0.3 }, { sim: 0.4 }], 0.6), true);
  for (const scored of [[], [{ sim: null }], [{ sim: 0.6 }], [{ sim: 0.9 }], [{ sim: NaN }]]) {
    assert.equal(canSkipMemoryConflictReview(scored, 0.6), false);
  }
  assert.equal(canSkipMemoryConflictReview([{ sim: 0.2 }], undefined), false);
});
