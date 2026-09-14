import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { loadHomeLayout, updateHomeLayout, HomeLayoutError } from './home-layout.js';
import { parseHostLocalWriteCommitFacts } from './harness/host-local-write-commit.js';

function fixture() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clem-home-layout-'));
  const file = path.join(rootDir, 'state', 'home-layout.json');
  const options = { rootDir, file, spaceExists: (id: string) => id !== 'missing-space' };
  return { file, options, read: () => loadHomeLayout(file), change: (input: unknown) => updateHomeLayout(input, options) };
}

test('reading a fresh Home creates no state', () => {
  const f = fixture();
  assert.deepEqual(f.read(), { version: 1, revision: 0, updatedAt: null, tiles: [] });
  assert.equal(existsSync(f.file), false);
});

test('pin, targeted move/resize, reopen and removal retain unrelated tiles', () => {
  const f = fixture();
  f.change({ operation: 'pin', space_id: 'sales-board', expected_revision: 0 });
  f.change({ operation: 'pin', space_id: 'team-board', expected_revision: 1 });
  const result = f.change({ operation: 'update', space_id: 'team-board', expected_revision: 2, width: 'wide', zone: 'now', position: 'before', before_space_id: 'sales-board' });
  assert.deepEqual(f.read().tiles, [
    { spaceId: 'team-board', width: 'wide', zone: 'now' },
    { spaceId: 'sales-board', width: 'medium', zone: 'watching' },
  ]);
  const receipt = parseHostLocalWriteCommitFacts(result.receipt)!;
  assert.equal(receipt.handle, 'state/home-layout.json');
  assert.equal(receipt.contentDigest, createHash('sha256').update(readFileSync(f.file)).digest('hex'));
  f.change({ operation: 'remove', space_id: 'team-board', expected_revision: 3 });
  assert.deepEqual(f.read().tiles, [{ spaceId: 'sales-board', width: 'medium', zone: 'watching' }]);
});

test('a stale edit cannot overwrite a manual change; identical retries do not duplicate or undo it', () => {
  const f = fixture();
  const pin = { operation: 'pin', space_id: 'sales-board', expected_revision: 0 };
  f.change(pin);
  assert.equal(f.change(pin).changed, false);
  f.change({ operation: 'update', space_id: 'sales-board', expected_revision: 1, width: 'wide' });
  assert.equal(f.change(pin).changed, false, 'unspecified width preserves the newer choice');
  const before = readFileSync(f.file, 'utf8');
  assert.throws(() => f.change({ ...pin, width: 'small' }), (error: unknown) => error instanceof HomeLayoutError && error.code === 'layout_conflict' && error.current?.revision === 2);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('missing targets, invalid moves and malformed shapes cannot change Home', () => {
  const f = fixture();
  f.change({ operation: 'pin', space_id: 'sales-board', expected_revision: 0 });
  const before = readFileSync(f.file, 'utf8');
  for (const bad of [
    { operation: 'pin', space_id: 'missing-space', expected_revision: 1 },
    { operation: 'update', space_id: 'other-board', expected_revision: 1 },
    { operation: 'update', space_id: 'sales-board', expected_revision: 1, position: 'before', before_space_id: 'other-board' },
    { operation: 'pin', space_id: '../secret', expected_revision: 1 },
    { operation: 'pin', space_id: 'other-board', expected_revision: 1, arbitrary: true },
  ]) assert.throws(() => f.change(bad));
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('corrupt retained state is surfaced without erasing it', () => {
  const f = fixture();
  mkdirSync(path.dirname(f.file)); writeFileSync(f.file, '{broken');
  assert.throws(f.read);
  assert.throws(() => f.change({ operation: 'pin', space_id: 'sales-board', expected_revision: 0 }));
  assert.equal(readFileSync(f.file, 'utf8'), '{broken');
});

test('placements are not clipped to a fixed tile count', () => {
  const f = fixture();
  for (let i = 0; i < 70; i++) f.change({ operation: 'pin', space_id: `board-${i}`, expected_revision: i });
  assert.equal(f.read().tiles.length, 70);
  assert.equal(f.read().tiles.at(-1)?.spaceId, 'board-69');
});

test('two processes editing the same revision cannot silently overwrite each other', async () => {
  const f = fixture();
  const child = (id: string) => new Promise<number | null>((resolve, reject) => {
    const code = `import {updateHomeLayout} from ${JSON.stringify(new URL('./home-layout.ts', import.meta.url).href)};
      try { updateHomeLayout({operation:'pin',space_id:${JSON.stringify(id)},expected_revision:0},
        {file:${JSON.stringify(f.file)},rootDir:${JSON.stringify(f.options.rootDir)},spaceExists:()=>true}); }
      catch(error) { process.exit(error.code==='layout_conflict'?2:3); }`;
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: 'ignore' });
    process.on('error', reject);process.on('exit', resolve);
  });
  assert.deepEqual((await Promise.all([child('alpha-board'), child('beta-board')])).sort(), [0, 2]);
  assert.equal(f.read().tiles.length, 1);
  assert.equal(f.read().revision, 1);
});
