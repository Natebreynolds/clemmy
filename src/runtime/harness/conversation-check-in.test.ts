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
