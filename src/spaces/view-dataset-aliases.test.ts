/**
 * Run: node scripts/run-tests-isolated.mjs src/spaces/view-dataset-aliases.test.ts
 *
 * A view sees each source's records under `records`, located the way the
 * kit's clem.rows locates them. Live 2026-09-22 (Daily Brief): records stored
 * under `result.data.value`, a hand-rolled rows() in the view, an empty board.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-view-aliases-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { withSourceRecordAliases } = await import('./data-store.js');

test('a read envelope with records under result.data.value gains a top-level records alias', () => {
  const data = {
    _meta: { calendar: { refreshedAt: 'x' } },
    calendar: { complete: true, result: { data: { '@odata.context': 'ctx', value: [{ subject: 'A' }, { subject: 'B' }] } } },
    inbox: { complete: true, result: { data: { value: [] } } },
    tasks: [{ id: 't1' }],
    note: 'plain',
  };
  const out = withSourceRecordAliases(data) as Record<string, any>;
  assert.deepEqual(out.calendar.records, [{ subject: 'A' }, { subject: 'B' }]);
  assert.equal(out.calendar.complete, true, 'the envelope keeps its own fields');
  assert.deepEqual(out.calendar.result.data.value, [{ subject: 'A' }, { subject: 'B' }]);
  assert.deepEqual(out.inbox.records, [], 'an empty record list is still a list');
  assert.deepEqual(out.tasks, [{ id: 't1' }], 'an array source is untouched');
  assert.equal(out.note, 'plain');
  assert.deepEqual(out._meta, data._meta, '_meta is untouched');
  assert.notEqual(out, data, 'the stored object is never mutated');
  assert.equal((data.calendar as any).records, undefined);
});

test('an existing records array is left alone; non-objects pass through', () => {
  const data = { src: { records: [{ id: 1 }], extra: 1 } };
  const out = withSourceRecordAliases(data) as Record<string, any>;
  assert.equal(out.src, data.src);
  assert.equal(withSourceRecordAliases(null), null);
  assert.deepEqual(withSourceRecordAliases([1, 2]), [1, 2]);
});
