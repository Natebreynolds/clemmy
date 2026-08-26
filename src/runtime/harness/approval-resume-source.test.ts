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
const approvalRegistry = await import('./approval-registry.js');

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
  const cardB = approvalRegistry.register({
    sessionId: session.id,
    subject: 'Exact card B',
    tool: 'fixture_tool',
    args: { card: 'b' },
  });

  const sourceBSeq = _acceptResumeConversationInputForTest({
    sessionId: session.id,
    approvalId: cardB.approvalId,
    decision: 'approve',
  });
  assert.notEqual(sourceBSeq, sourceA.seq);
  const sourceB = listEvents(session.id, { types: ['user_input_received'] })
    .find((event) => event.seq === sourceBSeq)!;
  assert.equal(sourceB.data.approvalId, cardB.approvalId);
  assert.equal(sourceB.data.decision, 'approve');
  assert.equal(sourceB.data.synthetic, true);

  assert.equal(_acceptResumeConversationInputForTest({
    sessionId: session.id,
    sourceUserSeq: sourceBSeq,
    approvalId: cardB.approvalId,
    decision: 'approve',
  }), sourceBSeq);
  assert.equal(listEvents(session.id, { types: ['user_input_received'] }).length, 2);

  assert.throws(() => _acceptResumeConversationInputForTest({
    sessionId: session.id,
    sourceUserSeq: sourceA.seq,
    approvalId: cardB.approvalId,
    decision: 'approve',
  }), new RegExp(`does not own approval ${cardB.approvalId}`));
});

test('an unknown explicit approval cannot mint an accepted control source', () => {
  const session = createSession({ kind: 'chat', channel: 'mobile' });
  assert.throws(() => _acceptResumeConversationInputForTest({
    sessionId: session.id,
    approvalId: 'apr-forged-missing',
    decision: 'approve',
  }), /does not belong to this session/);
  assert.equal(listEvents(session.id, { types: ['user_input_received'] }).length, 0);
});

test('multiple response rows for one explicit approval fail closed', () => {
  const session = createSession({ kind: 'chat', channel: 'mobile' });
  const card = approvalRegistry.register({
    sessionId: session.id,
    subject: 'Duplicate response fixture',
    tool: 'fixture_tool',
    args: { duplicate: true },
  });
  for (let turn = 1; turn <= 2; turn += 1) {
    appendEvent({
      sessionId: session.id,
      turn,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Approve duplicate.', approvalId: card.approvalId, decision: 'approve' },
    });
  }
  assert.throws(() => _acceptResumeConversationInputForTest({
    sessionId: session.id,
    approvalId: card.approvalId,
    decision: 'approve',
  }), /ambiguous accepted response ownership/);
});
