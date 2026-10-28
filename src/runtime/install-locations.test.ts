/** Run: node scripts/run-tests-isolated.mjs src/runtime/install-locations.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installNeedsFor, installPreflight, blockedInstallText, type InstallPlaces } from './install-locations.js';

const managed: InstallPlaces = {
  home: '/Users/owner',
  applications: false,
  usrLocalBin: false,
  npmPrefix: { path: '/usr/local', writable: false },
  homebrew: { path: '/opt/homebrew', writable: true },
};

test('an install that can go into the owner\'s own folders is redirected there, with a note', () => {
  const cask = installPreflight({ command: 'brew install --cask google-cloud-sdk', places: managed, platform: 'darwin' });
  assert.ok(cask.ok);
  assert.equal(cask.env.HOMEBREW_CASK_OPTS, '--appdir=/Users/owner/Applications');
  assert.match(cask.note ?? '', /your own Applications folder/);
  const npm = installPreflight({ command: 'npm install -g @railway/cli', places: managed, platform: 'darwin' });
  assert.ok(npm.ok);
  assert.equal(npm.env.npm_config_prefix, '/Users/owner/.local');
  const fine = installPreflight({ command: 'pipx install httpie', places: managed, platform: 'darwin' });
  assert.deepEqual(fine, { ok: true, env: {}, note: null });
  assert.deepEqual(installNeedsFor('brew install --cask x'), ['applications', 'homebrew']);
});

test('an install that only an administrator can place is blocked up front with the command to hand over', () => {
  const command = '/bin/bash -c "$(curl -fsSL https://example.test/install.sh)"';
  const verdict = installPreflight({ command, needs: ['applications'], places: managed, platform: 'darwin' });
  assert.ok(!verdict.ok);
  assert.equal(verdict.place, 'applications');
  assert.match(verdict.reason, /administrator/i);
  assert.equal(verdict.adminCommand, command);
  assert.match(blockedInstallText(verdict), /Command for the administrator:\n\/bin\/bash/);
  const brew = installPreflight({ command: 'brew install gh', places: { ...managed, homebrew: { path: '/opt/homebrew', writable: false } }, platform: 'darwin' });
  assert.ok(!brew.ok && brew.place === 'homebrew');
  const ok = installPreflight({ command, needs: ['applications'], places: { ...managed, applications: true }, platform: 'darwin' });
  assert.ok(ok.ok);
  assert.ok(installPreflight({ command, needs: ['applications'], places: managed, platform: 'win32' }).ok, 'Windows places are not read here');
});
