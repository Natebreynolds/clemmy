import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  WORKSPACE_SCHEMA_SQL,
  WORKSPACE_TABLES,
  WORKSPACE_SCHEMA_VERSION,
  ensureWorkspaceSchema,
} from './workspace-db-schema.js';

test('workspace schema version and table list are explicit', () => {
  assert.equal(WORKSPACE_SCHEMA_VERSION, 5);
  assert.deepEqual(WORKSPACE_TABLES, [
    'workspaces',
    'workspace_files',
    'workspace_revisions',
    'workspace_data_sources',
    'workspace_actions',
    'workspace_datasets',
    'workspace_dataset_observations',
    'workspace_dataset_source_retirements',
    'workspace_state_events',
    'workspace_workflow_bindings',
    'workspace_run_projections',
    'workspace_run_partitions',
    'workspace_canonical_entity_projection_heads',
    'workspace_memory_scope',
    'workspace_embeddings',
  ]);
});

test('workspace schema applies cleanly to SQLite', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    ensureWorkspaceSchema(db);
    assert.equal(db.pragma('user_version', { simple: true }), WORKSPACE_SCHEMA_VERSION);
    const rows = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));
    for (const table of WORKSPACE_TABLES) assert.ok(names.has(table), `missing table ${table}`);
  } finally {
    db.close();
  }
});

test('workspace schema cascades workspace-owned rows and keeps revision history queryable', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(WORKSPACE_SCHEMA_SQL);
    db.prepare(`
      INSERT INTO workspaces (id, slug, title, status, root_dir, created_at, updated_at)
      VALUES ('ws-1', 'release-room', 'Release Room', 'active', '/tmp/release-room', '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO workspace_files (id, workspace_id, rel_path, kind, content_hash, bytes, created_at, updated_at)
      VALUES ('file-1', 'ws-1', 'view/index.html', 'view', 'abc', 42, '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO workspace_revisions (id, workspace_id, file_id, version, snapshot_path, content_hash, bytes, author_session_id, created_at)
      VALUES ('rev-1', 'ws-1', 'file-1', 1, 'view-history/1.html', 'abc', 42, 'sess-1', '2026-06-30T00:01:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO workspace_state_events (id, workspace_id, seq, run_id, session_id, event_type, payload_json, created_at)
      VALUES ('evt-1', 'ws-1', 1, 'run-1', 'sess-1', 'workspace_file_changed', '{}', '2026-06-30T00:02:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO workspace_workflow_bindings (
        binding_id, workspace_id, workflow_id, role, projection_version,
        schedule_authority, state, revision, binding_digest, created_at, updated_at
      ) VALUES (
        'binding-1', 'ws-1', 'workflow-1', 'primary', 1,
        'workflow', 'active', 1, 'digest-1',
        '2026-06-30T00:02:00.000Z', '2026-06-30T00:02:00.000Z'
      )
    `).run();
    db.prepare(`
      INSERT INTO workspace_run_projections (
        binding_id, run_id, binding_digest, projection_digest, projection_json, updated_at
      ) VALUES (
        'binding-1', 'run-1', 'digest-1', 'projection-1', '{}',
        '2026-06-30T00:02:00.000Z'
      )
    `).run();
    db.prepare(`
      INSERT INTO workspace_run_partitions (
        binding_id, run_id, partition_id, state, attempt,
        observations_committed, canonical_records, duplicate_observations, updated_at
      ) VALUES (
        'binding-1', 'run-1', 'partition-1', 'completed', 1,
        2, 1, 1, '2026-06-30T00:02:00.000Z'
      )
    `).run();
    db.prepare(`
      INSERT INTO workspace_canonical_entity_projection_heads (
        binding_id, workflow_id, workspace_id, run_id, dataset_id,
        binding_digest, dataset_contract_digest, resolution_revision,
        resolution_root, coverage_revision, coverage_root,
        canonical_source_digest, workspace_projection_digest, head_digest,
        sidecar_json, projected_at
      ) VALUES (
        'binding-1', 'workflow-1', 'ws-1', 'run-1', 'dataset-canonical-1',
        '0000000000000000000000000000000000000000000000000000000000000000',
        '1111111111111111111111111111111111111111111111111111111111111111', 1,
        '2222222222222222222222222222222222222222222222222222222222222222', 1,
        '3333333333333333333333333333333333333333333333333333333333333333',
        '4444444444444444444444444444444444444444444444444444444444444444',
        '5555555555555555555555555555555555555555555555555555555555555555',
        '6666666666666666666666666666666666666666666666666666666666666666', '{}',
        '2026-06-30T00:02:00.000Z'
      )
    `).run();
    db.prepare(`
      INSERT INTO workspace_data_sources (
        id, workspace_id, composio_slug, created_at, updated_at
      ) VALUES (
        'source-1', 'ws-1', 'GOOGLEADS_SEARCH',
        '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z'
      )
    `).run();
    db.prepare(`
      INSERT INTO workspace_datasets (
        id, workspace_id, source_id, source_key, doc_json, content_hash, bytes,
        refreshed_at, first_seen_at, last_seen_at
      ) VALUES (
        'dataset-1', 'ws-1', 'source-1', 'ads', '{"spend":1}', 'hash-1', 11,
        '2026-06-30T00:02:00.000Z', '2026-06-30T00:02:00.000Z',
        '2026-06-30T00:02:00.000Z'
      )
    `).run();
    db.prepare(`
      INSERT INTO workspace_dataset_observations (
        id, workspace_id, source_key, refresh_id, batch_id, cause, dataset_id,
        content_hash, status, is_current, commit_hash, observed_at, created_at
      ) VALUES (
        'observation-1', 'ws-1', 'ads', 'refresh-1', 'batch-1', 'scheduled',
        'dataset-1', 'hash-1', 'ok', 1, 'commit-1',
        '2026-06-30T00:02:00.000Z', '2026-06-30T00:02:00.000Z'
      )
    `).run();
    db.prepare(`
      INSERT INTO workspace_dataset_source_retirements (
        workspace_id, source_key, projection_mode, retired_at
      ) VALUES (
        'ws-1', 'retired-ads', 'source', '2026-06-30T00:03:00.000Z'
      )
    `).run();

    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_revisions').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_state_events WHERE workspace_id = ?').get('ws-1') as { n: number }).n, 1);

    db.prepare('DELETE FROM workspaces WHERE id = ?').run('ws-1');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_files').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_revisions').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_state_events').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_workflow_bindings').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_run_projections').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_run_partitions').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_canonical_entity_projection_heads').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_datasets').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_dataset_observations').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_dataset_source_retirements').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

