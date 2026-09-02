/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/run-dispatch-lease-cipher-schema-v75.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-lease-v75-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const schema = await import('./eventlog-schema.js');

test.after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function version(db: Database.Database): number {
  return (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version;
}

function objects(db: Database.Database): Map<string, string> {
  return new Map((db.prepare(`
    SELECT name, sql FROM sqlite_master
     WHERE tbl_name = 'run_dispatch_leases' AND type IN ('index', 'trigger') AND sql IS NOT NULL
  `).all() as Array<{ name: string; sql: string }>).map((row) => [row.name, row.sql]));
}

test('v75 rebuilds run_dispatch_leases with the sealed-call cipher bound and keeps rows, indexes and triggers', () => {
  const db = new Database(path.join(TEST_HOME, 'v74.db'));
  try {
    schema.applyHarnessMigrationsThroughVersionForTests(db, 74);
    assert.equal(version(db), 74);
    const before = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'run_dispatch_leases'`).get() as { sql: string };
    assert.match(before.sql, /length\(recovery_argument_cipher\) BETWEEN 1 AND 48000/);
    const objectsBefore = objects(db);
    assert.ok(objectsBefore.size >= 6, `expected the four indexes and two triggers, saw ${[...objectsBefore.keys()].join(', ')}`);

    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO sessions (id, kind, channel, created_at, updated_at, status) VALUES ('s-v75', 'workflow', 'workflow', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z', 'active')`).run();
    const insertLease = db.prepare(`
      INSERT INTO run_dispatch_leases (scope_id, session_id, lease_id, activated_at)
      VALUES (?, 's-v75', ?, '2026-09-02T00:00:00.000Z')
    `);
    for (let index = 0; index < 3; index += 1) insertLease.run(`scope-${index}`, `lease-${index}`);
    db.pragma('foreign_keys = ON');

    schema.applyHarnessMigrations(db);
    assert.equal(version(db), 75);
    const after = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'run_dispatch_leases'`).get() as { sql: string };
    assert.match(after.sql, /length\(recovery_argument_cipher\) BETWEEN 1 AND 16777216/);
    assert.ok(!/BETWEEN 1 AND 48000/.test(after.sql));
    assert.equal(after.sql.replace(/BETWEEN 1 AND 16777216/, 'BETWEEN 1 AND 48000'), before.sql, 'only the bound changed');
    assert.deepEqual([...objects(db).entries()].sort(), [...objectsBefore.entries()].sort(), 'indexes and triggers recreated byte-identical');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM run_dispatch_leases').get() as { n: number }).n, 3);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'run_dispatch_leases_v74'`).get() as { n: number }).n, 0);

    // The bound itself, exercised on the real table: a 100 KB cipher is
    // accepted (the triggers that bind a lease to its logical call are
    // dropped inside a savepoint that is rolled back, so the table is untouched).
    db.exec('SAVEPOINT probe');
    try {
      for (const name of objects(db).keys()) {
        if (name.startsWith('trg_')) db.exec(`DROP TRIGGER ${name}`);
      }
      db.pragma('foreign_keys = OFF');
      db.prepare(`
        INSERT INTO run_dispatch_leases (scope_id, session_id, lease_id, activated_at, recovery_argument_cipher)
        VALUES ('scope-big', 's-v75', 'lease-big', '2026-09-02T00:00:00.000Z', ?)
      `).run('c'.repeat(100_000));
      assert.throws(() => db.prepare(`
        INSERT INTO run_dispatch_leases (scope_id, session_id, lease_id, activated_at, recovery_argument_cipher)
        VALUES ('scope-huge', 's-v75', 'lease-huge', '2026-09-02T00:00:00.000Z', ?)
      `).run('c'.repeat(16_777_217)), /CHECK constraint failed/);
    } finally {
      db.exec('ROLLBACK TO probe');
      db.exec('RELEASE probe');
      db.pragma('foreign_keys = ON');
    }
    assert.equal(objects(db).size, objectsBefore.size, 'triggers are back after the probe');
  } finally {
    db.close();
  }
});

test('a fresh database lands on v75 with the rebuilt bound', () => {
  const db = new Database(path.join(TEST_HOME, 'fresh.db'));
  try {
    schema.applyHarnessMigrations(db);
    assert.equal(version(db), 75);
    const table = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'run_dispatch_leases'`).get() as { sql: string };
    assert.match(table.sql, /BETWEEN 1 AND 16777216/);
    schema.applyHarnessMigrations(db);
    assert.equal(version(db), 75);
  } finally {
    db.close();
  }
});
