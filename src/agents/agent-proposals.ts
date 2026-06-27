import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { addNotification } from '../runtime/notifications.js';
import {
  agentFilePath,
  slugifyAgentName,
  writeTeamAgent,
  type TeamAgentRecord,
} from '../tools/shared.js';

const logger = pino({ name: 'clementine-next.agent-proposals' });

const PROPOSALS_DIR = path.join(BASE_DIR, 'state', 'agent-proposals');

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

export interface ProposedAgentDefinition {
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
  agent: ProposedAgentDefinition;
  memoryScope?: string;
  approvalPolicy?: string;
  evalCriteria: string[];
  suggestedWorkflows: string[];
  resolvedAt?: string;
  resolvedBy?: 'user' | 'system';
  resolvedAgentSlug?: string;
  rejectionReason?: string;
  appliedEdits?: Partial<ProposedAgentDefinition>;
  version: 'v1';
}

export interface AgentProposalInput {
  originatingRequest: string;
  name: string;
  description: string;
  role?: string;
  personality?: string;
  model?: string;
  project?: string;
  canMessage?: string[];
  allowedTools?: string[];
  skills?: string[];
  workflows?: string[];
  proactive?: boolean;
  autonomyEnabled?: boolean;
  cadenceMinutes?: number;
  memoryScope?: string;
  approvalPolicy?: string;
  evalCriteria?: string[];
  suggestedWorkflows?: string[];
  rationale: string;
  proposedByAgent?: string;
  source?: AgentProposal['source'];
  sessionId?: string;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function proposalPath(id: string): string {
  return path.join(PROPOSALS_DIR, `${id}.json`);
}

function readProposal(id: string): AgentProposal | null {
  const filePath = proposalPath(id);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as AgentProposal;
  } catch {
    return null;
  }
}

