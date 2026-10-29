import type { SessionFile, SessionFileRef } from './session-files';

/** Task filenames are hints; only the session-file service supplies identity. */
export function taskResultFiles(sessionId: string, files: readonly SessionFile[]): Array<{ file: SessionFile; ref: SessionFileRef }> {
  if (!sessionId.trim()) return [];
  const seen = new Set<string>();
  return files.flatMap(file => {
    if (!file.fileId?.trim() || !file.name?.trim() || typeof file.folder !== 'string' || seen.has(file.fileId)) return [];
    seen.add(file.fileId);
    return [{ file, ref: { sessionId, fileId: file.fileId, name: file.name, folder: file.folder } }];
  });
}
