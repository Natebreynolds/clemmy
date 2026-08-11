import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-task-continuity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const eventlog = await import('../runtime/harness/eventlog.js');
const continuity = await import('./task-continuity.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function session(id: string) {
  return eventlog.createSession({ id: `continuity-${id}`, kind: 'chat' });
}

function accepted(sessionId: string, text: string, synthetic = false) {
  return eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text, ...(synthetic ? { synthetic: true } : {}) },
  });
}

function createFullPacket(sessionId: string, sourceUserSeq: number, suffix: string) {
  return continuity.createTaskContinuityPacket({
    sessionId,
    originatingSourceUserSeq: sourceUserSeq,
    pause: {
      kind: 'clarification',
      question: `Which ${suffix}  account should I use?`,
      options: ['Work — primary', 'Personal / family'],
    },
    capabilities: [{
      kind: 'composio',
      identifier: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW',
      effectClass: 'read',
      evidenceKind: 'discovered',
      accountIdentity: 'work@example.com',
      resourceRefs: ['outlook:calendar:primary', 'outlook:calendar:primary'],
      schemaFingerprint: 'sha256:schema-v1',
    }],
  });
}

test('round-trips bounded capability, effect, account, resource, schema, and pause evidence', () => {
  const owner = session('roundtrip');
  const origin = accepted(owner.id, 'Check tomorrow on my Outlook calendar.');
  const packet = createFullPacket(owner.id, origin.seq, 'Outlook');

  assert.equal(packet.version, 1);
  assert.equal(packet.sessionId, owner.id);
  assert.equal(packet.originatingSourceUserSeq, origin.seq);
  assert.equal(packet.originatingSourceEventId, origin.id);
  assert.deepEqual(packet.pause, {
    kind: 'clarification',
    question: 'Which Outlook  account should I use?',
    options: ['Work — primary', 'Personal / family'],
  });
  assert.deepEqual(packet.capabilities, [{
    kind: 'composio',
    identifier: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW',
    effectClass: 'read',
    evidenceKind: 'discovered',
    accountIdentity: 'work@example.com',
    resourceRefs: ['outlook:calendar:primary'],
    schemaFingerprint: 'sha256:schema-v1',
  }]);

  const peeked = continuity.peekTaskContinuityPacket({ sessionId: owner.id });
  assert.equal(peeked.status, 'available');
  if (peeked.status === 'available') assert.deepEqual(peeked.packet, packet);
});

test('rejects raw arguments or other unsupported capability payload fields', () => {
  const owner = session('no-raw-args');
  const origin = accepted(owner.id, 'Read the connected task list.');
  assert.throws(() => continuity.createTaskContinuityPacket({
    sessionId: owner.id,
    originatingSourceUserSeq: origin.seq,
    pause: { kind: 'clarification', question: 'Which account?' },
    capabilities: [{
      kind: 'composio',
      identifier: 'PROVIDER_LIST_TASKS',
      effectClass: 'read',
      evidenceKind: 'resolved',
      resourceRefs: [],
      args: { secret: 'must-not-land' },
    } as unknown as continuity.TaskContinuityCapabilityEvidence],
  }), /unsupported field/);
});

test('is exact-session scoped and refuses a source owned by another session', () => {
  const first = session('session-a');
  const second = session('session-b');
  const firstOrigin = accepted(first.id, 'Read the first mailbox.');
  const secondOrigin = accepted(second.id, 'Read the second mailbox.');
  const packet = createFullPacket(first.id, firstOrigin.seq, 'first');

  assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId: second.id }), { status: 'none' });
  assert.throws(
    () => createFullPacket(first.id, secondOrigin.seq, 'forged'),
    /not an accepted user source/,
  );

  const secondReply = accepted(second.id, 'The first one.');
  assert.deepEqual(
    continuity.consumeTaskContinuityPacket({
      sessionId: first.id,
      consumingSourceUserSeq: secondReply.seq,
    }),
    { status: 'invalid_source', packetId: packet.packetId },
  );
  assert.equal(continuity.peekTaskContinuityPacket({ sessionId: first.id }).status, 'available');
});

