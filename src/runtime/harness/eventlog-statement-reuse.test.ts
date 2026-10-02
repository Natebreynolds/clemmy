import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-event-statement-reuse-'));
process.env.CLEMENTINE_HOME = home;
const log = await import('./eventlog.js');
after(() => { log.closeEventLog(); rmSync(home, { recursive:true, force:true }); });

test('stable event SQL compiles once while every event and session binding executes independently', () => {
  for (const id of ['fixture-event-reuse-a','fixture-event-reuse-b']) log.createSession({id,kind:'execution'});
  const db = log.openEventLog();
  const original = db.prepare;
  let insertPrepares = 0;
  let pointPrepares = 0;
  db.prepare = function(sql: string) {
    const shape = sql.replace(/\s+/g,' ').trim();
    if (shape.startsWith('INSERT INTO events ') && !shape.includes("'user_input_received'")) insertPrepares++;
    if (shape === 'SELECT * FROM events WHERE id = ?') pointPrepares++;
    return original.call(this,sql);
  } as typeof db.prepare;
  try {
    const ids: string[] = [];
    for (let i=0;i<8;i++) {
      const sessionId = i%2 ? 'fixture-event-reuse-b' : 'fixture-event-reuse-a';
      const event = log.appendEvent({sessionId,turn:i,role:'system',type:'session_started',data:{index:i,exact:`日本語-${i}`}});
      ids.push(event.id);
      assert.equal(log.getEvent(event.id)?.sessionId,sessionId);
      assert.deepEqual(log.getEvent(event.id)?.data,{index:i,exact:`日本語-${i}`});
    }
    const internal = db.transaction(() => log.insertInternalEventInTransaction(db, {
      sessionId:'fixture-event-reuse-a',turn:9,role:'system',type:'session_started',data:{internal:true},
    }))();
    assert.deepEqual(log.getEvent(internal.id)?.data,{internal:true});
    assert.equal(new Set(ids).size,8);
    assert.equal(insertPrepares,1,'the same insert shape does not recompile for each event or internal writer');
    assert.equal(pointPrepares,1,'event lookup executes fresh bindings on one compiled statement');
    assert.equal(log.listEvents('fixture-event-reuse-a').length,5);
    assert.equal(log.listEvents('fixture-event-reuse-b').length,4);
  } finally { db.prepare = original; }
});

test('event readers see current metadata after reuse and reopen the path on a new SQLite handle', () => {
  const id='fixture-event-reuse-reopen';
  log.createSession({id,kind:'execution',title:'original'});
  assert.equal(log.getSession(id)?.title,'original');
  log.updateSession(id,{title:'corrected'});
  assert.equal(log.getSession(id)?.title,'corrected');
  const event=log.appendEvent({sessionId:id,turn:1,role:'system',type:'session_started',data:{exact:'retained'}});
  log.closeEventLog();
  assert.equal(log.getSession(id)?.title,'corrected');
  assert.deepEqual(log.getEvent(event.id)?.data,{exact:'retained'});
});
