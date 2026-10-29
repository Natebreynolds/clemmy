/** Run: node scripts/run-tests-isolated.mjs src/runtime/install-locations.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elevatedInstallCommand, installNeedsFor, installPreflight, blockedInstallText, type InstallPlaces } from './install-locations.js';

const managed: InstallPlaces = {
  home: '/home/me',
  applications: false,
  usrLocalBin: false,
  npmPrefix: { path: '/usr/local', writable: false },
  homebrew: { path: '/opt/homebrew', writable: true },
};

test('an install that can go into the owner\'s own folders is redirected there, with a note', () => {
  const cask = installPreflight({ command: 'brew install --cask google-cloud-sdk', places: managed, platform: 'darwin' });
  assert.ok(cask.ok);
  assert.equal(cask.env.HOMEBREW_CASK_OPTS, '--appdir=/home/me/Applications');
  assert.match(cask.note ?? '', /your own Applications folder/);
  const npm = installPreflight({ command: 'npm install -g @railway/cli', places: managed, platform: 'darwin' });
  assert.ok(npm.ok);
  assert.equal(npm.env.npm_config_prefix, '/home/me/.local');
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

test('the elevated form keeps the owner\'s home, hands root-owned leftovers back, and the password is the OS\'s, never Clem\'s', () => {
  const mac = elevatedInstallCommand('/bin/bash -c "$(curl -fsSL https://example.test/install.sh)"', { platform: 'darwin', home: "/home/me", owner: { uid: 501, gid: 20 }, marker: '/home/me/.clementine-next/state/elevated-install.marker' });
  assert.equal(mac?.command, 'osascript');
  const script = mac?.args[1] ?? '';
  assert.ok(script.startsWith('do shell script "env HOME=\'/home/me\' /bin/bash -c '), script);
  assert.ok(script.includes('curl -fsSL https://example.test/install.sh'), script);
  assert.ok(script.endsWith('" with administrator privileges'), script);
  assert.match(script, /find '\/home\/me' -xdev -user 0 -newer '\/home\/me\/\.clementine-next\/state\/elevated-install\.marker' -exec chown -h 501:20 \{\} \+/);
  assert.match(script, /exit \$__s/, 'the install\'s own exit code is what the job sees');
  assert.equal(mac?.marker, '/home/me/.clementine-next/state/elevated-install.marker');
  assert.match(mac?.prompt ?? '', /Clem never sees them/);
  const bare = elevatedInstallCommand('x', { platform: 'linux', home: '/home/o', owner: { uid: 1000, gid: 1000 } });
  assert.equal(bare?.command, 'pkexec');
  assert.doesNotMatch(bare?.args[2] ?? '', /chown/, 'without a marker nothing is re-owned');
  assert.equal(elevatedInstallCommand('x', { platform: 'win32' }), null);
});
