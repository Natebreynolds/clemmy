import { composerDraftIsUnassigned, newComposerDraftKey, readComposerDraft, writeComposerDraft } from './composer-drafts';

interface ProjectToolsDraftState {
  newChat: number;
  project: { id: string; name: string };
  projectToolsDraft: { folderName: string };
}

const text = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
let lastStamp = 0;

/** Navigation opens a fresh project chat. No prompt query or send instruction. */
export function projectToolsChatNavigation(projectId: string, projectName: string, folderName: string, stamp?: number): {
  pathname: '/chat'; state: ProjectToolsDraftState;
} | null {
  const newChat = stamp ?? Math.max(Date.now(), lastStamp + 1);
  if (!text(projectId, 200) || !text(projectName, 500) || !text(folderName, 500)
    || !Number.isSafeInteger(newChat) || newChat <= 0) return null;
  lastStamp = Math.max(lastStamp, newChat);
  return { pathname: '/chat', state: { newChat, project: { id: projectId, name: projectName }, projectToolsDraft: { folderName } } };
}

export function readProjectToolsDraft(value: unknown): { stamp: number; text: string } | null {
  if (!record(value) || !Number.isSafeInteger(value.newChat) || Number(value.newChat) <= 0
    || !record(value.project) || !text(value.project.id, 200) || !text(value.project.name, 500)
    || !record(value.projectToolsDraft) || !text(value.projectToolsDraft.folderName, 500)) return null;
  return { stamp: Number(value.newChat), text: `Set up the tools declared by the ${JSON.stringify(value.projectToolsDraft.folderName)} folder for this project. Check existing connections and software, guide any necessary sign-in, and verify the tools. Do not perform any business actions.` };
}

// Like the drafts themselves, claims live only in this window. A removed or
// accepted seed never reappears when the same navigation remounts.
const claimedNavigations = new Set<string>();

/** Seed only an exactly owned, empty, unassigned new-chat draft. The ordinary
 * composer remains responsible for the user's eventual Send and acceptance. */
export function seedProjectToolsComposerDraft(input: {
  pathname: string; navigationKey: string; state: unknown;
  routeDraftKey: string; draftKey: string;
  executionSessionId?: string | null; conversationSessionId?: string | null; busy: boolean;
}): boolean {
  const request = readProjectToolsDraft(input.state);
  if (!request || input.pathname !== '/chat' || input.busy || input.executionSessionId || input.conversationSessionId
    || input.routeDraftKey !== newComposerDraftKey(input.pathname, input.navigationKey, request.stamp)
    || input.draftKey !== input.routeDraftKey || !composerDraftIsUnassigned(input.draftKey)) return false;
  const claim = `${input.navigationKey}:${request.stamp}`;
  if (claimedNavigations.has(claim)) return false;
  claimedNavigations.add(claim);
  let seeded = false;
  const current = readComposerDraft(input.draftKey);
  if (current.text || current.attachments.length || current.artifact) return false;
  writeComposerDraft(input.draftKey, latest => {
    if (!composerDraftIsUnassigned(input.draftKey) || latest.text || latest.attachments.length || latest.artifact) return latest;
    seeded = true;
    return { ...latest, text: request.text };
  });
  return seeded;
}
