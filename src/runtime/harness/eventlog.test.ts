/**
 * Run: npx tsx --test src/runtime/harness/eventlog.test.ts
 *
 * Contracts the 0.3 harness event log must keep:
 *   - sessions/events round-trip with monotonic seq
 *   - unknown event types are rejected (no free-form writes)
 *   - data survives close/reopen (crash recovery via SQLite WAL)
 *   - idempotency lookup returns the cached result event
 *   - kill switch is sticky until cleared
 *
 * Isolated via per-test CLEMENTINE_HOME so the user's real
 * ~/.clementine-next/state/harness.db is never touched.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-eventlog-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeEventLog,
  resetEventLog,
  createSession,
  getSession,
  updateSession,
  appendEvent,
  listEvents,
  getEvent,
  lookupIdempotent,
  recordIdempotent,
  requestKill,
  isKillRequested,
  clearKill,
  type EventType,
} from './eventlog.js';

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

test('idempotency: store and lookup returns the cached result event', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const returned = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'executor',
    type: 'tool_returned',
    data: { result: 'ok' },
    idemKey: 'k1',
  });
  recordIdempotent({
    key: 'k1',
    tool: 'write_file',
    sessionId: sess.id,
    resultEventId: returned.id,
  });
  const cached = lookupIdempotent('k1');
  assert.ok(cached);
  assert.equal(cached!.resultEventId, returned.id);
  assert.equal(cached!.tool, 'write_file');
  const loaded = getEvent(cached!.resultEventId);
  assert.ok(loaded);
  assert.deepEqual(loaded!.data, { result: 'ok' });
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

test('events with idem_key are queryable for replay', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'executor',
    type: 'tool_called',
    data: { tool: 'write_file', path: '/a' },
    idemKey: 'abc',
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'executor',
    type: 'tool_returned',
    data: { ok: true },
    idemKey: 'abc',
  });
  const events = listEvents(sess.id);
  assert.equal(events.filter((e) => e.idemKey === 'abc').length, 2);
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
