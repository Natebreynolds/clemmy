import { workflowConversationSessionId } from '@clem/chat-engine';
import { composerDraftKey, readComposerDraft, writeComposerDraft } from './composer-drafts';
import type { WorkflowCertification } from './automate';

/** Exact saved setup context becomes editable text, never an execution intent. */
export function workflowSetupPrompt(workflowSlug: string, certification?: WorkflowCertification | null): string {
  const lines = [`Help me finish setting up the automation with workflow ID "${workflowSlug}".`];
  if (certification?.summary) lines.push(`Current setup: ${certification.summary}`);
  const add = (label: string, values: string[] | undefined) => {
    if (values?.length) lines.push(`${label}:\n${values.map(value => `- ${value}`).join('\n')}`);
  };
  add('Information needed for a safe test', certification?.missingTestInputs);
  add('Information needed before a run', certification?.missingRunInputs);
  add('Apps or files still needed', certification?.resourceGaps);
  add('Setup questions', certification?.readinessGaps?.map(gap => `${gap.question}${gap.why ? ` (${gap.why})` : ''}`));
  add('Problems to resolve', certification?.blockingReasons);
  lines.push('Ask me one clear question at a time and explain account or input choices in plain language. Do not enable or run this automation until the required information is confirmed and its existing checks allow it. Do not approve requests or choose an account for me.');
  return lines.join('\n\n');
}

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
