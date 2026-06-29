import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { BASE_DIR, getRuntimeEnv } from '../config.js';
import { addNotification } from '../runtime/notifications.js';
import type { Plan } from './planner.js';
import { openPlanScope, closePlanScope, getPlanScope } from './plan-scope.js';

/** Kill-switch for goal-scoped autonomy (B1). Off ⇒ autonomous approval falls
 *  back to today's time-boxed plan scope. */
function goalScopeEnabled(): boolean {
  if ((getRuntimeEnv('CLEMMY_GOAL_CONTRACT', 'on') ?? 'on').toLowerCase() === 'off') return false;
  return (getRuntimeEnv('CLEMMY_GOAL_SCOPE', 'on') ?? 'on').toLowerCase() !== 'off';
}

/** Kill-switch for goal-BOUNDED send autonomy (2026-06-17): when an approved
 *  plan ENUMERATED its irreversible sends (Plan.externalSends), approval opens a
 *  goal-scoped scope that auto-approves ONLY those send shapes — off-shape sends
 *  still pause. Distinct from the explicit `autonomous` opt-in: it does NOT
 *  self-drive the goal, it just lets the sends the user blessed on the surfaced
 *  plan run hands-off. Off ⇒ a plan's enumerated sends pre-bless nothing. */
function goalSendAutonomyEnabled(): boolean {
  if (!goalScopeEnabled()) return false;
  return (getRuntimeEnv('CLEMMY_GOAL_SEND_AUTONOMY', 'on') ?? 'on').toLowerCase() !== 'off';
}

/** The unique send slugs / tool-names a plan enumerated in `externalSends`,
 *  deduped — exactly what the user blesses by approving the surfaced plan.
 *  Empty when the plan declares no external sends (read-only / local-only). */
export function deriveEnumeratedSends(plan: Plan): string[] {
  const sends = (plan as { externalSends?: Array<{ slug?: unknown }> | null }).externalSends;
  if (!Array.isArray(sends)) return [];
  const slugs = new Set<string>();
  for (const s of sends) {
    const slug = (s as { slug?: unknown })?.slug;
    if (typeof slug === 'string' && slug.trim()) slugs.add(slug.trim());
  }
  return [...slugs];
}

/** Close the goal-scoped plan scope tied to a goal that just resolved. Only
 *  closes a scope that IS goal-scoped FOR THIS goal — an unrelated time-boxed
 *  scope on the session is left alone. The scope's lifetime is derived from the
 *  goal, so its terminal transition is the only thing that closes it.
 *  Best-effort. */
function closeGoalScopeFor(goal: PlanProposal): void {
  if (!goal.sessionId) return;
  try {
    const scope = getPlanScope(goal.sessionId);
    if (scope?.goalScoped?.goalId === goal.id) {
      closePlanScope(goal.sessionId, `goal ${goal.status}`);
    }
  } catch { /* best-effort */ }
}

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
  /** Which stage this finding belongs to (absent on unstaged goals). */
  stageId?: string;
}

/**
 * An ordered milestone within a goal. Stages group the goal's existing
 * successCriteria (verbatim — the user blessed exactly that text) so a long
 * goal validates and checks in one milestone at a time instead of all-or-
 * nothing at the end. A goal with no `stages` validates against the full
 * criteria exactly as before — staging is purely additive.
 */
export interface GoalStage {
  id: string;
  title: string;
  /** Subset of the plan's successCriteria, verbatim. */
  criteria: string[];
  status: 'pending' | 'done';
  /** Set when the stage's criteria validated. */
  completedAt?: string;
  /** Single-fire latch: the stage-completion check-in has been surfaced. */
  checkinAt?: string;
}

/** Where a goal contract came from. Chat goals are session-pinned and subject
 *  to the daily idle reaper; workflow AND background goals live and die with
 *  their run (their lifetime is the task's wall-clock, not chat idleness), so
 *  both are exempt from the idle reaper. */
