export interface Models {
  fast: string;
  primary: string;
  deep: string;
}

export type AuthMode = 'api_key' | 'codex_oauth';

export interface RunRequest {
  instructions?: string;
  model?: string;
  prompt: string;
  sessionId?: string;
  userId?: string;
  channel?: string;
  /**
   * Hard wall-clock budget for the entire run, in milliseconds. When
   * exceeded, the runtime aborts in-flight requests and throws a
   * RuntimeTimeoutError (a CodexRuntimeError with status undefined and
   * a recognizable message prefix). Set per-caller — cron uses the
   * largest budgets, controller/synthesis the smallest. Omit to allow
   * unbounded runs (chat default — the user is watching).
   */
  maxWallClockMs?: number;
}

export interface ToolActivity {
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * Why a run ended. Lets UIs render appropriate affordances:
 *  - 'success' — normal end (model returned text, no more tool calls). No extra action.
 *  - 'pending-approval' — paused on an approval gate. UI shows approve/reject.
 *  - 'max-turns-with-grace' — hit the tool-turn cap; the model produced a
 *    summary of what it accomplished + what's pending. UI shows a
 *    [Continue] affordance that resumes with a fresh budget.
 *  - 'cancelled' — caller invoked AbortSignal mid-run.
 *  - 'error' — model backend returned no usable text and no tool calls.
 */
export type RunStoppedReason =
  | 'success'
  | 'pending-approval'
  | 'max-turns-with-grace'
  | 'cancelled'
  | 'error';

export interface RunResult {
  text: string;
  sessionId?: string;
  pendingApprovalId?: string;
  /**
   * Why this run stopped. Defaults to 'success' for backward-compat
   * with callers that don't yet inspect it.
   */
  stoppedReason?: RunStoppedReason;
  /**
   * Number of tool-call turns the loop went through before stopping.
   * Useful for the UI to show "Clementine ran 75 tool cycles" + cost.
   */
  turnsUsed?: number;
  raw?: unknown;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  userId?: string;
  channel?: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
}

export interface SessionAutoBrief {
  summary: string;
  recentUserRequests: string[];
  recentAssistantActions: string[];
  openQuestions: string[];
  activePlan?: string;
  nextStep?: string;
}

export interface SessionManualHandoff {
  pausedAt: string;
  completed: string[];
  remaining: string[];
  decisions: string[];
  blockers: string[];
  context: string;
}

export interface SessionBriefRecord {
  sessionId: string;
  userId?: string;
  channel?: string;
  createdAt: string;
  updatedAt: string;
  auto: SessionAutoBrief;
  manual?: SessionManualHandoff;
}

export interface MemoryContext {
  soul?: string;
  memory?: string;
  identity?: string;
  workingMemory?: string;
  sessionBrief?: string;
}

export interface MemorySearchHit {
  filePath: string;
  title: string;
  snippet: string;
  score: number;
}

export interface AssembledPromptContext {
  memoryContext: MemoryContext;
  retrievalText: string;
}

export interface AssistantRequest {
  message: string;
  sessionId: string;
  userId?: string;
  channel?: string;
  model?: string;
  runId?: string;
  onToolActivity?: (activity: ToolActivity) => Promise<void> | void;
  /** Fired per output-text delta when the runtime supports streaming.
   *  The runtime fires this in addition to (not instead of) the final
   *  text in the response. Callers that don't pass it get the same
   *  non-streaming behavior as before. */
  onChunk?: (delta: string) => Promise<void> | void;
  /** Fired per reasoning chunk (o-series models). Captured for
   *  observability in the run timeline; not intended for end-user
   *  display by default. */
  onReasoning?: (text: string) => Promise<void> | void;
  shouldCancel?: () => boolean | Promise<boolean>;
  /** Wall-clock budget passed through to the runtime. See RunRequest. */
  maxWallClockMs?: number;
}

export interface AssistantResponse {
  text: string;
  sessionId: string;
  pendingApprovalId?: string;
  /** Surfaced from the underlying runtime so channels can render
   *  appropriate affordances (e.g. a "Continue" button on
   *  `max-turns-with-grace`). Defaults to `'success'` when absent. */
  stoppedReason?: RunStoppedReason;
  /** Number of model→tool→model turns the run actually used. */
  turnsUsed?: number;
}

export interface RuntimeContextValue {
  sessionId: string;
  userId?: string;
  channel?: string;
}

export interface PendingApproval {
  id: string;
  sessionId: string;
  agentName: string;
  toolName: string;
  userId?: string;
  channel?: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected';
  state: string;
}

export interface ApprovalResolutionResult {
  approvalId: string;
  status: 'approved' | 'rejected';
  text: string;
  sessionId: string;
  nextApprovalId?: string;
}

export interface PlanStep {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface PlanRecord {
  id: string;
  title: string;
  sessionId?: string;
  source?: 'manual' | 'deep_task' | 'execution';
  createdAt: string;
  updatedAt: string;
  steps: PlanStep[];
}

export interface ExecutionRecord {
  id: string;
  sessionId: string;
  userId?: string;
  channel?: string;
  title: string;
  objective: string;
  reason: string;
  status: 'active' | 'paused' | 'blocked' | 'completed';
  /**
   * When status === 'paused', tracks WHO paused it:
   *  - 'user': the user (or the agent on the user's explicit request)
   *    paused this specific execution. `/clear-focus` leaves these alone.
   *  - 'focus': the execution was paused as a side-effect of
   *    `execution_focus` selecting a different task as the active focus.
   *    `/clear-focus` flips these back to 'active'.
   * Absent on records from before v0.2.10.
   */
  pausedBy?: 'user' | 'focus';
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  startedFromMessage: string;
  planId?: string;
  nextStep?: string;
  successCriteria?: string;
  lastAssistantSummary?: string;
  nextReviewAt?: string;
  lastControllerRunAt?: string;
  blocker?: string;
  autoAdvance?: boolean;
  taskBindings?: Array<{
    taskId: string;
    planStepId?: string;
    description?: string;
    status: 'pending' | 'completed';
    createdAt: string;
    completedAt?: string;
  }>;
  workflowBindings?: Array<{
    runId: string;
    workflow: string;
    status: 'queued' | 'running' | 'completed' | 'error';
    createdAt: string;
    updatedAt: string;
  }>;
  delegationBindings?: Array<{
    delegationId: string;
    toAgent: string;
    task: string;
    expectedOutput: string;
    planStepId?: string;
    status: 'pending' | 'in_progress' | 'completed';
    createdAt: string;
    updatedAt: string;
    result?: string;
  }>;
  activity?: Array<{
    id: string;
    key: string;
    type:
      | 'task_created'
      | 'task_completed'
      | 'workflow_queued'
      | 'workflow_completed'
      | 'workflow_failed'
      | 'delegation_created'
      | 'delegation_completed'
      | 'synthesis'
      | 'blocked'
      | 'completed'
      | 'status';
    message: string;
    createdAt: string;
    metadata?: Record<string, unknown>;
  }>;
  lastSynthesisAt?: string;
  /**
   * Wall-clock timestamp the controller wrote at the START of its most
   * recent advance cycle. Distinct from `lastActivityAt` (which only
   * advances on state-changing events) — heartbeat advances on EVERY
   * cycle so the reaper can tell "controller is alive and working" from
   * "controller crashed mid-cycle." Hermes-style.
   */
  lastHeartbeatAt?: string;
  /**
   * How many controller advance cycles in a row have errored / produced
   * unparsable output. Resets to 0 on a successful cycle. When it hits
   * the auto-fail threshold (5) the execution is moved to `failed`
   * with a `controller failed N times in a row` blocker so the user
   * gets one notification instead of N silent retries.
   */
  consecutiveAdvanceFailures?: number;
  confidence: number;
  reasons: string[];
}

export interface ManagedMcpServer {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  description: string;
  enabled: boolean;
  source: 'auto-detected' | 'user';
}

export interface AuthStatus {
  mode: AuthMode;
  configured: boolean;
  source: 'env' | 'local_store' | 'native' | 'codex_cli' | 'none';
  message: string;
  openaiApiKeyPresent: boolean;
  codexOauthPresent: boolean;
  codexAccountId?: string;
  codexLastRefresh?: string;
  codexImportPath?: string;
}
