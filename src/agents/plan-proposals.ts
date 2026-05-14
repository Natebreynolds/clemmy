import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { addNotification } from '../runtime/notifications.js';
import type { Plan } from './planner.js';

/**
 * Plan proposals — agent-drafted plans surfaced for user review.
 *
 * The Planner sub-agent produces inspectable plans via `draft_plan`.
 * For trivial / moderate work the orchestrator can execute against
 * the plan inline. For SIGNIFICANT or LARGE work (or anything the
 * orchestrator decides the user should see first), the orchestrator
 * calls `surface_plan` which persists the plan here and queues a
 * notification.
 *
 * The user reviews the plan in the dashboard or Discord, then
 * approves, rejects, or edits-then-approves. The plan goes from
 * `pending` → `approved` / `rejected` / `superseded`.
 *
 * Why a separate store rather than reusing the existing PlanStore:
 *   - PlanStore plans are *active* (tied to executions, tracked
 *     step-by-step). PlanProposals are *deliberative* — drafts the
 *     user hasn't yet committed to. Mixing them muddles the model.
 *   - The proposal lifecycle has its own metadata (resolution
 *     timestamp, rejection reason, applied edits) the active store
 *     doesn't need.
 *
 * Storage: ~/.clementine-next/state/plan-proposals/<id>.json
 * Notification: 'approval' kind so it routes through Discord +
 * dashboard via the existing notification path, same as check-in
 * proposals.
 */

const logger = pino({ name: 'clementine-next.plan-proposals' });

const PROPOSALS_DIR = path.join(BASE_DIR, 'state', 'plan-proposals');

export type PlanProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

export interface PlanProposal {
  id: string;
  proposedAt: string;
  proposedByAgent: string;
  status: PlanProposalStatus;
  /** The user's original request that triggered the plan. */
  originatingRequest: string;
  /** Session this plan belongs to so the agent can resume execution there. */
  sessionId?: string;
  /** Channel the originating request came from (discord:..., cli, webhook). */
  channel?: string;
  /** The structured plan from the Planner sub-agent. */
  plan: Plan;
  /** Optional preface the orchestrator wants the user to see before the plan. */
  context?: string;
  // Resolution metadata
  resolvedAt?: string;
  resolvedBy?: 'user' | 'system';
  rejectionReason?: string;
  /**
   * If the user edited the plan before approving, this is the plan as
   * approved. The original `plan` field is preserved for audit.
   */
  approvedPlan?: Plan;
  version: 'v1';
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function proposalPath(id: string): string {
  return path.join(PROPOSALS_DIR, `${id}.json`);
}

function readProposal(id: string): PlanProposal | null {
  const filePath = proposalPath(id);
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) as PlanProposal; }
  catch { return null; }
}

