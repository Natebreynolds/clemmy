import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const target = { id: 'fixture', command: 'fixture-cli' };
const roster = { fixture: { ...target, name: 'Fixture', vendor: 'Fixture' } };
const observed = { ...target, installed: true, binaryPath: '/selected/bin/fixture-cli', authStatus: 'unknown' };
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cli-selection-'));
process.env.CLEMENTINE_HOME = home;
mkdirSync(path.join(home, 'state'), { recursive: true });
const { readConnectedCliExecutableSelection, selectConnectedCliExecutable, reviewedCliExecutableFileIsSupported }
  = await import('./connected-cli-executable-selection.js');
after(() => rmSync(home, { recursive: true, force: true }));

test('exact installed path selection carries no authentication, account or effect claim', () => {
  for (const authStatus of ['unknown', 'ok', 'signed_out', 'error']) {
    const result = selectConnectedCliExecutable(target, { connected: roster, forgotten: [], platform: 'darwin',
      health: { fixture: { ...observed, authStatus, username: 'never-project', issue: 'configuration_required',
        lastProbeError: { timedOut: true }, staleSince: 'old' } } });
    assert.deepEqual(result, { status: 'selected', executablePath: observed.binaryPath, executableIdentity: observed.binaryPath });
  }
});

test('only absent connected/health observations allow bootstrap fallback', () => {
  assert.deepEqual(selectConnectedCliExecutable(target, { connected: {}, health: {}, forgotten: [] }),
    { status: 'unbound', reason: 'not_connected' });
  assert.deepEqual(selectConnectedCliExecutable(target, { connected: roster, health: {}, forgotten: [] }),
    { status: 'unbound', reason: 'not_observed' });
  const inherited = Object.create({ fixture: observed });
  assert.deepEqual(selectConnectedCliExecutable(target, { connected: roster, health: inherited, forgotten: [] }),
    { status: 'unbound', reason: 'not_observed' });
  assert.deepEqual(selectConnectedCliExecutable(target, { connected: Object.create(roster), health: { fixture: observed }, forgotten: [] }),
    { status: 'unbound', reason: 'not_connected' });
});

test('forgotten or mismatched observations cannot silently become another PATH executable', () => {
  assert.deepEqual(selectConnectedCliExecutable(target, { connected: roster, health: {}, forgotten: ['fixture'] }),
    { status: 'blocked', reason: 'forgotten' });
  for (const patch of [{ id: 'other' }, { command: ' fixture-cli ' }]) {
    assert.deepEqual(selectConnectedCliExecutable(target, { connected: { fixture: { ...target, ...patch } }, health: {}, forgotten: [] }),
      { status: 'blocked', reason: 'roster_identity_mismatch' });
    assert.deepEqual(selectConnectedCliExecutable(target, { connected: roster, health: { fixture: { ...observed, ...patch } }, forgotten: [] }),
      { status: 'blocked', reason: 'health_identity_mismatch' });
  }
});

test('present corrupt containers/rows and missing selected paths block rather than permit fallback', () => {
  for (const bad of [null, [], 42, 'bad']) {
    assert.deepEqual(selectConnectedCliExecutable(target, { connected: bad, health: {}, forgotten: [] }),
      { status: 'blocked', reason: 'malformed_roster' });
    assert.deepEqual(selectConnectedCliExecutable(target, { connected: roster, health: bad, forgotten: [] }),
      { status: 'blocked', reason: 'malformed_health' });
    assert.deepEqual(selectConnectedCliExecutable(target, { connected: roster, health: { fixture: bad }, forgotten: [] }),
      { status: 'blocked', reason: 'malformed_health' });
  }
  for (const binaryPath of [undefined, '', 'fixture-cli', ' /selected/bin/fixture-cli', '/selected/bin/fixture-cli\n']) {
    assert.deepEqual(selectConnectedCliExecutable(target, { connected: roster,
      health: { fixture: { ...observed, binaryPath } }, forgotten: [], platform: 'darwin' }),
    { status: 'blocked', reason: 'missing_executable_identity' });
  }
  assert.deepEqual(selectConnectedCliExecutable(target, { connected: roster,
    health: { fixture: { ...observed, installed: false } }, forgotten: [] }), { status: 'blocked', reason: 'not_installed' });
});

