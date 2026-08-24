/** Run: node scripts/run-tests-isolated.mjs src/setup/authority-seal-provisioning.test.ts
 *
 * A cold install must be able to make a typed crossing.
 *
 * The seal key that every sealed authority depends on was only ever created by
 * the test runner and by the isolated-home escape hatch inside the seal module
 * itself. On a real install nothing wrote one, so the first typed crossing
 * threw AuthoritySealKeyMissingError — the typed path could not work out of the
 * box anywhere, and the whole test suite hid it.
 *
 * These pins run in PRODUCTION shape: no CLEMMY_TEST_ISOLATED_HOME, no
 * CLEMMY_AUTHORITY_SEAL_KEY. That is the configuration the defect lived in.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-seal-provision-'));
process.env.CLEMENTINE_HOME = HOME;
// The preload mints an isolated home and stamps these; production has neither,
// and with them present the seal module mints a key on demand, which is exactly
// the behaviour that concealed the gap.
delete process.env.CLEMMY_TEST_ISOLATED_HOME;
delete process.env.CLEMENTINE_ISOLATED_VERTICAL;
delete process.env.CLEMMY_AUTHORITY_SEAL_KEY;
delete process.env.CLEMMY_AUTHORITY_SEAL_KEY_PREVIOUS;

const {
  AuthoritySealKeyMissingError,
  openCanonicalArguments,
  provisionAuthoritySealKey,
  sealCanonicalArguments,
} = await import('../runtime/harness/authority-argument-seal.js');

test('a cold production home cannot seal before it is provisioned', () => {
  assert.throws(
    () => sealCanonicalArguments({ token: 'alpha' }),
    AuthoritySealKeyMissingError,
    'the untouched install is the state the live daemon was in',
  );
});

test('provisioning makes the first typed crossing possible', () => {
  assert.equal(provisionAuthoritySealKey(), true, 'a cold home mints a key');
  const sealed = sealCanonicalArguments({ token: 'alpha' });
  assert.deepEqual(
    openCanonicalArguments(sealed),
    { token: 'alpha' },
    'sealed arguments round-trip under the provisioned key',
  );
});

test('provisioning never replaces a key that already exists', () => {
  // Re-provisioning must be inert. A provisioner that overwrote would orphan
  // every authority already sealed under the previous key — silently, since
  // the ciphertext stays well-formed and simply stops opening.
  const sealed = sealCanonicalArguments({ token: 'beta' });
  assert.equal(provisionAuthoritySealKey(), false, 'an existing key is reported, not replaced');
  assert.deepEqual(
    openCanonicalArguments(sealed),
    { token: 'beta' },
    'ciphertext sealed before the second call still opens',
  );
});
