import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProviderCapacityExhausted, providerCapacityErrorText } from './provider-capacity.js';

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
});
