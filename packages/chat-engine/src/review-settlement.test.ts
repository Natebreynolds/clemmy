import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldTranscript } from './engine.js';
import { applyReviewSettlement, readReviewSettlement } from './review-settlement.js';
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
