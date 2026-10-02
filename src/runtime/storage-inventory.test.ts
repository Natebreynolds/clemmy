import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'clem-storage-config-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { createStorageInventoryReader } = await import('./storage-inventory.js');
test.after(() => rm(fixtureHome, { recursive: true, force: true }));

test('inventory classifies file sizes without reading content, leaking paths or following symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clem-storage-'));
  try {
    for (const [file, bytes] of Object.entries({ 'state/harness.db': 100, 'state/harness.db-wal': 10,
      'state/authority-payloads/v1/a.sealed.json': 200, 'state/memory.db': 30, 'memory/tool-contracts/a.json': 40,
      'working-memory/a.md': 20, 'backups/a.db': 50, 'state/pre-v69-20260829/a.db': 60,
      'state/mcp-npx-cache/a/file': 70, 'runtime/a': 80, 'attachments/private-name.png': 90 })) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), Buffer.alloc(bytes));
    }
    await symlink(os.tmpdir(), path.join(root, 'outside'));
    await link(path.join(root, 'attachments/private-name.png'), path.join(root, 'attachments/duplicate'));
    const read = createStorageInventoryReader({ baseDir: root });
    const first = read();
    assert.equal(read(), first, 'concurrent clients share one scan');
    const result = await first;
    assert.equal(result.complete, true);
    assert.equal(result.totalBytes, 750);
    assert.equal(result.skippedLinks, 1);
    assert.deepEqual(result.categories.map(row => [row.id, row.bytes]), [
      ['conversations', 110], ['execution', 200], ['learning', 90], ['backups', 110], ['software', 150], ['files', 90],
    ]);
    assert.equal(JSON.stringify(result).includes('private-name'), false);
    assert.equal(JSON.stringify(result).includes(root), false);
    await writeFile(path.join(root, 'new-file'), Buffer.alloc(100));
    assert.equal(await read(), result, 'window focus cannot force another traversal inside the cache horizon');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing home and budget limits report partial data, not an empty successful inventory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clem-storage-budget-'));
  try {
    const missing = await createStorageInventoryReader({ baseDir: path.join(root, 'missing') })();
    assert.equal(missing.complete, false);
    assert.equal(missing.stopReason, 'unavailable');
    await writeFile(path.join(root, 'file'), 'content');
    const limited = await createStorageInventoryReader({ baseDir: root, maxEntries: 1 })();
    assert.equal(limited.complete, false);
    assert.equal(limited.stopReason, 'entry_limit');
    let now = 0;
    const timed = await createStorageInventoryReader({ baseDir: root, maxDurationMs: 1, clock: () => now++ })();
    assert.equal(timed.complete, false);
    assert.equal(timed.stopReason, 'time_limit');
  } finally { await rm(root, { recursive: true, force: true }); }
});
