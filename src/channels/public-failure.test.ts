import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PUBLIC_RUN_FAILURE_TEXT } from '../runtime/harness/public-presentation.js';
import {
  PUBLIC_APPROVAL_CARD_REFRESH_FAILURE_TEXT,
  PUBLIC_APPROVAL_EDIT_FAILURE_TEXT,
  PUBLIC_CHANNEL_FAILURE_TEXT,
  PUBLIC_MODEL_RUNTIME_UNAVAILABLE_TEXT,
  publicApprovalDecisionFailure,
} from './public-failure.js';

const PRIVATE_SENTINEL = 'HTTP 500 provider-secret-response-body';

test('channel failure copy shares the fail-closed harness fallback', () => {
  assert.equal(PUBLIC_CHANNEL_FAILURE_TEXT, PUBLIC_RUN_FAILURE_TEXT);
  assert.doesNotMatch(PUBLIC_CHANNEL_FAILURE_TEXT, /HTTP|provider-secret/i);
  assert.match(PUBLIC_MODEL_RUNTIME_UNAVAILABLE_TEXT, /Settings > Models/);
  assert.doesNotMatch(PUBLIC_MODEL_RUNTIME_UNAVAILABLE_TEXT, /auth|token|CLEMMY_|API key/i);
});

test('approval failure copy is actionable without accepting raw error detail', () => {
  const text = publicApprovalDecisionFailure('approve', 'apr-test');
  assert.match(text, /apr-test/);
  assert.match(text, /still actionable/);
  assert.doesNotMatch(text, new RegExp(PRIVATE_SENTINEL));
  assert.doesNotMatch(PUBLIC_APPROVAL_EDIT_FAILURE_TEXT, /response body|stack|ECONNREFUSED/i);
  assert.match(PUBLIC_APPROVAL_CARD_REFRESH_FAILURE_TEXT, /decision was recorded/i);
});