export interface GoalOrigin {
  kind: 'chat' | 'workflow' | 'background';
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
  /**
   * Hold-for-later marker. A pending proposal the user asked Clem to KEEP (not
   * run now, not a review-approval) — "hold it and bring it back when I ask."
   * It stays pending, surfaces in the session's Current Focus as a held task,
   * and the user resumes it by reference ("pick up the Salesforce scrape") →
   * dispatched goal-bound to the background. Distinguishes a held task from an
   * approval-pending plan so the two don't get confused.
   */
  heldForLater?: boolean;
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
  /** Ordered milestones grouping successCriteria; absent ⇒ unstaged goal. */
  stages?: GoalStage[];
  /** Bumped on every goal touch; drives the idle reaper TTL. */
  lastActivityAt?: string;
  /** Why the goal reached `satisfied` / `expired`. */
  doneReason?: string;
  // ── Self-driving fields (A2): the daemon re-enters the goal on a cadence ──
  /** When true, the daemon resumes this goal itself (no human prompt needed). */
  selfDriving?: boolean;
  /** Heartbeat cadence: resume at most once per this many ms. */
  resumeEveryMs?: number;
  /** Due-timestamp for the next self-resume (wall-clock compare ⇒ sleep-safe). */
  nextResumeAt?: string;
  /** Self-resumes fired so far. */
  resumeCount?: number;
  /** Resume ceiling before the goal parks for review. */
  maxResumes?: number;
  /** Consecutive zero-progress resumes — the anti-spin breaker counter. */
  noProgressStreak?: number;
  /** Hard stop: a goal past this is parked regardless of progress. */
  deadlineAt?: string;
  /** Progress fingerprint captured at the last resume; the breaker compares it. */
  lastResumeSnapshot?: { ledger: number; evidence: number; stagesDone: number };
  /** Set when the goal is parked: resumption stops until a human unparks it. */
  parked?: { at: string; reason: 'no_progress' | 'approval_timeout' | 'blocker'; note?: string };
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
    : '\n\nReview it, edit it, or approve me to proceed.';

