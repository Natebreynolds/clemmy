/**
 * Rebuild the prospective-intention materialized index from every durable
 * source of future commitments. Safe on every daemon tick; no LLM calls.
 */
import pino from 'pino';
import { listCheckInTemplates } from '../agents/check-in-templates.js';
import { listActiveGoalContracts } from '../agents/plan-proposals.js';
import { loadProactivityPolicy } from '../agents/proactivity-policy.js';
import { listBackgroundTasks } from '../execution/background-tasks.js';
import { listWorkflows } from '../memory/workflow-store.js';
import { readTimers } from './timers.js';
import {
  backgroundProspectiveDefinition,
  checkInProspectiveDefinition,
  goalProspectiveDefinition,
  monitorProspectiveDefinitions,
  timerProspectiveDefinition,
  workflowProspectiveDefinitions,
} from './prospective-adapters.js';
import {
  activateDueProspectiveIntentions,
  getProspectiveIntention,
  prospectiveIntentionId,
  prospectiveIntentionsEnabled,
  reconcileProspectiveIntentions,
  recordProspectiveOutcome,
  type ProspectiveIntentionDefinition,
  type ProspectiveSourceKind,
} from './prospective-intentions.js';

const logger = pino({ name: 'clementine-next.prospective-sync' });

export interface ProspectiveSyncResult {
  indexed: number;
  cancelled: number;
  dueActivated: number;
  sources: Partial<Record<ProspectiveSourceKind, number>>;
}

export function syncProspectiveIntentions(now = new Date()): ProspectiveSyncResult {
  const empty: ProspectiveSyncResult = { indexed: 0, cancelled: 0, dueActivated: 0, sources: {} };
  if (!prospectiveIntentionsEnabled()) return empty;

  const bySource: Partial<Record<ProspectiveSourceKind, ProspectiveIntentionDefinition[]>> = {};
  const put = (kind: ProspectiveSourceKind, values: ProspectiveIntentionDefinition[]): void => {
    bySource[kind] = values;
  };

  put('timer', readTimers()
    .filter((timer) => Number.isFinite(timer.fireAt))
    .map(timerProspectiveDefinition));
  const goals = listActiveGoalContracts();
  put('goal', goals
    .map(goalProspectiveDefinition)
    .filter((value): value is ProspectiveIntentionDefinition => Boolean(value)));

  const workflowDefinitions = listWorkflows()
    .flatMap((entry) => workflowProspectiveDefinitions(entry.name, entry.data));
  put('workflow_schedule', workflowDefinitions.filter((item) => item.sourceKind === 'workflow_schedule'));
  put('workflow_event', workflowDefinitions.filter((item) => item.sourceKind === 'workflow_event'));
  put('workflow_webhook', workflowDefinitions.filter((item) => item.sourceKind === 'workflow_webhook'));

  put('monitor', monitorProspectiveDefinitions(loadProactivityPolicy()));
  put('check_in', listCheckInTemplates()
    .map(checkInProspectiveDefinition)
    .filter((value): value is ProspectiveIntentionDefinition => Boolean(value)));
  const backgroundTasks = listBackgroundTasks();
  put('background', backgroundTasks
    .map(backgroundProspectiveDefinition)
    .filter((value): value is ProspectiveIntentionDefinition => Boolean(value)));

  const result: ProspectiveSyncResult = { ...empty, sources: {} };
  for (const kind of [
    'timer',
    'goal',
    'workflow_schedule',
    'workflow_event',
    'workflow_webhook',
    'monitor',
    'check_in',
    'background',
  ] as const) {
    const definitions = bySource[kind] ?? [];
    try {
      const reconciled = reconcileProspectiveIntentions(kind, definitions, now);
      result.indexed += reconciled.upserted;
      result.cancelled += reconciled.cancelled;
      result.sources[kind] = definitions.length;
    } catch (err) {
      logger.warn(
        { sourceKind: kind, err: err instanceof Error ? err.message : String(err) },
        'prospective source reconciliation failed',
      );
    }
  }
  // Rebuild status that is authoritative in the source record, not just its
  // definition. Guard the write so the minute-level sync stays a true no-op
  // once the materialized status already matches.
  for (const goal of goals) {
    if (!goal.parked) continue;
    const id = prospectiveIntentionId('goal', goal.id);
    try {
      if (getProspectiveIntention(id)?.status !== 'blocked') {
        recordProspectiveOutcome(id, 'blocked', {
          reason: goal.parked.reason,
          note: goal.parked.note ?? null,
          parkedAt: goal.parked.at,
        }, now);
      }
    } catch { /* the goal file remains authoritative */ }
  }
  for (const task of backgroundTasks) {
    if (task.status !== 'blocked') continue;
    const id = prospectiveIntentionId('background', task.id);
    try {
      if (getProspectiveIntention(id)?.status !== 'blocked') {
        recordProspectiveOutcome(id, 'blocked', {
          taskStatus: task.status,
          reason: task.error ?? 'background_task_blocked',
          resultPath: task.resultPath ?? null,
        }, now);
      }
    } catch { /* the background-task file remains authoritative */ }
  }
  try {
    result.dueActivated = activateDueProspectiveIntentions(now)
      .filter((cue) => cue.accepted).length;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'prospective due-cue activation failed',
    );
  }
  return result;
}
