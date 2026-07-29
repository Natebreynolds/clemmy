/**
 * Identity carried by one asynchronous Workspace history comparison.
 *
 * React Query can replace the first history page, or the router can reuse the
 * screen for another Workspace, while a diff request is still in flight.
 * Results are safe to render only while all three identity dimensions match.
 */
export interface WorkspaceDiffScope {
  workspaceId: string;
  pageToken: unknown;
  requestId: number;
}

export function isCurrentWorkspaceDiffScope(
  requested: WorkspaceDiffScope,
  current: WorkspaceDiffScope,
): boolean {
  return requested.workspaceId === current.workspaceId
    && requested.pageToken === current.pageToken
    && requested.requestId === current.requestId;
}
