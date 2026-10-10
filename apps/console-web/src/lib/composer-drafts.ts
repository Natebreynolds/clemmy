/** Window-local drafts survive route changes without keeping chat streams mounted. */
export interface DraftAttachment {
  localId: string;
  name: string;
  status: 'uploading' | 'ready' | 'error';
  id?: string;
  error?: string;
}
export interface ComposerDraft { text: string; attachments: DraftAttachment[] }
const empty: ComposerDraft = { text: '', attachments: [] };
const drafts = new Map<string, ComposerDraft>();
const aliases = new Map<string, string>();
const listeners = new Set<() => void>();
function resolve(key: string): string { return aliases.get(key) ?? key; }
export function readComposerDraft(key: string): ComposerDraft { return drafts.get(resolve(key)) ?? empty; }
export function writeComposerDraft(key: string, update: (draft: ComposerDraft) => ComposerDraft): void {
  drafts.set(resolve(key), update(readComposerDraft(key)));
  for (const listener of listeners) listener();
}
export function subscribeComposerDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** A new conversation receives an ID after its first send. Late uploads still
 * belong to that same conversation, not the next new-chat composer. */
export function moveComposerDraft(from: string, to: string): void {
  // A creation route is assigned once. A later route transition must never
  // redirect late uploads or delete the draft of an already assigned session.
  if (from === to || aliases.has(from)) return;
  if (!drafts.has(to) && drafts.has(resolve(from))) drafts.set(to, readComposerDraft(from));
  drafts.delete(resolve(from));
  aliases.set(from, to);
  for (const listener of listeners) listener();
}

export interface ComposerDraftOwner { draftKey: string; sessionId?: string | null }
/** Only an unassigned -> assigned transition on the same creation route owns
 * a handoff. New chat first changes the route while the old session is still
 * rendered; that intermediate render must not bind the new draft to the old. */
export function handoffComposerDraft(previous: ComposerDraftOwner, next: ComposerDraftOwner): void {
  if (previous.draftKey === next.draftKey && !previous.sessionId && next.sessionId) {
    moveComposerDraft(next.draftKey, `session:${next.sessionId}`);
  }
}

export function newComposerDraftKey(pathname: string, navigationKey: string, newChat?: number): string {
  return `new:${pathname}:${newChat ?? navigationKey}`;
}
