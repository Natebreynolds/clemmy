import assert from 'node:assert/strict';
import test from 'node:test';
import { authBootstrapMode } from './auth-bootstrap';
import { canRetryPairing, pairingRecovery } from './pairing-recovery';

test('only unconfirmed transport failures offer the exact retained pairing attempt', () => {
  for (const error of [new TypeError('Failed to fetch'), { status: 0 }, { status: 408 }, { status: 503 }]) {
    const recovery = pairingRecovery(error);
    assert.equal(recovery.retryable, true);
    assert.equal(canRetryPairing('?pair=attempt-one', 'attempt-one', recovery.retryable), true);
    assert.equal(canRetryPairing('?pair=attempt-two', 'attempt-one', recovery.retryable), false, 'an older error cannot retry a newer QR');
    assert.equal(canRetryPairing('?adopt=other', 'attempt-one', recovery.retryable), false);
    assert.equal(canRetryPairing('', 'attempt-one', recovery.retryable), false);
    assert.equal(canRetryPairing('?pair=attempt-one', null, recovery.retryable), false);
  }
});

test('expired and refused pairing never gains a retry of the old token', () => {
  for (const error of [{ status: 401, body: { error: 'INVALID_PAIRING_CODE' } }, { status: 400 }, { status: 403 }]) {
    const recovery = pairingRecovery(error);
    assert.equal(recovery.retryable, false);
    assert.equal(canRetryPairing('?pair=attempt-one', 'attempt-one', recovery.retryable), false);
    assert.match(recovery.message, /Apps & devices → Pair your phone/);
    assert.doesNotMatch(recovery.message, /Open Mobile/);
  }
});

test('a rate limit preserves the attempt and honors its server wait before another explicit retry', () => {
  const recovery = pairingRecovery({ status: 429, body: { error: 'LOCKED_OUT', retryAfterMs: 5_000 } }, 1_000);
  assert.equal(recovery.retryable, true);
  assert.equal(recovery.retryAt, 6_000);
  assert.equal(canRetryPairing('?pair=attempt-one', 'attempt-one', true, recovery.retryAt, 5_999), false);
  assert.equal(canRetryPairing('?pair=attempt-one', 'attempt-one', true, recovery.retryAt, 6_000), true);
  assert.equal(canRetryPairing('?pair=new-attempt', 'attempt-one', true, recovery.retryAt, 7_000), false);
  assert.equal(pairingRecovery({ status: 429 }, 1_000).retryAt, 61_000, 'a missing server wait never enables immediate retry');
  assert.match(recovery.message, /QR code is kept/);
  assert.doesNotMatch(recovery.message, /fresh code/);
});

test('retry re-enters the existing single-owner bootstrap rather than racing status or adoption', () => {
  const search = '?pair=attempt-one&adopt=old-handoff';
  assert.equal(canRetryPairing(search, 'attempt-one', true), true);
  assert.equal(authBootstrapMode(search), 'pair');
  assert.equal(authBootstrapMode('?adopt=old-handoff'), 'adopt');
  assert.equal(authBootstrapMode(''), 'status');
});
