/**
 * Exact approval response ownership: an explicit card id may never borrow a
 * different card, the latest bare approval text, or an attempt's old source.
 */
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-approval-resume-source-'));
process.env.CLEMENTINE_HOME = TMP;

const {
  appendEvent,
  createSession,
  listEvents,
  resetEventLog,
} = await import('./eventlog.js');
const { _acceptResumeConversationInputForTest } = await import('./loop.js');

afterEach(() => resetEventLog());
after(() => {
  resetEventLog();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('explicit approval B mints/reuses only B source and never borrows approval A', () => {
  const session = createSession({ kind: 'chat', channel: 'mobile' });
  const sourceA = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Approve apr-card-a.',
      approvalId: 'apr-card-a',
      decision: 'approve',
      source: 'mobile_approval',
    },
  });

  const sourceBSeq = _acceptResumeConversationInputForTest({
    sessionId: session.id,
    approvalId: 'apr-card-b',
    decision: 'approve',
  });
  assert.notEqual(sourceBSeq, sourceA.seq);
  const sourceB = listEvents(session.id, { types: ['user_input_received'] })
    .find((event) => event.seq === sourceBSeq)!;
  assert.equal(sourceB.data.approvalId, 'apr-card-b');
  assert.equal(sourceB.data.decision, 'approve');
  assert.equal(sourceB.data.synthetic, true);

  assert.equal(_acceptResumeConversationInputForTest({
    sessionId: session.id,
    sourceUserSeq: sourceBSeq,
    approvalId: 'apr-card-b',
    decision: 'approve',
  }), sourceBSeq);
  assert.equal(listEvents(session.id, { types: ['user_input_received'] }).length, 2);

  assert.throws(() => _acceptResumeConversationInputForTest({
    sessionId: session.id,
    sourceUserSeq: sourceA.seq,
    approvalId: 'apr-card-b',
    decision: 'approve',
  }), /does not own approval apr-card-b/);
});

test('multiple response rows for one explicit approval fail closed', () => {
  const session = createSession({ kind: 'chat', channel: 'mobile' });
  for (let turn = 1; turn <= 2; turn += 1) {
    appendEvent({
      sessionId: session.id,
      turn,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Approve duplicate.', approvalId: 'apr-duplicate', decision: 'approve' },
    });
  }
  assert.throws(() => _acceptResumeConversationInputForTest({
    sessionId: session.id,
    approvalId: 'apr-duplicate',
    decision: 'approve',
  }), /ambiguous accepted response ownership/);
});
