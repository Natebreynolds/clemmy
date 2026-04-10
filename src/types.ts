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

export interface MemoryContext {
  soul?: string;
  memory?: string;
  identity?: string;
  workingMemory?: string;
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
}

export interface PlanStep {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface PlanRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  steps: PlanStep[];
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
