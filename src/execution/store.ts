import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type { ExecutionRecord, PlanRecord } from '../types.js';
import { isUserFacingExecution } from './scope.js';
import { actionBus } from '../runtime/action-bus.js';
import { addNotification } from '../runtime/notifications.js';

const STATE_DIR = path.join(BASE_DIR, 'state');
const EXECUTIONS_FILE = path.join(STATE_DIR, 'executions.json');

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function loadExecutions(): ExecutionRecord[] {
  ensureStateDir();
  if (!existsSync(EXECUTIONS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(EXECUTIONS_FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed as ExecutionRecord[] : [];
  } catch {
    return [];
  }
}

function saveExecutions(executions: ExecutionRecord[]): void {
  ensureStateDir();
  writeFileSync(EXECUTIONS_FILE, JSON.stringify(executions, null, 2), 'utf-8');
}

function clean(value: string, maxChars = 220): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

export interface CreateExecutionInput {
  sessionId: string;
  userId?: string;
  channel?: string;
  title: string;
  objective: string;
  reason: string;
  startedFromMessage: string;
  confidence: number;
  reasons: string[];
  planId?: string;
  nextStep?: string;
  successCriteria?: string;
  lastAssistantSummary?: string;
  nextReviewAt?: string;
  blocker?: string;
  autoAdvance?: boolean;
}

export class ExecutionStore {
  list(limit = 20, status?: ExecutionRecord['status']): ExecutionRecord[] {
    return loadExecutions()
      .filter((execution) => !status || execution.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  get(id: string): ExecutionRecord | undefined {
    return loadExecutions().find((execution) => execution.id === id);
  }

  getActiveForSession(sessionId: string): ExecutionRecord | undefined {
    return loadExecutions()
      .filter((execution) => execution.sessionId === sessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .find((execution) => execution.status === 'active' || execution.status === 'blocked');
  }

  create(input: CreateExecutionInput): ExecutionRecord {
    const executions = loadExecutions();
    const now = new Date().toISOString();
    const execution: ExecutionRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      userId: input.userId,
      channel: input.channel,
      title: clean(input.title, 120),
      objective: clean(input.objective, 600),
      reason: clean(input.reason, 400),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      startedFromMessage: clean(input.startedFromMessage, 500),
      planId: input.planId,
      nextStep: input.nextStep ? clean(input.nextStep, 220) : undefined,
      successCriteria: input.successCriteria ? clean(input.successCriteria, 300) : undefined,
      lastAssistantSummary: input.lastAssistantSummary ? clean(input.lastAssistantSummary, 400) : undefined,
      nextReviewAt: input.nextReviewAt,
      blocker: input.blocker ? clean(input.blocker, 220) : undefined,
      autoAdvance: input.autoAdvance !== false,
      taskBindings: [],
      workflowBindings: [],
      delegationBindings: [],
      activity: [],
      confidence: Math.max(0, Math.min(1, input.confidence)),
      reasons: input.reasons.map((item) => clean(item, 140)).filter(Boolean).slice(0, 8),
    };
    executions.push(execution);
    saveExecutions(executions);
    return execution;
  }

  addActivity(input: {
    executionId: string;
    key: string;
    type: NonNullable<ExecutionRecord['activity']>[number]['type'];
    message: string;
    metadata?: Record<string, unknown>;
  }): ExecutionRecord | undefined {
    const executions = loadExecutions();
    const execution = executions.find((entry) => entry.id === input.executionId);
    if (!execution) return undefined;

    execution.activity = Array.isArray(execution.activity) ? execution.activity : [];
    if (execution.activity.some((item) => item.key === input.key)) {
      return execution;
    }

    execution.activity.push({
      id: randomUUID(),
      key: input.key,
      type: input.type,
      message: clean(input.message, 500),
      createdAt: new Date().toISOString(),
      metadata: input.metadata,
    });
    execution.activity = execution.activity.slice(-60);
    execution.updatedAt = new Date().toISOString();
    execution.lastActivityAt = new Date().toISOString();
    saveExecutions(executions);
    return execution;
  }

  recentActivity(executionId: string, limit = 10): NonNullable<ExecutionRecord['activity']> {
    const execution = this.get(executionId);
    return [...(execution?.activity ?? [])]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  update(id: string, patch: Partial<Omit<ExecutionRecord, 'id' | 'createdAt' | 'sessionId'>>): ExecutionRecord | undefined {
    const executions = loadExecutions();
    const execution = executions.find((entry) => entry.id === id);
    if (!execution) return undefined;

    Object.assign(execution, patch, {
      updatedAt: new Date().toISOString(),
      lastActivityAt: patch.lastActivityAt ?? new Date().toISOString(),
    });
    saveExecutions(executions);
    return execution;
  }

  listDue(now = new Date(), limit = 20): ExecutionRecord[] {
    return loadExecutions().filter((execution) => {
      if (execution.autoAdvance === false) return false;
      if (!isUserFacingExecution(execution)) return false;
      if (execution.status !== 'active' && execution.status !== 'blocked') return false;
      if (!execution.nextReviewAt) return true;
      return new Date(execution.nextReviewAt).getTime() <= now.getTime();
    })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  syncWithPlan(executionId: string, plan?: PlanRecord): ExecutionRecord | undefined {
    const execution = this.get(executionId);
    if (!execution) return undefined;
    if (!plan) return execution;

    const activeStep = plan.steps.find((step) => step.status === 'in_progress');
    const allDone = plan.steps.length > 0 && plan.steps.every((step) => step.status === 'done');
    return this.update(executionId, {
      planId: plan.id,
      nextStep: activeStep?.text ?? execution.nextStep,
      status: allDone ? 'completed' : execution.status,
      blocker: allDone ? undefined : execution.blocker,
      lastAssistantSummary: execution.lastAssistantSummary,
    });
  }
}

/**
 * Force-close executions that have been sitting in `active`/`blocked`/`paused`
 * with no activity for longer than `staleAfterMs`. The model is supposed to
 * call `execution_complete` when its work is done; when it forgets (turn cap,
 * compaction, crash mid-run), the record stays "active" forever and the
 * dashboard reports phantom in-flight work. Returns the number swept.
 */
export function sweepStaleExecutions(staleAfterMs = 60 * 60 * 1000): number {
  const cutoff = Date.now() - staleAfterMs;
  const executions = loadExecutions();
  const now = new Date().toISOString();
  let swept = 0;
  for (const execution of executions) {
    if (execution.status !== 'active' && execution.status !== 'blocked' && execution.status !== 'paused') continue;
    const updated = Date.parse(execution.lastActivityAt || execution.updatedAt || execution.createdAt);
    if (Number.isFinite(updated) && updated > cutoff) continue;
    const note = `Auto-closed: no activity for ${Math.round(staleAfterMs / 60000)}m (stale-execution sweep).`;
    execution.status = 'completed';
    execution.updatedAt = now;
    execution.lastActivityAt = now;
    execution.blocker = note;
    execution.lastAssistantSummary = execution.lastAssistantSummary
      ? `${execution.lastAssistantSummary} | ${note}`
      : note;
    execution.activity = Array.isArray(execution.activity) ? execution.activity : [];
    execution.activity.push({
      id: randomUUID(),
      key: `sweep-${Date.now()}`,
      type: 'status',
      message: note,
      createdAt: now,
    });
    execution.activity = execution.activity.slice(-60);
    swept += 1;
  }
  if (swept > 0) saveExecutions(executions);
  return swept;
}

export function renderExecutionSummary(execution: ExecutionRecord): string {
  const parts = [
    `[${execution.status}] ${execution.title}`,
    execution.nextStep ? `Next: ${execution.nextStep}` : '',
    execution.blocker ? `Blocker: ${execution.blocker}` : '',
    execution.successCriteria ? `Done when: ${execution.successCriteria}` : '',
  ].filter(Boolean);
  return parts.join(' | ');
}

function transitionToFailed(
  execution: ExecutionRecord,
  reason: string,
  activityKey: string,
): ExecutionRecord {
  const now = new Date().toISOString();
  const previousStatus = execution.status;
  execution.status = 'completed'; // ExecutionRecord status doesn't have 'failed' — keep 'completed' semantically + use blocker for reason
  execution.updatedAt = now;
  execution.lastActivityAt = now;
  execution.blocker = reason;
  execution.lastAssistantSummary = execution.lastAssistantSummary
    ? `${execution.lastAssistantSummary} | ${reason}`
    : reason;
  execution.activity = Array.isArray(execution.activity) ? execution.activity : [];
  execution.activity.push({
    id: randomUUID(),
    key: activityKey,
    type: 'status',
    message: reason,
    createdAt: now,
  });
  execution.activity = execution.activity.slice(-60);

  // Tell the live rail this transition happened so the user sees it.
  actionBus.emit({
    kind: 'execution.transitioned',
    executionId: execution.id,
    title: execution.title,
    previousState: previousStatus,
    nextState: 'completed',
    summary: reason,
  });

  // Surface a notification so the user finds out without staring at
  // the dashboard. Skip noisy notifications for non-user-facing
  // executions (background plumbing the user never asked about).
  if (isUserFacingExecution(execution)) {
    addNotification({
      id: `${Date.now()}-execution-${execution.id}-${activityKey}`,
      kind: 'execution',
      title: `Execution stopped: ${execution.title}`,
      body: reason,
      createdAt: now,
      read: false,
      metadata: { executionId: execution.id, sweepKey: activityKey },
    });
  }
  return execution;
}

/**
 * Reaper #1 — controller-crash detector. Active executions that haven't
 * had a heartbeat in `staleAfterMs` (default 5 min) are presumed to have
 * crashed mid-cycle: the controller process died, the daemon was
 * SIGSTOP'd, or `advanceExecution` is wedged. We can't recover the run
 * automatically (the model context is gone), but we can stop silently
 * pretending it's still working — flip to a stopped state, fire a
 * notification, and let the user retry if they care.
 *
 * Only kicks in for executions that have *ever* had a heartbeat
 * written (`lastHeartbeatAt` set). Executions created before this
 * field existed, or created very recently, are left alone — the
 * activity-based sweep (`sweepStaleExecutions`, 60 min) is the
 * fallback for those.
 */
export function sweepCrashedExecutions(staleAfterMs = 5 * 60 * 1000): number {
  const cutoff = Date.now() - staleAfterMs;
  const executions = loadExecutions();
  let swept = 0;
  for (const execution of executions) {
    if (execution.status !== 'active') continue;
    if (!execution.lastHeartbeatAt) continue;
    const heartbeatTime = Date.parse(execution.lastHeartbeatAt);
    if (!Number.isFinite(heartbeatTime) || heartbeatTime > cutoff) continue;
    const ageMinutes = Math.round((Date.now() - heartbeatTime) / 60000);
    transitionToFailed(
      execution,
      `Controller heartbeat stalled for ${ageMinutes}m — daemon likely crashed mid-cycle.`,
      `sweep-crashed-${Date.now()}`,
    );
    swept += 1;
  }
  if (swept > 0) saveExecutions(executions);
  return swept;
}

/**
 * Reaper #2 — perpetually-blocked execution detector. An execution
 * sits in `blocked` because the controller decided synthesis can't
 * proceed (waiting on a user reply, an external integration, etc.).
 * The existing `sweepStaleExecutions` runs at 60 min on `lastActivityAt`
 * which also fires controller-tick activity — so a blocked execution
 * that the controller checks on every 30 min indefinitely never trips
 * that sweep. This one looks at `updatedAt` (when state last actually
 * CHANGED) so a stuck blocker actually times out. Default 6 hours.
 */
export function sweepStaleBlockedExecutions(staleAfterMs = 6 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - staleAfterMs;
  const executions = loadExecutions();
  let swept = 0;
  for (const execution of executions) {
    if (execution.status !== 'blocked') continue;
    const updated = Date.parse(execution.updatedAt || execution.createdAt);
    if (!Number.isFinite(updated) || updated > cutoff) continue;
    const ageHours = Math.round((Date.now() - updated) / 3600000);
    transitionToFailed(
      execution,
      `Blocked for ${ageHours}h with no resolution — auto-failed; retry from the dashboard if still relevant.`,
      `sweep-blocked-${Date.now()}`,
    );
    swept += 1;
  }
  if (swept > 0) saveExecutions(executions);
  return swept;
}
