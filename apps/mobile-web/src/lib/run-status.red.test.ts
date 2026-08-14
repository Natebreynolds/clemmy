/** RED — mobile must keep a real awaiting-input run in live/needs-you state. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isActiveRunStatus } from './api.js';

test('awaiting_input remains live on mobile instead of falling into history', () => {
  assert.equal(
    isActiveRunStatus('awaiting_input'),
    true,
    'mobile Home/Activity treated a resumable input pause as finished history',
  );
});
