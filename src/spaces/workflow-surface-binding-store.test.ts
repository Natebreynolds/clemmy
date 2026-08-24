import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { ensureWorkspaceSchema } from './workspace-db-schema.js';
import {
  getWorkflowSurfaceBinding,
  getWorkspaceRunProjection,
  listWorkspaceRunPartitions,
  listWorkflowSurfaceBindingsForWorkflow,
  listWorkflowSurfaceBindingsForWorkspace,
  putSoleActiveWorkflowSurfaceBinding,
  putWorkflowSurfaceBinding,
  putWorkspaceRunProjection,
} from './workflow-surface-binding-store.js';
import {
  buildWorkspaceRunProjection,
  type WorkflowSurfaceBindingV1,
} from './workflow-surface-binding.js';

function fixture(): { db: Database.Database; binding: WorkflowSurfaceBindingV1 } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureWorkspaceSchema(db);
  db.prepare(`
    INSERT INTO workspaces (id, slug, title, status, root_dir, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?)
  `).run(
    'workspace:one',
    'workspace-one',
    'Workspace One',
    '/tmp/workspace-one',
    '2026-08-22T09:00:00.000Z',
    '2026-08-22T09:00:00.000Z',
  );
  return {
    db,
    binding: {
      version: 1,
      bindingId: 'binding:one',
      workflowId: 'workflow:one',
      workspaceId: 'workspace:one',
      revision: 1,
      role: 'primary',
      projectionVersion: 1,
      scheduleAuthority: 'workflow',
      state: 'active',
      createdAt: '2026-08-22T09:00:00.000Z',
      updatedAt: '2026-08-22T09:00:00.000Z',
    },
  };
}

test('binding store creates and replays one exact explicit relationship', () => {
  const { db, binding } = fixture();
  try {
    const first = putWorkflowSurfaceBinding({ db, binding });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.inserted, true);
    const replay = putWorkflowSurfaceBinding({ db, binding });
    assert.deepEqual(replay, { ...first, inserted: false });
    assert.equal(getWorkflowSurfaceBinding(binding.bindingId, db)?.digest, first.digest);
    assert.equal(listWorkflowSurfaceBindingsForWorkspace(binding.workspaceId, db).length, 1);
    assert.deepEqual(
      listWorkflowSurfaceBindingsForWorkflow(binding.workflowId, db),
      [{ ...binding, digest: first.digest }],
    );
    assert.deepEqual(listWorkflowSurfaceBindingsForWorkflow('workflow:absent', db), []);
  } finally {
    db.close();
  }
});

test('binding readers and CAS reject a row bitflip whose retained digest is stale', () => {
  const { db, binding } = fixture();
  try {
    const stored = putWorkflowSurfaceBinding({ db, binding });
    assert.equal(stored.ok, true);
    db.prepare(`
      UPDATE workspace_workflow_bindings SET workflow_id = ? WHERE binding_id = ?
    `).run('workflow:bitflipped', binding.bindingId);
    assert.equal(getWorkflowSurfaceBinding(binding.bindingId, db), null);
    assert.deepEqual(listWorkflowSurfaceBindingsForWorkflow('workflow:bitflipped', db), []);
    const replay = putWorkflowSurfaceBinding({ db, binding });
    assert.deepEqual(replay, {
      ok: false,
      kind: 'conflict',
      errors: ['stored binding bytes do not match their retained digest'],
    });
  } finally {
    db.close();
  }
});

test('binding update requires the reviewed digest and the next exact revision', () => {
  const { db, binding } = fixture();
  try {
    const first = putWorkflowSurfaceBinding({ db, binding });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const changed: WorkflowSurfaceBindingV1 = {
      ...binding,
      revision: 2,
      state: 'paused',
      updatedAt: '2026-08-22T09:01:00.000Z',
    };
    assert.deepEqual(
      putWorkflowSurfaceBinding({ db, binding: changed, expectedDigest: 'stale' }),
      {
        ok: false,
        kind: 'conflict',
        errors: ['binding revision, reviewed digest, or immutable identity does not match'],
      },
    );
    const update = putWorkflowSurfaceBinding({ db, binding: changed, expectedDigest: first.digest });
    assert.equal(update.ok, true);
    assert.equal(update.ok && update.binding.state, 'paused');
    assert.equal(update.ok && update.binding.revision, 2);
  } finally {
    db.close();
  }
});

test('one active primary surface is enforced without inferring from names', () => {
  const { db, binding } = fixture();
  try {
    assert.equal(putWorkflowSurfaceBinding({ db, binding }).ok, true);
    const second: WorkflowSurfaceBindingV1 = {
      ...binding,
      bindingId: 'binding:two',
      workflowId: 'workflow:two',
      createdAt: '2026-08-22T09:02:00.000Z',
      updatedAt: '2026-08-22T09:02:00.000Z',
    };
    const conflict = putWorkflowSurfaceBinding({ db, binding: second });
    assert.equal(conflict.ok, false);
    assert.equal(!conflict.ok && conflict.kind, 'conflict');
    assert.equal(listWorkflowSurfaceBindingsForWorkspace(binding.workspaceId, db).length, 1);
  } finally {
    db.close();
  }
});

