import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyBrowserHarnessSkillResources, findWindowsSetupExecutable, installBrowserHarnessOnWindows, openWindowsChromeDebuggingSetup,
  runWindowsSetupCommand, WINDOWS_BROWSER_HARNESS_SOURCE as source, windowsBrowserHarnessEnv,
  type WindowsInstallIO, type WindowsSetupCommand, type WindowsSetupResult } from './browser-harness-windows-setup.js';

const home = 'C:\\Users\\Zoë & Tools'; const repo = path.win32.join(home, 'Developer', 'browser-harness');
const git = 'C:\\Program Files\\Git\\cmd\\git.exe'; const uv = 'C:\\Tools & Apps\\uv.exe';
const python = 'C:\\Tools & Apps\\uv\\browser-harness\\Scripts\\python.exe';
const success = (stdout = ''): WindowsSetupResult => ({ ok: true, command: 'controlled command', code: 0, stdout, stderr: '', output: stdout });

function installation(options: { existing?: boolean; dirty?: boolean; wrongSource?: boolean; wrongOrigin?: boolean; uvFailure?: boolean; probeFailure?: boolean; missingPython?: boolean } = {}) {
  const calls: WindowsSetupCommand[] = []; const copied: Array<{ repository: string; destinations: string[] }> = []; const created: string[] = [];
  const io: WindowsInstallIO = {
    exists: () => options.existing ?? false, isDirectory: () => true, ensureDirectory: file => { created.push(file); },
    copySkills: (repository, destinations) => { copied.push({ repository, destinations }); }, findPython: () => options.missingPython ? null : python,
    run: async (command, onOutput) => {
      calls.push(command);
      if ((command.executable === uv && options.uvFailure) || (command.executable === python && options.probeFailure)) return { ...success(), ok: false, code: 1, stderr: 'controlled dependency refusal', output: 'controlled dependency refusal' };
      let text = '';
      if (command.args.includes('rev-parse')) text = options.wrongSource ? 'f'.repeat(40) : source.revision;
      else if (command.args.includes('get-url')) text = options.wrongOrigin ? 'https://other.invalid/repo' : source.repository;
      else if (command.args.includes('--porcelain')) text = options.dirty ? ' M src/browser_harness/run.py' : '';
      else if (command.executable === python) text = '{"python":"3.12","libraries":{"browser-harness":"0.1.13"}}';
      onOutput?.(text); return success(text);
    },
  };
  return { calls, copied, created, execute: () => installBrowserHarnessOnWindows({ git, uv, home, env: { Path: 'D:\\Tool chain', CLEMENTINE_HOME: 'D:\\Clem fixture', CODEX_HOME: 'D:\\Codex fixture' }, io }) };
}

test('fresh Windows install verifies immutable upstream identity before dependency installation and copies full skill destinations', async () => {
  const fixture = installation(); const receipt = await fixture.execute();
  assert.equal(receipt.ok, true, receipt.output);
  assert.deepEqual(fixture.calls[0]?.args, ['clone', '--no-checkout', '--single-branch', '--branch', source.tag, source.repository, repo]);
  assert.deepEqual(fixture.calls[1]?.args, ['-C', repo, 'rev-parse', `refs/tags/${source.tag}^{commit}`]);
  assert.deepEqual(fixture.calls[2]?.args, ['-C', repo, 'checkout', '--detach', source.revision]);
  const installed = fixture.calls.find(command => command.executable === uv)!;
  assert.deepEqual(installed.args, ['tool', 'install', '--python', '3.12', '--editable', repo]);
  assert.equal(installed.env.GIT_TERMINAL_PROMPT, '0'); assert.equal(installed.env.GCM_INTERACTIVE, 'never');
  assert.ok(fixture.calls.every(command => command.cwd === home && command.timeoutMs <= 300_000));
  const verified = fixture.calls.find(command => command.executable === python)!;
  assert.equal(verified.args[0], '-I'); assert.equal(verified.args[1], '-c');
  assert.match(verified.args[2]!, /"cdp-use":"1\.4\.5"/); assert.match(verified.args[2]!, /CDPClient\.send_raw/);
  assert.ok(!verified.args[2]!.includes('browser_harness.run'), 'qualification cannot execute upstream CLI/learned helpers');
  assert.deepEqual(fixture.copied, [{ repository: repo, destinations: ['D:\\Codex fixture\\skills\\browser-harness', 'D:\\Clem fixture\\skills\\browser-harness'] }]);
  assert.match(receipt.output, /Local browser connection remains unverified/);
});

test('moved upstream tag refuses before checkout or Python dependency effects', async () => {
  const fixture = installation({ wrongSource: true }); const receipt = await fixture.execute();
  assert.equal(receipt.ok, false); assert.match(receipt.output, /tag does not match/);
  assert.equal(fixture.calls.length, 2); assert.deepEqual(fixture.copied, []);
});

test('different source, local edits and unexpected origin are preserved without pull, reset, checkout, package install or skill copies', async () => {
  for (const option of [{ wrongSource: true }, { dirty: true }, { wrongOrigin: true }]) {
    const fixture = installation({ existing: true, ...option }); const receipt = await fixture.execute();
    assert.equal(receipt.ok, false); assert.match(receipt.output, /preserved/);
    assert.ok(fixture.calls.every(command => command.executable === git));
    assert.ok(fixture.calls.every(command => !command.args.some(arg => ['pull', 'reset', 'checkout', 'clone'].includes(arg))));
    assert.deepEqual(fixture.created, []); assert.deepEqual(fixture.copied, []);
  }
});

