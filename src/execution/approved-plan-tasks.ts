import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { addNotification } from '../runtime/notifications.js';
import { finishRun, getRun, startRun, type RunRecord } from '../runtime/run-events.js';
import { withFileLockSyncStrict } from '../runtime/atomic-json.js';
import { loadProactivityPolicy } from '../agents/proactivity-policy.js';
import {
  activateGoal,
  approvePlanProposalForBackgroundTask,
  bindBackgroundRunGoal,
  completePlanBackgroundAdmission,
  getPlanProposal,
  listPlanProposals,
  planProposalNeedsUserInput,
  type ApprovePlanProposalOptions,
  type PlanProposal,
} from '../agents/plan-proposals.js';
import type { Plan } from '../agents/planner.js';
import {
  createBackgroundTask,
  getBackgroundTask,
  type BackgroundTaskRecord,
} from './background-tasks.js';

export interface ApprovedPlanTaskResult {
  proposal: PlanProposal;
  task: BackgroundTaskRecord;
  run: RunRecord | undefined;
}

export interface ApprovedPlanAdmissionReconcileResult {
  scanned: number;
  materialized: number;
  completed: number;
  skipped: number;
  failed: number;
}

const ADMISSION_LOCK_DIR = path.join(BASE_DIR, 'state', 'plan-proposals');

function admissionLockTarget(proposalId: string): string {
  return path.join(ADMISSION_LOCK_DIR, `${encodeURIComponent(proposalId)}.background-admission`);
}

/** Stable, opaque worker reservation for one surfaced proposal. */
export function approvedPlanBackgroundTaskId(proposalId: string): string {
  const digest = createHash('sha256')
    .update(`clementine-approved-plan-background-task:v1\0${proposalId}`)
    .digest('hex')
    .slice(0, 24);
  return `bg-plan-${digest}`;
}

function discordChannelIdFromChannel(channel?: string): string | undefined {
  if (!channel?.startsWith('discord:')) return undefined;
  const parts = channel.split(':');
  return parts.length >= 3 ? parts[parts.length - 1] : undefined;
}

