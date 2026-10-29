import type { SessionFileRef } from './session-files';
import { unifiedChatSessionId } from './last-session';

/** A recorded identity opens the existing conversation viewer, never a report path. */
export function savedFilesDestination(sessionId: string, ref?: SessionFileRef) {
  return { pathname: `/chat/${encodeURIComponent(unifiedChatSessionId(sessionId))}`,
    state: ref ? { openSavedFile: ref } : { showSavedFiles: true } };
}

export function readSavedFileNavigation(value: unknown, sessionId?: string): SessionFileRef | null {
  if (!value || typeof value !== 'object' || !sessionId) return null;
  const ref = value as Partial<SessionFileRef>;
  if (ref.sessionId !== sessionId || ![ref.sessionId, ref.fileId, ref.name].every(part => typeof part === 'string'
    && part.length > 0 && part.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(part))
    || typeof ref.folder !== 'string' || ref.folder.length > 4096 || /[\u0000-\u001f\u007f]/.test(ref.folder)) return null;
  return { sessionId, fileId: ref.fileId, name: ref.name!, folder: ref.folder };
}
