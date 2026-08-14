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

function accepted(
  sessionId: string,
  text: string,
  synthetic = false,
  data: Record<string, unknown> = {},
) {
  return eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text, ...(synthetic ? { synthetic: true } : {}), ...data },
  });
}

function createFullPacket(sessionId: string, sourceUserSeq: number, suffix: string) {
  return continuity.createTaskContinuityPacket({
    sessionId,
    originatingSourceUserSeq: sourceUserSeq,
    pause: {
      kind: 'clarification',
      question: `Which ${suffix}  account should I use?`,
      options: [],
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

const FROZEN_RESOLUTION = {
  resolverVersion: 'clarification-resolver-v2',
  disposition: 'provided' as const,
  semanticInputHash: 'a'.repeat(64),
};

function consumeInput(sessionId: string, consumingSourceUserSeq: number) {
  return { sessionId, consumingSourceUserSeq, resolution: FROZEN_RESOLUTION };
}

test('round-trips bounded capability, effect, account, resource, schema, and public pause evidence', () => {
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
    options: [],
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

test('v42 continuity freeze columns are installed and unsealed legacy rows fail closed', () => {
  const owner = session('v42-freeze-schema');
  const origin = accepted(owner.id, 'Inspect the legacy packet.');
  const packet = createFullPacket(owner.id, origin.seq, 'legacy');
  const db = eventlog.openEventLog();
  const columns = new Set(
    (db.prepare('PRAGMA table_info(task_continuity_packets)').all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  for (const name of [
    'origin_audience_hash',
    'consumer_audience_hash',
    'resolver_version',
    'resolution_disposition',
    'resolution_selected_option',
    'resolution_active_task_input',
    'resolution_semantic_input_hash',
  ]) assert.ok(columns.has(name), name);
  db.prepare('DROP TRIGGER task_continuity_origin_audience_immutable').run();
  db.prepare('UPDATE task_continuity_packets SET origin_audience_hash = NULL WHERE packet_id = ?')
    .run(packet.packetId);
  assert.deepEqual(
    continuity.peekTaskContinuityPacket({ sessionId: owner.id }),
    { status: 'malformed', packetId: packet.packetId },
    'v1-v41 rows are not silently interpreted under the v42 resolver',
  );
  db.exec(`
    CREATE TRIGGER task_continuity_origin_audience_immutable
    BEFORE UPDATE OF origin_audience_hash, consumer_audience_hash ON task_continuity_packets
    FOR EACH ROW
    WHEN OLD.consumer_audience_hash IS NOT NULL
      OR OLD.origin_audience_hash IS NOT NEW.origin_audience_hash
    BEGIN SELECT RAISE(ABORT, 'task continuity origin audience is immutable'); END;
  `);
});

test('hidden awaiting options cannot enter a continuity packet without public delivery binding', () => {
  const owner = session('hidden-options');
  const origin = accepted(owner.id, 'Use one of my calendars.');
  assert.throws(() => continuity.createTaskContinuityPacket({
    sessionId: owner.id,
    originatingSourceUserSeq: origin.seq,
    pause: {
      kind: 'clarification',
      question: 'Which calendar should I use?',
      options: ['Private calendar', 'Work calendar'],
    },
  }), /exact public delivery binding/);
  assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId: owner.id }), { status: 'none' });
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
    continuity.consumeTaskContinuityPacket(consumeInput(first.id, secondReply.seq)),
    { status: 'invalid_source', packetId: packet.packetId },
  );
  assert.equal(continuity.peekTaskContinuityPacket({ sessionId: first.id }).status, 'available');
});

test('a different provider user in the same shared channel cannot consume the open question', () => {
  const owner = session('shared-channel-audience');
  const conversationKey = 'discord:channel-42';
  const origin = accepted(owner.id, 'Prepare the account email.', false, {
    source: 'channel:discord',
    userId: 'alice-provider-id',
    conversationKey,
  });
  const packet = createFullPacket(owner.id, origin.seq, 'mail');
  const foreignReply = accepted(owner.id, 'Yes, correct.', false, {
    source: 'channel:discord',
    userId: 'bob-provider-id',
    conversationKey,
  });
  assert.deepEqual(
    continuity.consumeTaskContinuityPacket(consumeInput(owner.id, foreignReply.seq)),
    { status: 'invalid_source', packetId: packet.packetId },
  );
  assert.equal(
    continuity.peekTaskContinuityPacket({ sessionId: owner.id }).status,
    'available',
    'the cross-user reply acquires no lineage and does not mutate the open packet',
  );
});

test('the packet seals its provider audience and fails closed if accepted event metadata mutates', () => {
  const owner = session('sealed-audience');
  const origin = accepted(owner.id, 'Prepare the account email.', false, {
    source: 'channel:discord',
    userId: 'alice-provider-id',
    conversationKey: 'discord:channel-42',
  });
  const packet = createFullPacket(owner.id, origin.seq, 'mail');
  const db = eventlog.openEventLog();
  const row = db.prepare('SELECT data_json AS dataJson FROM events WHERE id = ?')
    .get(origin.id) as { dataJson: string };
  const data = JSON.parse(row.dataJson) as Record<string, unknown>;
  db.prepare('UPDATE events SET data_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...data, userId: 'mallory-provider-id' }), origin.id);
  assert.deepEqual(
    continuity.peekTaskContinuityPacket({ sessionId: owner.id }),
    { status: 'malformed', packetId: packet.packetId },
  );
});

test('the consumed edge seals the answering audience and cannot rehydrate after source mutation', () => {
  const owner = session('sealed-consumer-audience');
  const audience = {
    source: 'channel:discord',
    userId: 'alice-provider-id',
    conversationKey: 'discord:channel-42',
  };
  const origin = accepted(owner.id, 'Prepare the account email.', false, audience);
  const packet = createFullPacket(owner.id, origin.seq, 'mail');
  const reply = accepted(owner.id, 'Use the work account.', false, audience);
  assert.equal(
    continuity.consumeTaskContinuityPacket(consumeInput(owner.id, reply.seq)).status,
    'consumed',
  );
  const db = eventlog.openEventLog();
  const row = db.prepare('SELECT data_json AS dataJson FROM events WHERE id = ?')
    .get(reply.id) as { dataJson: string };
  const data = JSON.parse(row.dataJson) as Record<string, unknown>;
  db.prepare('UPDATE events SET data_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...data, conversationKey: 'discord:other-channel' }), reply.id);
  assert.deepEqual(
    continuity.readConsumedTaskContinuityPacket({
      sessionId: owner.id,
      consumingSourceUserSeq: reply.seq,
    }),
    { status: 'invalid_source', packetId: packet.packetId },
    'mutable event bytes cannot redirect an already-consumed continuation edge',
  );
});

test('consumes once, only for the next real accepted source, while skipping synthetic inputs', () => {
  const owner = session('one-shot');
  const origin = accepted(owner.id, 'Check the calendar and ask if the account is ambiguous.');
  const packet = createFullPacket(owner.id, origin.seq, 'calendar');
  accepted(owner.id, 'Harness retry boilerplate.', true);
  const reply = accepted(owner.id, 'Use the first one.');

  const consumed = continuity.consumeTaskContinuityPacket(consumeInput(owner.id, reply.seq));
  assert.equal(consumed.status, 'consumed');
  if (consumed.status === 'consumed') {
    assert.deepEqual(consumed.packet, packet);
    assert.equal(consumed.consumingSourceUserSeq, reply.seq);
    assert.equal(consumed.consumingSourceEventId, reply.id);
    assert.deepEqual(consumed.resolution, FROZEN_RESOLUTION);
  }
  const replay = continuity.consumeTaskContinuityPacket(consumeInput(owner.id, reply.seq));
  assert.equal(replay.status, 'consumed');
  if (replay.status === 'consumed') {
    assert.equal(replay.replay, true);
    assert.equal(replay.packet.packetId, packet.packetId);
    assert.equal(replay.consumingSourceUserSeq, reply.seq);
    assert.deepEqual(replay.resolution, FROZEN_RESOLUTION);
  }
  const db = eventlog.openEventLog();
  const frozen = db.prepare(`
    SELECT resolver_version AS resolverVersion,
           resolution_disposition AS disposition,
           resolution_selected_option AS selectedOption,
           resolution_semantic_input_hash AS semanticInputHash
      FROM task_continuity_packets WHERE packet_id = ?
  `).get(packet.packetId);
  assert.deepEqual(frozen, {
    resolverVersion: FROZEN_RESOLUTION.resolverVersion,
    disposition: FROZEN_RESOLUTION.disposition,
    selectedOption: null,
    semanticInputHash: FROZEN_RESOLUTION.semanticInputHash,
  });
  assert.throws(
    () => db.prepare('UPDATE task_continuity_packets SET resolution_disposition = ? WHERE packet_id = ?')
      .run('declined', packet.packetId),
    /frozen resolution is immutable/,
  );
  assert.deepEqual(
    continuity.consumeTaskContinuityPacket({
      ...consumeInput(owner.id, reply.seq),
      resolution: { ...FROZEN_RESOLUTION, semanticInputHash: 'b'.repeat(64) },
    }),
    { status: 'invalid_source', packetId: packet.packetId },
    'a later resolver cannot reinterpret the same accepted answer',
  );
  const later = accepted(owner.id, 'A later turn must not inherit it.');
  assert.deepEqual(
    continuity.consumeTaskContinuityPacket(consumeInput(owner.id, later.seq)),
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
    continuity.consumeTaskContinuityPacket(consumeInput(owner.id, later.seq)),
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
  const consumed = new continuity.TaskContinuityStore().consume(consumeInput(owner.id, reply.seq));
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
      consumeInput(owner.id, reply.seq),
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
    continuity.consumeTaskContinuityPacket(consumeInput(owner.id, reply.seq)),
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

test('a damaged store with multiple open questions fails ambiguous and mutates neither', () => {
  const owner = session('ambiguous-open');
  const origin = accepted(owner.id, 'Prepare the report.');
  const packet = createFullPacket(owner.id, origin.seq, 'first');
  const db = eventlog.openEventLog();
  db.exec('DROP INDEX idx_task_continuity_one_open_per_session');
  try {
    db.prepare(`
      INSERT INTO task_continuity_packets (
        packet_id, version, session_id,
        originating_source_user_seq, originating_source_event_id,
        pause_kind, pause_question, pause_options_json, capability_evidence_json,
        created_at, expires_at
      )
      SELECT packet_id || '-duplicate', version, session_id,
             originating_source_user_seq, originating_source_event_id,
             pause_kind, 'Which second account should I use?',
             pause_options_json, capability_evidence_json,
             created_at, expires_at
        FROM task_continuity_packets
       WHERE packet_id = ?
    `).run(packet.packetId);
    assert.deepEqual(
      continuity.peekTaskContinuityPacket({ sessionId: owner.id }),
      { status: 'ambiguous' },
    );
    const answer = accepted(owner.id, 'Yes, correct.');
    assert.deepEqual(
      continuity.consumeTaskContinuityPacket(consumeInput(owner.id, answer.seq)),
      { status: 'ambiguous' },
    );
    const states = db.prepare(`
      SELECT consumed_at AS consumedAt, dismissed_at AS dismissedAt
        FROM task_continuity_packets
       WHERE session_id = ?
       ORDER BY packet_id
    `).all(owner.id) as Array<{ consumedAt: string | null; dismissedAt: string | null }>;
    assert.equal(states.length, 2);
    assert.ok(states.every((row) => row.consumedAt === null && row.dismissedAt === null));
  } finally {
    db.prepare('DELETE FROM task_continuity_packets WHERE packet_id = ?').run(`${packet.packetId}-duplicate`);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_continuity_one_open_per_session
        ON task_continuity_packets(session_id)
        WHERE consumed_at IS NULL AND superseded_at IS NULL
          AND expired_at IS NULL AND dismissed_at IS NULL
    `);
  }
});
