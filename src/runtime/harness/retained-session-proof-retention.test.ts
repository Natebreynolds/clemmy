/** No models or network: real task/context publication and bounded retention. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test, type TestContext } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-retained-proof-'));
Object.assign(process.env, { CLEMENTINE_HOME: fixtureHome, CLEMMY_TEST_ISOLATED_HOME: '1',
  MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true' });
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const log = await import('./eventlog.js');
const contexts = await import('./source-session-context.js');
const plans = await import('./plan-artifacts.js');
const branches = await import('./accepted-source-session-branch.js');
const schema = await import('./eventlog-schema.js');
const { withSessionProofCascade } = await import('./retained-session-proof-schema.js');
const { closeMemoryDb } = await import('../../memory/db.js');
beforeEach(() => log.resetEventLog());
after(() => { closeMemoryDb(); log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });
let serial = 0;
const OLD = '2020-01-01T00:00:00.000Z';
const principalId = 'retention-fixture-owner';
function session(metadata: Record<string, unknown> = {}) {
  const made = log.createSession({ id: `retained-proof-${++serial}`, kind: 'chat', userId: principalId,
    channel: 'mobile', metadata: { source: 'mobile', channelId: 'retention-conversation', ...metadata } });
  return { sessionId: made.id, principalId };
}
function source(scope: ReturnType<typeof session>, mode: import('./task-mode.js').TaskMode = { version: 1, kind: 'normal' }) {
  const event = log.appendEvent({ sessionId: scope.sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Inspect the controlled retained task.', userId: principalId, taskMode: mode } });
  return { ...scope, sourceUserSeq: event.seq };
}
function context(scope = session()) {
  const input = source(scope);
  const retained = contexts.captureFreshSourceSessionContext(input);
  assert.ok(retained);
  return { ...input, retained };
}
function child(parent: ReturnType<typeof context>) {
  return context(session({ source: 'delegated_worker', workerScope: true,
    parentSessionId: parent.sessionId, parentSourceUserSeq: parent.sourceUserSeq }));
}
function old(...ids: string[]) {
  const db = log.openEventLog();
  for (const id of ids) {
    log.updateSession(id, { status: 'completed' });
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(OLD, id);
    db.prepare('UPDATE harness_chat_requests SET created_at = ? WHERE session_id = ?').run(OLD, id);
  }
}
function publish(scope = session(), base?: import('./task-mode.js').PlanRevisionRef) {
  const input = source(scope, { version: 1, kind: 'plan' });
  const artifact = plans.publishPlanRevision({ ...input, fullText: 'Read the controlled local record.',
    readiness: 'ready', ...(base ? { base } : {}) });
  return { ...scope, artifact };
}
function ref(artifact: import('./task-mode.js').PlanRevisionRef) {
  return { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
}
function successor(scope: ReturnType<typeof session>, t: TestContext) {
  log.updateSession(scope.sessionId, { status: 'failed' });
  // Record historical bindings through the real writer under a historical
  // clock. Their timestamps are authority and cannot be edited afterward.
  t.mock.timers.enable({ apis: ['Date'], now: new Date(OLD) });
  let next: ReturnType<typeof branches.selectSessionForAcceptedSource>;
  try {
    next = branches.selectSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: scope.sessionId,
      durableSourceId: `retention-successor-${++serial}`, continuity: {
        provider: 'mobile', scopeId: null, conversationId: 'retention-conversation', audienceId: principalId,
      } });
  } finally { t.mock.timers.reset(); }
  assert.equal(next.disposition, 'branched');
  return { sessionId: next.sessionId, principalId };
}
function claim(scope: ReturnType<typeof session>, artifact: import('./task-mode.js').PlanRevisionRef) {
  const executeRef = ref(artifact);
  const input = { ...source(scope, { version: 1, kind: 'execute', executeRef }), executeRef };
  return { input, result: plans.claimPlanExecution(input) };
}
function count(table: string) {
  return (log.openEventLog().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test('expired source context reaps with its session; direct proof and event deletion stay prohibited', () => {
  const task = context();
  const db = log.openEventLog();
  assert.throws(() => db.prepare('DELETE FROM source_session_contexts_v1 WHERE session_id = ?').run(task.sessionId), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM events WHERE seq = ?').run(task.sourceUserSeq), /FOREIGN KEY/);
  old(task.sessionId);
  assert.equal(log.reapStaleSessions(14), 1);
  assert.equal(log.getSession(task.sessionId), null);
  assert.equal(count('source_session_contexts_v1'), 0);
});

test('a surviving grandchild keeps both ancestors; the whole expired context chain later reaps atomically', () => {
  const parent = context();
  const worker = child(parent);
  const grandchild = child(worker);
  old(parent.sessionId, worker.sessionId);
  assert.equal(log.reapStaleSessions(14), 0);
  assert.equal(log.sessionHasAcceptedSourceReplayBinding(parent.sessionId), true);
  assert.throws(() => log.openEventLog().prepare('DELETE FROM sessions WHERE id = ?').run(parent.sessionId), /FOREIGN KEY/);
  log.closeEventLog();
  assert.deepEqual(contexts.readSourceSessionContext(grandchild, grandchild.retained.digest)?.memoryScope, parent.retained.memoryScope);
  old(grandchild.sessionId);
  assert.equal(log.reapStaleSessions(14), 3);
  assert.equal(count('source_session_contexts_v1'), 0);
});

test('deferred session cascade still rejects a surviving proof consumer and restores the constraint mode', () => {
  const parent = context();
  const worker = child(parent);
  const db = log.openEventLog();
  assert.throws(() => db.transaction(() => withSessionProofCascade(db, () =>
    db.prepare('DELETE FROM sessions WHERE id = ?').run(parent.sessionId)))(), /FOREIGN KEY/);
  assert.equal(db.pragma('defer_foreign_keys', { simple: true }), 0);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.ok(contexts.readSourceSessionContext(worker, worker.retained.digest));
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.throws(() => db.transaction(() => withSessionProofCascade(db, () =>
    db.prepare('DELETE FROM source_session_contexts_v1 WHERE session_id = ?').run(worker.sessionId)))(), /immutable/);
  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    withSessionProofCascade(db, () => db.prepare('DELETE FROM sessions WHERE id IN (?, ?)').run(parent.sessionId, worker.sessionId));
    assert.equal(db.pragma('defer_foreign_keys', { simple: true }), 1, 'restore an already deferred caller');
  })();
  assert.equal(count('source_session_contexts_v1'), 0);
});

test('a pinned or archived child retains its expired parent proof', () => {
  for (const flag of ['pinned', 'archived']) {
    const parent = context();
    const worker = child(parent);
    old(parent.sessionId, worker.sessionId);
    log.updateSession(worker.sessionId, { metadata: { ...log.getSession(worker.sessionId)!.metadata, [flag]: true } });
    log.openEventLog().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(OLD, worker.sessionId);
    assert.equal(log.reapStaleSessions(14), 0);
    assert.ok(contexts.readSourceSessionContext(worker, worker.retained.digest));
  }
});

test('hard-delete archives a needed parent, preserving the surviving child through the real session API', async () => {
  const { deleteUnifiedSession } = await import('../../dashboard/sessions-api.js');
  const parent = context();
  const worker = child(parent);
  const result = deleteUnifiedSession(`harness:${parent.sessionId}`, true);
  assert.equal(result?.ok, true);
  assert.equal(result?.mode, 'archived');
  assert.equal(result?.retainedForReplay, true);
  assert.equal(log.getSession(parent.sessionId)?.metadata.archived, true);
  log.closeEventLog();
  assert.equal(contexts.readSourceSessionContext(worker, worker.retained.digest)?.digest, worker.retained.digest);
  old(parent.sessionId);
  assert.equal(log.reapStaleSessions(14), 0);
  old(worker.sessionId);
  assert.equal(log.reapStaleSessions(14), 2);
});

test('hard-delete removes an unreferenced context and its session through the real session API', async () => {
  const { deleteUnifiedSession } = await import('../../dashboard/sessions-api.js');
  const task = context();
  assert.equal(deleteUnifiedSession(`harness:${task.sessionId}`, true)?.mode, 'deleted');
  assert.equal(log.getSession(task.sessionId), null);
  assert.equal(count('source_session_contexts_v1'), 0);
});

test('expired reviewed plan, claim, observer and composition delete with one session', () => {
  const task = publish();
  const execution = claim(task, task.artifact);
  contexts.captureFreshSourceSessionContext(execution.input);
  old(task.sessionId);
  assert.equal(log.reapStaleSessions(14), 1);
  for (const table of ['reviewed_plan_revisions_v1', 'reviewed_plan_execution_claims_v1',
    'reviewed_plan_execution_observers_v1', 'source_session_contexts_v1']) assert.equal(count(table), 0, table);
});

test('a later reviewed revision retains its base session until both expire', t => {
  const parent = publish();
  const next = publish(successor(parent, t), ref(parent.artifact));
  old(parent.sessionId);
  assert.equal(log.reapStaleSessions(14), 0);
  assert.equal(plans.getPlanRevision({ ...next, ref: ref(parent.artifact) }).digest, parent.artifact.digest);
  old(next.sessionId);
  assert.equal(log.reapStaleSessions(14), 2);
  assert.equal(count('reviewed_plan_revisions_v1'), 0);
});

test('a surviving Execute observer retains the original execution and planning sessions transitively', t => {
  const parent = publish();
  const executing = successor(parent, t);
  const first = claim(executing, parent.artifact);
  const observing = successor(executing, t);
  const joined = claim(observing, parent.artifact);
  assert.equal(joined.result.joinedExistingSource, true);
  assert.equal(joined.result.claim.claimId, first.result.claim.claimId);
  old(parent.sessionId, executing.sessionId);
  assert.equal(log.reapStaleSessions(14), 0);
  log.closeEventLog();
  assert.equal(plans.claimPlanExecution(joined.input).claim.claimId, first.result.claim.claimId);
  old(observing.sessionId);
  assert.equal(log.reapStaleSessions(14), 3);
  assert.equal(count('reviewed_plan_execution_claims_v1'), 0);
});

test('a failed final session delete rolls back every earlier cascade', () => {
  const task = publish();
  claim(task, task.artifact);
  const other = context();
  old(task.sessionId, other.sessionId);
  const db = log.openEventLog();
  db.exec(`CREATE TRIGGER fixture_retention_failure BEFORE DELETE ON sessions
    WHEN OLD.id = '${other.sessionId}' BEGIN SELECT RAISE(ABORT, 'controlled delete failure'); END`);
  assert.throws(() => log.reapStaleSessions(14), /controlled delete failure/);
  assert.equal(count('reviewed_plan_execution_claims_v1'), 1);
  assert.equal(count('source_session_contexts_v1'), 1);
  assert.ok(log.getSession(task.sessionId));
  assert.ok(log.getSession(other.sessionId));
  db.exec('DROP TRIGGER fixture_retention_failure');
  assert.equal(log.reapStaleSessions(14), 2);
});

/** Historical v82 storage shape, used only to rehearse the real migration.
 * Existing public APIs create all data first. No execution proof is invented. */
