/**
 * Multi-agent workspace — typed fetchers over the daemon's read-only
 * /api/console/agents routes. Surfaces the team-agent roster, the
 * canMessage permission graph, team comms + delegations, and per-agent
 * autonomy runs. Read-only (slice 1); mirrors lib/spaces.ts.
 */
import { apiGet, apiPost, apiPatch, apiDelete } from './api';

export type AgentStatus = 'idle' | 'active' | 'blocked';

export interface AgentSummary {
  slug: string;
  name: string;
  role: string | null;
  description: string;
  model: string | null;
  project: string | null;
  channelName: string | null;
  canMessage: string[];
  allowedTools: string[];
  proactive: boolean;
  autonomyEnabled: boolean;
  cadenceMinutes: number | null;
  wakeTriggers: string[];
  skills: string[];
  workflows: string[];
  personality: string;
  status: AgentStatus;
  pendingInbox: number;
  pendingRequests: number;
  lastRunAt: string | null;
  lastSummary: string | null;
  commitments: string[];
  nextWakeAt: string | null;
  lastError: string | null;
}

export type GraphNodeKind = 'agent' | 'skill' | 'workflow';
export interface AgentGraphNode {
  id: string;
  label: string;
  role: string | null;
  primary: boolean;
  status: AgentStatus;
  kind: GraphNodeKind;
}
export interface AgentGraphEdge { source: string; target: string; kind: 'message' | 'skill' | 'workflow' }
export interface AgentGraphData { nodes: AgentGraphNode[]; edges: AgentGraphEdge[] }

export interface CatalogEntry { name: string; description: string }
export interface AgentCatalog { skills: CatalogEntry[]; workflows: CatalogEntry[] }

export interface TeamMessage {
  id: string;
  fromAgent: string;
  toAgent: string;
  content: string;
  timestamp: string;
  protocol: 'message' | 'request' | 'response';
  requestId?: string;
}
export interface Delegation {
  id: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  expectedOutput: string;
  status: 'pending' | 'in_progress' | 'completed';
  result?: string;
  createdAt: string;
  updatedAt: string;
}
export interface AgentComms { messages: TeamMessage[]; delegations: Delegation[] }

export interface AgentRunEvent {
  id: string;
  type: string;
  message: string;
  createdAt: string;
  data?: Record<string, unknown>;
}
export interface AgentRun {
  id: string;
  sessionId: string;
  title: string;
  input: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  outputPreview?: string;
  events: AgentRunEvent[];
}

export type AgentProposalStatus = 'pending' | 'approved' | 'rejected';
export type AgentCreationDecisionKind = 'one_off' | 'agent' | 'workflow' | 'workflow_with_agent';

export interface AgentCreationDecision {
  kind: AgentCreationDecisionKind;
  agentScore: number;
  workflowScore: number;
  oneOffScore: number;
  confidence: number;
  reasons: string[];
}

export interface AgentProposal {
  id: string;
  proposedAt: string;
  proposedByAgent: string;
  status: AgentProposalStatus;
  source: 'chat' | 'console' | 'system' | 'tool';
  originatingRequest: string;
  sessionId?: string;
  rationale: string;
  decision: AgentCreationDecision;
  agent: {
    name: string;
    description: string;
    role?: string;
    personality?: string;
    model?: string;
    project?: string;
    canMessage: string[];
    allowedTools: string[];
    skills: string[];
    workflows: string[];
    proactive: boolean;
    autonomyEnabled: boolean;
    cadenceMinutes: number;
  };
  memoryScope?: string;
  approvalPolicy?: string;
  evalCriteria: string[];
  suggestedWorkflows: string[];
  resolvedAt?: string;
  resolvedAgentSlug?: string;
  rejectionReason?: string;
}

export const listAgents = () =>
  apiGet<{ agents: AgentSummary[]; generatedAt: string }>('/api/console/agents').then((r) => r.agents);

export const getAgentGraph = () =>
  apiGet<AgentGraphData & { generatedAt: string }>('/api/console/agents/graph');

export const getAgentComms = (limit = 50) =>
  apiGet<AgentComms & { generatedAt: string }>(`/api/console/agents/comms?limit=${limit}`);

export const getAgentCatalog = () =>
  apiGet<AgentCatalog & { generatedAt: string }>('/api/console/agents/catalog');

export const getAgentRuns = (slug: string, limit = 20) =>
  apiGet<{ runs: AgentRun[]; generatedAt: string }>(
    `/api/console/agents/${encodeURIComponent(slug)}/runs?limit=${limit}`,
  ).then((r) => r.runs);

export const listAgentProposals = (status: AgentProposalStatus | 'all' = 'pending', limit = 20) =>
  apiGet<{ proposals: AgentProposal[]; generatedAt: string }>(
    `/api/console/agents/proposals?status=${encodeURIComponent(status)}&limit=${limit}`,
  ).then((r) => r.proposals);

/** Editable fields for create/update (slice 2). All optional on PATCH. */
export interface AgentInput {
  name?: string;
  description?: string;
  role?: string;
  personality?: string;
  model?: string;
  project?: string;
  canMessage?: string[];
  allowedTools?: string[];
  skills?: string[];
  workflows?: string[];
  cadenceMinutes?: number;
  proactive?: boolean;
  autonomyEnabled?: boolean;
}

export const createAgent = (input: AgentInput) =>
  apiPost<{ agent: AgentSummary }>('/api/console/agents', input).then((r) => r.agent);

export interface AgentProposalInput extends AgentInput {
  originatingRequest: string;
  rationale: string;
  memoryScope?: string;
  approvalPolicy?: string;
  evalCriteria?: string[];
  suggestedWorkflows?: string[];
}

export const createAgentProposal = (input: AgentProposalInput) =>
  apiPost<{ proposal: AgentProposal }>('/api/console/agents/proposals', input).then((r) => r.proposal);

export const approveAgentProposal = (id: string) =>
  apiPost<{ proposal: AgentProposal; agent: AgentSummary }>(
    `/api/console/agents/proposals/${encodeURIComponent(id)}/approve`,
  );

export const rejectAgentProposal = (id: string, reason?: string) =>
  apiPost<{ proposal: AgentProposal }>(
    `/api/console/agents/proposals/${encodeURIComponent(id)}/reject`,
    reason ? { reason } : {},
  ).then((r) => r.proposal);

export const updateAgent = (slug: string, input: AgentInput) =>
  apiPatch<{ agent: AgentSummary }>(`/api/console/agents/${encodeURIComponent(slug)}`, input).then((r) => r.agent);

export const deleteAgent = (slug: string) =>
  apiDelete<{ removed: boolean; slug: string }>(`/api/console/agents/${encodeURIComponent(slug)}`);

/** A signature of the most recent comms event, so the graph can detect a
 *  fresh message between polls and pulse the matching edge. */
export function latestCommsKey(comms: AgentComms | undefined): string {
  if (!comms) return '';
  const m = comms.messages[0];
  const d = comms.delegations[0];
  return `${m ? `${m.id}:${m.timestamp}` : ''}|${d ? `${d.id}:${d.updatedAt}` : ''}`;
}
