import { addNotification } from '../runtime/notifications.js';
import { finishRun, startRun, type RunRecord } from '../runtime/run-events.js';
import { loadProactivityPolicy } from '../agents/proactivity-policy.js';
import {
  approvePlanProposal,
  type ApprovePlanProposalOptions,
  type PlanProposal,
} from '../agents/plan-proposals.js';
import type { Plan } from '../agents/planner.js';
import {
  createBackgroundTask,
  type BackgroundTaskRecord,
} from './background-tasks.js';

export interface ApprovedPlanTaskResult {
  proposal: PlanProposal;
  task: BackgroundTaskRecord;
  run: RunRecord | undefined;
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

export function approvePlanAndQueueBackgroundTask(
  id: string,
  options: ApprovePlanProposalOptions = {},
): ApprovedPlanTaskResult | null {
  const proposal = approvePlanProposal(id, options);
  if (!proposal) return null;

  const plan = proposal.approvedPlan ?? proposal.plan;
  const task = createBackgroundTask({
    title: plan.objective,
    prompt: renderApprovedPlanPrompt(proposal, plan),
    originSessionId: proposal.sessionId,
    channel: proposal.channel,
    model: undefined,
    maxMinutes: loadProactivityPolicy().defaultLongTaskMinutes,
    source: proposal.channel?.startsWith('discord:') ? 'discord' : 'daemon',
  });

  const run = startRun({
    id: `run-${task.id}`,
    sessionId: task.runSessionId,
    channel: task.channel,
    source: task.source,
    title: task.title,
    message: task.prompt,
  });
  const outputPreview = `Plan ${proposal.id} approved and queued as background task ${task.id}.`;
  const finishedRun = finishRun(run.id, {
    status: 'queued',
    message: outputPreview,
    queuedTaskId: task.id,
    outputPreview,
  }) ?? run;

  addNotification({
    id: `${Date.now()}-plan-proposal-${proposal.id}-queued`,
    kind: 'execution',
    title: `Approved plan queued: ${plan.objective.slice(0, 80)}`,
    body: [
      `Plan ${proposal.id} is now background task ${task.id}.`,
      `Run: ${finishedRun.id}`,
      'The daemon will execute it and send progress check-ins.',
    ].join('\n'),
    createdAt: new Date().toISOString(),
    read: false,
    metadata: {
      planProposalId: proposal.id,
      backgroundTaskId: task.id,
      queuedTaskId: task.id,
      runId: finishedRun.id,
      sessionId: proposal.sessionId,
      channel: proposal.channel,
      discordChannelId: discordChannelIdFromChannel(proposal.channel),
    },
  });

  return { proposal, task, run: finishedRun };
}
