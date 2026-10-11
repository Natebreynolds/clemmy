import type { SessionFileRef } from './session-files';

/** An explicit choice of a saved file version. Never a client-named path. */
export interface ArtifactDiscussion {
  ref: SessionFileRef & { fileId: string };
  revision: string;
  /** Local association used only to clear the exact context after a transport retry. */
  preparedAttachmentId?: string;
}

export function readArtifactDiscussion(value: unknown): ArtifactDiscussion | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ArtifactDiscussion>;
  const ref = candidate.ref;
  if (!ref || typeof ref !== 'object' || typeof candidate.revision !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(candidate.revision)) return null;
  if (![ref.sessionId, ref.fileId, ref.name, ref.folder].every(part => typeof part === 'string'
    && part.length > 0 && part.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(part))) return null;
  return { ref: { sessionId: ref.sessionId, fileId: ref.fileId, name: ref.name, folder: ref.folder }, revision: candidate.revision };
}

export function sameArtifactDiscussion(a: ArtifactDiscussion | null | undefined, b: ArtifactDiscussion | null | undefined): boolean {
  return Boolean(a && b && a.ref.sessionId === b.ref.sessionId && a.ref.fileId === b.ref.fileId && a.revision === b.revision);
}

const usedNavigationSeeds = new Set<string>();
/** A route may remount after its first accepted message. Its selection must
 * not reappear after it was sent or deliberately removed. */
export function claimArtifactDiscussionSeed(navigationKey: string): boolean {
  if (usedNavigationSeeds.has(navigationKey)) return false;
  usedNavigationSeeds.add(navigationKey);
  if (usedNavigationSeeds.size > 200) usedNavigationSeeds.delete(usedNavigationSeeds.values().next().value!);
  return true;
}

export async function prepareArtifactDiscussion(
  selection: ArtifactDiscussion | undefined,
  prepare: (ref: SessionFileRef, revision: string) => Promise<{ id: string; name: string }>,
  stillCurrent: () => boolean,
): Promise<{ id: string; name: string } | null> {
  const check = () => { if (!stillCurrent()) throw new Error('The conversation changed before this message was sent. Your draft stays with its original conversation.'); };
  check();
  const result = selection ? await prepare(selection.ref, selection.revision) : null;
  check();
  return result;
}
