import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopTargets } from './vendor-whispercpp-desktop.mjs';

test('desktop whisper targets cover dual-arch Mac and x64 Windows', () => {
  assert.deepEqual(desktopTargets('darwin', 'arm64'), [
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
  ]);
  assert.deepEqual(desktopTargets('win32', 'x64'), ['x86_64-pc-windows-msvc']);
});

test('Linux packaging deliberately omits an unavailable local Whisper runtime', () => {
  assert.deepEqual(desktopTargets('linux', 'x64'), []);
  assert.deepEqual(desktopTargets('linux', 'arm64'), []);
});

test('unknown desktop targets fail instead of silently shipping a wrong binary', () => {
  assert.throws(() => desktopTargets('win32', 'arm64'), /unsupported on win32\/arm64/);
});