function writeProposal(record: PlanProposal): void {
  ensureDir(PROPOSALS_DIR);
  const tmp = `${proposalPath(record.id)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
  renameSync(tmp, proposalPath(record.id));
}

export interface SurfacePlanInput {
  plan: Plan;
  originatingRequest: string;
  proposedByAgent?: string;
  sessionId?: string;
  channel?: string;
  context?: string;
}

/**
 * Persist a Plan as a PlanProposal and queue an approval notification.
 * The orchestrator calls this when work is significant enough that the
 * user should see the plan before any mutation happens.
 */
export function surfacePlan(input: SurfacePlanInput): PlanProposal {
  if (!input.originatingRequest || input.originatingRequest.trim().length < 4) {
    throw new Error('originatingRequest required (min 4 chars) — what was the user asking for?');
  }
  if (!input.plan || !input.plan.objective || input.plan.steps.length === 0) {
    throw new Error('plan must include objective and at least one step');
  }
  const now = new Date().toISOString();
  const proposal: PlanProposal = {
    id: `plan-${randomUUID().slice(0, 8)}`,
    proposedAt: now,
    proposedByAgent: input.proposedByAgent ?? 'clementine',
    status: 'pending',
    originatingRequest: input.originatingRequest.trim(),
    sessionId: input.sessionId,
    channel: input.channel,
    plan: input.plan,
    context: input.context?.trim() || undefined,
    version: 'v1',
  };
  writeProposal(proposal);

  const stepSummary = proposal.plan.steps
    .slice(0, 4)
    .map((s) => `  ${s.n}. ${s.action}`)
    .join('\n');
  const moreSteps = proposal.plan.steps.length > 4
    ? `\n  …and ${proposal.plan.steps.length - 4} more steps`
    : '';
  const questionsBlock = proposal.plan.needsUserInput.length > 0
    ? `\n\nQuestions before I start:\n${proposal.plan.needsUserInput.map((q) => `  · ${q}`).join('\n')}`
    : '';

  addNotification({
    id: `${Date.now()}-plan-proposal-${proposal.id}`,
    kind: 'approval',
    title: `Plan ready for review: ${proposal.plan.objective.slice(0, 80)}`,
    body: [
      `Complexity: ${proposal.plan.estimatedComplexity}.`,
      proposal.context ? `\nContext: ${proposal.context}` : '',
      `\nObjective: ${proposal.plan.objective}`,
      `\nSteps:\n${stepSummary}${moreSteps}`,
      questionsBlock,
      '\n\nReview and approve in the dashboard or reply to approve / reject here.',
    ].filter(Boolean).join(''),
    createdAt: now,
    read: false,
    metadata: {
      planProposalId: proposal.id,
      sessionId: proposal.sessionId,
      channel: proposal.channel,
      kind: 'plan_proposal',
    },
  });

  logger.info({ proposalId: proposal.id, complexity: proposal.plan.estimatedComplexity, steps: proposal.plan.steps.length }, 'plan proposal surfaced');

  return proposal;
}

export function getPlanProposal(id: string): PlanProposal | null {
  return readProposal(id);
}

export interface ListPlanProposalsFilter {
  status?: PlanProposalStatus | 'all';
  sessionId?: string;
  limit?: number;
}

export function listPlanProposals(filter: ListPlanProposalsFilter = {}): PlanProposal[] {
  if (!existsSync(PROPOSALS_DIR)) return [];
  const wantedStatus = filter.status ?? 'pending';
  const items: PlanProposal[] = [];
  for (const entry of readdirSync(PROPOSALS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const p = JSON.parse(readFileSync(path.join(PROPOSALS_DIR, entry), 'utf-8')) as PlanProposal;
      if (wantedStatus !== 'all' && p.status !== wantedStatus) continue;
      if (filter.sessionId && p.sessionId !== filter.sessionId) continue;
      items.push(p);
    } catch { continue; }
  }
  items.sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  if (filter.limit !== undefined) return items.slice(0, Math.max(0, filter.limit));
  return items;
}

export interface ApprovePlanProposalOptions {
  /**
   * If the user edited the plan in the UI before approving, the
   * edited Plan is passed here and becomes the approvedPlan. Original
   * plan is preserved on the record for audit.
   */
  editedPlan?: Plan;
}

export function approvePlanProposal(id: string, options: ApprovePlanProposalOptions = {}): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal) return null;
  if (proposal.status !== 'pending') return null;
  const resolved: PlanProposal = {
    ...proposal,
    status: 'approved',
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'user',
    approvedPlan: options.editedPlan ?? proposal.plan,
  };
  writeProposal(resolved);

  addNotification({
    id: `${Date.now()}-plan-proposal-${proposal.id}-approved`,
    kind: 'system',
    title: `Plan approved: ${proposal.plan.objective.slice(0, 80)}`,
    body: options.editedPlan
      ? 'Plan approved with edits. The agent will execute against the edited plan.'
      : 'Plan approved. The agent will proceed.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { planProposalId: proposal.id, sessionId: proposal.sessionId, kind: 'plan_proposal' },
  });

  logger.info({ proposalId: proposal.id, edited: Boolean(options.editedPlan) }, 'plan proposal approved');
  return resolved;
}

export function rejectPlanProposal(id: string, reason?: string): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal) return null;
  if (proposal.status !== 'pending') return proposal;
  const resolved: PlanProposal = {
    ...proposal,
    status: 'rejected',
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'user',
    rejectionReason: reason?.trim() || undefined,
  };
  writeProposal(resolved);
  logger.info({ proposalId: proposal.id, reason }, 'plan proposal rejected');
  return resolved;
}

export function deletePlanProposal(id: string): boolean {
  const filePath = proposalPath(id);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

/**
 * Mark a pending proposal as superseded — used when the agent has
 * drafted a new plan for the same originating request and wants to
 * cancel the prior one without going through reject (which carries
 * negative feedback signal).
 */
export function supersedePlanProposal(id: string, replacedBy?: string): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal) return null;
  if (proposal.status !== 'pending') return proposal;
  const resolved: PlanProposal = {
    ...proposal,
    status: 'superseded',
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'system',
    rejectionReason: replacedBy ? `Replaced by ${replacedBy}` : undefined,
  };
  writeProposal(resolved);
  return resolved;
}
