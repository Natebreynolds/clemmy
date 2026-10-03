/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/conversation-check-in.test.ts
 *
 * Clem's own mid-task check-ins, landing IN THREAD.
 *
 * The preamble speaks once BEFORE the work. This speaks DURING it, as many
 * times as the work warrants, so someone who walks away can reopen the session
 * and read what happened while they were gone. It is deliberately not a
 * notification: a check-in is ambient progress in the conversation, not an
 * interruption.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-check-in-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-check-in\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { actionBus } = await import('../action-bus.js');
const { projectHarnessEventsForPublic } = await import('./public-presentation.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;
function turn(text = 'reconcile the sheet') {
  const session = eventlog.createSession({ id: `check-in-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text },
  });
  return { session, source };
}

function observeCheckIns(sessionId: string) {
  const rows: Array<{
    kind: 'harness.event' | 'harness.public_event';
    event: import('./eventlog.js').EventRow;
    inTransaction: boolean;
    persisted: boolean;
  }> = [];
  const detach = actionBus.subscribe((signal) => {
    if (
      (signal.kind !== 'harness.event' && signal.kind !== 'harness.public_event')
      || signal.sessionId !== sessionId
      || signal.event.type !== 'conversation_check_in'
    ) return;
    rows.push({
      kind: signal.kind,
      event: signal.event,
      inTransaction: eventlog.openEventLog().inTransaction,
      persisted: eventlog.listEvents(sessionId, { types: ['conversation_check_in'] })
        .some((event) => event.id === signal.event.id),
    });
  });
  return { rows, detach };
}

test('a check-in publishes its exact source once per bus channel after commit', () => {
  const { session, source } = turn();
  // A later request in the reusable session must not take ownership of this note.
  eventlog.appendEvent({
    sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'a separate request' },
  });
  const observed = observeCheckIns(session.id);
  try {
    const result = eventlog.appendConversationCheckIn({
      source,
      text: 'Found three unmatched rows; checking their source records next.',
    });
    assert.ok(result.inserted && result.event);
    assert.deepEqual(observed.rows.map(({ kind, event }) => [kind, event.id]), [
      ['harness.event', result.event.id],
      ['harness.public_event', result.event.id],
    ]);
    for (const row of observed.rows) {
      assert.equal(row.inTransaction, false, 'listeners run only after the insert commits');
      assert.equal(row.persisted, true, 'the published row can already be read');
      assert.equal(row.event.sessionId, source.sessionId);
      assert.equal(row.event.turn, source.turn);
      assert.equal(row.event.parentEventId, row.kind === 'harness.event' ? source.id : null,
        'the public projection keeps its existing private-parent redaction');
      assert.equal(row.event.data.sourceUserSeq, source.seq);
    }
    assert.equal(eventlog.listEvents(session.id, { types: ['conversation_completed'] }).length, 0);
  } finally {
    observed.detach();
  }
});

test('check-in publication follows the managed outer commit and discards rollback', () => {
  const { session, source } = turn();
  const observed = observeCheckIns(session.id);
  try {
    assert.throws(() => eventlog.withEventPublicationTransaction(() => {
      eventlog.appendConversationCheckIn({ source, text: 'This transaction will roll back.' });
      assert.equal(observed.rows.length, 0, 'no live prose before the outer commit');
      throw new Error('roll back fixture');
    }), /roll back fixture/);
    assert.equal(observed.rows.length, 0);
    assert.equal(eventlog.listEvents(session.id, { types: ['conversation_check_in'] }).length, 0);

    const result = eventlog.withEventPublicationTransaction(() => {
      const inserted = eventlog.appendConversationCheckIn({ source, text: 'The retained finding is ready.' });
      assert.equal(observed.rows.length, 0, 'publication still waits for the outer commit');
      return inserted;
    });
    assert.ok(result.event);
    assert.deepEqual(observed.rows.map(({ kind, event }) => [kind, event.id]), [
      ['harness.event', result.event.id],
      ['harness.public_event', result.event.id],
    ]);
    assert.ok(observed.rows.every((row) => row.persisted && !row.inTransaction));
  } finally {
    observed.detach();
  }
});

test('capped and rejected check-ins publish nothing', () => {
  const { session, source } = turn();
  for (let i = 0; i < eventlog.MAX_CONVERSATION_CHECK_INS_PER_TURN; i += 1) {
    eventlog.appendConversationCheckIn({ source, text: `Existing note ${i}` });
  }
  const synthetic = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'CONTINUE', synthetic: true },
  });
  const observed = observeCheckIns(session.id);
  try {
    assert.deepEqual(eventlog.appendConversationCheckIn({ source, text: 'Overflow note' }), {
      event: null, inserted: false, reason: 'cap_reached',
    });
    for (const invalidSource of [synthetic, { ...source, id: 'wrong-parent' }]) {
      assert.throws(() => eventlog.appendConversationCheckIn({
        source: invalidSource, text: 'Rejected source',
      }), /exact real user source/);
    }
    assert.throws(() => eventlog.appendConversationCheckIn({ source, text: '   ' }), /not safe public text/);
    assert.equal(observed.rows.length, 0);
    assert.equal(eventlog.listEvents(session.id, { types: ['conversation_check_in'] }).length,
      eventlog.MAX_CONVERSATION_CHECK_INS_PER_TURN);
  } finally {
    observed.detach();
  }
});

test('a check-in lands in thread, authored by Clem and parented to its source', () => {
  const { session, source } = turn();
  const result = eventlog.appendConversationCheckIn({
    source: { id: source.id, seq: source.seq, sessionId: session.id, turn: source.turn },
    text: 'Read the Log tab — 34 rows. Paging Slack now to match them up.',
  });
  assert.equal(result.inserted, true);
  assert.equal(result.event?.role, 'Clem');
  assert.equal(result.event?.parentEventId, source.id);
  assert.equal(result.event?.turn, source.turn);

  // The whole requirement: reopen the session later and it is still there.
  const projected = projectHarnessEventsForPublic(eventlog.listEvents(session.id));
  const checkIns = projected.filter((e) => e.type === 'conversation_check_in');
  assert.equal(checkIns.length, 1, 'the check-in survives the public projection');
  assert.equal(
    (checkIns[0]!.data as { text?: string }).text,
    'Read the Log tab — 34 rows. Paging Slack now to match them up.',
  );
});

test('several check-ins accumulate — this is not the preamble', () => {
  const { session, source } = turn();
  const ref = { id: source.id, seq: source.seq, sessionId: session.id, turn: source.turn };
  for (const note of ['Reading the Log tab.', 'Slack paged, 8 pages.', 'Found 3 orphan rows.']) {
    assert.equal(eventlog.appendConversationCheckIn({ source: ref, text: note }).inserted, true);
  }
  const projected = projectHarnessEventsForPublic(eventlog.listEvents(session.id))
    .filter((e) => e.type === 'conversation_check_in');
  assert.deepEqual(
    projected.map((e) => (e.data as { text?: string }).text),
    ['Reading the Log tab.', 'Slack paged, 8 pages.', 'Found 3 orphan rows.'],
    'order is the order she said them',
  );
});

test('a looping model cannot turn a conversation into a log', () => {
  const { session, source } = turn();
  const ref = { id: source.id, seq: source.seq, sessionId: session.id, turn: source.turn };
  const cap = eventlog.MAX_CONVERSATION_CHECK_INS_PER_TURN;
  for (let i = 0; i < cap; i += 1) {
    assert.equal(eventlog.appendConversationCheckIn({ source: ref, text: `note ${i}` }).inserted, true);
  }
  const overflow = eventlog.appendConversationCheckIn({ source: ref, text: 'one too many' });
  assert.equal(overflow.inserted, false);
  assert.equal(overflow.reason, 'cap_reached', 'the caller is told, so it never believes it spoke');
  assert.equal(overflow.event, null);
});

test('a check-in must come from the exact real user source', () => {
  const { session, source } = turn();
  // A synthetic source is not a person asking for something.
  const synthetic = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'CONTINUE', synthetic: true },
  });
  assert.throws(() => eventlog.appendConversationCheckIn({
    source: { id: synthetic.id, seq: synthetic.seq, sessionId: session.id, turn: synthetic.turn },
    text: 'should not land',
  }), /exact real user source/);

  // A mismatched id is not that source either.
  assert.throws(() => eventlog.appendConversationCheckIn({
    source: { id: 'not-the-source', seq: source.seq, sessionId: session.id, turn: source.turn },
    text: 'should not land',
  }), /exact real user source/);
});

test('a check-in carries no authority and no unsafe text', () => {
  const { session, source } = turn();
  const ref = { id: source.id, seq: source.seq, sessionId: session.id, turn: source.turn };
  assert.throws(() => eventlog.appendConversationCheckIn({ source: ref, text: '   ' }),
    /not safe public text/, 'an empty note is not a check-in');
  assert.throws(() => eventlog.appendConversationCheckIn({ source: ref, text: 'x'.repeat(5_000) }),
    /not safe public text/, 'a check-in is a sentence, not a report');

  eventlog.appendConversationCheckIn({ source: ref, text: 'Halfway through the Slack pages.' });
  const [projected] = projectHarnessEventsForPublic(eventlog.listEvents(session.id))
    .filter((e) => e.type === 'conversation_check_in');
  // A closed key set: no status, outcome, need, approval or effect can ride in.
  assert.deepEqual(Object.keys(projected!.data).sort(), ['kind', 'sourceUserSeq', 'text', 'version']);
});

test('a forged generic row cannot reach a thread by resembling a check-in', () => {
  const { session } = turn();
  // No parent, no Clem authorship — the projection floor must reject it even
  // though the payload has the right shape.
  const forged = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'system', type: 'heartbeat',
    data: { version: 1, kind: 'check_in', sourceUserSeq: 1, text: 'I am not Clem' },
  });
  const projected = projectHarnessEventsForPublic([forged]);
  const leaked = projected.some((e) => JSON.stringify(e.data).includes('I am not Clem'));
  assert.equal(leaked, false, 'a generic row must not become public prose');
});