test('workspace schema enforces one state-event sequence per workspace', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(WORKSPACE_SCHEMA_SQL);
    db.prepare(`
      INSERT INTO workspaces (id, slug, title, status, root_dir, created_at, updated_at)
      VALUES ('ws-1', 'release-room', 'Release Room', 'active', '/tmp/release-room', '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z')
    `).run();
    const insert = db.prepare(`
      INSERT INTO workspace_state_events (id, workspace_id, seq, event_type, payload_json, created_at)
      VALUES (?, 'ws-1', 1, 'workspace_file_changed', '{}', '2026-06-30T00:02:00.000Z')
    `);
    insert.run('evt-1');
    assert.throws(() => insert.run('evt-2'), /UNIQUE constraint failed/);
  } finally {
    db.close();
  }
});

test('workspace migration refuses a future schema without mutating it', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY);
      PRAGMA user_version = 99;
    `);
    assert.throws(
      () => ensureWorkspaceSchema(db),
      /newer than supported version/,
    );
    assert.equal(db.pragma('user_version', { simple: true }), 99);
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS n
        FROM sqlite_master
        WHERE type = 'table' AND name = 'workspace_dataset_observations'
      `).get() as { n: number }).n,
      0,
    );
  } finally {
    db.close();
  }
});

test('workspace schema v5 adds explicit projection heads without changing v3 workspaces', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE workspaces (
        id                 TEXT PRIMARY KEY,
        slug               TEXT NOT NULL UNIQUE,
        title              TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
        root_dir           TEXT NOT NULL,
        view_entry         TEXT NOT NULL DEFAULT 'view/index.html',
        origin_session_id  TEXT,
        focus_id           INTEGER,
        recipe_json        TEXT,
        metadata_json      TEXT NOT NULL DEFAULT '{}',
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        last_opened_at     TEXT,
        last_refreshed_at  TEXT
      );
      INSERT INTO workspaces (
        id, slug, title, status, root_dir, created_at, updated_at
      ) VALUES (
        'workspace-v3', 'workspace-v3', 'Workspace V3', 'active', '/tmp/workspace-v3',
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
      PRAGMA user_version = 3;
    `);
    ensureWorkspaceSchema(db);
    assert.equal(db.pragma('user_version', { simple: true }), 5);
    assert.deepEqual(
      db.prepare('SELECT id, title, status FROM workspaces WHERE id = ?')
        .get('workspace-v3'),
      { id: 'workspace-v3', title: 'Workspace V3', status: 'active' },
    );
    db.prepare(`
      INSERT INTO workspace_workflow_bindings (
        binding_id, workspace_id, workflow_id, role, projection_version,
        schedule_authority, state, revision, binding_digest, created_at, updated_at
      ) VALUES (?, ?, ?, 'primary', 1, 'workflow', 'active', 1, ?, ?, ?)
    `).run(
      'binding-v4',
      'workspace-v3',
      'workflow-v4',
      'digest-v4',
      '2026-08-22T00:00:00.000Z',
      '2026-08-22T00:00:00.000Z',
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM workspace_workflow_bindings').get() as { n: number }).n,
      1,
    );
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS n FROM sqlite_master
        WHERE type = 'table' AND name = 'workspace_canonical_entity_projection_heads'
      `).get() as { n: number }).n,
      1,
    );
    assert.equal(db.pragma('foreign_key_check').length, 0);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    db.close();
  }
});