test('consumes once, only for the next real accepted source, while skipping synthetic inputs', () => {
  const owner = session('one-shot');
  const origin = accepted(owner.id, 'Check the calendar and ask if the account is ambiguous.');
  const packet = createFullPacket(owner.id, origin.seq, 'calendar');
  accepted(owner.id, 'Harness retry boilerplate.', true);
  const reply = accepted(owner.id, 'Use the first one.');

  const consumed = continuity.consumeTaskContinuityPacket({
    sessionId: owner.id,
    consumingSourceUserSeq: reply.seq,
  });
  assert.equal(consumed.status, 'consumed');
  if (consumed.status === 'consumed') {
    assert.deepEqual(consumed.packet, packet);
    assert.equal(consumed.consumingSourceUserSeq, reply.seq);
    assert.equal(consumed.consumingSourceEventId, reply.id);
  }
  const replay = continuity.consumeTaskContinuityPacket({
    sessionId: owner.id,
    consumingSourceUserSeq: reply.seq,
  });
  assert.equal(replay.status, 'consumed');
  if (replay.status === 'consumed') {
    assert.equal(replay.replay, true);
    assert.equal(replay.packet.packetId, packet.packetId);
    assert.equal(replay.consumingSourceUserSeq, reply.seq);
  }
  const later = accepted(owner.id, 'A later turn must not inherit it.');
  assert.deepEqual(
    continuity.consumeTaskContinuityPacket({
      sessionId: owner.id,
      consumingSourceUserSeq: later.seq,
    }),
    { status: 'none' },
    'only the exact logical consumer may rehydrate a packet',
  );
});

test('retires a packet when a later turn tries to skip the first eligible user source', () => {
  const owner = session('stale');
  const origin = accepted(owner.id, 'Inspect the release queue.');
  const packet = createFullPacket(owner.id, origin.seq, 'release');
  accepted(owner.id, 'The work account.');
  const later = accepted(owner.id, 'Unrelated follow-up.');

  assert.deepEqual(
    continuity.consumeTaskContinuityPacket({
      sessionId: owner.id,
      consumingSourceUserSeq: later.seq,
    }),
    { status: 'stale', packetId: packet.packetId },
  );
  assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId: owner.id }), { status: 'none' });
});

test('survives a daemon-style database close/reopen before consumption', () => {
  const owner = session('restart');
  const origin = accepted(owner.id, 'Refresh the task feed.');
  const packet = createFullPacket(owner.id, origin.seq, 'feed');

  eventlog.closeEventLog();
  const restartedStore = new continuity.TaskContinuityStore();
  const afterRestart = restartedStore.peek({ sessionId: owner.id });
  assert.equal(afterRestart.status, 'available');
  if (afterRestart.status === 'available') assert.deepEqual(afterRestart.packet, packet);

  const reply = accepted(owner.id, 'Use the connected work account.');
  eventlog.closeEventLog();
  const consumed = new continuity.TaskContinuityStore().consume({
    sessionId: owner.id,
    consumingSourceUserSeq: reply.seq,
  });
  assert.equal(consumed.status, 'consumed');
  if (consumed.status === 'consumed') assert.equal(consumed.packet.packetId, packet.packetId);
});

test('expires closed and is retired without exposing stale evidence', () => {
  const owner = session('expiry');
  const origin = accepted(owner.id, 'Read the report.');
  const createdAt = '2030-01-01T00:00:00.000Z';
  const packet = continuity.createTaskContinuityPacket({
    sessionId: owner.id,
    originatingSourceUserSeq: origin.seq,
    pause: { kind: 'approval', question: 'Should I continue with this account?' },
    ttlMs: 1_000,
  }, { now: createdAt });

  assert.deepEqual(
    continuity.peekTaskContinuityPacket(
      { sessionId: owner.id },
      { now: '2030-01-01T00:00:01.000Z' },
    ),
    { status: 'expired', packetId: packet.packetId },
  );
  const reply = accepted(owner.id, 'Yes.');
  assert.deepEqual(
    continuity.consumeTaskContinuityPacket(
      { sessionId: owner.id, consumingSourceUserSeq: reply.seq },
      { now: '2030-01-01T00:00:01.000Z' },
    ),
    { status: 'expired', packetId: packet.packetId },
  );
  assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId: owner.id }), { status: 'none' });
});

