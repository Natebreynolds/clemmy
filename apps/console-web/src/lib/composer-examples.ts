import { composerDraftIsUnassigned, readComposerDraft, writeComposerDraft } from './composer-drafts';

export const COMPOSER_EXAMPLES = [
  { id: 'weekly-brief', label: 'Prepare a weekly brief', text: 'Help me prepare a useful weekly business brief. Ask what I want to track and which sources to use, then propose how to keep it current.' },
  { id: 'follow-ups', label: 'Organize follow-ups', text: 'Help me organize the follow-ups I owe people. Ask which work and sources to include, then prepare a clear list and drafts for me to review.' },
  { id: 'plan', label: 'Make a plan', text: 'Help me make a practical plan for this goal: ' },
  { id: 'file', label: 'Understand a file', text: 'Summarize the file I attach. Explain the key points and any next steps.' },
] as const;

/** Examples fill an empty creation draft. Sending remains the user's action. */
export function seedComposerExample(input: {
  id: string; draftKey: string; routeDraftKey: string; activeDraftKey: string;
  allowed: boolean; executionSessionId?: string | null; conversationSessionId?: string | null;
}): boolean {
  const example = COMPOSER_EXAMPLES.find(item => item.id === input.id);
  if (!example || !input.allowed || input.activeDraftKey !== input.draftKey
    || input.draftKey !== input.routeDraftKey || input.executionSessionId || input.conversationSessionId
    || !composerDraftIsUnassigned(input.draftKey)) return false;
  const current = readComposerDraft(input.draftKey);
  if (current.text || current.attachments.length || current.artifact) return false;
  let seeded = false;
  writeComposerDraft(input.draftKey, latest => {
    if (!composerDraftIsUnassigned(input.draftKey) || latest.text || latest.attachments.length || latest.artifact) return latest;
    seeded = true;
    return { ...latest, text: example.text };
  });
  return seeded;
}
