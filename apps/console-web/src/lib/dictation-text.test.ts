import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dictatedDraft } from './dictation-text.js';

test('dictated words join the draft the owner started with, without doubling spaces', () => {
  assert.equal(dictatedDraft('', 'hello there'), 'hello there');
  assert.equal(dictatedDraft('Draft so far', ' and more words '), 'Draft so far and more words');
  assert.equal(dictatedDraft('Ends with a space ', 'next'), 'Ends with a space next');
  assert.equal(dictatedDraft('Kept as is', '   '), 'Kept as is', 'silence leaves the draft alone');
});
