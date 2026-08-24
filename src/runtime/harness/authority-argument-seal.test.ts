/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/authority-argument-seal.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-seal-key-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
delete process.env.CLEMMY_AUTHORITY_SEAL_KEY;

const {
  AuthoritySealKeyMissingError,
  openCanonicalArguments,
  rotateAuthoritySealKey,
  sealCanonicalArguments,
} = await import('./authority-argument-seal.js');

test('missing seal key fails closed outside isolated homes', async () => {
  const previous = process.env.CLEMMY_TEST_ISOLATED_HOME;
  delete process.env.CLEMMY_TEST_ISOLATED_HOME;
  delete process.env.CLEMMY_AUTHORITY_SEAL_KEY;
  try {
    assert.throws(() => sealCanonicalArguments({ secret: 'x' }), AuthoritySealKeyMissingError);
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_TEST_ISOLATED_HOME;
    else process.env.CLEMMY_TEST_ISOLATED_HOME = previous;
  }
});

test('rotated key recovers previous ciphertext and vault is owner-only', () => {
  process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
  const sealed = sealCanonicalArguments({ token: 'alpha' });
  const next = 'cd'.repeat(32);
  rotateAuthoritySealKey(next);
  process.env.CLEMMY_AUTHORITY_SEAL_KEY = next;
  assert.deepEqual(openCanonicalArguments(sealed), { token: 'alpha' });
  const vault = path.join(HOME, 'state', 'secrets-vault.json');
  const mode = statSync(vault).mode & 0o777;
  assert.equal(mode, 0o600);
  delete process.env.CLEMMY_AUTHORITY_SEAL_KEY;
});
