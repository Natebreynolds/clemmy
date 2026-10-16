/** Upgrade and fault-injection tests for the durable result-publication intent. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-outcome-schema-v95-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const schema = await import('./eventlog-schema.js');
const log = await import('./eventlog.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');
const { deliverOutcome, deliverOutcomeWithAcknowledgement, processDeferredProactiveReports } = await import('../outcome.js');
const { actionBus } = await import('../action-bus.js');
const NOW = '2026-10-15T12:00:00.000Z';

after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('v94 upgrade adds the indexed bounded retry ledger without rewriting historical sessions, events or attempts', () => {
  const db = new Database(path.join(home, 'historical-v94.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 94);
    db.prepare(`INSERT INTO sessions (id,kind,created_at,updated_at,status,metadata_json)
      VALUES ('historical-background','chat',?,?,'active',?)`).run(NOW, NOW,
      JSON.stringify({ preserved: 'historical bytes', deferredProactiveReports: [{ sourceId: 'old-report' }] }));
    const historical = db.prepare(`INSERT INTO events (id,session_id,turn,role,type,data_json,created_at)
      VALUES (?,'historical-background',1,'user','user_input_received',?,?)`);
    const seq = Number(historical.run('historical-human', '{"text":"Keep the historical task."}', NOW).lastInsertRowid);
    historical.run('historical-passive', JSON.stringify({ synthetic: true, source: 'outcome', deliveryPhase: 'passive',
      sourceId: 'old-report', sourceLabel: 'Historical result', text: 'Original retained result.' }), NOW);
    db.prepare(`INSERT INTO run_attempts (attempt_id,session_id,run_id,started_at,status,source_user_seq)
      VALUES ('historical-attempt','historical-background','historical-run',?,'active',?)`).run(NOW, seq);
    const tables = ['sessions', 'events', 'run_attempts'];
    const rows = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const priorVersions = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
    const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();

    schema.applyHarnessMigrations(db);

    assert.equal(HARNESS_SCHEMA_VERSION, 95);
    assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()), rows);
    assert.deepEqual(db.prepare('SELECT * FROM schema_version WHERE version <= 94 ORDER BY version').all(), priorVersions);
    assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all(),
      Array.from({ length: HARNESS_SCHEMA_VERSION }, (_, index) => ({ version: index + 1 })));
    assert.deepEqual(db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL
      AND name NOT IN ('outcome_reports_pending_v1','outcome_reports_pending_order_v1','outcome_reports_pending_session_v1')
      ORDER BY type,name`).all(), objects);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(db.prepare('SELECT * FROM outcome_reports_pending_v1').all(), []);
    assert.deepEqual((db.pragma('index_info(outcome_reports_pending_order_v1)') as Array<{ name: string }>).map(row => row.name),
      ['attempts', 'created_at']);
    const insert = db.prepare('INSERT INTO outcome_reports_pending_v1 (source_event_id,session_id,created_at) VALUES (?,?,?)');
    insert.run('historical-passive', 'historical-background', NOW);
    assert.deepEqual(db.prepare('SELECT * FROM outcome_reports_pending_v1').get(),
      { source_event_id: 'historical-passive', session_id: 'historical-background', created_at: NOW, attempts: 0 });
    assert.throws(() => insert.run('historical-passive', 'another-session', NOW), /UNIQUE constraint/);
    assert.throws(() => insert.run('missing-source', 'historical-background', NOW), /FOREIGN KEY constraint/);
    assert.throws(() => db.prepare('UPDATE outcome_reports_pending_v1 SET attempts=-1').run(), /CHECK constraint/);
    assert.throws(() => insert.run('missing-session', null, NOW), /NOT NULL constraint/);
    schema.applyHarnessMigrations(db);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM outcome_reports_pending_v1').get() as { n: number }).n, 1);
    assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()), rows);
  } finally { db.close(); }
});

test('a pending-intent insert failure rolls back the passive result atomically and permits one clean retry', () => {
  const id = 'background-atomic-retention';
  log.createSession({ id, kind: 'chat', channel: 'desktop' });
  const human = log.appendEvent({ sessionId: id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Keep the controlled foreground task.' } });
  const db = log.openEventLog();
  db.exec(`CREATE TRIGGER fixture_background_pending_failure BEFORE INSERT ON outcome_reports_pending_v1
    WHEN NEW.session_id = 'background-atomic-retention'
    BEGIN SELECT RAISE(ABORT, 'controlled pending insert failure'); END;`);
  const outcome = { status: 'done' as const, detail: 'The controlled separate result is ready.' };
  const context = { originSessionId: id, sourceLabel: 'Controlled background task', sourceId: 'atomic-run',
    proactiveTurn: true, deliveryId: 'controlled-atomic-delivery' };
  const publicEvents: Array<{ seq: number }> = [];
  const detach = actionBus.subscribe(event => {
    if (event.kind === 'harness.public_event' && event.sessionId === id) publicEvents.push(event.event);
  });
  try {
    assert.equal(deliverOutcome(outcome, context), false);
    assert.deepEqual(log.listEvents(id), [human], 'failed intent retains no orphan passive/report/terminal event');
    assert.deepEqual(db.prepare('SELECT * FROM outcome_reports_pending_v1 WHERE session_id=?').all(id), []);
    assert.deepEqual(publicEvents, [], 'a rolled-back passive event must never escape through SSE');
    const next = log.appendEvent({ sessionId: id, turn: 2, role: 'user', type: 'user_input_received',
      data: { text: 'This real input follows the rejected delivery.' } });
    assert.equal(next.seq, human.seq + 1, 'the failed insert consumed no durable event cursor');
    assert.equal(publicEvents.length, 1, 'the next real accepted input publishes exactly once');
    assert.equal(publicEvents[0]!.seq, next.seq);
  } finally { db.exec('DROP TRIGGER fixture_background_pending_failure'); detach(); }
  assert.equal(deliverOutcome(outcome, context), true);
  const accepted = log.listEvents(id);
  assert.equal(accepted.filter(event => event.data.deliveryPhase === 'passive').length, 1);
  assert.equal(accepted.filter(event => event.data.deliveryPhase === 'report').length, 1);
  assert.equal(accepted.filter(event => event.type === 'conversation_completed').length, 1);
  assert.deepEqual(db.prepare('SELECT * FROM outcome_reports_pending_v1 WHERE session_id=?').all(id), []);
  assert.equal(accepted.some(event => ['tool_called', 'model_request_started', 'run_started'].includes(event.type)), false);
  assert.equal(deliverOutcome(outcome, context), false, 'replay does not duplicate the accepted result');
});

test('pending publication retains an expired session through reaping and hard delete until actual delivery is acknowledged', async () => {
  const id = 'background-retention-until-ack';
  log.createSession({ id, kind: 'chat', channel: 'desktop' });
  const db = log.openEventLog();
  const outcome = { status: 'done' as const, detail: 'The retained controlled report is ready.' };
  const context = { originSessionId: id, sourceLabel: 'Controlled retained task', sourceId: 'retention-run',
    proactiveTurn: true, deliveryId: 'controlled-retention-delivery' };
  db.exec(`CREATE TRIGGER fixture_background_publication_failure BEFORE INSERT ON events
    WHEN NEW.type='conversation_completed' AND NEW.session_id='background-retention-until-ack'
    BEGIN SELECT RAISE(ABORT, 'controlled public delivery failure'); END;`);
  try {
    assert.equal(deliverOutcomeWithAcknowledgement(outcome, context).acknowledged, false);
  } finally { db.exec('DROP TRIGGER fixture_background_publication_failure'); }
  const passive = log.listEvents(id).find(event => event.data.deliveryPhase === 'passive')!;
  assert.ok(passive);
  assert.equal(log.sessionHasAcceptedSourceReplayBinding(id), true);
  const expire = () => db.prepare("UPDATE sessions SET status='completed', updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
  expire();
  assert.equal(log.reapStaleSessions(14), 0, 'an undelivered result holds its expired conversation');
  assert.ok(log.getEvent(passive.id));
  assert.throws(() => db.prepare('DELETE FROM events WHERE id=?').run(passive.id), /FOREIGN KEY constraint/);
  assert.throws(() => db.prepare('DELETE FROM sessions WHERE id=?').run(id), /FOREIGN KEY constraint/);
  const { deleteUnifiedSession } = await import('../../dashboard/sessions-api.js');
  const deletion = deleteUnifiedSession(`harness:${id}`, true);
  assert.equal(deletion?.mode, 'archived');
  assert.equal(deletion?.retainedForReplay, true);
  assert.ok(log.getSession(id));
  await processDeferredProactiveReports();
  assert.equal(log.listEvents(id, { types: ['conversation_completed'] }).length, 1);
  assert.deepEqual(db.prepare('SELECT * FROM outcome_reports_pending_v1 WHERE session_id=?').all(id), []);
  assert.equal(log.sessionHasAcceptedSourceReplayBinding(id), false, 'acknowledgement releases only the delivery hold');
  expire();
  assert.equal(log.reapStaleSessions(14), 1, 'ordinary retention resumes after the exact visible result exists');
  assert.equal(log.getSession(id), null);
  assert.equal(log.getEvent(passive.id), null);
});
