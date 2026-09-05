/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/async-read-refinement-schema-v72.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-async-v72-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const schema = await import('./eventlog-schema.js');
const asyncSchema = await import('./async-read-refinement-schema.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

function version(db: Database.Database): number {
  return (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
    version: number;
  }).version;
}

function object(db: Database.Database, name: string): { type: string; sql: string } | undefined {
  return db.prepare(`SELECT type, sql FROM sqlite_master WHERE name = ?`).get(name) as {
    type: string; sql: string;
  } | undefined;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

function exerciseTerminalOutcomeAuthority(db: Database.Database, suffix: string): void {
  const sessionId = `terminal-shape-${suffix}`;
  const sourceUserSeq = 1;
  const ownerCallId = `owner-${suffix}`;
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare(`
      INSERT INTO ${asyncSchema.ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE}
        (session_id, source_user_seq, accepted_task_id, start_logical_tool_call_id,
         receipt_version, recipe_digest, terminal_kind, reason,
         getter_logical_tool_call_id, getter_result_handle_id,
         getter_raw_payload_sha256, recorded_at)
      VALUES (?, ?, ?, ?, 1, ?, 'attempts_exhausted', ?, NULL, NULL, NULL, ?)
    `).run(
      sessionId,
      sourceUserSeq,
      `task-${suffix}`,
      ownerCallId,
      'a'.repeat(64),
      'All bounded getter attempts completed without one terminal verified recent-article result.',
      '2026-08-31T12:00:00.000Z',
    );
    assert.throws(() => db.prepare(`
      INSERT INTO ${asyncSchema.ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE}
        (session_id, source_user_seq, accepted_task_id, start_logical_tool_call_id,
         receipt_version, recipe_digest, getter_logical_tool_call_id,
         getter_result_handle_id, getter_raw_payload_sha256, evidence_json,
         evidence_digest, recorded_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, '{}', ?, ?)
    `).run(
      sessionId, sourceUserSeq, `task-${suffix}`, ownerCallId,
      'a'.repeat(64), `getter-${suffix}`, `handle-${suffix}`,
      'b'.repeat(64), 'c'.repeat(64), '2026-08-31T12:00:01.000Z',
    ), /already has a terminal receipt/);

    db.prepare(`DELETE FROM ${asyncSchema.ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE}`).run();
    db.prepare(`
      INSERT INTO ${asyncSchema.ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE}
        (session_id, source_user_seq, accepted_task_id, start_logical_tool_call_id,
         receipt_version, recipe_digest, getter_logical_tool_call_id,
         getter_result_handle_id, getter_raw_payload_sha256, evidence_json,
         evidence_digest, recorded_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, '{}', ?, ?)
    `).run(
      sessionId, sourceUserSeq, `task-${suffix}`, ownerCallId,
      'a'.repeat(64), `getter-${suffix}`, `handle-${suffix}`,
      'b'.repeat(64), 'c'.repeat(64), '2026-08-31T12:00:01.000Z',
    );
    assert.throws(() => db.prepare(`
      INSERT INTO ${asyncSchema.ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE}
        (session_id, source_user_seq, accepted_task_id, start_logical_tool_call_id,
         receipt_version, recipe_digest, terminal_kind, reason, recorded_at)
      VALUES (?, ?, ?, ?, 1, ?, 'provider_failed', ?, ?)
    `).run(
      sessionId, sourceUserSeq, `task-${suffix}`, ownerCallId,
      'a'.repeat(64), 'The batch getter ended failed.', '2026-08-31T12:00:02.000Z',
    ), /already has a completion receipt/);
    db.prepare(`DELETE FROM ${asyncSchema.ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE}`).run();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

test('v71 to v72 adds the historical terminal owner and v73 normalizes Stop authority', () => {
  const db = new Database(path.join(TEST_HOME, 'plain-v71.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 71);
    assert.equal(version(db), 71);
    assert.equal(object(db, asyncSchema.ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE), undefined);
    assert.equal(object(db, asyncSchema.ASYNC_READ_REFINEMENT_RECOVERY_CURSOR_TABLE), undefined);

    schema.applyHarnessMigrationsThroughVersionForTests(db, 72);
    assert.equal(version(db), 72);
    assert.ok(object(db, asyncSchema.ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE));
    assert.ok(object(db, asyncSchema.ASYNC_READ_REFINEMENT_RECOVERY_CURSOR_TABLE));
    assert.ok(object(db, 'trg_async_read_refinement_completion_excludes_terminal'));
    assert.ok(object(db, 'trg_async_read_refinement_terminal_excludes_completion'));
    assert.ok(object(db, 'idx_sessions_chat_run_in_flight_updated'));
    assert.ok(!columnNames(db, asyncSchema.ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE)
      .includes('cancellation_run_attempt_id'));

    schema.applyHarnessMigrations(db);
    assert.equal(version(db), HARNESS_SCHEMA_VERSION);
    assert.ok(columnNames(db, asyncSchema.ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE)
      .includes('cancellation_run_attempt_id'));
    exerciseTerminalOutcomeAuthority(db, 'plain');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);

    const frozen = db.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name LIKE 'async_read_refinement_%'
          OR name LIKE 'trg_async_read_refinement_%'
       ORDER BY type, name
    `).all();
    const versions = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
    schema.applyHarnessMigrations(db);
    assert.deepEqual(db.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name LIKE 'async_read_refinement_%'
          OR name LIKE 'trg_async_read_refinement_%'
       ORDER BY type, name
    `).all(), frozen);
    assert.deepEqual(db.prepare('SELECT * FROM schema_version ORDER BY version').all(), versions);
  } finally {
    db.close();
  }
});

