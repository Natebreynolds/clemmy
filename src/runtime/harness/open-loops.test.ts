/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/open-loops.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-open-loops-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { openLoopsForSession, renderOpenLoops, stripAskMarker } = await import('./open-loops.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function chat(id: string, channel = 'mobile', userId = 'device-1') {
  return HarnessSession.create({ id, kind: 'chat', channel, userId, metadata: { source: channel, channelId: id, userId } });
}

function ask(sessionId: string, question: string, options: string[] = []) {
  eventlog.appendEvent({ sessionId, turn: 1, role: 'system', type: 'awaiting_user_input', data: { question, options, purpose: 'clarification' } });
}

test('unanswered questions from the same principal\'s other recent conversations are carried, newest first, bounded', () => {
  eventlog.resetEventLog();
  const older = chat('loop-older');
  older.recordUserInput('can you edit this event please and add a brief description about clem in the invite', 1);
  ask(older.id, 'Which calendar event should I update, and what should the brief description say about Clem?', ['Share the event title and time', 'Paste the wording']);
  const newer = chat('loop-newer');
  newer.recordUserInput('The Clementine discussion with Adam tomorrow at 9.', 1);
  ask(newer.id, 'ASK: Which calendar should I use for tomorrow’s 9 AM discussion with Adam?');
  // An answered question is not an open loop.
  const answered = chat('loop-answered');
  answered.recordUserInput('Draft the note', 1);
  ask(answered.id, 'Which note?');
  answered.recordUserInput('The Friday one', 2);
  // Another person on the same channel is a different principal.
  const other = chat('loop-other-user', 'mobile', 'device-2');
  other.recordUserInput('Book my flight', 1);
  ask(other.id, 'Which airline?');

  const current = chat('loop-current');
  const loops = openLoopsForSession(current.id);
  assert.deepEqual(loops.map((l) => l.sessionId), ['loop-newer', 'loop-older']);
  assert.equal(loops[0]?.question, 'Which calendar should I use for tomorrow’s 9 AM discussion with Adam?', 'the host marker never reaches the person');
  assert.equal(loops[0]?.about, 'The Clementine discussion with Adam tomorrow at 9.');
  assert.deepEqual(loops[1]?.options, ['Share the event title and time', 'Paste the wording']);

  const text = renderOpenLoops(loops);
  assert.match(text, /^\[open with you/);
  assert.match(text, /You asked: "Which calendar should I use/);
  assert.match(text, /about: "can you edit this event/);
  assert.doesNotMatch(text, /Which airline|Which note\?/);
  assert.ok(text.length < 1_200, `bounded (${text.length})`);

  // Bounded by limit, and the current session's own questions are never listed
  // (its history is already in view).
  ask(current.id, 'Own question?');
  assert.equal(openLoopsForSession(current.id, { limit: 1 }).length, 1);
  assert.ok(openLoopsForSession(current.id).every((l) => l.sessionId !== current.id));

  // Outside the window nothing is carried.
  assert.deepEqual(openLoopsForSession(current.id, { now: Date.now() + 48 * 60 * 60 * 1000 }), []);
  assert.equal(renderOpenLoops([]), '');
});

test('a session with no principal, or a missing session, carries nothing and never throws', () => {
  eventlog.resetEventLog();
  assert.deepEqual(openLoopsForSession('does-not-exist'), []);
  assert.equal(stripAskMarker('ASK:  Which one?'), 'Which one?');
  assert.equal(stripAskMarker('Which one?'), 'Which one?');
});
