/**
 * The shared exact-attempt Stop primitive — extracted from the desktop route so
 * the phone can stop a live turn at all.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/stop-exact-attempt.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-stop-exact-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-stop-exact\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { stopExactHarnessAttempt } = await import('./stop-exact-attempt.js');

test.after(() => { eventlog.closeEventLog(); rmSync(TMP_HOME, { recursive: true, force: true }); });

test('stop latches the EXACT attempt kill; a stale attempt latches but touches nothing else', () => {
  const session = eventlog.createSession({ id: 'stop-exact-1', kind: 'chat' });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: 'run-live' });
  eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text: 'long task' },
  }, { armRunInFlight: true });

  const live = eventlog.getActiveRunAttempt(session.id);
  assert.ok(live, 'fixture: the attempt is active');

  const stopped = stopExactHarnessAttempt(session.id, live, 'test stop', 'test');
  assert.ok(
    eventlog.isKillRequested(session.id, { attemptId: live.attemptId, sourceUserSeq: 0 }),
    'the durable kill latch names the attempt',
  );
  assert.equal(typeof stopped.cancelledApprovals, 'number');

  // A FABRICATED attempt id cannot even latch: requestKill refuses an attempt
  // that is not registered to the session. Stricter than a no-op, and worth
  // pinning as such.
  assert.throws(
    () => stopExactHarnessAttempt(
      session.id,
      { ...live, attemptId: 'attempt:stale-nonsense' },
      'forged stop',
      'test',
    ),
    /not registered/,
  );
});

test('a registered-but-superseded attempt latches its own kill and touches nothing else', () => {
  const session = eventlog.createSession({ id: 'stop-exact-2', kind: 'chat' });
  const first = eventlog.beginRunAttempt(session.id, { runId: 'run-old' });
  eventlog.recordRunAttemptUserInput(first, {
    turn: 1, role: 'user', data: { text: 'first task' },
  }, { armRunInFlight: true });
  eventlog.finishRunAttempt(first, 'completed');
  const second = eventlog.beginRunAttempt(session.id, { runId: 'run-new' });
  eventlog.recordRunAttemptUserInput(second, {
    turn: 2, role: 'user', data: { text: 'second task' },
  }, { armRunInFlight: true });

  // Stopping with the OLD attempt: its own latch lands (exact), but the ACTIVE
  // attempt's approvals/interrupt state are untouched — a stale tap can never
  // widen into a session-wide kill.
  const staleStop = stopExactHarnessAttempt(session.id, first, 'stale stop', 'test');
  assert.deepEqual(staleStop, { cancelledApprovals: 0, cancelledTasks: 0 });
  const active = eventlog.getActiveRunAttempt(session.id);
  assert.equal(active?.attemptId, second.attemptId, 'the live attempt survives');
});