  return [
    'I drafted this for review before I start.',
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
    stages: null,
    risks: [],
    estimatedComplexity: 'trivial',
    recommendsTrackedExecution: false,
    needsUserInput: missing.slice(0, 5).map((key) => `What is the value for "${key}"?`),
    appliedInstructions: [],
    externalSends: null,
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
  /**
   * Goal-scoped autonomy (B1): open a GOAL-LIFETIME scope (no TTL, closed by
   * the goal's terminal transition) and flag the goal self-driving, so the
   * goal runs unattended. Send-kind tools still gate unless enumerated in
   * `allowedSends`; the 5 safety gates never bypass.
   */
  autonomous?: boolean;
  /** Sends the plan enumerated + the user blessed (autonomous only). */
  allowedSends?: string[];
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
  //
  // Autonomous approval opens a GOAL-SCOPED scope instead (no TTL, lifetime =
  // the goal) AFTER activation below — so here we skip the time-boxed open for
  // the autonomous path. Falls back to the time-boxed scope when the goal-scope
  // kill-switch is off.
  const autonomous = Boolean(options.autonomous) && goalScopeEnabled();
  // Goal-BOUNDED send autonomy: a plan that ENUMERATED its sends (and the user
  // approved that surfaced list) pre-blesses exactly those send shapes. Opens a
  // goal-scoped scope below (after activation) WITHOUT self-driving the goal;
  // off-shape sends still pause. Explicit `autonomous` takes precedence (it adds
  // self-drive). Caller-supplied allowedSends (the dashboard's "edit + bless")
  // win; otherwise we derive from the plan the user saw.
  const enumeratedSends = (options.allowedSends && options.allowedSends.length > 0)
    ? options.allowedSends
    : deriveEnumeratedSends(approvedPlan);
  const sendBounded = !autonomous
    && !!proposal.sessionId
    && enumeratedSends.length > 0
    && goalSendAutonomyEnabled();
  let scopeOpened = false;
  let scopeExpiresAt: string | undefined;
  if (!autonomous && !sendBounded && proposal.sessionId && options.allowedTools?.length !== 0) {
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
      if (activated) {
        if (autonomous) {
          // Goal-lifetime auto-approval scope + self-driving. The scope is keyed
          // to the goal and closed by satisfy/expire/supersede — no timer.
          try {
            openPlanScope({
              sessionId: proposal.sessionId,
              planProposalId: proposal.id,
              approvedPlanObjective: approvedPlan.objective,
              allowedTools: options.allowedTools,
              goalScoped: { goalId: proposal.id },
              allowedSends: options.allowedSends,
            });
            // enableGoalSelfDrive rewrites the record — return ITS result so the
            // caller sees selfDriving:true (not the pre-self-drive snapshot).
            const driving = enableGoalSelfDrive(proposal.id);
            if (driving) return driving;
          } catch (err) {
            logger.warn({ proposalId: proposal.id, err: err instanceof Error ? err.message : String(err) }, 'autonomous scope/self-drive setup failed');
          }
        } else if (sendBounded) {
          // Goal-bounded send autonomy: open a goal-scoped scope that auto-runs
          // ONLY the sends the user blessed on the surfaced plan. No self-drive —
          // the goal is parked + judged, but it does not run unattended. Off-shape
          // sends (a slug not in this list) still pause. Lifetime = the goal.
          try {
            openPlanScope({
              sessionId: proposal.sessionId,
              planProposalId: proposal.id,
              approvedPlanObjective: approvedPlan.objective,
              allowedTools: options.allowedTools,
              goalScoped: { goalId: proposal.id },
              allowedSends: enumeratedSends,
            });
            logger.info(
              { proposalId: proposal.id, sends: enumeratedSends.length },
              'goal-bounded send autonomy: opened goal-scoped scope for enumerated sends (no self-drive)',
            );
          } catch (err) {
            logger.warn({ proposalId: proposal.id, err: err instanceof Error ? err.message : String(err) }, 'goal-bounded send scope setup failed');
          }
        }
        return activated;
      }
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
/** Default self-resume cadence: a goal heartbeats at most once per 30 min. */
export const GOAL_DEFAULT_RESUME_EVERY_MS = 30 * 60 * 1000;
/** Default self-resume ceiling before the goal parks for human review. */
export const GOAL_DEFAULT_MAX_RESUMES = 12;
/** Consecutive zero-progress resumes that trip the anti-spin breaker. */
export const GOAL_NO_PROGRESS_LIMIT = 2;

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
      const supersededGoal: PlanProposal = {
        ...other,
        status: 'superseded',
        resolvedAt: new Date().toISOString(),
        resolvedBy: 'system',
        rejectionReason: `Superseded by goal ${id}`,
      };
      writeProposal(supersededGoal);
      closeGoalScopeFor(supersededGoal);
      logger.info({ superseded: other.id, by: id, sessionId: proposal.sessionId }, 'active goal superseded by new goal');
    }
  }

  const now = new Date().toISOString();
  const stages = materializeStages(proposal.approvedPlan ?? proposal.plan);
  const active: PlanProposal = {
    ...proposal,
    status: 'active',
    origin: options.origin ?? proposal.origin ?? { kind: 'chat' },
    attempt: proposal.attempt ?? 0,
    maxAttempts: options.maxAttempts ?? proposal.maxAttempts ?? GOAL_DEFAULT_MAX_ATTEMPTS,
    evidence: proposal.evidence ?? [],
    progressLedger: proposal.progressLedger ?? [],
    ...(stages ? { stages } : {}),
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
      stages: null,
      risks: [],
      estimatedComplexity: 'moderate',
      recommendsTrackedExecution: false,
      needsUserInput: [],
      appliedInstructions: [],
      externalSends: null,
    },
    version: 'v1',
  };
  writeProposal(proposal);
  return activateGoal(proposal.id, { origin: { kind: 'chat' }, maxAttempts: input.maxAttempts });
}

