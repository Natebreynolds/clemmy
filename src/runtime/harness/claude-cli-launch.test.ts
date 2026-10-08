import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { claudeCliLaunch, claudeSdkCliLaunchOptions, resolveClaudeCliOnPath } from './claude-cli-launch.js';

function fixture(run: (directory: string) => void | Promise<void>): void | Promise<void> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'claude-launch & % test-'));
  try {
    const result = run(directory);
    if (result instanceof Promise) return result.finally(() => rmSync(directory, { recursive: true, force: true }));
    rmSync(directory, { recursive: true, force: true });
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

function npmShim(directory: string, metadata = { name: '@anthropic-ai/claude-code', bin: { claude: 'cli.js' } }): string {
  const root = path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(metadata));
  const entry = path.join(root, 'cli.js');
  writeFileSync(entry, 'let prompt="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>prompt+=s);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({args:process.argv.slice(2),prompt,token:process.env.CLAUDE_CODE_OAUTH_TOKEN,other:process.env.ANTHROPIC_API_KEY,runAsNode:process.env.ELECTRON_RUN_AS_NODE})));');
  writeFileSync(path.join(directory, 'claude.cmd'), npmCmdShim('node_modules\\@anthropic-ai\\claude-code\\cli.js', true));
  return entry;
}

/** Byte-for-byte what npm's cmd-shim writes (npm 10, cmd-shim 7): a node
 *  script gets `"%_prog%"  "%dp0%\…"` with TWO spaces (empty args); a native
 *  target is run directly. Generated with cmd-shim on 2026-10-08. */
