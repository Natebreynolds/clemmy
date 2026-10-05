/** Run with scripts/run-tests-isolated.mjs. No provider or live-home access. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-receipt-v93-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const schema = await import('./eventlog-schema.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');
test.after(() => rmSync(TEST_HOME, {recursive:true,force:true}));
const NOW = '2026-10-04T20:00:00.000Z';
const HASH = 'a'.repeat(64);

function objects(db: Database.Database) {
  return db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND
    ((type='index' AND tbl_name='durable_memory_intake_receipts') OR
     (type='trigger' AND (tbl_name='durable_memory_intake_receipts' OR sql LIKE '%durable_memory_intake_receipts%')))
    ORDER BY type,name`).all();
}

function seedV1(db: Database.Database) {
  const sessionId = 'historical-v1-memory-receipt';
  db.prepare("INSERT INTO sessions (id,kind,created_at,updated_at,status,metadata_json) VALUES (?,'chat',?,?,'active','{}')").run(sessionId,NOW,NOW);
  const event = db.prepare('INSERT INTO events (id,session_id,turn,role,type,data_json,created_at) VALUES (?,?,1,?,?,?,?)');
  const seq = Number(event.run('memory-v1-source',sessionId,'user','user_input_received','{"text":"Remember this: fixture is ORCHARD."}',NOW).lastInsertRowid);
  event.run('memory-v1-graph',sessionId,'system','turn_graph_shadow','{}',NOW);
  const acceptedTaskId = `task:${sessionId}#${seq}`;
  const receiptId = `memory-intake:v1:${HASH}`;
  event.run('memory-v1-mirror',sessionId,'system','durable_memory_intake_receipt',JSON.stringify({receiptId,sourceUserSeq:seq,acceptedTaskId}),NOW);
  db.prepare(`INSERT INTO accepted_task_authority (session_id,source_user_seq,accepted_task_id,authority_protocol,
    graph_event_id,graph_id,graph_hash,state,expected_work_required,armed_at,updated_at)
    VALUES (?,?,?,1,'memory-v1-graph','graph-v1',?,'armed',1,?,?)`).run(sessionId,seq,acceptedTaskId,HASH,NOW,NOW);
  db.prepare(`INSERT INTO durable_memory_intake_receipts (receipt_id,protocol_version,session_id,source_user_seq,
    accepted_task_id,graph_event_id,graph_id,graph_hash,source_event_id,source_message_digest,episode_id,call_id,
    episode_content_hash,candidate_count,candidate_digest,evidence_digest,receipt_json,receipt_event_id,issued_at)
    VALUES (?,1,?,?,?,'memory-v1-graph','graph-v1',?,'memory-v1-source',?,'episode-v1','call-v1',?,1,?,?,'{"historical":"bytes"}','memory-v1-mirror',?)`)
    .run(receiptId,sessionId,seq,acceptedTaskId,HASH,HASH,HASH,HASH,HASH,NOW);
  db.prepare(`UPDATE accepted_task_authority SET state='manifested_verifying',manifest_id=?,host_completion_receipt_id=?,
    host_completion_event_id='memory-v1-mirror',backstop_event_id='memory-v1-mirror' WHERE session_id=?`).run(receiptId,receiptId,sessionId);
  return {sessionId,seq,receiptId};
}

test('v93 preserves historical V1 bytes, authority references, triggers and FKs while adding V2', () => {
  const db = new Database(path.join(TEST_HOME,'historical.db'));
  try {
    db.pragma('foreign_keys=ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db,92);
    const fixture = seedV1(db);
    const beforeRows = db.prepare('SELECT * FROM durable_memory_intake_receipts').all();
    const beforeAuthority = db.prepare('SELECT * FROM accepted_task_authority').all();
    const beforeEvents = db.prepare('SELECT * FROM events').all();
    const beforeObjects = objects(db);
    assert.ok(beforeObjects.length >= 5);
    schema.applyHarnessMigrations(db);
    assert.equal((db.prepare('SELECT MAX(version) v FROM schema_version').get() as {v:number}).v,HARNESS_SCHEMA_VERSION);
    assert.deepEqual(db.prepare('SELECT * FROM durable_memory_intake_receipts').all(),beforeRows);
    assert.deepEqual(db.prepare('SELECT * FROM accepted_task_authority').all(),beforeAuthority);
    assert.deepEqual(db.prepare('SELECT * FROM events').all(),beforeEvents);
    assert.deepEqual(objects(db),beforeObjects);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
    assert.throws(() => db.prepare("UPDATE durable_memory_intake_receipts SET issued_at='altered' WHERE receipt_id=?").run(fixture.receiptId),/immutable/);
    assert.throws(() => db.prepare('DELETE FROM durable_memory_intake_receipts WHERE receipt_id=?').run(fixture.receiptId),/immutable/);
    assert.throws(() => db.prepare('UPDATE accepted_task_authority SET host_completion_receipt_id=? WHERE session_id=?')
      .run(`memory-intake:v2:${HASH}`,fixture.sessionId),/exact or monotonic/);
    const table = (db.prepare("SELECT sql FROM sqlite_master WHERE name='durable_memory_intake_receipts'").get() as {sql:string}).sql;
    assert.match(table,/protocol_version IN \(1, 2\)/);
    assert.match(table,/protocol_version = 2 AND receipt_id LIKE 'memory-intake:v2:%'/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='durable_memory_intake_receipts_v93'").get(),undefined);
    // Reopen/reapply changes neither historical proof nor its authority.
    schema.applyHarnessMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM durable_memory_intake_receipts').all(),beforeRows);
  } finally {db.close();}
});

test('v93 rejects an unsanctioned replacement name transactionally without losing old rows', () => {
  const db = new Database(path.join(TEST_HOME,'conflict.db'));
  try {
    schema.applyHarnessMigrationsThroughVersionForTests(db,92);
    seedV1(db);
    const rows = db.prepare('SELECT * FROM durable_memory_intake_receipts').all();
    db.exec('CREATE TABLE durable_memory_intake_receipts_v93 (untrusted TEXT)');
    assert.throws(() => schema.applyHarnessMigrations(db),/preexisting replacement/);
    assert.deepEqual(db.prepare('SELECT * FROM durable_memory_intake_receipts').all(),rows);
    assert.equal((db.prepare('SELECT MAX(version) v FROM schema_version').get() as {v:number}).v,92);
  } finally {db.close();}
});

test('v93 preserves its V1 receipt alongside unrelated missing-source run history retained by v32', () => {
  const db = new Database(path.join(TEST_HOME,'unrelated-history.db'));
  try {
    db.pragma('foreign_keys=ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db,92);
    const fixture = seedV1(db);
    // A real historical shape explicitly tolerated by v32. It is not new
    // admissible execution authority and must not be silently repaired here.
    db.pragma('foreign_keys=OFF');
    db.prepare(`INSERT INTO run_attempts (attempt_id,session_id,run_id,started_at,status,source_user_seq)
      VALUES ('historical-missing-source',?,'historical-run',?,'active',999999)`).run(fixture.sessionId,NOW);
    db.pragma('foreign_keys=ON');
    const beforeViolations = db.pragma('foreign_key_check');
    assert.equal(beforeViolations.length,1);
    assert.equal((beforeViolations[0] as {table:string}).table,'run_attempts');
    const before = ['run_attempts','durable_memory_intake_receipts','accepted_task_authority','events']
      .map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const beforeObjects = objects(db);
    schema.applyHarnessMigrations(db);
    assert.equal((db.prepare('SELECT MAX(version) v FROM schema_version').get() as {v:number}).v,93);
    assert.deepEqual(['run_attempts','durable_memory_intake_receipts','accepted_task_authority','events']
      .map(table => db.prepare(`SELECT * FROM ${table}`).all()),before);
    assert.deepEqual(objects(db),beforeObjects);
    assert.deepEqual(db.pragma('foreign_key_check'),beforeViolations,'only the unchanged historical violation remains');
    assert.deepEqual(db.pragma('foreign_key_check(durable_memory_intake_receipts)'),[]);
    assert.equal(db.pragma('foreign_keys',{simple:true}),1);
  } finally {db.close();}
});

test('v93 refuses a receipt outbound FK violation and preserves the complete historical table', () => {
  const db = new Database(path.join(TEST_HOME,'receipt-outbound-corruption.db'));
  try {
    schema.applyHarnessMigrationsThroughVersionForTests(db,92);
    const fixture = seedV1(db);
    // Deliberately malformed old receipt, never produced through the live
    // writer. Restore its exact immutable trigger before testing migration.
    db.pragma('foreign_keys=OFF');
    const trigger = (db.prepare("SELECT sql FROM sqlite_master WHERE name='trg_durable_memory_intake_receipts_update_immutable'")
      .get() as {sql:string}).sql;
    db.exec('DROP TRIGGER trg_durable_memory_intake_receipts_update_immutable');
    db.prepare("UPDATE durable_memory_intake_receipts SET receipt_event_id='missing-receipt-event' WHERE receipt_id=?")
      .run(fixture.receiptId);
    db.exec(trigger);
    const rows = db.prepare('SELECT * FROM durable_memory_intake_receipts').all();
    const authority = db.prepare('SELECT * FROM accepted_task_authority').all();
    const beforeObjects = objects(db);
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE name='durable_memory_intake_receipts'").get();
    assert.equal(db.pragma('foreign_key_check(durable_memory_intake_receipts)').length,1);
    assert.throws(() => schema.applyHarnessMigrations(db),/schema v93 memory receipt foreign-key validation failed/);
    assert.equal((db.prepare('SELECT MAX(version) v FROM schema_version').get() as {v:number}).v,92);
    assert.deepEqual(db.prepare('SELECT * FROM durable_memory_intake_receipts').all(),rows);
    assert.deepEqual(db.prepare('SELECT * FROM accepted_task_authority').all(),authority);
    assert.deepEqual(objects(db),beforeObjects);
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name='durable_memory_intake_receipts'").get(),table);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='durable_memory_intake_receipts_v93'").get(),undefined);
    assert.equal(db.pragma('foreign_keys',{simple:true}),0);
  } finally {db.close();}
});

test('v93 refuses an inbound CASCADE extension before rebuilding or losing its child row', () => {
  const db = new Database(path.join(TEST_HOME,'receipt-inbound-cascade.db'));
  try {
    db.pragma('foreign_keys=ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db,92);
    const fixture = seedV1(db);
    db.exec('CREATE TABLE fixture_receipt_child (id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES durable_memory_intake_receipts(receipt_id) ON DELETE CASCADE)');
    db.prepare('INSERT INTO fixture_receipt_child VALUES (?,?)').run('retained-child',fixture.receiptId);
    const before = ['fixture_receipt_child','durable_memory_intake_receipts','accepted_task_authority','events']
      .map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const beforeObjects = objects(db);
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE name='durable_memory_intake_receipts'").get();
    assert.throws(() => schema.applyHarnessMigrations(db),/unsupported inbound memory receipt foreign keys/);
    assert.equal((db.prepare('SELECT MAX(version) v FROM schema_version').get() as {v:number}).v,92);
    assert.deepEqual(['fixture_receipt_child','durable_memory_intake_receipts','accepted_task_authority','events']
      .map(table => db.prepare(`SELECT * FROM ${table}`).all()),before);
    assert.deepEqual(objects(db),beforeObjects);
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name='durable_memory_intake_receipts'").get(),table);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
    assert.equal(db.pragma('foreign_keys',{simple:true}),1);
  } finally {db.close();}
});
