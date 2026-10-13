/**
 * What the phone shows when the daemon refuses a request: the route's plain
 * line, never its machine code. The code stays on the error's body for the
 * callers that branch on it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, displayMessage, setSessionFingerprint } from './api.js';

test('a refused chat send shows its plain line and keeps the code on the body', async t => {
  setSessionFingerprint(null);
  const line = 'This turn is finishing; the message was not queued.';
  t.mock.method(globalThis, 'fetch', async () => Response.json(
    { error: line, code: 'STEER_NOTE_CUTOVER', sessionId: 'sess-phone' }, { status: 409 }));
  await assert.rejects(api('/m/api/chat/send', { method: 'POST', body: '{}' }), (error: unknown) => {
    const failure = error as Error & { status: number; body: { code?: string; sessionId?: string } };
    assert.equal(failure.message, line);
    assert.doesNotMatch(failure.message, /STEER_NOTE/);
    assert.equal(failure.status, 409);
    assert.equal(failure.body.code, 'STEER_NOTE_CUTOVER');
    assert.equal(failure.body.sessionId, 'sess-phone');
    return true;
  });
});

test('a plain message beside a machine code is the line shown; a bare code or no body falls back', () => {
  assert.equal(displayMessage({ error: 'TRANSCRIPTION_STOPPED', message: 'Wait for cleanup, then try again.' }, 409),
    'Wait for cleanup, then try again.');
  assert.equal(displayMessage({ error: 'RUN_NOT_ACTIVE' }, 409), 'RUN_NOT_ACTIVE');
  assert.equal(displayMessage({ error: 'CHAT_SEND_FAILED', message: '   ' }, 500), 'CHAT_SEND_FAILED');
  assert.equal(displayMessage({ error: '', message: '' }, 500), 'HTTP 500');
  assert.equal(displayMessage(['not', 'an', 'object'], 502), 'HTTP 502');
  assert.equal(displayMessage('not json', 502), 'HTTP 502');
  assert.equal(displayMessage(null, 503), 'HTTP 503');
});
