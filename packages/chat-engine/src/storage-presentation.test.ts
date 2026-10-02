import assert from 'node:assert/strict';
import { test } from 'node:test';
import { storageDatabaseSummary } from './storage-presentation.js';

test('storage copy never calls logical payload reduction or reusable pages freed disk space', () => {
  const lines = storageDatabaseSummary({ state: 'measured', allocatedBytes: 6_000_000_000, reusableBytes: 1_000_000,
    historyConversion: { state: 'blocked', scannedRows: 10, convertedHistories: 8, netLogicalPayloadBytesRemoved: 4_000_000 } });
  assert.match(lines.join(' '), /1.00 MB.*reuse/);
  assert.match(lines.join(' '), /still on disk/);
  assert.match(lines.join(' '), /payload by 4.00 MB/);
  assert.match(lines.join(' '), /needs attention.*preserved.*not skipped/);
  assert.doesNotMatch(lines.join(' '), /freed|deleted|running|completed/);
  assert.deepEqual(storageDatabaseSummary(undefined), []);
  assert.deepEqual(storageDatabaseSummary({ state: 'unavailable' }), ['Database space details are unavailable.']);
});
