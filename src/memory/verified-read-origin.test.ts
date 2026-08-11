import assert from 'node:assert/strict';
import test from 'node:test';

import { parseVerifiedReadCapabilityOrigin } from './verified-read-origin.js';

const EXACT = {
  version: 1,
  sessionId: 'cold-session',
  sourceUserSeq: 17,
  receiptId: `rr_${'a'.repeat(32)}`,
  evidenceDigest: 'b'.repeat(24),
} as const;

test('verified-read capability origin accepts only the exact bounded v1 pointer', () => {
  assert.deepEqual(parseVerifiedReadCapabilityOrigin(EXACT), EXACT);
  for (const value of [
    { ...EXACT, version: 2 },
    { ...EXACT, sourceUserSeq: 0 },
    { ...EXACT, sessionId: ' cold-session' },
    { ...EXACT, receiptId: 'receipt' },
    { ...EXACT, evidenceDigest: 'b'.repeat(64) },
    { ...EXACT, extra: true },
  ]) assert.equal(parseVerifiedReadCapabilityOrigin(value), null);
});
