/**
 * Durable identity for the active chat conversation (2026-08-04).
 *
 * The conversation's session id previously lived only in a ref inside the
 * mounted Chat component — navigating to Tasks/Workspaces and back was
 * indistinguishable from "New chat": the server minted a fresh session, the
 * felt-conversation was gone, and the sidebar accumulated one orphan session
 * per navigation round-trip (the dominant clutter source). This module is the
 * one place that identity survives: the chat surfaces record the UNIFIED
 * session id (the `harness:<raw>` form the /chat/:sessionId route accepts),
 * and the chat index redirects back into it instead of a blank hero.
 */
const KEY = 'clem.chat.last-session';

export function rememberLastChatSession(unifiedId: string | null): void {
  try {
    if (unifiedId) window.localStorage.setItem(KEY, unifiedId);
    else window.localStorage.removeItem(KEY);
  } catch { /* private mode / storage denied — feature degrades to old behavior */ }
}

export function lastChatSession(): string | null {
  try {
    const value = window.localStorage.getItem(KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

/** The unified (`harness:`-prefixed) form of a raw harness session id. Raw ids
 *  may themselves contain colons (`console:…`), so only an existing store
 *  namespace prefix counts as already-unified. */
export function unifiedChatSessionId(rawSessionId: string): string {
  return rawSessionId.startsWith('harness:') || rawSessionId.startsWith('desktop:')
    ? rawSessionId
    : `harness:${rawSessionId}`;
}
