import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clementineLiveMountFromUrl,
  clementineLiveUrlForDashboard,
  createClementineLiveMountIdentity,
  isCurrentClementineLiveMount,
  isValidClementineLiveMountIdentity,
  isValidClementineLiveMountNonce,
} from './live-mount-handshake.js';

const FIRST_NONCE = 'abcdefghijklmnopqrstuvwx';
const SECOND_NONCE = 'zyxwvutsrqponmlkjihgfedc';

test('creates a new generation-bound identity for every load', () => {
  const first = createClementineLiveMountIdentity(0, () => FIRST_NONCE);
  const second = createClementineLiveMountIdentity(first.generation, () => SECOND_NONCE);
  assert.deepEqual(first, { generation: 1, nonce: FIRST_NONCE });
  assert.deepEqual(second, { generation: 2, nonce: SECOND_NONCE });
  assert.equal(isCurrentClementineLiveMount(second, first), false);
  assert.equal(isCurrentClementineLiveMount(second, { ...second }), true);
});

test('rejects malformed mount nonces and identities', () => {
  assert.equal(isValidClementineLiveMountNonce('too-short'), false);
  assert.equal(isValidClementineLiveMountNonce(`${FIRST_NONCE}!`), false);
  assert.equal(isValidClementineLiveMountIdentity({ generation: 1, nonce: FIRST_NONCE }), true);
  assert.equal(isValidClementineLiveMountIdentity({ generation: 0, nonce: FIRST_NONCE }), false);
  assert.equal(isValidClementineLiveMountIdentity({ generation: 1, nonce: FIRST_NONCE, extra: true }), false);
  assert.throws(() => createClementineLiveMountIdentity(0, () => 'predictable-but-short'));
});

test('notch URL strips bootstrap credentials and round-trips only its mount identity', () => {
  const mount = { generation: 7, nonce: FIRST_NONCE };
  const url = clementineLiveUrlForDashboard(
    'http://127.0.0.1:43123/console?token=top-secret#fragment',
    mount,
  );
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/console/notch');
  assert.equal(parsed.searchParams.has('token'), false);
  assert.equal(parsed.hash, '');
  assert.deepEqual(clementineLiveMountFromUrl(url), mount);
  assert.equal(clementineLiveMountFromUrl('http://127.0.0.1:43123/console/notch'), null);
  assert.equal(clementineLiveMountFromUrl('not a URL'), null);
});
