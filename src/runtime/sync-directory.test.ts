import assert from 'node:assert/strict';
import { chmodSync, constants, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncDirectoryMetadata, syncExistingFileBytes } from './sync-directory.js';

function recordingIo(failure?: 'open' | 'sync' | 'close') {
  const calls: unknown[][] = [];
  const error = Object.assign(new Error(`${failure} failed`), { code: failure === 'sync' ? 'EIO' : 'EPERM' });
  const io = {
    open(directory: string, flags: string | number) {
      calls.push(['open', directory, flags]);
      if (failure === 'open') throw error;
      return 27;
    },
    sync(fd: number) { calls.push(['sync', fd]); if (failure === 'sync') throw error; },
    close(fd: number) { calls.push(['close', fd]); if (failure === 'close') throw error; },
  };
  return { calls, error, io };
}

test('Windows explicitly reports unsupported metadata sync without opening a directory', () => {
  const f = recordingIo('open');
  assert.equal(syncDirectoryMetadata('C:\\Clem\\state', { platform: 'win32', io: f.io }), 'unsupported_on_windows');
  assert.deepEqual(f.calls, [], 'post-rename EPERM is avoided without suppressing filesystem errors');
});

test('POSIX retains exact no-follow directory flags and closes after successful fsync', () => {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  for (const platform of ['darwin', 'linux'] as const) {
    const f = recordingIo();
    assert.equal(syncDirectoryMetadata('/clem/state', { platform, flags, io: f.io }), 'synced');
    assert.deepEqual(f.calls, [['open', '/clem/state', flags], ['sync', 27], ['close', 27]]);
  }
});

test('existing read-mode directory callers preserve their exact open semantics', () => {
  const f = recordingIo();
  assert.equal(syncDirectoryMetadata('/clem/files', { platform: 'linux', io: f.io }), 'synced');
  assert.deepEqual(f.calls, [['open', '/clem/files', 'r'], ['sync', 27], ['close', 27]]);
});

test('POSIX open errors propagate without falsely syncing or closing an absent descriptor', () => {
  const f = recordingIo('open');
  assert.throws(() => syncDirectoryMetadata('/denied', { platform: 'darwin', io: f.io }), error => error === f.error);
  assert.deepEqual(f.calls, [['open', '/denied', 'r']]);
});

test('POSIX fsync errors propagate and the opened descriptor still closes exactly once', () => {
  const f = recordingIo('sync');
  assert.throws(() => syncDirectoryMetadata('/unreliable', { platform: 'linux', io: f.io }), error => error === f.error);
  assert.deepEqual(f.calls, [['open', '/unreliable', 'r'], ['sync', 27], ['close', 27]]);
});

test('POSIX close errors propagate instead of returning a false synced receipt', () => {
  const f = recordingIo('close');
  assert.throws(() => syncDirectoryMetadata('/clem/state', { platform: 'linux', io: f.io }), error => error === f.error);
  assert.deepEqual(f.calls, [['open', '/clem/state', 'r'], ['sync', 27], ['close', 27]]);
});

test('real POSIX directory flush works and supplied no-follow flags still reject a symlink', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-directory-sync-'));
  try {
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    assert.equal(syncDirectoryMetadata(root, { flags }), 'synced');
    symlinkSync(root, path.join(root, 'link'), 'dir');
    assert.throws(() => syncDirectoryMetadata(path.join(root, 'link'), { flags }), error => ['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function scriptedIo(steps: { open?: string; sync?: string } = {}) {
  const calls: unknown[][] = [];
  const fail = (code: string) => Object.assign(new Error(`${code} failed`), { code });
  return {
    calls,
    io: {
      open(file: string, flags: string | number) { calls.push(['open', file, flags]); if (steps.open) throw fail(steps.open); return 41; },
      sync(fd: number) { calls.push(['sync', fd]); if (steps.sync) throw fail(steps.sync); },
      close(fd: number) { calls.push(['close', fd]); },
    },
  };
}

test('an existing file is flushed through a writable handle on Windows and a read-only one on POSIX', () => {
  const win = scriptedIo();
  assert.equal(syncExistingFileBytes('C:\\Clem\\run.json', { platform: 'win32', io: win.io }), 'synced');
  assert.deepEqual(win.calls, [['open', 'C:\\Clem\\run.json', 'r+'], ['sync', 41], ['close', 41]]);
  const posix = scriptedIo();
  assert.equal(syncExistingFileBytes('/clem/run.json', { platform: 'darwin', io: posix.io }), 'synced');
  assert.deepEqual(posix.calls, [['open', '/clem/run.json', 'r'], ['sync', 41], ['close', 41]]);
});

test('a file Windows will not open or flush for writing was flushed by its writer; POSIX errors still surface', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    assert.equal(syncExistingFileBytes('C:\\Clem\\marker.json', { platform: 'win32', io: scriptedIo({ open: code }).io }), 'writer_flushed_on_windows');
    const flush = scriptedIo({ sync: code });
    assert.equal(syncExistingFileBytes('C:\\Clem\\marker.json', { platform: 'win32', io: flush.io }), 'writer_flushed_on_windows');
    assert.deepEqual(flush.calls.at(-1), ['close', 41], 'the handle is closed');
  }
  assert.throws(() => syncExistingFileBytes('C:\\Clem\\gone.json', { platform: 'win32', io: scriptedIo({ open: 'ENOENT' }).io }), /ENOENT/);
  assert.throws(() => syncExistingFileBytes('C:\\Clem\\disk.json', { platform: 'win32', io: scriptedIo({ sync: 'EIO' }).io }), /EIO/);
  assert.throws(() => syncExistingFileBytes('/clem/run.json', { platform: 'linux', io: scriptedIo({ sync: 'EPERM' }).io }), /EPERM/);
});

test('a real existing file is flushed on this platform, including one marked read-only', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-sync-file-'));
  try {
    const file = path.join(dir, 'receipt.json');
    writeFileSync(file, '{"runId":"r1"}', { mode: 0o600 });
    assert.equal(syncExistingFileBytes(file), 'synced');
    chmodSync(file, 0o444);
    const result = syncExistingFileBytes(file);
    assert.equal(result, process.platform === 'win32' ? 'writer_flushed_on_windows' : 'synced');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

