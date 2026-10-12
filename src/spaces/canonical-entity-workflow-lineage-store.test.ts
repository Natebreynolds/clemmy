import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { constants, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-lineage-store-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const {
  loadCanonicalEntityWorkflowLineageReceipt,
  putCanonicalEntityWorkflowLineageReceipt,
} = await import('./canonical-entity-workflow-lineage-store.js');

const directory = path.join(home, 'state', 'canonical-entities', 'workflow-lineage');
// The store treats the request as opaque canonical JSON.
const request = (label: string) => ({ version: 1, label }) as never;
const temporaries = () => (existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.tmp')) : []);

test.after(() => rmSync(home, { recursive: true, force: true }));

/** Windows flush rules on any OS: fsync through a descriptor opened without
 * write access fails with EPERM (FlushFileBuffers needs write access). */
function withWindowsFlushSemantics<T>(fn: () => T): T {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const realOpen = fs.openSync;
  const realFsync = fs.fsyncSync;
  const readOnly = new Set<number>();
  fs.openSync = ((file: Parameters<typeof realOpen>[0], flags: Parameters<typeof realOpen>[1] = 'r', mode?: Parameters<typeof realOpen>[2]) => {
    const writable = typeof flags === 'number'
      ? (flags & (constants.O_WRONLY | constants.O_RDWR)) !== 0
      : /[wa+]/.test(flags);
    const fd = realOpen(file, flags, mode);
    if (writable) readOnly.delete(fd); else readOnly.add(fd);
    return fd;
  }) as typeof realOpen;
  fs.fsyncSync = ((fd: number) => {
    if (readOnly.has(fd)) throw Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM', syscall: 'fsync' });
    realFsync(fd);
  }) as typeof realFsync;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fs.openSync = realOpen;
    fs.fsyncSync = realFsync;
    Object.defineProperty(process, 'platform', platform);
    syncBuiltinESMExports();
  }
}

test('a lineage receipt installs once, replays identical bytes, and refuses different bytes', () => {
  const first = putCanonicalEntityWorkflowLineageReceipt({ receiptId: 'lineage-once', request: request('a') });
  assert.equal(first.ok && first.inserted, true, JSON.stringify(first));
  const replay = putCanonicalEntityWorkflowLineageReceipt({ receiptId: 'lineage-once', request: request('a') });
  assert.equal(replay.ok && !replay.inserted, true, JSON.stringify(replay));
  const conflict = putCanonicalEntityWorkflowLineageReceipt({ receiptId: 'lineage-once', request: request('b') });
  assert.equal(!conflict.ok && conflict.kind, 'conflict');
  assert.equal(loadCanonicalEntityWorkflowLineageReceipt('lineage-once')?.receiptId, 'lineage-once');
  assert.deepEqual(temporaries(), []);
});

test('Windows flush rules still install the receipt and leave no temp file (3.18.35 blocked every bound read projection)', () => {
  const result = withWindowsFlushSemantics(
    () => putCanonicalEntityWorkflowLineageReceipt({ receiptId: 'lineage-windows', request: request('w') }),
  );
  assert.equal(result.ok && result.inserted, true, JSON.stringify(result));
  assert.equal(loadCanonicalEntityWorkflowLineageReceipt('lineage-windows')?.receiptId, 'lineage-windows');
  assert.deepEqual(temporaries(), []);
});

test('a failed link reports storage_error and removes its own temp file', () => {
  const realLink = fs.linkSync;
  fs.linkSync = (() => {
    throw Object.assign(new Error('EXDEV: simulated link failure'), { code: 'EXDEV', syscall: 'link' });
  }) as typeof realLink;
  syncBuiltinESMExports();
  try {
    const result = putCanonicalEntityWorkflowLineageReceipt({ receiptId: 'lineage-link-fails', request: request('x') });
    assert.equal(!result.ok && result.kind, 'storage_error', JSON.stringify(result));
  } finally {
    fs.linkSync = realLink;
    syncBuiltinESMExports();
  }
  assert.deepEqual(temporaries(), []);
  assert.equal(loadCanonicalEntityWorkflowLineageReceipt('lineage-link-fails'), null);
});
