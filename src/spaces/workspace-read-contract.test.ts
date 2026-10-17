import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareWorkspaceGet, projectWorkspaceSnapshotRead, WorkspaceReadContractError } from './workspace-read-contract.js';
import { workspaceDataContentDigest } from './workspace-set-data-contract.js';

const slug = 'controlled-snapshot';
const data = JSON.parse('{"selected":{"records":[{"id":"exact-1","note":"' + 'untrimmed café 🦊 '.repeat(80) + '"}],"__proto__":{"literal":true}},"nearby":{"records":[{"id":"decoy"}]}}');
function snapshot() {
  return {
    record: { id: slug, title: 'Controlled snapshot', status: 'active', version: 3, dataSources: [], actions: [] },
    manifest: JSON.stringify({ id: slug, status: 'active', version: 3 }),
    data: JSON.stringify(data), revision: 'a'.repeat(64),
  };
}
function refuses(code: WorkspaceReadContractError['code'], work: () => unknown) {
  assert.throws(work, (error: unknown) => error instanceof WorkspaceReadContractError && error.code === code);
}

test('exact Workspace reads preserve the complete document or selected value and declare their saved identity', () => {
  const full = projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug }), snapshot());
  assert.deepEqual(full.data, data);
  assert.equal(full.source_id, null);
  assert.equal(full.scope, 'data');
  assert.equal(full.complete, true);
  assert.equal(full.workspace.id, slug);
  assert.equal(full.workspace.revision, 'a'.repeat(64));
  assert.equal(full.workspace.data_sha256, workspaceDataContentDigest(data));
  const selected = projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug, source_id: 'selected', expected_revision: full.workspace.revision }), snapshot());
  assert.deepEqual(selected.data, data.selected);
  assert.ok(Object.hasOwn(selected.data as object, '__proto__'), 'JSON member names remain data');
  assert.equal(selected.complete, true);
  assert.equal(selected.records_page, undefined);
  const metadata = projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug, metadata_only: true }), snapshot());
  assert.equal(metadata.data, null);
  assert.equal(metadata.scope, 'metadata');
  assert.equal(metadata.complete, true, 'completeness belongs to the explicit metadata scope');
  assert.match(metadata.workspace.metadata_revision!, /^workspace-metadata:v1:[a-f0-9]{64}$/);
  assert.equal(metadata.workspace.revision, undefined);
  assert.equal(metadata.workspace.data_sha256, undefined);
  assert.deepEqual(metadata.metadata, { data_sources: [], actions: [], contract: null });
  assert.deepEqual(projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug, metadata_only: true }), {
    record: snapshot().record, manifest: snapshot().manifest,
  }), metadata, 'metadata never requires or claims dataset bytes');
  for (const status of ['paused', 'archived']) {
    const retained = projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug }), { ...snapshot(),
      manifest: JSON.stringify({ id: slug, status }), record: { ...snapshot().record, status } });
    assert.equal(retained.workspace.status, status);
    assert.deepEqual(retained.data, data, 'suspending future source/action work does not hide retained saved data');
  }
});

test('only explicit record paging omits saved values and exposes its offset, path and completeness', () => {
  const saved = snapshot();
  saved.data = JSON.stringify({ selected: { records: [{ id: 'one' }, { id: 'two' }], extra: 'retained only on full source reads' } });
  const page = projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug, source_id: 'selected', limit: 1, offset: 1 }), saved);
  assert.deepEqual(page.data, [{ id: 'two' }]);
  assert.deepEqual(page.records_page, { path: 'records', offset: 1, limit: 1, total: 2, returned: 1 });
  assert.equal(page.complete, false);
  const allRecords = projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug, source_id: 'selected', limit: 2 }), saved);
  assert.equal(allRecords.complete, true);
  assert.equal(allRecords.records_page?.total, 2);
  refuses('records_unavailable', () => projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug, source_id: 'nearby', limit: 2 }), { ...snapshot(), data: '{"nearby":{"count":1}}' }));
});

test('missing, foreign, stale or corrupt saved targets and absent sources cannot become empty successful reads', () => {
  refuses('workspace_unavailable', () => projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug }), undefined));
  refuses('workspace_unavailable', () => projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug }), { ...snapshot(), manifest: JSON.stringify({ id: slug, status: 'unknown' }) }));
  for (const status of [null, 17, false]) {
    refuses('workspace_unavailable', () => projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug }), { ...snapshot(), manifest: JSON.stringify({ id: slug, status }) }));
  }
  assert.equal(projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug }), { ...snapshot(), manifest: JSON.stringify({ id: slug }) }).workspace.status, 'active',
    'an omitted legacy status keeps its documented store default');
  refuses('workspace_identity_changed', () => projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug }), { ...snapshot(), manifest: '{"id":"nearby"}' }));
  refuses('workspace_identity_changed', () => projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug }), { ...snapshot(), record: { ...snapshot().record, id: 'nearby' } }));
  refuses('workspace_revision_changed', () => projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug, expected_revision: 'b'.repeat(64) }), snapshot()));
  refuses('workspace_revision_changed', () => projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug }), { ...snapshot(), revision: '' }));
  refuses('dataset_unavailable', () => projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug }), { ...snapshot(), data: '{' }));
  refuses('dataset_unavailable', () => projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug }), { ...snapshot(), data: '[]' }));
  refuses('source_unavailable', () => projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug, source_id: 'missing' }), snapshot()));
  refuses('source_unavailable', () => projectWorkspaceSnapshotRead(prepareWorkspaceGet({ slug, source_id: 'toString' }), snapshot()));
});

test('the reviewed read has one closed argument contract without hidden path, refresh or pagination defaults', () => {
  for (const args of [
    { slug: '../other' }, { slug, path: '/tmp/other' }, { slug, refresh: true },
    { slug, source_id: '' }, { slug, source_id: 'bad\nkey' }, { slug, source_id: 'selected', metadata_only: true },
    { slug, limit: 10 }, { slug, offset: 1 }, { slug, expected_revision: 'invented' },
    { slug, metadata_only: true, expected_revision: 'a'.repeat(64) },
  ]) refuses('invalid_arguments', () => prepareWorkspaceGet(args));
  const args = { slug, source_id: 'selected', metadata_only: null, limit: null, offset: null, expected_revision: null };
  assert.deepEqual(prepareWorkspaceGet(args), args, 'validation does not rewrite sealed call arguments');
});
