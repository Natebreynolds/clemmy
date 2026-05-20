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
  requestKill,
  isKillRequested,
  clearKill,
} = await import('./eventlog.js');
type EventType = import('./eventlog.js').EventType;

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
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
