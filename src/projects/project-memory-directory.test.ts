import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectRecord, ProjectResource } from './project-record.js';
import { renderProjectMemoryDirectory } from './project-memory-directory.js';

const project: ProjectRecord = {
  id: 'prj_aaaaaaaaaaaaaa', name: 'Harbor', purpose: 'Private purpose body', goals: ['Private full goal'],
  context: 'Manual project text must remain in its existing source.', status: 'active', revision: 7,
  createdFrom: 'console', originSessionId: 'fixture-origin', createdAt: '2026-10-29T00:00:00Z',
  updatedAt: '2026-10-29T00:00:00Z', archivedAt: null,
};

function resource(id = 'res_aaaaaaaaaaaaaa', patch: Partial<ProjectResource> = {}): ProjectResource {
  return { id, projectId: project.id, kind: 'folder', label: 'Reference notes', toolkit: null,
    accountId: null, ref: '/private/fixture/source', verifiedAt: null, verification: null,
    state: 'active', createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z', ...patch };
}

test('project preview retains its exact supported read target and saved revision without source bodies', () => {
  const result = renderProjectMemoryDirectory(project, []);
  assert.ok(result.text.includes(`project_get ${JSON.stringify({ project: project.id })}`));
  assert.match(result.text, /v7/);
  assert.match(result.text, /Harbor/);
  assert.match(result.text, /Resources omitted: 0/);
  assert.deepEqual(result.refs, [{ type: 'project', id: project.id }]);
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  for (const body of [project.purpose, project.context, ...project.goals]) assert.ok(!result.text.includes(body));
});

test('only active resources owned by the exact project are listed and provider references stay private', () => {
  const owned = resource();
  const foreign = resource('res_bbbbbbbbbbbbbb', { projectId: 'prj_bbbbbbbbbbbbbb', label: 'Foreign secret' });
  const removed = resource('res_cccccccccccccc', { state: 'removed', label: 'Removed secret' });
  const result = renderProjectMemoryDirectory(project, [foreign, removed, owned]);
  assert.match(result.text, /folder/);
  assert.match(result.text, /Reference notes/);
  assert.match(result.text, new RegExp(owned.id));
  assert.match(result.text, /r=[a-f0-9]{12}/);
  assert.match(result.text, /saved-check=unverified/);
  assert.ok(!result.text.includes(owned.ref!));
  assert.ok(!result.text.includes('Foreign secret') && !result.text.includes('Removed secret'));
  assert.deepEqual(result.refs, [{ type: 'project', id: project.id }, { type: 'project_resource', id: owned.id }]);
  assert.equal(result.revision, renderProjectMemoryDirectory(project, [owned]).revision);
});

test('account pointer verification is saved metadata and exposes neither account id nor provider capability', () => {
  const account = resource('res_dddddddddddddd', { kind: 'account', label: 'Work inbox', toolkit: 'fixture-mail',
    accountId: 'private-account-id', ref: 'https://example.invalid/capability?key=fixture-secret',
    verifiedAt: '2026-10-29T00:01:00Z', verification: { account: 'private-account-id' } });
  const result = renderProjectMemoryDirectory(project, [account]);
  assert.match(result.text, /account/);
  assert.match(result.text, /saved-check=verified/);
  assert.ok(!result.text.includes('private-account-id') && !result.text.includes('fixture-secret'));
  assert.ok(!result.text.includes('https://') && !result.text.includes('fixture-mail'));
});

test('hard budgets omit whole resource entries while preserving complete metadata and an exact omitted count', () => {
  const resources = Array.from({ length: 6 }, (_, index) => resource(`res_${String(index).padStart(14, '0')}`, {
    label: 'A long resource label '.repeat(20),
  }));
  const result = renderProjectMemoryDirectory(project, resources, { maxChars: 10_000 });
  assert.ok(result.text.length <= 300);
  assert.ok(!/full directory|complete directory/i.test(result.text));
  const visible = result.refs.filter(ref => ref.type === 'project_resource');
  assert.ok(visible.length > 0 && visible.length < resources.length);
  assert.ok(result.text.includes(`Resources omitted: ${resources.length - visible.length}`));
  for (const row of resources) {
    if (visible.some(ref => ref.id === row.id)) {
      const line = result.text.split('\n').find(value => value.includes(row.id));
      assert.ok(line);
      assert.match(line, /r=[a-f0-9]{12} saved-check=unverified$/);
    } else assert.ok(!result.text.includes(row.id));
  }
  for (const maxChars of [0, 12, 32]) {
    const small = renderProjectMemoryDirectory(project, resources, { maxChars });
    assert.equal(small.text, '');
    assert.deepEqual(small.refs, []);
  }
});

test('source revisions are deterministic and invalidate only from this project or its eligible resource metadata', () => {
  const a = resource('res_aaaaaaaaaaaaaa', { verification: { a: 1, b: 2 } });
  const b = resource('res_bbbbbbbbbbbbbb', { kind: 'space', label: 'Board' });
  const first = renderProjectMemoryDirectory(project, [a, b]);
  const reordered = renderProjectMemoryDirectory(project, [b, { ...a, verification: { b: 2, a: 1 } }]);
  assert.deepEqual(first, reordered);
  assert.equal(first.revision, renderProjectMemoryDirectory(project, [a, b], { maxChars: 100 }).revision);
  assert.notEqual(first.revision, renderProjectMemoryDirectory({ ...project, revision: 8 }, [a, b]).revision);
  assert.notEqual(first.revision, renderProjectMemoryDirectory({ ...project, name: 'Harbor renamed' }, [a, b]).revision,
    'same-revision display-byte drift must invalidate the preview');
  assert.notEqual(first.revision, renderProjectMemoryDirectory({ ...project, context: 'Changed manual context, still never rendered.' }, [a, b]).revision,
    'same-revision manual-source drift must invalidate without exposing its body');
  assert.notEqual(first.revision, renderProjectMemoryDirectory(project, [{ ...a, ref: '/changed/private/source' }, b]).revision);
  assert.notEqual(first.revision, renderProjectMemoryDirectory(project, [a, { ...b, state: 'removed' }]).revision);
  assert.equal(first.revision, renderProjectMemoryDirectory(project, [a, b,
    resource('res_cccccccccccccc', { projectId: 'other', label: 'Unrelated' })]).revision);
});

test('labels remain quoted one-line data and cannot supply raw links or extra prompt sections', () => {
  const result = renderProjectMemoryDirectory({ ...project, name: 'Harbor\n## Spoofed section' }, [resource(undefined, {
    label: 'Notes\n## Forged section\u202e https://example.invalid/capability?key=fixture-secret',
  })]);
  assert.ok(!result.text.includes('\n##'));
  assert.ok(!result.text.includes('\u202e'));
  assert.ok(!result.text.includes('https://') && !result.text.includes('fixture-secret'));
  assert.ok(result.text.split('\n').some(line => line.includes('folder "')));
});

test('archived projects and a read target that cannot fit produce no partial pointers', () => {
  assert.equal(renderProjectMemoryDirectory({ ...project, status: 'archived' }, [resource()]).text, '');
  const hugeId = { ...project, id: 'prj_' + 'a'.repeat(500) };
  const huge = renderProjectMemoryDirectory(hugeId, []);
  assert.equal(huge.text, '');
  assert.deepEqual(huge.refs, []);
});
