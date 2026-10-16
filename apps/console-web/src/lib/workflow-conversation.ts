import { workflowConversationSessionId } from '@clem/chat-engine';
import { composerDraftKey, readComposerDraft, writeComposerDraft } from './composer-drafts';

export interface WorkflowConversationQuestion {
  workflowSlug: string;
  id: number;
  text: string;
}

/** A context shortcut prepares a question; only the ordinary Send posts it.
 * Existing text, files and artifact selections always stay with their owner. */
export function prepareWorkflowQuestion(
  workflowSlug: string,
  question: WorkflowConversationQuestion,
  append = false,
): 'prepared' | 'draft-kept' | 'wrong-workflow' {
  const sessionId = workflowConversationSessionId(workflowSlug);
  if (!sessionId || question.workflowSlug !== workflowSlug || !Number.isSafeInteger(question.id)
    || question.id < 1 || !question.text.trim()) return 'wrong-workflow';
  const key = composerDraftKey('', undefined, sessionId);
  const current = readComposerDraft(key);
  if (!append && (current.text || current.attachments.length || current.artifact)) return 'draft-kept';
  writeComposerDraft(key, draft => ({ ...draft,
    text: append && draft.text ? `${draft.text}\n\n${question.text}` : question.text,
  }));
  return 'prepared';
}
