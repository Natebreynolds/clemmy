/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/event-reference-indexes-schema-v102.test.ts
 *
 * v102 indexes every column that references an event row, so deleting an
 * event never reads a child table row by row.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-event-reference-indexes-v102-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const schema = await import('./eventlog-schema.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('v101 to v102 leaves every row and object as it was and indexes every reference into events', () => {
  const db = new Database(path.join(TMP_HOME, 'v101-to-v102.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 101);
    db.prepare(`INSERT INTO sessions (id, kind, created_at, updated_at, status, metadata_json) VALUES ('chat-a', 'chat', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'active', '{}')`).run();
    db.prepare(`INSERT INTO events (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
      VALUES ('source-1', 'chat-a', 1, 'user', 'user_input_received', NULL, '{"text":"hello"}', '2026-10-01T00:00:00.000Z')`).run();
    const rows = ['sessions', 'events'].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const otherObjects = db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'idx_%_event' ORDER BY type, name`).all();

    schema.applyHarnessMigrationsThroughVersionForTests(db, 102);

    assert.ok(HARNESS_SCHEMA_VERSION >= 102);
    assert.deepEqual(['sessions', 'events'].map((table) => db.prepare(`SELECT * FROM ${table}`).all()), rows);
    assert.deepEqual(db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'idx_%_event' ORDER BY type, name`).all(), otherObjects);

    // Every foreign key into events has an index led by its referencing column.
    const unindexed = db.prepare(`
      SELECT m.name AS child, f."from" AS col FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
       WHERE m.type = 'table' AND f."table" = 'events'
         AND NOT EXISTS (SELECT 1 FROM pragma_index_list(m.name) i JOIN pragma_index_info(i.name) c WHERE c.seqno = 0 AND c.name = f."from")
    `).all() as Array<{ child: string; col: string }>;
    assert.deepEqual(unindexed, [], 'every reference into events is indexed');
    assert.ok((db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%_event'`).get() as { n: number }).n >= 30);
    // A lookup by a referencing column uses its index.
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM physical_dispatches WHERE start_event_id = 'source-1'`).all() as Array<{ detail: string }>;
    assert.ok(plan.some((row) => row.detail.includes('idx_physical_dispatches_start_event_id_event')), JSON.stringify(plan));
  } finally { db.close(); }
});
