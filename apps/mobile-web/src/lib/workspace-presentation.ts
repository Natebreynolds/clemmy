export type WorkspaceContentMode = 'static_snapshot' | null | undefined;

/** Missing runners are a defect only for a dynamic/draft Workspace. A static
 * snapshot is intentionally complete without refresh machinery. */
export function workspaceNeedsSourceRepair(input: {
  sourceCount: number;
  contentMode: WorkspaceContentMode;
}): boolean {
  return input.sourceCount === 0 && input.contentMode !== 'static_snapshot';
}

/** Real source failures stay visible regardless of presentation mode. The
 * static marker only changes the meaning of an absent source list. */
export function failedWorkspaceSources<T extends { ok: boolean }>(sources: readonly T[]): T[] {
  return sources.filter((source) => !source.ok);
}
