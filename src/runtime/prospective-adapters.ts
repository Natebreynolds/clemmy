/**
 * Pure adapters from Clementine's source-specific commitment stores into the
 * unified prospective-intention control plane.
 *
 * Keeping these transforms pure makes the index rebuildable: the timers, goal
 * contracts, workflows, monitor policy, check-ins, and background-task records
 * remain the execution authorities.
 */
import type { ProactivityPolicy } from '../agents/proactivity-policy.js';
import type { CheckInTemplate } from '../agents/check-in-templates.js';
import type { PlanProposal } from '../agents/plan-proposals.js';
import type { BackgroundTaskRecord } from '../execution/background-tasks.js';
import { workflowTriggerPayloadHash } from '../execution/workflow-trigger-registry.js';
import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';
import type { TimerEntry } from './timers.js';
import {
  prospectiveIntentionId,
  type ProspectiveIntentionDefinition,
  type ProspectiveRisk,
} from './prospective-intentions.js';

function workflowRisk(steps: WorkflowStepInput[]): ProspectiveRisk {
  if (steps.some((step) => step.sideEffect === 'send')) return 'send';
  if (steps.some((step) => step.sideEffect === 'write')) return 'write';
  if (steps.length > 0 && steps.every((step) => step.sideEffect === 'read')) return 'read';
  return 'inherits';
}

export function timerProspectiveDefinition(timer: TimerEntry): ProspectiveIntentionDefinition {
  return {
    id: prospectiveIntentionId('timer', timer.id),
    sourceKind: 'timer',
    sourceId: timer.id,
    objective: timer.message,
    trigger: { kind: 'time', at: new Date(timer.fireAt).toISOString() },
    action: { kind: 'notify', ref: timer.id, summary: timer.message },
    risk: 'read',
    approvalMode: 'none',
    recurring: false,
    metadata: { createdAtMs: timer.createdAt },
  };
}

export function goalProspectiveDefinition(goal: PlanProposal): ProspectiveIntentionDefinition | null {
  if (goal.status !== 'active' || !goal.selfDriving) return null;
  const plan = goal.approvedPlan ?? goal.plan;
  const trigger = goal.nextResumeAt
    ? { kind: 'time' as const, at: goal.nextResumeAt }
    : { kind: 'manual' as const };
  const hasEnumeratedSends = Array.isArray(plan.externalSends) && plan.externalSends.length > 0;
  return {
    id: prospectiveIntentionId('goal', goal.id),
    sourceKind: 'goal',
    sourceId: goal.id,
    objective: plan.objective,
    trigger,
    action: { kind: 'resume_goal', ref: goal.id, summary: plan.objective },
    sessionId: goal.sessionId,
    goalId: goal.id,
    risk: hasEnumeratedSends ? 'send' : 'inherits',
    approvalMode: 'enforce_at_action',
    recurring: true,
    metadata: {
      parked: Boolean(goal.parked),
      resumeCount: goal.resumeCount ?? 0,
      maxResumes: goal.maxResumes ?? null,
      deadlineAt: goal.deadlineAt ?? null,
    },
  };
}

function eventTriggerSourceId(
  workflowSlug: string,
  event: NonNullable<WorkflowDefinition['trigger']['events']>[number],
): string {
  const signature = workflowTriggerPayloadHash({
    type: event.type,
    filter: event.filter ?? {},
    dedupeKeyTemplate: event.dedupeKey ?? null,
  }).slice(0, 16);
  return `system_event:${workflowSlug}:${event.type}:${signature}`;
}

