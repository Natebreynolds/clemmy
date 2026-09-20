import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareWorkerResultShares, readSharedWorkerResult } from './worker-retained-results.js';

test('workers read only explicitly shared, unchanged parent results', () => {
  const row = { output: JSON.stringify({ records: Array.from({ length: 1000 }, (_, id) => ({ id })) }), truncatedAtWrite: false };
  const shares = prepareWorkerResultShares('parent', ['call-a', 'call-a'], id => id === 'call-a' ? row : null);
  assert.equal(shares.length, 1);
  assert.ok(JSON.stringify(shares).length < 200);
  let reads = 0;
  const read = (session: string, id: string) => { reads++; assert.equal(session, 'parent'); assert.equal(id, 'call-a'); return row; };
  assert.equal(readSharedWorkerResult('call-a', 'parent', shares, read), row);
  assert.equal(readSharedWorkerResult('call-b', 'parent', shares, read), null);
  assert.equal(readSharedWorkerResult('call-a', 'other', shares, read), null);
  assert.equal(readSharedWorkerResult('call-a', 'parent', [...shares, ...shares], read), null);
  assert.equal(reads, 1);
  assert.equal(readSharedWorkerResult('call-a', 'parent', shares, () => ({ ...row, output: 'changed' })), null);
  assert.equal(readSharedWorkerResult('call-a', 'parent', shares, () => ({ ...row, truncatedAtWrite: true })), null);
  assert.equal(readSharedWorkerResult('call-a', 'parent', shares, () => null), null);
});

test('missing and incomplete results never become worker grants', () => {
  assert.throws(() => prepareWorkerResultShares('parent', ['missing'], () => null), /missing or incomplete/);
  assert.throws(() => prepareWorkerResultShares('parent', ['partial'], () => ({ output: '{}', truncatedAtWrite: true })), /missing or incomplete/);
});
