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
}

export interface ToolActivity {
  toolName: string;
  input: Record<string, unknown>;
}

export interface RunResult {
  text: string;
  sessionId?: string;
  pendingApprovalId?: string;
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
}

export interface AssistantResponse {
  text: string;
  sessionId: string;
  pendingApprovalId?: string;
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
