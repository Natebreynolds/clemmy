import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-steer-source-'));
process.env.CLEMENTINE_HOME = home;
const events = await import('./eventlog.js');
const { appendSteerNote, takeUndeliveredSteerNotes, adoptedSteerNotesForSource } = await import('./steer-notes.js');
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('all six notes retain complete accepted text and exact source order across reopen', () => {
  const session = events.createSession({ id: 'sess-steer-six-complete', kind: 'chat' });
  const first = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'First task.' } });
  const old = appendSteerNote(session.id, 'Do not adopt a newer task note here.');
  const second = events.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Second task.' } });
  const texts = ['  '+ 'Original instruction. '.repeat(130) + ' FULL TAIL BEYOND 2000  ', ...Array.from({ length: 5 }, (_, i) => `Instruction ${i + 2}`)];
  const notes = texts.map((text) => appendSteerNote(session.id, text));
  events.closeEventLog();
  assert.deepEqual(takeUndeliveredSteerNotes(session.id, first.seq).map((note) => note.seq), [old.seq], 'a prior task never consumes a newer source note');
  assert.deepEqual(adoptedSteerNotesForSource({ sessionId: session.id, sourceUserSeq: first.seq }).map((note) => note.seq), [old.seq]);
  const current = takeUndeliveredSteerNotes(session.id, second.seq);
  assert.deepEqual(current.map((note) => [note.seq, note.text]), notes.map((note, i) => [note.seq, texts[i]]));
  assert.equal(takeUndeliveredSteerNotes(session.id, second.seq).length, 0);
  events.closeEventLog();
  assert.deepEqual(adoptedSteerNotesForSource({ sessionId: session.id, sourceUserSeq: second.seq }).map((note) => note.text), texts);
});
