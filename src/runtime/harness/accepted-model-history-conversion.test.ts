import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createAcceptedModelHistorySchema, createAcceptedModelHistoryConversionSchema,
  registerAcceptedModelHistoryReader, storeAcceptedModelHistory } from './accepted-model-history-store.js';
import { convertAcceptedModelHistoryBatch, inspectAcceptedModelHistoryConversion } from './accepted-model-history-conversion.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const history = (label: string) => `[ { "role": "user", "content": ${JSON.stringify(`${label} 日本語 🐕\n`.repeat(4_000))} } ]`;

function fixture(filename = ':memory:', installConversion = true) {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS accepted_model_batch_admissions (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, authority_digest TEXT, source_user_seq INTEGER,
    graph_hash TEXT, response_id TEXT, admitted_at TEXT, call_ids_json TEXT,
    pre_history_json TEXT, pre_history_digest TEXT, pre_history_item_count INTEGER,
    frame_history_json TEXT, frame_history_digest TEXT, frame_history_item_count INTEGER);
    CREATE TABLE IF NOT EXISTS accepted_model_batch_checkpoints (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, authority_digest TEXT, source_user_seq INTEGER,
    graph_hash TEXT, response_id TEXT, committed_at TEXT,
    history_json TEXT, history_digest TEXT, history_item_count INTEGER);
    CREATE TRIGGER IF NOT EXISTS trg_accepted_model_batch_admission_immutable BEFORE UPDATE ON accepted_model_batch_admissions
      BEGIN SELECT RAISE(ABORT, 'old append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_accepted_model_batch_checkpoint_immutable BEFORE UPDATE ON accepted_model_batch_checkpoints
      BEGIN SELECT RAISE(ABORT, 'old append-only'); END;`);
  registerAcceptedModelHistoryReader(db);
  createAcceptedModelHistorySchema(db);
  if (installConversion) db.transaction(() => createAcceptedModelHistoryConversionSchema(db))();
  return db;
}

function seed(db: Database.Database, id: number, json = history('Keep my approved plan')) {
  db.prepare(`INSERT INTO accepted_model_batch_admissions (id, session_id, authority_digest, source_user_seq,
    pre_history_json, pre_history_digest, pre_history_item_count, frame_history_json, frame_history_digest, frame_history_item_count)
    VALUES (?, 'controlled', 'authority', 7, ?, ?, 1, ?, ?, 1)`).run(id, json, digest(json), json, digest(json));
  db.prepare(`INSERT INTO accepted_model_batch_checkpoints (id, session_id, authority_digest, source_user_seq,
    history_json, history_digest, history_item_count) VALUES (?, 'controlled', 'authority', 7, ?, ?, 1)`)
    .run(id, json, digest(json));
  return json;
}

test('legacy exact bytes convert across three lanes with one object; dry-run never writes and SQL reads are identical', () => {
  const db = fixture();
  try {
    const json = seed(db, 1);
    const before = db.prepare('SELECT * FROM accepted_model_batch_admissions').get() as Record<string, unknown>;
    const changes = db.prepare('SELECT total_changes() AS n').get();
    assert.equal(inspectAcceptedModelHistoryConversion(db, 'admission_pre').eligibleRows, 1);
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), changes);
    for (const lane of ['admission_pre', 'admission_frame', 'checkpoint'] as const) {
      const result = convertAcceptedModelHistoryBatch(db, { lane, maxDurationMs: 1_000 });
      assert.equal(result.state, 'caught_up');
      assert.equal(result.converted, 1);
      assert.equal(result.inlineBytesRemoved, Buffer.byteLength(json) - 2);
      if (lane !== 'admission_pre') assert.equal(result.encodedBytesAdded, 0);
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM accepted_model_history_objects_v1').get() as { n: number }).n, 1);
    const after = db.prepare('SELECT * FROM accepted_model_batch_admissions_readable_v1').get() as Record<string, unknown>;
    for (const key of Object.keys(before).filter(key => !key.endsWith('_object_digest'))) assert.deepEqual(after[key], before[key], key);
    assert.equal((db.prepare('SELECT history_json FROM accepted_model_batch_checkpoints_readable_v1').get() as { history_json: string }).history_json, json);
    assert.equal((db.prepare('SELECT json_extract(history_json, \'$[0].role\') AS role FROM accepted_model_batch_checkpoints_readable_v1').get() as { role: string }).role, 'user');
    assert.throws(() => db.prepare('DELETE FROM accepted_model_history_objects_v1').run(), /FOREIGN KEY/);
  } finally { db.close(); }
});

test('every semantic field remains immutable during an otherwise valid conversion, including hidden rowid', () => {
  const db = fixture();
  try {
    const json = seed(db, 1);
    const stored = storeAcceptedModelHistory(db, json);
    for (const [table, column] of [['accepted_model_batch_admissions', 'pre_history'], ['accepted_model_batch_checkpoints', 'history']]) {
      const names = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
      for (const name of names.filter(name => !name.endsWith('_json') || name === 'call_ids_json')) {
        if (name.endsWith('_object_digest')) continue;
        assert.throws(() => db.prepare(`UPDATE ${table} SET ${column}_json = '[]', ${column}_object_digest = ?, "${name}" = ?`)
          .run(stored.objectDigest, name.endsWith('_count') || name === 'id' || name === 'source_user_seq' ? 9 : 'changed'), /append-only/, name);
      }
      assert.throws(() => db.prepare(`UPDATE ${table} SET ${column}_json = '[]', ${column}_object_digest = ?, rowid = 9`).run(stored.objectDigest), /append-only/);
      assert.throws(() => db.prepare(`UPDATE ${table} SET session_id = session_id`).run(), /append-only/);
    }
    assert.equal((db.prepare('SELECT pre_history_json AS json FROM accepted_model_batch_admissions').get() as { json: string }).json, json);
  } finally { db.close(); }
});

test('a conversion refuses substituted bytes, mismatched counts, replacing refs and downgrading storage', () => {
  const db = fixture();
  try {
    const json = seed(db, 1);
    const good = storeAcceptedModelHistory(db, json);
    const other = storeAcceptedModelHistory(db, history('different evidence'));
    assert.throws(() => db.prepare(`UPDATE accepted_model_batch_checkpoints SET history_json = '[]', history_object_digest = ?`).run(other.objectDigest), /append-only/);
    assert.throws(() => db.prepare(`UPDATE accepted_model_batch_checkpoints SET history_json = '[]', history_object_digest = ?, history_item_count = 2`).run(good.objectDigest), /append-only/);
    assert.throws(() => db.prepare(`UPDATE accepted_model_batch_checkpoints SET history_json = ?, history_object_digest = ?`).run(' [] ', good.objectDigest), /append-only/);
    convertAcceptedModelHistoryBatch(db, { lane: 'checkpoint', maxDurationMs: 1_000 });
    assert.throws(() => db.prepare(`UPDATE accepted_model_batch_checkpoints SET history_object_digest = ?`).run(other.objectDigest), /append-only/);
    assert.throws(() => db.prepare(`UPDATE accepted_model_batch_checkpoints SET history_json = ?, history_object_digest = NULL`).run(json), /append-only/);
  } finally { db.close(); }
});

test('a byte budget does not read or silently skip an oversized eligible row', () => {
  const db = fixture();
  try {
    const json = seed(db, 1);
    const result = convertAcceptedModelHistoryBatch(db, { lane: 'checkpoint', maxInputBytes: 32 * 1024, maxDurationMs: 1_000 });
    assert.equal(result.scanned, 0);
    assert.equal(result.inputBytes, 0);
    assert.equal(result.requiredInputBudget, Buffer.byteLength(json));
    assert.equal(inspectAcceptedModelHistoryConversion(db, 'checkpoint').lastRowid, null);
    assert.equal(convertAcceptedModelHistoryBatch(db, { lane: 'checkpoint', maxInputBytes: Buffer.byteLength(json), maxDurationMs: 1_000 }).converted, 1);
    assert.throws(() => convertAcceptedModelHistoryBatch(db, { lane: 'checkpoint', maxRows: -1 }), /budget/);
  } finally { db.close(); }
});

test('failed cursor publication rolls back the object and conversion; an explicit retry advances once', () => {
  const db = fixture();
  try {
    const json = seed(db, 1);
    db.exec(`CREATE TRIGGER stop_cursor BEFORE UPDATE ON accepted_model_history_conversion_v1
      WHEN NEW.last_rowid IS NOT OLD.last_rowid BEGIN SELECT RAISE(ABORT, 'controlled interruption'); END;`);
    const failed = convertAcceptedModelHistoryBatch(db, { lane: 'checkpoint', maxDurationMs: 1_000 });
    assert.equal(failed.state, 'blocked');
    assert.equal(failed.blockedRowid, '1');
    assert.equal(inspectAcceptedModelHistoryConversion(db, 'checkpoint').lastRowid, null);
    assert.equal((db.prepare('SELECT history_json AS json FROM accepted_model_batch_checkpoints').get() as { json: string }).json, json);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM accepted_model_history_objects_v1').get() as { n: number }).n, 0);
    db.exec('DROP TRIGGER stop_cursor');
    assert.equal(convertAcceptedModelHistoryBatch(db, { lane: 'checkpoint', maxDurationMs: 1_000 }).converted, 1);
    assert.equal(convertAcceptedModelHistoryBatch(db, { lane: 'checkpoint', maxDurationMs: 1_000 }).converted, 0);
  } finally { db.close(); }
});

test('damage remains blocked at its original cursor and is not silently converted to empty context', () => {
  const db = fixture();
  try {
    const json = seed(db, 1);
    const stored = storeAcceptedModelHistory(db, json);
    db.exec('DROP TRIGGER accepted_model_history_object_immutable_v1'); // disposable offline-damage fixture only
    db.prepare(`UPDATE accepted_model_history_objects_v1 SET encoded = x'00'`).run();
    assert.ok(stored.objectDigest);
    const result = convertAcceptedModelHistoryBatch(db, { lane: 'checkpoint', maxDurationMs: 1_000 });
    assert.equal(result.state, 'blocked');
    assert.equal(result.converted, 0);
    assert.equal(inspectAcceptedModelHistoryConversion(db, 'checkpoint').lastRowid, null);
    assert.equal((db.prepare('SELECT history_json AS json FROM accepted_model_batch_checkpoints').get() as { json: string }).json, json);
  } finally { db.close(); }
});

test('restart and independent writers share a durable cursor; new rows after caught-up are considered', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-history-convert-'));
  let first: Database.Database | undefined;
  let second: Database.Database | undefined;
  try {
    const filename = path.join(dir, 'fixture.db');
    first = fixture(filename);
    const json = seed(first, -7); // cursor does not assume positive hidden rowids
    seed(first, 2, history('preserve completed write'));
    assert.equal(convertAcceptedModelHistoryBatch(first, { lane: 'checkpoint', maxRows: 1, maxDurationMs: 1_000 }).converted, 1);
    assert.equal(inspectAcceptedModelHistoryConversion(first, 'checkpoint').lastRowid, '-7');
    first.close(); first = undefined;
    second = fixture(filename);
    assert.equal(convertAcceptedModelHistoryBatch(second, { lane: 'checkpoint', maxDurationMs: 1_000 }).converted, 1);
    first = fixture(filename);
    assert.equal(convertAcceptedModelHistoryBatch(first, { lane: 'checkpoint', maxDurationMs: 1_000 }).converted, 0);
    seed(second, 3, history('new task'));
    // An actual competing writer cannot observe/advance a stale cursor.
    second.pragma('busy_timeout = 1');
    first.exec('BEGIN IMMEDIATE');
    assert.throws(() => convertAcceptedModelHistoryBatch(second, { lane: 'checkpoint', maxDurationMs: 1_000 }), /locked/);
    first.exec('ROLLBACK');
    assert.equal(convertAcceptedModelHistoryBatch(first, { lane: 'checkpoint', maxDurationMs: 1_000 }).converted, 1);
    assert.equal((second.prepare('SELECT history_json AS json FROM accepted_model_batch_checkpoints_readable_v1 WHERE id = -7').get() as { json: string }).json, json);
    assert.deepEqual(first.pragma('foreign_key_check'), []);
  } finally { first?.close(); second?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('schema replacement is atomic and leaves original immutable fences on migration failure', () => {
  const db = fixture(':memory:', false);
  try {
    seed(db, 1);
    const before = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_accepted_model_batch_checkpoint_immutable'`).get();
    assert.throws(() => db.transaction(() => { createAcceptedModelHistoryConversionSchema(db); throw new Error('cancel migration'); })(), /cancel migration/);
    assert.deepEqual(db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_accepted_model_batch_checkpoint_immutable'`).get(), before);
    assert.throws(() => db.prepare('UPDATE accepted_model_batch_checkpoints SET history_json = history_json').run(), /old append-only/);
    assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'accepted_model_history_conversion_v1'`).get(), undefined);
  } finally { db.close(); }
});

test('cursor orders numeric rowids rather than their reporting text and never jumps past 2 to 10', () => {
  const db = fixture();
  try {
    for (const id of [1, 2, 10, 20]) seed(db, id);
    for (const expected of ['1', '2', '10', '20']) {
      assert.equal(convertAcceptedModelHistoryBatch(db, { lane: 'checkpoint', maxRows: 1, maxDurationMs: 1_000 }).converted, 1);
      assert.equal(inspectAcceptedModelHistoryConversion(db, 'checkpoint').lastRowid, expected);
    }
    assert.equal(convertAcceptedModelHistoryBatch(db, { lane: 'checkpoint', maxDurationMs: 1_000 }).state, 'caught_up');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM accepted_model_batch_checkpoints WHERE history_object_digest IS NULL').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('new foreground work yields between atomic rows without advancing the next history', () => {
  const db = fixture();
  try {
    seed(db, 1); seed(db, 2);
    let checks = 0;
    const result = convertAcceptedModelHistoryBatch(db, { lane: 'checkpoint', maxDurationMs: 1_000,
      shouldContinue: () => ++checks === 1 });
    assert.equal(result.state, 'deferred');
    assert.equal(result.converted, 1);
    assert.equal(inspectAcceptedModelHistoryConversion(db, 'checkpoint').lastRowid, '1');
    assert.equal((db.prepare('SELECT history_object_digest AS ref FROM accepted_model_batch_checkpoints WHERE id = 2').get() as { ref: string | null }).ref, null);
    assert.equal(convertAcceptedModelHistoryBatch(db, { lane: 'checkpoint', maxDurationMs: 1_000 }).converted, 1);
  } finally { db.close(); }
});
