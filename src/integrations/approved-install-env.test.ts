/**
 * Run: node scripts/run-tests-isolated.mjs src/integrations/approved-install-env.test.ts
 *
 * Live 10-02: Clem's installer ran `npm install -g` with the root-owned system
 * npm in /usr/local (a login shell puts it first) and failed with EACCES, while
 * the owner's own nvm npm installed the same package fine. An approved install
 * now runs the owner's toolchain first, and the finished install joins the
 * saved CLI list whichever door started it.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'clem-approved-install-'));
const HOME = path.join(ROOT, 'home');
const NVM_BIN = path.join(HOME, '.nvm', 'versions', 'node', 'v22.9.0', 'bin');
mkdirSync(NVM_BIN, { recursive: true });
mkdirSync(path.join(HOME, '.nvm', 'alias'), { recursive: true });
writeFileSync(path.join(HOME, '.nvm', 'alias', 'default'), '22\n');
writeFileSync(path.join(NVM_BIN, 'npm'), '#!/bin/sh\necho "owner nvm npm $*"\nexit 0\n');
chmodSync(path.join(NVM_BIN, 'npm'), 0o755);
const CLEM = path.join(ROOT, 'clem');
mkdirSync(path.join(CLEM, 'state'), { recursive: true });
writeFileSync(path.join(CLEM, '.env'), '');
process.env.HOME = HOME;
process.env.CLEMENTINE_HOME = CLEM;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
// In the app the daemon runs on the app's own binary, whose folder holds no
// npm; under the test runner it is a real Node install, so name the app's.
const realExecPath = process.execPath;
process.execPath = path.join(ROOT, 'Clementine.app', 'Contents', 'MacOS', 'Clementine');

const { installCommandEnv, startApprovedInstallCommand, getInstallJob } = await import('./browser-harness.js');
const { getSavedClis } = await import('../runtime/saved-clis.js');

after(() => { process.execPath = realExecPath; rmSync(ROOT, { recursive: true, force: true }); });

test('an approved install runs the owner\'s own npm ahead of the system one', () => {
  const dirs = (installCommandEnv().PATH ?? '').split(path.delimiter);
  assert.ok(dirs.includes(NVM_BIN), dirs.join('\n'));
  assert.ok(dirs.indexOf(NVM_BIN) < dirs.indexOf('/usr/local/bin'), 'nvm\'s default npm comes before /usr/local');
});

test('the install runs with that npm and the finished CLI joins the saved list', async () => {
  const job = startApprovedInstallCommand('npm install -g clem-fixture-cli-0b7e2', 'Install fixture', { savedCli: 'clem-fixture-cli-0b7e2' });
  const deadline = Date.now() + 15_000;
  while (getInstallJob(job.id)?.status === 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const done = getInstallJob(job.id)!;
  assert.equal(done.status, 'succeeded', done.output);
  assert.match(done.output, /owner nvm npm install -g clem-fixture-cli-0b7e2/);
  const until = Date.now() + 5_000;
  while (!getSavedClis().includes('clem-fixture-cli-0b7e2') && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  assert.ok(getSavedClis().includes('clem-fixture-cli-0b7e2'), 'recorded without the Connect screen polling');
});
