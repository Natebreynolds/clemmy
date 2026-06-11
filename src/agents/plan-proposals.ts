import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { addNotification } from '../runtime/notifications.js';
import type { Plan } from './planner.js';
import { openPlanScope } from './plan-scope.js';

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

export type PlanProposalStatus =
  | 'pending' | 'approved' | 'rejected' | 'superseded'
  // Goal-contract lifecycle (GOAL-CONTRACT-PLAN.md): an approved plan that has
  // been ACTIVATED becomes the session's parked goal — the harness re-injects
  // it each turn and validates completion against it externally. Vocabulary
  // ported from the legacy /goal loop: pursuing→active, achieved→satisfied,
  // budget-limited→expired(reason).
  | 'active' | 'satisfied' | 'expired';

/** One validation finding, per criterion, per attempt. */
export interface GoalEvidence {
  at: string;
  attempt: number;
  criterion: string;
  pass: boolean;
  /** How the criterion was checked (deterministic check vs LLM judge). */
  method?: 'deterministic' | 'judge' | 'skipped';
  detail?: string;
}

/** Where a goal contract came from. Chat goals are session-pinned and subject
 *  to the daily idle reaper; workflow goals live and die with their run. */
export interface GoalOrigin {
  kind: 'chat' | 'workflow';
  runId?: string;
  stepId?: string;
}

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
  /**
   * Discriminator. Default (absent) === 'plan' — an ordinary drafted plan.
   * 'workflow_pending_inputs' is the ask-then-resume record: a workflow that
   * could not run because required inputs were missing. The user's next reply
   * supplies them and the run resumes (see plan-continuity). Carries the
   * workflow-specific fields below; its synthetic `plan` exists only so the
   * shared persistence + classifier machinery works unchanged.
   */
  kind?: 'plan' | 'workflow_pending_inputs';
  /** workflow_pending_inputs: the workflow to resume. */
  workflowName?: string;
  /** workflow_pending_inputs: required input names that were missing. */
  requiredInputs?: string[];
  /** workflow_pending_inputs: inputs accumulated so far across replies. */
  pendingInputValues?: Record<string, string>;
  // ── Goal-contract fields (present only once a proposal is ACTIVATED) ──
  /** Where the goal came from; absent ⇒ treated as chat-origin. */
  origin?: GoalOrigin;
  /** Validation attempts consumed so far. */
  attempt?: number;
  /** Attempt ceiling before the loop escalates instead of retrying. */
  maxAttempts?: number;
  /** Validation findings, per criterion, per attempt (append-only). */
  evidence?: GoalEvidence[];
  /** Compact harness-curated "done so far" lines re-injected each turn. */
  progressLedger?: string[];
  /** Bumped on every goal touch; drives the idle reaper TTL. */
  lastActivityAt?: string;
  /** Why the goal reached `satisfied` / `expired`. */
  doneReason?: string;
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

export function planNeedsUserInput(plan: Plan): boolean {
  return Array.isArray(plan.needsUserInput) && plan.needsUserInput.some((item) => item.trim().length > 0);
}

