import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { addNotification } from '../runtime/notifications.js';
import {
  createCheckInTemplate,
  updateCheckInTemplate,
  type TriggerKind,
  type CheckInTemplate,
} from './check-in-templates.js';
import type { CheckInUrgency } from './check-ins.js';

/**
 * Agent-drafted check-in template PROPOSALS.
 *
 * The agent itself can spot recurring patterns in conversation
 * ("you've mentioned the staging deploy three times this week") and
 * propose a new template. The user approves → it promotes to an
 * active CheckInTemplate. Reject → discarded.
 *
 * Why "propose, don't auto-create":
 *   - The user owns what reaches out to them. Proactive check-ins
 *     are an intimate UX — the wrong cadence is annoying enough
 *     that we never want the agent to install one without consent.
 *   - The agent's rationale ("I noticed X because Y") is captured
 *     so the user can audit why the agent thought this would help.
 *   - Approval flow doubles as feedback: the user shaping which
 *     proposals stick teaches the agent what kinds of nudges they
 *     actually want.
 *
 * Storage: ~/.clementine-next/state/check-in-proposals/<id>.json
 * Notification: 'approval' kind so it routes to Discord + dashboard
 * via the existing notification path.
 */

const logger = pino({ name: 'clementine-next.check-in-proposals' });

const PROPOSALS_DIR = path.join(BASE_DIR, 'state', 'check-in-proposals');

export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export interface CheckInTemplateProposal {
  id: string;
  proposedAt: string;
  proposedByAgent: string;
  rationale: string;
  status: ProposalStatus;
  // Template fields — same shape as CreateTemplateInput minus enabled/seededId
  name: string;
  description: string;
  agentSlug: string;
  trigger: TriggerKind;
  schedule?: string;
  blockedHours?: number;
  staleDays?: number;
  inboxThreshold?: number;
  questionTemplate: string;
  urgency: CheckInUrgency;
  cooldownHours: number;
  // Resolution metadata
  resolvedAt?: string;
  resolvedBy?: 'user' | 'system';
  resolvedTemplateId?: string;
  rejectionReason?: string;
  /**
   * Fields the user changed at approval time, e.g. {schedule: '0 10 * * 1'}.
   * Only populated when overrides differ from the proposal as drafted.
   * This is the learning signal: "user wanted this idea but adjusted X".
   */
  appliedEdits?: Record<string, string | number>;
  version: 'v1';
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function proposalPath(id: string): string {
  return path.join(PROPOSALS_DIR, `${id}.json`);
}

function readProposal(id: string): CheckInTemplateProposal | null {
  const filePath = proposalPath(id);
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) as CheckInTemplateProposal; }
  catch { return null; }
}

