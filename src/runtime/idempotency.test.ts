/**
 * Run: npx tsx --test src/runtime/idempotency.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  lookupIdempotent,
  rememberIdempotent,
  _clearIdempotencyForTests,
  idempotencySize,
} = await import('./idempotency.js');

test.beforeEach(() => { _clearIdempotencyForTests(); });

test('lookup with no entry returns cached:false', () => {
  const result = lookupIdempotent<string>('scope', 'k1');
  assert.equal(result.cached, false);
});

test('remember then lookup returns the cached value', () => {
  rememberIdempotent('scope', 'k1', { hello: 'world' });
  const result = lookupIdempotent<{ hello: string }>('scope', 'k1');
  assert.equal(result.cached, true);
  if (result.cached) assert.deepEqual(result.value, { hello: 'world' });
});

test('lookup respects the (scope, key) tuple', () => {
  rememberIdempotent('chat:dev-a', 'k1', { who: 'a' });
  rememberIdempotent('chat:dev-b', 'k1', { who: 'b' });
  const ra = lookupIdempotent<{ who: string }>('chat:dev-a', 'k1');
  const rb = lookupIdempotent<{ who: string }>('chat:dev-b', 'k1');
  assert.equal(ra.cached && ra.value.who, 'a');
  assert.equal(rb.cached && rb.value.who, 'b');
});

test('TTL expiration: entries past their TTL are evicted on lookup', () => {
  const now = 1_000_000;
  rememberIdempotent('scope', 'k1', 'v', 100, now);
  // 50ms later → still cached
  assert.equal(lookupIdempotent('scope', 'k1', now + 50).cached, true);
  // 200ms later → expired
  assert.equal(lookupIdempotent('scope', 'k1', now + 200).cached, false);
});

test('empty key is a no-op (never caches, never reads)', () => {
  rememberIdempotent('scope', '', 'value');
  assert.equal(lookupIdempotent('scope', '').cached, false);
});

test('overflow eviction drops oldest entries past MAX_ENTRIES', () => {
  // MAX_ENTRIES = 256 in the impl. Fill with 260 distinct keys.
  for (let i = 0; i < 260; i += 1) {
    rememberIdempotent('scope', `k${i}`, i);
  }
  assert.ok(idempotencySize() <= 256, `expected ≤256 entries, got ${idempotencySize()}`);
  // The very first should have been evicted; the most recent should
  // still be there.
  assert.equal(lookupIdempotent<number>('scope', 'k259').cached, true);
});
