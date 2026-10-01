import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyOutcomeText } from './from-clem';

test('what a reply did is said plainly, and an unclear reply says how to answer', () => {
  assert.equal(replyOutcomeText({ outcome: 'started', sessionId: 's' }, 'Calendar watch'), 'Started a conversation.');
  assert.equal(replyOutcomeText({ outcome: 'rule_added' }, 'Work review'), 'Saved as a rule for Work review.');
  assert.match(replyOutcomeText({ outcome: 'unclear' }, 'Noticing'), /do it/);
  assert.equal(replyOutcomeText({ outcome: 'gone' }, 'Noticing'), 'Already handled.');
});
