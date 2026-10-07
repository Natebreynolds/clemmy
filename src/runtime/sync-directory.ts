/** Directory metadata flush is separate from file fsync and atomic publication. */
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
