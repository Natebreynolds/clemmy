import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-exact-learning-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
const log = await import('./eventlog.js');
const { acceptedTaskIdFor } = await import('./attempt-identity.js');
const { canonicalVerifiedReadReceipt, verifiedReadOriginMatchesAliasDigest } =
  await import('../read-path/verified-read-origin-authority.js');
const { acceptedPhraseDigest } = await import('../../memory/capability-alias-index.js');
const { resolveAcceptedSource } = await import('../../memory/verified-read-learning.js');
const { applyHarnessMigrations } = await import('./eventlog-schema.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

test.beforeEach(() => log.resetEventLog());
test.after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const sid = 'exact-learning';
  log.createSession({ id: sid, kind: 'chat' });
  log.createSession({ id: 'other-owner', kind: 'chat' });
  const source = log.appendEvent({ sessionId: sid, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'Read my schedule' } });
  const receiptId = `rr_${'a'.repeat(32)}`;
  const origin = { version: 1 as const, sessionId: sid, sourceUserSeq: source.seq,
    receiptId, evidenceDigest: 'b'.repeat(24) };
  const record = { receiptId, at: new Date().toISOString(), provider: 'schedule',
    operation: 'read', identifier: 'ÉCHO_READ', effectClass: 'read',
    dispatchOutcome: 'succeeded', schemaFingerprint: 'schema-exact',
    scope: { tenant: 'tenant', workspace: 'workspace', accountIdentity: 'stable-account' },
    source: { sessionId: sid, sourceUserSeq: source.seq, attemptId: 'attempt-exact' },
    readEvidenceRef: `evt:${origin.evidenceDigest}` };
  const settle = (kind = 'succeeded', seq: unknown = source.seq, tool = 'écho_read') => log.appendEvent({
    sessionId: sid, turn: 1, role: 'system', type: 'tool_attempt_settled',
    data: { sourceUserSeq: seq, tool, acceptedTaskId: acceptedTaskIdFor(sid, source.seq),
      kind, dispatchState: 'dispatched', mutating: false, logicalToolCallId: 'logical-exact' },
  });
  const receipt = () => log.appendEvent({ sessionId: sid, turn: 1, role: 'system',
    type: 'read_receipt', data: { record } });
  return { sid, source, origin, record, settle, receipt };
}

test('canonical receipt keeps exact scope, Unicode matching, latest failure and receipt cutoff', () => {
  const f = fixture();
  const success = f.settle();
  const receipt = f.receipt();
  // A later failure does not belong to the earlier receipt.
  f.settle('failed');
  assert.equal(log.getLatestToolAttemptSettlementForSource(f.sid, f.source.seq, 'ÉCHO_READ', receipt.seq)?.seq, success.seq);
  assert.deepEqual(canonicalVerifiedReadReceipt({ origin: f.origin, identifier: 'ÉCHO_READ',
    accountIdentity: 'stable-account', schemaFingerprint: 'schema-exact' }), f.record);
  assert.equal(canonicalVerifiedReadReceipt({ origin: f.origin, identifier: 'ÉCHO_READ', accountIdentity: 'other' }), null);
  assert.equal(canonicalVerifiedReadReceipt({ origin: f.origin, identifier: 'ÉCHO_READ', schemaFingerprint: 'stale' }), null);
  assert.equal(canonicalVerifiedReadReceipt({ origin: { ...f.origin, sourceUserSeq: f.source.seq + 1 }, identifier: 'ÉCHO_READ' }), null);

  const g = fixtureAfterReset();
  g.settle();
  const failure = g.settle('failed');
  // String sequence values cannot overwrite a numeric accepted-source proof.
  g.settle('succeeded', String(g.source.seq));
  assert.equal(g.source.seq, 1);
  g.settle('succeeded', true); // SQLite JSON true is 1; the source is still not numeric.
  const afterFailure = g.receipt();
  assert.equal(log.getLatestToolAttemptSettlementForSource(g.sid, g.source.seq, 'ÉCHO_READ', afterFailure.seq)?.seq, failure.seq);
  assert.equal(canonicalVerifiedReadReceipt({ origin: g.origin, identifier: 'ÉCHO_READ' }), null);
});

function fixtureAfterReset() { log.resetEventLog(); return fixture(); }

test('duplicate receipts remain ambiguous and the identity lookup returns only two witnesses', () => {
  const f = fixture();
  f.settle();
  const first = f.receipt();
  const second = f.receipt();
  f.receipt();
  assert.deepEqual(log.listReadReceiptEventsForId(f.sid, f.origin.receiptId).map(e => e.seq), [first.seq, second.seq]);
  assert.equal(canonicalVerifiedReadReceipt({ origin: f.origin, identifier: 'ÉCHO_READ' }), null);
  assert.equal(log.listReadReceiptEventsForId('other-owner', f.origin.receiptId).length, 0);
  assert.equal(log.listReadReceiptEventsForId(f.sid, 'missing').length, 0);
});

