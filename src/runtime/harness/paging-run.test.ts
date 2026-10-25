/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/paging-run.test.ts
 *
 * The same list read page after page is told what paging costs from the
 * third page; lookups by different ids, and different lists, are not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pagingRunLength, pagingRunNote, PAGING_NOTE_FROM } from './paging-run.js';

const base = { folder: 'inbox', filter: 'isRead eq false', top: 1000 };
const returned = new Set(['cursor-page-2', 'cursor-page-3', 'cursor-page-4']);
const isReturned = (value: string) => returned.has(value);

test('a cursor copied from each result into the next call is paging', () => {
  const earlier = [
    { operation: 'LIST_ITEMS', args: { ...base } },
    { operation: 'LIST_ITEMS', args: { ...base, page_token: 'cursor-page-2' } },
  ];
  assert.equal(pagingRunLength(earlier, { operation: 'LIST_ITEMS', args: { ...base, page_token: 'cursor-page-3' } }, isReturned), 3);
  assert.ok(PAGING_NOTE_FROM <= 3);
  assert.match(pagingRunNote('c3', 'LIST_ITEMS', 3), /page 3 of the same LIST_ITEMS list/);
});

test('an offset that only grows is paging; one that jumps back is not', () => {
  const earlier = [
    { operation: 'LIST_ITEMS', args: { ...base, skip: 0 } },
    { operation: 'LIST_ITEMS', args: { ...base, skip: 1000 } },
  ];
  assert.equal(pagingRunLength(earlier, { operation: 'LIST_ITEMS', args: { ...base, skip: 2000 } }, isReturned), 3);
  assert.equal(pagingRunLength(earlier, { operation: 'LIST_ITEMS', args: { ...base, skip: 500 } }, isReturned), 1);
});

test('lookups by different ids, a different list, or two changed arguments are not paging', () => {
  const lookups = [
    { operation: 'GET_ITEM', args: { id: 'a1' } },
    { operation: 'GET_ITEM', args: { id: 'b2' } },
  ];
  assert.equal(pagingRunLength(lookups, { operation: 'GET_ITEM', args: { id: 'c3' } }, isReturned), 1);
  assert.equal(pagingRunLength([{ operation: 'OTHER', args: base }], { operation: 'LIST_ITEMS', args: base }, isReturned), 1);
  const windows = [{ operation: 'LIST_EVENTS', args: { start: 'mon', end: 'tue' } }];
  assert.equal(pagingRunLength(windows, { operation: 'LIST_EVENTS', args: { start: 'tue', end: 'wed' } }, isReturned), 1);
  assert.equal(pagingRunLength([], { operation: 'LIST_ITEMS', args: base }, isReturned), 1);
});