test('valid JSON with a malformed or future evidence shape fails closed and remains unconsumed', () => {
  const owner = session('malformed');
  const origin = accepted(owner.id, 'Look up tomorrow.');
  const packet = createFullPacket(owner.id, origin.seq, 'malformed');
  const db = eventlog.openEventLog();
  db.prepare(`
    UPDATE task_continuity_packets
       SET capability_evidence_json = ?
     WHERE packet_id = ?
  `).run(JSON.stringify({
    version: 2,
    capabilities: [{ kind: 'composio', identifier: 'FORGED' }],
  }), packet.packetId);

  assert.deepEqual(
    continuity.peekTaskContinuityPacket({ sessionId: owner.id }),
    { status: 'malformed', packetId: packet.packetId },
  );
  const reply = accepted(owner.id, 'Use the first one.');
  assert.deepEqual(
    continuity.consumeTaskContinuityPacket({
      sessionId: owner.id,
      consumingSourceUserSeq: reply.seq,
    }),
    { status: 'malformed', packetId: packet.packetId },
  );
  const row = db.prepare(`
    SELECT consumed_at AS consumedAt
      FROM task_continuity_packets
     WHERE packet_id = ?
  `).get(packet.packetId) as { consumedAt: string | null };
  assert.equal(row.consumedAt, null, 'malformed evidence never acquires continuation authority');
});

test('a newer pause supersedes the prior open packet without deleting its audit row', () => {
  const owner = session('supersession');
  const origin = accepted(owner.id, 'List my inbox.');
  const first = createFullPacket(owner.id, origin.seq, 'first');
  const second = continuity.createTaskContinuityPacket({
    sessionId: owner.id,
    originatingSourceUserSeq: origin.seq,
    pause: { kind: 'recovery', question: 'Retry the exact failed read?' },
    capabilities: [],
  });

  const current = continuity.peekTaskContinuityPacket({ sessionId: owner.id });
  assert.equal(current.status, 'available');
  if (current.status === 'available') assert.equal(current.packet.packetId, second.packetId);
  const rows = eventlog.openEventLog().prepare(`
    SELECT packet_id AS packetId, superseded_at AS supersededAt
      FROM task_continuity_packets
     WHERE session_id = ?
     ORDER BY rowid ASC
  `).all(owner.id) as Array<{ packetId: string; supersededAt: string | null }>;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.packetId), [first.packetId, second.packetId]);
  assert.ok(rows[0]?.supersededAt, 'the old packet remains as explicitly superseded audit history');
  assert.equal(rows[1]?.supersededAt, null);
});

test('dismisses an open packet without consuming or deleting its audit row', () => {
  const owner = session('dismiss');
  const origin = accepted(owner.id, 'Read my two calendars.');
  const packet = createFullPacket(owner.id, origin.seq, 'calendar');
  const dismissed = continuity.dismissTaskContinuityPacket({
    sessionId: owner.id,
    reason: 'topic_changed',
  });

  assert.equal(dismissed.status, 'dismissed');
  if (dismissed.status === 'dismissed') {
    assert.equal(dismissed.packetId, packet.packetId);
    assert.equal(dismissed.reason, 'topic_changed');
  }
  assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId: owner.id }), { status: 'none' });
  assert.deepEqual(
    continuity.dismissTaskContinuityPacket({ sessionId: owner.id }),
    { status: 'none' },
  );
  const row = eventlog.openEventLog().prepare(`
    SELECT consumed_at AS consumedAt, dismissed_at AS dismissedAt, dismissed_reason AS dismissedReason
      FROM task_continuity_packets
     WHERE packet_id = ?
  `).get(packet.packetId) as {
    consumedAt: string | null;
    dismissedAt: string | null;
    dismissedReason: string | null;
  };
  assert.equal(row.consumedAt, null);
  assert.ok(row.dismissedAt);
  assert.equal(row.dismissedReason, 'topic_changed');
});
