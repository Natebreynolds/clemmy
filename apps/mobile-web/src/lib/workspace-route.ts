const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

/** Only an exact Spaces route may select a detail. Invalid/unrelated query
 * values degrade to the list instead of becoming an API/path input. */
export function workspaceFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get('tab') !== 'spaces') return null;
  const slug = params.get('workspace');
  return slug && WORKSPACE_SLUG.test(slug) ? slug : null;
}

export function mobileWorkspacePath(slug: string): string {
  if (!WORKSPACE_SLUG.test(slug)) throw new Error('invalid Workspace slug');
  return `/m/?tab=spaces&workspace=${encodeURIComponent(slug)}`;
}

function markedWorkspace(state: unknown): string | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const value = (state as { clemWorkspace?: unknown }).clemWorkspace;
  return typeof value === 'string' && WORKSPACE_SLUG.test(value) ? value : null;
}

export function workspaceColdOpenNeedsParent(search: string, historyState: unknown): boolean {
  const selected = workspaceFromSearch(search);
  return Boolean(selected && markedWorkspace(historyState) !== selected);
}

export type WorkspaceNavigationIntent =
  | { kind: 'none' }
  | { kind: 'push'; path: string; state: { clemWorkspace: string } }
  | { kind: 'back' }
  | { kind: 'replace_list' };

export function workspaceNavigationIntent(input: {
  search: string;
  historyState: unknown;
  next: string | null;
}): WorkspaceNavigationIntent {
  const current = workspaceFromSearch(input.search);
  if (input.next) {
    if (!WORKSPACE_SLUG.test(input.next)) throw new Error('invalid Workspace slug');
    return current === input.next
      ? { kind: 'none' }
      : {
        kind: 'push',
        path: mobileWorkspacePath(input.next),
        state: { clemWorkspace: input.next },
      };
  }
  return current && markedWorkspace(input.historyState)
    ? { kind: 'back' }
    : { kind: 'replace_list' };
}