function writeProposal(record: AgentProposal): void {
  ensureDir(PROPOSALS_DIR);
  const tmp = `${proposalPath(record.id)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
  renameSync(tmp, proposalPath(record.id));
}

function countAny(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

export function scoreAgentCreationNeed(request: string, hints: Partial<AgentProposalInput> = {}): AgentCreationDecision {
  const text = [
    request,
    hints.name,
    hints.description,
    hints.role,
    hints.rationale,
    hints.personality,
  ].filter(Boolean).join(' ').toLowerCase();

  const agentScore =
    countAny(text, [
      /\bagent\b/,
      /\bspecialist\b/,
      /\brole\b/,
      /\bresearcher\b/,
      /\breviewer\b/,
      /\banalyst\b/,
      /\bwriter\b/,
      /\bassistant\b/,
      /\boperator\b/,
      /\bteam member\b/,
      /\bpersona\b/,
    ]) * 2
    + countAny(text, [
      /\balways\b/,
      /\bevery time\b/,
      /\bwhenever\b/,
      /\bany time\b/,
      /\breusable\b/,
      /\brepeated\b/,
      /\bacross workflows\b/,
      /\bdurable\b/,
      /\bremember\b/,
      /\bmemory\b/,
      /\btool set\b/,
    ]);

  const workflowScore =
    countAny(text, [
      /\bworkflow\b/,
      /\bprocess\b/,
      /\bautomation\b/,
      /\bsequence\b/,
      /\bsteps?\b/,
      /\btriggers?\b/,
      /\bschedules?\b/,
      /\bapprovals?\b/,
      /\bretr(?:y|ies)\b/,
      /\binputs?\b/,
      /\boutputs?\b/,
      /\bthen\b/,
    ]) * 2
    + countAny(text, [
      /\brepeatable\b/,
      /\bwhen .* then\b/,
      /\bafter\b/,
      /\bbefore\b/,
      /\brun\b/,
    ]);

  const oneOffScore =
    countAny(text, [
      /\bone[- ]?off\b/,
      /\bonce\b/,
      /\bquick\b/,
      /\bjust this\b/,
      /\bfor now\b/,
      /\btemporary\b/,
      /\bad hoc\b/,
    ]) * 2;

  const reasons: string[] = [];
  if (agentScore >= 4) reasons.push('durable specialist behavior');
  if (workflowScore >= 4) reasons.push('repeatable process signals');
  if (oneOffScore >= 2) reasons.push('one-off language present');
  if ((hints.allowedTools?.length ?? 0) > 0) reasons.push('stable tool permissions');
  if (hints.memoryScope) reasons.push('durable memory scope');
  if (hints.approvalPolicy) reasons.push('approval boundary');

  let kind: AgentCreationDecisionKind = 'one_off';
  if (agentScore >= 4 && workflowScore >= 2) kind = 'workflow_with_agent';
  else if (agentScore >= 4) kind = 'agent';
  else if (workflowScore >= 4) kind = 'workflow';

  const rawConfidence = 38 + Math.max(agentScore, workflowScore) * 8 - oneOffScore * 7;
  const confidence = Math.max(20, Math.min(96, Math.round(rawConfidence)));
  return { kind, agentScore, workflowScore, oneOffScore, confidence, reasons };
}

function cleanList(values?: string[]): string[] {
  return Array.isArray(values)
    ? [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]
    : [];
}

function validateInput(input: AgentProposalInput): void {
  if (!input.name || input.name.trim().length < 3) throw new Error('name required (min 3 chars)');
  if (!input.description || input.description.trim().length < 8) throw new Error('description required (min 8 chars)');
  if (!input.originatingRequest || input.originatingRequest.trim().length < 8) throw new Error('originatingRequest required (min 8 chars)');
  if (!input.rationale || input.rationale.trim().length < 8) throw new Error('rationale required (min 8 chars)');
  if (input.cadenceMinutes !== undefined && input.cadenceMinutes < 5) throw new Error('cadenceMinutes must be >= 5');
}

export function proposeAgentDefinition(input: AgentProposalInput): AgentProposal {
  validateInput(input);
  const now = new Date().toISOString();
  const decision = scoreAgentCreationNeed(input.originatingRequest, input);
  const proposal: AgentProposal = {
    id: `agp-${randomUUID().slice(0, 8)}`,
    proposedAt: now,
    proposedByAgent: input.proposedByAgent?.trim() || 'clementine',
    status: 'pending',
    source: input.source ?? 'chat',
    originatingRequest: input.originatingRequest.trim(),
    sessionId: input.sessionId?.trim() || undefined,
    rationale: input.rationale.trim(),
    decision,
    agent: {
      name: input.name.trim(),
      description: input.description.trim(),
      role: input.role?.trim() || undefined,
      personality: input.personality?.trim() || undefined,
      model: input.model?.trim() || undefined,
      project: input.project?.trim() || undefined,
      canMessage: cleanList(input.canMessage),
      allowedTools: cleanList(input.allowedTools),
      skills: cleanList(input.skills),
      workflows: cleanList(input.workflows),
      proactive: input.proactive ?? true,
      autonomyEnabled: input.autonomyEnabled ?? true,
      cadenceMinutes: input.cadenceMinutes !== undefined ? Math.max(5, input.cadenceMinutes) : 30,
    },
    memoryScope: input.memoryScope?.trim() || undefined,
    approvalPolicy: input.approvalPolicy?.trim() || undefined,
    evalCriteria: cleanList(input.evalCriteria),
    suggestedWorkflows: cleanList(input.suggestedWorkflows),
    version: 'v1',
  };
  writeProposal(proposal);

  addNotification({
    id: `${Date.now()}-agent-proposal-${proposal.id}`,
    kind: 'approval',
    title: `Agent proposal: ${proposal.agent.name}`,
    body: [
      proposal.rationale,
      '',
      `Decision: ${proposal.decision.kind} · confidence ${proposal.decision.confidence}/100`,
      `Role: ${proposal.agent.role ?? 'specialist'}`,
      '',
      'Review from Agents → Agent drafts.',
    ].join('\n'),
    createdAt: now,
    read: false,
    metadata: { proposalId: proposal.id, proposedByAgent: proposal.proposedByAgent, kind: 'agent_proposal' },
  });

  logger.info({ proposalId: proposal.id, name: proposal.agent.name, decision: proposal.decision.kind }, 'agent proposal queued');
  return proposal;
}

export function getAgentProposal(id: string): AgentProposal | null {
  return readProposal(id);
}

export interface ListAgentProposalsFilter {
  status?: AgentProposalStatus | 'all';
  limit?: number;
}

export function listAgentProposals(filter: ListAgentProposalsFilter = {}): AgentProposal[] {
  if (!existsSync(PROPOSALS_DIR)) return [];
  const wantedStatus = filter.status ?? 'pending';
  const items: AgentProposal[] = [];
  for (const entry of readdirSync(PROPOSALS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const proposal = JSON.parse(readFileSync(path.join(PROPOSALS_DIR, entry), 'utf-8')) as AgentProposal;
      if (wantedStatus !== 'all' && proposal.status !== wantedStatus) continue;
      items.push(proposal);
    } catch {
      continue;
    }
  }
  items.sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  if (filter.limit !== undefined) return items.slice(0, Math.max(0, filter.limit));
  return items;
}

export interface ApproveAgentProposalOptions {
  overrides?: Partial<ProposedAgentDefinition>;
}

function definedOverrides(overrides: Partial<ProposedAgentDefinition>): Partial<ProposedAgentDefinition> {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<ProposedAgentDefinition>;
}

function recordFromProposal(proposal: AgentProposal, overrides: Partial<ProposedAgentDefinition> = {}): TeamAgentRecord {
  const agent = { ...proposal.agent, ...definedOverrides(overrides) };
  const memoryLine = proposal.memoryScope ? `\nMemory scope: ${proposal.memoryScope}` : '';
  const approvalLine = proposal.approvalPolicy ? `\nApproval boundary: ${proposal.approvalPolicy}` : '';
  const evalLines = proposal.evalCriteria.length > 0
    ? `\nEvaluation criteria:\n${proposal.evalCriteria.map((criterion) => `- ${criterion}`).join('\n')}`
    : '';
  const personality = (agent.personality?.trim()
    || `You are ${agent.name}. ${agent.description}`).trim();

  return {
    slug: slugifyAgentName(agent.name),
    name: agent.name.trim(),
    description: agent.description.trim(),
    role: agent.role?.trim() || undefined,
    canMessage: cleanList(agent.canMessage),
    allowedTools: cleanList(agent.allowedTools),
    skills: cleanList(agent.skills),
    workflows: cleanList(agent.workflows),
    model: agent.model?.trim() || undefined,
    project: agent.project?.trim() || undefined,
    tier: 2,
    autonomyEnabled: agent.autonomyEnabled ?? true,
    proactive: agent.proactive ?? true,
    cadenceMinutes: agent.cadenceMinutes !== undefined ? Math.max(5, agent.cadenceMinutes) : 30,
    wakeTriggers: ['inbox', 'delegation', 'request', 'stale_tasks', 'daily_review'],
    personality: `${personality}${memoryLine}${approvalLine}${evalLines}`.trim(),
  };
}

export function approveAgentProposal(
  id: string,
  options: ApproveAgentProposalOptions = {},
): { proposal: AgentProposal; agent: TeamAgentRecord } | null {
  const proposal = readProposal(id);
  if (!proposal || proposal.status !== 'pending') return null;
  const record = recordFromProposal(proposal, options.overrides);
  if (!record.slug) throw new Error('could not derive a valid slug from agent name');
  if (existsSync(agentFilePath(record.slug))) throw new Error(`agent already exists: ${record.slug}`);

  writeTeamAgent(record);
  const updated: AgentProposal = {
    ...proposal,
    status: 'approved',
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'user',
    resolvedAgentSlug: record.slug,
    appliedEdits: options.overrides,
  };
  writeProposal(updated);
  return { proposal: updated, agent: record };
}

export function rejectAgentProposal(id: string, reason?: string): AgentProposal | null {
  const proposal = readProposal(id);
  if (!proposal || proposal.status !== 'pending') return null;
  const updated: AgentProposal = {
    ...proposal,
    status: 'rejected',
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'user',
    rejectionReason: reason?.trim() || undefined,
  };
  writeProposal(updated);
  return updated;
}

export function agentProposalStats(): { pending: number; approved: number; rejected: number } {
  const all = listAgentProposals({ status: 'all' });
  return {
    pending: all.filter((p) => p.status === 'pending').length,
    approved: all.filter((p) => p.status === 'approved').length,
    rejected: all.filter((p) => p.status === 'rejected').length,
  };
}