export interface CreateGoalContractInput {
  objective: string;
  successCriteria?: string[];
  nextActions?: string[];
  risks?: string[];
  stages?: Array<{ title: string; criteria: string[] }> | null;
  sessionId?: string;
  channel?: string;
  originatingRequest?: string;
  maxAttempts?: number;
  selfDriving?: boolean;
  resumeEveryMs?: number;
  maxResumes?: number;
  deadlineAt?: string;
  /** Goal provenance. Defaults to chat (session-pinned, idle-reaped). Pass a
   *  run-owned origin (workflow/background) to exempt it from the idle reaper. */
  origin?: GoalOrigin;
}

/**
 * Console/API front door for a durable goal contract. This uses the same
 * plan-proposal store and activation path as chat-approved plans, but it does
 * not need an intermediate pending approval because the user is explicitly
 * creating the goal from the Goals surface.
 */
export function createGoalContract(input: CreateGoalContractInput): PlanProposal | null {
  const objective = input.objective.trim();
  if (objective.length < 4) return null;
  const criteria = (input.successCriteria ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 8);
  const nextActions = (input.nextActions ?? []).map((a) => a.trim()).filter(Boolean).slice(0, 12);
  const risks = (input.risks ?? []).map((r) => r.trim()).filter(Boolean).slice(0, 8);
  const stages = Array.isArray(input.stages)
    ? input.stages
        .map((stage) => ({
          title: stage.title.trim(),
          criteria: stage.criteria.map((c) => c.trim()).filter((c) => criteria.includes(c)),
        }))
        .filter((stage) => stage.title.length > 0 && stage.criteria.length > 0)
        .slice(0, 6)
    : null;
  const now = new Date().toISOString();
  const sessionId = input.sessionId?.trim() || `goal:${randomUUID().slice(0, 8)}`;
  const proposal: PlanProposal = {
    id: `goal-${randomUUID().slice(0, 8)}`,
    proposedAt: now,
    proposedByAgent: 'user',
    status: 'pending',
    originatingRequest: input.originatingRequest?.trim() || objective,
    sessionId,
    channel: input.channel?.trim() || 'console',
    plan: {
      objective,
      steps: (nextActions.length > 0 ? nextActions : [`Pursue the objective: ${objective}`]).map((action, i) => ({
        n: i + 1,
        action,
        rationale: i === 0 ? 'Next concrete action toward the goal.' : 'Follow-on action toward the goal.',
        verification: null,
      })),
      successCriteria: criteria,
      stages,
      risks,
      estimatedComplexity: nextActions.length > 3 || criteria.length > 3 ? 'significant' : 'moderate',
      recommendsTrackedExecution: true,
      needsUserInput: [],
      appliedInstructions: [],
      externalSends: null,
    },
    version: 'v1',
  };
  writeProposal(proposal);
  const active = activateGoal(proposal.id, { origin: input.origin ?? { kind: 'chat' }, maxAttempts: input.maxAttempts });
  if (!active) return null;
  if (input.selfDriving) {
    return enableGoalSelfDrive(active.id, {
      resumeEveryMs: input.resumeEveryMs,
      maxResumes: input.maxResumes,
      deadlineAt: input.deadlineAt,
    }) ?? active;
  }
  return active;
}

/** Kill-switch (default ON) for binding a goal contract to a backgrounded
 *  task's run-session. When on, a task pushed to the background runs against a
 *  DURABLE goal — it keeps working until the success criteria validate (not one
 *  pass), tracks progress, and reports back against them. `=off` reverts to a
 *  one-shot prompt run (the legacy behavior). */
