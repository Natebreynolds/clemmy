import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { findBrowserHarnessPython } from './browser-python.js';

function fixture(entries: Record<string, string | Buffer>, platform: NodeJS.Platform = 'win32', env: NodeJS.ProcessEnv = {}) {
  const inspected: string[] = [];
  const files = {
    isFile: (file: string) => Object.hasOwn(entries, file),
    read: (file: string) => {
      inspected.push(file);
      const value = entries[file];
      if (value === undefined) throw new Error('Missing file');
      return Buffer.isBuffer(value) ? value : Buffer.from(value);
    },
  };
  return { resolve: () => findBrowserHarnessPython({ platform, home: platform === 'win32' ? 'C:\\Users\\Tester' : '/home/tester', env, files }), inspected };
}

const bin = 'C:\\Users\\Tester\\.local\\bin';
const venv = 'C:\\Users\\Tester\\AppData\\Roaming\\uv\\tools\\browser-harness';
const python = path.win32.join(venv, 'Scripts', 'python.exe');
const config = path.win32.join(venv, 'pyvenv.cfg');
const exe = (interpreter: string) => Buffer.from(`MZ\0launcher bytes#!${interpreter}\r\nPK\x03\x04zip payload`, 'utf8');

test('Windows copied uv launcher resolves its embedded venv rather than system Python', () => {
  // pip/distlib places the shebang between the PE and ZIP; current uv places
  // it in the uncompressed __main__.py ZIP payload within the PE resources.
  for (const launcher of [exe(python), Buffer.from(`MZ\0UV_SCRIPT_DATA\0PK\x03\x04__main__.py#!${python}\nfrom browser_harness.run import main\n`)]) {
    const f = fixture({ [path.win32.join(bin, 'browser-harness.exe')]: launcher, [python]: '', [config]: '' }, 'win32', { PATH: 'C:\\SystemPython' });
    assert.equal(f.resolve(), python);
    assert.deepEqual(f.inspected, [path.win32.join(bin, 'browser-harness.exe')]);
  }
});

test('Windows copied launcher preserves quoted paths with spaces and Unicode', () => {
  const root = 'D:\\Clem tools\\猫\\browser-harness';
  const interpreter = path.win32.join(root, 'Scripts', 'python.exe');
  for (const line of [interpreter, `"${interpreter}"`]) {
    const f = fixture({ [path.win32.join(bin, 'browser-harness.exe')]: exe(line), [interpreter]: '', [path.win32.join(root, 'pyvenv.cfg')]: '' });
    assert.equal(f.resolve(), interpreter);
  }
});

test('Windows Scripts launcher binds its adjacent interpreter without reading or running the shim', () => {
  for (const name of ['browser-harness.exe', 'browser-harness.cmd', 'browser-harness.bat']) {
    const f = fixture({ [path.win32.join(venv, 'Scripts', name)]: 'This must never be executed', [python]: '', [config]: '' }, 'win32', { PATH: `"${path.win32.join(venv, 'Scripts')}"` });
    assert.equal(f.resolve(), python);
    assert.deepEqual(f.inspected, []);
  }
});

test('an exposed Windows shell wrapper outside Scripts cannot select arbitrary shell code or system Python', () => {
  const f = fixture({ [path.win32.join(bin, 'browser-harness.cmd')]: `@echo off\r\n"${python}" run.py\r\n`, [python]: '', [config]: '', 'C:\\SystemPython\\python.exe': '' }, 'win32', { PATH: 'C:\\SystemPython' });
  assert.equal(f.resolve(), null);
  assert.deepEqual(f.inspected, []);
});

test('Windows launcher without its venv or exact interpreter refuses before dispatch', () => {
  for (const absent of [python, config]) {
    const entries = { [path.win32.join(bin, 'browser-harness.exe')]: exe(python), [python]: '', [config]: '' };
    delete entries[absent];
    assert.equal(fixture(entries).resolve(), null);
  }
});

test('malformed Windows launcher arguments and relative paths cannot become an interpreter command', () => {
  for (const interpreter of ['python.exe', '\\venv\\Scripts\\python.exe', `${python} -c arbitrary`, `"${python}" -I`, 'C:\\Python\\python.exe', 'C:\\venv\\Scripts\\pythonw.exe']) {
    assert.equal(fixture({ [path.win32.join(bin, 'browser-harness.exe')]: exe(interpreter), [interpreter]: '', [config]: '' }).resolve(), null, interpreter);
  }
});

test('a text masquerading as an exe and a bare system Python do not establish an installed backend', () => {
  assert.equal(fixture({ [path.win32.join(bin, 'browser-harness.exe')]: `#!${python}\n`, [python]: '', [config]: '' }).resolve(), null);
  assert.equal(fixture({ [python]: '', [config]: '' }, 'win32', { PATH: path.win32.dirname(python) }).resolve(), null);
});

test('broken earlier Windows installation permits a later exact installed launcher', () => {
  const second = 'E:\\Installed tools';
  const f = fixture({ [path.win32.join(bin, 'browser-harness.exe')]: exe('C:\\Gone\\Scripts\\python.exe'), [path.win32.join(second, 'browser-harness.exe')]: exe(python), [python]: '', [config]: '' }, 'win32', { PATH: second });
  assert.equal(f.resolve(), python);
});

test('empty PATH entries never discover a backend in the working directory', () => {
  const f = fixture({ 'browser-harness.exe': exe(python), [python]: '', [config]: '' }, 'win32', { PATH: ';' });
  assert.equal(f.resolve(), null);
  assert.deepEqual(f.inspected, []);
});

test('Windows Path spelling and a configured uv tool executable directory select the exact installed venv', () => {
  for (const env of [{ Path: 'D:\\Custom tools' }, { UV_TOOL_BIN_DIR: 'D:\\Custom tools', Path: '' }]) {
    const f = fixture({ 'D:\\Custom tools\\browser-harness.exe': exe(python), [python]: '', [config]: '' }, 'win32', env);
    assert.equal(f.resolve(), python);
  }
  const relative = fixture({ 'relative\\browser-harness.exe': exe(python), [python]: '', [config]: '' }, 'win32', { Path: 'relative' });
  assert.equal(relative.resolve(), null);
});

test('POSIX installed venv shebang remains the exact interpreter authority', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const interpreter = '/home/tester/.local/share/uv/tools/browser-harness/bin/python3.12';
    const f = fixture({ '/home/tester/.local/bin/browser-harness': `#!${interpreter}\nimport browser_harness\n`, [interpreter]: '' }, platform);
    assert.equal(f.resolve(), interpreter);
    assert.deepEqual(f.inspected, ['/home/tester/.local/bin/browser-harness']);
  }
});

test('POSIX never executes env launchers or accepts an unrelated interpreter fallback', () => {
  for (const firstLine of ['#!/usr/bin/env python3', '#!/bin/sh', '#!/gone/bin/python3']) {
    const f = fixture({ '/home/tester/.local/bin/browser-harness': `${firstLine}\n`, '/usr/bin/python3': '' }, 'darwin', { PATH: '/usr/bin' });
    assert.equal(f.resolve(), null);
  }
});
