/** Run: node scripts/run-tests-isolated.mjs src/runtime/install-locations.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elevatedInstallCommand, installNeedsFor, installPreflight, blockedInstallText, type InstallPlaces } from './install-locations.js';

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
  assert.ok(verdict.elevated, 'a system place can be written through the OS administrator prompt');
  assert.equal(verdict.elevated?.command, 'osascript');
  assert.match(verdict.reason, /ask for an administrator's name and password/);
  const brew = installPreflight({ command: 'brew install gh', places: { ...managed, homebrew: { path: '/opt/homebrew', writable: false } }, platform: 'darwin' });
  assert.ok(!brew.ok && brew.place === 'homebrew' && brew.elevated === null, 'the package manager\'s tree is never written as an administrator');
  const ok = installPreflight({ command, needs: ['applications'], places: { ...managed, applications: true }, platform: 'darwin' });
  assert.ok(ok.ok);
  assert.ok(installPreflight({ command, needs: ['applications'], places: managed, platform: 'win32' }).ok, 'Windows places are not read here');
});

test('the elevated form keeps the owner\'s home and escapes the command for the OS prompt; the password is the OS\'s, never Clem\'s', () => {
  const mac = elevatedInstallCommand('/bin/bash -c "$(curl -fsSL https://example.test/install.sh)"', { platform: 'darwin', home: "/Users/o'wner" });
  assert.equal(mac?.command, 'osascript');
  const expected = 'do shell script "env HOME=\'/Users/o\'\\\\\'\'wner\' /bin/bash -c \\"$(curl -fsSL https://example.test/install.sh)\\"" with administrator privileges';
  assert.equal(mac?.args[1], expected);
  assert.match(mac?.prompt ?? '', /Clem never sees them/);
  assert.equal(elevatedInstallCommand('x', { platform: 'linux', home: '/home/o' })?.command, 'pkexec');
  assert.equal(elevatedInstallCommand('x', { platform: 'win32' }), null);
});
