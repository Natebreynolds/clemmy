import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, symlink, link } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readStorageDatabaseStatus } from './storage-database-status.js';
import { createAcceptedModelHistorySchema, createAcceptedModelHistoryConversionSchema, registerAcceptedModelHistoryReader } from './harness/accepted-model-history-store.js';
import { convertAcceptedModelHistoryBatch } from './harness/accepted-model-history-conversion.js';

test('read-only page metadata distinguishes reusable allocation from logical payload reduction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clem-database-space-'));
  let db: Database.Database | undefined;
  try {
    await mkdir(path.join(root, 'state'));
    db = new Database(path.join(root, 'state', 'harness.db'));
    db.exec(`CREATE TABLE accepted_model_batch_admissions (pre_history_json TEXT, pre_history_digest TEXT,
      pre_history_item_count INTEGER, frame_history_json TEXT, frame_history_digest TEXT, frame_history_item_count INTEGER);
      CREATE TABLE accepted_model_batch_checkpoints (history_json TEXT, history_digest TEXT, history_item_count INTEGER);
      CREATE TABLE temporary_bulk (data BLOB);`);
    registerAcceptedModelHistoryReader(db);
    createAcceptedModelHistorySchema(db);
    db.transaction(() => createAcceptedModelHistoryConversionSchema(db!))();
    const json = JSON.stringify([{ content: 'Private corrected task context 日本語'.repeat(4_000) }]);
    const digest = createHash('sha256').update(json).digest('hex');
    db.prepare(`INSERT INTO accepted_model_batch_admissions VALUES (?, ?, 1, ?, ?, 1, NULL, NULL)`).run(json, digest, json, digest);
    db.prepare(`INSERT INTO accepted_model_batch_checkpoints VALUES (?, ?, 1, NULL)`).run(json, digest);
    for (const lane of ['admission_pre', 'admission_frame', 'checkpoint'] as const) {
      assert.equal(convertAcceptedModelHistoryBatch(db, { lane, maxDurationMs: 1_000 }).converted, 1);
    }
    db.prepare('INSERT INTO temporary_bulk VALUES (zeroblob(1000000))').run();
    db.exec('DROP TABLE temporary_bulk');
    const changes = db.prepare('SELECT total_changes() AS n').get();
    const status = await readStorageDatabaseStatus(root);
    assert.equal(status.state, 'measured');
    if (status.state !== 'measured') throw new Error('missing measured status');
    assert.ok(status.allocatedBytes > 1_000_000);
    assert.ok(status.reusableBytes > 0 && status.reusableBytes < status.allocatedBytes);
    assert.equal(status.historyConversion?.state, 'caught_up');
    assert.equal(status.historyConversion?.convertedHistories, 3);
    assert.ok(status.historyConversion!.netLogicalPayloadBytesRemoved > 0);
    assert.notEqual(status.reusableBytes, status.historyConversion!.netLogicalPayloadBytesRemoved);
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), changes);
    assert.equal(JSON.stringify(status).includes('Private'), false);
    assert.equal(JSON.stringify(status).includes(root), false);
    assert.equal((db.prepare('SELECT history_json FROM accepted_model_batch_checkpoints_readable_v1').get() as { history_json: string }).history_json, json);
    db.prepare(`UPDATE accepted_model_history_conversion_v1 SET state = 'blocked', blocked_rowid = 17 WHERE lane = 'checkpoint'`).run();
    const blocked = await readStorageDatabaseStatus(root);
    assert.equal(blocked.state === 'measured' ? blocked.historyConversion?.state : null, 'blocked');
    assert.equal(JSON.stringify(blocked).includes('blocked_rowid'), false, 'source locators do not cross the UI boundary');
  } finally { db?.close(); await rm(root, { recursive: true, force: true }); }
});

test('old databases report space without migration, and unavailable data never becomes zero space', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clem-old-space-'));
  try {
    assert.deepEqual(await readStorageDatabaseStatus(root), { state: 'not_created' });
    await mkdir(path.join(root, 'state'));
    const filename = path.join(root, 'state', 'harness.db');
    const db = new Database(filename);
    db.exec('CREATE TABLE retained_history (content TEXT); INSERT INTO retained_history VALUES (\'private\');');
    const status = await readStorageDatabaseStatus(root);
    assert.equal(status.state === 'measured' ? status.historyConversion : undefined, null);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), [{ name: 'retained_history' }]);
    db.close();
    await writeFile(filename, 'corrupt, not a SQLite store');
    assert.deepEqual(await readStorageDatabaseStatus(root), { state: 'unavailable' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('linked database or state folders are never followed for storage details', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clem-linked-space-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'clem-private-space-'));
  try {
    const db = new Database(path.join(outside, 'harness.db')); db.exec('CREATE TABLE private (data TEXT)'); db.close();
    await symlink(outside, path.join(root, 'state'));
    assert.deepEqual(await readStorageDatabaseStatus(root), { state: 'unavailable' });
    await rm(path.join(root, 'state'));
    await mkdir(path.join(root, 'state'));
    await link(path.join(outside, 'harness.db'), path.join(root, 'state', 'harness.db'));
    assert.deepEqual(await readStorageDatabaseStatus(root), { state: 'unavailable' });
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
