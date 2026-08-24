/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/accepted-source-session-pointer-schema-v60.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-source-pointer-v60-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const schema = await import('./eventlog-schema.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

const NOW = '2026-08-24T00:00:00.000Z';
const CONTINUITY = 'a'.repeat(64);
const SOURCE = 'b'.repeat(64);

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('v59 to v60 adds a durable CAS pointer and immutable source binding without rewriting sessions', () => {
  const db = new Database(path.join(TMP_HOME, 'v59-to-v60.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 59);
    for (const id of ['pointer-root', 'pointer-child', 'pointer-next']) {
      db.prepare(`
        INSERT INTO sessions
          (id, kind, created_at, updated_at, status, metadata_json)
        VALUES (?, 'chat', ?, ?, 'active', '{}')
      `).run(id, NOW, NOW);
    }
    const before = db.prepare('SELECT * FROM sessions ORDER BY id').all();

    schema.applyHarnessMigrationsThroughVersionForTests(db, 60);

    assert.ok(HARNESS_SCHEMA_VERSION >= 60);
    assert.equal((db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
      version: number;
    }).version, 60);
    assert.deepEqual(db.prepare('SELECT * FROM sessions ORDER BY id').all(), before);
    const tables = new Set((db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    ).all() as Array<{ name: string }>).map((row) => row.name));
    assert.ok(tables.has('accepted_source_session_pointers'));
    assert.ok(tables.has('accepted_source_session_bindings'));

    db.prepare(`
      INSERT INTO accepted_source_session_pointers
        (root_session_id, continuity_digest, head_session_id, revision, updated_at)
      VALUES ('pointer-root', ?, 'pointer-child', 0, ?)
    `).run(CONTINUITY, NOW);
    db.prepare(`
      INSERT INTO accepted_source_session_bindings
        (durable_source_digest, root_session_id, continuity_digest,
         session_id, disposition, selected_after_seq, created_at)
      VALUES (?, 'pointer-root', ?, 'pointer-child', 'branched', 0, ?)
    `).run(SOURCE, CONTINUITY, NOW);

    const pointerFks = db.pragma('foreign_key_list(accepted_source_session_pointers)') as Array<{
      from: string;
      table: string;
      on_delete: string;
    }>;
    assert.deepEqual(
      pointerFks.map((fk) => [fk.from, fk.table, fk.on_delete]),
      [['head_session_id', 'sessions', 'RESTRICT']],
      'the root is an opaque durable lineage key; only the live head is a session FK',
    );

    assert.throws(
      () => db.prepare(`UPDATE accepted_source_session_bindings SET session_id = 'pointer-next'`).run(),
      /immutable/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO accepted_source_session_pointers
          (root_session_id, continuity_digest, head_session_id, revision, updated_at)
        VALUES ('pointer-root', ?, 'missing-session', 0, ?)
      `).run('c'.repeat(64), NOW),
      /FOREIGN KEY/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO accepted_source_session_bindings
          (durable_source_digest, root_session_id, continuity_digest,
           session_id, disposition, selected_after_seq, created_at)
        VALUES (?, 'pointer-root', ?, 'missing-session', 'reused', 0, ?)
      `).run('d'.repeat(64), CONTINUITY, NOW),
      /FOREIGN KEY/,
    );

    db.prepare(`DELETE FROM sessions WHERE id = 'pointer-root'`).run();
    assert.equal(
      (db.prepare(`
        SELECT head_session_id FROM accepted_source_session_pointers
         WHERE root_session_id = 'pointer-root' AND continuity_digest = ?
      `).get(CONTINUITY) as { head_session_id: string }).head_session_id,
      'pointer-child',
      'TTL/hard deletion of the historical parent cannot delete live successor lineage',
    );
    assert.throws(
      () => db.prepare(`DELETE FROM sessions WHERE id = 'pointer-child'`).run(),
      /FOREIGN KEY/,
      'a selected session cannot be reaped while its immutable provider-source binding is live',
    );
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS count FROM accepted_source_session_bindings`).get() as {
        count: number;
      }).count,
      1,
      'a failed delete cannot erase replay idempotency',
    );

    const firstCas = db.prepare(`
      UPDATE accepted_source_session_pointers
         SET head_session_id = 'pointer-next', revision = revision + 1, updated_at = ?
       WHERE root_session_id = 'pointer-root' AND continuity_digest = ?
         AND head_session_id = 'pointer-child' AND revision = 0
    `).run(NOW, CONTINUITY);
    const staleCas = db.prepare(`
      UPDATE accepted_source_session_pointers
         SET head_session_id = 'pointer-child', revision = revision + 1, updated_at = ?
       WHERE root_session_id = 'pointer-root' AND continuity_digest = ?
         AND head_session_id = 'pointer-child' AND revision = 0
    `).run(NOW, CONTINUITY);
    assert.equal(firstCas.changes, 1);
    assert.equal(staleCas.changes, 0);

    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    db.close();
  }
});
