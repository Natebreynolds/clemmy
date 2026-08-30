import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProviderInternalGenerationFailure } from './provider-internal-generation.js';

test('recognizes a bare SSE generation crash with no HTTP status', () => {
  assert.equal(
    isProviderInternalGenerationFailure(new Error('Internal error during token generation')),
    true,
  );
  assert.equal(
    isProviderInternalGenerationFailure({ message: 'Internal error during token generation' }),
    true,
  );
});

test('recognizes established provider-internal spellings without treating client errors as infra', () => {
  for (const value of [
    'The server had an error while processing your request.',
    { bodyText: '{"error":{"type":"server_error","message":"engine exception"}}' },
    { error: { type: 'server_error', message: 'internal server error' } },
  ]) {
    assert.equal(isProviderInternalGenerationFailure(value), true, JSON.stringify(value));
  }
  assert.equal(isProviderInternalGenerationFailure({ message: 'invalid schema for field x' }), false);
  assert.equal(isProviderInternalGenerationFailure(new Error('bad input')), false);
  assert.equal(isProviderInternalGenerationFailure({ status: 400, message: 'tool call arguments are invalid' }), false);
});
