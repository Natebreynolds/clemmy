import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { inspectLearningRetentionInventory as inspect } from './learning-retention-inventory.js';

function fixture(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE memory_learning_batches(batch_id TEXT PRIMARY KEY, session_id TEXT,
    member_count INTEGER, shard_count INTEGER, status TEXT);
    CREATE TABLE memory_learning_members(batch_id TEXT, ordinal INTEGER, disposition TEXT,
      UNIQUE(batch_id, ordinal));
    CREATE TABLE memory_learning_shards(batch_id TEXT, ordinal INTEGER, status TEXT, reflection_call_id TEXT,
      UNIQUE(batch_id, ordinal));
    CREATE TABLE memory_reflection_receipts(session_id TEXT, call_id TEXT, status TEXT,
      result_json TEXT, PRIMARY KEY(session_id, call_id));
    CREATE TABLE memory_reflection_candidates(session_id TEXT, call_id TEXT, status TEXT, text TEXT);
    CREATE INDEX candidate_source ON memory_reflection_candidates(session_id, call_id);`);
  return db;
}
function batch(db: Database.Database, input: {
  rowid: number; status?: string; dispositions?: string[];
  shard?: string; receipt?: string; candidates?: string[];
}): void {
  const id = `PRIVATE_BATCH_${input.rowid}`;
  const members = input.dispositions ?? ['unstructured'];
  db.prepare('INSERT INTO memory_learning_batches(rowid,batch_id,session_id,member_count,shard_count,status) VALUES(?,?,?,?,?,?)')
    .run(input.rowid, id, 'PRIVATE_SESSION', members.length, input.shard ? 1 : 0, input.status ?? 'completed');
  members.forEach((disposition, ordinal) => db.prepare('INSERT INTO memory_learning_members VALUES(?,?,?)').run(id, ordinal, disposition));
  if (input.shard) db.prepare('INSERT INTO memory_learning_shards VALUES(?,?,?,?)').run(id, 0, input.shard, id);
  if (input.receipt) db.prepare('INSERT INTO memory_reflection_receipts VALUES(?,?,?,?)')
    .run('PRIVATE_SESSION', id, input.receipt, 'PRIVATE_RESULT');
  for (const status of input.candidates ?? []) db.prepare('INSERT INTO memory_reflection_candidates VALUES(?,?,?,?)')
    .run('PRIVATE_SESSION', id, status, 'PRIVATE_PROPOSED_FACT');
}

test('completed intake does not hide unavailable evidence, pending promotion, failed or missing extraction', () => {
  const db = fixture();
  try {
    batch(db, { rowid: 1, dispositions: ['unavailable'] });
    batch(db, { rowid: 2, shard: 'completed', receipt: 'buffered', candidates: ['pending'] });
    batch(db, { rowid: 3, shard: 'completed', receipt: 'failed' });
    batch(db, { rowid: 4, shard: 'completed' });
    batch(db, { rowid: 5, status: 'dead_letter', shard: 'dead_letter' });
    batch(db, { rowid: 6, status: 'pending', shard: 'processing' });
    batch(db, { rowid: 7, shard: 'completed', receipt: 'completed', candidates: ['pending'] });
    const report = inspect(db, { maxDurationMs: 1_000 });
    assert.equal(report.complete, true);
    assert.equal(report.deletionAuthorized, false);
    assert.equal(report.states.source_unavailable, 1);
    assert.equal(report.states.learning_pending, 3);
    assert.equal(report.states.learning_failed, 2);
    assert.equal(report.states.receipt_missing, 1);
    assert.equal(report.states.extraction_completed, 0);
    assert.equal(report.candidates.pending, 2);
  } finally { db.close(); }
});

test('settled non-memory dispositions are counted without deletion authority, raw text or mutations', () => {
  const db = fixture();
  try {
    batch(db, { rowid: 2, dispositions: ['control', 'structured_task_evidence', 'resource_pointer', 'failed', 'write_ack', 'empty'] });
    batch(db, { rowid: 10, shard: 'completed', receipt: 'completed', candidates: ['promoted', 'rejected', 'expired'] });
    const changes = db.prepare('SELECT total_changes() AS n').get();
    db.pragma('query_only = ON');
    const report = inspect(db, { maxDurationMs: 1_000 });
    assert.equal(report.complete, true);
    assert.equal(report.states.no_extraction_required, 1);
    assert.equal(report.states.extraction_completed, 1);
    assert.deepEqual(report.candidates, { pending: 0, promoted: 1, rejected: 1, expired: 1 });
    assert.equal(report.deletionAuthorized, false);
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), changes);
    assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
    assert.equal(report.scope, 'learning_projection_only');
  } finally { db.close(); }
});

test('completed with open/dead shards or missing/unknown members is inconsistent rather than settled', () => {
  const db = fixture();
  try {
    batch(db, { rowid: 1, shard: 'processing' });
    batch(db, { rowid: 2, shard: 'dead_letter' });
    batch(db, { rowid: 3, dispositions: ['invented-disposition'] });
    batch(db, { rowid: 4, dispositions: [] });
    db.prepare('UPDATE memory_learning_batches SET member_count=1 WHERE rowid=4').run();
    batch(db, { rowid: 5 });
    assert.equal(inspect(db, { maxDurationMs: 1_000 }).states.inconsistent, 5);
  } finally { db.close(); }
});

test('bounded pages use numeric rowids, including negative ids, and resume without silently skipping batches', () => {
  const db = fixture();
  try {
    for (const rowid of [-5, 2, 10, 100]) batch(db, { rowid, dispositions: ['empty'] });
    const first = inspect(db, { maxBatches: 2, maxDurationMs: 1_000 });
    assert.equal(first.complete, false);
    assert.equal(first.stopReason, 'batch_limit');
    assert.equal(first.throughRowid, 2);
    const second = inspect(db, { afterRowid: first.throughRowid, maxBatches: 2, maxDurationMs: 1_000 });
    assert.equal(second.complete, true);
    assert.equal(second.throughRowid, 100);
    assert.equal(first.batchesInspected + second.batchesInspected, 4);
  } finally { db.close(); }
});

test('large children and cooperative deadline report partial coverage, never an empty or settled backlog', () => {
  const db = fixture();
  try {
    batch(db, { rowid: 1, dispositions: ['empty', 'empty', 'empty'] });
    batch(db, { rowid: 2, shard: 'completed', receipt: 'completed', candidates: ['rejected', 'expired', 'promoted'] });
    const limited = inspect(db, { maxRowsPerBatch: 3, maxDurationMs: 1_000 });
    assert.equal(limited.complete, false);
    assert.equal(limited.stopReason, 'child_limit');
    assert.equal(limited.states.inspection_limit, 1);
    assert.equal(limited.states.extraction_completed, 0);
    let now = 0;
    const timed = inspect(db, { maxDurationMs: 1, clock: () => now++ });
    assert.equal(timed.complete, false);
    assert.equal(timed.stopReason, 'time_limit');
    assert.equal(timed.batchesInspected, 0);
  } finally { db.close(); }
});

test('old or damaged projection schemas are unavailable and are never migrated or repaired by inspection', () => {
  const old = new Database(':memory:');
  try {
    old.exec('CREATE TABLE private_data(value TEXT)');
    const report = inspect(old);
    assert.equal(report.state, 'unavailable');
    assert.equal(report.stopReason, 'schema_unavailable');
    assert.equal(report.complete, false);
    assert.deepEqual(old.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all(), [{ name: 'private_data' }]);
  } finally { old.close(); }
  const damaged = fixture();
  try {
    damaged.exec('ALTER TABLE memory_learning_batches RENAME COLUMN member_count TO damaged');
    const report = inspect(damaged);
    assert.equal(report.state, 'unavailable');
    assert.equal(report.stopReason, 'read_failed');
    assert.equal(report.complete, false);
  } finally { damaged.close(); }
});

test('invalid budgets and cursors never silently widen inspection', () => {
  const db = fixture();
  try {
    for (const input of [{ maxBatches: 0 }, { maxRowsPerBatch: Infinity }, { maxDurationMs: 5_001 },
      { afterRowid: NaN }, { afterRowid: 2.5 }]) assert.throws(() => inspect(db, input), /invalid learning inventory/);
  } finally { db.close(); }
});
