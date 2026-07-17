/**
 * Run: npx tsx --test src/runtime/harness/eventlog.test.ts
 *
 * Contracts the 0.3 harness event log must keep:
 *   - sessions/events round-trip with monotonic seq
 *   - unknown event types are rejected (no free-form writes)
 *   - data survives close/reopen (crash recovery via SQLite WAL)
 *   - kill switch is sticky until cleared
 *
 * Isolated via per-test CLEMENTINE_HOME so the user's real
 * ~/.clementine-next/state/harness.db is never touched.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-eventlog-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic imports: anything that reads BASE_DIR must load AFTER
// process.env.CLEMENTINE_HOME is set, or it'll bake in the wrong path.
const {
  closeEventLog,
  resetEventLog,
  createSession,
  getSession,
  updateSession,
  listSessions,
  appendEvent,
  appendTerminalEventOnce,
  listEvents,
  countMatchingEvents,
  writeToolOutput,
  getToolOutput,
  TOOL_OUTPUT_MAX_BYTES,
  getLatestEventSeq,
  requestKill,
  isKillRequested,
  clearKill,
  beginRunAttempt,
  bindRunAttemptSourceUserEvent,
  claimRunAttemptLease,
  finishRunAttempt,
  getActiveRunAttempt,
  getLatestRunAttempt,
  listLatestRunAttemptsForSessions,
  getLatestRunAttemptByRunId,
  findUserInputEventForRun,
  renewRunAttemptLease,
  interruptForeignRunAttemptLeases,
  interruptOrphanedRunAttemptsAtBoot,
  claimHarnessChatRequest,
  getHarnessChatRequestReceipt,
  requestHarnessChatCancellation,
  getHarnessChatCancellation,
  preserveCurrentKillAndClearStale,
  recordRunAttemptUserInput,
  reapStaleSessions,
  openEventLog,
  HARNESS_DB_PATH,
} = await import('./eventlog.js');
type EventType = import('./eventlog.js').EventType;

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('latest schema upgrades an existing v4 approval table without losing rows', () => {
  resetEventLog();
  closeEventLog();
  const raw = new Database(HARNESS_DB_PATH);
  raw.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_version (version, applied_at) VALUES (4, '2026-07-01T00:00:00.000Z');
    CREATE TABLE pending_approvals (
      approval_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      channel TEXT,
      channel_id TEXT,
      requested_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      subject TEXT NOT NULL,
      tool TEXT,
      args_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      resolution TEXT,
      resolver TEXT,
      resolved_at TEXT
    );
    INSERT INTO pending_approvals
      (approval_id, session_id, requested_at, expires_at, subject, status)
    VALUES
      ('apr-old1', 'workflow:old', '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'existing approval', 'pending');
  `);
  raw.close();

  const migrated = openEventLog();
  const columns = migrated.prepare('PRAGMA table_info(pending_approvals)').all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === 'resume_key'));
  assert.ok(columns.some((column) => column.name === 'consumed_at'));
  assert.equal(
    (migrated.prepare("SELECT subject FROM pending_approvals WHERE approval_id = 'apr-old1'").get() as { subject: string }).subject,
    'existing approval',
  );
  assert.equal(
    (migrated.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
    12,
  );
  resetEventLog();
});

test('schema v6 migrates scoped guardrail rows and skips legacy orphans', () => {
  resetEventLog();
  closeEventLog();
  const raw = new Database(HARNESS_DB_PATH);
  raw.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_version (version, applied_at) VALUES (5, '2026-07-01T00:00:00.000Z');
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    INSERT INTO sessions (id) VALUES ('sess-valid');
    CREATE TABLE tool_guardrail_state (
      session_id TEXT PRIMARY KEY,
      recent_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO tool_guardrail_state (session_id, recent_json, updated_at) VALUES
      ('sess-valid', '[{"toolName":"plain"}]', '2026-07-01T00:00:00.000Z'),
      ('sess-valid::codeMode', '[{"toolName":"scoped"}]', '2026-07-01T00:00:01.000Z'),
      ('sess-missing::codeMode', '[{"toolName":"orphan"}]', '2026-07-01T00:00:02.000Z');
  `);
  raw.close();

  const migrated = openEventLog();
  const rows = migrated.prepare(
    'SELECT scope_id, parent_session_id FROM tool_guardrail_scope_state ORDER BY scope_id',
  ).all() as Array<{ scope_id: string; parent_session_id: string }>;
  assert.deepEqual(rows, [
    { scope_id: 'sess-valid', parent_session_id: 'sess-valid' },
    { scope_id: 'sess-valid::codeMode', parent_session_id: 'sess-valid' },
  ]);
  assert.equal(
    (migrated.prepare(
      'SELECT COUNT(*) AS n FROM tool_guardrail_state WHERE session_id = ?',
    ).get('sess-missing::codeMode') as { n: number }).n,
    0,
    'a legacy row with no owning session is unreachable state and is removed',
  );
  assert.equal(
    (migrated.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
    12,
  );
  resetEventLog();
});

test('schema v11 preserves a legacy targeted stop without widening its compatibility mirror', () => {
  resetEventLog();
  closeEventLog();
  const raw = new Database(HARNESS_DB_PATH);
  raw.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_version (version, applied_at) VALUES (10, '2026-07-16T00:00:00.000Z');
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    INSERT INTO sessions (id) VALUES ('sess-v10-kill');
    CREATE TABLE run_attempts (
      attempt_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      source_user_seq INTEGER
    );
    INSERT INTO run_attempts
      (attempt_id, session_id, run_id, started_at, finished_at, status)
    VALUES
      ('attempt-v10-a', 'sess-v10-kill', 'run-v10-a', '2026-07-16T00:00:00.000Z', NULL, 'active'),
      ('attempt-v10-b', 'sess-v10-kill', 'run-v10-b', '2026-07-16T00:00:01.000Z', NULL, 'active');
    CREATE TABLE run_kill_requests (
      session_id TEXT PRIMARY KEY,
      attempt_id TEXT,
      run_id TEXT,
      requested_at TEXT NOT NULL,
      reason TEXT
    );
    INSERT INTO run_kill_requests
      (session_id, attempt_id, run_id, requested_at, reason)
    VALUES
      ('sess-v10-kill', 'attempt-v10-a', 'run-v10-a', '2026-07-16T00:00:02.000Z', 'stop A');
    CREATE TABLE kill_switches (
      session_id TEXT PRIMARY KEY,
      requested_at TEXT NOT NULL,
      reason TEXT
    );
    INSERT INTO kill_switches
      (session_id, requested_at, reason)
    VALUES
      ('sess-v10-kill', '2026-07-16T00:00:02.000Z', 'legacy mirror of stop A');
    CREATE TABLE pending_approvals (
      approval_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    INSERT INTO pending_approvals (approval_id, session_id) VALUES
      ('apr-valid-v10', 'sess-v10-kill'),
      ('apr-orphan-v10', 'sess-deleted');
  `);
  raw.close();

  const migrated = openEventLog();
  const rows = migrated.prepare(
    'SELECT scope_key, attempt_id, run_id FROM run_kill_requests WHERE session_id = ?',
  ).all('sess-v10-kill') as Array<{ scope_key: string; attempt_id: string | null; run_id: string | null }>;
  assert.deepEqual(rows, [{ scope_key: 'attempt:attempt-v10-a', attempt_id: 'attempt-v10-a', run_id: 'run-v10-a' }]);
  assert.equal(
    (migrated.prepare('SELECT COUNT(*) AS n FROM kill_switches WHERE session_id = ?').get('sess-v10-kill') as { n: number }).n,
    0,
    'the old compatibility mirror is not reinterpreted as a session-wide stop',
  );
  assert.equal(isKillRequested('sess-v10-kill', { attemptId: 'attempt-v10-a' }), true);
  assert.equal(isKillRequested('sess-v10-kill', { attemptId: 'attempt-v10-b' }), false);
  assert.deepEqual(
    migrated.prepare('SELECT approval_id FROM pending_approvals ORDER BY approval_id').all(),
    [{ approval_id: 'apr-valid-v10' }],
    'only approvals with a durable owning session survive migration hygiene',
  );
  resetEventLog();
});

test('fresh schema v12 creates artifact truth and pre-ack cancellation tables eagerly', () => {
  resetEventLog();
  const db = openEventLog();
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  for (const name of [
    'run_artifacts',
    'artifact_run_scopes',
    'artifact_source_roots',
    'harness_chat_request_cancellations',
  ]) assert.ok(tables.has(name), `${name} exists before the first turn`);
  const columns = new Set(
    (db.prepare('PRAGMA table_info(run_artifacts)').all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const name of [
    'binding_verified_at',
    'verification_call_id',
    'verification_shape',
    'verification_fingerprint',
  ]) assert.ok(columns.has(name), name);
  assert.equal(
    (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
    12,
  );
  resetEventLog();
});

test('schema v12 upgrades a lazy artifact ledger in place and preserves its earliest source root', () => {
  resetEventLog();
  closeEventLog();
  const raw = new Database(HARNESS_DB_PATH);
  raw.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_version (version, applied_at) VALUES (11, '2026-07-16T00:00:00.000Z');
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    INSERT INTO sessions (id) VALUES ('sess-v11-artifact');
    CREATE TABLE run_artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_scope_id TEXT NOT NULL,
      slot_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      title TEXT,
      create_shape TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','bound','uncertain')),
      resource_id TEXT,
      uri TEXT,
      source_call_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, run_scope_id, slot_key)
    );
    INSERT INTO run_artifacts
      (id, session_id, run_scope_id, slot_key, kind, provider, title, create_shape,
       status, resource_id, uri, source_call_id, created_at, updated_at)
    VALUES
      ('artifact-v11', 'sess-v11-artifact', 'scope-late', 'google_doc:primary',
       'google_doc', 'Google Docs', 'Preserved', 'CREATE', 'bound', 'doc-v11',
       'https://docs.google.com/document/d/doc-v11/edit', 'call-v11',
       '2026-07-16T00:00:03.000Z', '2026-07-16T00:00:03.000Z');
    CREATE TABLE artifact_run_scopes (
      session_id TEXT NOT NULL,
      attempt_scope_id TEXT NOT NULL,
      root_scope_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, attempt_scope_id)
    );
    INSERT INTO artifact_run_scopes
      (session_id, attempt_scope_id, root_scope_id, source_user_seq, reason, created_at)
    VALUES
      ('sess-v11-artifact', 'scope-late', 'root-late', 42, 'retry', '2026-07-16T00:00:02.000Z'),
      ('sess-v11-artifact', 'scope-first', 'root-first', 42, 'initial', '2026-07-16T00:00:01.000Z');
  `);
  raw.close();

  const migrated = openEventLog();
  const artifact = migrated.prepare(
    'SELECT resource_id, binding_verified_at FROM run_artifacts WHERE id = ?',
  ).get('artifact-v11') as { resource_id: string; binding_verified_at: string | null };
  assert.deepEqual(artifact, { resource_id: 'doc-v11', binding_verified_at: null });
  const root = migrated.prepare(
    'SELECT root_scope_id FROM artifact_source_roots WHERE session_id = ? AND source_user_seq = ?',
  ).get('sess-v11-artifact', 42) as { root_scope_id: string };
  assert.equal(root.root_scope_id, 'root-first');
  assert.equal(
    (migrated.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
    12,
  );
  resetEventLog();
});

test('creates a session and appends events with monotonic seq', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', channel: 'cli', title: 'test' });
  assert.equal(sess.status, 'active');
  assert.equal(sess.kind, 'chat');

  for (let i = 0; i < 10; i++) {
    appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'orchestrator',
      type: 'heartbeat',
      data: { i },
    });
  }
  const events = listEvents(sess.id);
  assert.equal(events.length, 10);
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].seq > events[i - 1].seq, 'seq is monotonic');
  }
});

test('reapStaleSessions deletes old terminal sessions (+cascade), keeps active + recent', () => {
  resetEventLog();
  const db = openEventLog();
  const backdate = (id: string) =>
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', id);

  // A: old + completed → should be reaped (and cascade-delete its events).
  const a = createSession({ kind: 'workflow', channel: 'cli', title: 'old-done' });
  appendEvent({ sessionId: a.id, turn: 0, role: 'orchestrator', type: 'heartbeat', data: {} });
  updateSession(a.id, { status: 'completed' });
  backdate(a.id);

  // B: old but ACTIVE → must be kept (user can still resume in-flight work).
  const b = createSession({ kind: 'chat', channel: 'cli', title: 'old-active' });
  backdate(b.id);

  // C: completed but RECENT → must be kept (within TTL).
  const c = createSession({ kind: 'execution', channel: 'cli', title: 'recent-done' });
  updateSession(c.id, { status: 'completed' });

  const deleted = reapStaleSessions(14);
  assert.equal(deleted, 1, 'only the old terminal session is reaped');
  assert.equal(getSession(a.id), null, 'old completed session gone');
  assert.equal(listEvents(a.id).length, 0, 'cascade removed its events');
  assert.ok(getSession(b.id), 'old ACTIVE session kept (resumable)');
  assert.ok(getSession(c.id), 'recent completed session kept (within TTL)');

  // TTL <= 0 is a no-op guard (never reap everything by accident).
  const d = createSession({ kind: 'chat', channel: 'cli', title: 'guard' });
  updateSession(d.id, { status: 'completed' });
  backdate(d.id);
  assert.equal(reapStaleSessions(0), 0, 'ttl<=0 reaps nothing');
  assert.ok(getSession(d.id), 'guarded session survives ttl<=0');
});

test('reapStaleSessions never reaps a pinned or archived terminal session', () => {
  resetEventLog();
  const db = openEventLog();
  const backdate = (id: string) =>
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', id);

  // Pinned + old + completed → must be kept (explicit "hold onto this").
  const pinned = createSession({ kind: 'chat', channel: 'discord', title: 'pinned-done' });
  updateSession(pinned.id, { status: 'completed', metadata: { source: 'discord', pinned: true } });
  backdate(pinned.id);

  // Archived + old + completed → must be kept.
  const archived = createSession({ kind: 'workflow', channel: 'cli', title: 'archived-done' });
  updateSession(archived.id, { status: 'completed', metadata: { archived: true } });
  backdate(archived.id);

  // Plain old completed → reaped.
  const plain = createSession({ kind: 'chat', channel: 'cli', title: 'plain-done' });
  updateSession(plain.id, { status: 'completed' });
  backdate(plain.id);

  const deleted = reapStaleSessions(14);
  assert.equal(deleted, 1, 'only the un-pinned, un-archived terminal session is reaped');
  assert.ok(getSession(pinned.id), 'pinned terminal session kept');
  assert.ok(getSession(archived.id), 'archived terminal session kept');
  assert.equal(getSession(plain.id), null, 'plain old terminal session reaped');
});

test('rejects unknown event type', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  assert.throws(
    () =>
      appendEvent({
        sessionId: sess.id,
        turn: 0,
        role: 'orchestrator',
        type: 'totally_made_up' as EventType,
        data: {},
      }),
    /unknown event type/,
  );
});

test('persists across close+reopen (crash recovery)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'planner',
    type: 'plan_drafted',
    data: { steps: 3 },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'orchestrator',
    type: 'plan_approved',
    data: {},
  });
  closeEventLog();
  // simulate restart — next call reopens the cached handle
  const events = listEvents(sess.id);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'plan_drafted');
  assert.equal(events[1].type, 'plan_approved');
  const reload = getSession(sess.id);
  assert.ok(reload);
  assert.equal(reload!.id, sess.id);
});

test('listEvents filters by sinceSeq and types', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const e1 = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'o',
    type: 'turn_started',
    data: {},
  });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'o', type: 'heartbeat', data: {} });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'o', type: 'tool_called', data: {} });
  const since = listEvents(sess.id, { sinceSeq: e1.seq });
  assert.equal(since.length, 2);
  const onlyTools = listEvents(sess.id, { types: ['tool_called'] });
  assert.equal(onlyTools.length, 1);
  assert.equal(onlyTools[0].type, 'tool_called');
  assert.equal(countMatchingEvents(sess.id, { sinceSeq: e1.seq }), 2);
  assert.equal(countMatchingEvents(sess.id, { types: ['tool_called'] }), 1);
});

test('newest limited event window is returned in chronological order', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  for (const type of ['turn_started', 'heartbeat', 'tool_called', 'tool_returned'] as EventType[]) {
    appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type, data: {} });
  }
  const newest = listEvents(sess.id, { desc: true, limit: 2 });
  assert.deepEqual(newest.map((event) => event.type), ['tool_called', 'tool_returned']);
  assert.ok(newest[0].seq < newest[1].seq);
});

test('latest run attempt follows a reusable session across terminal turns', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const first = beginRunAttempt(sess.id, { runId: 'desktop:first' });
  finishRunAttempt(first, 'completed');
  const second = beginRunAttempt(sess.id, { runId: 'desktop:second' });
  const latest = getLatestRunAttempt(sess.id);
  assert.equal(latest?.attemptId, second.attemptId);
  assert.equal(latest?.runId, 'desktop:second');
  assert.equal(latest?.status, 'active');
  assert.equal(latest?.finishedAt, null);
  assert.equal(latest?.sourceUserSeq, null);
});

test('latest run attempts are projected for many sessions in one deterministic batch', () => {
  resetEventLog();
  const firstSession = createSession({ kind: 'chat' });
  const secondSession = createSession({ kind: 'chat' });
  const old = beginRunAttempt(firstSession.id, { runId: 'desktop:old' });
  finishRunAttempt(old, 'completed');
  const latest = beginRunAttempt(firstSession.id, { runId: 'desktop:latest' });
  const other = beginRunAttempt(secondSession.id, { runId: 'desktop:other' });

  const projected = listLatestRunAttemptsForSessions([
    firstSession.id,
    secondSession.id,
    firstSession.id,
    'missing-session',
  ]);
  assert.equal(projected.size, 2);
  assert.equal(projected.get(firstSession.id)?.attemptId, latest.attemptId);
  assert.equal(projected.get(secondSession.id)?.attemptId, other.attemptId);
  assert.equal(projected.has('missing-session'), false);
});

test('fold #7: the boot sweep interrupts NULL-run_id attempts (Discord/webhook lanes)', () => {
  resetEventLog();
  const discordSess = createSession({ kind: 'chat', channel: 'discord' });
  // Discord/webhook attempts carry no external run id — the crash shape that leaked.
  const orphaned = beginRunAttempt(discordSess.id);
  assert.equal(orphaned.runId, null);
  assert.equal(getLatestRunAttempt(discordSess.id)?.status, 'active');

  const swept = interruptOrphanedRunAttemptsAtBoot();
  assert.ok(swept >= 1, 'the NULL-run_id attempt is swept at daemon boot');
  const latest = getLatestRunAttempt(discordSess.id);
  assert.equal(latest?.status, 'interrupted');
  assert.ok(latest?.finishedAt, 'the phantom active row is terminal after boot');
});

test('fold #7: the foreign-lease sweep with no prefix also reaches NULL-run_id rows', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', channel: 'discord' });
  beginRunAttempt(sess.id);
  const swept = interruptForeignRunAttemptLeases('boot-owner-x');
  assert.ok(swept >= 1, 'run_id LIKE alone can never match NULL — the explicit NULL arm must');
  assert.equal(getLatestRunAttempt(sess.id)?.status, 'interrupted');
  // A prefixed sweep still targets only its own lane.
  const desktopSess = createSession({ kind: 'chat', channel: 'desktop' });
  beginRunAttempt(desktopSess.id, { runId: 'desktop:live' });
  const discordSess2 = createSession({ kind: 'chat', channel: 'discord' });
  beginRunAttempt(discordSess2.id);
  const sweptPrefixed = interruptForeignRunAttemptLeases('boot-owner-x', { runIdPrefix: 'desktop:' });
  assert.equal(sweptPrefixed, 1, 'prefix sweep touches only the prefixed lane');
  assert.equal(getLatestRunAttempt(discordSess2.id)?.status, 'active', 'NULL-run_id rows are untouched by a prefixed sweep');
});

test('run attempt binds idempotently to one exact same-session user input', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', channel: 'desktop' });
  const attempt = beginRunAttempt(sess.id, { runId: 'desktop:source-bound' });
  const firstInput = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Build the memo.', runId: 'desktop:source-bound' },
  });
  bindRunAttemptSourceUserEvent(attempt, firstInput.seq);
  bindRunAttemptSourceUserEvent(attempt, firstInput.seq);
  assert.equal(getLatestRunAttempt(sess.id)?.sourceUserSeq, firstInput.seq);

  const secondInput = appendEvent({
    sessionId: sess.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Different request.' },
  });
  assert.throws(
    () => bindRunAttemptSourceUserEvent(attempt, secondInput.seq),
    /already bound to user event/,
  );

  const other = createSession({ kind: 'chat' });
  const foreignInput = appendEvent({
    sessionId: other.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Foreign request.' },
  });
  const otherAttempt = beginRunAttempt(sess.id, { runId: 'desktop:other-attempt' });
  assert.throws(
    () => bindRunAttemptSourceUserEvent(otherAttempt, foreignInput.seq),
    /not a user input for attempt session/,
  );
});

test('recordRunAttemptUserInput atomically inserts once and binding wins over transformed prompts', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', channel: 'desktop' });
  const attempt = beginRunAttempt(sess.id, { runId: 'desktop:atomic-source' });
  const literal = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: '/goal start Build the firm brief.' },
  });
  const transformed = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Execute the normalized goal objective.' },
  });

  assert.equal(transformed.seq, literal.seq, 'the exact binding outranks runtime prompt text');
  assert.equal(listEvents(sess.id, { types: ['user_input_received'] }).length, 1);
  assert.equal(getLatestRunAttempt(sess.id)?.sourceUserSeq, literal.seq);
});

test('desktop run finds a pre-recorded request-id input only while it is unsettled', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', channel: 'desktop' });
  claimHarnessChatRequest({
    requestId: 'client-request-source-1234',
    sessionId: sess.id,
    runId: 'desktop:source-request',
    inputHash: 'hash',
    sinceSeq: 0,
  });
  const input = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the exact brief.', requestId: 'client-request-source-1234' },
  });

  assert.equal(
    findUserInputEventForRun(sess.id, 'desktop:source-request', 'Create the exact brief.')?.seq,
    input.seq,
  );
  assert.equal(
    findUserInputEventForRun(sess.id, 'desktop:source-request', 'Different text.'),
    null,
    'run identity alone cannot dedupe a different message',
  );
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'assistant',
    type: 'conversation_completed',
    data: { summary: 'Done.' },
  });
  assert.equal(
    findUserInputEventForRun(sess.id, 'desktop:source-request', 'Create the exact brief.'),
    null,
    'a settled request is historical input, not the source of a fresh attempt',
  );
});

test('getLatestEventSeq returns the current replay cursor for a session', () => {
  resetEventLog();
  const first = createSession({ kind: 'chat' });
  const second = createSession({ kind: 'chat' });
  assert.equal(getLatestEventSeq(first.id), 0);

  const e1 = appendEvent({
    sessionId: first.id,
    turn: 1,
    role: 'o',
    type: 'turn_started',
    data: {},
  });
  appendEvent({ sessionId: second.id, turn: 1, role: 'o', type: 'heartbeat', data: {} });
  const e2 = appendEvent({
    sessionId: first.id,
    turn: 1,
    role: 'o',
    type: 'tool_called',
    data: {},
  });

  assert.ok(e2.seq > e1.seq);
  assert.equal(getLatestEventSeq(first.id), e2.seq);
});

test('listSessions filters recent sessions without loading events', () => {
  resetEventLog();
  const discord = createSession({
    kind: 'chat',
    channel: 'discord',
    userId: 'user-1',
    title: 'discord task',
    metadata: { source: 'discord', channelId: 'channel-1' },
  });
  const workflow = createSession({
    kind: 'workflow',
    channel: 'workflow',
    title: 'workflow task',
    metadata: { source: 'workflow', workflowName: 'daily' },
  });
  updateSession(workflow.id, { status: 'paused' });

  const discordRows = listSessions({ channel: 'discord' });
  assert.equal(discordRows.length, 1);
  assert.equal(discordRows[0].id, discord.id);
  assert.equal(discordRows[0].metadata.source, 'discord');

  const activeRows = listSessions({ status: ['active', 'paused'], limit: 10 });
  assert.deepEqual(new Set(activeRows.map((session) => session.id)), new Set([discord.id, workflow.id]));
});

test('listSessions has deterministic tie ordering for offset pagination', () => {
  resetEventLog();
  for (let i = 0; i < 5; i += 1) {
    createSession({ id: `tie-page-${String(i).padStart(3, '0')}`, kind: 'chat' });
  }

  const sameUpdatedAt = '2026-07-01T00:00:00.000Z';
  openEventLog().prepare('UPDATE sessions SET updated_at = ? WHERE id LIKE ?').run(sameUpdatedAt, 'tie-page-%');

  assert.deepEqual(
    listSessions({ limit: 2, offset: 0 }).map((session) => session.id),
    ['tie-page-004', 'tie-page-003'],
  );
  assert.deepEqual(
    listSessions({ limit: 2, offset: 2 }).map((session) => session.id),
    ['tie-page-002', 'tie-page-001'],
  );
  assert.deepEqual(
    listSessions({ limit: 2, offset: 4 }).map((session) => session.id),
    ['tie-page-000'],
  );
});

test('kill switch is sticky until cleared', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  assert.equal(isKillRequested(sess.id), false);
  requestKill(sess.id, 'user pressed stop');
  assert.equal(isKillRequested(sess.id), true);
  clearKill(sess.id);
  assert.equal(isKillRequested(sess.id), false);
});

test('run-scoped kill survives current-attempt preparation but not a fresh attempt', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  requestKill(sess.id, 'legacy idle-session stop');
  const first = beginRunAttempt(sess.id, { runId: 'run-current' });
  requestKill(sess.id, 'stop current', first);
  assert.equal(preserveCurrentKillAndClearStale(sess.id, first), true);
  assert.equal(isKillRequested(sess.id, first), true);
  assert.equal(
    (openEventLog().prepare(
      "SELECT COUNT(*) AS n FROM run_kill_requests WHERE session_id = ? AND scope_key = 'session:*'",
    ).get(sess.id) as { n: number }).n,
    0,
    'preparing an exact attempt clears a stale session fallback while preserving its exact stop',
  );

  finishRunAttempt(first, 'cancelled');
  const next = beginRunAttempt(sess.id, { runId: 'run-next' });
  assert.equal(preserveCurrentKillAndClearStale(sess.id, next), false);
  assert.equal(isKillRequested(sess.id), false);
  assert.equal(isKillRequested(sess.id, first), false, 'the old attempt already settled and consumed its latch');
  assert.equal(getActiveRunAttempt(sess.id)?.attemptId, next.attemptId);
});

test('attempt kill latches coexist, survive reopen, and resolve by exact source turn', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const first = beginRunAttempt(sess.id, { runId: 'run-a' });
  const firstInput = recordRunAttemptUserInput(first, {
    turn: 1, role: 'user', data: { text: 'attempt A' },
  });
  requestKill(sess.id, 'stop A', first);

  const second = beginRunAttempt(sess.id, { runId: 'run-b' });
  const secondInput = recordRunAttemptUserInput(second, {
    turn: 2, role: 'user', data: { text: 'attempt B' },
  });
  assert.equal(preserveCurrentKillAndClearStale(sess.id, second), false);
  requestKill(sess.id, 'stop B', second);

  assert.equal(isKillRequested(sess.id, { sourceUserSeq: firstInput.seq }), true);
  assert.equal(isKillRequested(sess.id, { sourceUserSeq: secondInput.seq }), true);
  assert.equal(
    (openEventLog().prepare('SELECT COUNT(*) AS n FROM run_kill_requests WHERE session_id = ?').get(sess.id) as { n: number }).n,
    2,
    'one session can retain independent A and B stop latches',
  );
  assert.equal(
    (openEventLog().prepare('SELECT COUNT(*) AS n FROM kill_switches WHERE session_id = ?').get(sess.id) as { n: number }).n,
    0,
    'attempt-targeted stops never widen into the legacy session-global mirror',
  );

  closeEventLog();
  assert.equal(isKillRequested(sess.id, first), true, 'A latch survives a database reopen');
  assert.equal(isKillRequested(sess.id, second), true, 'B latch survives a database reopen');

  clearKill(sess.id, second);
  assert.equal(isKillRequested(sess.id, second), false);
  assert.equal(isKillRequested(sess.id, first), true, 'clearing B cannot consume A');
  clearKill(sess.id, first);
  assert.equal(isKillRequested(sess.id, first), false);
});

test('a stop in the pre-dispatch window targets the already-registered attempt', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const attempt = beginRunAttempt(sess.id, { runId: 'run-pre-dispatch' });
  requestKill(sess.id, 'stop before model dispatch');
  assert.equal(isKillRequested(sess.id, attempt), true);
  assert.equal(preserveCurrentKillAndClearStale(sess.id, attempt), true);
});

test('reusing a settled external run id creates a fresh attempt identity', () => {
  const sess = createSession({ kind: 'chat', channel: 'discord' });
  const first = beginRunAttempt(sess.id, { runId: 'run-retried' });
  finishRunAttempt(first, 'completed');
  const retry = beginRunAttempt(sess.id, { runId: 'run-retried' });

  assert.notEqual(retry.attemptId, first.attemptId);
  assert.equal(retry.runId, first.runId);
  assert.equal(getLatestRunAttemptByRunId(sess.id, 'run-retried')?.attemptId, retry.attemptId);
});

test('desktop chat request receipt persists one payload/session/run and replays idempotently', () => {
  const sess = createSession({ kind: 'chat', channel: 'desktop' });
  const input = {
    requestId: 'client-request-1234',
    sessionId: sess.id,
    runId: 'desktop:stable-run',
    inputHash: 'hash-one',
    sinceSeq: 12,
  };
  const first = claimHarnessChatRequest(input);
  const replay = claimHarnessChatRequest(input);

  assert.equal(first.inserted, true);
  assert.equal(replay.inserted, false);
  assert.deepEqual(replay.receipt, first.receipt);
  closeEventLog();
  assert.deepEqual(getHarnessChatRequestReceipt(input.requestId), first.receipt, 'receipt survives reopen/restart');
  assert.throws(
    () => claimHarnessChatRequest({ ...input, inputHash: 'different-payload' }),
    /different chat request/,
  );
});

test('a pre-ack chat cancellation is durable, idempotent, and prevents later receipt acceptance', () => {
  resetEventLog();
  const requestId = 'client-request-cancel-before-ack';
  const first = requestHarnessChatCancellation(requestId, 'user pressed Stop');
  const replay = requestHarnessChatCancellation(requestId, 'duplicate click');
  assert.deepEqual(replay, first, 'the first Stop remains the durable authority');
  assert.equal(first.reason, 'user pressed Stop');

  closeEventLog();
  assert.deepEqual(getHarnessChatCancellation(requestId), first, 'the tombstone survives restart');
  const sess = createSession({ kind: 'chat', channel: 'desktop' });
  assert.throws(
    () => claimHarnessChatRequest({
      requestId,
      sessionId: sess.id,
      runId: 'desktop:must-not-run',
      inputHash: 'cancelled-hash',
      sinceSeq: 0,
    }),
    /cancelled before acceptance/,
  );
  assert.equal(getHarnessChatRequestReceipt(requestId), null);
});

test('run attempt lease suppresses live replay and reclaims an expired attempt under a fresh identity', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', channel: 'desktop' });
  const first = claimRunAttemptLease({
    sessionId: sess.id,
    runId: 'desktop:leased-run',
    ownerId: 'daemon-old',
    leaseMs: 5_000,
    nowMs: 10_000,
  });
  assert.equal(first.claimed, true);
  assert.ok(first.attempt);
  const source = recordRunAttemptUserInput(first.attempt!, {
    turn: 1,
    role: 'user',
    data: { text: 'Resume this exact request.' },
  });

  const liveReplay = claimRunAttemptLease({
    sessionId: sess.id,
    runId: 'desktop:leased-run',
    ownerId: 'daemon-new',
    leaseMs: 5_000,
    nowMs: 12_000,
  });
  assert.equal(liveReplay.claimed, false);
  assert.equal(liveReplay.reason, 'active');
  assert.equal(liveReplay.attempt?.attemptId, first.attempt?.attemptId);

  assert.equal(renewRunAttemptLease(first.attempt!, 'daemon-old', 5_000, 13_000), true);
  const recovered = claimRunAttemptLease({
    sessionId: sess.id,
    runId: 'desktop:leased-run',
    ownerId: 'daemon-new',
    leaseMs: 5_000,
    nowMs: 19_000,
  });
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.interruptedAttemptId, first.attempt?.attemptId);
  assert.notEqual(recovered.attempt?.attemptId, first.attempt?.attemptId);
  const recoveredRecord = getLatestRunAttemptByRunId(sess.id, 'desktop:leased-run');
  assert.equal(recoveredRecord?.leaseOwner, 'daemon-new');
  assert.equal(recoveredRecord?.sourceUserSeq, source.seq, 'interrupted recovery preserves the exact source input');

  const nestedRuntimeAttempt = beginRunAttempt(sess.id, { runId: 'desktop:leased-run' });
  assert.equal(
    nestedRuntimeAttempt.attemptId,
    recovered.attempt?.attemptId,
    'a downstream runtime wrapper reuses the recovered lease attempt instead of superseding it',
  );
  assert.equal(getLatestRunAttemptByRunId(sess.id, 'desktop:leased-run')?.leaseOwner, 'daemon-new');

  finishRunAttempt(recovered.attempt!, 'completed');
  const terminalReplay = claimRunAttemptLease({
    sessionId: sess.id,
    runId: 'desktop:leased-run',
    ownerId: 'daemon-new',
    leaseMs: 5_000,
    nowMs: 20_000,
  });
  assert.equal(terminalReplay.claimed, false);
  assert.equal(terminalReplay.reason, 'terminal');
});

test('lease replay reconciles a durable terminal after a crash instead of re-executing', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', channel: 'desktop' });
  const first = claimRunAttemptLease({
    sessionId: sess.id,
    runId: 'desktop:terminal-before-finally',
    ownerId: 'daemon-old',
    leaseMs: 5_000,
    nowMs: 10_000,
  });
  assert.ok(first.attempt);
  const source = recordRunAttemptUserInput(first.attempt!, {
    turn: 1,
    role: 'user',
    data: { text: 'Create the report.' },
  });
  const terminal = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'success', summary: 'Report created.' },
  });
  assert.equal(terminal.data.attemptId, first.attempt?.attemptId);
  assert.equal(terminal.data.runId, 'desktop:terminal-before-finally');
  assert.equal(terminal.data.sourceUserSeq, source.seq);
  // Simulate process death here: finishRunAttempt never ran and the lease later
  // expired. The durable terminal after this exact source is still authority.
  const replay = claimRunAttemptLease({
    sessionId: sess.id,
    runId: 'desktop:terminal-before-finally',
    ownerId: 'daemon-new',
    leaseMs: 5_000,
    nowMs: 20_000,
  });

  assert.equal(replay.claimed, false);
  assert.equal(replay.reason, 'terminal');
  assert.equal(replay.attempt?.attemptId, first.attempt?.attemptId, 'no replacement executor was minted');
  const settled = getLatestRunAttemptByRunId(sess.id, 'desktop:terminal-before-finally');
  assert.equal(settled?.status, 'completed');
  assert.equal(settled?.sourceUserSeq, source.seq);
});

test('a late completion keeps the source turn owner after a newer attempt becomes active', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', channel: 'desktop' });
  const first = beginRunAttempt(sess.id, { runId: 'desktop:turn-a' });
  const firstSource = recordRunAttemptUserInput(first, {
    turn: 1,
    role: 'user',
    data: { text: 'Turn A' },
  });
  const second = beginRunAttempt(sess.id, { runId: 'desktop:turn-b' });
  recordRunAttemptUserInput(second, {
    turn: 2,
    role: 'user',
    data: { text: 'Turn B' },
  });

  const lateFirstTerminal = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'success', sourceUserSeq: firstSource.seq },
  });

  assert.equal(lateFirstTerminal.data.attemptId, first.attemptId);
  assert.equal(lateFirstTerminal.data.runId, first.runId);
  assert.equal(lateFirstTerminal.data.sourceUserSeq, firstSource.seq);
  assert.notEqual(lateFirstTerminal.data.attemptId, second.attemptId);
});

test('daemon startup interrupts only foreign desktop leases so their request can resume immediately', () => {
  resetEventLog();
  const foreign = createSession({ kind: 'chat', channel: 'desktop' });
  const owned = createSession({ kind: 'chat', channel: 'desktop' });
  const otherSurface = createSession({ kind: 'chat', channel: 'discord' });
  claimRunAttemptLease({ sessionId: foreign.id, runId: 'desktop:foreign', ownerId: 'old-daemon', leaseMs: 60_000, nowMs: 1_000 });
  claimRunAttemptLease({ sessionId: owned.id, runId: 'desktop:owned', ownerId: 'new-daemon', leaseMs: 60_000, nowMs: 1_000 });
  claimRunAttemptLease({ sessionId: otherSurface.id, runId: 'discord:foreign', ownerId: 'old-daemon', leaseMs: 60_000, nowMs: 1_000 });

  assert.equal(interruptForeignRunAttemptLeases('new-daemon', { runIdPrefix: 'desktop:', nowMs: 2_000 }), 1);
  assert.equal(getLatestRunAttemptByRunId(foreign.id, 'desktop:foreign')?.status, 'interrupted');
  assert.equal(getLatestRunAttemptByRunId(owned.id, 'desktop:owned')?.status, 'active');
  assert.equal(getLatestRunAttemptByRunId(otherSurface.id, 'discord:foreign')?.status, 'active');

  const resumed = claimRunAttemptLease({
    sessionId: foreign.id,
    runId: 'desktop:foreign',
    ownerId: 'new-daemon',
    leaseMs: 60_000,
    nowMs: 2_001,
  });
  assert.equal(resumed.claimed, true);
  assert.notEqual(resumed.attempt?.attemptId, 'attempt:desktop:foreign');
});

test('terminal completion is appended and broadcast only once per attempt key', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const first = appendTerminalEventOnce({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    data: { reason: 'cancelled' },
  }, 'brain:attempt-1');
  const second = appendTerminalEventOnce({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    data: { reason: 'cancelled' },
  }, 'brain:attempt-1');
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(first.event.id, second.event.id);
  assert.equal(listEvents(sess.id, { types: ['conversation_completed'] }).length, 1);
});

test('updateSession patches and bumps updated_at', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat', title: 'first' });
  const original = sess.updatedAt;
  const next = updateSession(sess.id, { title: 'renamed', status: 'paused' });
  assert.equal(next.title, 'renamed');
  assert.equal(next.status, 'paused');
  assert.ok(next.updatedAt >= original);
});

test('appending event bumps the parent session updated_at', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const original = sess.updatedAt;
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'orchestrator',
    type: 'turn_started',
    data: {},
  });
  const reloaded = getSession(sess.id);
  assert.ok(reloaded);
  assert.ok(reloaded!.updatedAt >= original);
});

test('500 sequential appends keep ordering and survive reopen', () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  for (let i = 0; i < 500; i++) {
    appendEvent({
      sessionId: sess.id,
      turn: Math.floor(i / 50),
      role: 'executor',
      type: 'heartbeat',
      data: { i },
    });
  }
  closeEventLog();
  const all = listEvents(sess.id);
  assert.equal(all.length, 500);
  for (let i = 0; i < all.length; i++) {
    assert.equal(all[i].data.i, i);
  }
});

test('appendEvent emits a harness.event on the global actionBus', async () => {
  // The dashboard SSE endpoint and Discord live-progress edits both
  // subscribe to actionBus to learn about new harness events. Wire
  // a subscriber here and verify every appendEvent fans out.
  const { actionBus } = await import('../action-bus.js');
  const sess = createSession({
    kind: 'chat',
    channel: 'discord',
    userId: 'user-1',
    title: 'discord task',
    metadata: {
      source: 'discord',
      channelId: 'channel-1',
      __conversation: { items: [{ role: 'user', content: 'private history' }] },
    },
  });

  const seen: Array<{
    sessionId: string;
    type: string;
    turn: number;
    channel: string | null;
    source: unknown;
    hasConversation: boolean;
  }> = [];
  const unsubscribe = actionBus.subscribe((evt) => {
    if (evt.kind !== 'harness.event') return;
    if (evt.sessionId !== sess.id) return;
    seen.push({
      sessionId: evt.sessionId,
      type: evt.event.type,
      turn: evt.event.turn,
      channel: evt.session?.channel ?? null,
      source: evt.session?.metadata.source,
      hasConversation: Object.prototype.hasOwnProperty.call(evt.session?.metadata ?? {}, '__conversation'),
    });
  });

  appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'turn_started', data: {} });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'orchestrator', type: 'handoff', data: { to: 'Executor' } });
  appendEvent({ sessionId: sess.id, turn: 2, role: 'system', type: 'turn_ended', data: {} });

  unsubscribe();
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((s) => s.type), ['turn_started', 'handoff', 'turn_ended']);
  assert.equal(seen[0].sessionId, sess.id);
  assert.equal(seen[0].channel, 'discord');
  assert.equal(seen[0].source, 'discord');
  assert.equal(seen[0].hasConversation, false);
});

test('actionBus subscribers filtered by sessionId never see other sessions', async () => {
  const { actionBus } = await import('../action-bus.js');
  const a = createSession({ kind: 'chat' });
  const b = createSession({ kind: 'chat' });

  const onlyA: string[] = [];
  const unsubscribe = actionBus.subscribe((evt) => {
    if (evt.kind !== 'harness.event') return;
    if (evt.sessionId !== a.id) return;
    onlyA.push(evt.event.type);
  });

  appendEvent({ sessionId: a.id, turn: 1, role: 'system', type: 'turn_started', data: {} });
  appendEvent({ sessionId: b.id, turn: 1, role: 'system', type: 'turn_started', data: {} });
  appendEvent({ sessionId: a.id, turn: 1, role: 'system', type: 'turn_ended', data: {} });

  unsubscribe();
  assert.deepEqual(onlyA, ['turn_started', 'turn_ended']);
});

test('writeToolOutput preserves an existing larger payload for the same call id', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const full = 'full payload '.repeat(1000);
  const clipped = 'full payload\n[clipped: composio_execute_tool returned 13000 chars at 2026-05-26T00:00:00.000Z — call recall_tool_result("call_keep_full") for full output]';

  writeToolOutput({
    sessionId: sess.id,
    callId: 'call_keep_full',
    tool: 'composio_execute_tool',
    output: full,
  });
  writeToolOutput({
    sessionId: sess.id,
    callId: 'call_keep_full',
    tool: 'composio_execute_tool',
    output: clipped,
  });

  const row = getToolOutput(sess.id, 'call_keep_full');
  assert.ok(row);
  assert.equal(row.output, full);
  assert.equal(row.contentBytes, Buffer.byteLength(full, 'utf8'));
});

test('writeToolOutput stores a 300KB result in FULL (was tail-dropped under the old 200KB cap)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const big = 'D'.repeat(300_000); // 300KB — exceeds the OLD 200KB ceiling, under the new 2MB one
  writeToolOutput({ sessionId: sess.id, callId: 'call_300k', tool: 'composio_execute_tool', output: big });
  const row = getToolOutput(sess.id, 'call_300k');
  assert.ok(row);
  assert.equal(row.output.length, 300_000, 'full payload stored, no tail loss');
  assert.equal(row.truncatedAtWrite, false);
  assert.equal(row.contentBytes, 300_000);
});

test('writeToolOutput still tail-truncates + marks beyond the cap (backstop)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const overBy = 100_000;
  const huge = 'H'.repeat(TOOL_OUTPUT_MAX_BYTES + overBy); // ASCII → bytes == chars
  writeToolOutput({ sessionId: sess.id, callId: 'call_huge', tool: 'composio_execute_tool', output: huge });
  const row = getToolOutput(sess.id, 'call_huge');
  assert.ok(row);
  assert.equal(row.truncatedAtWrite, true, 'overflow is marked');
  assert.equal(row.contentBytes, TOOL_OUTPUT_MAX_BYTES + overBy, 'original byte count preserved for the header');
  assert.equal(row.output.length, TOOL_OUTPUT_MAX_BYTES, 'stored body clamped to the cap');
});
