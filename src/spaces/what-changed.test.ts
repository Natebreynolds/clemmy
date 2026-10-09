/**
 * Run: node scripts/run-tests-isolated.mjs src/spaces/what-changed.test.ts
 *
 * What changed in a Space comes from the history it keeps: per collection,
 * the last real change (not the last refresh), counted by row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-what-changed-test-'));
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const store = await import('./store.js');
const carrier = await import('./workspace-set-data-carrier.js');
const { whatChangedInSpace, rowCounts } = await import('./what-changed.js');
const { diffWorkspaceObservationDocuments } = await import('./observation-diff.js');

test('rows are counted by identity: new, changed (however many fields), gone, and other changes', () => {
  const before = { items: [{ id: 'a', title: 'One', owner: 'x' }, { id: 'b', title: 'Two' }, { id: 'c', title: 'Three' }] };
  const after = { items: [{ id: 'a', title: 'One!', owner: 'y' }, { id: 'c', title: 'Three' }, { id: 'd', title: 'Four' }], total: 3 };
  assert.deepEqual(rowCounts(diffWorkspaceObservationDocuments(before, after)), { added: 1, changed: 1, removed: 1, other: 1, more: false });
});

test('row identity is found by shape: any casing of the usual names, or a field that persists across versions', () => {
  const casing = diffWorkspaceObservationDocuments(
    { records: [{ Id: '001A', Name: 'Acme' }, { Id: '001B', Name: 'Beta' }] },
    { records: [{ Id: '001B', Name: 'Beta Co' }, { Id: '001C', Name: 'Cora' }] },
  );
  assert.deepEqual(rowCounts(casing), { added: 1, changed: 1, removed: 1, other: 0, more: false });

  // `ts` identifies a message; `edited_at` is unique too but changes with an
  // edit, so it carries over less and is not chosen.
  const persisting = diffWorkspaceObservationDocuments(
    { messages: [{ ts: '1.1', text: 'hi', edited_at: 't1' }, { ts: '1.2', text: 'yo', edited_at: 't2' }] },
    { messages: [{ ts: '1.1', text: 'hi!', edited_at: 't3' }, { ts: '1.2', text: 'yo', edited_at: 't2' }, { ts: '1.3', text: 'new', edited_at: 't4' }] },
  );
  assert.deepEqual(rowCounts(persisting), { added: 1, changed: 1, removed: 0, other: 0, more: false });
});

test('a secret-like field is never a row identity, so its values never enter change paths', () => {
  const diff = diffWorkspaceObservationDocuments(
    { sessions: [{ accessToken: 'tok-aaa-111', apiKey: 'k-1', label: 'One' }, { accessToken: 'tok-bbb-222', apiKey: 'k-2', label: 'Two' }] },
    { sessions: [{ accessToken: 'tok-aaa-111', apiKey: 'k-1', label: 'One!' }, { accessToken: 'tok-bbb-222', apiKey: 'k-2', label: 'Two' }] },
  );
  const rendered = JSON.stringify(diff);
  assert.doesNotMatch(rendered, /tok-aaa-111|tok-bbb-222|k-1|k-2/);
  assert.ok(diff.changes.every((change) => !change.entityKey || !/token|apikey/i.test(change.entityKey)));
});

test('a Space reports each collection\'s last real change, not its last refresh', async () => {
  const slug = 'post-queue';
  store.spaceStore.save({ id: slug, title: 'Post queue', viewContent: '<p>queue</p>' });
  const write = (rows: unknown[]) => carrier.executeManualWorkspaceSetData({ slug, source_id: 'drafts', data_json: JSON.stringify(rows) });
  await write([{ id: 'p1', text: 'Launch post' }, { id: 'p2', text: 'Recap' }]);
  assert.deepEqual(whatChangedInSpace(slug).map((c) => [c.collection, c.state]), [['drafts', 'first']]);

  await write([{ id: 'p1', text: 'Launch post v2' }, { id: 'p3', text: 'Teaser' }]);
  const [changed] = whatChangedInSpace(slug);
  assert.equal(changed!.state, 'changed');
  assert.deepEqual([changed!.added, changed!.changed, changed!.removed], [1, 1, 1]);

  // The same content again is a refresh, not a change: the report still
  // describes the last real change and when it happened.
  await write([{ id: 'p1', text: 'Launch post v2' }, { id: 'p3', text: 'Teaser' }]);
  const [again] = whatChangedInSpace(slug);
  assert.deepEqual([again!.added, again!.changed, again!.removed], [1, 1, 1]);
  assert.equal(again!.changedAt, changed!.changedAt);
  assert.ok(again!.checkedAt >= changed!.checkedAt);
});
