import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-read-revision-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { readResourceRevision } = await import('./read-resource-revision.js');

function touchForward(filePath: string, seconds: number): void {
  const st = statSync(filePath);
  utimesSync(filePath, st.atime, new Date(st.mtimeMs + seconds * 1000));
}

test('a declared local read carries a revision that moves with the file and never with an unrelated one', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-read-revision-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'notes.md');
  writeFileSync(file, 'one');
  const first = readResourceRevision('read_file', { path: file });
  assert.ok(first, 'an existing file has a revision');
  assert.equal(readResourceRevision('read_file', { path: file }), first, 'stable while untouched');
  writeFileSync(path.join(dir, 'other.md'), 'noise');
  assert.equal(readResourceRevision('read_file', { path: file }), first, 'a sibling file does not move a single-file revision');
  writeFileSync(file, 'two'); touchForward(file, 5);
  assert.notEqual(readResourceRevision('read_file', { path: file }), first, 'an edit moves it');
  assert.equal(readResourceRevision('read_file', { path: path.join(dir, 'missing.md') }), null, 'a missing file has no revision, so no reuse');
  const listing = readResourceRevision('list_files', { directory: dir, limit: null });
  assert.ok(listing);
  writeFileSync(path.join(dir, 'added.md'), 'new entry');
  assert.notEqual(readResourceRevision('list_files', { directory: dir, limit: null }), listing, 'a directory listing moves when an entry is added');
});

test('a Space read is bound to its directory and the canonical store; undeclared reads and traversal have no revision', t => {
  const spaces = path.join(TMP_HOME, 'spaces', 'acceptance-notes');
  mkdirSync(spaces, { recursive: true });
  writeFileSync(path.join(spaces, 'manifest.json'), '{"title":"a"}');
  writeFileSync(path.join(spaces, 'data.json'), '{}');
  const canonicalDir = path.join(TMP_HOME, 'state', 'canonical-entities');
  mkdirSync(canonicalDir, { recursive: true });
  const canonical = path.join(canonicalDir, 'canonical-entities.db');
  writeFileSync(canonical, 'db');
  t.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));
  const first = readResourceRevision('space_get', { slug: 'acceptance-notes' });
  assert.ok(first);
  writeFileSync(`${canonical}-wal`, 'projection landed');
  const afterProjection = readResourceRevision('space_get', { slug: 'acceptance-notes' });
  assert.notEqual(afterProjection, first, 'a host projection through the WAL moves the Space revision');
  writeFileSync(path.join(spaces, 'data.json'), '{"rows":1}'); touchForward(path.join(spaces, 'data.json'), 5);
  assert.notEqual(readResourceRevision('space_get', { slug: 'acceptance-notes' }), afterProjection, 'a dataset write moves it');
  assert.equal(readResourceRevision('space_get', { slug: '../etc' }), null, 'traversal never resolves');
  assert.equal(readResourceRevision('space_get', { slug: 'missing-space' }), null);
  assert.equal(readResourceRevision('workflow_run_status', { run_id: 'x' }), null, 'a status poll declares no revision and is never reused');
  assert.equal(readResourceRevision('skill_read', { name: 'x' }), null, 'a read without a declared revision source is never reused');
  mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
  writeFileSync(path.join(TMP_HOME, 'state', 'memory.db'), 'm');
  const memory = readResourceRevision('memory_search', { query: 'brief', limit: 20 });
  assert.ok(memory);
  writeFileSync(path.join(TMP_HOME, 'state', 'memory.db-wal'), 'remembered');
  assert.notEqual(readResourceRevision('memory_recall_all', { objective: 'brief', limit: null }), memory, 'a memory write moves every memory read revision');
});
