import {
  composerDraftIsUnassigned, newComposerDraftKey, readComposerDraft, writeComposerDraft,
} from './composer-drafts';

export type ConnectionSetupKind = 'apps' | 'mcp' | 'cli';
interface ConnectionSetupState {
  newChat: number;
  connectionSetupDraft: { kind: ConnectionSetupKind; detail?: string };
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isKind = (value: unknown): value is ConnectionSetupKind => value === 'apps' || value === 'mcp' || value === 'cli';
const validDetail = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
let lastStamp = 0;

/** Navigation only prepares an editable request. Normal Send still owns submission. */
export function connectionSetupChatNavigation(kind: ConnectionSetupKind, detail?: string, stamp?: number): {
  pathname: '/chat'; state: ConnectionSetupState;
} | null {
  const newChat = stamp ?? Math.max(Date.now(), lastStamp + 1);
  if (!isKind(kind) || (detail !== undefined && !validDetail(detail))
    || !Number.isSafeInteger(newChat) || newChat <= 0) return null;
  lastStamp = Math.max(lastStamp, newChat);
  const trimmed = detail?.trim();
  return { pathname: '/chat', state: { newChat,
    connectionSetupDraft: { kind, ...(trimmed ? { detail: trimmed } : {}) } } };
}

export function readConnectionSetupDraft(value: unknown): { stamp: number; text: string } | null {
  if (!record(value) || !Number.isSafeInteger(value.newChat) || Number(value.newChat) <= 0
    || !record(value.connectionSetupDraft) || !isKind(value.connectionSetupDraft.kind)
    || (value.connectionSetupDraft.detail !== undefined && !validDetail(value.connectionSetupDraft.detail))) return null;
  const { kind, detail } = value.connectionSetupDraft;
  const subject = detail?.trim() ? JSON.stringify(detail.trim())
    : kind === 'mcp' ? 'an MCP tool server' : kind === 'cli' ? 'a command-line tool' : 'an app';
  return { stamp: Number(value.newChat), text: `Help me connect ${subject}${detail?.trim() && kind === 'cli' ? ' as a command-line tool' : detail?.trim() && kind === 'mcp' ? ' as an MCP tool server' : ''}. Check existing connections and software first, guide any necessary browser or private sign-in, and verify what is available. Ask me which connection I mean if needed. Do not perform any business actions.` };
}

const claimedNavigations = new Set<string>();
export function seedConnectionSetupComposerDraft(input: {
  pathname: string; navigationKey: string; state: unknown; routeDraftKey: string; draftKey: string;
  executionSessionId?: string | null; conversationSessionId?: string | null; busy: boolean;
}): boolean {
  const request = readConnectionSetupDraft(input.state);
  if (!request || input.pathname !== '/chat' || input.busy || input.executionSessionId || input.conversationSessionId
    || input.routeDraftKey !== newComposerDraftKey(input.pathname, input.navigationKey, request.stamp)
    || input.draftKey !== input.routeDraftKey || !composerDraftIsUnassigned(input.draftKey)) return false;
  const claim = input.routeDraftKey;
  if (claimedNavigations.has(claim)) return false;
  claimedNavigations.add(claim);
  const current = readComposerDraft(input.draftKey);
  if (current.text || current.attachments.length || current.artifact) return false;
  let seeded = false;
  writeComposerDraft(input.draftKey, latest => {
    if (!composerDraftIsUnassigned(input.draftKey) || latest.text || latest.attachments.length || latest.artifact) return latest;
    seeded = true;
    return { ...latest, text: request.text };
  });
  return seeded;
}
