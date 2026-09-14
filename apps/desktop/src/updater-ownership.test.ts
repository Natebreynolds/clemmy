import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as errors from './updater-errors.js';
import * as versions from './version-compare.js';

// Execute the real updater module with only OS/Electron side effects replaced.
// This exercises startup, check, native handoff and failed repair together.
function harness(inApplications = true) {
  const events = new Map<string, (...args: any[]) => void>();
  const calls = { checks: 0, installs: 0, admin: 0 };
  const autoUpdater = {
    on: (name: string, cb: (...args: any[]) => void) => events.set(name, cb),
    checkForUpdates: async () => { calls.checks++; },
    quitAndInstall: () => { calls.installs++; },
    downloadUpdate: async () => [],
  };
  const source = readFileSync(new URL('./updater.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} as any };
  const imports: Record<string, any> = {
    electron: {
      app: { isPackaged: true, isInApplicationsFolder: () => inApplications, getVersion: () => '3.18.6' },
      dialog: { showErrorBox: () => { throw new Error('blocking dialog'); } },
      Notification: class { show() {} },
    },
    'electron-updater': { autoUpdater },
    'node:child_process': { execFile: (_file: unknown, _args: unknown, _opts: unknown, cb: Function) => {
      calls.admin++; queueMicrotask(() => cb(new Error('cancelled'), '', 'Authorization cancelled'));
    } },
    'node:os': { userInfo: () => ({ username: 'fixture.owner' }) },
    'node:path': path,
    'node:fs': { accessSync: () => { throw new Error('EACCES'); }, constants: { W_OK: 2 },
      appendFileSync() {}, existsSync: () => true, mkdirSync() {} },
    './version-compare.js': versions, './updater-errors.js': errors,
  };
  vm.runInNewContext(code, { module, exports: module.exports,
    require: (id: string) => { assert.ok(id in imports, id); return imports[id]; },
    process: { platform: 'darwin', execPath: '/Applications/Clementine.app/Contents/MacOS/Clementine', env: {}, pid: 1 },
    setInterval: () => ({ unref() {} }), clearInterval() {}, queueMicrotask,
  });
  return { updater: module.exports, events, calls };
}

test('root-owned signed install still arms checks and reaches native installation without recursive chown', async () => {
  const { updater, events, calls } = harness();
  updater.initAutoUpdater({ logFile: '/fixture/supervisor.log' });
  assert.equal(calls.checks, 1);
  assert.equal(updater.getUpdaterStatus().installBlocker, undefined);
  await updater.checkForUpdatesNow();
  assert.equal(calls.checks, 2);
  assert.equal(calls.admin, 0);
  events.get('update-downloaded')!({ version: '3.18.7' });
  assert.equal(updater.applyUpdate().action, 'installing');
  assert.equal(calls.installs, 1);
});

test('translocated install remains blocked without requesting an ownership repair', async () => {
  const { updater, calls } = harness(false);
  updater.initAutoUpdater({ logFile: '/fixture/supervisor.log' });
  await updater.checkForUpdatesNow();
  assert.equal(updater.getUpdaterStatus().installBlocker, 'move-to-applications');
  assert.equal(calls.checks, 0);
  assert.equal(calls.admin, 0);
  assert.equal(updater.applyUpdate().ok, false);
});

test('explicit repair cancellation remains an inline error and does not prevent a subsequent update check', async () => {
  const { updater, calls } = harness();
  const result = await updater.repairAppOwnership();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'Authorization cancelled');
  assert.equal(updater.getUpdaterStatus().error, 'Authorization cancelled');
  await updater.checkForUpdatesNow();
  assert.equal(calls.admin, 1);
  assert.equal(calls.checks, 1);
  assert.equal(updater.getUpdaterStatus().error, undefined);
});

test('repair UI returns errors through the bridge without synchronous native dialogs', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const body = main.slice(main.indexOf('async function repairUpdateOwnershipFromUi('), main.indexOf('async function quitCleanly('));
  assert.ok(body.includes('repairResult: result'));
  assert.doesNotMatch(body, /dialog\.show(?:ErrorBox|MessageBoxSync)\s*\(/);
  assert.ok(body.includes("logNonFatal('update ownership repair failed'"));
});
