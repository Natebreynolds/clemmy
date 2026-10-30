import { composerDraftIsUnassigned, newComposerDraftKey, readComposerDraft, writeComposerDraft } from './composer-drafts';

let lastStamp = 0;
/** Prepare an isolated local draft. Navigation does not submit a request or
 * create a conversation, and never replaces an existing or assigned draft. */
export function editableChatDraft(text: string, now = Date.now()): { pathname: '/chat'; state: { newChat: number } } | null {
  if (!text.trim() || !Number.isSafeInteger(now) || now <= 0) return null;
  let stamp = Math.max(now, lastStamp + 1);
  while (Number.isSafeInteger(stamp)) {
    const key = newComposerDraftKey('/chat', '', stamp);
    const existing = readComposerDraft(key);
    if (composerDraftIsUnassigned(key) && !existing.text && !existing.attachments.length && !existing.artifact) {
      writeComposerDraft(key, current => ({ ...current, text }));
      lastStamp = stamp;
      return { pathname: '/chat', state: { newChat: stamp } };
    }
    stamp++;
  }
  return null;
}
