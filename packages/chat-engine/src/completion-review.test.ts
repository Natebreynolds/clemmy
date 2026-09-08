import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCompletionReviewResponse } from './completion-review.js';

test('review off and a selected same-provider judge survive the actual response shape', () => {
  assert.deepEqual(readCompletionReviewResponse({ completionReview: {
    enabled: false, judge: 'gpt-5.6-terra', judgeSource: 'settings',
  } }), { enabled: false, judge: 'gpt-5.6-terra', judgeSource: 'settings' });
  assert.deepEqual(readCompletionReviewResponse({ completionReview: {
    enabled: true, judge: 'claude-opus-5', judgeSource: 'chat-rule',
  } }), { enabled: true, judge: 'claude-opus-5', judgeSource: 'chat-rule' });
});

test('missing policy, fusion-only or malformed responses never become review off', () => {
  for (const value of [null, {}, { fusion: { mode: 'off' } },
    { completionReview: { enabled: 'false', judge: 'gpt-5.6-terra', judgeSource: 'settings' } },
    { completionReview: { enabled: true, judge: '', judgeSource: 'settings' } },
    { completionReview: { enabled: false, judge: 'gpt-5.6-terra' } },
  ]) assert.throws(() => readCompletionReviewResponse(value), /could not be confirmed/);
});