export function backgroundGoalContractEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_BG_GOAL_CONTRACT', 'on') ?? 'on').toLowerCase() !== 'off';
}

/**
 * Bind a durable goal contract to a background task's RUN session, so the
 * unattended run is goal-driven (the goal re-injects each turn, completion is
 * VALIDATED against the criteria, and a not-yet-met run re-attempts up to the
 * goal cap) instead of executing a prompt once — the "have the goal defined
 * before pushing to the background" guarantee. The goal is created on
 * `runSessionId` (unique per task), so it never collides with the originating
 * chat's own goal. Shared by BOTH background entry paths (the conversational
 * dispatch_background_task tool AND the plan-first approve→queue path) so the
 * guarantee is a property of backgrounding, not of which path queued it.
 * Best-effort: a binding failure never blocks the task — it just falls back to
 * the prompt-only run. Returns the activated goal, or null when disabled/invalid.
 */
export function bindBackgroundRunGoal(
  runSessionId: string,
  input: { objective: string; successCriteria?: string[]; nextActions?: string[]; originatingRequest?: string; channel?: string },
): PlanProposal | null {
  if (!backgroundGoalContractEnabled()) return null;
  if (!runSessionId || (input.objective ?? '').trim().length < 4) return null;
  try {
    return createGoalContract({
      objective: input.objective,
      successCriteria: input.successCriteria,
      nextActions: input.nextActions,
      originatingRequest: input.originatingRequest ?? input.objective,
      sessionId: runSessionId,
      channel: input.channel ?? 'background',
      // Run-owned: the goal's lifetime is the task's wall-clock, so exempt it
      // from the daily chat-idle reaper (same treatment as workflow goals).
      origin: { kind: 'background' },
    });
  } catch {
    return null;
  }
}

export interface HoldTaskInput {
  objective: string;
  /** Agreed steps/approach (markdown bullets or discrete lines). */
  steps?: string[];
  successCriteria?: string[];
  sessionId: string;
  channel?: string;
  originatingRequest?: string;
}

/**
 * Hold an AGREED task for later instead of running it now — the "or you can ask
 * me later and I'll bring it back up" path. Persists the agreed objective + steps
 * + criteria as a PENDING, held-for-later plan bound to the session. It does NOT
 * run and does NOT enter the approval queue; the user resumes it by reference
 * (see resumeHeldTask), at which point it dispatches goal-bound to the background.
 * Returns the held proposal, or null on invalid input.
 */
export function holdTaskForLater(input: HoldTaskInput): PlanProposal | null {
  const objective = (input.objective ?? '').trim();
  if (objective.length < 4 || !input.sessionId) return null;
  const criteria = (input.successCriteria ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 8);
  const steps = (input.steps ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 12);
  const now = new Date().toISOString();
  const proposal: PlanProposal = {
    id: `held-${randomUUID().slice(0, 8)}`,
    proposedAt: now,
    proposedByAgent: 'clementine',
    status: 'pending',
    heldForLater: true,
    originatingRequest: input.originatingRequest?.trim() || objective,
    sessionId: input.sessionId,
    channel: input.channel,
    plan: {
      objective,
      steps: (steps.length > 0 ? steps : [`Pursue the objective: ${objective}`]).map((action, i) => ({
        n: i + 1,
        action,
        rationale: i === 0 ? 'Agreed first step (held for later).' : 'Agreed follow-on step (held for later).',
        verification: null,
      })),
      successCriteria: criteria,
      stages: null,
      risks: [],
      estimatedComplexity: steps.length > 3 || criteria.length > 3 ? 'significant' : 'moderate',
      recommendsTrackedExecution: true,
      needsUserInput: [],
      appliedInstructions: [],
      externalSends: null,
    },
    version: 'v1',
  };
  writeProposal(proposal);
  return proposal;
}

/** The session's held-for-later tasks (pending + heldForLater), newest first. */
export function listHeldTasks(sessionId: string): PlanProposal[] {
  if (!sessionId) return [];
  return listPlanProposals({ status: 'pending', sessionId }).filter((p) => p.heldForLater === true);
}

