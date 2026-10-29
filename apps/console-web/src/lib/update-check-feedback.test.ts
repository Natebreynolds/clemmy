import assert from 'node:assert/strict';
import test from 'node:test';
import { updateCheckFeedback } from './update-check-feedback';

test('only a completed successful update check claims the app is current', () => {
  assert.equal(updateCheckFeedback({ state: 'no-update' }, '3.18.58'), 'You’re on the latest version (v3.18.58).');
  for (const result of [null, undefined, [], {}, { state: 'idle' }, { state: 'checking' }, { state: 'error' },
    { state: 'no-update', error: 'Updates require the installed app' }, { state: 'unknown-future-state' }]) {
    assert.doesNotMatch(updateCheckFeedback(result), /latest version/);
  }
});

test('update feedback distinguishes availability, download and install without leaking diagnostic errors', () => {
  assert.match(updateCheckFeedback({ state: 'available' }), /available/);
  assert.match(updateCheckFeedback({ state: 'downloading' }), /downloading/);
  assert.match(updateCheckFeedback({ state: 'ready-to-install' }), /ready to install/);
  const failure = updateCheckFeedback({ state: 'error', error: 'secret diagnostic path at native.module (/private/user/file:12)' });
  assert.match(failure, /Try again/);
  assert.doesNotMatch(failure, /secret|private|native\.module/);
});
