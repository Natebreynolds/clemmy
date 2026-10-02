import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createAcceptedModelHistorySchema, registerAcceptedModelHistoryReader, storeAcceptedModelHistory } from './accepted-model-history-store.js';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE accepted_model_batch_admissions (
    id INTEGER PRIMARY KEY, pre_history_json TEXT, pre_history_digest TEXT, pre_history_item_count INTEGER,
    frame_history_json TEXT, frame_history_digest TEXT, frame_history_item_count INTEGER);
    CREATE TABLE accepted_model_batch_checkpoints (
    id INTEGER PRIMARY KEY, history_json TEXT, history_digest TEXT, history_item_count INTEGER);`);
  registerAcceptedModelHistoryReader(db);
  createAcceptedModelHistorySchema(db);
  return db;
}

test('one immutable object backs both source histories; SQL json_each and reopen readers retain exact JSON', () => {
  const db = fixture();
  try {
    const json = JSON.stringify([{ role: 'user', content: 'Preserve my corrected plan 日本語 🐕\n'.repeat(4_000) }]);
    const first = db.transaction(() => storeAcceptedModelHistory(db, json))();
    const second = db.transaction(() => storeAcceptedModelHistory(db, json))();
    assert.ok(first.objectDigest);
    assert.deepEqual(first, second);
    db.prepare(`INSERT INTO accepted_model_batch_admissions VALUES (1, ?, ?, 1, '[]', 'empty', 0, ?, NULL)`)
      .run(first.inlineJson, first.objectDigest, first.objectDigest);
    db.prepare(`INSERT INTO accepted_model_batch_checkpoints VALUES (1, ?, ?, 1, ?)`)
      .run(second.inlineJson, second.objectDigest, second.objectDigest);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM accepted_model_history_objects_v1').get() as { n: number }).n, 1);
    const row = db.prepare('SELECT history_json FROM accepted_model_batch_checkpoints_readable_v1').get() as { history_json: string };
    assert.equal(row.history_json, json);
    const sql = db.prepare(`SELECT item.value AS item FROM accepted_model_batch_admissions_readable_v1 source, json_each(source.pre_history_json) item`).get() as { item: string };
    assert.deepEqual(JSON.parse(sql.item), JSON.parse(json)[0]);
    registerAcceptedModelHistoryReader(db);
    assert.equal((db.prepare('SELECT history_json FROM accepted_model_batch_checkpoints_readable_v1').get() as { history_json: string }).history_json, json);
    assert.throws(() => db.prepare(`UPDATE accepted_model_history_objects_v1 SET encoded = x'00'`).run(), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM accepted_model_history_objects_v1').run(), /FOREIGN KEY/);
    assert.throws(() => db.prepare(`INSERT INTO accepted_model_batch_checkpoints VALUES (2, '[]', 'wrong', 1, ?)`)
      .run(first.objectDigest), /exact bytes/);
  } finally { db.close(); }
});

test('object publication rolls back with its owning transaction; small legacy histories remain unchanged', () => {
  const db = fixture();
  try {
    const legacy = JSON.stringify([{ role: 'user', content: 'small' }]);
    assert.deepEqual(storeAcceptedModelHistory(db, legacy), { inlineJson: legacy, objectDigest: null });
    assert.throws(() => db.transaction(() => { storeAcceptedModelHistory(db, JSON.stringify([{ content: 'x'.repeat(50_000) }])); throw new Error('cancel publication'); })(), /cancel publication/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM accepted_model_history_objects_v1').get() as { n: number }).n, 0);
    db.prepare(`INSERT INTO accepted_model_batch_checkpoints VALUES (1, ?, 'legacy', 1, NULL)`).run(legacy);
    assert.equal((db.prepare('SELECT history_json FROM accepted_model_batch_checkpoints_readable_v1').get() as { history_json: string }).history_json, legacy);
  } finally { db.close(); }
});

test('corrupted compressed history cannot become empty context or a success proof', () => {
  const db = fixture();
  try {
    const stored = storeAcceptedModelHistory(db, JSON.stringify([{ content: 'correct evidence'.repeat(5_000) }]));
    db.prepare(`INSERT INTO accepted_model_batch_checkpoints VALUES (1, '[]', ?, 1, ?)`).run(stored.objectDigest, stored.objectDigest);
    // Simulate offline damage only in this disposable DB; production writes
    // cannot update the immutable object through the normal schema.
    db.exec('DROP TRIGGER accepted_model_history_object_immutable_v1');
    db.prepare(`UPDATE accepted_model_history_objects_v1 SET encoded = x'00'`).run();
    assert.throws(() => db.prepare('SELECT history_json FROM accepted_model_batch_checkpoints_readable_v1').get());
  } finally { db.close(); }
});

test('materialized history is checked against its source digest, not just a valid replacement object', () => {
  const db = fixture();
  try {
    const original = storeAcceptedModelHistory(db, JSON.stringify([{ content: 'original'.repeat(5_000) }]));
    const other = storeAcceptedModelHistory(db, JSON.stringify([{ content: 'unrelated'.repeat(5_000) }]));
    db.prepare(`INSERT INTO accepted_model_batch_checkpoints VALUES (1, '[]', ?, 1, ?)`).run(original.objectDigest, original.objectDigest);
    // These minimal parent tables deliberately omit production's immutable
    // UPDATE fence so a damaged reference can be injected without weakening it.
    db.prepare('UPDATE accepted_model_batch_checkpoints SET history_object_digest = ?').run(other.objectDigest);
    assert.throws(() => db.prepare('SELECT history_json FROM accepted_model_batch_checkpoints_readable_v1').get(), /exact digest/);
  } finally { db.close(); }
});

test('schema rehearsal preserves existing immutable objects and references when migration is reapplied', () => {
  const db = fixture();
  try {
    const json = JSON.stringify([{ content: 'retained exact plan'.repeat(4_000) }]);
    const stored = storeAcceptedModelHistory(db, json);
    db.prepare(`INSERT INTO accepted_model_batch_checkpoints VALUES (1, '[]', ?, 1, ?)`).run(stored.objectDigest, stored.objectDigest);
    createAcceptedModelHistorySchema(db);
    assert.equal((db.prepare('SELECT history_json FROM accepted_model_batch_checkpoints_readable_v1').get() as { history_json: string }).history_json, json);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});
