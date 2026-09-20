import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewedArgumentsWithLocalNulls } from './reviewed-local-null-arguments.js';

const local = { identity: { kind: 'local_registry' }, inputSchema: { properties: {
  slug: { type: 'string' }, limit: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
  offset: { anyOf: [{ anyOf: [{ type: 'integer' }, { type: 'null' }] }, { type: 'null' }] },
} } };

test('reviewed native pagination accepts only transport-equivalent added nulls without changing the plan', () => {
  const expected = Object.freeze({ slug: 'framework-fixture' });
  const actual = { ...expected, limit: null, offset: null };
  assert.deepEqual(reviewedArgumentsWithLocalNulls(expected, actual, local), actual);
  assert.deepEqual(expected, { slug: 'framework-fixture' });
  assert.equal(reviewedArgumentsWithLocalNulls(expected, expected, local), expected);
});

test('provider nulls, unknown keys, non-null arguments and existing approved values remain exact', () => {
  const expected = { slug: 'framework-fixture' };
  for (const actual of [{ ...expected, unknown: null }, { ...expected, limit: 20 }, { slug: null }, null, []]) {
    assert.equal(reviewedArgumentsWithLocalNulls(expected, actual, local), expected);
  }
  assert.equal(reviewedArgumentsWithLocalNulls(expected, { ...expected, limit: null }, {
    ...local, identity: { kind: 'provider' },
  }), expected);
  const pinned = { ...expected, limit: 10 };
  assert.equal(reviewedArgumentsWithLocalNulls(pinned, { ...expected, limit: null }, local), pinned);
  assert.notDeepEqual(reviewedArgumentsWithLocalNulls(expected, { slug: 'other', offset: null }, local), { slug: 'other', offset: null });
});
