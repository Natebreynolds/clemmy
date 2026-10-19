/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/authored-workflow-write-scratch.test.ts
 *
 * A workflow step's write into the system's temporary folders is its scratch:
 * the owner receives its content only through a later write, which is still
 * reviewed against the step's saved instructions. Live 2026-10-18: one step
 * that saved four branch results to /tmp before writing its CSV spent six
 * constraint reviews (~45 s).
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-authored-scratch-'));
const { localWriteTargetsOnlyScratch } = await import('./authored-workflow-write-authority.js');

test('a declared target in the system temporary folders is scratch; anywhere else is not', () => {
  assert.equal(localWriteTargetsOnlyScratch('write_file', { path: '/tmp/hard9-p5.json', content: '{}' }), true);
  assert.equal(localWriteTargetsOnlyScratch('write_file', { path: '/private/tmp/p7.json', content: '{}' }), true);
  assert.equal(localWriteTargetsOnlyScratch('write_file', { path: path.join(process.env.CLEMENTINE_HOME!, 'p8.json'), content: '{}' }), false,
    'Clementine\'s home is never scratch, even when it lives in a temporary folder');
  assert.equal(localWriteTargetsOnlyScratch('write_file', { path: '~/clem-fixtures/out/under20.csv', content: 'a' }), false,
    'the deliverable is still reviewed');
  assert.equal(localWriteTargetsOnlyScratch('write_file', { path: '/tmp/../Users/owner/notes.md', content: 'a' }), false,
    'a path that only starts in a temporary folder is not scratch');
  assert.equal(localWriteTargetsOnlyScratch('write_file', { path: 'tmp/p5.json', content: 'a' }), false, 'a relative path is not scratch');
  assert.equal(localWriteTargetsOnlyScratch('write_file', { path: '/tmpfiles/p5.json', content: 'a' }), false);
  assert.equal(localWriteTargetsOnlyScratch('write_file', { content: 'a' }), false, 'no declared target, no exemption');
});

test('a shell command is never scratch here, whatever folder it names', () => {
  // A command that writes to /tmp can do anything else too; it keeps its review.
  assert.equal(localWriteTargetsOnlyScratch('run_shell_command', { command: 'cat > /tmp/p5.json' }), false);
});
