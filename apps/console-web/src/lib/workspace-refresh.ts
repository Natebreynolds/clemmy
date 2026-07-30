export interface WorkspaceRefreshResult {
  ok: boolean;
  sourceId: string;
  error?: string;
  pendingApprovalId?: string;
}

export class WorkspaceRefreshError extends Error {
  readonly results: WorkspaceRefreshResult[];
  readonly pendingApprovalIds: string[];

  constructor(
    message: string,
    results: WorkspaceRefreshResult[],
    pendingApprovalIds: string[],
  ) {
    super(message);
    this.name = 'WorkspaceRefreshError';
    this.results = results;
    this.pendingApprovalIds = pendingApprovalIds;
  }
}

export function refreshFailureForResults(
  results: WorkspaceRefreshResult[],
): WorkspaceRefreshError | null {
  const failures = results.filter((result) => !result.ok);
  if (failures.length === 0) return null;

  const pendingApprovalIds = [...new Set(
    failures
      .map((result) => result.pendingApprovalId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )];
  if (pendingApprovalIds.length > 0) {
    const sources = failures
      .filter((result) => result.pendingApprovalId)
      .map((result) => result.sourceId)
      .join(', ');
    return new WorkspaceRefreshError(
      `Approval needed before ${sources || 'this data source'} can refresh (${pendingApprovalIds.join(', ')}). Open Ask Clem in this Workspace to approve it; the refresh will then resume automatically.`,
      results,
      pendingApprovalIds,
    );
  }

  return new WorkspaceRefreshError(
    failures
      .map((result) => `${result.sourceId}: ${result.error ?? 'refresh failed'}`)
      .join('; '),
    results,
    [],
  );
}
