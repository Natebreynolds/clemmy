import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRecursivePatternSources } from './recursive-pattern-sources.js';

test('each pattern selects only its cited source facts in citation order', () => {
  const rows = [{ id: 1, depth: 0 }, { id: 2, depth: 0 }, { id: 3, depth: 4 }];
  assert.deepEqual(selectRecursivePatternSources([2, 1], rows), [rows[1], rows[0]]);
  assert.deepEqual(selectRecursivePatternSources([1, 1, 2], rows), [rows[0], rows[1]]);
});

test('invalid citations cannot fall back to unrelated batch facts', () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  for (const ids of [undefined, [], [1], [1, 1], [1, 99], ['1', 2], [1.5, 2], [-1, 2]]) {
    assert.equal(selectRecursivePatternSources(ids, rows), null);
  }
});
