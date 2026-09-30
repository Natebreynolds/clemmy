export interface WorkspaceSourceControlView {
  sourceId: string;
  runner: string;
  revision: string;
  permission: 'active' | 'stopped' | 'needs_review';
  detail: string;
  run: { occurrenceId: string; phase: 'not_started' | 'running' | 'held'; crossings: number; outcome: string | null } | null;
  canStop: boolean;
  canReview: boolean;
  canResolve: boolean;
  approvalId?: string;
}
export interface WorkspaceSourceControlRequest {
  controlId: string;
  expectedRevision: string;
  action: 'stop' | 'review' | 'resolve';
  note?: string;
  reviewedEffects?: boolean;
}
export interface WorkspaceSourceControlResponse {
  view: WorkspaceSourceControlView;
  pendingApprovalId?: string;
}
