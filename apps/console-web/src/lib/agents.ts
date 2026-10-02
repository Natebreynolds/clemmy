/**
 * Agents — typed fetchers over /api/console/agents.
 *
 * An agent is a specialized working context a person opens and works in: a
 * name, what it handles, standing instructions, and the skills / workflows /
 * tools / model it reaches for first. A turn inside an agent is an ordinary
 * Clem turn with that agent's context; a conversation can switch agents
 * between messages. Mirrors lib/spaces.ts.
 */
import { apiGet, apiPost, apiPatch, apiDelete } from './api';
import type { RunAgent } from './board';
import type { Session } from '@/features/conversations/types';

export interface AgentRecord {
  id: string;
  name: string;
  /** One line: what this agent handles. */
  handles: string;
  /** Standing instructions every thread in this agent starts from. */
  instructions: string;
  skills: string[];
  workflows: string[];
  tools: string[];
  /** A model id, or null to follow the brain. */
  model: string | null;
  memoryScope: string | null;
  createdFrom: 'chat' | 'console' | 'phone' | 'plugin' | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Editable fields. On PATCH every field is optional; '' or null clears a
 *  string field. */
export interface AgentInput {
  name?: string;
  handles?: string;
  instructions?: string;
  skills?: string[];
  workflows?: string[];
  tools?: string[];
  model?: string | null;
  memoryScope?: string | null;
}

export interface CatalogEntry { name: string; description: string }
export interface CatalogModel { id: string; label: string }
export interface AgentCatalog {
  skills: CatalogEntry[];
  workflows: CatalogEntry[];
  /** Absent until the daemon offers a tool picker; hide the picker when so. */
  tools?: CatalogEntry[];
  /** Absent until the daemon offers a model picker; hide the picker when so. */
  models?: CatalogModel[];
}

/** A worker run spawned from a thread inside an agent. */
export interface AgentWorker extends RunAgent {
  boundAgentId?: string;
  parentRunId?: string;
}

export interface AgentWork {
  threads: Session[];
  workers: AgentWorker[];
}

/** Server records arrive with whatever the daemon stored; every list and
 *  nullable field is filled in here so screens never branch on absence. */
function normalizeAgent(raw: Partial<AgentRecord> & { id: string; name: string }): AgentRecord {
  return {
    id: raw.id,
    name: raw.name,
    handles: raw.handles ?? '',
    instructions: raw.instructions ?? '',
    skills: raw.skills ?? [],
    workflows: raw.workflows ?? [],
    tools: raw.tools ?? [],
    model: raw.model ?? null,
    memoryScope: raw.memoryScope ?? null,
    createdFrom: raw.createdFrom ?? null,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

export const listAgents = () =>
  apiGet<{ agents?: AgentRecord[] }>('/api/console/agents')
    .then((r) => (r.agents ?? []).map(normalizeAgent));

export const getAgent = (id: string) =>
  apiGet<{ agent: AgentRecord }>(`/api/console/agents/${encodeURIComponent(id)}`)
    .then((r) => normalizeAgent(r.agent));

export const createAgent = (input: AgentInput) =>
  apiPost<{ agent: AgentRecord }>('/api/console/agents', input).then((r) => normalizeAgent(r.agent));

export const updateAgent = (id: string, input: AgentInput) =>
  apiPatch<{ agent: AgentRecord }>(`/api/console/agents/${encodeURIComponent(id)}`, input)
    .then((r) => normalizeAgent(r.agent));

export const deleteAgent = (id: string) =>
  apiDelete<{ removed: boolean; id: string }>(`/api/console/agents/${encodeURIComponent(id)}`);

export const getAgentCatalog = () =>
  apiGet<Partial<AgentCatalog>>('/api/console/agents/catalog')
    .then((r): AgentCatalog => ({
      skills: r.skills ?? [],
      workflows: r.workflows ?? [],
      ...(r.tools ? { tools: r.tools } : {}),
      ...(r.models ? { models: r.models } : {}),
    }));

export const getAgentWork = (id: string, limit = 20) =>
  apiGet<Partial<AgentWork>>(`/api/console/agents/${encodeURIComponent(id)}/work?limit=${limit}`)
    .then((r): AgentWork => ({ threads: r.threads ?? [], workers: r.workers ?? [] }));

/** Who answers a conversation: a saved agent, by id and the name it shows. */
export interface ConversationAgent { id: string; name: string }

/** Switch who answers a conversation from its next message: an agent's id,
 *  or null for Clem. Repeating the current choice is a no-op. */
export const setConversationAgent = (sessionId: string, agentId: string | null) =>
  apiPost<{ sessionId: string; agentId: string | null; agentName: string | null; changed: boolean }>(
    `/api/console/sessions/${encodeURIComponent(sessionId)}/agent`,
    { agentId },
  );

/** An agent's own model, when it answers the next message. */
export interface AnsweringAgentModel { modelId: string; agentId: string; agentName: string }

/** Whether the next message is answered on an agent's own model: `agentId` is
 *  the agent chip's choice (null = Clem), applied on send like the switch. */
export const getAnsweringModel = (sessionId: string | undefined, agentId: string | null) => {
  const query = new URLSearchParams();
  if (sessionId) query.set('sessionId', sessionId);
  query.set('agentId', agentId ?? '');
  return apiGet<{ agent: AnsweringAgentModel | null }>(`/api/console/answering-model?${query}`).then((r) => r.agent ?? null);
};

/** The chips a roster card shows: what the agent reaches for first. */
export function agentReachSummary(agent: AgentRecord, modelLabel?: string | null): string[] {
  const parts: string[] = [];
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (agent.skills.length > 0) parts.push(count(agent.skills.length, 'skill'));
  if (agent.workflows.length > 0) parts.push(count(agent.workflows.length, 'workflow'));
  if (agent.tools.length > 0) parts.push(count(agent.tools.length, 'tool'));
  if (agent.model) parts.push(modelLabel || agent.model);
  return parts;
}

// ─── Drafts from Clem ───
// A proposal Clem wrote during a conversation, waiting for the owner to turn
// it into an agent. Stays until the chat-card flow replaces it.

export type AgentProposalStatus = 'pending' | 'approved' | 'rejected';

export interface AgentProposal {
  id: string;
  proposedAt: string;
  status: AgentProposalStatus;
  source: 'chat' | 'console' | 'system' | 'tool';
  originatingRequest: string;
  sessionId?: string;
  rationale: string;
  agent: {
    name: string;
    description?: string;
    handles?: string;
    instructions?: string;
    model?: string | null;
    skills?: string[];
    workflows?: string[];
    tools?: string[];
  };
  suggestedWorkflows?: string[];
  resolvedAt?: string;
  rejectionReason?: string;
}

export const listAgentProposals = (status: AgentProposalStatus | 'all' = 'pending', limit = 20) =>
  apiGet<{ proposals?: AgentProposal[] }>(
    `/api/console/agents/proposals?status=${encodeURIComponent(status)}&limit=${limit}`,
  ).then((r) => r.proposals ?? []);

export const approveAgentProposal = (id: string) =>
  apiPost<{ proposal: AgentProposal; agent?: AgentRecord }>(
    `/api/console/agents/proposals/${encodeURIComponent(id)}/approve`,
  );

export const rejectAgentProposal = (id: string, reason?: string) =>
  apiPost<{ proposal: AgentProposal }>(
    `/api/console/agents/proposals/${encodeURIComponent(id)}/reject`,
    reason ? { reason } : {},
  ).then((r) => r.proposal);