test('uv failure, missing exact interpreter and failed dependency/API checks never establish setup success', async () => {
  for (const option of [{ uvFailure: true }, { missingPython: true }, { probeFailure: true }]) {
    const fixture = installation({ existing: true, ...option }); const receipt = await fixture.execute();
    assert.equal(receipt.ok, false); assert.deepEqual(fixture.copied, []);
    assert.ok(!receipt.output.includes('Local browser connection remains unverified'), 'success suffix is absent after failure');
  }
});

test('Windows environment retains credentials privately and one case-normalized PATH; custom uv tool bin is discoverable', () => {
  const env = { Path: 'D:\\Tools;.;"D:\\Other tools"', UV_TOOL_BIN_DIR: 'D:\\Custom uv\\bin', TEST_CONFIG: 'kept' };
  const resolved = windowsBrowserHarnessEnv(env, home);
  assert.equal(Object.keys(resolved).filter(key => key.toLowerCase() === 'path').length, 1);
  assert.ok(resolved.PATH!.startsWith('D:\\Custom uv\\bin;')); assert.equal(resolved.TEST_CONFIG, 'kept');
  const inspected: string[] = [];
  const command = findWindowsSetupExecutable('uv', env, home, file => { inspected.push(file); return file === 'D:\\Other tools\\uv.exe'; });
  assert.equal(command, 'D:\\Other tools\\uv.exe'); assert.ok(inspected.every(file => /^[a-z]:\\/i.test(file)));
  assert.equal(findWindowsSetupExecutable('uv', { Path: '.' }, home, file => file === 'uv.exe'), undefined);
});

test('skill copies preserve exact bounded Markdown guides, refuse link escapes and leave unrelated files intact', () => {
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clem-browser-skills-')));
  try {
    const repository = path.join(temporary, 'repo'); const destination = path.join(temporary, 'skill');
    mkdirSync(path.join(repository, 'interaction-skills'), { recursive: true }); mkdirSync(destination);
    writeFileSync(path.join(repository, 'SKILL.md'), '# Browser\nRead interaction-skills/connection.md\n');
    writeFileSync(path.join(repository, 'install.md'), '# Setup\n');
    writeFileSync(path.join(repository, 'interaction-skills', 'connection.md'), '# Connection\n猫\n');
    writeFileSync(path.join(repository, 'interaction-skills', 'must-not-execute.py'), 'raise Exception()');
    writeFileSync(path.join(destination, 'user-note.txt'), 'preserve');
    copyBrowserHarnessSkillResources(repository, [destination]);
    assert.equal(readFileSync(path.join(destination, 'interaction-skills', 'connection.md'), 'utf8'), '# Connection\n猫\n');
    assert.equal(readFileSync(path.join(destination, 'user-note.txt'), 'utf8'), 'preserve');
    assert.equal(existsSync(path.join(destination, 'interaction-skills', 'must-not-execute.py')), false);
    const outside = path.join(temporary, 'outside'); mkdirSync(outside);
    symlinkSync(outside, path.join(repository, 'interaction-skills', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => copyBrowserHarnessSkillResources(repository, [destination]), /symbolic links/);
    const targetLink = path.join(temporary, 'target-link'); symlinkSync(outside, targetLink, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => copyBrowserHarnessSkillResources(repository, [targetLink]), /symbolic links|links or junctions/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('Chrome setup launches exact known Chrome with literal settings URL and reports permission/connection still pending', async () => {
  const launches: Array<{ executable: string; args: string[]; options: unknown }> = [];
  let unreferenced = false;
  const launch = ((executable: string, args: string[], options: unknown) => {
    launches.push({ executable, args, options }); const child = new EventEmitter();
    Object.assign(child, { unref() { unreferenced = true; } }); queueMicrotask(() => child.emit('spawn')); return child;
  }) as typeof spawn;
  const receipt = await openWindowsChromeDebuggingSetup({ env: { ProgramFiles: 'D:\\Apps' }, isFile: file => file === 'D:\\Apps\\Google\\Chrome\\Application\\chrome.exe', launch });
  assert.equal(receipt.ok, true); assert.deepEqual(launches[0]?.args, ['chrome://inspect/#remote-debugging']);
  assert.deepEqual(launches[0]?.options, { shell: false, detached: true, windowsHide: false, stdio: 'ignore' });
  assert.equal(unreferenced, true); assert.match(receipt.output, /not yet verified/); assert.match(receipt.output, /same operation/);
  assert.ok(!JSON.stringify(launches).includes('--remote-debugging-port')); assert.ok(!JSON.stringify(launches).includes('--user-data-dir'));
  const missing = await openWindowsChromeDebuggingSetup({ env: {}, isFile: () => false, launch });
  assert.equal(missing.ok, false); assert.equal(launches.length, 1); assert.match(missing.output, /Google Chrome was not found/);
});

test('bounded literal-argv executor captures real child exit failure without shell expansion', async () => {
  const receipt = await runWindowsSetupCommand({ executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1]);process.stderr.write("failed");process.exit(7)', 'literal & %PATH% $(never)'], cwd: os.tmpdir(), env: process.env, timeoutMs: 5_000 });
  assert.equal(receipt.ok, false); assert.equal(receipt.code, 7); assert.equal(receipt.stdout, 'literal & %PATH% $(never)'); assert.equal(receipt.stderr, 'failed');
});