export function planProposalNeedsUserInput(proposal: PlanProposal): boolean {
  return planNeedsUserInput(proposal.approvedPlan ?? proposal.plan);
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateForNotification(value: string, max = 220): string {
  const compact = compactWhitespace(value);
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function sanitizeAppliedInstructionForNotification(value: string): string {
  let text = compactWhitespace(value)
    .replace(/\s*\((?:source|from):[^)]*\)\s*$/gi, '')
    .replace(/`[^`]*(?:SKILL\.md|workflows?)[^`]*`/gi, 'the saved workflow')
    .replace(/(?:^|\s)(?:~\/|\/)?[A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)+(?:SKILL\.md|\.md)?/g, ' the saved workflow');

  if (/proposal|audit|brief/i.test(value) && /workflow|SKILL\.md|workflows/i.test(value)) {
    text = 'Use the relevant saved proposal workflow for the research and briefing steps.';
  } else if (/outbound|Scorpion|law[- ]firm|SEO jargon|booking URL/i.test(value)) {
    text = 'Use the saved outbound-writing guidance: clear law-firm language, low jargon, and no raw booking URLs unless asked.';
  }

  return truncateForNotification(text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"), 180);
}

function renderPlanNotificationBody(proposal: PlanProposal): string {
  const steps = proposal.plan.steps
    .map((s) => `${s.n}. ${truncateForNotification(s.action, 180)}`)
    .join('\n');
  const appliedInstructions = (proposal.plan.appliedInstructions ?? [])
    .map(sanitizeAppliedInstructionForNotification)
    .filter((item, index, items) => item.length > 0 && items.indexOf(item) === index)
    .slice(0, 4);
  const contextBlock = appliedInstructions.length > 0
    ? `\n\nContext I will use:\n${appliedInstructions.map((item) => `- ${item}`).join('\n')}`
    : '';
  const questionsBlock = proposal.plan.needsUserInput.length > 0
    ? `\n\nI need this before I can start:\n${proposal.plan.needsUserInput.map((q) => `- ${truncateForNotification(q, 220)}`).join('\n')}`
    : '';
  const closing = proposal.plan.needsUserInput.length > 0
    ? '\n\nReply with the missing detail. I will not start until this is clear.'
    : '\n\nApprove when you want me to start, or reject if this is not the right plan.';

  return [
    'I made a plan before starting.',
    '',
    `Goal: ${truncateForNotification(proposal.plan.objective, 260)}`,
    '',
    `What I will do:\n${steps}`,
    contextBlock,
    questionsBlock,
    closing,
  ].filter(Boolean).join('\n');
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
  if (planNeedsUserInput(input.plan)) {
    throw new Error('plan has unresolved needsUserInput; ask the user for that input before surfacing the plan for approval');
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

  addNotification({
    id: `${Date.now()}-plan-proposal-${proposal.id}`,
    kind: 'approval',
    title: `Review before I start: ${truncateForNotification(proposal.plan.objective, 80)}`,
    body: renderPlanNotificationBody(proposal),
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

/**
 * Persist a Plan that still has open `needsUserInput` questions as a
 * pending PlanProposal — the "asking plan." This is the plan-continuity
 * path: unlike `surfacePlan` (which refuses unresolved questions because
 * those plans are not yet approvable), this records the asking plan so the
 * user's NEXT message can be classified against it and folded back in,
 * even across session rollover.
 *
 * It deliberately does NOT queue an approval notification — the plan is not
 * approvable yet, and the questions are surfaced to the user through the
 * caller's `awaiting_user_input` event. This only durably stores the plan.
 */
export function surfaceAskingPlan(input: SurfacePlanInput): PlanProposal {
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
  logger.info(
    { proposalId: proposal.id, openQuestions: proposal.plan.needsUserInput.length, channel: proposal.channel },
    'asking plan persisted (plan-continuity)',
  );
  return proposal;
}

export interface SurfaceWorkflowPendingInputsInput {
  workflowName: string;
  /** Required input names that were missing on the attempted run. */
  requiredInputs: string[];
  /** Inputs already supplied on the attempted run (carried forward). */
  providedInputs?: Record<string, string>;
  sessionId?: string;
  channel?: string;
  originatingRequest?: string;
}

/**
 * Persist a "workflow can't run — inputs missing" record so the user's NEXT
 * reply can supply the values and resume the run, instead of the model being
 * told to retry a call its schema can't vary (the 84× loop). Like
 * surfaceAskingPlan, this does NOT queue an approval notification — the short
 * ask is surfaced to the user through the tool's text result; this only
 * durably records what we're waiting on, keyed by session.
 */
export function surfaceWorkflowPendingInputs(input: SurfaceWorkflowPendingInputsInput): PlanProposal {
  const missing = input.requiredInputs.map((k) => k.trim()).filter((k) => k.length > 0);
  if (missing.length === 0) {
    throw new Error('surfaceWorkflowPendingInputs requires at least one missing input name');
  }
  const objective = `Run the "${input.workflowName}" workflow`;
  const plan: Plan = {
    objective,
    steps: [
      {
        n: 1,
        action: `Queue the "${input.workflowName}" workflow once its required input(s) are supplied: ${missing.join(', ')}.`,
        rationale: 'The workflow cannot run until every required input has a value.',
        verification: null,
      },
    ],
    successCriteria: [`The "${input.workflowName}" workflow is queued with all required inputs.`],
    risks: [],
    estimatedComplexity: 'trivial',
    recommendsTrackedExecution: false,
    needsUserInput: missing.slice(0, 5).map((key) => `What is the value for "${key}"?`),
    appliedInstructions: [],
  };
  const now = new Date().toISOString();
  const proposal: PlanProposal = {
    id: `wfask-${randomUUID().slice(0, 8)}`,
    proposedAt: now,
    proposedByAgent: 'clementine',
    status: 'pending',
    originatingRequest: input.originatingRequest?.trim() || objective,
    sessionId: input.sessionId,
    channel: input.channel,
    plan,
    kind: 'workflow_pending_inputs',
    workflowName: input.workflowName,
    requiredInputs: missing,
    pendingInputValues: { ...(input.providedInputs ?? {}) },
    version: 'v1',
  };
  writeProposal(proposal);
  logger.info(
    { proposalId: proposal.id, workflowName: input.workflowName, missing, sessionId: input.sessionId },
    'workflow pending-inputs ask surfaced',
  );
  return proposal;
}

/**
 * Merge newly-supplied input values into a pending workflow-inputs proposal.
 * Returns the updated record, or null if the proposal is gone / resolved.
 */
export function setWorkflowPendingInputValues(id: string, values: Record<string, string>): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal || proposal.status !== 'pending') return null;
  const updated: PlanProposal = {
    ...proposal,
    pendingInputValues: { ...(proposal.pendingInputValues ?? {}), ...values },
  };
  writeProposal(updated);
  return updated;
}

export function getPlanProposal(id: string): PlanProposal | null {
  return readProposal(id);
}

export interface ListPlanProposalsFilter {
  status?: PlanProposalStatus | 'all';
  sessionId?: string;
  /** Filter to proposals that originated on this channel (e.g. discord:<id>). */
  channel?: string;
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
      if (filter.channel && p.channel !== filter.channel) continue;
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
  /**
   * How long the plan-scope stays open after approval. Default 15 min.
   * Capped at 1 hour by the scope module. Pass 0 to skip opening a
   * scope entirely (every tool call still requires individual
   * approval).
   */
  scopeTtlMs?: number;
  /**
   * Which tools the plan-scope auto-approves. Defaults to shell + file
   * writes — the same surface that normally needs per-call approval.
   * Pass an empty array to skip opening a scope.
   */
  allowedTools?: string[];
}

export function approvePlanProposal(id: string, options: ApprovePlanProposalOptions = {}): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal) return null;
  if (proposal.status !== 'pending') return null;
  const approvedPlan = options.editedPlan ?? proposal.plan;
  if (planNeedsUserInput(approvedPlan)) return null;
  const resolved: PlanProposal = {
    ...proposal,
    status: 'approved',
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'user',
    approvedPlan,
  };
  writeProposal(resolved);

  // Open a plan-scope so the next batch of tool calls (run_shell_command,
  // write_file) doesn't have to interrupt for per-call approval. The
  // scope expires after the TTL even if the agent keeps running.
  let scopeOpened = false;
  let scopeExpiresAt: string | undefined;
  if (proposal.sessionId && options.allowedTools?.length !== 0) {
    const scope = openPlanScope({
      sessionId: proposal.sessionId,
      planProposalId: proposal.id,
      approvedPlanObjective: approvedPlan.objective,
      ttlMs: options.scopeTtlMs,
      allowedTools: options.allowedTools,
    });
    scopeOpened = true;
    scopeExpiresAt = scope.expiresAt;
  }

  addNotification({
    id: `${Date.now()}-plan-proposal-${proposal.id}-approved`,
    kind: 'system',
    title: `Plan approved: ${proposal.plan.objective.slice(0, 80)}`,
    body: [
      options.editedPlan ? 'Plan approved with edits.' : 'Plan approved.',
      scopeOpened
        ? `Auto-approval window open until ${scopeExpiresAt} for shell + file-write actions inside this plan. You can revoke from the dashboard.`
        : 'The agent will continue to ask before each shell or file-write action.',
    ].join(' '),
    createdAt: new Date().toISOString(),
    read: false,
    silent: true,
    metadata: { planProposalId: proposal.id, sessionId: proposal.sessionId, kind: 'plan_proposal' },
  });

  logger.info({ proposalId: proposal.id, edited: Boolean(options.editedPlan), scopeOpened }, 'plan proposal approved');

  // Goal-contract Phase 3: an approved CHAT plan becomes the session's parked
  // goal — the harness re-injects it each turn and validates completion
  // against its successCriteria externally. One chokepoint, all approval
  // surfaces. workflow_pending_inputs records are a resume mechanism, not a
  // goal; sessionless proposals have no conversation to pin to. Best-effort:
  // activation failure must never break the approval itself.
  if (proposal.sessionId && (proposal.kind ?? 'plan') === 'plan') {
    try {
      const activated = activateGoal(proposal.id, { origin: { kind: 'chat' } });
      if (activated) return activated;
    } catch (err) {
      logger.warn({ proposalId: proposal.id, err: err instanceof Error ? err.message : String(err) }, 'goal activation after approval failed');
    }
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Goal contracts (GOAL-CONTRACT-PLAN.md, Phase 1)
//
// The parked-goal substrate: an approved plan (or a /goal objective) becomes
// the session's ACTIVE goal contract. The harness re-injects it fresh every
// iteration (the model rents the goal, never owns it) and completion is
// validated externally against the PARKED successCriteria — the model saying
// "done" is a trigger to validate, never the verdict.
//
// This is the SAME store as plan proposals — statuses on one record, one
// lifecycle: proposed → active → satisfied | expired | superseded. It absorbs
// the legacy /goal GoalState (status vocabulary ported; the JSON-file store in
// state/goals/ is deleted in Phase 3) and replaces the Active Task delegation
// pin (Phase 3). Do not add a parallel mechanism.
// ─────────────────────────────────────────────────────────────────────────────

/** Idle TTL for chat-origin goals: no activity for this long → expired. */
const GOAL_IDLE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
/** Terminal goal records (satisfied/expired) older than this are purged. */
const GOAL_TERMINAL_PURGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Default validation-attempt ceiling before the loop escalates. */
export const GOAL_DEFAULT_MAX_ATTEMPTS = 3;

export interface ActivateGoalOptions {
  origin?: GoalOrigin;
  maxAttempts?: number;
}

/**
 * Transition an `approved` (or, for /goal-created contracts, `pending`)
 * proposal into the session's ACTIVE goal. Enforces ONE active goal per
 * session: any other active goal on the same session is marked superseded —
 * never silently stacked. Returns null when the proposal is missing or not
 * in an activatable state.
 */
export function activateGoal(id: string, options: ActivateGoalOptions = {}): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal) return null;
  if (proposal.status !== 'approved' && proposal.status !== 'pending') return null;
  if (planProposalNeedsUserInput(proposal)) return null;

  // One active goal per session — supersede the rest explicitly.
  if (proposal.sessionId) {
    for (const other of listPlanProposals({ status: 'active', sessionId: proposal.sessionId })) {
      if (other.id === id) continue;
      writeProposal({
        ...other,
        status: 'superseded',
        resolvedAt: new Date().toISOString(),
        resolvedBy: 'system',
        rejectionReason: `Superseded by goal ${id}`,
      });
      logger.info({ superseded: other.id, by: id, sessionId: proposal.sessionId }, 'active goal superseded by new goal');
    }
  }

  const now = new Date().toISOString();
  const active: PlanProposal = {
    ...proposal,
    status: 'active',
    origin: options.origin ?? proposal.origin ?? { kind: 'chat' },
    attempt: proposal.attempt ?? 0,
    maxAttempts: options.maxAttempts ?? proposal.maxAttempts ?? GOAL_DEFAULT_MAX_ATTEMPTS,
    evidence: proposal.evidence ?? [],
    progressLedger: proposal.progressLedger ?? [],
    lastActivityAt: now,
  };
  writeProposal(active);
  logger.info({ goalId: id, sessionId: proposal.sessionId, origin: active.origin?.kind }, 'goal contract activated');
  return active;
}

/** The session's current parked goal, if any. Newest wins if several exist
 *  (shouldn't happen — activateGoal supersedes — but be deterministic). */
export function getActiveGoalForSession(sessionId: string): PlanProposal | null {
  if (!sessionId) return null;
  const active = listPlanProposals({ status: 'active', sessionId, limit: 1 });
  return active[0] ?? null;
}

/**
 * /goal front door: create + activate a goal directly from a bare objective
 * (no plan-first round-trip). The synthetic plan carries the objective with
 * NO success criteria — validation falls back to judging the objective itself
 * via the audit-checklist judge, which is exactly the legacy /goal semantics.
 * Criteria-rich goals come from the plan-first approval path instead.
 */
export function createDirectGoal(input: {
  objective: string;
  sessionId: string;
  channel?: string;
  maxAttempts?: number;
}): PlanProposal | null {
  const objective = input.objective.trim();
  if (objective.length < 4 || !input.sessionId) return null;
  const now = new Date().toISOString();
  const proposal: PlanProposal = {
    id: `goal-${randomUUID().slice(0, 8)}`,
    proposedAt: now,
    proposedByAgent: 'clementine',
    status: 'pending',
    originatingRequest: objective,
    sessionId: input.sessionId,
    channel: input.channel,
    plan: {
      objective,
      steps: [{ n: 1, action: `Pursue the objective: ${objective}`, rationale: 'Direct /goal objective.', verification: null }],
      successCriteria: [],
      risks: [],
      estimatedComplexity: 'moderate',
      recommendsTrackedExecution: false,
      needsUserInput: [],
      appliedInstructions: [],
    },
    version: 'v1',
  };
  writeProposal(proposal);
  return activateGoal(proposal.id, { origin: { kind: 'chat' }, maxAttempts: input.maxAttempts });
}

/** Restart-resume seam: every active goal across all sessions. */
export function listActiveGoalContracts(): PlanProposal[] {
  return listPlanProposals({ status: 'all' }).filter((p) => p.status === 'active');
}

/**
 * Bump a goal's activity stamp and optionally append a progress-ledger line.
 * The ledger is the compact "done so far" digest the harness re-injects each
 * iteration instead of letting the transcript accumulate.
 */
export function touchGoalActivity(id: string, ledgerLine?: string): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal || proposal.status !== 'active') return null;
  const updated: PlanProposal = {
    ...proposal,
    lastActivityAt: new Date().toISOString(),
    ...(ledgerLine && ledgerLine.trim().length > 0
      ? { progressLedger: [...(proposal.progressLedger ?? []), ledgerLine.trim()].slice(-20) }
      : {}),
  };
  writeProposal(updated);
  return updated;
}

