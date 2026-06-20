import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurnIntent } from './turn-intent.js';

test('classifyTurnIntent: pure questions are qa', () => {
  assert.equal(classifyTurnIntent('what model are we running right now'), 'qa');
  assert.equal(classifyTurnIntent('how does the pipeline work?'), 'qa');
  assert.equal(classifyTurnIntent('summarize yesterday'), 'qa');
  assert.equal(classifyTurnIntent(''), 'qa');
  assert.equal(classifyTurnIntent(undefined), 'qa');
});

test('classifyTurnIntent: irreversible-action verbs are action', () => {
  assert.equal(classifyTurnIntent('send the proposal to the client'), 'action');
  assert.equal(classifyTurnIntent('publish the site'), 'action');
  assert.equal(classifyTurnIntent('deploy to production'), 'action');
  assert.equal(classifyTurnIntent('delete those records'), 'action');
  assert.equal(classifyTurnIntent('charge the customer'), 'action');
  assert.equal(classifyTurnIntent('migrate the database'), 'action');
});

test('classifyTurnIntent: NARROW — reversible chatter stays qa (no over-fire)', () => {
  // "run my email flow" intentionally stays qa: it does not name an irreversible
  // action, and the workflow hint is kept in the packet regardless of intent.
  assert.equal(classifyTurnIntent('run my email flow'), 'qa');
  assert.equal(classifyTurnIntent('look at the spreadsheet'), 'qa');
  assert.equal(classifyTurnIntent('what should I send?'), 'action'); // contains "send" — conservative, fine
});

test('classifyTurnIntent: word-boundary — substrings do not false-match', () => {
  assert.equal(classifyTurnIntent('the deletion policy doc'), 'qa'); // "deletion" != "delete"
  assert.equal(classifyTurnIntent('senders and receivers overview'), 'qa'); // "senders" != "send/sends"
});