test('pilot binding insertion atomically keeps one non-retired Workspace per workflow', () => {
  const { db, binding } = fixture();
  try {
    db.prepare(`
      INSERT INTO workspaces (id, slug, title, status, root_dir, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?)
    `).run(
      'workspace:two',
      'workspace-two',
      'Workspace Two',
      '/tmp/workspace-two',
      '2026-08-22T09:00:00.000Z',
      '2026-08-22T09:00:00.000Z',
    );
    const first = putSoleActiveWorkflowSurfaceBinding({ db, binding });
    assert.equal(first.ok, true);
    const competing: WorkflowSurfaceBindingV1 = {
      ...binding,
      bindingId: 'binding:competing',
      workspaceId: 'workspace:two',
      createdAt: '2026-08-22T09:01:00.000Z',
      updatedAt: '2026-08-22T09:01:00.000Z',
    };
    assert.deepEqual(putSoleActiveWorkflowSurfaceBinding({ db, binding: competing }), {
      ok: false,
      kind: 'conflict',
      errors: ['workflow already has a different non-retired Workspace binding'],
    });
    assert.deepEqual(
      listWorkflowSurfaceBindingsForWorkflow(binding.workflowId, db).map((row) => row.bindingId),
      [binding.bindingId],
    );
  } finally {
    db.close();
  }
});

test('binding refuses a missing workspace and cascades with workspace deletion', () => {
  const { db, binding } = fixture();
  try {
    assert.deepEqual(
      putWorkflowSurfaceBinding({ db, binding: { ...binding, workspaceId: 'workspace:missing' } }),
      {
        ok: false,
        kind: 'missing_workspace',
        errors: ['workspace workspace:missing does not exist'],
      },
    );
    assert.equal(putWorkflowSurfaceBinding({ db, binding }).ok, true);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(binding.workspaceId);
    assert.equal(getWorkflowSurfaceBinding(binding.bindingId, db), null);
  } finally {
    db.close();
  }
});

test('projection commits only against the exact current binding and replays idempotently', () => {
  const { db, binding } = fixture();
  try {
    const storedBinding = putWorkflowSurfaceBinding({ db, binding });
    assert.equal(storedBinding.ok, true);
    if (!storedBinding.ok) return;
    const snapshot = buildWorkspaceRunProjection(binding, [
      { factId: 'fact:declare-one', sequence: 1, ordinal: 0, kind: 'partition_declared', partitionId: 'segment:one', at: '2026-08-22T09:01:00.000Z' },
      { factId: 'fact:complete-one', sequence: 2, ordinal: 0, kind: 'partition_status', partitionId: 'segment:one', state: 'completed', attempt: 1, at: '2026-08-22T09:02:00.000Z' },
      { factId: 'fact:coverage-one', sequence: 3, ordinal: 0, kind: 'coverage_evidence', status: 'complete', declaredPartitions: 1, evidenceRef: 'coverage:one', at: '2026-08-22T09:03:00.000Z' },
    ]);
    const stale = putWorkspaceRunProjection({
      db,
      snapshot,
      bindingDigest: 'stale',
    });
    assert.deepEqual(stale, {
      ok: false,
      kind: 'conflict',
      errors: ['projection does not match the current active binding revision'],
    });
    const first = putWorkspaceRunProjection({
      db,
      snapshot,
      bindingDigest: storedBinding.digest,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.inserted, true);
    assert.deepEqual(
      putWorkspaceRunProjection({ db, snapshot, bindingDigest: storedBinding.digest }),
      { ...first, inserted: false },
    );
    assert.equal(getWorkspaceRunProjection(binding.bindingId, db)?.digest, first.digest);
    assert.deepEqual(
      listWorkspaceRunPartitions(binding.bindingId, { db }),
      snapshot.partitions,
    );
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(binding.workspaceId);
    assert.equal(getWorkspaceRunProjection(binding.bindingId, db), null);
  } finally {
    db.close();
  }
});

test('partition projection storage is normalized and paginated', () => {
  const { db, binding } = fixture();
  try {
    const storedBinding = putWorkflowSurfaceBinding({ db, binding });
    assert.equal(storedBinding.ok, true);
    if (!storedBinding.ok) return;
    const declarations = Array.from({ length: 10_005 }, (_, index) => ({
      factId: `fact:declare:${String(index).padStart(5, '0')}`,
      sequence: index + 1,
      ordinal: 0,
      kind: 'partition_declared' as const,
      partitionId: `partition:${String(index).padStart(5, '0')}`,
      at: '2026-08-22T09:01:00.000Z',
    }));
    const snapshot = buildWorkspaceRunProjection(binding, declarations);
    const put = putWorkspaceRunProjection({
      db,
      snapshot,
      bindingDigest: storedBinding.digest,
    });
    assert.equal(put.ok, true);
    const collected: string[] = [];
    let afterPartitionId: string | undefined;
    while (true) {
      const page = listWorkspaceRunPartitions(binding.bindingId, {
        db,
        ...(afterPartitionId ? { afterPartitionId } : {}),
        limit: 500,
      });
      collected.push(...page.map((partition) => partition.partitionId));
      if (page.length < 500) break;
      afterPartitionId = page.at(-1)!.partitionId;
    }
    assert.equal(collected.length, 10_005);
    assert.equal(new Set(collected).size, 10_005);
    assert.equal(collected.at(-1), 'partition:10004');
    const storedJson = db.prepare(`
      SELECT projection_json FROM workspace_run_projections WHERE binding_id = ?
    `).get(binding.bindingId) as { projection_json: string };
    assert.equal(storedJson.projection_json.includes('partition:10004'), false);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM workspace_run_partitions WHERE binding_id = ?')
        .get(binding.bindingId) as { n: number }).n,
      10_005,
    );
  } finally {
    db.close();
  }
});