test('v73 upgrades the earlier v71 terminal-table candidate without assuming a clean home', () => {
  const db = new Database(path.join(TEST_HOME, 'intermediate-v71.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 71);
    // Simulate a developer home that ran an earlier v71 candidate in which the
    // terminal table existed, while the durable cursor and reciprocal guards did not.
    db.exec(`
      CREATE TABLE async_read_refinement_terminal_receipts (
        session_id TEXT NOT NULL,
        source_user_seq INTEGER NOT NULL CHECK (source_user_seq > 0),
        accepted_task_id TEXT NOT NULL,
        start_logical_tool_call_id TEXT NOT NULL,
        receipt_version INTEGER NOT NULL CHECK (receipt_version = 1),
        recipe_digest TEXT NOT NULL CHECK (length(recipe_digest) = 64),
        terminal_kind TEXT NOT NULL CHECK (terminal_kind IN (
          'insufficient_evidence','provider_failed','provider_cancelled',
          'deadline_exhausted','attempts_exhausted'
        )),
        reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
        getter_logical_tool_call_id TEXT,
        getter_result_handle_id TEXT,
        getter_raw_payload_sha256 TEXT,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (session_id, source_user_seq, start_logical_tool_call_id),
        FOREIGN KEY (session_id, source_user_seq, start_logical_tool_call_id)
          REFERENCES async_read_refinement_start_receipts(
            session_id, source_user_seq, start_logical_tool_call_id
          ) ON DELETE CASCADE
      )
    `);
    schema.applyHarnessMigrations(db);
    assert.equal(version(db), HARNESS_SCHEMA_VERSION);
    assert.ok(object(db, asyncSchema.ASYNC_READ_REFINEMENT_RECOVERY_CURSOR_TABLE));
    assert.ok(object(db, 'trg_async_read_refinement_completion_excludes_terminal'));
    assert.ok(object(db, 'trg_async_read_refinement_terminal_excludes_completion'));
    assert.ok(object(db, 'idx_sessions_chat_run_in_flight_updated'));
    exerciseTerminalOutcomeAuthority(db, 'intermediate');
    const rebuiltSql = object(db, asyncSchema.ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE)?.sql ?? '';
    assert.match(rebuiltSql, /getter_raw_payload_sha256 IS NULL OR length\(getter_raw_payload_sha256\) = 64/i);
    assert.match(rebuiltSql, /UNIQUE \(session_id, source_user_seq, getter_logical_tool_call_id\)/i);
    const terminalForeignKeys = db.prepare(`PRAGMA foreign_key_list(${asyncSchema.ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE})`).all() as Array<{ table: string; from: string }>;
    assert.ok(terminalForeignKeys.some((entry) => (
        entry.table === 'durable_result_handles' && entry.from === 'getter_result_handle_id'
      )), 'the upgraded candidate receives the exact result-handle FK');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    db.close();
  }
});

test('v73 restores recovery structures missing from an already-stamped v72 home', () => {
  const db = new Database(path.join(TEST_HOME, 'stamped-v72.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 72);
    assert.equal(version(db), 72);
    db.exec('DROP TABLE plan_task_binding_seal_recovery_cursor');
    assert.equal(object(db, 'plan_task_binding_seal_recovery_cursor'), undefined);

    schema.applyHarnessMigrations(db);
    assert.equal(version(db), HARNESS_SCHEMA_VERSION);
    assert.ok(object(db, 'plan_task_binding_seal_recovery_cursor'));
    assert.ok(object(db, asyncSchema.ASYNC_READ_REFINEMENT_RECOVERY_CURSOR_TABLE));
    assert.ok(object(db, 'idx_sessions_chat_run_in_flight_updated'));
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    db.close();
  }
});

test.after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});
