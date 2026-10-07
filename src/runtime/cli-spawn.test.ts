import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { spawnCliProcess } from './cli-spawn.js';
import { stopWindowsProcessTree } from './windows-process-tree.js';

test('actual Windows npm-style batch shim launches from a spaced Unicode path with literal catalog arguments', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'clem cli café & fixture-'));
  const shim = path.join(directory, 'catalog-cli.cmd');
  const program = path.join(directory, 'fixture.cjs');
  const output = path.join(directory, 'args.json');
  writeFileSync(program, `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2)));process.exit(7);`);
  // cmd.exe reads a batch file in the OEM code page, so the Unicode directory
  // must not be spelled inside it; %~dp0 is the shim's own (Unicode) folder.
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0fixture.cjs" %*\r\n`);
  const child = spawnCliProcess(shim, ['auth', 'login', '--web', '--scope=repo'], { cwd: directory, stdio: 'ignore', windowsHide: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exit = await Promise.race([
      once(child, 'close'),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('owned batch fixture timed out')), 5_000); }),
    ]);
    assert.equal(exit[0], 7, 'the real shim exit is retained');
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), ['auth', 'login', '--web', '--scope=repo']);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null) await stopWindowsProcessTree(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
