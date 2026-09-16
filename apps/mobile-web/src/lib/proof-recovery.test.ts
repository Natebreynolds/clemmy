import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverFromUnauthorized } from './proof-recovery.js';

test('a live session adopts the fingerprint the daemon reports, so the next proof heals', () => {
  assert.deepEqual(
    recoverFromUnauthorized({ authenticated: true, sessionFingerprint: 'fp-current' }),
    { kind: 'session_alive', adoptFingerprint: 'fp-current' },
  );
});

test('a live session with no fingerprint in the answer keeps what it has', () => {
  assert.deepEqual(
    recoverFromUnauthorized({ authenticated: true, sessionFingerprint: null }),
    { kind: 'session_alive', adoptFingerprint: null },
  );
  assert.deepEqual(
    recoverFromUnauthorized({ authenticated: true }),
    { kind: 'session_alive', adoptFingerprint: null },
  );
});

test('only a confirmed dead session flips to the gate', () => {
  assert.deepEqual(recoverFromUnauthorized({ authenticated: false }), { kind: 'session_dead' });
  assert.deepEqual(recoverFromUnauthorized(null), { kind: 'session_dead' });
  assert.deepEqual(recoverFromUnauthorized(undefined), { kind: 'session_dead' });
});
