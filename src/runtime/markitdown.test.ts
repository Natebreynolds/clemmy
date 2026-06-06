import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CONVERTIBLE_EXTENSIONS,
  UV_TARGETS,
  convertToMarkdown,
  isConvertibleExtension,
  uvTargetForHost,
  vendoredUvPath,
} from './markitdown.js';

test('uvTargetForHost maps every supported platform/arch', () => {
  assert.equal(uvTargetForHost('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.equal(uvTargetForHost('darwin', 'x64'), 'x86_64-apple-darwin');
  assert.equal(uvTargetForHost('linux', 'x64'), 'x86_64-unknown-linux-gnu');
  assert.equal(uvTargetForHost('linux', 'arm64'), 'aarch64-unknown-linux-gnu');
  assert.equal(uvTargetForHost('win32', 'x64'), 'x86_64-pc-windows-msvc');
});

test('uvTargetForHost returns null for unsupported hosts', () => {
  assert.equal(uvTargetForHost('linux', 'ia32'), null);
  assert.equal(uvTargetForHost('win32', 'arm64'), null);
  assert.equal(uvTargetForHost('freebsd' as NodeJS.Platform, 'x64'), null);
});

test('every mapped target is one we vendor', () => {
  const mapped = [
    uvTargetForHost('darwin', 'arm64'),
    uvTargetForHost('darwin', 'x64'),
    uvTargetForHost('linux', 'x64'),
    uvTargetForHost('linux', 'arm64'),
    uvTargetForHost('win32', 'x64'),
  ];
  for (const t of mapped) {
    assert.ok(t && UV_TARGETS.includes(t), `${t} should be in UV_TARGETS`);
  }
});

test('vendoredUvPath points at the per-target binary, .exe on windows', () => {
  const nix = vendoredUvPath('aarch64-apple-darwin', 'darwin');
  assert.ok(nix);
  assert.ok(nix.endsWith(path.join('vendor', 'uv', 'aarch64-apple-darwin', 'uv')));

  const win = vendoredUvPath('x86_64-pc-windows-msvc', 'win32');
  assert.ok(win);
  assert.ok(win.endsWith('uv.exe'));

  assert.equal(vendoredUvPath(null, 'darwin'), null);
});

test('isConvertibleExtension routes binary/office formats, not text', () => {
  for (const ext of ['.pdf', '.docx', '.pptx', '.xlsx', '.epub', '.png', '.mp3']) {
    assert.equal(isConvertibleExtension(`/tmp/file${ext}`), true, `${ext} should convert`);
  }
  for (const ext of ['.txt', '.md', '.json', '.csv', '.html', '.xml', '.ts']) {
    assert.equal(isConvertibleExtension(`/tmp/file${ext}`), false, `${ext} should stay raw`);
  }
  // case-insensitive
  assert.equal(isConvertibleExtension('/tmp/SCAN.PDF'), true);
});

test('CONVERTIBLE_EXTENSIONS excludes plain-text formats', () => {
  for (const ext of ['.txt', '.md', '.json', '.csv', '.html', '.xml']) {
    assert.equal(CONVERTIBLE_EXTENSIONS.has(ext), false);
  }
});

test('convertToMarkdown returns structured error for a missing file (no network)', async () => {
  const missing = path.join(os.tmpdir(), 'clem-markitdown-does-not-exist-xyz.pdf');
  const result = await convertToMarkdown(missing);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /does not exist/i);
});
