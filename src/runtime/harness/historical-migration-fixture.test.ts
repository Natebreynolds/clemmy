/** Offline fixture maintenance only; no live database or provider access. */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { applyHarnessMigrations } from './eventlog-schema.js';
import { restoreEmptyV1MemoryReceiptForHistoricalMigrationFixture as restore } from './historical-migration-fixture.testsupport.js';

const receiptSql = (db: Database.Database): string => (db.prepare(
  "SELECT sql FROM sqlite_master WHERE name='durable_memory_intake_receipts'",
).get() as { sql: string }).sql;

test('historical fixture restores empty canonical V1 checks and preserves all other schema objects before real v93 replay', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    applyHarnessMigrations(db);
    const original = receiptSql(db);
    const otherObjects = () => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name!='durable_memory_intake_receipts' ORDER BY type,name").all();
    const before = otherObjects();
    const versions = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
    restore(db);
    assert.match(receiptSql(db), /CHECK \(protocol_version = 1\)/);
    assert.deepEqual(otherObjects(), before);
    assert.deepEqual(db.prepare('SELECT * FROM schema_version ORDER BY version').all(), versions, 'the helper does not claim an older version');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    restore(db); // Already historical and empty is a no-op.
    db.exec('DELETE FROM schema_version WHERE version >= 93');
    applyHarnessMigrations(db);
    assert.equal(receiptSql(db), original);
    assert.deepEqual(otherObjects(), before);
  } finally { db.close(); }
});

test('historical fixture refuses populated receipt or bound authority without rewriting even synthetic guard rows', () => {
  // These deliberately tiny tables test the refusal guard, not admission proof.
  for (const bound of [false, true]) {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE durable_memory_intake_receipts (receipt_id TEXT); CREATE TABLE accepted_task_authority (host_completion_receipt_id TEXT, host_completion_event_id TEXT);');
      db.exec(bound ? "INSERT INTO accepted_task_authority VALUES ('bound', 'event')" : "INSERT INTO durable_memory_intake_receipts VALUES ('retained')");
      const before = db.serialize();
      assert.throws(() => restore(db), bound ? /bound host completion authority/ : /populated receipt authority/);
      assert.deepEqual(db.serialize(), before);
    } finally { db.close(); }
  }
});

test('historical fixture requires isolation and refuses an unknown empty receipt shape', () => {
  const db = new Database(':memory:');
  const prior = process.env.CLEMMY_TEST_ISOLATED_HOME;
  try {
    db.exec('CREATE TABLE durable_memory_intake_receipts (receipt_id TEXT)');
    delete process.env.CLEMMY_TEST_ISOLATED_HOME;
    assert.throws(() => restore(db), /isolated test contract/);
    process.env.CLEMMY_TEST_ISOLATED_HOME = prior;
    const before = db.serialize();
    assert.throws(() => restore(db), /unknown receipt schema/);
    assert.deepEqual(db.serialize(), before);
  } finally {
    if (prior === undefined) delete process.env.CLEMMY_TEST_ISOLATED_HOME;
    else process.env.CLEMMY_TEST_ISOLATED_HOME = prior;
    db.close();
  }
});
