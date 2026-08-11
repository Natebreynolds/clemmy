import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';
import { deleteSmokeHarnessSession } from './smoke-harness-cleanup.js';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-smoke-cleanup-'));
process.env.CLEMENTINE_HOME = testHome;

const eventlog = await import('../src/runtime/harness/eventlog.js');
const dispatchLease = await import('../src/runtime/harness/dispatch-lease.js');
const databasePath = path.join(testHome, 'state', 'harness.db');

after(() => {
  eventlog.closeEventLog();
  rmSync(testHome, { recursive: true, force: true });
});

function seedCompletedSession(sessionId: string): void {
  const session = eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'cli' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'throwaway smoke fixture' },
  });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `${session.id}:run` });
  eventlog.bindRunAttemptSourceUserEvent(attempt, source.seq);
  const root = dispatchLease.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::root`,
    runAttemptId: attempt.attemptId,
  });
  const child = dispatchLease.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::child`,
    runAttemptId: attempt.attemptId,
    parentLease: root,
  });
  dispatchLease.revokeDispatchLease(child);
  dispatchLease.revokeDispatchLease(root);
  eventlog.finishRunAttempt(attempt, 'completed');
  eventlog.updateSession(session.id, { status: 'completed' });
}

test('dev and goal smoke cleanup remove parent sessions through exact FK cascades', () => {
  const devSessionId = 'console:fixture-smoke';
  const goalSessionId = 'goal-resume-live-fixture';
  seedCompletedSession(devSessionId);
  seedCompletedSession(goalSessionId);
  eventlog.closeEventLog();

  const cleanupSql = readFileSync(
    new URL('./dev-clean-harness-sessions.sql', import.meta.url),
    'utf8',
  );
  assert.match(cleanupSql, /PRAGMA\s+foreign_keys\s*=\s*ON/i);
  assert.match(cleanupSql, /DELETE\s+FROM\s+sessions/i);
  assert.doesNotMatch(cleanupSql, /DELETE\s+FROM\s+events/i);

  const cliShape = new Database(databasePath);
  cliShape.pragma('foreign_keys = OFF');
  assert.equal(cliShape.pragma('foreign_keys', { simple: true }), 0, 'fixture models sqlite3 CLI default');
  cliShape.exec(cleanupSql);
  assert.equal(cliShape.pragma('foreign_keys', { simple: true }), 1, 'cleanup turns FK enforcement on');
  cliShape.close();

  assert.equal(deleteSmokeHarnessSession(databasePath, goalSessionId), 1);

  const inspected = new Database(databasePath, { readonly: true, fileMustExist: true });
  for (const table of ['sessions', 'events', 'run_attempts', 'run_dispatch_leases'] as const) {
    const row = inspected.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    assert.equal(row.count, 0, `${table} must leave through the parent-session cascade`);
  }
  const foreignKeyViolations = inspected.prepare(
    'SELECT COUNT(*) AS count FROM pragma_foreign_key_check',
  ).get() as { count: number };
  assert.equal(foreignKeyViolations.count, 0);
  inspected.close();
});

test('live-smoke scripts delegate cleanup and never delete event rows directly', () => {
  for (const relative of ['./smoke-goal-resume-live.ts', './smoke-goal-reorient-live.ts']) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.match(source, /deleteSmokeHarnessSession\(/);
    assert.doesNotMatch(source, /DELETE\s+FROM\s+events/i);
    assert.doesNotMatch(source, /DELETE\s+FROM\s+sessions/i);
  }
});
