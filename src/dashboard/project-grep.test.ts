import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { grepProjectFiles } from './console-routes.js';

function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-test-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'function onSubmit() {}\nconst x = 1;\n');
  fs.writeFileSync(path.join(root, 'b.md'), '# Title\nTODO: write docs\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), 'export const onSubmit = 2;\n');
  // node_modules should be skipped entirely
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'onSubmit everywhere\n');
  // a binary file should be skipped
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x6f, 0x6e, 0x53]));
  return root;
}

test('finds matches across files, case-insensitive', () => {
  const root = makeTree();
  try {
    const r = grepProjectFiles(root, 'onsubmit');
    const files = r.matches.map((m) => m.rel).sort();
    assert.ok(files.includes('a.ts'));
    assert.ok(files.includes(path.join('src', 'c.ts')));
    // every match carries a 1-based line number and text
    assert.ok(r.matches.every((m) => m.line >= 1 && typeof m.text === 'string'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('skips node_modules', () => {
  const root = makeTree();
  try {
    const r = grepProjectFiles(root, 'onSubmit');
    assert.ok(!r.matches.some((m) => m.rel.includes('node_modules')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('skips binary files', () => {
  const root = makeTree();
  try {
    const r = grepProjectFiles(root, 'onS');
    assert.ok(!r.matches.some((m) => m.rel === 'bin.dat'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('respects maxMatches cap and reports truncation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-cap-'));
  try {
    fs.writeFileSync(path.join(root, 'many.txt'), Array.from({ length: 50 }, () => 'hit').join('\n'));
    const r = grepProjectFiles(root, 'hit', { maxMatches: 10 });
    assert.equal(r.matches.length, 10);
    assert.equal(r.truncated, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('returns no matches for an absent needle', () => {
  const root = makeTree();
  try {
    const r = grepProjectFiles(root, 'zzz-not-present');
    assert.equal(r.matches.length, 0);
    assert.ok(r.filesScanned >= 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