function downgradeProofTablesToV82() {
  const db = log.openEventLog();
  const tables: Array<[string, string]> = [
    ['reviewed_plan_execution_observers_v1', 'session_id, source_user_seq, claim_id, source_digest'],
    ['reviewed_plan_execution_claims_v1', 'claim_id, plan_id, revision, session_id, source_user_seq, claim_json, event_id'],
    ['reviewed_plan_revisions_v1', 'plan_id, revision, digest, session_id, source_user_seq, principal_id, artifact_json, event_id'],
    ['source_session_contexts_v1', 'session_id, source_user_seq, identity_json, identity_digest'],
  ];
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const [table, columns] of tables) {
        const oldSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
        // Strip only the new generated references/session cascade to reproduce
        // the former restrictive FKs. Keep old immutable-delete semantics.
        let body = oldSql.slice(oldSql.indexOf('(')).replaceAll(' ON DELETE CASCADE', '')
          .replace(/\n\s*(?:base_plan_id|base_revision|parent_session_id|parent_source_user_seq)[^\n]*,?/g, '')
          .replace(/,\s*FOREIGN KEY\(base_plan_id, base_revision\) REFERENCES reviewed_plan_revisions_v1\(plan_id, revision\)/, '')
          .replace(/,\s*FOREIGN KEY\(parent_session_id, parent_source_user_seq\) REFERENCES source_session_contexts_v1\(session_id, source_user_seq\)/, '');
        if (table === 'source_session_contexts_v1') {
          body = body.replace('session_id TEXT NOT NULL REFERENCES sessions(id)', 'session_id TEXT NOT NULL');
        }
        db.exec(`CREATE TABLE ${table}_old ${body}; INSERT INTO ${table}_old (${columns}) SELECT ${columns} FROM ${table};
          DROP TABLE ${table}; ALTER TABLE ${table}_old RENAME TO ${table};
          CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable'); END;
          CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable'); END;`);
      }
      db.prepare('DELETE FROM schema_version WHERE version = 83').run();
    })();
  } finally { db.pragma('foreign_keys = ON'); }
}

