import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-source-usage-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const log = await import('./harness/eventlog.js');
const { recordModelUsage, withModelUsageAttribution } = await import('./usage-log.js');
const { readAcceptedSourceUsage } = await import('./accepted-source-usage.js');
after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

function source(sessionId: string) {
  if (!log.getSession(sessionId)) log.createSession({ id: sessionId, kind: 'chat' });
  const event = log.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'recorded fixture' } });
  return { sessionId, sourceUserSeq: event.seq };
}
function record(owner: ReturnType<typeof source>, extra: Partial<Parameters<typeof recordModelUsage>[0]> = {}) {
  recordModelUsage({ ...owner, model: 'fixture-usage', cacheDialect: 'inclusive',
    inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, durationMs: 25, ...extra });
}

test('actual usage writer keeps one task total through attempts, roles and database reopen', () => {
  const first = source('source-total');
  const other = source(first.sessionId);
  record(first, { attemptId: 'physical-one', role: 'brain' });
  record(other, { inputTokens: 10_000, role: 'brain' });
  record(first, { attemptId: 'physical-two', role: 'reviewer' });
  log.closeEventLog();
  record(first, { attemptId: 'physical-three', role: 'router', cacheDialect: 'exclusive',
    inputTokens: 20, cachedInputTokens: 80, outputTokens: 10 });
  const usage = readAcceptedSourceUsage(first)!;
  assert.deepEqual(usage.totals, { calls: 3, failedCalls: 0, uncertifiedCalls: 0, unknownCostCalls: 0,
    promptTokens: 300, cachedReadTokens: 240, uncachedWorkTokens: 90, outputTokens: 30,
    reportedTotalTokens: 250, modelMs: 75 });
  assert.deepEqual(Object.keys(usage.byRole), ['brain', 'reviewer', 'router']);
  assert.equal(readAcceptedSourceUsage(other)!.totals.calls, 1);
  assert.equal(usage.sourcePredatesMetering, false);
});

test('parent attribution applies only when the request has no exact owner of its own', () => {
  const parent = source('usage-parent');
  const child = source('usage-child');
  withModelUsageAttribution({ ...parent, role: 'brain' }, () => record(child, { role: 'worker' }));
  withModelUsageAttribution({ sessionId: 'memory-job', sourceUserSeq: 0, role: 'memory', usageParentTurn: parent }, () =>
    recordModelUsage({ sessionId: 'memory-job', model: 'fixture-memory', cacheDialect: 'none', inputTokens: 20, outputTokens: 5 }));
  assert.equal(readAcceptedSourceUsage(parent)!.totals.calls, 1);
  assert.equal(readAcceptedSourceUsage(parent)!.byRole.memory!.uncachedWorkTokens, 25);
  assert.equal(readAcceptedSourceUsage(child)!.byRole.worker!.calls, 1);
  assert.equal(readAcceptedSourceUsage({ sessionId: parent.sessionId, sourceUserSeq: child.sourceUserSeq }), null);
});

test('unknown, failed, and cached usage preserve their distinct meanings', () => {
  const owner = source('usage-quality');
  record(owner, { cacheDialect: 'unknown' });
  record(owner, { ok: false, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  record(owner, { ok: false, inputTokens: 20, cachedInputTokens: 0, outputTokens: 2 });
  const totals = readAcceptedSourceUsage(owner)!.totals;
  assert.equal(totals.calls, 3);
  assert.equal(totals.failedCalls, 2);
  assert.equal(totals.uncertifiedCalls, 2, 'a failed zero placeholder is also uncertified');
  assert.equal(totals.unknownCostCalls, 1, 'no reported cost on a failed call does not prove zero cost');
  assert.equal(totals.uncachedWorkTokens, 132, 'undeclared cache accounting is charged conservatively');
});

test('a source from before the meter is labeled partial instead of inventing a complete baseline', () => {
  const owner = source('usage-before-upgrade');
  const previous = log.openEventLog().prepare('SELECT applied_at FROM schema_version WHERE version = 84').get() as { applied_at: string };
  log.openEventLog().prepare('UPDATE schema_version SET applied_at = ? WHERE version = 84').run('9999-01-01T00:00:00.000Z');
  try {
    record(owner);
    assert.equal(readAcceptedSourceUsage(owner)!.sourcePredatesMetering, true);
  } finally {
    log.openEventLog().prepare('UPDATE schema_version SET applied_at = ? WHERE version = 84').run(previous.applied_at);
  }
});

test('a failed request can still report cached work without pretending its usage is missing', () => {
  const owner = source('usage-failed-cache');
  record(owner, { ok: false, cacheDialect: 'exclusive', inputTokens: 0, outputTokens: 0, cachedInputTokens: 80 });
  const totals = readAcceptedSourceUsage(owner)!.totals;
  assert.equal(totals.failedCalls, 1);
  assert.equal(totals.unknownCostCalls, 0);
  assert.equal(totals.cachedReadTokens, 80);
});

test('a sessionless or mismatched request never borrows the latest accepted source', () => {
  const one = source('usage-correct-owner');
  source('usage-other-owner');
  record({ sessionId: 'usage-other-owner', sourceUserSeq: one.sourceUserSeq });
  recordModelUsage({ sessionId: one.sessionId, model: 'fixture-without-source', inputTokens: 1000, outputTokens: 30 });
  assert.equal(readAcceptedSourceUsage(one)!.totals.calls, 0);
});

test('deleting the owning session removes only its usage projection', () => {
  const owner = source('usage-delete');
  const keep = source('usage-keep');
  record(owner); record(keep);
  log.openEventLog().prepare('DELETE FROM sessions WHERE id = ?').run(owner.sessionId);
  assert.equal(readAcceptedSourceUsage(owner), null);
  assert.equal(readAcceptedSourceUsage(keep)!.totals.calls, 1);
  assert.equal(log.openEventLog().prepare('SELECT COUNT(*) AS n FROM accepted_source_usage_v1 WHERE session_id = ?')
    .get(owner.sessionId)?.n, 0);
});

test('rehearsing the new migration preserves reported usage and accepted-source references', async () => {
  const owner = source('usage-migration');
  record(owner);
  const db = log.openEventLog();
  const before = db.prepare('SELECT * FROM accepted_source_usage_v1 ORDER BY session_id, source_user_seq, role').all();
  db.prepare('DELETE FROM schema_version WHERE version = 84').run();
  const { applyHarnessMigrations } = await import('./harness/eventlog-schema.js');
  applyHarnessMigrations(db);
  assert.deepEqual(db.prepare('SELECT * FROM accepted_source_usage_v1 ORDER BY session_id, source_user_seq, role').all(), before);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(readAcceptedSourceUsage(owner)!.totals.calls, 1);
});

test('an unavailable usage projection cannot turn a returned model response into an execution failure', () => {
  const owner = source('usage-observation-failure');
  const db = log.openEventLog();
  db.pragma('query_only = ON');
  try {
    assert.doesNotThrow(() => record(owner));
  } finally { db.pragma('query_only = OFF'); }
  assert.equal(readAcceptedSourceUsage(owner)!.totals.calls, 0, 'this projection is not a provider billing guarantee');
});