export function workflowProspectiveDefinitions(
  workflowSlug: string,
  workflow: WorkflowDefinition,
): ProspectiveIntentionDefinition[] {
  if (!workflow.enabled) return [];
  const definitions: ProspectiveIntentionDefinition[] = [];
  const risk = workflowRisk(workflow.steps ?? []);
  const approvalMode = risk === 'read' ? 'none' as const : 'enforce_at_action' as const;
  const objective = workflow.goal?.objective || workflow.description || `Run workflow ${workflow.name}`;

  const schedule = workflow.trigger?.schedule?.trim();
  if (schedule) {
    definitions.push({
      id: prospectiveIntentionId('workflow_schedule', workflowSlug),
      sourceKind: 'workflow_schedule',
      sourceId: workflowSlug,
      objective,
      trigger: {
        kind: 'cron',
        expression: schedule,
        timezone: workflow.trigger.timezone?.trim() || undefined,
      },
      action: { kind: 'run_workflow', ref: workflowSlug, summary: objective },
      workflowName: workflowSlug,
      risk,
      approvalMode,
      recurring: true,
      metadata: { workflowSlug },
    });
  }

  const webhookPath = workflow.trigger?.webhookPath?.trim();
  if (webhookPath) {
    const sourceId = `webhook:${workflowSlug}:${webhookPath}`;
    definitions.push({
      id: prospectiveIntentionId('workflow_webhook', sourceId),
      sourceKind: 'workflow_webhook',
      sourceId,
      objective,
      trigger: { kind: 'webhook', path: webhookPath },
      action: { kind: 'run_workflow', ref: workflowSlug, summary: objective },
      workflowName: workflowSlug,
      risk,
      approvalMode,
      recurring: true,
      metadata: { workflowSlug },
    });
  }

  for (const event of workflow.trigger?.events ?? []) {
    const eventType = event.type?.trim();
    if (!eventType) continue;
    const sourceId = eventTriggerSourceId(workflowSlug, event);
    definitions.push({
      id: prospectiveIntentionId('workflow_event', sourceId),
      sourceKind: 'workflow_event',
      sourceId,
      objective,
      trigger: {
        kind: 'event',
        eventType,
        filter: event.filter,
        dedupeKeyTemplate: event.dedupeKey?.trim() || undefined,
      },
      action: { kind: 'run_workflow', ref: workflowSlug, summary: objective },
      workflowName: workflowSlug,
      risk,
      approvalMode,
      recurring: true,
      metadata: { workflowSlug },
    });
  }
  return definitions;
}

export function monitorProspectiveDefinitions(policy: ProactivityPolicy): ProspectiveIntentionDefinition[] {
  if (!policy.enabled) return [];
  const definitions: ProspectiveIntentionDefinition[] = [];
  if (policy.inboxWatchEnabled) {
    definitions.push({
      id: prospectiveIntentionId('monitor', 'inbox'),
      sourceKind: 'monitor',
      sourceId: 'inbox',
      objective: 'Watch connected inboxes and surface messages that genuinely need the user',
      trigger: { kind: 'state', channel: 'inbox', intervalMs: policy.inboxWatchMinutes * 60_000 },
      action: { kind: 'observe', ref: 'inbox-monitor' },
      risk: 'read',
      approvalMode: 'none',
      recurring: true,
    });
  }
  if (policy.calendarWatchEnabled) {
    definitions.push({
      id: prospectiveIntentionId('monitor', 'calendar'),
      sourceKind: 'monitor',
      sourceId: 'calendar',
      objective: 'Watch connected calendars for conflicts, unanswered invitations, and imminent meetings',
      trigger: { kind: 'state', channel: 'calendar', intervalMs: policy.calendarWatchMinutes * 60_000 },
      action: { kind: 'observe', ref: 'calendar-monitor' },
      risk: 'read',
      approvalMode: 'none',
      recurring: true,
    });
  }
  return definitions;
}

export function checkInProspectiveDefinition(
  template: CheckInTemplate,
): ProspectiveIntentionDefinition | null {
  if (!template.enabled) return null;
  const trigger = template.trigger === 'schedule' && template.schedule
    ? { kind: 'cron' as const, expression: template.schedule }
    : {
        kind: 'state' as const,
        channel: template.trigger,
        intervalMs: Math.max(1, template.cooldownHours) * 60 * 60_000,
      };
  return {
    id: prospectiveIntentionId('check_in', template.id),
    sourceKind: 'check_in',
    sourceId: template.id,
    objective: template.description || template.name,
    trigger,
    action: { kind: 'surface_check_in', ref: template.id, summary: template.questionTemplate },
    risk: 'read',
    approvalMode: 'none',
    recurring: true,
    metadata: { name: template.name, urgency: template.urgency },
  };
}

const ACTIVE_BACKGROUND_STATUSES: ReadonlySet<BackgroundTaskRecord['status']> = new Set([
  'pending',
  'running',
  'cancelling',
  'awaiting_approval',
  'awaiting_continue',
  'awaiting_input',
  'blocked',
  'interrupted',
]);

export function backgroundProspectiveDefinition(
  task: BackgroundTaskRecord,
): ProspectiveIntentionDefinition | null {
  if (!ACTIVE_BACKGROUND_STATUSES.has(task.status)) return null;
  const objective = task.title?.trim() || task.prompt.replace(/\s+/g, ' ').trim().slice(0, 240);
  return {
    id: prospectiveIntentionId('background', task.id),
    sourceKind: 'background',
    sourceId: task.id,
    objective: `Report back when background task completes: ${objective}`,
    trigger: { kind: 'completion', resourceType: 'background_task', resourceId: task.id },
    action: { kind: 'report_back', ref: task.id, summary: objective },
    sessionId: task.originSessionId,
    risk: 'read',
    approvalMode: 'none',
    recurring: false,
    metadata: { status: task.status, runSessionId: task.runSessionId },
  };
}