test('v83 migration preserves exact plan, claim and nested context bytes, then permits bounded retention', () => {
  const task = publish();
  const execution = claim(task, task.artifact);
  const parentContext = contexts.captureFreshSourceSessionContext(execution.input)!;
  const worker = child({ ...execution.input, retained: parentContext });
  const stored = () => ['reviewed_plan_revisions_v1', 'reviewed_plan_execution_claims_v1',
    'reviewed_plan_execution_observers_v1', 'source_session_contexts_v1'].map(table => {
    // Hidden/generated fields are derived; compare every original persisted byte.
    const columns = (log.openEventLog().pragma(`table_xinfo(${table})`) as Array<{ name: string; hidden: number }>)
      .filter(column => column.hidden === 0).map(column => column.name).join(', ');
    return log.openEventLog().prepare(`SELECT ${columns} FROM ${table} ORDER BY 1, 2`).all();
  });
  const before = stored();
  downgradeProofTablesToV82();
  old(task.sessionId, worker.sessionId);
  assert.throws(() => log.reapStaleSessions(14), /no such column|FOREIGN KEY/);
  schema.applyHarnessMigrations(log.openEventLog());
  assert.deepEqual(stored(), before);
  schema.applyHarnessMigrations(log.openEventLog());
  log.closeEventLog();
  assert.deepEqual(stored(), before, 'migration is stable on re-entry and reopen');
  assert.equal(plans.claimPlanExecution(execution.input).claim.digest, execution.result.claim.digest);
  assert.equal(contexts.readSourceSessionContext(worker, worker.retained.digest)?.digest, worker.retained.digest);
  assert.equal(log.openEventLog().pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(log.openEventLog().pragma('foreign_key_check'), []);
  assert.equal(log.reapStaleSessions(14), 2);
});

test('a missing legacy proof parent aborts migration and restores the original schema and payload', () => {
  const task = publish();
  claim(task, task.artifact);
  const parent = context();
  const worker = child(parent);
  downgradeProofTablesToV82();
  const db = log.openEventLog();
  db.exec('DROP TRIGGER source_session_contexts_v1_no_update');
  db.prepare("UPDATE source_session_contexts_v1 SET identity_json = json_set(identity_json, '$.parent.sessionId', 'missing-parent') WHERE session_id = ?")
    .run(worker.sessionId);
  const before = db.prepare('SELECT identity_json FROM source_session_contexts_v1 WHERE session_id = ?').get(worker.sessionId);
  assert.throws(() => schema.applyHarnessMigrations(db), /integrity checks/);
  assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v, 82);
  assert.deepEqual(db.prepare('SELECT identity_json FROM source_session_contexts_v1 WHERE session_id = ?').get(worker.sessionId), before);
  assert.equal((db.pragma('table_xinfo(source_session_contexts_v1)') as Array<{ name: string }>).some(row => row.name === 'parent_session_id'), false);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});
