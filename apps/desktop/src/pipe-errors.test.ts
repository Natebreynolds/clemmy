/**
 * Run: npx tsx --test apps/desktop/src/pipe-errors.test.ts
 *
 * Guards the v0.5.64 fix: an EPIPE/ECONNRESET from an optional child helper
 * (the Recall.ai recorder) is benign and must be ignored by the global error
 * handlers, never escalated to a fatal boot dialog. Real errors must still be
 * treated as fatal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBenignPipeError } from './pipe-errors.js';

test('EPIPE (by code) is benign', () => {
  const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  assert.equal(isBenignPipeError(err), true);
});

test('ECONNRESET (by code) is benign', () => {
  const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  assert.equal(isBenignPipeError(err), true);
});

test('EPIPE detectable by message when code is lost', () => {
  assert.equal(isBenignPipeError(new Error('Error: write EPIPE')), true);
  assert.equal(isBenignPipeError('write EPIPE'), true);
});

test('real errors are NOT benign (still fatal)', () => {
  assert.equal(isBenignPipeError(new Error('Cannot find module foo')), false);
  assert.equal(isBenignPipeError(Object.assign(new Error('boom'), { code: 'ERR_MODULE_NOT_FOUND' })), false);
  assert.equal(isBenignPipeError(new TypeError('x is not a function')), false);
});

test('null/undefined are not benign', () => {
  assert.equal(isBenignPipeError(null), false);
  assert.equal(isBenignPipeError(undefined), false);
});

test('does not false-positive on substrings (PIPELINE etc.)', () => {
  assert.equal(isBenignPipeError(new Error('PIPELINE stage failed')), false);
});
