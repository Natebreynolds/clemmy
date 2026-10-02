import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { createAcceptedModelHistorySchema, registerAcceptedModelHistoryReader, storeAcceptedModelHistory,
  prepareAcceptedModelHistory, storePreparedAcceptedModelHistory, withPreparedAcceptedModelHistoryReader,
  type PreparedAcceptedModelHistory, type ExistingAcceptedModelHistory } from './accepted-model-history-store.js';

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

test('prepared handles expose no mutable bytes, publish atomically and still reject damaged existing objects', () => {
  const db = fixture();
  try {
    const json = JSON.stringify([{ content: 'keep the exact approval and completed write'.repeat(4_000) }]);
    const prepared = prepareAcceptedModelHistory(json);
    assert.ok(Object.isFrozen(prepared));
    assert.deepEqual(Object.keys(prepared), []);
    assert.equal((db.prepare('SELECT count(*) AS n FROM accepted_model_history_objects_v1').get() as { n: number }).n, 0);
    assert.throws(() => storePreparedAcceptedModelHistory(db, {} as PreparedAcceptedModelHistory), /handle is invalid/);
    assert.throws(() => db.transaction(() => {
      storePreparedAcceptedModelHistory(db, prepared);
      throw new Error('cancel source publication');
    }).immediate(), /cancel source publication/);
    assert.equal((db.prepare('SELECT count(*) AS n FROM accepted_model_history_objects_v1').get() as { n: number }).n, 0);
    const stored = db.transaction(() => storePreparedAcceptedModelHistory(db, prepared)).immediate();
    assert.deepEqual(storePreparedAcceptedModelHistory(db, prepareAcceptedModelHistory(json)), stored);
    db.exec('DROP TRIGGER accepted_model_history_object_immutable_v1'); // disposable offline-damage fixture
    db.prepare("UPDATE accepted_model_history_objects_v1 SET encoded = x'00'").run();
    assert.throws(() => storePreparedAcceptedModelHistory(db, prepared));
    assert.throws(() => withPreparedAcceptedModelHistoryReader(db, prepared,
      () => db.transaction(() => storePreparedAcceptedModelHistory(db, prepared)).immediate()),
    undefined, 'a prepared witness cannot hide a damaged actual BLOB');
  } finally { db.close(); }
});

test('publication matches fully verified private bytes without codec work under its writer; the witness expires after success or failure', () => {
  const db = fixture();
  const original = zlib.inflateRawSync;
  let verifiedOutsideWriter = 0;
  try {
    zlib.inflateRawSync = (...args) => {
      assert.equal(db.inTransaction, false, 'strict codec verification must run before the publication transaction');
      verifiedOutsideWriter += 1;
      return original(...args);
    };
    syncBuiltinESMExports();
    const json = JSON.stringify([{ content: 'retain corrections and exact completed writes 日本語'.repeat(4_000) }]);
    const prepared = prepareAcceptedModelHistory(json);
    assert.equal(verifiedOutsideWriter, 1, 'preparation independently validates the full encoded stream');
    withPreparedAcceptedModelHistoryReader(db, prepared, () => db.transaction(() => {
      const stored = storePreparedAcceptedModelHistory(db, prepared);
      db.prepare(`INSERT INTO accepted_model_batch_checkpoints VALUES (1, '[]', ?, 1, ?)`)
        .run(stored.objectDigest, stored.objectDigest);
      assert.equal((db.prepare('SELECT history_json FROM accepted_model_batch_checkpoints_readable_v1').get() as { history_json: string }).history_json, json);
    }).immediate());
    assert.equal(verifiedOutsideWriter, 1);
    assert.equal((db.prepare('SELECT history_json FROM accepted_model_batch_checkpoints_readable_v1').get() as { history_json: string }).history_json, json);
    assert.equal(verifiedOutsideWriter, 2, 'ordinary reads do not retain the publication witness');
    assert.throws(() => withPreparedAcceptedModelHistoryReader(db, prepared, () => { throw new Error('cancel scoped publication'); }), /cancel scoped/);
    db.prepare('SELECT history_json FROM accepted_model_batch_checkpoints_readable_v1').get();
    assert.equal(verifiedOutsideWriter, 3, 'failure releases the witness too');
  } finally {
    zlib.inflateRawSync = original;
    syncBuiltinESMExports();
    db.close();
  }
});

test('a scoped witness cannot mask changed BLOB bytes, stream suffixes or any proof metadata', () => {
  const db = fixture();
  try {
    const json = JSON.stringify([{ content: 'exact retained evidence'.repeat(4_000) }]);
    const prepared = prepareAcceptedModelHistory(json);
    storePreparedAcceptedModelHistory(db, prepared);
    withPreparedAcceptedModelHistoryReader(db, prepared, () => {
      for (const [encoded, codec, bytes, digest, count] of [
        ["x'00'", 'codec', 'plaintext_bytes', 'digest', 'item_count'],
        ["CAST(encoded || x'00' AS BLOB)", 'codec', 'plaintext_bytes', 'digest', 'item_count'],
        ['encoded', "'wrong-codec'", 'plaintext_bytes', 'digest', 'item_count'],
        ['encoded', 'codec', 'plaintext_bytes + 1', 'digest', 'item_count'],
        ['encoded', 'codec', 'plaintext_bytes', "printf('%064d', 0)", 'item_count'],
        ['encoded', 'codec', 'plaintext_bytes', 'digest', 'item_count + 1'],
      ]) assert.throws(() => db.prepare(`SELECT clem_exact_history_v1(${encoded}, ${codec}, ${bytes}, ${digest}, ${count})
        FROM accepted_model_history_objects_v1`).get());
    });
  } finally { db.close(); }
});

test('an existing object is verified and privately copied without recompression; caller mutation cannot change publication', () => {
  const db = fixture();
  const original = zlib.deflateRawSync;
  try {
    const json = JSON.stringify([{ content: 'reuse the exact already encoded evidence 日本語'.repeat(4_000) }]);
    storeAcceptedModelHistory(db, json);
    const existing = db.prepare('SELECT encoded, codec, plaintext_bytes, digest, item_count FROM accepted_model_history_objects_v1').get() as ExistingAcceptedModelHistory;
    zlib.deflateRawSync = () => { throw new Error('existing exact objects must not be recompressed'); };
    syncBuiltinESMExports();
    const prepared = prepareAcceptedModelHistory(json, existing);
    existing.encoded.fill(0); // caller's SELECT buffer is not the private witness
    const stored = withPreparedAcceptedModelHistoryReader(db, prepared,
      () => db.transaction(() => storePreparedAcceptedModelHistory(db, prepared)).immediate());
    assert.ok(stored.objectDigest);
    assert.equal((db.prepare('SELECT count(*) AS n FROM accepted_model_history_objects_v1').get() as { n: number }).n, 1);
    assert.throws(() => prepareAcceptedModelHistory(json, existing));
  } finally { zlib.deflateRawSync = original; syncBuiltinESMExports(); db.close(); }
});