test('a binding revision invalidates the prior visual projection until it is rebuilt', () => {
  const { db, binding } = fixture();
  try {
    const firstBinding = putWorkflowSurfaceBinding({ db, binding });
    assert.equal(firstBinding.ok, true);
    if (!firstBinding.ok) return;
    const firstSnapshot = buildWorkspaceRunProjection(binding, [
      { factId: 'fact:declare', sequence: 1, ordinal: 0, kind: 'partition_declared', partitionId: 'partition:one', at: '2026-08-22T09:01:00.000Z' },
    ]);
    const firstProjection = putWorkspaceRunProjection({
      db,
      snapshot: firstSnapshot,
      bindingDigest: firstBinding.digest,
    });
    assert.equal(firstProjection.ok, true);
    if (!firstProjection.ok) return;

    const revisedBinding: WorkflowSurfaceBindingV1 = {
      ...binding,
      revision: 2,
      state: 'paused',
      updatedAt: '2026-08-22T09:02:00.000Z',
    };
    const revised = putWorkflowSurfaceBinding({
      db,
      binding: revisedBinding,
      expectedDigest: firstBinding.digest,
    });
    assert.equal(revised.ok, true);
    if (!revised.ok) return;
    assert.equal(getWorkspaceRunProjection(binding.bindingId, db), null);

    const rebuilt = buildWorkspaceRunProjection(revisedBinding, [
      { factId: 'fact:declare', sequence: 1, ordinal: 0, kind: 'partition_declared', partitionId: 'partition:one', at: '2026-08-22T09:01:00.000Z' },
      { factId: 'fact:running', sequence: 2, ordinal: 0, kind: 'partition_status', partitionId: 'partition:one', state: 'running', attempt: 1, at: '2026-08-22T09:03:00.000Z' },
    ]);
    assert.equal(putWorkspaceRunProjection({
      db,
      snapshot: rebuilt,
      bindingDigest: revised.digest,
      expectedProjectionDigest: firstProjection.digest,
    }).ok, true);
    assert.equal(getWorkspaceRunProjection(binding.bindingId, db)?.projection.coverage.runningPartitions, 1);
  } finally {
    db.close();
  }
});

test('corrupt partition bytes fail closed and cannot be blessed by exact replay', () => {
  const { db, binding } = fixture();
  try {
    const storedBinding = putWorkflowSurfaceBinding({ db, binding });
    assert.equal(storedBinding.ok, true);
    if (!storedBinding.ok) return;
    const snapshot = buildWorkspaceRunProjection(binding, [
      { factId: 'fact:declare', sequence: 1, ordinal: 0, kind: 'partition_declared', partitionId: 'partition:one', at: '2026-08-22T09:01:00.000Z' },
    ]);
    assert.equal(putWorkspaceRunProjection({
      db,
      snapshot,
      bindingDigest: storedBinding.digest,
    }).ok, true);
    db.prepare(`
      UPDATE workspace_run_partitions
      SET state = 'completed'
      WHERE binding_id = ? AND partition_id = ?
    `).run(binding.bindingId, 'partition:one');
    assert.equal(getWorkspaceRunProjection(binding.bindingId, db), null);
    assert.deepEqual(
      putWorkspaceRunProjection({ db, snapshot, bindingDigest: storedBinding.digest }),
      { ok: false, kind: 'conflict', errors: ['stored projection is corrupt'] },
    );
  } finally {
    db.close();
  }
});
