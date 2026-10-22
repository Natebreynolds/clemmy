import { acceptComposerDraft, moveComposerDraft, readComposerDraft, writeComposerDraft, type ComposerDraft } from './composer-drafts';
import type { MemoryHit } from './memory';

/** Only the explicitly selected identity accompanies the question. Its body,
 * sources and confidence are read through the normal memory tools if needed. */
export function memoryAssistantMessage(text: string, context: Pick<MemoryHit, 'ref'> | null): string {
  const question = text.trim();
  return context
    ? [question, `Selected memory reference: ${JSON.stringify({ type: context.ref.type, id: context.ref.id })}`].filter(Boolean).join('\n\n')
    : question;
}

export interface MemoryAssistantSubmission { wireInput: string; draft: ComposerDraft }

export function captureMemoryAssistantSubmission(
  wireInput: string,
  text: string,
  attachmentIds: readonly string[],
  current: ComposerDraft,
): MemoryAssistantSubmission {
  return { wireInput, draft: {
    text: current.text.trim() === text.trim() ? current.text : text,
    attachments: current.attachments.filter(file => file.id && attachmentIds.includes(file.id)),
    artifact: current.artifact?.preparedAttachmentId && attachmentIds.includes(current.artifact.preparedAttachmentId)
      ? current.artifact : undefined,
  } };
}

/** The shared Composer sees the contextual wire text on retry. Settle its
 * original editable text only after that exact request is acknowledged. */
export function settleMemoryAssistantRetry(key: string, wireInput: string, submission: MemoryAssistantSubmission | null): void {
  if (submission?.wireInput === wireInput) acceptComposerDraft(key, submission.draft);
}

/** Explicit Open chat moves a draft, never a request. The alias also keeps a
 * late upload attached to its original draft after navigation. */
export function handoffMemoryAssistantDraft(
  sourceKey: string,
  conversationId: string,
  pending: boolean,
  context: Pick<MemoryHit, 'ref'> | null,
): 'moved' | 'pending' | 'conflict' {
  if (pending) return 'pending';
  const targetKey = `session:${conversationId}`;
  const source = readComposerDraft(sourceKey);
  const target = readComposerDraft(targetKey);
  const next = context ? { ...source, text: memoryAssistantMessage(source.text, context) } : source;
  const hasDraft = (draft: ComposerDraft) => Boolean(draft.text.trim() || draft.attachments.length || draft.artifact);
  // moveComposerDraft keeps an existing target, so check before allowing it
  // to discard a different source. Neither draft changes on this refusal.
  if (hasDraft(next) && hasDraft(target)) return 'conflict';
  if (context) writeComposerDraft(sourceKey, () => next);
  moveComposerDraft(sourceKey, targetKey);
  return 'moved';
}