/** Look up one held task by id (must still be pending + held). */
export function getHeldTask(id: string): PlanProposal | null {
  const p = readProposal(id);
  return p && p.heldForLater === true && p.status === 'pending' ? p : null;
}

/** Synthetic session key for a workflow's run-level goal contract — one
 *  active goal per workflow, shared across re-pursuit runs. */
export function workflowGoalSessionId(workflowName: string): string {
  return `workflow-goal:${workflowName}`;
}

/**
 * Workflow run-goal front door: find-or-create the ACTIVE goal contract for a
 * workflow's pinned run goal. Re-pursuit runs of the same workflow reuse the
 * existing active contract (evidence + attempt lineage accumulate across
 * runs); a fresh fire after the prior contract resolved creates a new one.
 * Workflow-origin goals are exempt from the daily idle reaper — they live and
 * die with their runs (satisfied on pass, expired on exhaustion).
 */
export function ensureWorkflowRunGoal(input: {
  workflowName: string;
  runId: string;
  objective: string;
  successCriteria?: string[];
  maxAttempts?: number;
}): PlanProposal | null {
  const objective = input.objective.trim();
  if (objective.length < 4 || !input.workflowName) return null;
  const sessionId = workflowGoalSessionId(input.workflowName);
  const existing = getActiveGoalForSession(sessionId);
  if (existing) {
    // Same objective → same contract (re-pursuit lineage accumulates).
    // CHANGED objective (the workflow's goal: block was edited between
    // fires) → the old contract is stale; supersede it so its evidence
    // doesn't pollute the new goal's lineage. activateGoal below enforces
    // one-active-per-session, which performs the supersede.
    const existingObjective = (existing.approvedPlan ?? existing.plan).objective?.trim();
    if (existingObjective === objective) return existing;
  }
  const now = new Date().toISOString();
  const criteria = (input.successCriteria ?? []).map((c) => c.trim()).filter(Boolean);
  const proposal: PlanProposal = {
    id: `goal-${randomUUID().slice(0, 8)}`,
    proposedAt: now,
    proposedByAgent: 'clementine',
    status: 'pending',
    originatingRequest: `Workflow "${input.workflowName}" pinned run goal: ${objective}`,
    sessionId,
    channel: 'workflow',
    plan: {
      objective,
      steps: [{ n: 1, action: `Run workflow "${input.workflowName}" until the goal is met.`, rationale: 'Pinned workflow run goal.', verification: null }],
      successCriteria: criteria,
      stages: null,
      risks: [],
      estimatedComplexity: 'moderate',
      recommendsTrackedExecution: false,
      needsUserInput: [],
      appliedInstructions: [],
      externalSends: null,
    },
    version: 'v1',
  };
  writeProposal(proposal);
  return activateGoal(proposal.id, {
    origin: { kind: 'workflow', runId: input.runId },
    maxAttempts: input.maxAttempts,
  });
}

/**
 * Render the origin session's parked goal for DELEGATED work (sub-agents,
 * background tasks) — the replacement for the deleted Active Task pin.
 * Origin-keyed only; returns undefined when the session has no active goal,
 * so delegated prompts stay byte-identical for goal-less sessions.
 */
