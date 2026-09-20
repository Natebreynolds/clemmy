/**
 * "Needs you" must be answerable, not just readable.
 *
 * THE REGRESSION THIS CLOSES. A parked run reaches this pane whichever way it
 * is blocked, but only approvals could be settled here — `needsYouDecision`
 * returns null for a question, so a run stopped on "which mailbox should I
 * use?" rendered as a row you could read and not answer. The one thing that
 * would let Clementine carry on was the one thing the pane would not take.
 *
 * `POST /api/console/inbox/questions/:id/answer` has always returned
 * `resuming` when the answer releases a run — the word is in its contract —
 * along with per-row `answerable` / `unavailableReason` and a typed refusal
 * when the answer must go to its origin conversation. None of it was used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const pane = read('./NeedsYouPane.tsx');

test('a question row can be answered from the pane', () => {
  assert.ok(pane.includes('answerInboxQuestion'),
    'NeedsYouPane no longer answers questions — a parked run becomes unanswerable here again.');
  assert.ok(pane.includes('item.questionId'),
    'NeedsYouPane no longer recognises a question row.');
});

test('the run resuming is reported as the run resuming', () => {
  assert.match(pane, /resuming/,
    'The pane no longer distinguishes `resuming` — the owner loses the one signal that says the run picked back up.');
  assert.match(pane, /picking the run back up/,
    'The resuming copy is gone; say what actually happened, not a generic acknowledgement.');
});

test('the server decides whether a question is answerable here', () => {
  assert.ok(pane.includes('answerable'),
    'The pane ignores `answerable` and will render a control that cannot work.');
  assert.ok(pane.includes('unavailableReason'),
    'The pane drops the server’s own reason for why an answer cannot be given here.');
  assert.match(pane, /authorized origin|requires_origin/,
    'The pane no longer handles the origin-conversation refusal, so that 409 reads as a generic failure.');
});

test('offered options are used instead of making the owner type', () => {
  assert.ok(pane.includes('question?.options') || pane.includes('question.options'),
    'A question that offers choices should answer in one click.');
});

test('the answer path costs nothing when nothing is asking', () => {
  assert.match(pane, /enabled: questionIds\.length > 0/,
    'The questions poll is no longer conditional; a Home with no open questions pays for it anyway.');
});