function npmCmdShim(target: string, nodeScript: boolean): string {
  const head = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n';
  if (!nodeScript) return `${head}"%dp0%\\${target}"   %*\r\n`;
  return `${head}\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n`
    + `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
}

test('Windows never starts npm\'s extensionless sh launcher; a real npm install resolves to its package entry', () => fixture(directory => {
  // A tester's install (2026-10-08): claude (sh), claude.cmd and claude.ps1 side
  // by side. The one-space shim pattern missed claude.cmd, the bare sh file was
  // spawned, and every Claude call ended the daemon with spawn ENOENT.
  const entry = npmShim(directory);
  writeFileSync(path.join(directory, 'claude'), '#!/bin/sh\nexec node "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"\n');
  writeFileSync(path.join(directory, 'claude.ps1'), '#!/usr/bin/env pwsh\n');
  assert.equal(resolveClaudeCliOnPath({ directories: [directory], platform: 'win32' }), entry);
  writeFileSync(path.join(directory, 'claude.cmd'), '@echo off\r\nnode other.js %*');
  assert.throws(() => resolveClaudeCliOnPath({ directories: [directory], platform: 'win32' }), /not a supported npm/,
    'an unreadable shim is refused, never replaced by the sh launcher');
}));

test('Windows runs a native npm Claude target directly and refuses a target the package did not declare', () => fixture(directory => {
  const root = path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  const native = path.join(root, 'bin', 'claude.exe'); writeFileSync(native, 'not executed');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'bin/claude.exe' } }));
  writeFileSync(path.join(directory, 'claude.cmd'), npmCmdShim('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', false));
  assert.equal(resolveClaudeCliOnPath({ directories: [directory], platform: 'win32' }), native);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'cli.js' } }));
  assert.throws(() => resolveClaudeCliOnPath({ directories: [directory], platform: 'win32' }), /not a supported npm/);
}));

test('Windows selects native exe before the co-located npm shim, while retaining PATH precedence', () => fixture(directory => {
  npmShim(directory);
  const native = path.join(directory, 'claude.exe');
  writeFileSync(native, 'not executed');
  const later = path.join(directory, 'later');
  mkdirSync(later); writeFileSync(path.join(later, 'claude.exe'), 'not executed');
  assert.equal(resolveClaudeCliOnPath({ directories: [directory, later], platform: 'win32' }), native);
}));

test('Windows unwraps a canonical npm shim to the same local package entry; explicit shim override also works', () => fixture(directory => {
  const entry = npmShim(directory);
  assert.equal(resolveClaudeCliOnPath({ directories: [directory], platform: 'win32' }), entry);
  assert.equal(resolveClaudeCliOnPath({ directories: [], override: path.join(directory, 'claude.cmd'), platform: 'win32' }), entry);
}));

test('Windows refuses arbitrary batch code, mismatched packages, and oversized shim content', () => fixture(directory => {
  npmShim(directory, { name: 'another-package', bin: { claude: 'cli.js' } });
  assert.throws(() => resolveClaudeCliOnPath({ directories: [directory], platform: 'win32' }), /not a supported npm/);
  const shim = path.join(directory, 'claude.cmd');
  writeFileSync(shim, '@echo off\r\nnode other.js %*');
  assert.throws(() => resolveClaudeCliOnPath({ directories: [], override: shim, platform: 'win32' }), /unsupported Windows batch/);
  writeFileSync(shim, 'x'.repeat(16 * 1024 + 1));
  assert.throws(() => resolveClaudeCliOnPath({ directories: [directory], platform: 'win32' }), /not a supported npm/);
}));

test('POSIX path and explicit overrides keep their existing selection and argv', () => fixture(directory => {
  const entry = path.join(directory, 'claude'); writeFileSync(entry, 'not executed');
  assert.equal(resolveClaudeCliOnPath({ directories: [directory], platform: 'darwin' }), entry);
  const override = path.join(directory, 'mine.cmd'); writeFileSync(override, 'not evaluated');
  assert.equal(resolveClaudeCliOnPath({ directories: [directory], override, platform: 'darwin' }), override);
  assert.equal(resolveClaudeCliOnPath({ directories: [directory], override: path.join(directory, 'absent'), platform: 'darwin' }), entry);
  const args = ['--model', 'claude-sonnet-5.5', '--system-prompt', 'a & b %PATH% "quoted"\nnext'];
  assert.deepEqual(claudeCliLaunch(entry, args, { platform: 'darwin' }), { command: entry, args, envPatch: {} });
  assert.deepEqual(claudeSdkCliLaunchOptions(entry, { platform: 'darwin' }), {});
}));

test('Windows JS launch preserves argv as individual bytes and uses packaged Node without a shell', () => {
  const cli = 'C:\\Users\\A & B\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
  const args = ['--model', 'claude-sonnet-5.5', '--system-prompt', '& calc %PATH% "q"\nline', ''];
  assert.deepEqual(claudeCliLaunch(cli, args, { platform: 'win32', execPath: 'C:\\Clem\\Clementine.exe', electron: true }), {
    command: 'C:\\Clem\\Clementine.exe', args: [cli, ...args], envPatch: { ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.deepEqual(claudeSdkCliLaunchOptions('C:\\claude.exe', { platform: 'win32' }), {});
});

test('SDK JS callback keeps exact args, owned env, and process I/O; no provider is invoked', async () => fixture(async directory => {
  const cli = npmShim(directory);
  const launch = claudeSdkCliLaunchOptions(cli, { platform: 'win32', execPath: process.execPath, electron: true });
  assert.equal(launch.executable, 'node');
  const args = [cli, '--model', 'claude-sonnet-5.5', '& calc %PATH% "q"\nline', ''];
  const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'fixture-owned-token' };
  delete env.ANTHROPIC_API_KEY;
  const child = launch.spawnClaudeCodeProcess!({ command: 'node', args, cwd: directory, env, signal: new AbortController().signal });
  const prompt = 'fixture prompt & %PATH% "q"\nnext';
  child.stdin.end(prompt);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  const ended = new Promise<void>(resolve => child.stdout.on('end', resolve));
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`)));
  });
  await ended;
  assert.deepEqual(JSON.parse(output), { args: args.slice(1), prompt, token: 'fixture-owned-token', runAsNode: '1' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, process.env.ELECTRON_RUN_AS_NODE, 'caller env was not modified');
  assert.throws(() => launch.spawnClaudeCodeProcess!({ command: 'node', args: ['other.js'], cwd: directory, env, signal: new AbortController().signal }), /selected CLI entry/);
}));

test('SDK JS callback forwards its SDK-owned abort signal to the child process', async () => fixture(async directory => {
  const cli = npmShim(directory);
  writeFileSync(cli, 'setInterval(()=>{},1000);');
  const launch = claudeSdkCliLaunchOptions(cli, { platform: 'win32', execPath: process.execPath, electron: false });
  const abortController = new AbortController();
  const child = launch.spawnClaudeCodeProcess!({ command: 'node', args: [cli], cwd: directory, env: process.env, signal: abortController.signal });
  const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
  const errored = new Promise<Error>(resolve => child.on('error', resolve));
  abortController.abort();
  assert.equal((await errored).name, 'AbortError');
  await exited;
  assert.equal(child.killed, true);
}));
