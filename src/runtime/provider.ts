import type { ApprovalResolutionResult, PendingApproval, RunRequest, RunResult, ToolActivity } from '../types.js';

export class AgentRuntimeCancelledError extends Error {
  constructor(message = 'Run cancelled.') {
    super(message);
    this.name = 'AgentRuntimeCancelledError';
  }
}

export interface AgentRuntimeCallbacks {
  /** Final assembled text — fired once when the run completes. Always fires. */
  onText?: (text: string) => Promise<void>;
  /** Per-delta streaming text. Fires only when the runtime supports
   *  streaming AND the caller subscribed. Sum of all deltas equals the
   *  final text. Caller can buffer/throttle/edit-in-place. */
  onChunk?: (delta: string) => Promise<void>;
  /** Per-reasoning-chunk for o-series-style reasoning models. Captured
   *  into run events. Optional. */
  onReasoning?: (text: string) => Promise<void>;
  onToolActivity?: (activity: ToolActivity) => Promise<void>;
  shouldCancel?: () => boolean | Promise<boolean>;
}

export interface AgentRuntime {
  run(request: RunRequest, callbacks?: AgentRuntimeCallbacks): Promise<RunResult>;
  listPendingApprovals(): PendingApproval[];
  resolveApproval(approvalId: string, approved: boolean): Promise<ApprovalResolutionResult>;
}
