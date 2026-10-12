import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
if (process.env.CLEMMY_TEST_ISOLATED_HOME !== '1') throw new Error('Disposable home required.');
const { migrateMemoryDatabaseHandle } = await import('./db.js');
const log = await import('../runtime/harness/eventlog.js');
const usage = await import('../runtime/usage-log.js');
const { createAutomaticMemoryOrigin } = await import('./memory-destination.js');
const { recordAutomaticMemoryCandidate } = await import('./reflection-candidates.js');
const accounting = await import('./memory-causal-accounting.js');
const dir = mkdtempSync(path.join(os.tmpdir(), 'memory-causal-extension-'));
after(() => { log.closeEventLog(); rmSync(dir, { recursive: true, force: true }); });
let counter = 0;
function fixture() {
  const session = log.createSession({ id: `sess-accounting-${++counter}`, kind: 'chat' });
  const text = 'For this project only, use blue headings.';
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  const attempt = log.beginRunAttempt(session.id, { attemptId: `attempt:accounting-${counter}` });
  log.bindRunAttemptSourceUserEvent(attempt, source.seq);
  const parent = { sessionId: session.id, sourceUserSeq: source.seq, attemptId: attempt.attemptId };
  const origin = createAutomaticMemoryOrigin({ source: { authority: 'accepted_user_input', sessionId: session.id,
    eventId: source.id, eventSeq: source.seq, eventType: 'user_input_received', ownerText: text, context: null },
    claim: { start: 0, end: text.length }, claimMode: 'complete', candidate: { kind: 'user', text } });
  const input = { sessionId: session.id, callId: `auto-capture:user-source:${source.seq}`, kind: 'user', text,
    importance: 5, origin };
  return { source, attempt, parent, input };
}
function memoryDb(filename = ':memory:') { const db = new Database(filename); db.pragma('foreign_keys = ON'); migrateMemoryDatabaseHandle(db); return db; }
function parentOf(db: Database.Database, id: number) { return usage.memoryAccountingParent(accounting.readMemoryCandidateAccountingOrigin(id, db)); }

