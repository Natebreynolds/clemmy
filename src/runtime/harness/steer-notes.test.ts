/**
 * Run: npx tsx --test src/runtime/harness/steer-notes.test.ts
 *
 * Mid-run steering (2026-08-07): user messages reach a RUNNING turn without
 * stopping it. Pins: exactly-once delivery, chat-surface guard, the model-
 * facing block shape, and the context-not-authority framing.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-steer-notes-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { createSession, listEvents } = await import('./eventlog.js');
const {
  appendSteerNote,
  takeUndeliveredSteerNotes,
  formatSteerBlock,
  steerBlockForToolBoundary,
  sessionSupportsSteering,
} = await import('./steer-notes.js');

after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('a steer note is delivered exactly once, in order, and durably marked', () => {
  const session = createSession({ id: 'sess-steer-once', kind: 'chat' });
  appendSteerNote(session.id, 'skip the two accounts with no email on file');
  appendSteerNote(session.id, 'and use the Q3 template');

  const first = takeUndeliveredSteerNotes(session.id);
  assert.equal(first.length, 2);
  assert.equal(first[0].text, 'skip the two accounts with no email on file');
  assert.equal(first[1].text, 'and use the Q3 template');

  // Marker is durable — a second boundary delivers nothing.
  assert.equal(takeUndeliveredSteerNotes(session.id).length, 0);
  const markers = listEvents(session.id, { types: ['user_steer_note_delivered'] });
  assert.equal(markers.length, 1);

  // A NEW note after delivery is picked up alone.
  appendSteerNote(session.id, 'actually cap it at 8 drafts');
  const second = takeUndeliveredSteerNotes(session.id);
  assert.equal(second.length, 1);
  assert.equal(second[0].text, 'actually cap it at 8 drafts');
});

test('steering is scoped to human chat surfaces — agent/cron sessions never inject', () => {
  assert.equal(sessionSupportsSteering('sess-desktop-abc'), true);
  assert.equal(sessionSupportsSteering('space-crm-dash'), true);
  assert.equal(sessionSupportsSteering('discord-123'), true);
  assert.equal(sessionSupportsSteering('agent:clementine'), false);
  assert.equal(sessionSupportsSteering('workflow:trigger-x:main'), false);
  assert.equal(sessionSupportsSteering(undefined), false);
  // The boundary composition returns '' for a non-steerable session without
  // touching the event log.
  assert.equal(steerBlockForToolBoundary('agent:clementine'), '');
});

test('the injected block carries the user words verbatim and the context-not-authority frame', () => {
  const block = formatSteerBlock([{ seq: 1, text: 'also pull the phone numbers' }]);
  assert.match(block, /MID-RUN MESSAGE FROM THE USER/);
  assert.match(block, /"also pull the phone numbers"/);
  assert.match(block, /does not replace it unless it clearly says so/i);
  assert.match(block, /normal approval path/i, 'a note never becomes a side-door around effect gates');
  assert.equal(formatSteerBlock([]), '');
});

test('boundary composition: one call takes, formats, and marks — empty when quiet', () => {
  const session = createSession({ id: 'sess-steer-boundary', kind: 'chat' });
  assert.equal(steerBlockForToolBoundary(session.id), '', 'quiet session adds zero bytes');
  appendSteerNote(session.id, 'prioritize Phoenix firms first');
  const block = steerBlockForToolBoundary(session.id);
  assert.match(block, /Phoenix firms first/);
  assert.equal(steerBlockForToolBoundary(session.id), '', 'delivered exactly once');
});
