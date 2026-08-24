/** Run: node scripts/run-tests-isolated.mjs src/setup/init-home-authority-seal.test.ts
 *
 * The wiring pin for the authority seal key.
 *
 * A provisioner that exists but is never reached is the same defect wearing a
 * different filename, so this drives the real boot-path scaffolder — the one
 * `src/index.ts` calls during service boot — against a home that has no key,
 * and checks the vault afterwards.
 *
 * It lives in its own file because BASE_DIR binds once per process from
 * CLEMENTINE_HOME: a cold home cannot be arranged partway through a file that
 * has already imported the vault path.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-inithome-seal-'));
process.env.CLEMENTINE_HOME = HOME;
// Production shape: the seal module mints on demand under these, which is the
// behaviour that hid the missing provisioner in the first place.
delete process.env.CLEMMY_TEST_ISOLATED_HOME;
delete process.env.CLEMENTINE_ISOLATED_VERTICAL;
delete process.env.CLEMMY_AUTHORITY_SEAL_KEY;

const VAULT_FILE = path.join(HOME, 'state', 'secrets-vault.json');

function vaultSealKey(): string | undefined {
  if (!existsSync(VAULT_FILE)) return undefined;
  const parsed = JSON.parse(readFileSync(VAULT_FILE, 'utf8')) as {
    entries?: Record<string, string>;
  };
  return parsed.entries?.authority_seal_v2;
}

test('booting a cold home leaves a usable authority seal key behind', async () => {
  assert.equal(vaultSealKey(), undefined, 'the cold home starts with no key');

  const { initHome } = await import('./init-home.js');
  await initHome();

  assert.match(
    vaultSealKey() ?? '',
    /^[a-f0-9]{64}$/,
    'scaffolding wrote a 32-byte hex key into the vault',
  );

  // The key is not merely present — it is the one the crossing path will use.
  const { openCanonicalArguments, sealCanonicalArguments } =
    await import('../runtime/harness/authority-argument-seal.js');
  const sealed = sealCanonicalArguments({ token: 'cold-boot' });
  assert.deepEqual(openCanonicalArguments(sealed), { token: 'cold-boot' });
});

test('booting an already-provisioned home leaves its key untouched', async () => {
  const before = vaultSealKey();
  const { initHome } = await import('./init-home.js');
  await initHome();
  assert.equal(vaultSealKey(), before, 'a second boot must not rotate the key out from under sealed authorities');
});