function renderApprovedPlanPrompt(proposal: PlanProposal, plan: Plan): string {
  const steps = plan.steps
    .map((step) => [
      `${step.n}. ${step.action}`,
      `   Rationale: ${step.rationale}`,
      step.verification ? `   Verification: ${step.verification}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n');

  return [
    `Approved plan proposal: ${proposal.id}`,
    '',
    'Run this approved plan as a durable background task. Work through the steps in order, use tools when useful, and continue until the objective is complete, blocked, or requires another approval.',
    'Stay within the approved objective. If the work materially changes scope, stop and ask for a new approval.',
    'Treat the approved plan as the user accepting its stated assumptions and safe defaults. Do not re-ask questions already surfaced in the approved plan; choose the safest stated option. Ask again only when required data is absent and there is no safe no-send/no-mutation default.',
    '',
    `Original user request:\n${proposal.originatingRequest}`,
    '',
    `Objective:\n${plan.objective}`,
    '',
    `Steps:\n${steps}`,
    '',
    `Success criteria:\n${plan.successCriteria.map((item) => `- ${item}`).join('\n')}`,
    plan.risks.length > 0 ? `\nRisks:\n${plan.risks.map((item) => `- ${item}`).join('\n')}` : '',
    plan.needsUserInput.length > 0
      ? `\nKnown user-input needs:\n${plan.needsUserInput.map((item) => `- ${item}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');
}

function proposalCanMaterialize(proposal: PlanProposal, taskId: string): boolean {
  return (proposal.kind ?? 'plan') === 'plan'
    && (proposal.status === 'approved' || proposal.status === 'active')
    && proposal.backgroundAdmission?.version === 1
    && proposal.backgroundAdmission.taskId === taskId
    && taskId === approvedPlanBackgroundTaskId(proposal.id)
    && !planProposalNeedsUserInput(proposal);
}

/**
 * The background goal is a projection of the task admission. If a process died
 * after creating that goal, rejoin it by the task's unique run session. A
 * pending record at that exact session is the createGoalContract crash seam.
 */
function ensureBackgroundRunGoal(
  task: BackgroundTaskRecord,
  proposal: PlanProposal,
  plan: Plan,
): void {
  const existing = listPlanProposals({ status: 'all', sessionId: task.runSessionId })
    .find((candidate) => (
      candidate.origin?.kind === 'background'
      || (
        (candidate.status === 'pending' || candidate.status === 'approved')
        && candidate.plan.objective === plan.objective
        && candidate.originatingRequest === proposal.originatingRequest
      )
    ));
  if (existing) {
    if (existing.status === 'pending' || existing.status === 'approved') {
      activateGoal(existing.id, { origin: { kind: 'background' } });
    }
    return;
  }
  bindBackgroundRunGoal(task.runSessionId, {
    objective: plan.objective,
    successCriteria: plan.successCriteria,
    nextActions: plan.steps.map((step) => step.action),
    originatingRequest: proposal.originatingRequest,
    channel: proposal.channel,
  });
}

function ensureQueuedRunProjection(
  task: BackgroundTaskRecord,
  proposal: PlanProposal,
): RunRecord | undefined {
  const runId = `run-${task.id}`;
  let run = getRun(runId);
  if (!run) {
    run = startRun({
      id: runId,
      sessionId: task.runSessionId,
      channel: task.channel,
      source: task.source,
      title: task.title,
      message: task.prompt,
    });
  }

  // If the process died between startRun and finishRun, the task is still
  // pending and the unbound `running` record is only the half-written queue
  // projection. Once a worker claims the task it owns this run and recovery
  // must never move it backwards to queued.
  const currentTask = getBackgroundTask(task.id) ?? task;
  if (
    currentTask.status === 'pending'
    && run.status === 'running'
    && !run.queuedTaskId
  ) {
    const outputPreview = `Plan ${proposal.id} approved and queued as background task ${task.id}.`;
    run = finishRun(run.id, {
      status: 'queued',
      message: outputPreview,
      queuedTaskId: task.id,
      outputPreview,
    }) ?? run;
  }
  return run;
}

function ensureQueuedNotification(
  proposal: PlanProposal,
  plan: Plan,
  task: BackgroundTaskRecord,
  run: RunRecord | undefined,
): void {
  addNotification({
    id: `plan-proposal-${proposal.id}-queued`,
    kind: 'execution',
    title: `Approved plan queued: ${plan.objective.slice(0, 80)}`,
    body: [
      `Plan ${proposal.id} is now background task ${task.id}.`,
      `Run: ${run?.id ?? `run-${task.id}`}`,
      'The daemon will execute it and send progress check-ins.',
    ].join('\n'),
    createdAt: proposal.backgroundAdmission?.requestedAt ?? proposal.resolvedAt ?? new Date().toISOString(),
    read: false,
    silent: true,
    metadata: {
      planProposalId: proposal.id,
      backgroundTaskId: task.id,
      queuedTaskId: task.id,
      runId: run?.id ?? `run-${task.id}`,
      sessionId: proposal.sessionId,
      channel: proposal.channel,
      discordChannelId: discordChannelIdFromChannel(proposal.channel),
    },
  });
}

function materializeApprovedPlanAdmission(id: string): ApprovedPlanTaskResult | null {
  mkdirSync(ADMISSION_LOCK_DIR, { recursive: true });
  return withFileLockSyncStrict(admissionLockTarget(id), () => {
    const proposal = getPlanProposal(id);
    const taskId = approvedPlanBackgroundTaskId(id);
    if (!proposal || !proposalCanMaterialize(proposal, taskId)) return null;

    const plan = proposal.approvedPlan ?? proposal.plan;
    const task = createBackgroundTask({
      explicitId: taskId,
      title: plan.objective,
      prompt: renderApprovedPlanPrompt(proposal, plan),
      originSessionId: proposal.sessionId,
      channel: proposal.channel,
      model: undefined,
      maxMinutes: loadProactivityPolicy().defaultLongTaskMinutes,
      source: proposal.channel?.startsWith('discord:') ? 'discord' : 'daemon',
    });

    ensureBackgroundRunGoal(task, proposal, plan);
    const run = ensureQueuedRunProjection(task, proposal);
    ensureQueuedNotification(proposal, plan, task, run);

    const acknowledged = completePlanBackgroundAdmission(proposal.id, task.id);
    if (!acknowledged) {
      throw new Error(`Approved plan admission ${proposal.id} lost its durable task binding.`);
    }
    return { proposal: acknowledged, task, run };
  });
}

export function approvePlanAndQueueBackgroundTask(
  id: string,
  options: ApprovePlanProposalOptions = {},
): ApprovedPlanTaskResult | null {
  const taskId = approvedPlanBackgroundTaskId(id);
  const before = getPlanProposal(id);
  if (!before) return null;

  if (before.status === 'pending') {
    // A losing concurrent click returns null from the transition, then reloads
    // and rejoins the winner's durable intent below.
    approvePlanProposalForBackgroundTask(id, taskId, options);
  }

  const admitted = getPlanProposal(id);
  if (!admitted || !proposalCanMaterialize(admitted, taskId)) return null;
  return materializeApprovedPlanAdmission(id);
}

/**
 * Boot/tick repair for the only durable unfinished shape: an approved/active
 * proposal with a background admission that has not acknowledged all of its
 * projections. Rejected, superseded, asking, and malformed records are inert.
 */
export function reconcileApprovedPlanTaskAdmissions(
  options: { limit?: number } = {},
): ApprovedPlanAdmissionReconcileResult {
  const result: ApprovedPlanAdmissionReconcileResult = {
    scanned: 0,
    materialized: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
  };
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const candidates = listPlanProposals({ status: 'all' })
    .filter((proposal) => proposal.backgroundAdmission && !proposal.backgroundAdmission.completedAt)
    .slice(0, limit);

  for (const proposal of candidates) {
    result.scanned += 1;
    const taskId = approvedPlanBackgroundTaskId(proposal.id);
    if (!proposalCanMaterialize(proposal, taskId)) {
      result.skipped += 1;
      continue;
    }
    const existed = Boolean(getBackgroundTask(taskId));
    try {
      const repaired = materializeApprovedPlanAdmission(proposal.id);
      if (!repaired) {
        result.skipped += 1;
        continue;
      }
      if (!existed) result.materialized += 1;
      result.completed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
