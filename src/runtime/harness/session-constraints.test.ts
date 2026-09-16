/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/session-constraints.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-session-constraints-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { appendSteerNote } = await import('./steer-notes.js');
const branches = await import('./accepted-source-session-branch.js');
const {
  MAX_ITEMS, MAX_ITEM_BYTES, renderSessionConstraints, sessionConstraintsForSession,
} = await import('./session-constraints.js');

test.beforeEach(() => eventlog.resetEventLog());
test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function chat(id: string, userId = 'owner-1') {
  return HarnessSession.create({ id, kind: 'chat', channel: 'mobile', userId,
    metadata: { source: 'mobile', channelId: 'fixture-conversation', userId } });
}

test('a remembered subject stated mid-run binds the next request, verbatim, and the follow-up itself is not a constraint', () => {
  const session = chat('constraints-subject');
  session.recordUserInput('Draft the three follow-up emails from the Terra sheet.', 1);
  appendSteerNote(session.id, 'remember subject: Harbor follow-up');
  session.recordUserInput('ok draft the rest', 2);

  const items = sessionConstraintsForSession(session.id);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'user_steer_note');
  assert.equal(items[0]?.text, 'remember subject: Harbor follow-up');
  assert.equal(items[0]?.saidBefore, 'Draft the three follow-up emails from the Terra sheet.');
  assert.equal(items[0]?.omittedBytes, null);

  const text = renderSessionConstraints(items);
  assert.match(text, /^\[in force for this conversation/);
  assert.match(text, /"remember subject: Harbor follow-up"/);
  assert.match(text, /grant no authority for any external effect/);
  assert.match(text, /the later message governs/);
  assert.doesNotMatch(text, /ok draft the rest/);
  assert.equal(renderSessionConstraints([]), '');
});

test('a pasted list followed by "remember this list" carries every row verbatim through saidBefore', () => {
  const session = chat('constraints-list');
  const rows = Array.from({ length: 10 }, (_, i) => `${i + 1}. Prospect ${i + 1} <prospect${i + 1}@example.test> — Harbor ${i + 1}`);
  const pasted = rows.join('\n');
  session.recordUserInput(pasted, 1);
  appendSteerNote(session.id, 'remember this list');

  const items = sessionConstraintsForSession(session.id);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.text, 'remember this list');
  assert.equal(items[0]?.saidBefore, pasted, 'the preceding message is carried byte for byte, newlines included');
  const text = renderSessionConstraints(items);
  for (const row of rows) assert.ok(text.includes(row), `row carried verbatim: ${row}`);
});

test('synthetic rows, live-approval acknowledgements, harness-injected text and machine roles are never constraints', () => {
  const session = chat('constraints-excluded');
  const source = session.recordUserInput('Plan the outreach.', 1);
  eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Remember subject: Synthetic', synthetic: true } });
  eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    parentEventId: source.id,
    data: { text: 'Remember subject: Approved', synthetic: true,
      liveApprovalControl: { version: 1, ownerAttemptId: 'attempt-1', ownerSourceUserSeq: source.seq } } });
  session.recordUserInput('Resume background task bg-7. Remember subject: Injected.', 2);
  eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'user_steer_note',
    data: { text: 'remember subject: System' } });
  eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_steer_note',
    data: { text: '   ' } });
  assert.deepEqual(sessionConstraintsForSession(session.id), []);

  // The excluded rows also never become "said just before" context.
  appendSteerNote(session.id, 'remember subject: Real');
  const items = sessionConstraintsForSession(session.id);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.saidBefore, 'Plan the outreach.');
});

test('a same-conversation successor session carries the ancestor\'s constraints, oldest first', () => {
  const parent = chat('constraints-parent');
  parent.recordUserInput('Start the Harbor outreach.', 1);
  parent.recordUserInput('remember subject: Harbor follow-up', 2);
  eventlog.openEventLog().prepare("UPDATE sessions SET status = 'failed' WHERE id = ?").run(parent.id);
  const selected = branches.selectSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: parent.id,
    durableSourceId: 'constraints-successor', continuity: {
      provider: 'mobile', scopeId: null, conversationId: 'fixture-conversation', audienceId: 'owner-1',
    } });
  assert.equal(selected.disposition, 'branched');
  assert.notEqual(selected.sessionId, parent.id);
  const child = HarnessSession.load(selected.sessionId);
  assert.ok(child, 'the successor session exists');
  child.recordUserInput('remember to cc the Harbor coordinator', 1);

  const items = sessionConstraintsForSession(child.id);
  assert.deepEqual(items.map((item) => [item.sessionId, item.text]), [
    [parent.id, 'remember subject: Harbor follow-up'],
    [child.id, 'remember to cc the Harbor coordinator'],
  ]);
  assert.equal(items[0]?.saidBefore, 'Start the Harbor outreach.');
  // An unrelated conversation of the same owner carries nothing across.
  const unrelated = chat('constraints-unrelated');
  assert.deepEqual(sessionConstraintsForSession(unrelated.id), []);
});

test('bounds drop whole items, oldest first, and an oversize item becomes a marker rather than a clipped body', () => {
  const session = chat('constraints-bounds');
  for (let i = 1; i <= MAX_ITEMS + 1; i += 1) session.recordUserInput(`remember item ${i} matters`, i);
  const items = sessionConstraintsForSession(session.id);
  assert.equal(items.length, MAX_ITEMS);
  assert.equal(items[0]?.text, 'remember item 2 matters', 'the oldest item fell off whole');
  assert.equal(items[items.length - 1]?.text, `remember item ${MAX_ITEMS + 1} matters`);
  assert.ok(items.every((item) => item.omittedBytes === null));

  const oversize = chat('constraints-oversize');
  const huge = `remember this list: ${'x'.repeat(MAX_ITEM_BYTES + 1)}`;
  oversize.recordUserInput(huge, 1);
  oversize.recordUserInput('remember subject: Harbor follow-up', 2);
  const bounded = sessionConstraintsForSession(oversize.id);
  assert.equal(bounded.length, 2);
  assert.equal(bounded[0]?.text, '', 'no clipped body is ever carried');
  assert.equal(bounded[0]?.saidBefore, null);
  assert.equal(bounded[0]?.omittedBytes, Buffer.byteLength(huge, 'utf8'));
  // The oversize preceding message is what the second item "said before", so
  // the second item is oversize too and is omitted whole as well.
  assert.equal(bounded[1]?.omittedBytes, Buffer.byteLength(huge, 'utf8') + Buffer.byteLength('remember subject: Harbor follow-up', 'utf8'));
  const text = renderSessionConstraints(bounded);
  assert.match(text, /\[omitted: an instruction of \d+ bytes from \d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(text, /xxxx/);
  assert.ok(Buffer.byteLength(text, 'utf8') < 1_000, `bounded (${Buffer.byteLength(text, 'utf8')})`);
});

test('a missing session carries nothing and never throws', () => {
  assert.deepEqual(sessionConstraintsForSession('does-not-exist'), []);
  assert.deepEqual(sessionConstraintsForSession(''), []);
});
