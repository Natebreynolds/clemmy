/**
 * Run: npx tsx --test src/tools/memory-tools.test.ts
 *
 * Covers the standing-instruction protection policy for the DIRECT memory
 * tools (reviewForgetRequest) — the pure decision behind memory_forget's
 * pinned/constraint refusals. The notification side is a straight
 * addNotification wrapper, covered by the notifications store tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewForgetRequest } from './memory-tools.js';

const fact = (over: Partial<{ id: number; kind: string; pinned: boolean; content: string }>) => ({
  id: 42,
  kind: 'user',
  pinned: false,
  content: 'Some fact.',
  ...over,
}) as Parameters<typeof reviewForgetRequest>[0];

test('reviewForgetRequest: a plain unpinned fact can be forgotten (soft or hard)', () => {
  assert.equal(reviewForgetRequest(fact({}), false).allow, true);
  assert.equal(reviewForgetRequest(fact({}), true).allow, true);
});

test('reviewForgetRequest: a PINNED fact is refused — unpin first', () => {
  const r = reviewForgetRequest(fact({ pinned: true }), false);
  assert.equal(r.allow, false);
  assert.match(r.reason ?? '', /PINNED standing instruction/);
  assert.match(r.reason ?? '', /memory_pin/);
});

test('reviewForgetRequest: a pinned CONSTRAINT is refused even for soft delete', () => {
  const r = reviewForgetRequest(fact({ kind: 'constraint', pinned: true }), false);
  assert.equal(r.allow, false);
});

test('reviewForgetRequest: hard-deleting an unpinned constraint is refused; soft is allowed', () => {
  const hard = reviewForgetRequest(fact({ kind: 'constraint', pinned: false }), true);
  assert.equal(hard.allow, false);
  assert.match(hard.reason ?? '', /recoverable/);
  const soft = reviewForgetRequest(fact({ kind: 'constraint', pinned: false }), false);
  assert.equal(soft.allow, true);
});
