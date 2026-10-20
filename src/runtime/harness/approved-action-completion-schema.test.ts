import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {applyHarnessMigrationsThroughVersionForTests} from './eventlog-schema.js';

test('v95 to v96 preserves historical rows and memory schema while adding empty exact-call proof',()=>{
  const db=new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');applyHarnessMigrationsThroughVersionForTests(db,95);
    db.prepare("INSERT INTO sessions(id,kind,status,metadata_json,created_at,updated_at) VALUES('old','chat','active','{}','2026-10-19','2026-10-19')").run();
    db.prepare("INSERT INTO events(id,session_id,turn,role,type,data_json,created_at) VALUES('old-source','old',1,'user','user_input_received','{\"text\":\"Historical fixture.\"}','2026-10-19')").run();
    const rows=['sessions','events','run_attempts','accepted_task_authority','durable_memory_intake_receipts'].map(t=>db.prepare(`SELECT * FROM ${t}`).all());
    const memory=db.prepare("SELECT sql FROM sqlite_master WHERE name='durable_memory_intake_receipts'").get();
    const oldTriggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('trg_accepted_task_host_completion_monotonic','trg_accepted_task_host_terminal_exact')").all() as Array<{name:string;sql:string}>;
    applyHarnessMigrationsThroughVersionForTests(db,96);
    assert.deepEqual(['sessions','events','run_attempts','accepted_task_authority','durable_memory_intake_receipts'].map(t=>db.prepare(`SELECT * FROM ${t}`).all()),rows);
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name='durable_memory_intake_receipts'").get(),memory);
    for(const trigger of oldTriggers) {
      const current=(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(trigger.name) as {sql:string}).sql;
      const body=trigger.sql.slice(trigger.sql.indexOf('NOT EXISTS (')+'NOT EXISTS ('.length,trigger.sql.lastIndexOf('\n          )'));
      assert.ok(current.includes(body),'the entire prior memory predicate remains present');
    }
    assert.equal((db.prepare('SELECT max(version) v FROM schema_version').get() as {v:number}).v,96);
    for(const table of ['approved_action_completion_intents_v1','approved_action_completion_receipts_v1']) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(),[]);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
  } finally {db.close();}
});

test('v96 refuses preexisting unsanctioned proof without stamping version or altering history',()=>{
  const db=new Database(':memory:');
  try {
    applyHarnessMigrationsThroughVersionForTests(db,95);
    db.exec('CREATE TABLE approved_action_completion_receipts_v1(untrusted TEXT)');
    const before=db.serialize();
    assert.throws(()=>applyHarnessMigrationsThroughVersionForTests(db,96),/refuses preexisting unsanctioned/);
    assert.deepEqual(db.serialize(),before);
    assert.equal((db.prepare('SELECT max(version) v FROM schema_version').get() as {v:number}).v,95);
  } finally {db.close();}
});