function writeProposal(record: CheckInTemplateProposal): void {
  ensureDir(PROPOSALS_DIR);
  const tmp = `${proposalPath(record.id)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
  renameSync(tmp, proposalPath(record.id));
}

// ─── Public API ────────────────────────────────────────────────

export interface ProposeInput {
  name: string;
  description?: string;
  agentSlug?: string;
  trigger: TriggerKind;
  schedule?: string;
  blockedHours?: number;
  staleDays?: number;
  inboxThreshold?: number;
  questionTemplate: string;
  urgency?: CheckInUrgency;
  cooldownHours?: number;
  rationale: string;
  proposedByAgent?: string;
}

/**
 * Validate the proposal payload. Throws on obvious problems so the
 * agent gets immediate feedback instead of writing a broken proposal
 * that fails on approval. Mirrors the same checks createCheckInTemplate
 * applies, plus a rationale-quality check.
 */
function validatePropose(input: ProposeInput): void {
  if (!input.name || input.name.trim().length < 3) {
    throw new Error('name required (min 3 chars)');
  }
  if (!input.questionTemplate || input.questionTemplate.trim().length < 8) {
    throw new Error('questionTemplate required (min 8 chars)');
  }
  if (!input.rationale || input.rationale.trim().length < 8) {
    throw new Error('rationale required (min 8 chars) — explain WHY you think this template would help');
  }
  if (input.trigger === 'schedule') {
    if (!input.schedule || !/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(input.schedule.trim())) {
      throw new Error('schedule trigger requires a 5-field cron expression');
    }
  }
  if (input.trigger === 'execution_blocked' && input.blockedHours !== undefined && input.blockedHours < 1) {
    throw new Error('blockedHours must be >= 1');
  }
  if (input.trigger === 'goal_stale' && input.staleDays !== undefined && input.staleDays < 1) {
    throw new Error('staleDays must be >= 1');
  }
  if (input.trigger === 'inbox_backed_up' && input.inboxThreshold !== undefined && input.inboxThreshold < 1) {
    throw new Error('inboxThreshold must be >= 1');
  }
  if (input.cooldownHours !== undefined && input.cooldownHours < 0) {
    throw new Error('cooldownHours must be >= 0');
  }
}

export function proposeCheckInTemplate(input: ProposeInput): CheckInTemplateProposal {
  validatePropose(input);
  const now = new Date().toISOString();
  const proposal: CheckInTemplateProposal = {
    id: `prop-${randomUUID().slice(0, 8)}`,
    proposedAt: now,
    proposedByAgent: input.proposedByAgent ?? 'clementine',
    rationale: input.rationale.trim(),
    status: 'pending',
    name: input.name.trim(),
    description: (input.description ?? '').trim(),
    agentSlug: input.agentSlug?.trim() || 'clementine',
    trigger: input.trigger,
    schedule: input.trigger === 'schedule' ? input.schedule : undefined,
    blockedHours: input.trigger === 'execution_blocked' ? (input.blockedHours ?? 24) : undefined,
    staleDays: input.trigger === 'goal_stale' ? (input.staleDays ?? 7) : undefined,
    inboxThreshold: input.trigger === 'inbox_backed_up' ? (input.inboxThreshold ?? 10) : undefined,
    questionTemplate: input.questionTemplate.trim(),
    urgency: input.urgency ?? 'normal',
    cooldownHours: input.cooldownHours ?? (input.trigger === 'schedule' ? 1 : 12),
    version: 'v1',
  };
  writeProposal(proposal);

  // Notify the user — same path as approvals so it routes to Discord
  // + dashboard + tray badge.
  addNotification({
    id: `${Date.now()}-checkin-proposal-${proposal.id}`,
    kind: 'approval',
    title: `Check-in proposal: ${proposal.name}`,
    body: [
      proposal.rationale,
      '',
      `Trigger: ${proposal.trigger}${proposal.schedule ? ` · cron ${proposal.schedule}` : ''}`,
      `Question: ${proposal.questionTemplate.slice(0, 240)}`,
      '',
      'Approve from Settings → Proactive Check-Ins.',
    ].join('\n'),
    createdAt: now,
    read: false,
    metadata: { proposalId: proposal.id, proposedByAgent: proposal.proposedByAgent, kind: 'check_in_proposal' },
  });

  logger.info({ proposalId: proposal.id, name: proposal.name, trigger: proposal.trigger }, 'check-in proposal queued');

  return proposal;
}

export function getProposal(id: string): CheckInTemplateProposal | null {
  return readProposal(id);
}

export interface ListProposalsFilter {
  status?: ProposalStatus | 'all';
  limit?: number;
}

export function listProposals(filter: ListProposalsFilter = {}): CheckInTemplateProposal[] {
  if (!existsSync(PROPOSALS_DIR)) return [];
  const wantedStatus = filter.status ?? 'pending';
  const items: CheckInTemplateProposal[] = [];
  for (const entry of readdirSync(PROPOSALS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const p = JSON.parse(readFileSync(path.join(PROPOSALS_DIR, entry), 'utf-8')) as CheckInTemplateProposal;
      if (wantedStatus !== 'all' && p.status !== wantedStatus) continue;
      items.push(p);
    } catch { continue; }
  }
  items.sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  if (filter.limit !== undefined) return items.slice(0, Math.max(0, filter.limit));
  return items;
}

export interface ApproveOptions {
  /** Optional overrides — user can tweak fields before approving. */
  overrides?: Partial<{
    name: string;
    description: string;
    schedule: string;
    blockedHours: number;
    staleDays: number;
    inboxThreshold: number;
    questionTemplate: string;
    urgency: CheckInUrgency;
    cooldownHours: number;
  }>;
  /** Default true — approved templates start enabled. Pass false to
   *  approve+install in disabled state. */
  enabledOnInstall?: boolean;
}

export function approveProposal(id: string, options: ApproveOptions = {}): { proposal: CheckInTemplateProposal; template: CheckInTemplate } | null {
  const proposal = readProposal(id);
  if (!proposal) return null;
  if (proposal.status !== 'pending') {
    // Approving an already-resolved proposal is a no-op — return the
    // existing template if we have a record of it.
    return null;
  }
  const overrides = options.overrides ?? {};
  const template = createCheckInTemplate({
    name: overrides.name ?? proposal.name,
    description: overrides.description ?? proposal.description,
    agentSlug: proposal.agentSlug,
    trigger: proposal.trigger,
    schedule: overrides.schedule ?? proposal.schedule,
    blockedHours: overrides.blockedHours ?? proposal.blockedHours,
    staleDays: overrides.staleDays ?? proposal.staleDays,
    inboxThreshold: overrides.inboxThreshold ?? proposal.inboxThreshold,
    questionTemplate: overrides.questionTemplate ?? proposal.questionTemplate,
    urgency: overrides.urgency ?? proposal.urgency,
    cooldownHours: overrides.cooldownHours ?? proposal.cooldownHours,
    enabled: options.enabledOnInstall ?? true,
  });

  const appliedEdits: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const before = (proposal as unknown as Record<string, unknown>)[key];
    if (value !== before) appliedEdits[key] = value as string | number;
  }
  const resolved: CheckInTemplateProposal = {
    ...proposal,
    status: 'approved',
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'user',
    resolvedTemplateId: template.id,
    appliedEdits: Object.keys(appliedEdits).length > 0 ? appliedEdits : undefined,
  };
  writeProposal(resolved);

  addNotification({
    id: `${Date.now()}-checkin-proposal-${proposal.id}-approved`,
    kind: 'system',
    title: `Approved: ${proposal.name}`,
    body: `Template installed${options.enabledOnInstall === false ? ' (disabled)' : ' and enabled'}.`,
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { proposalId: proposal.id, templateId: template.id, kind: 'check_in_proposal' },
  });

  logger.info({ proposalId: proposal.id, templateId: template.id }, 'check-in proposal approved');

  return { proposal: resolved, template };
}

export function rejectProposal(id: string, reason?: string): CheckInTemplateProposal | null {
  const proposal = readProposal(id);
  if (!proposal) return null;
  if (proposal.status !== 'pending') return proposal;
  const resolved: CheckInTemplateProposal = {
    ...proposal,
    status: 'rejected',
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'user',
    rejectionReason: reason?.trim() || undefined,
  };
  writeProposal(resolved);
  logger.info({ proposalId: proposal.id, reason }, 'check-in proposal rejected');
  return resolved;
}

export function deleteProposal(id: string): boolean {
  const filePath = proposalPath(id);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

/**
 * Re-open the EDIT path on an existing active template via this same
 * proposal lifecycle — useful when the agent wants to suggest tweaks
 * to an existing template's wording or cadence. The proposal carries
 * a reference to the template it would replace.
 *
 * Approving an edit proposal updates the template in place rather
 * than creating a new one. For now we do this by setting
 * `resolvedTemplateId` to the existing template id at propose-time
 * and routing approval through updateCheckInTemplate.
 */
export interface ProposeEditInput extends ProposeInput {
  editsTemplateId: string;
}

export function proposeTemplateEdit(input: ProposeEditInput): CheckInTemplateProposal {
  const proposal = proposeCheckInTemplate(input);
  const updated: CheckInTemplateProposal = { ...proposal, resolvedTemplateId: input.editsTemplateId };
  writeProposal(updated);
  return updated;
}

export function approveEditProposal(id: string, options: ApproveOptions = {}): { proposal: CheckInTemplateProposal; template: CheckInTemplate } | null {
  const proposal = readProposal(id);
  if (!proposal || proposal.status !== 'pending' || !proposal.resolvedTemplateId) return null;
  const overrides = options.overrides ?? {};
  const template = updateCheckInTemplate(proposal.resolvedTemplateId, {
    name: overrides.name ?? proposal.name,
    description: overrides.description ?? proposal.description,
    schedule: overrides.schedule ?? proposal.schedule,
    blockedHours: overrides.blockedHours ?? proposal.blockedHours,
    staleDays: overrides.staleDays ?? proposal.staleDays,
    inboxThreshold: overrides.inboxThreshold ?? proposal.inboxThreshold,
    questionTemplate: overrides.questionTemplate ?? proposal.questionTemplate,
    urgency: overrides.urgency ?? proposal.urgency,
    cooldownHours: overrides.cooldownHours ?? proposal.cooldownHours,
  });
  if (!template) return null;

  const resolved: CheckInTemplateProposal = {
    ...proposal,
    status: 'approved',
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'user',
  };
  writeProposal(resolved);
  return { proposal: resolved, template };
}