test('first insert retains exact original attempt after reopen and duplicate foreign delivery', async () => {
  const f = fixture(); const filename = path.join(dir, 'reopen.sqlite'); let db = memoryDb(filename);
  const id = usage.withModelUsageAttribution(f.parent, () => recordAutomaticMemoryCandidate(f.input, db));
  assert.deepEqual(parentOf(db, id), f.parent);
  const before = db.prepare('SELECT * FROM memory_candidate_accounting_origins').all(); db.close();
  db = memoryDb(filename); assert.deepEqual(parentOf(db, id), f.parent);
  const other = log.beginRunAttempt(f.parent.sessionId, { attemptId: 'attempt:later-same-source' });
  log.bindRunAttemptSourceUserEvent(other, f.source.seq);
  assert.equal(usage.withModelUsageAttribution({ ...f.parent, attemptId: other.attemptId }, () => recordAutomaticMemoryCandidate(f.input, db)), id);
  assert.deepEqual(db.prepare('SELECT * FROM memory_candidate_accounting_origins').all(), before);
  assert.deepEqual(parentOf(db, id), f.parent);
  const backup = path.join(dir, 'backup.sqlite'); await db.backup(backup); db.close();
  db = memoryDb(backup); assert.deepEqual(parentOf(db, id), f.parent);
  assert.equal((db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version, 37);
  db.close();
});

test('explicit absent/foreign/unbound origin stays unowned rather than adopting replay', () => {
  for (const mode of ['absent', 'foreign', 'unbound', 'wrong-source', 'wrong-text'] as const) {
    const f = fixture(); const db = memoryDb();
    const current = mode === 'foreign' ? { ...f.parent, sessionId: 'other-session' }
      : mode === 'unbound' ? { ...f.parent, attemptId: 'attempt:nonexistent' }
        : mode === 'wrong-source' ? { ...f.parent, sourceUserSeq: f.source.seq + 1 } : f.parent;
    if (mode === 'wrong-text') log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?').run('{"text":"different"}', f.source.seq);
    const id = mode === 'absent' ? recordAutomaticMemoryCandidate(f.input, db)
      : usage.withModelUsageAttribution(current, () => recordAutomaticMemoryCandidate(f.input, db));
    assert.deepEqual(parentOf(db, id), mode === 'wrong-text' ? undefined : { sessionId: f.parent.sessionId, sourceUserSeq: f.parent.sourceUserSeq }, mode);
    usage.withModelUsageAttribution(f.parent, () => recordAutomaticMemoryCandidate(f.input, db));
    assert.equal(parentOf(db, id)?.attemptId, undefined, 'redelivery cannot upgrade explicit unowned'); db.close();
  }
});

test('legacy extension absence never upgrades; exact source-only fallback has no attempt', () => {
  const f = fixture(); const db = memoryDb();
  const id = recordAutomaticMemoryCandidate(f.input, db);
  db.exec('DROP TABLE memory_candidate_accounting_origins; DROP TABLE memory_causal_accounting_meta');
  assert.deepEqual(parentOf(db, id), { sessionId: f.parent.sessionId, sourceUserSeq: f.parent.sourceUserSeq });
  usage.withModelUsageAttribution(f.parent, () => recordAutomaticMemoryCandidate(f.input, db));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_candidate_accounting_origins'").get(), undefined);
  db.close();
});

test('corrupt extension/schema/attempt/candidate identities decline only accounting', () => {
  for (const mode of ['schema', 'version', 'attempt', 'candidate', 'source', 'episode'] as const) {
    const f = fixture(); const db = memoryDb();
    const id = usage.withModelUsageAttribution(f.parent, () => recordAutomaticMemoryCandidate(f.input, db));
    if (mode === 'schema') { db.exec('DROP TABLE memory_candidate_accounting_origins'); db.exec('CREATE TABLE memory_candidate_accounting_origins (candidate_id INTEGER PRIMARY KEY)'); }
    if (mode === 'version') db.prepare('DELETE FROM memory_causal_accounting_meta').run();
    if (mode === 'attempt') {
      const b = log.beginRunAttempt(f.parent.sessionId, { attemptId: 'attempt:tampered-valid' }); log.bindRunAttemptSourceUserEvent(b, f.source.seq);
      db.prepare('UPDATE memory_candidate_accounting_origins SET attempt_id = ?').run(b.attemptId);
    }
    if (mode === 'candidate') db.prepare('UPDATE memory_reflection_candidates SET candidate_hash = ? WHERE id = ?').run('changed', id);
    if (mode === 'source') db.prepare('UPDATE memory_candidate_accounting_origins SET source_event_id = ?').run('changed');
    if (mode === 'episode') db.prepare('UPDATE memory_reflection_candidates SET call_id = ? WHERE id = ?').run('different', id);
    assert.equal(parentOf(db, id), undefined, mode); db.close();
  }
});

test('optional accounting failure preserves ordinary candidate and outer rollback couples both', () => {
  const f = fixture(); const db = memoryDb(); db.exec('CREATE TABLE memory_causal_accounting_meta (wrong TEXT)');
  const id = usage.withModelUsageAttribution(f.parent, () => recordAutomaticMemoryCandidate(f.input, db));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_reflection_candidates').get() && id > 0, true);
  assert.equal(parentOf(db, id), undefined); db.close();
  const clean = memoryDb();
  assert.throws(() => clean.transaction(() => { usage.withModelUsageAttribution(f.parent, () => recordAutomaticMemoryCandidate(f.input, clean)); throw new Error('fixture rollback'); })(), /fixture rollback/);
  assert.equal((clean.prepare('SELECT COUNT(*) AS n FROM memory_reflection_candidates').get() as { n: number }).n, 0);
  assert.equal(clean.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_candidate_accounting_origins'").get(), undefined);
  clean.close();
});

test('first scheduling attempt is explicit causal ownership, not original admission inference', () => {
  const f = fixture(); const db = memoryDb();
  const later = log.beginRunAttempt(f.parent.sessionId, { attemptId: 'attempt:first-scheduler-B' });
  log.bindRunAttemptSourceUserEvent(later, f.source.seq);
  const b = { ...f.parent, attemptId: later.attemptId };
  const id = usage.withModelUsageAttribution(b, () => recordAutomaticMemoryCandidate(f.input, db));
  assert.deepEqual(parentOf(db, id), b, 'first valid scheduler B is not relabeled admission A');
  usage.withModelUsageAttribution(f.parent, () => recordAutomaticMemoryCandidate(f.input, db));
  assert.deepEqual(parentOf(db, id), b, 'later delivery cannot rewrite scheduling ownership'); db.close();
});
