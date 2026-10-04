import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldTranscript } from './engine.js';
import { cardDecisionOf, hiddenCardDecision, type HarnessEvent } from './types.js';

const event = (seq: number, type: string, data: Record<string, unknown> = {}): HarnessEvent => ({ seq, type, sessionId: 'chat', data });
const card = event(5, 'approval_requested', { approvalId: 'apr-card', subject: 'Let Clem use a server', tool: 'approval' });
const tap = (decision: 'approve' | 'reject') => event(6, 'user_input_received', {
  text: `${decision === 'approve' ? 'Approve' : 'Reject'} apr-card.`, displayText: `${decision === 'approve' ? 'Approve' : 'Reject'} apr-card`,
  synthetic: true, source: 'mobile_approval', approvalId: 'apr-card', decision,
});
const reply = (status: 'done' | 'failed') => event(7, 'conversation_completed', {
  sourceUserSeq: 6, reply: status === 'done' ? 'Approved apr-card.' : 'Could not record that decision.',
  presentation: { identity: { sessionId: 'chat', sourceUserSeq: 6 }, status, kind: status === 'done' ? 'answer' : 'error', text: status === 'done' ? 'Approved apr-card.' : 'Could not record that decision.', resumable: false },
  turnOutcome: { status },
});

test('a card tap is read only from the host record of the message', () => {
  assert.deepEqual(cardDecisionOf(tap('approve').data!), { approvalId: 'apr-card', decision: 'approve' });
  assert.equal(cardDecisionOf({ text: 'Approve apr-card' }), null, 'typed words are not a tap');
  assert.equal(cardDecisionOf({ source: 'mobile_approval', approvalId: 'apr-card', decision: 'maybe' }), null);
});

test('a card tap and its reply stay out of the transcript, and the card reads as decided', () => {
  for (const decision of ['approve', 'reject'] as const) {
    const rows = foldTranscript([card, tap(decision), reply('done')], 'chat');
    const shown = rows.filter((row) => !hiddenCardDecision(row));
    assert.equal(shown.length, 1, 'only the card itself remains');
    assert.equal(shown[0]!.approval?.resolution, decision === 'approve' ? 'approved' : 'declined');
  }
});

test('a tap whose decision failed to land stays visible', () => {
  const rows = foldTranscript([card, tap('approve'), reply('failed')], 'chat');
  const failed = rows.find((row) => row.role === 'assistant' && row.cardDecision);
  assert.ok(failed);
  assert.equal(hiddenCardDecision(failed!), false);
});
