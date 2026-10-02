import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { HARNESS_SCHEMA_VERSION } from './harness/schema-version.js';
import { createAcceptedModelHistorySchema, createAcceptedModelHistoryConversionSchema, registerAcceptedModelHistoryReader } from './harness/accepted-model-history-store.js';
import { runHistoryStorageMaintenance } from './history-storage-maintenance.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clem-idle-history-'));
  await mkdir(path.join(root, 'state'));
  const filename = path.join(root, 'state', 'harness.db');
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    CREATE TABLE run_attempts (id TEXT PRIMARY KEY, finished_at TEXT);
    CREATE TABLE accepted_model_batch_admissions (pre_history_json TEXT, pre_history_digest TEXT,
      pre_history_item_count INTEGER, frame_history_json TEXT, frame_history_digest TEXT, frame_history_item_count INTEGER);
    CREATE TABLE accepted_model_batch_checkpoints (history_json TEXT, history_digest TEXT, history_item_count INTEGER);`);
  const insert = db.prepare('INSERT INTO schema_version VALUES (?)');
  for (let n = 1; n <= HARNESS_SCHEMA_VERSION; n++) insert.run(n);
  registerAcceptedModelHistoryReader(db);
  createAcceptedModelHistorySchema(db);
  db.transaction(() => createAcceptedModelHistoryConversionSchema(db))();
  const json = JSON.stringify([{ content: 'Keep the approved task and completed write intact. 日本語'.repeat(8_000) }]);
  const digest = createHash('sha256').update(json).digest('hex');
  db.prepare(`INSERT INTO accepted_model_batch_admissions VALUES (?, ?, 1, ?, ?, 1, NULL, NULL)`).run(json, digest, json, digest);
  db.prepare(`INSERT INTO accepted_model_batch_checkpoints VALUES (?, ?, 1, NULL)`).run(json, digest);
  return { root, filename, db, json, async close() { db.close(); await rm(root, { recursive: true, force: true }); } };
}

test('maintenance worker shares concurrent requests and restores original context without blocking event-loop timers', async () => {
  const f = await fixture();
  try {
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    const first = runHistoryStorageMaintenance(f.filename);
    assert.equal(runHistoryStorageMaintenance(f.filename), first);
    const result = await first;
    clearTimeout(timer);
    assert.equal(timerFired, true);
    assert.equal(result.state, 'processed');
    if (result.state !== 'processed') throw new Error('worker did not convert');
    assert.equal(result.result.converted, 1);
    for (let n = 0; n < 5; n++) await runHistoryStorageMaintenance(f.filename);
    assert.equal((f.db.prepare('SELECT history_json FROM accepted_model_batch_checkpoints_readable_v1').get() as { history_json: string }).history_json, f.json);
    assert.equal((f.db.prepare('SELECT pre_history_json FROM accepted_model_batch_admissions_readable_v1').get() as { pre_history_json: string }).pre_history_json, f.json);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM accepted_model_history_objects_v1').get() as { n: number }).n, 1);
    assert.equal((await runHistoryStorageMaintenance(f.filename)).state, 'caught_up');
  } finally { await f.close(); }
});

test('maintenance yields to unfinished work and an actual SQLite writer; neither changes history or progress', async () => {
  const f = await fixture();
  try {
    f.db.prepare('INSERT INTO run_attempts VALUES (?, NULL)').run('controlled-active-work');
    assert.deepEqual(await runHistoryStorageMaintenance(f.filename), { state: 'deferred', reason: 'work_active' });
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM accepted_model_history_objects_v1').get() as { n: number }).n, 0);
    f.db.prepare('UPDATE run_attempts SET finished_at = ?').run(new Date().toISOString());
    f.db.exec('BEGIN IMMEDIATE');
    assert.deepEqual(await runHistoryStorageMaintenance(f.filename), { state: 'deferred', reason: 'writer_busy' });
    f.db.exec('ROLLBACK');
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM accepted_model_history_conversion_v1 WHERE last_rowid IS NOT NULL').get() as { n: number }).n, 0);
    assert.equal((await runHistoryStorageMaintenance(f.filename)).state, 'processed');
  } finally { if (f.db.inTransaction) f.db.exec('ROLLBACK'); await f.close(); }
});

test('maintenance cannot migrate an old or noncontiguous store and never falls back to main-thread conversion', async () => {
  const f = await fixture();
  try {
    f.db.prepare('DELETE FROM schema_version WHERE version = 3').run();
    assert.deepEqual(await runHistoryStorageMaintenance(f.filename), { state: 'deferred', reason: 'schema_unready' });
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM accepted_model_history_objects_v1').get() as { n: number }).n, 0);
    assert.equal(f.db.prepare('SELECT version FROM schema_version WHERE version = 3').get(), undefined);
    assert.deepEqual(await runHistoryStorageMaintenance(path.join(f.root, 'missing.db')), { state: 'unavailable' });
  } finally { await f.close(); }
});
