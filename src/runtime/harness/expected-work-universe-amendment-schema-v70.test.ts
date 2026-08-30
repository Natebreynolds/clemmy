/**
 * Run: node scripts/run-tests-isolated.mjs
 *   src/runtime/harness/expected-work-universe-amendment-schema-v70.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-amendment-v70-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const schema = await import('./eventlog-schema.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const canonicalUpdateTrigger = `
  CREATE TRIGGER trg_expected_work_universe_amendment_update_immutable
  BEFORE UPDATE ON expected_work_universe_amendments
  BEGIN
    SELECT RAISE(ABORT, 'a universe amendment is immutable');
  END;
`;
const canonicalDeleteTrigger = `
  CREATE TRIGGER trg_expected_work_universe_amendment_delete_immutable
  BEFORE DELETE ON expected_work_universe_amendments
  WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
  BEGIN
    SELECT RAISE(ABORT, 'a universe amendment is immutable');
  END;
`;

function createAdversarialV69Database(input: {
  name: string;
  updateTrigger?: string;
  deleteTrigger?: string;
  extraTrigger?: string;
}): Database.Database {
  const db = new Database(path.join(TMP_HOME, `${input.name}.db`));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE events (
      id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE accepted_task_work_contracts (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_user_seq INTEGER NOT NULL,
      contract_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY (session_id, source_user_seq)
    );
    CREATE TABLE expected_work_universe_amendments (
      session_id              TEXT NOT NULL,
      source_user_seq         INTEGER NOT NULL CHECK (source_user_seq > 0),
      contract_id             TEXT NOT NULL,
      universe_id             TEXT NOT NULL,
      prior_member_id_pointer TEXT NOT NULL,
      member_id_pointer       TEXT NOT NULL
                              CHECK (member_id_pointer != prior_member_id_pointer),
      motivating_refusal      TEXT NOT NULL,
      sealed_member_count     INTEGER NOT NULL CHECK (sealed_member_count > 0),
      amended_at              TEXT NOT NULL,
      amendment_event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
      PRIMARY KEY (session_id, source_user_seq, contract_id, universe_id),
      FOREIGN KEY (contract_id)
        REFERENCES accepted_task_work_contracts(contract_id) ON DELETE RESTRICT
    );
    ${input.updateTrigger ?? canonicalUpdateTrigger}
    ${input.deleteTrigger ?? canonicalDeleteTrigger}
    ${input.extraTrigger ?? ''}
  `);
  const stamp = db.prepare(
    `INSERT INTO schema_version (version, applied_at) VALUES (?, '2026-08-30T00:00:00.000Z')`,
  );
  for (let version = 1; version <= 69; version += 1) stamp.run(version);
  db.exec(`
    INSERT INTO sessions (id) VALUES ('session-amended');
    INSERT INTO events (id, session_id) VALUES ('event-amended', 'session-amended');
    INSERT INTO accepted_task_work_contracts
      (session_id, source_user_seq, contract_id)
    VALUES ('session-amended', 1, 'contract-amended');
    INSERT INTO expected_work_universe_amendments
      (session_id, source_user_seq, contract_id, universe_id,
       prior_member_id_pointer, member_id_pointer, motivating_refusal,
       sealed_member_count, amended_at, amendment_event_id)
    VALUES ('session-amended', 1, 'contract-amended', 'leads',
            '/id', '/Id', 'the settled source proved /Id',
            2, '2026-08-30T00:00:00.000Z', 'event-amended');
  `);
  return db;
}

test('v70 preserves a v69 amendment and gives only its exact session cascade deletion authority', () => {
  const db = new Database(path.join(TMP_HOME, 'amendment-v69.db'));
  try {
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE events (
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE accepted_task_work_contracts (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_user_seq INTEGER NOT NULL,
        contract_id TEXT NOT NULL UNIQUE,
        PRIMARY KEY (session_id, source_user_seq)
      );
      CREATE TABLE expected_work_universe_amendments (
        session_id              TEXT NOT NULL,
        source_user_seq         INTEGER NOT NULL CHECK (source_user_seq > 0),
        contract_id             TEXT NOT NULL,
        universe_id             TEXT NOT NULL,
        prior_member_id_pointer TEXT NOT NULL,
        member_id_pointer       TEXT NOT NULL
                                CHECK (member_id_pointer != prior_member_id_pointer),
        motivating_refusal      TEXT NOT NULL,
        sealed_member_count     INTEGER NOT NULL CHECK (sealed_member_count > 0),
        amended_at              TEXT NOT NULL,
        amendment_event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
        PRIMARY KEY (session_id, source_user_seq, contract_id, universe_id),
        FOREIGN KEY (contract_id)
          REFERENCES accepted_task_work_contracts(contract_id) ON DELETE RESTRICT
      );
      CREATE TRIGGER trg_expected_work_universe_amendment_update_immutable
      BEFORE UPDATE ON expected_work_universe_amendments
      BEGIN
        SELECT RAISE(ABORT, 'a universe amendment is immutable');
      END;
      CREATE TRIGGER trg_expected_work_universe_amendment_delete_immutable
      BEFORE DELETE ON expected_work_universe_amendments
      WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
      BEGIN
        SELECT RAISE(ABORT, 'a universe amendment is immutable');
      END;
    `);
    const stamp = db.prepare(
      `INSERT INTO schema_version (version, applied_at) VALUES (?, '2026-08-30T00:00:00.000Z')`,
    );
    for (let version = 1; version <= 69; version += 1) stamp.run(version);

    db.prepare(`INSERT INTO sessions (id) VALUES ('session-amended')`).run();
    db.prepare(`
      INSERT INTO events (id, session_id)
      VALUES ('event-amended', 'session-amended')
    `).run();
    db.prepare(`
      INSERT INTO accepted_task_work_contracts
        (session_id, source_user_seq, contract_id)
      VALUES ('session-amended', 1, 'contract-amended')
    `).run();
    db.prepare(`
      INSERT INTO expected_work_universe_amendments
        (session_id, source_user_seq, contract_id, universe_id,
         prior_member_id_pointer, member_id_pointer, motivating_refusal,
         sealed_member_count, amended_at, amendment_event_id)
      VALUES ('session-amended', 1, 'contract-amended', 'leads',
              '/id', '/Id', 'the settled source proved /Id',
              2, '2026-08-30T00:00:00.000Z', 'event-amended')
    `).run();

    const beforeRows = db.prepare(
      'SELECT * FROM expected_work_universe_amendments',
    ).all();
    const beforeTriggers = db.prepare(`
      SELECT name, sql FROM sqlite_master
       WHERE type = 'trigger' AND tbl_name = 'expected_work_universe_amendments'
       ORDER BY name
    `).all();
    assert.throws(
      () => db.prepare(`DELETE FROM sessions WHERE id = 'session-amended'`).run(),
      /FOREIGN KEY/,
      'the v69 RESTRICT path reproduces the retention blocker before migration',
    );

    schema.applyHarnessMigrationsThroughVersionForTests(db, 70);

    assert.equal(
      (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
      70,
    );
    assert.deepEqual(
      db.prepare('SELECT * FROM expected_work_universe_amendments').all(),
      beforeRows,
      'the rebuild preserves every amendment byte',
    );
    assert.deepEqual(
      db.prepare(`
        SELECT name, sql FROM sqlite_master
         WHERE type = 'trigger' AND tbl_name = 'expected_work_universe_amendments'
         ORDER BY name
      `).all(),
      beforeTriggers,
      'both standalone immutability triggers remain byte-identical',
    );

    const foreignKeys = db.pragma(
      'foreign_key_list(expected_work_universe_amendments)',
    ) as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const groups = new Map<number, string[]>();
    for (const foreignKey of foreignKeys) {
      const group = groups.get(foreignKey.id) ?? [];
      group[foreignKey.seq] = `${foreignKey.from}:${foreignKey.table}.${foreignKey.to}:${foreignKey.on_delete}`;
      groups.set(foreignKey.id, group);
    }
    assert.deepEqual(
      [...groups.values()].map((group) => group.join('|')).sort(),
      [
        'session_id:accepted_task_work_contracts.session_id:CASCADE'
          + '|source_user_seq:accepted_task_work_contracts.source_user_seq:CASCADE'
          + '|contract_id:accepted_task_work_contracts.contract_id:CASCADE',
        'session_id:events.session_id:CASCADE|amendment_event_id:events.id:CASCADE',
        'session_id:sessions.id:CASCADE',
      ].sort(),
    );

    assert.throws(
      () => db.prepare(`
        UPDATE expected_work_universe_amendments
           SET motivating_refusal = 'tampered'
         WHERE session_id = 'session-amended'
      `).run(),
      /immutable/,
      'no standalone caller gained update authority',
    );
    assert.throws(
      () => db.prepare(`
        DELETE FROM expected_work_universe_amendments
         WHERE session_id = 'session-amended'
      `).run(),
      /immutable/,
      'no standalone caller gained deletion authority',
    );
    assert.equal(
      db.prepare(`DELETE FROM sessions WHERE id = 'session-amended'`).run().changes,
      1,
      'the exact session owner can now cascade the amendment',
    );
    assert.equal(
      (db.prepare(
        'SELECT COUNT(*) AS n FROM expected_work_universe_amendments',
      ).get() as { n: number }).n,
      0,
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    db.close();
  }
});

test('v70 refuses tampered amendment triggers atomically before creating parent indexes', () => {
  const cases = [
    {
      name: 'missing-update',
      updateTrigger: '',
    },
    {
      name: 'noop-update',
      updateTrigger: `
        CREATE TRIGGER trg_expected_work_universe_amendment_update_immutable
        BEFORE UPDATE ON expected_work_universe_amendments
        BEGIN SELECT 1; END;
      `,
    },
    {
      name: 'false-delete-condition',
      deleteTrigger: `
        CREATE TRIGGER trg_expected_work_universe_amendment_delete_immutable
        BEFORE DELETE ON expected_work_universe_amendments
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id AND 0)
        BEGIN SELECT RAISE(ABORT, 'a universe amendment is immutable'); END;
      `,
    },
    {
      name: 'extra-trigger',
      extraTrigger: `
        CREATE TRIGGER trg_expected_work_universe_amendment_extra
        AFTER INSERT ON expected_work_universe_amendments
        BEGIN SELECT 1; END;
      `,
    },
  ];

  for (const variant of cases) {
    const db = createAdversarialV69Database(variant);
    try {
      const beforeRows = db.prepare(
        'SELECT * FROM expected_work_universe_amendments',
      ).all();
      const beforeTriggers = db.prepare(`
        SELECT name, sql FROM sqlite_master
         WHERE type = 'trigger' AND tbl_name = 'expected_work_universe_amendments'
         ORDER BY name
      `).all();

      assert.throws(
        () => schema.applyHarnessMigrationsThroughVersionForTests(db, 70),
        /schema v70 amendment trigger.*not exact/,
        variant.name,
      );
      assert.equal(
        (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
        69,
        `${variant.name}: the failed migration is not stamped`,
      );
      assert.deepEqual(
        db.prepare('SELECT * FROM expected_work_universe_amendments').all(),
        beforeRows,
        `${variant.name}: amendment bytes roll back`,
      );
      assert.deepEqual(
        db.prepare(`
          SELECT name, sql FROM sqlite_master
           WHERE type = 'trigger' AND tbl_name = 'expected_work_universe_amendments'
           ORDER BY name
        `).all(),
        beforeTriggers,
        `${variant.name}: trigger objects remain untouched`,
      );
      assert.equal(
        (db.prepare(`
          SELECT COUNT(*) AS n FROM sqlite_master
           WHERE name IN (
             'uq_accepted_task_work_contract_exact_identity',
             'uq_event_exact_session_identity'
           )
        `).get() as { n: number }).n,
        0,
        `${variant.name}: validation happens before parent-index creation`,
      );
      assert.equal(
        (db.prepare(`
          SELECT COUNT(*) AS n FROM sqlite_master
           WHERE name = 'expected_work_universe_amendments_v69'
        `).get() as { n: number }).n,
        0,
        `${variant.name}: no rebuild source is stranded`,
      );
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    } finally {
      db.close();
    }
  }
});

test('v70 refuses cross-session amendment identity without adopting or partially rebuilding it', () => {
  const db = createAdversarialV69Database({ name: 'mixed-session-identity' });
  try {
    db.exec(`
      INSERT INTO sessions (id) VALUES ('session-other');
      INSERT INTO events (id, session_id) VALUES ('event-other', 'session-other');
      INSERT INTO accepted_task_work_contracts
        (session_id, source_user_seq, contract_id)
      VALUES ('session-other', 1, 'contract-other');
      INSERT INTO expected_work_universe_amendments
        (session_id, source_user_seq, contract_id, universe_id,
         prior_member_id_pointer, member_id_pointer, motivating_refusal,
         sealed_member_count, amended_at, amendment_event_id)
      VALUES ('session-amended', 1, 'contract-other', 'cross-session',
              '/id', '/Id', 'foreign parent identities',
              1, '2026-08-30T00:00:00.000Z', 'event-other');
    `);
    const beforeRows = db.prepare(`
      SELECT * FROM expected_work_universe_amendments
       ORDER BY universe_id
    `).all();

    assert.throws(
      () => schema.applyHarnessMigrationsThroughVersionForTests(db, 70),
      /schema v70 refuses mixed amendment identities: contracts=1, events=1/,
    );
    assert.equal(
      (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
      69,
    );
    assert.deepEqual(
      db.prepare(`
        SELECT * FROM expected_work_universe_amendments
         ORDER BY universe_id
      `).all(),
      beforeRows,
      'the rejected cross-session identity is neither rewritten nor discarded',
    );
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS n FROM sqlite_master
         WHERE name IN (
           'uq_accepted_task_work_contract_exact_identity',
           'uq_event_exact_session_identity',
           'expected_work_universe_amendments_v69'
         )
      `).get() as { n: number }).n,
      0,
      'the failed migration rolls back indexes and the rebuild source name',
    );
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    db.close();
  }
});
