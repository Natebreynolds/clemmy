import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProviderCapacityExhausted, providerCapacityErrorText, isProviderExtraUsageUnavailable, isProviderCreditRefusalError } from './provider-capacity.js';

test('recognizes Anthropic model-scoped extra-usage exhaustion carried by HTTP 400', () => {
  const live = {
    status: 400,
    message: 'Bad Request',
    responseBody: {
      error: {
        message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
      },
    },
  };
  assert.equal(isProviderCapacityExhausted(live), true);
  assert.equal(isProviderExtraUsageUnavailable(live), true);
  assert.match(providerCapacityErrorText(live), /out of extra usage/i);
});

test('recognizes established plan/quota spellings without treating ordinary 400s as capacity', () => {
  for (const value of [
    'usage_limit_reached',
    'The usage limit has been reached.',
    'Weekly limit reached.',
    { bodyText: '{"error":{"message":"You exceeded your current quota"}}' },
  ]) {
    assert.equal(isProviderCapacityExhausted(value), true, JSON.stringify(value));
  }
  assert.equal(isProviderCapacityExhausted({ status: 400, message: 'invalid schema' }), false);
  assert.equal(isProviderCapacityExhausted('429 Too Many Requests'), false, 'a short generic 429 is not a durable plan-limit signal');
  for (const value of ['429 Too Many Requests', 'Weekly limit reached.', 'invalid schema']) {
    assert.equal(isProviderExtraUsageUnavailable(value), false, 'do not invent an extra-usage scope');
  }
});

test('a thrown credit refusal is read from the status, the status in its text, the words, or the cause', () => {
  assert.equal(isProviderCreditRefusalError(Object.assign(new Error('Payment Required'), { status: 402 })), true);
  assert.equal(isProviderCreditRefusalError(new Error('step failed via harness: 402 Credit limit exceeded, please add credits')), true);
  assert.equal(isProviderCreditRefusalError(new Error('credit line reached for this account')), true);
  assert.equal(isProviderCreditRefusalError(new Error('fetch failed', { cause: Object.assign(new Error('insufficient_quota'), { status: 429 }) })), true);
  assert.equal(isProviderCreditRefusalError(new Error('API Error: 429 rate limit, slow down')), false, 'a burst limit is not a refusal for credit');
  assert.equal(isProviderCreditRefusalError(new Error('API Error: 400 Bad Request: invalid schema')), false);
  assert.equal(isProviderCreditRefusalError(null), false);
});
