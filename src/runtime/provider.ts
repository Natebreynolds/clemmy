import type { ApprovalResolutionResult, PendingApproval, RunRequest, RunResult, ToolActivity } from '../types.js';

export interface AgentRuntimeCallbacks {
  onText?: (text: string) => Promise<void>;
  onToolActivity?: (activity: ToolActivity) => Promise<void>;
}

export interface AgentRuntime {
  run(request: RunRequest, callbacks?: AgentRuntimeCallbacks): Promise<RunResult>;
  listPendingApprovals(): PendingApproval[];
  resolveApproval(approvalId: string, approved: boolean): Promise<ApprovalResolutionResult>;
}
