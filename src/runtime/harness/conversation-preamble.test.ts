import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-conversation-preamble-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_CHAT_AUTO_RESUME = 'on';

const {
  appendConversationPreambleOnce,
  appendEvent,
  beginRunAttempt,
  closeEventLog,
  createSession,
  listEvents,
  recordRunAttemptUserInput,
} = await import('./eventlog.js');
const { actionBus } = await import('../action-bus.js');
const {
  projectHarnessEventForPublic,
  publicConversationPreambleData,
} = await import('./public-presentation.js');
const { acceptedSourceOutcome } = await import('./accepted-source-outcome.js');
const { recoverInterruptedChatRuns } = await import('./restart-recovery.js');

test.after(() => {
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function acceptedSource(sessionId: string, turn = 1) {
  return appendEvent({
    sessionId,
    turn,
    role: 'user',
    type: 'user_input_received',
    data: { text: `accepted source ${turn}` },
  });
}

test('exact-source CAS persists and broadcasts one closed nonterminal preamble', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const source = acceptedSource(session.id, 7);
  const raw: string[] = [];
  const publicRows: string[] = [];
  const detach = actionBus.subscribe((event) => {
    if (event.sessionId !== session.id) return;
    if (event.kind === 'harness.event' && event.event.type === 'conversation_preamble') {
      raw.push(event.event.id);
    }
    if (event.kind === 'harness.public_event' && event.event.type === 'conversation_preamble') {
      publicRows.push(event.event.id);
    }
  });
  try {
    const first = appendConversationPreambleOnce({
      source,
      text: 'I remember the earlier attempt. I’m starting with the exact Ventura request now.',
      intentKey: 'intent:ventura:1',
    });
    const replay = appendConversationPreambleOnce({
      source,
      text: 'I remember the earlier attempt. I’m starting with the exact Ventura request now.',
      intentKey: 'intent:ventura:1',
    });
    assert.equal(first.inserted, true);
    assert.equal(replay.inserted, false);
    assert.equal(replay.event.id, first.event.id);
    assert.equal(first.event.sessionId, source.sessionId);
    assert.equal(first.event.turn, source.turn);
    assert.equal(first.event.role, 'Clem');
    assert.equal(first.event.parentEventId, source.id);
    assert.deepEqual(first.event.data, {
      version: 1,
      kind: 'pre_execution',
      sourceUserSeq: source.seq,
      text: 'I remember the earlier attempt. I’m starting with the exact Ventura request now.',
      intentKey: 'intent:ventura:1',
    });
    assert.equal(listEvents(session.id, { types: ['conversation_preamble'] }).length, 1);
    assert.deepEqual(raw, [first.event.id], 'the exact retry does not rebroadcast the raw row');
    assert.deepEqual(publicRows, [first.event.id], 'the exact retry does not rebroadcast public prose');
    assert.equal(listEvents(session.id, { types: ['conversation_completed'] }).length, 0);
  } finally {
    detach();
  }
});

test('CAS refuses identity drift, conflicting prose, synthetic sources, and generic append bypasses', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const source = acceptedSource(session.id, 2);
  appendConversationPreambleOnce({ source, text: 'I have the request and I’m beginning now.' });

  assert.throws(
    () => appendConversationPreambleOnce({ source, text: 'A competing acknowledgement.' }),
    /conflicts with the durable owner/i,
  );
  assert.throws(
    () => appendConversationPreambleOnce({ source: { ...source, turn: 3 }, text: 'wrong turn' }),
    /exact real user source/i,
  );
  assert.throws(
    () => appendConversationPreambleOnce({ source: { ...source, id: 'wrong-parent' }, text: 'wrong parent' }),
    /exact real user source/i,
  );
  assert.throws(
    () => appendEvent({
      sessionId: session.id,
      turn: source.turn,
      role: 'Clem',
      type: 'conversation_preamble',
      parentEventId: source.id,
      data: { version: 1, kind: 'pre_execution', sourceUserSeq: source.seq, text: 'bypass' },
    }),
    /exact-source CAS writer/i,
  );

  const synthetic = appendEvent({
    sessionId: session.id,
    turn: 3,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'internal continuation', synthetic: true },
  });
  assert.throws(
    () => appendConversationPreambleOnce({ source: synthetic, text: 'not a real source' }),
    /exact real user source/i,
  );
  assert.equal(listEvents(session.id, { types: ['conversation_preamble'] }).length, 1);
});

test('overlapping real sources retain independent exact preambles', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const firstSource = acceptedSource(session.id, 4);
  const secondSource = acceptedSource(session.id, 4);
  const first = appendConversationPreambleOnce({ source: firstSource, text: 'Starting the first accepted request.' });
  const second = appendConversationPreambleOnce({ source: secondSource, text: 'Starting the second accepted request.' });
  assert.notEqual(first.event.id, second.event.id);
  assert.equal(first.event.parentEventId, firstSource.id);
  assert.equal(second.event.parentEventId, secondSource.id);
  assert.deepEqual(
    listEvents(session.id, { types: ['conversation_preamble'] }).map((event) => event.data.sourceUserSeq),
    [firstSource.seq, secondSource.seq],
  );
});

test('public projector accepts only the closed safe presentation shape', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const source = acceptedSource(session.id, 9);
  const row = appendConversationPreambleOnce({
    source,
    text: 'I have the details and I’m beginning with the requested source.',
    intentKey: 'intent-safe',
  }).event;
  const projected = projectHarnessEventForPublic(row);
  assert.ok(projected);
  assert.equal(projected.parentEventId, null, 'execution topology stays private on the public bus');
  assert.deepEqual(projected.data, row.data);
  assert.equal('status' in projected.data, false);
  assert.equal('outcome' in projected.data, false);
  assert.equal('authority' in projected.data, false);

  assert.equal(publicConversationPreambleData({ ...row.data, status: 'done' }), null);
  assert.equal(projectHarnessEventForPublic({ ...row, data: { ...row.data, status: 'done' } }), null);
  assert.equal(projectHarnessEventForPublic({ ...row, role: 'system' }), null);
  assert.equal(projectHarnessEventForPublic({ ...row, parentEventId: null }), null);
  assert.equal(projectHarnessEventForPublic({
    ...row,
    data: { ...row.data, text: '{"summary":"x","reply":"x","done":true,"nextAction":"completed"}' },
  }), null);
});

test('restart recovery does not mistake a preamble for an accepted-source outcome', async () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const attempt = beginRunAttempt(session.id, { runId: 'preamble-restart-neutrality' });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Run the accepted task.' },
  }, { armRunInFlight: true });
  appendConversationPreambleOnce({ source, text: 'I have the request and I’m beginning now.' });
  assert.equal(acceptedSourceOutcome(source), null, 'a preamble never settles its accepted source');
  const resumed: number[] = [];
  const summary = recoverInterruptedChatRuns(
    () => Date.now() + 1_000,
    async (dispatch) => { resumed.push(dispatch.sourceUserSeq); },
    { bootCutoffMs: Date.now() + 1_000 },
  );
  assert.equal(summary.records[0]?.terminalReconciled, false);
  assert.equal(summary.records[0]?.autoResumed, true);
  assert.deepEqual(resumed, [source.seq]);
  assert.equal(listEvents(session.id, { types: ['conversation_completed'] }).length, 0);
});