/**
 * Append a validation attempt's evidence and bump the attempt counter.
 * Returns the updated record; the caller decides continue / escalate from
 * `attempt >= maxAttempts`.
 */
export function recordGoalValidation(id: string, evidence: GoalEvidence[]): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal || proposal.status !== 'active') return null;
  const updated: PlanProposal = {
    ...proposal,
    attempt: (proposal.attempt ?? 0) + 1,
    evidence: [...(proposal.evidence ?? []), ...evidence].slice(-100),
    lastActivityAt: new Date().toISOString(),
  };
  writeProposal(updated);
  return updated;
}

/** External validation passed — the goal is done. */
export function satisfyGoal(id: string, reason?: string): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal || proposal.status !== 'active') return null;
  const resolved: PlanProposal = {
    ...proposal,
    status: 'satisfied',
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'system',
    doneReason: reason?.trim() || undefined,
  };
  writeProposal(resolved);
  logger.info({ goalId: id, sessionId: proposal.sessionId }, 'goal contract satisfied');
  return resolved;
}

/** Terminal stop without completion (idle TTL, budget exhaustion, user cancel). */
export function expireGoal(id: string, reason?: string): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal || proposal.status !== 'active') return null;
  const resolved: PlanProposal = {
    ...proposal,
    status: 'expired',
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'system',
    doneReason: reason?.trim() || undefined,
  };
  writeProposal(resolved);
  logger.info({ goalId: id, sessionId: proposal.sessionId, reason }, 'goal contract expired');
  return resolved;
}

