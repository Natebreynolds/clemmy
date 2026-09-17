import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countWorkspaceRecords, renderWorkspaceSourceRecords, SOURCE_PAGE_MAX_BYTES } from './workspace-data-digest.js';

test('a page of records stays under the inline size and names the exact next offset, losing no record', () => {
  const records = Array.from({ length: 60 }, (_, index) => ({ id: `deal-${index}`, notes: 'x'.repeat(900) }));
  const dataset = { pipeline: { complete: true, result: { data: { records } } } };
  const seen: string[] = [];
  let offset = 0;
  for (let pages = 0; pages < 20 && offset < records.length; pages += 1) {
    const page = renderWorkspaceSourceRecords(dataset as never, 'pipeline', 60, offset);
    assert.ok(Buffer.byteLength(page, 'utf8') < SOURCE_PAGE_MAX_BYTES + 2_000, `page at ${offset} stays small`);
    const ids = [...page.matchAll(/"id":"(deal-\d+)"/g)].map((match) => match[1]!);
    assert.ok(ids.length > 0);
    seen.push(...ids);
    const next = page.match(/offset (\d+)\./);
    offset = next ? Number(next[1]) : records.length;
  }
  assert.deepEqual(seen, records.map((record) => record.id));
});

test('one oversized record is still returned whole rather than an empty page', () => {
  const dataset = { big: [{ id: 'only', body: 'y'.repeat(40_000) }] };
  const page = renderWorkspaceSourceRecords(dataset as never, 'big', 20, 0);
  assert.match(page, /records 1–1 of 1/);
});

test('a source count is the records the view reads, not the first side list beside them', () => {
  // Command-line query output: the records sit under result, beside an empty warnings list.
  const cli = { status: 0, result: { done: true, totalSize: 3, records: [{ Id: 'a' }, { Id: 'b' }, { Id: 'c' }] }, warnings: [] };
  assert.equal(countWorkspaceRecords(cli), 3);
  assert.equal(countWorkspaceRecords({ status: 0, result: { done: true, totalSize: 0, records: [] }, warnings: [] }), 0);
  assert.equal(countWorkspaceRecords({ complete: true, result: { records: [{ id: 1 }] } }), 1);
  assert.equal(countWorkspaceRecords({ stdout: JSON.stringify([{ id: 1 }, { id: 2 }]) }), 2);
  assert.equal(countWorkspaceRecords([]), 0);
  assert.equal(countWorkspaceRecords({ summary: { total: 5 }, warnings: [] }), null, 'an empty side list says nothing about rows');
  assert.equal(countWorkspaceRecords({ total: 5 }), null);
});