export function getGoalPinForDelegation(originSessionId: string): string | undefined {
  if (!originSessionId) return undefined;
  const goal = getActiveGoalForSession(originSessionId);
  if (!goal) return undefined;
  const plan = goal.approvedPlan ?? goal.plan;
  const criteria = (plan.successCriteria ?? []).map((c) => c.trim()).filter(Boolean);
  return [
    `Pinned goal (origin conversation): ${plan.objective}`,
    criteria.length > 0 ? `Success criteria:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
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
 * Session-keyed convenience over {@link touchGoalActivity}: append one ledger
 * line to whatever goal is active on `sessionId` (no-op if none). The async
 * lanes — workflow runs, background tasks — deliver their outcome back to the
 * origin session, and this turns that outcome into goal evidence with a single
 * call site (see deliverOutcome). Returns the updated record, or null when the
 * session has no active goal.
 */
export function appendGoalLedgerForSession(sessionId: string, ledgerLine: string): PlanProposal | null {
  if (!sessionId || !ledgerLine || !ledgerLine.trim()) return null;
  const goal = getActiveGoalForSession(sessionId);
  if (!goal) return null;
  return touchGoalActivity(goal.id, ledgerLine);
}

/**
 * Turn a plan's optional authored `stages` into runtime GoalStage records
 * (stable ids + pending status). Returns undefined when the plan has no usable
 * stages — the goal then runs unstaged (today's behavior). Defensive: drops
 * empty stages and never throws on a malformed plan.
 */
function materializeStages(plan: Plan): GoalStage[] | undefined {
  const authored = (plan as { stages?: unknown }).stages;
  if (!Array.isArray(authored) || authored.length === 0) return undefined;
  const stages: GoalStage[] = [];
  for (let i = 0; i < authored.length; i++) {
    const raw = authored[i] as { title?: unknown; criteria?: unknown };
    const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
    const criteria = Array.isArray(raw?.criteria)
      ? raw.criteria.map((c) => String(c).trim()).filter(Boolean)
      : [];
    if (!title || criteria.length === 0) continue;
    stages.push({ id: `s${i + 1}`, title, criteria, status: 'pending' });
  }
  return stages.length > 0 ? stages : undefined;
}

/** The goal's current (first pending) stage, or null if unstaged / all done. */
export function getCurrentGoalStage(goal: PlanProposal): GoalStage | null {
  return goal.stages?.find((s) => s.status === 'pending') ?? null;
}

/**
 * Mark a stage complete: status→done + completedAt + checkinAt latch, and reset
 * the validation attempt budget so the NEXT stage starts fresh. Returns the
 * updated record ONLY on the pending→done transition (null if the stage is
 * missing or already done) — so the caller can treat a non-null return as the
 * single-fire signal to surface the stage check-in. Never advances a
 * non-active goal.
 */
export function advanceGoalStage(goalId: string, stageId: string): PlanProposal | null {
  const proposal = readProposal(goalId);
  if (!proposal || proposal.status !== 'active' || !proposal.stages) return null;
  const stage = proposal.stages.find((s) => s.id === stageId);
  if (!stage || stage.status === 'done') return null; // not found / already latched
  const now = new Date().toISOString();
  const updated: PlanProposal = {
    ...proposal,
    stages: proposal.stages.map((s) =>
      s.id === stageId ? { ...s, status: 'done' as const, completedAt: now, checkinAt: now } : s,
    ),
    attempt: 0,
    lastActivityAt: now,
  };
  writeProposal(updated);
  logger.info({ goalId, stageId, title: stage.title }, 'goal stage advanced');
  return updated;
}

export interface EnableSelfDriveOptions {
  resumeEveryMs?: number;
  maxResumes?: number;
  deadlineAt?: string;
}

/**
 * Flag an active goal as self-driving: the daemon will re-enter it on a
 * cadence (see goal-resume.ts) until it satisfies, parks, or exhausts its
 * resume budget. First resume is one interval out (the goal already ran once
 * interactively). No-op on a non-active goal.
 */
export function enableGoalSelfDrive(id: string, options: EnableSelfDriveOptions = {}): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal || proposal.status !== 'active') return null;
  const resumeEveryMs = options.resumeEveryMs ?? GOAL_DEFAULT_RESUME_EVERY_MS;
  const updated: PlanProposal = {
    ...proposal,
    selfDriving: true,
    resumeEveryMs,
    maxResumes: options.maxResumes ?? GOAL_DEFAULT_MAX_RESUMES,
    resumeCount: proposal.resumeCount ?? 0,
    noProgressStreak: 0,
    nextResumeAt: new Date(Date.now() + resumeEveryMs).toISOString(),
    deadlineAt: options.deadlineAt ?? proposal.deadlineAt,
    parked: undefined,
  };
  writeProposal(updated);
  logger.info({ goalId: id, resumeEveryMs, maxResumes: updated.maxResumes }, 'goal self-drive enabled');
  return updated;
}

export function disableGoalSelfDrive(id: string): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal || proposal.status !== 'active') return null;
  const updated: PlanProposal = {
    ...proposal,
    selfDriving: false,
    nextResumeAt: undefined,
    resumeEveryMs: undefined,
    lastActivityAt: new Date().toISOString(),
  };
  writeProposal(updated);
  logger.info({ goalId: id }, 'goal self-drive disabled');
  return updated;
}

/**
 * Record that a self-resume is being scheduled+fired: bump resumeCount, set the
 * next due-timestamp, snapshot progress for the breaker, and carry the streak.
 * Called BEFORE the resume turn fires so a crash costs one slot, never a double
 * fire. No-op on a non-active goal.
 */
export function recordGoalResumeScheduled(
  id: string,
  next: { nextResumeAt: string; snapshot: { ledger: number; evidence: number; stagesDone: number }; noProgressStreak: number },
): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal || proposal.status !== 'active') return null;
  const updated: PlanProposal = {
    ...proposal,
    resumeCount: (proposal.resumeCount ?? 0) + 1,
    nextResumeAt: next.nextResumeAt,
    lastResumeSnapshot: next.snapshot,
    noProgressStreak: next.noProgressStreak,
    lastActivityAt: new Date().toISOString(),
  };
  writeProposal(updated);
  return updated;
}

/** Park a goal: self-resumption stops until a human unparks it. Idempotent. */
export function parkGoal(
  id: string,
  reason: 'no_progress' | 'approval_timeout' | 'blocker',
  note?: string,
): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal || proposal.status !== 'active') return null;
  if (proposal.parked) return proposal; // already parked — single-fire
  const updated: PlanProposal = {
    ...proposal,
    parked: { at: new Date().toISOString(), reason, note: note?.trim() || undefined },
  };
  writeProposal(updated);
  logger.info({ goalId: id, reason }, 'goal parked');
  return updated;
}

/** Clear a goal's parked state + reset the no-progress streak, and (if
 *  self-driving) re-arm the next resume. The /goal resume + user-reply path. */
export function unparkGoal(id: string): PlanProposal | null {
  const proposal = readProposal(id);
  if (!proposal || proposal.status !== 'active') return null;
  const resumeEveryMs = proposal.resumeEveryMs ?? GOAL_DEFAULT_RESUME_EVERY_MS;
  const updated: PlanProposal = {
    ...proposal,
    parked: undefined,
    noProgressStreak: 0,
    lastActivityAt: new Date().toISOString(),
    ...(proposal.selfDriving ? { nextResumeAt: new Date(Date.now() + resumeEveryMs).toISOString() } : {}),
  };
  writeProposal(updated);
  logger.info({ goalId: id }, 'goal unparked');
  return updated;
}

/** Pure progress fingerprint the breaker compares across resumes. */
export function goalProgressSnapshot(goal: PlanProposal): { ledger: number; evidence: number; stagesDone: number } {
  return {
    ledger: goal.progressLedger?.length ?? 0,
    evidence: goal.evidence?.length ?? 0,
    stagesDone: goal.stages?.filter((s) => s.status === 'done').length ?? 0,
  };
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
  closeGoalScopeFor(resolved);
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
  closeGoalScopeFor(resolved);
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
      const originKind = p.origin?.kind ?? 'chat';
      if (originKind === 'workflow' || originKind === 'background') continue; // run-owned: lifetime is the task wall-clock, not chat idleness
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
