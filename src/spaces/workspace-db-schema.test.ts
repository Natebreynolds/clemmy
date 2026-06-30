import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  WORKSPACE_SCHEMA_SQL,
  WORKSPACE_TABLES,
  WORKSPACE_SCHEMA_VERSION,
} from './workspace-db-schema.js';

test('workspace schema version and table list are explicit', () => {
  assert.equal(WORKSPACE_SCHEMA_VERSION, 1);
  assert.deepEqual(WORKSPACE_TABLES, [
    'workspaces',
    'workspace_files',
    'workspace_revisions',
    'workspace_data_sources',
    'workspace_actions',
    'workspace_datasets',
    'workspace_state_events',
    'workspace_memory_scope',
    'workspace_embeddings',
  ]);
});

test('workspace schema applies cleanly to SQLite', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(WORKSPACE_SCHEMA_SQL);
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

    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_revisions').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_state_events WHERE workspace_id = ?').get('ws-1') as { n: number }).n, 1);

    db.prepare('DELETE FROM workspaces WHERE id = ?').run('ws-1');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_files').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_revisions').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_state_events').get() as { n: number }).n, 0);
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
