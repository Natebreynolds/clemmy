import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-task-continuity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const eventlog = await import('../runtime/harness/eventlog.js');
const continuity = await import('./task-continuity.js');
const { presentationEventForOutcome, turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');

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

function retainedQuestionBinding(suffix: string, changes: {
  visible?: string; shape?: 'done' | 'approval' | 'continue' | 'blocked';
  foreignSource?: boolean; legacy?: boolean;
} = {}) {
  const owner = session(`retained-${suffix}`);
  const origin = accepted(owner.id, 'Inspect the synthetic local note.');
  const question = 'Which correction should I make?';
  const options = ['Correct the title', 'Correct the date'];
  const raw = (changes.visible ?? question)
    + '\n\nRetained work (durable checkpoint):\n- Source/tool read_file: 1 record retained as rh_fixture_read.\nExternal write state: no settled external-write attempt is recorded.';
  const awaiting = eventlog.appendEvent({ sessionId: owner.id, turn: 3, role: 'Clem', type: 'awaiting_user_input',
    data: { sourceUserSeq: changes.foreignSource ? origin.seq + 99 : origin.seq, question, options, purpose: 'clarification' } });
  const identity = { sessionId: owner.id, turn: 1, sourceUserSeq: origin.seq };
  const base = { version: 2 as const, id: turnOutcomeId(identity), identity };
  const presentation = presentationEventForOutcome(changes.shape === 'done'
    ? { ...base, status: 'done', resumable: false, presentation: { kind: 'answer', text: raw } }
    : changes.shape === 'blocked'
      ? { ...base, status: 'blocked', resumable: true, presentation: { kind: 'blocked', text: raw } }
      : changes.shape === 'approval'
        ? { ...base, status: 'needs_input', resumable: true, needs: { kind: 'approval' }, presentation: { kind: 'approval', text: raw, approvalId: 'fixture-approval' } }
        : changes.shape === 'continue'
          ? { ...base, status: 'needs_input', resumable: true, needs: { kind: 'continue' }, presentation: { kind: 'continue', text: raw } }
          : { ...base, status: 'needs_input', resumable: true, needs: { kind: 'input' }, presentation: { kind: 'question', text: raw } });
  const terminal = eventlog.appendEvent({ sessionId: owner.id, turn: 1, role: 'system', type: 'conversation_completed',
    data: { sourceUserSeq: origin.seq, reply: raw, ...(!changes.legacy ? { presentation,
      turnOutcome: { version: 2, id: presentation.outcomeId, status: presentation.status,
        resumable: presentation.resumable, ...(presentation.needs ? { needs: presentation.needs } : {}) },
    } : {}) } });
  const input = { sessionId: owner.id, originatingSourceUserSeq: origin.seq,
    pause: { kind: 'clarification' as const, question, options },
    publicDeliveryBinding: { awaitingEventId: awaiting.id, terminalEventId: terminal.id } };
  return { owner, origin, terminal, raw, input };
}

test('exact typed public question binding survives retained-work terminal and store restart', () => {
  const { owner, terminal, raw, input } = retainedQuestionBinding('restart');
  const packet = continuity.createTaskContinuityPacket(input);
  eventlog.closeEventLog();
  const store = new continuity.TaskContinuityStore();
  assert.deepEqual(store.peek({ sessionId: owner.id }), { status: 'available', packet });
  const reply = accepted(owner.id, 'Correct the title');
  eventlog.closeEventLog();
  const consumed = new continuity.TaskContinuityStore().consume(consumeInput(owner.id, reply.seq));
  assert.equal(consumed.status, 'consumed');
  if (consumed.status === 'consumed') assert.equal(consumed.packet.packetId, packet.packetId);
  const readback = eventlog.listEvents(owner.id, { types: ['conversation_completed'] })[0]!;
  assert.deepEqual(readback, terminal);
  assert.equal((readback.data.presentation as { text: string }).text, raw);
});

test('retained-work projection does not bind altered public questions, hidden options, foreign sources or other shapes', () => {
  for (const [suffix, changes] of [
    ['extra-visible-prose', { visible: 'Which correction should I make? Also publish the note.' }],
    ['different-question', { visible: 'Should I publish the note?' }],
    ['foreign-source', { foreignSource: true }],
    ['done', { shape: 'done' }],
    ['approval', { shape: 'approval' }],
    ['continue', { shape: 'continue' }],
    ['blocked', { shape: 'blocked' }],
    ['legacy', { legacy: true }],
  ] as const) {
    const { input } = retainedQuestionBinding(suffix, changes);
    assert.throws(() => continuity.createTaskContinuityPacket(input), /exact public ask and terminal/, suffix);
  }
  const { input } = retainedQuestionBinding('hidden-option');
  assert.throws(() => continuity.createTaskContinuityPacket({ ...input,
    pause: { ...input.pause, options: ['Publish the note', 'Correct the date'] },
  }), /exact public ask and terminal/);
});

test('malformed typed-looking terminals cannot authorize retained-work stripping in the store', () => {
  for (const corruption of ['version', 'missing-outcome', 'mismatched-outcome', 'missing-text', 'foreign-session'] as const) {
    const { terminal, input } = retainedQuestionBinding(`malformed-${corruption}`);
    const data = structuredClone(terminal.data);
    const presentation = data.presentation as Record<string, unknown>;
    if (corruption === 'version') presentation.version = 99;
    if (corruption === 'missing-outcome') delete data.turnOutcome;
    if (corruption === 'mismatched-outcome') (data.turnOutcome as Record<string, unknown>).status = 'done';
    if (corruption === 'missing-text') delete presentation.text;
    if (corruption === 'foreign-session') (presentation.identity as Record<string, unknown>).sessionId = 'foreign-session';
    // Model old/corrupted persisted bytes; ordinary event publication already
    // validates the pair and correctly refuses these shapes at append time.
    eventlog.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?')
      .run(JSON.stringify(data), terminal.id);
    assert.throws(() => continuity.createTaskContinuityPacket(input), /exact public ask and terminal/, corruption);
  }
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
    assert.deepEqual(continuity.readTaskContinuityClarificationSources({ sessionId: owner.id, packetId: packet.packetId }),
      { status: 'refused', reason: 'ambiguous_leaf' });
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

function deliveredQuestion(sessionId: string, sourceUserSeq: number, question: string, options: string[] = []) {
  const awaiting = eventlog.appendEvent({ sessionId, turn: 1, role: 'Clem', type: 'awaiting_user_input',
    data: { sourceUserSeq, question, options, purpose: 'clarification' } });
  const identity = { sessionId, turn: 1, sourceUserSeq };
  const presentation = presentationEventForOutcome({ version: 2, id: turnOutcomeId(identity), identity,
    status: 'needs_input', resumable: true, needs: { kind: 'input' }, presentation: { kind: 'question', text: question } });
  const terminal = eventlog.appendEvent({ sessionId, turn: 1, role: 'system', type: 'conversation_completed',
    data: { sourceUserSeq, reply: question, presentation, turnOutcome: { version: 2, id: presentation.outcomeId,
      status: presentation.status, resumable: presentation.resumable, needs: presentation.needs } } });
  return { awaitingEventId: awaiting.id, terminalEventId: terminal.id };
}

function clarificationChain(id: string, replies: string[] = ['Use the named report; increase the batch to 40.', 'Keep weekday timing.'],
  audience: Record<string, unknown> = {}) {
  const owner = session(id);
  const root = accepted(owner.id, 'Prepare the project.\nAsk for any missing facts.', false, audience);
  const base = Date.now() + 1_000;
  const expiresAt = new Date(base + 100_000).toISOString();
  const slot = { goalId: `goal:${owner.id}:${root.seq}`, revision: 0, questionId: `question:${root.seq}`, slotKey: 'reply' };
  const packets: ReturnType<typeof continuity.createTaskContinuityPacket>[] = [];
  const replySources: ReturnType<typeof accepted>[] = [];
  const makePacket = (source: ReturnType<typeof accepted>, index: number) => {
    const question = index === 0 ? 'Which report, batch size, timing and intent?' : 'What intent remains unresolved?';
    return continuity.createTaskContinuityPacket({
      sessionId: owner.id, originatingSourceUserSeq: source.seq,
      pause: { kind: 'clarification', question, slot },
      publicDeliveryBinding: deliveredQuestion(owner.id, source.seq, question),
      ...(index > 0 ? { lineage: { rootSourceUserSeq: root.seq, parentPacketId: packets[index - 1]!.packetId } } : {}),
      expiresAt,
    }, { now: new Date(base + index * 100).toISOString() });
  };
  packets.push(makePacket(root, 0));
  for (const text of replies) {
    const reply = accepted(owner.id, text, false, audience);
    replySources.push(reply);
    packets.push(makePacket(reply, packets.length));
  }
  return { owner, root, replySources, packets, leaf: packets.at(-1)!, base, expiresAt, slot };
}

function readChain(fixture: ReturnType<typeof clarificationChain>, consumingSourceUserSeq?: number) {
  return continuity.readTaskContinuityClarificationSources({ sessionId: fixture.owner.id, packetId: fixture.leaf.packetId,
    ...(consumingSourceUserSeq !== undefined ? { consumingSourceUserSeq } : {}) },
  { now: new Date(fixture.base + 2_000).toISOString() });
}

function packetAudit(sessionId: string) {
  return eventlog.openEventLog().prepare('SELECT * FROM task_continuity_packets WHERE session_id = ? ORDER BY created_at, packet_id').all(sessionId);
}

test('literal clarification chain retains every source amendment in order, frozen and without writes', () => {
  const fixture = clarificationChain('literal-chain', ['Report is named.\nIncrease immediate draft batch to 40.', 'Yes to timing; intent is still unclear.']);
  const before = packetAudit(fixture.owner.id);
  const changes = eventlog.openEventLog().prepare('SELECT total_changes() AS total').get();
  const result = readChain(fixture);
  assert.equal(result.status, 'verified');
  if (result.status !== 'verified') return;
  assert.equal(result.root.sourceUserSeq, fixture.root.seq);
  assert.equal(result.root.sourceEventId, fixture.root.id);
  assert.equal(result.root.text, fixture.root.data.text);
  assert.deepEqual(result.replies.map(source => [source.sourceUserSeq, source.sourceEventId, source.text]),
    fixture.replySources.map(source => [source.seq, source.id, source.data.text]));
  assert.deepEqual(result.packetIds, fixture.packets.map(packet => packet.packetId));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.root) && Object.isFrozen(result.replies)
    && result.replies.every(source => Object.isFrozen(source) && Object.isFrozen(source.previousDeliveredOptions))
    && Object.isFrozen(result.packetIds));
  assert.deepEqual(result.replies.map(source => source.previousDeliveredQuestion),
    fixture.packets.slice(0, -1).map(packet => packet.pause.question));
  assert.equal('capabilities' in result, false, 'literal evidence exposes no inherited effect authority');
  assert.deepEqual(readChain(fixture), result, 'repeated reads reproduce exact evidence');
  assert.deepEqual(packetAudit(fixture.owner.id), before);
  assert.deepEqual(eventlog.openEventLog().prepare('SELECT total_changes() AS total').get(), changes);
});

test('exact consumed leaf rehydrates literal chain after restart and TTL without a second claim', () => {
  const fixture = clarificationChain('consumed-chain');
  const open = readChain(fixture);
  const final = accepted(fixture.owner.id, 'Intent means a reply or a meeting request.');
  const consumed = continuity.consumeTaskContinuityPacket(consumeInput(fixture.owner.id, final.seq),
    { now: new Date(fixture.base + 3_000).toISOString() });
  assert.equal(consumed.status, 'consumed');
  const before = packetAudit(fixture.owner.id);
  eventlog.closeEventLog();
  const replay = continuity.readTaskContinuityClarificationSources({ sessionId: fixture.owner.id,
    packetId: fixture.leaf.packetId, consumingSourceUserSeq: final.seq },
  { now: new Date(fixture.base + 200_000).toISOString() });
  assert.equal(replay.status, 'verified');
  if (replay.status !== 'verified') return;
  const { consumedReply, ...replayedOpen } = replay;
  assert.deepEqual(replayedOpen, open, 'expiry cannot erase exact already-consumed audit history');
  assert.ok(consumedReply && Object.isFrozen(consumedReply) && Object.isFrozen(consumedReply.previousDeliveredOptions));
  assert.equal(consumedReply.sourceUserSeq, final.seq);
  assert.equal(consumedReply.sourceEventId, final.id);
  assert.equal(consumedReply.text, final.data.text);
  assert.equal(consumedReply.previousDeliveredQuestion, fixture.leaf.pause.question);
  assert.equal(consumedReply.dataHash.length, 64);
  assert.deepEqual(packetAudit(fixture.owner.id), before);
  assert.deepEqual(readChain(fixture), { status: 'refused', reason: 'retired_hop' });
  const later = accepted(fixture.owner.id, 'A different request.');
  assert.deepEqual(readChain(fixture, later.seq), { status: 'refused', reason: 'consumed_leaf_mismatch' });
});

test('incoming reply is an exact frozen audience edge and reads without claiming the leaf', () => {
  const audience = { source: 'channel:discord', userId: 'fixture-owner', conversationKey: 'discord:fixture-channel' };
  const fixture = clarificationChain('literal-next-reply', undefined, audience);
  accepted(fixture.owner.id, 'Synthetic housekeeping before.', true);
  const next = accepted(fixture.owner.id, 'Yes.\nKeep the increase to 40.', false, audience);
  accepted(fixture.owner.id, 'Synthetic housekeeping after.', true);
  const before = packetAudit(fixture.owner.id);
  const changes = eventlog.openEventLog().prepare('SELECT total_changes() AS total').get();
  const input = { sessionId: fixture.owner.id, packetId: fixture.leaf.packetId, nextReplySourceUserSeq: next.seq };
  const result = continuity.readTaskContinuityClarificationSources(input, { now: new Date(fixture.base + 2_000).toISOString() });
  assert.equal(result.status, 'verified');
  if (result.status !== 'verified') return;
  assert.ok(result.nextReply && Object.isFrozen(result.nextReply) && Object.isFrozen(result.nextReply.previousDeliveredOptions));
  assert.equal(result.nextReply.sourceUserSeq, next.seq);
  assert.equal(result.nextReply.sourceEventId, next.id);
  assert.equal(result.nextReply.text, next.data.text);
  assert.equal(result.nextReply.previousDeliveredQuestion, fixture.leaf.pause.question);
  assert.equal(result.replies.length, fixture.replySources.length, 'unconsumed incoming answer is separate evidence');
  assert.deepEqual(continuity.readTaskContinuityClarificationSources(input,
    { now: new Date(fixture.base + 2_000).toISOString() }), result);
  assert.deepEqual(packetAudit(fixture.owner.id), before);
  assert.deepEqual(eventlog.openEventLog().prepare('SELECT total_changes() AS total').get(), changes);
  assert.deepEqual(continuity.readTaskContinuityClarificationSources({ ...input, consumingSourceUserSeq: next.seq }),
    { status: 'refused', reason: 'invalid_input' });
});

test('incoming reply refuses wrong audience, skipped or stale human source and controls before publication', () => {
  const audience = { source: 'channel:discord', userId: 'fixture-owner', conversationKey: 'discord:fixture-channel' };
  for (const kind of ['wrong-user', 'wrong-channel', 'missing-user', 'foreign-session', 'synthetic', 'wrong-seq',
    'skip', 'later', 'malformed-later', 'control', 'empty'] as const) {
    const fixture = clarificationChain(`literal-next-${kind}`, [], audience);
    if (kind === 'skip') accepted(fixture.owner.id, 'An unrelated human message.', false, audience);
    const inputAudience: Record<string, unknown> = { ...audience };
    if (kind === 'wrong-user') inputAudience.userId = 'different-owner';
    if (kind === 'wrong-channel') inputAudience.conversationKey = 'discord:different-channel';
    if (kind === 'missing-user') delete inputAudience.userId;
    if (kind === 'control') Object.assign(inputAudience, { source: 'mobile_approval', approvalId: 'fixture-card', decision: 'approve' });
    const reply = accepted(kind === 'foreign-session' ? session('literal-next-foreign').id : fixture.owner.id,
      kind === 'empty' ? '  ' : 'Yes, and increase the batch.', kind === 'synthetic', inputAudience);
    if (kind === 'later' || kind === 'malformed-later') {
      const later = accepted(fixture.owner.id, 'A later human request.', false, audience);
      if (kind === 'malformed-later') eventlog.openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?').run('{', later.seq);
    }
    const before = packetAudit(fixture.owner.id);
    const result = continuity.readTaskContinuityClarificationSources({ sessionId: fixture.owner.id,
      packetId: fixture.leaf.packetId, nextReplySourceUserSeq: kind === 'wrong-seq' ? fixture.root.seq : reply.seq },
    { now: new Date(fixture.base + 2_000).toISOString() });
    assert.equal(result.status, 'refused', kind);
    assert.deepEqual(packetAudit(fixture.owner.id), before, kind);
  }
});

test('public question cadence and options remain literal with the accepted amendment after consumed restart', () => {
  const owner = session('literal-public-cadence');
  const root = accepted(owner.id, 'Prepare the project report.');
  const base = Date.now() + 1_000;
  const slot = { goalId: 'cadence-goal', revision: 0, questionId: 'cadence-question', slotKey: 'reply' };
  const question = 'Use CEDAR BATCH LOG?\nTiming is 2026-10-06 09:00 America/Los_Angeles; quantity 10–12?\nWhat does RGL mean?';
  const options = ['Confirm timing\nKeep weekday cadence', 'Change timing'];
  const first = continuity.createTaskContinuityPacket({ sessionId: owner.id, originatingSourceUserSeq: root.seq,
    pause: { kind: 'clarification', question, options, slot },
    publicDeliveryBinding: deliveredQuestion(owner.id, root.seq, question, options) }, { now: new Date(base).toISOString() });
  const amendment = accepted(owner.id, 'Yes.\nChange the batch to 14–16.');
  const residual = 'Keep weekday timing. What does RGL mean?';
  const leaf = continuity.createTaskContinuityPacket({ sessionId: owner.id, originatingSourceUserSeq: amendment.seq,
    pause: { kind: 'clarification', question: residual, slot },
    lineage: { rootSourceUserSeq: root.seq, parentPacketId: first.packetId }, expiresAt: first.expiresAt,
    publicDeliveryBinding: deliveredQuestion(owner.id, amendment.seq, residual) }, { now: new Date(base + 100).toISOString() });
  const read = () => continuity.readTaskContinuityClarificationSources({ sessionId: owner.id, packetId: leaf.packetId },
    { now: new Date(base + 2_000).toISOString() });
  const open = read();
  assert.equal(open.status, 'verified');
  if (open.status !== 'verified') return;
  assert.equal(open.replies[0]!.text, amendment.data.text);
  assert.equal(open.replies[0]!.previousDeliveredQuestion, question);
  assert.deepEqual(open.replies[0]!.previousDeliveredOptions, options);
  assert.equal(open.root.text.includes('09:00'), false, 'the cadence exists only in the actual delivered prior question');
  const final = accepted(owner.id, 'RGL means Release Gate Ledger. Use 15 cases.');
  assert.equal(continuity.consumeTaskContinuityPacket(consumeInput(owner.id, final.seq),
    { now: new Date(base + 3_000).toISOString() }).status, 'consumed');
  eventlog.closeEventLog();
  const replay = continuity.readTaskContinuityClarificationSources({ sessionId: owner.id, packetId: leaf.packetId,
    consumingSourceUserSeq: final.seq }, { now: new Date(base + 200_000_000).toISOString() });
  assert.equal(replay.status, 'verified');
  if (replay.status !== 'verified') return;
  const { consumedReply, ...replayedOpen } = replay;
  assert.deepEqual(replayedOpen, open);
  assert.equal(consumedReply?.text, final.data.text);
  assert.equal(consumedReply?.previousDeliveredQuestion, residual);
});

test('unbound historical parent questions cannot masquerade as publicly delivered answer context', () => {
  const fixture = clarificationChain('literal-unbound-public', ['Yes, use it.']);
  eventlog.openEventLog().prepare('UPDATE task_continuity_packets SET public_awaiting_event_id = NULL, public_terminal_event_id = NULL WHERE packet_id = ?')
    .run(fixture.packets[0]!.packetId);
  assert.deepEqual(readChain(fixture), { status: 'refused', reason: 'unbound_public_question' });
  const rootOnly = clarificationChain('literal-next-unbound', []);
  eventlog.openEventLog().prepare('UPDATE task_continuity_packets SET public_awaiting_event_id = NULL, public_terminal_event_id = NULL WHERE packet_id = ?')
    .run(rootOnly.leaf.packetId);
  const reply = accepted(rootOnly.owner.id, 'Yes.');
  assert.deepEqual(continuity.readTaskContinuityClarificationSources({ sessionId: rootOnly.owner.id,
    packetId: rootOnly.leaf.packetId, nextReplySourceUserSeq: reply.seq }, { now: new Date(rootOnly.base + 2_000).toISOString() }),
  { status: 'refused', reason: 'unbound_public_question' });
});

test('aggregate source bound includes literal delivered questions and every public option', () => {
  const owner = session('literal-public-size-bound');
  const root = accepted(owner.id, 'Prepare the report.');
  const base = Date.now() + 1_000;
  const slot = { goalId: 'public-size-goal', revision: 0, questionId: 'public-size-question', slotKey: 'reply' };
  const question = 'Q'.repeat(4_000);
  const options = Array.from({ length: 8 }, (_, index) => `${index}${'o'.repeat(499)}`);
  let leaf = continuity.createTaskContinuityPacket({ sessionId: owner.id, originatingSourceUserSeq: root.seq,
    pause: { kind: 'clarification', question, options, slot },
    publicDeliveryBinding: deliveredQuestion(owner.id, root.seq, question, options) }, { now: new Date(base).toISOString() });
  for (let index = 0; index < 4; index += 1) {
    const reply = accepted(owner.id, 'Yes.');
    leaf = continuity.createTaskContinuityPacket({ sessionId: owner.id, originatingSourceUserSeq: reply.seq,
      pause: { kind: 'clarification', question, options, slot },
      publicDeliveryBinding: deliveredQuestion(owner.id, reply.seq, question, options),
      lineage: { rootSourceUserSeq: root.seq, parentPacketId: leaf.packetId }, expiresAt: leaf.expiresAt },
    { now: new Date(base + (index + 1) * 100).toISOString() });
  }
  const before = packetAudit(owner.id);
  assert.deepEqual(continuity.readTaskContinuityClarificationSources({ sessionId: owner.id, packetId: leaf.packetId },
    { now: new Date(base + 2_000).toISOString() }), { status: 'refused', reason: 'source_chain_limit' });
  assert.deepEqual(packetAudit(owner.id), before, 'overflow refuses complete context rather than truncating it');
});

test('raw blank public options cannot evade the delivered option-count bound', () => {
  const fixture = clarificationChain('literal-public-options-count', []);
  const db = eventlog.openEventLog();
  const row = db.prepare('SELECT public_awaiting_event_id AS awaitingId FROM task_continuity_packets WHERE packet_id = ?')
    .get(fixture.leaf.packetId) as { awaitingId: string };
  const awaiting = eventlog.getEvent(row.awaitingId)!;
  db.prepare('UPDATE events SET data_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...awaiting.data, options: Array.from({ length: 9 }, () => '') }), awaiting.id);
  assert.equal(continuity.peekTaskContinuityPacket({ sessionId: fixture.owner.id }).status, 'available',
    'canonical normalized option comparison alone filters out this raw overflow');
  const reply = accepted(fixture.owner.id, 'Yes.');
  const before = packetAudit(fixture.owner.id);
  assert.deepEqual(continuity.readTaskContinuityClarificationSources({ sessionId: fixture.owner.id,
    packetId: fixture.leaf.packetId, nextReplySourceUserSeq: reply.seq }, { now: new Date(fixture.base + 2_000).toISOString() }),
  { status: 'refused', reason: 'unbound_public_question' });
  assert.deepEqual(packetAudit(fixture.owner.id), before);
});

test('consumed final reply is included in the aggregate literal context bound', () => {
  const fixture = clarificationChain('literal-consumed-size', []);
  const reply = accepted(fixture.owner.id, 'x'.repeat(continuity.MAX_CLARIFICATION_SOURCE_CHAIN_CHARS));
  assert.equal(continuity.consumeTaskContinuityPacket(consumeInput(fixture.owner.id, reply.seq),
    { now: new Date(fixture.base + 2_000).toISOString() }).status, 'consumed');
  const before = packetAudit(fixture.owner.id);
  assert.deepEqual(readChain(fixture, reply.seq), { status: 'refused', reason: 'source_chain_limit' });
  assert.deepEqual(packetAudit(fixture.owner.id), before);
});

test('unchained legacy clarification preserves its literal root with no invented replies', () => {
  const owner = session('literal-unchained');
  const origin = accepted(owner.id, 'Inspect this request.');
  const packet = createFullPacket(owner.id, origin.seq, 'legacy');
  const result = continuity.readTaskContinuityClarificationSources({ sessionId: owner.id, packetId: packet.packetId });
  assert.equal(result.status, 'verified');
  if (result.status !== 'verified') return;
  assert.equal(result.root.text, origin.data.text);
  assert.deepEqual(result.replies, []);
});

test('unknown or foreign packet cannot fall back to a root-only context', () => {
  const fixture = clarificationChain('literal-unknown');
  assert.deepEqual(continuity.readTaskContinuityClarificationSources({ sessionId: fixture.owner.id, packetId: 'unknown' }),
    { status: 'refused', reason: 'unknown_packet' });
  assert.deepEqual(continuity.readTaskContinuityClarificationSources({ sessionId: session('literal-foreign').id,
    packetId: fixture.leaf.packetId }), { status: 'refused', reason: 'unknown_packet' });
  assert.deepEqual(readChain(fixture, fixture.replySources[0]!.seq), { status: 'refused', reason: 'consumed_leaf_mismatch' },
    'an open leaf cannot be admitted as if it were consumed');
});

for (const [field, value] of [['goalId', 'wrong-goal'], ['revision', 1], ['questionId', 'wrong-question'], ['slotKey', 'wrong-slot']] as const) {
  test(`clarification chain refuses changed ${field}`, () => {
    const fixture = clarificationChain(`literal-slot-${field}`);
    eventlog.openEventLog().prepare('UPDATE task_continuity_packets SET pause_slot_json = ? WHERE packet_id = ?')
      .run(JSON.stringify({ ...fixture.slot, [field]: value }), fixture.leaf.packetId);
    assert.deepEqual(readChain(fixture), { status: 'refused', reason: 'slot_changed' });
  });
}

test('clarification chain rejects malformed slot and wrong parent/root event identity', () => {
  for (const corruption of ['slot', 'parent', 'root-event', 'origin-event'] as const) {
    const fixture = clarificationChain(`literal-bad-${corruption}`);
    const db = eventlog.openEventLog();
    if (corruption === 'slot') db.prepare('UPDATE task_continuity_packets SET pause_slot_json = ? WHERE packet_id = ?')
      .run('{"revision":"unknown"}', fixture.leaf.packetId);
    if (corruption === 'parent') db.prepare('UPDATE task_continuity_packets SET parent_packet_id = ? WHERE packet_id = ?')
      .run(fixture.packets[0]!.packetId, fixture.leaf.packetId);
    if (corruption === 'root-event') db.prepare('UPDATE task_continuity_packets SET root_source_event_id = ? WHERE packet_id = ?')
      .run(fixture.replySources[0]!.id, fixture.leaf.packetId);
    if (corruption === 'origin-event') db.prepare('UPDATE task_continuity_packets SET originating_source_event_id = ? WHERE packet_id = ?')
      .run(fixture.root.id, fixture.leaf.packetId);
    assert.equal(readChain(fixture).status, 'refused', corruption);
  }
});

test('clarification chain refuses an ancestor without its exact supersession receipt', () => {
  const fixture = clarificationChain('literal-supersession');
  eventlog.openEventLog().prepare('UPDATE task_continuity_packets SET superseded_at = ? WHERE packet_id = ?')
    .run(new Date(fixture.base + 500).toISOString(), fixture.packets[0]!.packetId);
  assert.deepEqual(readChain(fixture), { status: 'refused', reason: 'unbound_supersession' });
});

test('expired, retired and nonclarification ancestors cannot be used as a source chain', () => {
  for (const state of ['expired', 'dismissed', 'approval', 'recovery'] as const) {
    const fixture = clarificationChain(`literal-retired-${state}`);
    const db = eventlog.openEventLog();
    if (state === 'expired') db.prepare('UPDATE task_continuity_packets SET expired_at = ? WHERE packet_id = ?')
      .run(new Date(fixture.base + 1_000).toISOString(), fixture.packets[0]!.packetId);
    if (state === 'dismissed') db.prepare('UPDATE task_continuity_packets SET dismissed_at = ?, dismissed_reason = ? WHERE packet_id = ?')
      .run(new Date(fixture.base + 1_000).toISOString(), 'invalidated', fixture.packets[0]!.packetId);
    if (state === 'approval' || state === 'recovery') db.prepare('UPDATE task_continuity_packets SET pause_kind = ? WHERE packet_id = ?')
      .run(state, fixture.packets[0]!.packetId);
    assert.equal(readChain(fixture).status, 'refused', state);
  }
  const expired = clarificationChain('literal-clock-expired');
  const before = packetAudit(expired.owner.id);
  assert.deepEqual(continuity.readTaskContinuityClarificationSources({ sessionId: expired.owner.id,
    packetId: expired.leaf.packetId }, { now: expired.expiresAt }), { status: 'refused', reason: 'expired_hop' });
  assert.deepEqual(packetAudit(expired.owner.id), before, 'expiry inspection remains SELECT-only');
});

test('wrong sealed answering audience or literal source mutation refuses the complete chain', () => {
  const fixture = clarificationChain('literal-audience', undefined,
    { source: 'channel:discord', userId: 'fixture-owner', conversationKey: 'discord:fixture-channel' });
  const changed = fixture.replySources[0]!;
  eventlog.openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?')
    .run(JSON.stringify({ ...changed.data, userId: 'foreign-owner' }), changed.seq);
  assert.deepEqual(readChain(fixture), { status: 'refused', reason: 'malformed_chain' });
});

test('an intervening formerly synthetic human source breaks exact adjacency', () => {
  const owner = session('literal-adjacency');
  const root = accepted(owner.id, 'Prepare the project.');
  const base = Date.now() + 1_000;
  const slot = { goalId: 'fixture-goal', revision: 0, questionId: 'fixture-question', slotKey: 'reply' };
  const first = continuity.createTaskContinuityPacket({ sessionId: owner.id, originatingSourceUserSeq: root.seq,
    pause: { kind: 'clarification', question: 'Which scope?', slot },
    publicDeliveryBinding: deliveredQuestion(owner.id, root.seq, 'Which scope?') }, { now: new Date(base).toISOString() });
  const intervening = accepted(owner.id, 'Unrelated request.', true);
  const reply = accepted(owner.id, 'Use scope B.');
  const leaf = continuity.createTaskContinuityPacket({ sessionId: owner.id, originatingSourceUserSeq: reply.seq,
    lineage: { rootSourceUserSeq: root.seq, parentPacketId: first.packetId },
    pause: { kind: 'clarification', question: 'Which destination?', slot }, expiresAt: first.expiresAt,
    publicDeliveryBinding: deliveredQuestion(owner.id, reply.seq, 'Which destination?') },
  { now: new Date(base + 100).toISOString() });
  assert.equal(continuity.readTaskContinuityClarificationSources({ sessionId: owner.id, packetId: leaf.packetId }).status, 'verified');
  eventlog.openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?')
    .run(JSON.stringify({ ...intervening.data, synthetic: false }), intervening.seq);
  assert.equal(continuity.readTaskContinuityClarificationSources({ sessionId: owner.id, packetId: leaf.packetId }).status, 'refused');
});

test('literal chain refuses formal-control sources and bounded depth/character overflow', () => {
  const control = clarificationChain('literal-control', ['Approve the card.'], { source: 'mobile_approval', approvalId: 'fixture-card', decision: 'approve' });
  assert.deepEqual(readChain(control), { status: 'refused', reason: 'control_source' });
  const depth = clarificationChain('literal-depth', Array.from({ length: continuity.MAX_CLARIFICATION_SOURCE_CHAIN_PACKETS }, (_, index) => `Reply ${index}.`));
  assert.deepEqual(readChain(depth), { status: 'refused', reason: 'source_chain_limit' });
  const chars = clarificationChain('literal-chars', ['x'.repeat(continuity.MAX_CLARIFICATION_SOURCE_CHAIN_CHARS)]);
  assert.deepEqual(readChain(chars), { status: 'refused', reason: 'source_chain_limit' });
});

test('a consumed ancestor never masquerades as an exact superseded clarification hop', () => {
  const fixture = clarificationChain('literal-consumed-ancestor');
  const child = fixture.replySources[0]!;
  eventlog.openEventLog().prepare(`UPDATE task_continuity_packets SET consumed_at = ?,
    consumed_by_source_user_seq = ?, consumed_by_source_event_id = ?,
    consumer_audience_hash = (SELECT origin_audience_hash FROM task_continuity_packets WHERE packet_id = ?),
    resolver_version = ?, resolution_disposition = ?, resolution_semantic_input_hash = ? WHERE packet_id = ?`)
    .run(new Date(fixture.base + 500).toISOString(), child.seq, child.id, fixture.packets[1]!.packetId,
      FROZEN_RESOLUTION.resolverVersion, FROZEN_RESOLUTION.disposition, FROZEN_RESOLUTION.semanticInputHash,
      fixture.packets[0]!.packetId);
  assert.deepEqual(readChain(fixture), { status: 'refused', reason: 'retired_hop' });
});

test('exact consumed-leaf replay refuses changed consumer identity and formal-control consumers', () => {
  const fixture = clarificationChain('literal-consumer-mutation');
  const final = accepted(fixture.owner.id, 'The remaining answer.');
  continuity.consumeTaskContinuityPacket(consumeInput(fixture.owner.id, final.seq),
    { now: new Date(fixture.base + 3_000).toISOString() });
  eventlog.openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?')
    .run(JSON.stringify({ ...final.data, text: 'Changed answer.' }), final.seq);
  assert.deepEqual(readChain(fixture, final.seq), { status: 'refused', reason: 'consumed_leaf_mismatch' });

  const control = clarificationChain('literal-consumer-control');
  const decision = accepted(control.owner.id, 'Approve.', false, { source: 'mobile_approval', approvalId: 'fixture-card', decision: 'approve' });
  assert.equal(continuity.consumeTaskContinuityPacket(consumeInput(control.owner.id, decision.seq),
    { now: new Date(control.base + 3_000).toISOString() }).status, 'consumed');
  assert.deepEqual(readChain(control, decision.seq), { status: 'refused', reason: 'control_source' });
});

test('read-only clarification source lookup never installs missing schema', async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  try {
    const store = new continuity.TaskContinuityStore(() => db);
    assert.deepEqual(store.readClarificationSources({ sessionId: 'fixture', packetId: 'unknown' }),
      { status: 'refused', reason: 'unavailable' });
    assert.deepEqual(db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table'), []);
  } finally { db.close(); }
});

test('a synthetic input reads as having consumed nothing, never as an invalid consumer', () => {
  const owner = session('synthetic-reader');
  const origin = accepted(owner.id, 'Run the export and ask which account if unsure.');
  const packet = createFullPacket(owner.id, origin.seq, 'export');
  const hidden = accepted(owner.id, '[approval-resume] The approved action ran; finish the request.', true);
  assert.deepEqual(
    continuity.readConsumedTaskContinuityPacket({ sessionId: owner.id, consumingSourceUserSeq: hidden.seq }),
    { status: 'none' },
    'a hidden machine source is not the owner\'s answer and consumed nothing',
  );
  const reply = accepted(owner.id, 'The second one.');
  const consumed = continuity.consumeTaskContinuityPacket(consumeInput(owner.id, reply.seq));
  assert.equal(consumed.status, 'consumed', 'the question is still open for the next real reply');
  if (consumed.status === 'consumed') assert.equal(consumed.packet.packetId, packet.packetId);
  assert.equal(
    continuity.readConsumedTaskContinuityPacket({ sessionId: owner.id, consumingSourceUserSeq: hidden.seq + 1000 }).status,
    'invalid_source',
    'a missing source is still invalid',
  );
});