test('exact source and receipt lookups do not hydrate unrelated history, or coerce non-text input', () => {
  const f = fixture();
  f.settle();
  const first = f.receipt();
  const second = f.receipt();
  assert.equal(f.source.seq, 1);
  log.appendEvent({ sessionId: f.sid, turn: 1, role: 'system', type: 'read_receipt', data: {
    record: { ...f.record, receiptId: 'boolean-source', source: { ...f.record.source, sourceUserSeq: true } },
  } });
  const db = log.openEventLog();
  // Parsing unrelated historical bodies is unnecessary. A parser sentinel
  // makes that regression fail independently of benchmark timing.
  db.prepare(`INSERT INTO events(id, session_id, turn, role, type, data_json, created_at)
    VALUES ('unrelated-history', ?, 1, 'system', 'tool_returned', ?, ?)`).run(f.sid,
      JSON.stringify({ unused: 'UNRELATED_HISTORY'.repeat(1024) }), new Date().toISOString());
  const originalParse = JSON.parse;
  JSON.parse = (text, reviver) => {
    assert.ok(!String(text).includes('UNRELATED_HISTORY'), 'unrelated historical body was hydrated');
    return originalParse(text, reviver);
  };
  try {
    assert.deepEqual(resolveAcceptedSource(f.sid, f.source.seq), { sourceUserSeq: f.source.seq, phrase: 'Read my schedule' });
    assert.equal(log.getUserInputEventAtSequence('other-owner', f.source.seq), undefined);
    assert.equal(log.getUserInputEventAtSequence(f.sid, first.seq), undefined);
    for (const invalid of [0, -1, 1.5, NaN, Infinity]) assert.equal(log.getUserInputEventAtSequence(f.sid, invalid), undefined);
    assert.deepEqual(log.listReadReceiptEventsForSource(f.sid, f.source.seq).map(e => e.seq), [second.seq, first.seq]);
    assert.equal(verifiedReadOriginMatchesAliasDigest(f.origin, acceptedPhraseDigest('Read my schedule')), true);
  } finally { JSON.parse = originalParse; }
  const invalidSource = log.appendEvent({ sessionId: f.sid, turn: 2, role: 'user', type: 'user_input_received', data: { text: 123 } });
  assert.equal(verifiedReadOriginMatchesAliasDigest({ ...f.origin, sourceUserSeq: invalidSource.seq }, acceptedPhraseDigest('123')), false);
});

test('actual lookup queries use receipt/source indexes and the sequence primary key without table scans', () => {
  const f = fixture();
  f.settle();
  const receipt = f.receipt();
  // A fresh connection avoids previously prepared-query cache entries.
  log.closeEventLog();
  const db = log.openEventLog();
  const original = db.prepare;
  const sqls: string[] = [];
  db.prepare = function (sql: string) { sqls.push(sql); return original.call(this, sql); } as typeof db.prepare;
  try {
    log.listReadReceiptEventsForId(f.sid, f.origin.receiptId);
    log.listReadReceiptEventsForSource(f.sid, f.source.seq);
    log.getUserInputEventAtSequence(f.sid, f.source.seq);
    log.getLatestToolAttemptSettlementForSource(f.sid, f.source.seq, 'ÉCHO_READ', receipt.seq);
  } finally { db.prepare = original; }
  const queries = sqls.filter(sql => sql.includes('SELECT * FROM events'));
  assert.equal(queries.length, 4);
  for (const sql of queries) {
    const [params, expected] = sql.includes('record.receiptId')
      ? [[f.sid, f.origin.receiptId], 'idx_events_read_receipt_identity_v1']
      : sql.includes('record.source.sourceUserSeq')
        ? [[f.sid, f.source.seq], 'idx_events_read_receipt_source_v1']
        : sql.includes('tool_attempt_settled')
          ? [[f.sid, f.source.seq, receipt.seq], 'idx_events_read_settlement_source_v1']
          : [[f.source.seq, f.sid], 'INTEGER PRIMARY KEY'];
    const plan = JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
    assert.ok(plan.includes(expected), plan);
    assert.doesNotMatch(plan, /SCAN events|TEMP B-TREE/);
  }
});

test('v91 indexes preserve duplicate receipts, unrelated payloads and incomplete legacy records exactly', () => {
  const db = new Database(':memory:');
  try {
    log.applyHarnessMigrationsThroughVersionForTests(db, 90);
    db.prepare(`INSERT INTO sessions(id, kind, created_at, updated_at, status, metadata_json)
      VALUES ('legacy', 'chat', ?, ?, 'active', '{}')`).run('2026-10-01', '2026-10-01');
    const insert = db.prepare(`INSERT INTO events(id, session_id, turn, role, type, data_json, created_at)
      VALUES (?, 'legacy', 1, 'system', ?, ?, '2026-10-01')`);
    insert.run('receipt-one', 'read_receipt', '{"record":{"receiptId":"duplicate"}}');
    insert.run('receipt-two', 'read_receipt', '{"record":{"receiptId":"duplicate"}}');
    insert.run('incomplete-receipt', 'read_receipt', '{"record":null}');
    insert.run('unrelated', 'tool_returned', '{"payload":"unchanged history"}');
    const before = db.prepare('SELECT * FROM events ORDER BY seq').all();
    applyHarnessMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY seq').all(), before);
    assert.equal((db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version, HARNESS_SCHEMA_VERSION);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally { db.close(); }
});
