import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-event-type-index-'));
process.env.CLEMENTINE_HOME = fixtureHome;
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const log = await import('./eventlog.js');
const schema = await import('./eventlog-schema.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

test.after(() => { log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

test('v78 preserves exact pending-batch recovery while replacing its full event scan with a type-leading index', () => {
  const db = log.openEventLog();
  // v78 only adds this index, so removing its DDL/version leaves the exact v77
  // layout while retaining the real production eventlog connection/query.
  db.exec('DROP INDEX idx_events_type_seq; DELETE FROM schema_version WHERE version >= 78;');
  assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v, 77);
  log.createSession({ id: 'index-fixture-a', kind: 'chat' });
  log.createSession({ id: 'index-fixture-b', kind: 'chat' });
  const insert = db.prepare(`INSERT INTO events(id,session_id,turn,role,type,parent_event_id,data_json,created_at)
    VALUES (?, ?, 1, 'host', ?, NULL, ?, '2026-09-05T23:00:00.000Z')`);
  db.transaction(() => {
    for (let i = 0; i < 4_000; i++) insert.run(`noise-${i}`, 'index-fixture-a', 'tool_returned', JSON.stringify({ text: 'noise'.repeat(250) }));
    insert.run('closed-settled', 'index-fixture-a', 'async_work_dispatch_batch_closed', JSON.stringify({ sourceGroupId: 'settled', sourceUserSeq: 10 }));
    insert.run('published-settled', 'index-fixture-a', 'async_work_dispatched', JSON.stringify({ sourceGroupId: 'settled', sourceUserSeq: 10 }));
    insert.run('closed-pending', 'index-fixture-a', 'async_work_dispatch_batch_closed', JSON.stringify({ sourceGroupId: 'pending', sourceUserSeq: 11, retained: 'exact payload\nTail.' }));
    insert.run('closed-wrong-source', 'index-fixture-a', 'async_work_dispatch_batch_closed', JSON.stringify({ sourceGroupId: 'same-group', sourceUserSeq: 12 }));
    insert.run('published-wrong-source', 'index-fixture-a', 'async_work_dispatched', JSON.stringify({ sourceGroupId: 'same-group', sourceUserSeq: 13 }));
    insert.run('closed-wrong-session', 'index-fixture-a', 'async_work_dispatch_batch_closed', JSON.stringify({ sourceGroupId: 'other-session', sourceUserSeq: 14 }));
    insert.run('published-wrong-session', 'index-fixture-b', 'async_work_dispatched', JSON.stringify({ sourceGroupId: 'other-session', sourceUserSeq: 14 }));
  })();

  // Capture the actual production statement for EXPLAIN, without duplicating
  // its filtering/join logic in the regression.
  let recoverySql = '';
  const prepare = db.prepare;
  db.prepare = function(sql: string) {
    if (sql.includes('FROM events AS closed')) recoverySql = sql;
    return prepare.call(this, sql);
  } as typeof db.prepare;
  let before: ReturnType<typeof log.listPendingAsyncWorkDispatchBatchClosedEvents>;
  try { before = log.listPendingAsyncWorkDispatchBatchClosedEvents(200); }
  finally { db.prepare = prepare; }
  assert.ok(recoverySql, 'the real recovery reader reached its SQLite statement');
  assert.deepEqual(before.map(event => event.id), ['closed-pending', 'closed-wrong-source', 'closed-wrong-session']);
  const details = (sql: string, values: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as Array<{ detail: string }>).map(row => row.detail);
  assert.ok(details(recoverySql, [200]).some(detail => /^SCAN closed$/.test(detail)), 'v77 reproduces the live timer full scan');

  schema.applyHarnessMigrations(db);
  assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v, HARNESS_SCHEMA_VERSION);
  const afterPlan = details(recoverySql, [200]);
  assert.ok(afterPlan.some(detail => /SEARCH closed USING INDEX idx_events_type_seq \(type=\?\)/.test(detail)), afterPlan.join('\n'));
  assert.ok(!afterPlan.some(detail => /^SCAN closed/.test(detail)));
  assert.deepEqual(log.listPendingAsyncWorkDispatchBatchClosedEvents(200), before, 'ordering, complete payloads, and exact source/session exclusion remain unchanged');
  assert.deepEqual(log.listPendingAsyncWorkDispatchBatchClosedEvents(1), before.slice(0, 1), 'the existing output page limit is unchanged');

  const globalCursor = 'SELECT seq FROM events WHERE type = ? AND seq > ? ORDER BY seq LIMIT ?';
  assert.ok(details(globalCursor, ['conversation_completed', 0, 100]).some(detail => /USING COVERING INDEX idx_events_type_seq/.test(detail)));
  schema.applyHarnessMigrations(db);
  log.closeEventLog();
  assert.deepEqual(log.listPendingAsyncWorkDispatchBatchClosedEvents(200), before, 'normal reopen keeps the migrated index and the same recovery work');
});
