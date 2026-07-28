import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectAddressedApproval } from './approval-addressing.js';

const rows = [
  { approvalId: 'apr-a111', subject: 'Create the Airtable record' },
  { approvalId: 'apr-b222', subject: 'Update the calendar event' },
];

test('approval addressing requires an exact id when multiple cards are pending', () => {
  assert.deepEqual(selectAddressedApproval(rows), { kind: 'ambiguous', rows });
  assert.deepEqual(selectAddressedApproval(rows, 'apr-b222'), {
    kind: 'selected',
    row: rows[1],
  });
  assert.deepEqual(selectAddressedApproval(rows, 'apr-nope'), {
    kind: 'missing',
    approvalId: 'apr-nope',
  });
});

test('a bare decision may select the sole actionable approval and never invents one', () => {
  assert.deepEqual(selectAddressedApproval([rows[0]]), {
    kind: 'selected',
    row: rows[0],
  });
  assert.deepEqual(selectAddressedApproval([]), { kind: 'none' });
});
