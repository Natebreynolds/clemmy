/**
 * Run: node scripts/run-tests-isolated.mjs apps/desktop/src/setup-access.test.ts
 *
 * First-run computer access, written before the daemon exists: the owner's
 * choice lands in the daemon's own file, adding a folder keeps the default
 * folders, and the OS gates are read without prompting.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-setup-access-'));
process.env.CLEMENTINE_HOME = path.join(HOME, '.clementine-next');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
mkdirSync(path.join(HOME, '.clementine-next', 'state'), { recursive: true });

const bridge = await import('./setup-bridge.js');
const setup = await import('./computer-access-setup.js');
after(() => rmSync(HOME, { recursive: true, force: true }));

test('the wizard saves the choice into the daemon\'s own file, and never writes a partial policy file', async () => {
  bridge.saveComputerAccess('full');
  const file = path.join(HOME, '.clementine-next', 'state', 'computer-access.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf-8')).choice, 'full');
  assert.equal(existsSync(path.join(HOME, '.clementine-next', 'state', 'proactivity-policy.json')), false,
    'a policy file holding only this field would read as Ask mode');
  const daemon = await import('../../../src/runtime/computer-access.js');
  assert.deepEqual(daemon.storedComputerAccess(), { choice: 'full', chosen: true }, 'the daemon reads what the wizard wrote');
});

test('adding a folder on a fresh install keeps the default folders instead of replacing them', () => {
  mkdirSync(path.join(HOME, 'Desktop'), { recursive: true });
  mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
  bridge.addWorkspaceDir(path.join(HOME, 'Clients'));
  const env = readFileSync(path.join(HOME, '.clementine-next', '.env'), 'utf-8');
  const dirs = (env.match(/^WORKSPACE_DIRS=(.*)$/m)?.[1] ?? '').replace(/^"|"$/g, '').split(',');
  assert.deepEqual(dirs, [path.join(HOME, 'Desktop'), path.join(HOME, 'Documents'), path.join(HOME, 'Clients')]);
});

test('the wizard\'s default folders are the daemon\'s default folders', async () => {
  const shared = await import('../../../src/tools/shared.js');
  assert.deepEqual([...bridge.DEFAULT_WORKSPACE_CANDIDATES], [...shared.DEFAULT_WORKSPACE_CANDIDATES]);
});

test('Full Disk Access is read without a prompt, and the folders are asked for only when pressed', async () => {
  const fault = (code: string) => Object.assign(new Error(code), { code });
  assert.equal(setup.macFullDiskAccess('/Users/o', () => undefined), 'granted');
  assert.equal(setup.macFullDiskAccess('/Users/o', () => { throw fault('EPERM'); }), 'not_granted');
  assert.equal(setup.macFullDiskAccess('/Users/o', () => { throw fault('ENOENT'); }), 'unknown');
  const asked: string[] = [];
  const folders = await setup.requestSetupFolders('/Users/o', async (folder) => {
    asked.push(folder);
    if (folder.endsWith('Documents')) throw fault('EPERM');
  });
  assert.deepEqual(folders, [
    { label: 'Desktop', state: 'allowed' }, { label: 'Documents', state: 'denied' }, { label: 'Downloads', state: 'allowed' },
  ]);
  assert.equal(asked.length, 3);
  assert.deepEqual(setup.parseControlledFolderReport('{"mode":1,"allowed":["C:\\\\x\\\\Clementine.exe"]}', 'c:\\x\\clementine.exe'),
    { controlledFolderAccess: 'on', appAllowed: true });
  assert.equal(setup.setupAccessPageUrl('full_disk_access'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
});
