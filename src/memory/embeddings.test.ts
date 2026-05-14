/**
 * Run: npx tsx --test src/memory/embeddings.test.ts
 *
 * Uses Node's built-in test runner so we have no new dependencies and
 * tests work the moment you check out the branch. When the project
 * adopts a proper test framework later, these files port verbatim —
 * the assertions are identical to anything vitest/jest would use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bufferToVector,
  cosine,
  EMBEDDING_DIM,
  vectorToBuffer,
} from './embeddings.js';

test('vectorToBuffer + bufferToVector roundtrip preserves vectors', () => {
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = Math.sin(i * 0.01);
  const buffer = vectorToBuffer(v);
  const restored = bufferToVector(buffer);

  assert.equal(restored.length, v.length, 'length matches');
  // Roundtrip should be bit-exact for Float32.
  for (let i = 0; i < v.length; i++) {
    assert.equal(restored[i], v[i], `index ${i} differs`);
  }
});

test('vectorToBuffer copies storage (does not alias)', () => {
  const v = new Float32Array(4);
  v[0] = 1; v[1] = 2; v[2] = 3; v[3] = 4;
  const buffer = vectorToBuffer(v);
  // Mutate the source vector — buffer should not change.
  v[0] = 99;
  const restored = bufferToVector(buffer);
  assert.equal(restored[0], 1, 'buffer must not alias source vector');
});

test('cosine of identical vectors is 1', () => {
  const v = new Float32Array(8);
  for (let i = 0; i < 8; i++) v[i] = i + 1;
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6, 'expected cosine ≈ 1');
});

test('cosine of orthogonal vectors is 0', () => {
  const a = new Float32Array([1, 0, 0, 0]);
  const b = new Float32Array([0, 1, 0, 0]);
  assert.equal(cosine(a, b), 0);
});

test('cosine of antiparallel vectors is -1', () => {
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([-1, -2, -3]);
  assert.ok(Math.abs(cosine(a, b) - -1) < 1e-6);
});

test('cosine returns 0 when one vector is zero (avoids NaN)', () => {
  const a = new Float32Array([1, 2, 3]);
  const z = new Float32Array([0, 0, 0]);
  assert.equal(cosine(a, z), 0);
  assert.equal(cosine(z, a), 0);
  assert.equal(cosine(z, z), 0);
});

test('cosine handles mismatched lengths by clipping to shorter', () => {
  const a = new Float32Array([1, 0, 0, 100]);
  const b = new Float32Array([1, 0, 0]); // length 3
  // Should clip a to first 3 dims, both become [1,0,0] → cosine = 1.
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
});
