/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/full-page.test.ts
 *
 * A list that came back exactly as full as the page size the call asked for
 * is named as one page, not a total; a short selection, or a list shorter
 * than its page, is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullPageNote } from './full-page.js';

const page = (n: number) => JSON.stringify({ data: { value: Array.from({ length: n }, (_, i) => ({ id: `m${i}` })) }, successful: true });

test('a list exactly as full as the page size asked for is one page, not a total', () => {
  const carrier = { tool_slug: 'LIST_ITEMS', arguments: JSON.stringify({ folder: 'inbox', top: 1000 }) };
  assert.match(fullPageNote(carrier, page(1000)) ?? '', /returned 1000 records, exactly the 1000 it asked for/);
  assert.match(fullPageNote({ limit: 200 }, page(200)) ?? '', /one page, not a total/);
  // A carrier sees its child's bounded view; the recorded total is the count.
  const view = JSON.stringify({ data: { value: Array.from({ length: 64 }, (_, i) => ({ id: `m${i}` })) },
    __clementine: { kind: 'structured_projection_v1', records: { path: 'data.value', total: 1000, shown: 64 } } });
  assert.match(fullPageNote({ args_json: JSON.stringify(carrier) }, view) ?? '', /exactly the 1000 it asked for/);
});

test('a short selection, a list shorter than its page, or no list at all says nothing', () => {
  assert.equal(fullPageNote({ top: 5 }, page(5)), null, 'five most recent is the whole answer');
  assert.equal(fullPageNote({ top: 1000 }, page(612)), null, 'a partial page is the end of the list');
  assert.equal(fullPageNote({ top: 1000 }, 'plain text'), null);
  assert.equal(fullPageNote({ year: 2026 }, page(60)), null);
});
