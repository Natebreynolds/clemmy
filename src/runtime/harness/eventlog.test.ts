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
  listEvents,
  writeToolOutput,
  getToolOutput,
  TOOL_OUTPUT_MAX_BYTES,
  getLatestEventSeq,
  requestKill,
  isKillRequested,
  clearKill,
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

test('schema v5 upgrades an existing v4 approval table without losing rows', () => {
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
    5,
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
