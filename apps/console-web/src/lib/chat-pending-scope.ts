/** Auxiliary composers must not share the primary new-chat retry slot. */
export function chatPendingStorageKey(scope?: string, sessionId?: string | null): string {
  return scope ? `clem.pending.console:aux:${scope}` : `clem.pending.console:${sessionId ?? 'new'}`;
}
