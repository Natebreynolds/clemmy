/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/computer-access.test.ts
 *
 * The owner settles computer access once. These pin how the OS gates are read
 * (without prompting) and asked for (only when the owner presses the button).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-computer-access-'));
process.env.CLEMENTINE_HOME = path.join(HOME, '.clementine-next');
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, '.clementine-next', 'state'), { recursive: true });

const access = await import('./computer-access.js');
after(() => rmSync(HOME, { recursive: true, force: true }));

function fault(code: string): Error { return Object.assign(new Error(code), { code }); }

function probes(overrides: Partial<import('./computer-access.js').ComputerAccessProbes>) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  return {
    calls,
    probes: {
      platform: 'darwin' as NodeJS.Platform,
      homedir: '/Users/example',
      openForRead: () => undefined,
      listFolder: async () => [],
      run: async (command: string, args: readonly string[]) => { calls.push({ command, args }); return ''; },
      appExecutable: '/Applications/Clementine.app/Contents/MacOS/Clementine',
      ...overrides,
    },
  };
}

test('macOS Full Disk Access is read from the privacy database without any prompt', async () => {
  let opened = '';
  const granted = probes({ openForRead: (file) => { opened = file; } });
  assert.deepEqual(await access.computerAccessStatus(granted.probes, { choice: 'full', chosen: true }),
    { choice: 'full', chosen: true, platform: 'mac', mac: { fullDiskAccess: 'granted' } });
  assert.equal(opened, '/Users/example/Library/Application Support/com.apple.TCC/TCC.db');
  const refused = probes({ openForRead: () => { throw fault('EPERM'); } });
  assert.equal((await access.computerAccessStatus(refused.probes, { choice: 'standard', chosen: false })).mac?.fullDiskAccess, 'not_granted');
  const odd = probes({ openForRead: () => { throw fault('ENOENT'); } });
  assert.equal((await access.computerAccessStatus(odd.probes, { choice: 'standard', chosen: false })).mac?.fullDiskAccess, 'unknown');
});

test('asking for the protected folders lists each once and reports what macOS answered', async () => {
  const listed: string[] = [];
  const mac = probes({
    listFolder: async (folder) => {
      listed.push(folder);
      if (folder.endsWith('Documents')) throw fault('EPERM');
      if (folder.endsWith('Downloads')) throw fault('ENOENT');
      return [];
    },
  });
  assert.deepEqual(await access.requestMacFolderAccess(mac.probes), [
    { label: 'Desktop', folder: '/Users/example/Desktop', state: 'allowed' },
    { label: 'Documents', folder: '/Users/example/Documents', state: 'denied' },
    { label: 'Downloads', folder: '/Users/example/Downloads', state: 'missing' },
  ]);
  assert.equal(listed.length, 3);
  assert.deepEqual(await access.requestMacFolderAccess(probes({ platform: 'win32' }).probes), [], 'nothing to ask on Windows');
});

test('Windows Controlled Folder Access is read from Defender\'s own report, and an unreadable report is unknown', async () => {
  const exe = 'C:\\Users\\owner\\AppData\\Local\\Programs\\Clementine\\Clementine.exe';
  assert.deepEqual(access.parseControlledFolderReport('{"mode":0,"allowed":[]}', exe), { controlledFolderAccess: 'off', appAllowed: false });
  assert.deepEqual(access.parseControlledFolderReport(`{"mode":1,"allowed":["${exe.toUpperCase().replace(/\\/g, '\\\\')}"]}`, exe),
    { controlledFolderAccess: 'on', appAllowed: true });
  assert.equal(access.parseControlledFolderReport('{"mode":2,"allowed":null}', exe).controlledFolderAccess, 'audit');
  assert.deepEqual(access.parseControlledFolderReport('not json', exe), { controlledFolderAccess: 'unknown', appAllowed: null });
  const windows = probes({ platform: 'win32', appExecutable: exe, run: async () => '{"mode":1,"allowed":[]}' });
  assert.deepEqual(await access.computerAccessStatus(windows.probes, { choice: 'standard', chosen: false }),
    { choice: 'standard', chosen: false, platform: 'windows', windows: { controlledFolderAccess: 'on', appAllowed: false } });
  const noDefender = probes({ platform: 'win32', run: async () => { throw fault('ENOENT'); } });
  assert.equal((await access.computerAccessStatus(noDefender.probes, { choice: 'standard', chosen: false })).windows?.controlledFolderAccess, 'unknown');
});

test('the system page opens only on its own platform, through the system opener', async () => {
  const mac = probes({});
  assert.equal(await access.openSystemAccessPage('full_disk_access', mac.probes), true);
  assert.deepEqual(mac.calls, [{ command: 'open', args: ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'] }]);
  assert.equal(await access.openSystemAccessPage('controlled_folders', mac.probes), false);
  const win = probes({ platform: 'win32' });
  assert.equal(await access.openSystemAccessPage('controlled_folders', win.probes), true);
  assert.deepEqual(win.calls, [{ command: 'cmd.exe', args: ['/c', 'start', '', 'windowsdefender://ransomwareprotection'] }]);
});

test('the choice is its own file: absent means not chosen yet, and the policy file is never touched', async () => {
  const { existsSync, writeFileSync } = await import('node:fs');
  assert.deepEqual(access.storedComputerAccess(), { choice: 'standard', chosen: false }, 'nothing changes until the owner chooses');
  assert.equal(access.setComputerAccessChoice('full'), 'full');
  assert.deepEqual(access.storedComputerAccess(), { choice: 'full', chosen: true });
  assert.equal(access.computerAccessChoice(), 'full');
  assert.equal(access.setComputerAccessChoice('nonsense' as never), 'standard');
  assert.equal(existsSync(path.join(HOME, '.clementine-next', 'state', 'proactivity-policy.json')), false,
    'choosing access never writes a partial policy file (which would read as Ask mode)');
  writeFileSync(access.computerAccessFile(), '{not json');
  assert.deepEqual(access.storedComputerAccess(), { choice: 'standard', chosen: false }, 'an unreadable file is not a choice');
});