test('workspace schema migrates an exact v4 binding/projection DB to v5 in place', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(WORKSPACE_SCHEMA_SQL);
    db.exec(`
      DROP TABLE workspace_canonical_entity_projection_heads;
      INSERT INTO workspaces (
        id, slug, title, status, root_dir, created_at, updated_at
      ) VALUES (
        'workspace-v4', 'workspace-v4', 'Workspace V4', 'active', '/tmp/workspace-v4',
        '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'
      );
      INSERT INTO workspace_workflow_bindings (
        binding_id, workspace_id, workflow_id, role, projection_version,
        schedule_authority, state, revision, binding_digest, created_at, updated_at
      ) VALUES (
        'binding-v4-retained', 'workspace-v4', 'workflow-v4-retained', 'primary', 1,
        'workflow', 'active', 1,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'
      );
      INSERT INTO workspace_run_projections (
        binding_id, run_id, binding_digest, projection_digest, projection_json, updated_at
      ) VALUES (
        'binding-v4-retained', 'run-v4-retained',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        '{}', '2026-08-22T00:00:00.000Z'
      );
      PRAGMA user_version = 4;
    `);
    ensureWorkspaceSchema(db);
    assert.equal(db.pragma('user_version', { simple: true }), 5);
    assert.deepEqual(
      db.prepare(`
        SELECT binding_id, workflow_id, workspace_id
        FROM workspace_workflow_bindings WHERE binding_id = 'binding-v4-retained'
      `).get(),
      {
        binding_id: 'binding-v4-retained',
        workflow_id: 'workflow-v4-retained',
        workspace_id: 'workspace-v4',
      },
    );
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS count FROM workspace_run_projections
        WHERE binding_id = 'binding-v4-retained'
      `).get() as { count: number }).count,
      1,
    );
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name = 'workspace_canonical_entity_projection_heads'
      `).get() as { count: number }).count,
      1,
    );
    assert.equal(db.pragma('foreign_key_check').length, 0);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    db.close();
  }
});