export interface GoalReapStats {
  expired: number;
  purged: number;
  notified: number;
}

/**
 * Daily goal hygiene (wired to the nightly maintenance tick):
 *  - chat-origin ACTIVE goals idle past the 24h TTL → expired. A goal that
 *    was mid-flight (validation attempts or ledger progress) gets ONE inbox
 *    note so unfinished work never vanishes silently; an untouched goal
 *    sweeps silently.
 *  - workflow-origin goals are EXEMPT — they live and die with their run.
 *  - terminal goal records (satisfied/expired) older than 7 days are purged.
 *    Only goal-lifecycle statuses are touched; pending/approved/rejected/
 *    superseded proposals keep their existing behavior untouched.
 */
export function reapExpiredGoals(now: Date = new Date()): GoalReapStats {
  const stats: GoalReapStats = { expired: 0, purged: 0, notified: 0 };
  for (const p of listPlanProposals({ status: 'all' })) {
    if (p.status === 'active') {
      if ((p.origin?.kind ?? 'chat') === 'workflow') continue; // run-owned
      const last = Date.parse(p.lastActivityAt ?? p.proposedAt);
      if (!Number.isFinite(last) || now.getTime() - last < GOAL_IDLE_TTL_MS) continue;
      const wasMidFlight = (p.attempt ?? 0) > 0 || (p.progressLedger?.length ?? 0) > 0;
      expireGoal(p.id, 'idle past 24h TTL');
      stats.expired += 1;
      if (wasMidFlight) {
        addNotification({
          id: `${Date.now()}-goal-expired-${p.id}`,
          kind: 'system',
          title: `Goal expired incomplete: ${truncateForNotification(p.plan.objective, 80)}`,
          body: `This goal went idle for over a day and was set aside with work still in progress. Say "continue" in that conversation to revive it, or let it go.`,
          createdAt: now.toISOString(),
          read: false,
          metadata: { planProposalId: p.id, sessionId: p.sessionId, kind: 'goal_expired' },
        });
        stats.notified += 1;
      }
    } else if (p.status === 'satisfied' || p.status === 'expired') {
      const resolved = Date.parse(p.resolvedAt ?? p.proposedAt);
      if (Number.isFinite(resolved) && now.getTime() - resolved > GOAL_TERMINAL_PURGE_MS) {
        deletePlanProposal(p.id);
        stats.purged += 1;
      }
    }
  }
  if (stats.expired > 0 || stats.purged > 0) {
    logger.info({ stats }, 'goal reaper pass completed');
  }
  return stats;
}