test('Windows accepts explicit native-executable path spellings and retains literal original path', () => {
  for (const binaryPath of ['C:\\Program Files\\Fixture Café\\tool.EXE', '\\\\server\\share\\Fixture\\tool.exe']) {
    const result = selectConnectedCliExecutable(target, { connected: roster,
      health: { fixture: { ...observed, binaryPath } }, forgotten: [], platform: 'win32' });
    assert.deepEqual(result, { status: 'selected', executablePath: binaryPath,
      executableIdentity: path.win32.normalize(binaryPath).toLowerCase() });
  }
});

test('Windows never infers a drive or a batch/script interpreter from an observed path', () => {
  for (const binaryPath of ['tool.exe', '\\rooted\\tool.exe', 'C:relative\\tool.exe', '\\\\server', ' C:\\tool.exe']) {
    assert.deepEqual(selectConnectedCliExecutable(target, { connected: roster,
      health: { fixture: { ...observed, binaryPath } }, forgotten: [], platform: 'win32' }),
    { status: 'blocked', reason: 'missing_executable_identity' });
  }
  for (const binaryPath of ['C:\\bin\\tool.cmd', 'C:\\bin\\tool.bat', 'C:\\bin\\tool.ps1', 'C:\\bin\\tool', 'C:\\bin\\tool.com']) {
    assert.deepEqual(selectConnectedCliExecutable(target, { connected: roster,
      health: { fixture: { ...observed, binaryPath } }, forgotten: [], platform: 'win32' }),
    { status: 'blocked', reason: 'unsupported_windows_launcher' });
  }
});

test('regular Windows .exe admission does not depend on POSIX execute bits or admit script interpreters', () => {
  assert.equal(reviewedCliExecutableFileIsSupported({ executablePath: 'C:\\bin\\tool.exe', isFile: true, mode: 0o666, platform: 'win32' }), true);
  assert.equal(reviewedCliExecutableFileIsSupported({ executablePath: 'C:\\bin\\tool.exe', isFile: false, mode: 0o777, platform: 'win32' }), false);
  for (const extension of ['cmd', 'bat', 'ps1', 'com']) {
    assert.equal(reviewedCliExecutableFileIsSupported({ executablePath: `C:\\bin\\tool.${extension}`, isFile: true, mode: 0o777, platform: 'win32' }), false);
  }
  assert.equal(reviewedCliExecutableFileIsSupported({ executablePath: '/bin/fixture', isFile: true, mode: 0o644n, platform: 'darwin' }), false);
  assert.equal(reviewedCliExecutableFileIsSupported({ executablePath: '/bin/fixture', isFile: true, mode: 0o755n, platform: 'darwin' }), true);
  assert.equal(reviewedCliExecutableFileIsSupported({ executablePath: '/bin/fixture', isFile: false, mode: 0o755, platform: 'darwin' }), false);
});

test('read-only metadata accessor distinguishes absent bootstrap files from corrupt observations', () => {
  const selected = () => readConnectedCliExecutableSelection(target, { baseDir: home, platform: 'darwin' });
  assert.equal(selected().status, 'unbound');
  writeFileSync(path.join(home, 'state', 'connected-clis.json'), JSON.stringify({ version: 'v1', entries: roster }));
  assert.deepEqual(selected(), { status: 'unbound', reason: 'not_observed' });
  writeFileSync(path.join(home, 'state', 'cli-auth-health.json'), '{broken');
  assert.deepEqual(selected(), { status: 'blocked', reason: 'malformed_health' });
  writeFileSync(path.join(home, 'state', 'cli-auth-health.json'), JSON.stringify({ version: 'v1', entries: { fixture: observed } }));
  assert.equal(selected().status, 'selected');
  writeFileSync(path.join(home, 'state', 'connected-clis.json'), JSON.stringify({ version: 'v1', entries: roster, forgotten: ['fixture'] }));
  assert.deepEqual(selected(), { status: 'blocked', reason: 'forgotten' });
  writeFileSync(path.join(home, 'state', 'connected-clis.json'), JSON.stringify({ version: 'v1', entries: roster, forgotten: {} }));
  assert.deepEqual(selected(), { status: 'blocked', reason: 'malformed_roster' });
});
