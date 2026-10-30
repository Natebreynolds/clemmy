/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/steer-note-pickup.test.ts
 *
 * Owner 2026-10-30: "there should never be a time where Clem doesn't pick up
 * a message in a conversation." A message the running work never adopted
 * becomes the conversation's next turn, in the owner's words, exactly once;
 * never while work still runs there, and never a second bubble.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-steer-pickup-'));
process.env.CLEMENTINE_HOME = TMP;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const { bindSteerPickupRespond, pickUpUnownedSteerNotes, unownedSteerNotes } = await import('./steer-note-pickup.js');
const { projectHarnessEventForPublic } = await import('./public-presentation.js');

test.after(() => {
  bindSteerPickupRespond(null);
  eventlog.closeEventLog();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

const later = () => Date.now() + 6_000;

test('a message no work adopted starts the next turn once, in the owner\'s words', async () => {
  const asked: Array<{ sessionId: string; message: string; sourceUserSeq: number }> = [];
  bindSteerPickupRespond(async (request) => { asked.push(request); });
  const chat = eventlog.createSession({ id: 'sess-pickup-orphan', kind: 'chat', channel: 'mobile' });
  eventlog.appendEvent({ sessionId: chat.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Remove the team party' } });
  const note = eventlog.appendEvent({ sessionId: chat.id, turn: 0, role: 'user', type: 'user_steer_note',
    data: { text: 'Also block 4 to 6 pm every day as busy' } });

  assert.deepEqual(unownedSteerNotes(chat.id).map((n) => n.seq), [], 'a fresh note waits for the running work\'s own handoff');
  assert.equal(await pickUpUnownedSteerNotes(chat.id, later()), 'started');
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.message, 'Also block 4 to 6 pm every day as busy');
  const source = eventlog.listEvents(chat.id, { types: ['user_input_received'] }).find((row) => row.seq === asked[0]!.sourceUserSeq)!;
  assert.equal(source.data.source, 'steer_follow_up');
  assert.notEqual(source.data.synthetic, true, 'the owner\'s own words, kept in the conversation\'s history');
  assert.equal(projectHarnessEventForPublic(source), null, 'the owner already sees the note; the input draws no second bubble');
  assert.deepEqual(source.data.steerNoteSeqs, [note.seq]);
  assert.equal(await pickUpUnownedSteerNotes(chat.id, later()), 'none', 'exactly once');
  assert.equal(asked.length, 1);
});

test('nothing starts while work still runs in the conversation, or for a note already delivered', async () => {
  const asked: unknown[] = [];
  bindSteerPickupRespond(async (request) => { asked.push(request); });
  const busy = eventlog.createSession({ id: 'sess-pickup-busy', kind: 'chat', channel: 'desktop' });
  eventlog.beginRunAttempt(busy.id, { runId: 'busy-run' });
  eventlog.appendEvent({ sessionId: busy.id, turn: 0, role: 'user', type: 'user_steer_note', data: { text: 'Steer this' } });
  assert.equal(await pickUpUnownedSteerNotes(busy.id, later()), 'none', 'the running work adopts it');

  const done = eventlog.createSession({ id: 'sess-pickup-delivered', kind: 'chat', channel: 'desktop' });
  const adopted = eventlog.appendEvent({ sessionId: done.id, turn: 0, role: 'user', type: 'user_steer_note', data: { text: 'Adopted' } });
  eventlog.appendEvent({ sessionId: done.id, turn: 0, role: 'system', type: 'user_steer_note_delivered', data: { noteSeqs: [adopted.seq] } });
  assert.equal(await pickUpUnownedSteerNotes(done.id, later()), 'none');
  assert.equal(asked.length, 0);
});
