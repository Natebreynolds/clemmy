/**
 * Run: npx tsx --test src/runtime/harness/dispatch-lease-boot-reconcile.test.ts
 *
 * Causal coverage for the daemon-boot-only dispatch quarantine. The test uses
 * only the durable harness store: no model, tool registry, provider, or
 * physical-dispatch implementation participates.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-dispatch-boot-quarantine-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const dispatch = await import('./dispatch-lease.js');

test.after(() => {
  eventlog.closeEventLog();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('schema v68 appends a closed boot-quarantine reason without reinterpreting old revokes', () => {
  eventlog.resetEventLog();
  eventlog.closeEventLog();
  const historical = new Database(eventlog.HARNESS_DB_PATH);
  eventlog.applyHarnessMigrationsThroughVersionForTests(historical, 67);
  historical.exec(`
    INSERT INTO sessions
      (id, kind, channel, created_at, updated_at, status, metadata_json)
    VALUES
      ('v67-revoked-session', 'chat', 'desktop',
       '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z', 'active', '{}');
    INSERT INTO run_attempts
      (attempt_id, session_id, run_id, started_at, finished_at, status)
    VALUES
      ('v67-revoked-attempt', 'v67-revoked-session', 'v67-revoked-run',
       '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:01.000Z', 'completed');
    INSERT INTO run_dispatch_leases
      (scope_id, session_id, lease_id, run_attempt_id, activated_at, revoked_at)
    VALUES
      ('v67-revoked-scope', 'v67-revoked-session', 'v67-revoked-lease',
       'v67-revoked-attempt', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:01.000Z');
  `);
  historical.close();

  const migrated = eventlog.openEventLog();
  const columns = new Set(
    (migrated.prepare('PRAGMA table_info(run_dispatch_leases)').all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  assert.ok(columns.has('revocation_reason'));
  assert.deepEqual(
    migrated.prepare(`
      SELECT revoked_at, revocation_reason
        FROM run_dispatch_leases WHERE scope_id = 'v67-revoked-scope'
    `).get(),
    {
      revoked_at: '2026-08-27T00:00:01.000Z',
      revocation_reason: null,
    },
    'an already-revoked historical generation keeps its exact prior meaning',
  );
  assert.throws(
    () => migrated.prepare(`
      UPDATE run_dispatch_leases SET revocation_reason = 'provider_specific_guess'
       WHERE scope_id = 'v67-revoked-scope'
    `).run(),
    /CHECK constraint failed/,
    'the durable reason vocabulary is closed',
  );
});

test('boot quarantine revokes only exact terminal-attempt generations and is a fixed point', () => {
  eventlog.resetEventLog();
  const db = eventlog.openEventLog();
  const makeSession = (id: string, kind: 'chat' | 'execution' | 'workflow' | 'agent') =>
    eventlog.createSession({ id, kind, channel: kind === 'chat' ? 'desktop' : kind });

  const chat = makeSession('boot-quarantine-chat', 'chat');
  const chatAttempt = eventlog.beginRunAttempt(chat.id, { attemptId: 'attempt:boot-quarantine-chat' });
  const chatLease = dispatch.activateDispatchLease({
    sessionId: chat.id,
    scopeId: 'scope:boot-quarantine-chat',
    runAttemptId: chatAttempt.attemptId,
  });
  eventlog.finishRunAttempt(chatAttempt, 'completed');

  const workflow = makeSession('boot-quarantine-workflow', 'workflow');
  const workflowAttempt = eventlog.beginRunAttempt(workflow.id, {
    attemptId: 'attempt:boot-quarantine-workflow',
  });
  const workflowLease = dispatch.activateDispatchLease({
    sessionId: workflow.id,
    scopeId: 'scope:boot-quarantine-workflow',
    runAttemptId: workflowAttempt.attemptId,
  });
  eventlog.finishRunAttempt(workflowAttempt, 'interrupted');

  const active = makeSession('boot-quarantine-active', 'execution');
  const olderAttempt = eventlog.beginRunAttempt(active.id, { attemptId: 'attempt:boot-quarantine-older' });
  eventlog.finishRunAttempt(olderAttempt, 'completed');
  const activeAttempt = eventlog.beginRunAttempt(active.id, { attemptId: 'attempt:boot-quarantine-active' });
  const activeLease = dispatch.activateDispatchLease({
    sessionId: active.id,
    scopeId: 'scope:boot-quarantine-active',
    runAttemptId: activeAttempt.attemptId,
  });

  const crossOwner = makeSession('boot-quarantine-cross-owner', 'chat');
  const crossAttempt = eventlog.beginRunAttempt(crossOwner.id, {
    attemptId: 'attempt:boot-quarantine-cross-owner',
  });
  eventlog.finishRunAttempt(crossAttempt, 'failed');
  const crossLeaseSession = makeSession('boot-quarantine-cross-lease', 'agent');
  const crossSessionLease = dispatch.activateDispatchLease({
    sessionId: crossLeaseSession.id,
    scopeId: 'scope:boot-quarantine-cross-session',
    runAttemptId: crossAttempt.attemptId,
  });

  const unbound = makeSession('boot-quarantine-unbound', 'execution');
  const unboundLease = dispatch.activateDispatchLease({
    sessionId: unbound.id,
    scopeId: 'scope:boot-quarantine-unbound',
  });

  const alreadyRevoked = makeSession('boot-quarantine-already-revoked', 'workflow');
  const alreadyRevokedAttempt = eventlog.beginRunAttempt(alreadyRevoked.id, {
    attemptId: 'attempt:boot-quarantine-already-revoked',
  });
  const alreadyRevokedLease = dispatch.activateDispatchLease({
    sessionId: alreadyRevoked.id,
    scopeId: 'scope:boot-quarantine-already-revoked',
    runAttemptId: alreadyRevokedAttempt.attemptId,
  });
  eventlog.finishRunAttempt(alreadyRevokedAttempt, 'cancelled');
  dispatch.revokeDispatchLease(alreadyRevokedLease);

  const halfTerminal = makeSession('boot-quarantine-half-terminal', 'agent');
  const halfTerminalAttempt = eventlog.beginRunAttempt(halfTerminal.id, {
    attemptId: 'attempt:boot-quarantine-half-terminal',
  });
  const halfTerminalLease = dispatch.activateDispatchLease({
    sessionId: halfTerminal.id,
    scopeId: 'scope:boot-quarantine-half-terminal',
    runAttemptId: halfTerminalAttempt.attemptId,
  });
  db.prepare(`
    UPDATE run_attempts SET status = 'interrupted'
     WHERE attempt_id = ? AND session_id = ?
  `).run(halfTerminalAttempt.attemptId, halfTerminal.id);

  const activeWithFinishedTimestamp = makeSession('boot-quarantine-active-with-finish', 'chat');
  const activeWithFinishedAttempt = eventlog.beginRunAttempt(activeWithFinishedTimestamp.id, {
    attemptId: 'attempt:boot-quarantine-active-with-finish',
  });
  const activeWithFinishedLease = dispatch.activateDispatchLease({
    sessionId: activeWithFinishedTimestamp.id,
    scopeId: 'scope:boot-quarantine-active-with-finish',
    runAttemptId: activeWithFinishedAttempt.attemptId,
  });
  db.prepare(`
    UPDATE run_attempts SET finished_at = '2026-08-27T01:00:00.000Z'
     WHERE attempt_id = ? AND session_id = ?
  `).run(activeWithFinishedAttempt.attemptId, activeWithFinishedTimestamp.id);

  const eventsBefore = db.prepare(
    'SELECT seq, id, session_id, type, data_json, created_at FROM events ORDER BY seq',
  ).all();
  const physicalBefore = db.prepare('SELECT * FROM physical_dispatches ORDER BY physical_dispatch_id').all();
  const alreadyRevokedBefore = db.prepare(`
    SELECT revoked_at, revocation_reason FROM run_dispatch_leases WHERE scope_id = ?
  `).get(alreadyRevokedLease.scopeId);

  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('provider access is forbidden during boot dispatch quarantine');
  }) as typeof fetch;
  let firstPass = -1;
  try {
    firstPass = dispatch.reconcileTerminalRunAttemptDispatchLeasesAtBoot(1_800_000_000_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(firstPass, 2, 'one chat and one non-chat exact terminal owner are quarantined');
  assert.equal(fetchCalls, 0, 'boot quarantine never calls a provider transport');

  const rowsAfterFirst = db.prepare(`
    SELECT scope_id, revoked_at, revocation_reason
      FROM run_dispatch_leases ORDER BY scope_id
  `).all() as Array<{
    scope_id: string;
    revoked_at: string | null;
    revocation_reason: string | null;
  }>;
  const byScope = new Map(rowsAfterFirst.map((row) => [row.scope_id, row]));
  for (const lease of [chatLease, workflowLease]) {
    assert.deepEqual(byScope.get(lease.scopeId), {
      scope_id: lease.scopeId,
      revoked_at: '2027-01-15T08:00:00.000Z',
      revocation_reason: dispatch.TERMINAL_RUN_ATTEMPT_BOOT_REVOCATION_REASON,
    });
    assert.equal(dispatch.isDispatchLeaseCurrent(lease), false);
  }
  for (const lease of [
    activeLease,
    crossSessionLease,
    unboundLease,
    halfTerminalLease,
    activeWithFinishedLease,
  ]) {
    assert.deepEqual(byScope.get(lease.scopeId), {
      scope_id: lease.scopeId,
      revoked_at: null,
      revocation_reason: null,
    });
  }
  assert.equal(
    dispatch.isDispatchLeaseCurrent(activeLease),
    true,
    'a different terminal attempt in the same session cannot quarantine the exact active owner',
  );
  assert.equal(
    dispatch.isDispatchLeaseCurrent(crossSessionLease),
    false,
    'a cross-session attempt reference remains fail-closed without being reinterpreted as a boot revoke',
  );
  assert.equal(dispatch.isDispatchLeaseCurrent(unboundLease), true, 'an unbound lease is outside attempt quarantine');
  assert.deepEqual(
    db.prepare(`
      SELECT revoked_at, revocation_reason FROM run_dispatch_leases WHERE scope_id = ?
    `).get(alreadyRevokedLease.scopeId),
    alreadyRevokedBefore,
    'a prior exact owner keeps its original timestamp and nullable reason',
  );
  assert.deepEqual(
    db.prepare('SELECT seq, id, session_id, type, data_json, created_at FROM events ORDER BY seq').all(),
    eventsBefore,
    'quarantine emits no synthetic lifecycle or provider evidence',
  );
  assert.deepEqual(
    db.prepare('SELECT * FROM physical_dispatches ORDER BY physical_dispatch_id').all(),
    physicalBefore,
    'quarantine neither starts nor edits a physical dispatch',
  );

  assert.equal(
    dispatch.reconcileTerminalRunAttemptDispatchLeasesAtBoot(1_900_000_000_000),
    0,
    'the second boot pass is a fixed point',
  );
  assert.deepEqual(
    db.prepare(`
      SELECT scope_id, revoked_at, revocation_reason
        FROM run_dispatch_leases ORDER BY scope_id
    `).all(),
    rowsAfterFirst,
    'an idempotent pass preserves every timestamp and reason byte',
  );
});
