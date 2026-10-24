import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldTranscript } from './engine.js';
import { answerCheckCorrectedSource, applyAnswerCheckCorrection, applyReviewSettlement, readReviewSettlement } from './review-settlement.js';
import type { HarnessEvent } from './types.js';

const SESSION = 'review-settlement-fixture';

function answeredTurn(sourceUserSeq: number, review: string, text = 'Here is the answer.'): HarnessEvent[] {
  return [
    { seq: sourceUserSeq, type: 'user_input_received', sessionId: SESSION, role: 'user', data: { text: 'Summarize the notes.' } },
    { seq: sourceUserSeq + 1, type: 'conversation_completed', sessionId: SESSION, role: 'system', data: {
      sourceUserSeq,
      reply: text,
      presentation: { version: 1, status: 'done', kind: 'answer', text,
        identity: { sessionId: SESSION, sourceUserSeq, turn: 1 } },
      turnOutcome: { version: 2, status: 'done', resumable: false },
      review,
    } },
  ];
}

const settled = (seq: number, sourceUserSeq: number, review: string, reviewNote?: string): HarnessEvent => ({
  seq, type: 'completion_review_settled', sessionId: SESSION, role: 'system',
  data: { version: 1, sourceUserSeq, review, ...(reviewNote ? { reviewNote } : {}) },
});

test('an answer published while checking reopens with the ruling its review reached', () => {
  const messages = foldTranscript([...answeredTurn(1, 'checking'), settled(3, 1, 'checked')], SESSION);
  const answer = messages.find((message) => message.role === 'assistant')!;
  assert.equal(answer.text, 'Here is the answer.');
  assert.equal(answer.terminal?.review, 'checked');
  assert.equal(answer.reviewPendingSource, undefined, 'nothing is left waiting');
});

test('a ruling that said no carries its finding to the chip, and only to its own answer', () => {
  const messages = foldTranscript([
    ...answeredTurn(1, 'checking', 'First answer.'),
    ...answeredTurn(3, 'checking', 'Second answer.'),
    settled(5, 3, 'rejected', 'The notes have three items.'),
  ], SESSION);
  const [first, second] = messages.filter((message) => message.role === 'assistant');
  assert.equal(first!.terminal?.review, 'checking', 'the other answer is still being checked');
  assert.equal(first!.reviewPendingSource, 1);
  assert.equal(second!.terminal?.review, 'rejected');
  assert.equal(second!.terminal?.reviewNote, 'The notes have three items.');
});

test('a ruling never rewrites an answer that was not waiting for one', () => {
  const messages = foldTranscript([...answeredTurn(1, 'checked'), settled(3, 1, 'rejected', 'Stale.')], SESSION);
  const answer = messages.find((message) => message.role === 'assistant')!;
  assert.equal(answer.terminal?.review, 'checked');
  assert.equal(answer.terminal?.reviewNote, undefined);
});

test('only a closed, known ruling is read', () => {
  assert.equal(readReviewSettlement(settled(3, 1, 'checking')), null, 'a ruling never re-opens the check');
  assert.equal(readReviewSettlement({ ...settled(3, 1, 'checked'), data: { sourceUserSeq: 1, review: 'checked' } }), null);
  assert.equal(readReviewSettlement(settled(3, 1, 'checked'), 'another-session'), null);
  assert.deepEqual(readReviewSettlement(settled(3, 1, 'checked', 'ignored for a pass')), { sourceUserSeq: 1, review: 'checked' });
  const untouched = [{ id: 'a', role: 'assistant' as const, text: 'x' }];
  assert.equal(applyReviewSettlement(untouched, { sourceUserSeq: 1, review: 'checked' }), untouched);
});

/** Clem's correction after a ruling that said no, as the server posts it: a
 *  synthetic outcome source and its report, naming the answer it corrects. */
function correctionReport(seq: number, corrects: number, text: string, status = 'done'): HarnessEvent[] {
  const marker = { version: 1, sourceUserSeq: seq, sourceLabel: 'answer check', sourceId: `answer-check:${corrects}`, phase: 'report' };
  const identity = { sessionId: SESSION, sourceUserSeq: seq, turn: 0 };
  return [
    { seq, type: 'user_input_received', sessionId: SESSION, role: 'user', turn: 0, data: {
      synthetic: true, source: 'outcome', deliveryPhase: 'report', backgroundOutcomeReport: marker } },
    { seq: seq + 1, type: 'conversation_completed', sessionId: SESSION, role: 'system', data: {
      sourceUserSeq: seq, reply: text,
      presentation: { version: 1, audience: 'user', phase: 'final', identity, status, kind: 'answer', text, resumable: false },
      turnOutcome: { version: 2, status, resumable: false },
      backgroundOutcomeReport: marker,
    } },
  ];
}

test('a correction after a no takes the answer\'s place: one ask, one reply', () => {
  const messages = foldTranscript([
    ...answeredTurn(1, 'checking', 'The meeting is at 10:00.'),
    settled(3, 1, 'rejected', 'The calendar record says 9:00.'),
    ...correctionReport(4, 1, 'The meeting is at 9:00.'),
  ], SESSION);
  const replies = messages.filter((message) => message.role === 'assistant');
  assert.equal(replies.length, 1, 'the correction is not a second reply');
  assert.equal(replies[0]!.text, 'The meeting is at 9:00.');
  assert.equal(replies[0]!.terminal?.review, 'corrected');
  assert.equal(replies[0]!.terminal?.reviewNote, 'The calendar record says 9:00.', 'what the check found stays on the chip');
});

test('a correction that ends on a question leaves the answer waiting on the owner', () => {
  const messages = foldTranscript([
    ...answeredTurn(1, 'checking', 'Done: three rows.'),
    settled(3, 1, 'rejected', 'Only two rows were written.'),
    ...correctionReport(4, 1, 'Only two rows went in. Shall I add the third?', 'needs_input'),
  ], SESSION);
  const replies = messages.filter((message) => message.role === 'assistant');
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.status, 'awaiting-reply');
});

test('a correction with no rejected answer to replace still shows as its own reply', () => {
  const messages = foldTranscript([
    ...answeredTurn(1, 'checked', 'Fine answer.'),
    ...correctionReport(4, 1, 'A correction with nothing to replace.'),
  ], SESSION);
  const replies = messages.filter((message) => message.role === 'assistant');
  assert.deepEqual(replies.map((message) => message.text), ['Fine answer.', 'A correction with nothing to replace.']);
});

test('only an answer-check report names an answer to correct', () => {
  assert.equal(answerCheckCorrectedSource({ sourceId: 'answer-check:12' }), 12);
  assert.equal(answerCheckCorrectedSource({ sourceId: 'answer-check:0' }), null);
  assert.equal(answerCheckCorrectedSource({ sourceId: 'answer-check:12x' }), null);
  assert.equal(answerCheckCorrectedSource({ sourceId: 'bg-task:12' }), null);
  assert.equal(answerCheckCorrectedSource(null), null);
  const rejected = [{ id: 'a', role: 'assistant', text: 'x', correctableSource: 2, terminal: { status: 'done' as const, review: 'rejected' as const } }];
  assert.equal(applyAnswerCheckCorrection(rejected, 3, { text: 'y' }), null, 'another answer is not touched');
  assert.equal(applyAnswerCheckCorrection(rejected, 2, { text: '   ' }), null, 'an empty correction replaces nothing');
});
