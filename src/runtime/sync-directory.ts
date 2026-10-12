/** Directory metadata flush is separate from file fsync and atomic publication.
 * The same module promotes an existing file's bytes (written and linked by
 * another writer) to durable storage. */
import { closeSync, fsyncSync, openSync } from 'node:fs';

interface DirectorySyncIo {
  open(directory: string, flags: string | number): number;
  sync(fd: number): void;
  close(fd: number): void;
}

const nativeIo: DirectorySyncIo = {
  open: (directory, flags) => openSync(directory, flags),
  sync: fsyncSync,
  close: closeSync,
};

/** Node's Windows filesystem API does not provide directory fsync. Do not
 * attempt a directory open there: it can return EPERM after a successful
 * rename, falsely reporting that the already-published write failed.
 *
 * Windows callers still fsync regular-file bytes, publish by rename, retain
 * their ownership/journals and verify the result. Directory-entry persistence
 * across power loss is not guaranteed by this helper on Windows. POSIX opens
 * keep their caller-provided flags and every open/fsync/close error propagates.
 */
export function syncDirectoryMetadata(directory: string, options: {
  flags?: string | number;
  /** Narrow test seams; production uses the current OS and Node filesystem. */
  platform?: NodeJS.Platform;
  io?: DirectorySyncIo;
} = {}): 'synced' | 'unsupported_on_windows' {
  if ((options.platform ?? process.platform) === 'win32') return 'unsupported_on_windows';
  const io = options.io ?? nativeIo;
  const fd = io.open(directory, options.flags ?? 'r');
  try { io.sync(fd); } finally { io.close(fd); }
  return 'synced';
}

/** Windows answers these when a file cannot be opened for writing: a
 * read-only attribute, an access rule, or another process holding it. */
const WINDOWS_UNWRITABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Flush an existing file's bytes, whoever wrote them.
 *
 * POSIX flushes through a read-only handle. Windows refuses to flush a handle
 * without write access (EPERM, every time), so there the file is opened for
 * writing without truncation and flushed; Windows flushes the file's cached
 * data, not one handle's. A file Windows will not open for writing was
 * flushed by its writer before it was published, so that is reported, not
 * thrown. POSIX errors propagate unchanged.
 */
export function syncExistingFileBytes(file: string, options: {
  /** Narrow test seams; production uses the current OS and Node filesystem. */
  platform?: NodeJS.Platform;
  io?: DirectorySyncIo;
} = {}): 'synced' | 'writer_flushed_on_windows' {
  const io = options.io ?? nativeIo;
  const windows = (options.platform ?? process.platform) === 'win32';
  let fd: number;
  try {
    fd = io.open(file, windows ? 'r+' : 'r');
  } catch (error) {
    if (windows && WINDOWS_UNWRITABLE.has((error as NodeJS.ErrnoException)?.code ?? '')) return 'writer_flushed_on_windows';
    throw error;
  }
  try {
    io.sync(fd);
  } catch (error) {
    if (!windows || !WINDOWS_UNWRITABLE.has((error as NodeJS.ErrnoException)?.code ?? '')) throw error;
    return 'writer_flushed_on_windows';
  } finally {
    io.close(fd);
  }
  return 'synced';
}
