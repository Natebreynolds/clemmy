/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/steer-after-approval.test.ts
 *
 * Owner 2026-10-30: "there should never be a time where Clem doesn't pick up a
 * message in a conversation." A message sent while Clem carries out an
 * approved card belongs to the work the approval resumed, so that work's own
 * handoff picks it up. The tap (Approve or Reject) is a control on that work,
 * never a new assignment that would own the message and never run.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-steer-after-approval-'));
process.env.CLEMENTINE_HOME = TMP;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const { hasUndeliveredSteerNotes, takeUndeliveredSteerNotes } = await import('./steer-notes.js');

test.after(() => {
  eventlog.closeEventLog();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

const input = (sessionId: string, turn: number, data: Record<string, unknown>) =>
  eventlog.appendEvent({ sessionId, turn, role: 'user', type: 'user_input_received', data });
const note = (sessionId: string, text: string) =>
  eventlog.appendEvent({ sessionId, turn: 0, role: 'user', type: 'user_steer_note', data: { text } });

test('a message sent while an approved card runs belongs to the work the approval resumed', () => {
  for (const surface of ['mobile_approval', 'desktop_approval']) {
    const chat = eventlog.createSession({ id: `sess-steer-after-${surface}`, kind: 'chat', channel: 'mobile' });
    const ask = input(chat.id, 1, { text: 'Can you remove the team party from my calendar please' });
    input(chat.id, 2, { text: 'Approve apr-1.', synthetic: true, source: surface, approvalId: 'apr-1', decision: 'approve' });
    const sent = note(chat.id, 'Also block 4 to 6 pm every day as busy');
    assert.equal(hasUndeliveredSteerNotes(chat.id, ask.seq), true, `${surface}: the resumed work owns the message`);
    assert.deepEqual(takeUndeliveredSteerNotes(chat.id, ask.seq, true).map((n) => n.seq), [sent.seq]);
    assert.equal(hasUndeliveredSteerNotes(chat.id, ask.seq), false, 'picked up exactly once');
  }
});

test('a real new message still begins its own assignment', () => {
  const chat = eventlog.createSession({ id: 'sess-steer-new-assignment', kind: 'chat', channel: 'mobile' });
  const first = input(chat.id, 1, { text: 'What is on my calendar today?' });
  const second = input(chat.id, 2, { text: 'Remove the team party please' });
  const sent = note(chat.id, 'Only the one on Friday');
  assert.equal(hasUndeliveredSteerNotes(chat.id, first.seq), false, 'the earlier assignment does not take a later one\'s message');
  assert.deepEqual(takeUndeliveredSteerNotes(chat.id, second.seq, true).map((n) => n.seq), [sent.seq]);
});
