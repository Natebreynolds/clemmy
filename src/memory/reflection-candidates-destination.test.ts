import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

if (process.env.CLEMMY_TEST_ISOLATED_HOME !== '1') throw new Error('Use the disposable repository test runner.');
const { migrateMemoryDatabaseHandle } = await import('./db.js');
const { createAutomaticMemoryOrigin, automaticMemoryOriginDigest, parseAutomaticMemoryEnvelope } = await import('./memory-destination.js');
const {
  recordAutomaticMemoryCandidate, recordAutomaticMemoryCandidates, readAutomaticMemoryCandidate,
  commitAutomaticMemoryDecision, readOwnedAutomaticMemoryDecision,
} = await import('./reflection-candidates.js');
import type { AutomaticMemoryDecision, AutomaticMemoryOriginInput } from './memory-destination.js';

const handles: Database.Database[] = [];
const dirs: string[] = [];
afterEach(() => { for (const db of handles.splice(0)) if (db.open) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function database(filename = ':memory:', version?: number) {
  const db = new Database(filename); handles.push(db);
  migrateMemoryDatabaseHandle(db, version === undefined ? {} : { targetVersion: version });
  return db;
}
const ownerText = 'For this project only, reports use blue headings. For everywhere, reports use blue headings.';
function originInput(span = { start: 0, end: ownerText.indexOf(' For everywhere') }): AutomaticMemoryOriginInput {
  return { source: { authority: 'accepted_user_input', sessionId: 'destination-storage', eventId: 'source-17',
    eventSeq: 17, eventType: 'user_input_received', ownerText,
    context: { sessionId: 'destination-storage', sourceUserSeq: 17, digest: 'b'.repeat(64),
      memoryScope: { projectId: 'project-A', agentKey: null } } },
    claim: span, claimMode: 'complete', candidate: { kind: 'user', text: ownerText.slice(span.start, span.end) } };
}
function candidate(value = originInput()) {
  const origin = createAutomaticMemoryOrigin(value);
  return { sessionId: value.source.sessionId, callId: 'auto-capture:user-source:17', kind: value.candidate.kind,
    text: value.candidate.text, importance: 5, intakeReason: 'explicit remember request', trustLevel: 1,
    sourceUri: 'conversation://destination-storage/auto-capture:user-source:17', origin };
}
function claim(db: Database.Database, id: number, attemptCount = 1) {
  const processingStartedAt = `2026-10-05T04:00:0${attemptCount}.000Z`;
  db.prepare('UPDATE memory_reflection_candidates SET attempt_count = ?, processing_started_at = ? WHERE id = ?').run(attemptCount, processingStartedAt, id);
  const found = readAutomaticMemoryCandidate(id, db); assert.equal(found.status, 'valid');
  if (found.status !== 'valid') throw new Error('fixture origin missing');
  return { id, originDigest: found.envelope.originDigest, claim: { attemptCount, processingStartedAt } };
}
function decision(value = originInput()): AutomaticMemoryDecision {
  return { durability: 'standing', claim: value.claim, destination: 'current_project',
    destinationSpans: [{ start: 0, end: 'For this project only'.length }], reason: 'Exact project-only source clause.' };
}

test('v37 migration leaves legacy pending/terminal facts untouched and refuses old-reader downgrade', () => {
  const db = database(':memory:', 36);
  const factId = Number(db.prepare(`INSERT INTO consolidated_facts
    (kind,content,content_hash,source_session_id,created_at,updated_at)
    VALUES ('user','Prior retained convention with its complete condition.','old-fact-hash','legacy','2026-01-01','2026-01-02')`).run().lastInsertRowid);
  for (const status of ['pending', 'promoted', 'rejected', 'expired']) {
    db.prepare(`INSERT INTO memory_reflection_candidates
      (session_id,call_id,candidate_hash,kind,text,importance,status,reason,resulting_fact_id,created_at,resolved_at,source_type)
      VALUES ('legacy',?,?,?,?,5,?,?,?,'2026-01-01',?,'auto_capture')`).run(
      `old-${status}`, `hash-${status}`, 'user', 'old scoped preference', status,
      `retained-${status}`, status === 'promoted' ? factId : null, status === 'pending' ? null : '2026-01-02');
  }
  const before = db.prepare('SELECT * FROM memory_reflection_candidates ORDER BY id').all() as Record<string, unknown>[];
  const factBytes = JSON.stringify(db.prepare('SELECT * FROM consolidated_facts ORDER BY id').all());
  migrateMemoryDatabaseHandle(db);
  const after = db.prepare('SELECT * FROM memory_reflection_candidates ORDER BY id').all() as Record<string, unknown>[];
  assert.deepEqual(after, before.map(row => ({ ...row, destination_json: null })));
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM consolidated_facts ORDER BY id').all()), factBytes);
  for (const row of after) assert.equal(readAutomaticMemoryCandidate(Number(row.id), db).status, 'legacy');
  // This is the unchanged production migration guard with the v36 reader's
  // target, not a claim that an old packaged binary was launched.
  assert.throws(() => migrateMemoryDatabaseHandle(db, { targetVersion: 36 }), /newer than migration target/);
  migrateMemoryDatabaseHandle(db);
  assert.equal((db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version, 37);
});
test('exact intake replay preserves row, terminal outcome and destination', () => {
  const db = database(); const input = candidate(); const id = recordAutomaticMemoryCandidate(input, db);
  const saved = commitAutomaticMemoryDecision({ ...claim(db, id), decision: decision() }, db);
  assert.equal(saved.status, 'committed');
  db.prepare("UPDATE memory_reflection_candidates SET status = 'promoted', reason = 'retained outcome' WHERE id = ?").run(id);
  assert.equal(recordAutomaticMemoryCandidate(input, db), id);
  const row = readAutomaticMemoryCandidate(id, db); assert.equal(row.status, 'valid');
  if (row.status === 'valid') { assert.equal(row.row.status, 'promoted'); assert.equal(row.row.reason, 'retained outcome'); assert.deepEqual(row.envelope.decision, decision()); }
});
test('replayed same source with changed kind, context or owner bytes cannot mint replacement', () => {
  const db = database(); const id = recordAutomaticMemoryCandidate(candidate(), db);
  for (const mode of ['kind', 'context', 'text'] as const) {
    const value = originInput();
    if (mode === 'kind') value.candidate.kind = 'constraint';
    if (mode === 'context') value.source.context!.memoryScope.projectId = 'project-B';
    if (mode === 'text') value.source.ownerText += ' New source text';
    assert.throws(() => recordAutomaticMemoryCandidate(candidate(value), db), /conflicts/);
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memory_reflection_candidates').get() as { n: number }).n, 1);
  assert.equal(readAutomaticMemoryCandidate(id, db).status, 'valid');
});
test('batch identity distinguishes repeated clauses but freezes the original extraction set', () => {
  const db = database();
  const second = originInput({ start: ownerText.indexOf('For everywhere'), end: ownerText.length });
  const inputs = [candidate(), candidate(second)];
  const ids = recordAutomaticMemoryCandidates(inputs, db);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(recordAutomaticMemoryCandidates([...inputs].reverse(), db), [...ids].reverse());
  assert.throws(() => recordAutomaticMemoryCandidates([inputs[0]!], db), /extraction changed/);
  const changed = originInput({ start: 4, end: inputs[0]!.origin.claim.end });
  assert.throws(() => recordAutomaticMemoryCandidates([candidate(changed), inputs[1]!], db), /conflicts/);
  assert.throws(() => recordAutomaticMemoryCandidates([inputs[0]!, inputs[0]!], db), /claim identities/);
});
test('claimed decision is single-assignment and rejects changed decisions', () => {
  const db = database(); const id = recordAutomaticMemoryCandidate(candidate(), db); const owner = claim(db, id);
  assert.equal(commitAutomaticMemoryDecision({ ...owner, decision: decision() }, db).status, 'committed');
  assert.equal(commitAutomaticMemoryDecision({ ...owner, decision: decision() }, db).status, 'replayed');
  assert.equal(commitAutomaticMemoryDecision({ ...owner, decision: { ...decision(), destination: 'everywhere' } }, db).status, 'conflict');
  const wrong = { ...owner, originDigest: 'c'.repeat(64) };
  assert.equal(commitAutomaticMemoryDecision({ ...wrong, decision: decision() }, db).status, 'conflict');
});
test('stale processing owner cannot decide or use a newer lease even with same timestamp', () => {
  const db = database(); const id = recordAutomaticMemoryCandidate(candidate(), db); const stale = claim(db, id);
  db.prepare('UPDATE memory_reflection_candidates SET attempt_count = 2 WHERE id = ?').run(id);
  assert.equal(commitAutomaticMemoryDecision({ ...stale, decision: decision() }, db).status, 'lost_ownership');
  assert.equal(readOwnedAutomaticMemoryDecision(stale, db).status, 'lost_ownership');
  const next = { ...stale, claim: { ...stale.claim, attemptCount: 2 } };
  assert.equal(commitAutomaticMemoryDecision({ ...next, decision: decision() }, db).status, 'committed');
  db.prepare("UPDATE memory_reflection_candidates SET status = 'rejected' WHERE id = ?").run(id);
  assert.equal(readOwnedAutomaticMemoryDecision(next, db).status, 'lost_ownership');
});
test('unknown legacy candidate cannot acquire a decision or be silently upgraded by replay', () => {
  const db = database(); const input = candidate();
  const id = recordAutomaticMemoryCandidate(input, db);
  const owner = claim(db, id);
  db.prepare('UPDATE memory_reflection_candidates SET destination_json = NULL WHERE id = ?').run(id);
  assert.equal(commitAutomaticMemoryDecision({ ...owner, decision: decision() }, db).status, 'legacy');
  assert.throws(() => recordAutomaticMemoryCandidate(input, db), /conflicts/);
});
test('corrupt destination or row-origin mismatch cannot be read as positive scope', () => {
  const db = database(); const id = recordAutomaticMemoryCandidate(candidate(), db);
  const row = readAutomaticMemoryCandidate(id, db); assert.equal(row.status, 'valid');
  if (row.status !== 'valid') throw new Error('fixture');
  db.prepare('UPDATE memory_reflection_candidates SET text = ? WHERE id = ?').run('different meaning', id);
  assert.equal(readAutomaticMemoryCandidate(id, db).status, 'conflict');
  db.prepare('UPDATE memory_reflection_candidates SET text = ?, destination_json = ? WHERE id = ?').run(row.row.text, '{"version":100}', id);
  assert.equal(readAutomaticMemoryCandidate(id, db).status, 'conflict');
});
test('frozen source and decision survive database close/reopen without ambient session lookup', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-destination-')); dirs.push(dir);
  const file = path.join(dir, 'memory.db'); let db = database(file);
  const input = candidate(); const id = recordAutomaticMemoryCandidate(input, db); const owner = claim(db, id);
  assert.equal(commitAutomaticMemoryDecision({ ...owner, decision: decision() }, db).status, 'committed');
  db.close(); db = database(file);
  const found = readAutomaticMemoryCandidate(id, db); assert.equal(found.status, 'valid');
  if (found.status === 'valid') {
    assert.equal(found.envelope.originDigest, automaticMemoryOriginDigest(input.origin));
    assert.deepEqual(parseAutomaticMemoryEnvelope(found.row.destination_json).decision, decision());
    assert.equal(recordAutomaticMemoryCandidate(input, db), id);
  }
});
