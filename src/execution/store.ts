import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type { ExecutionRecord, PlanRecord } from '../types.js';
import { isUserFacingExecution } from './scope.js';
import { actionBus } from '../runtime/action-bus.js';
import { addNotification } from '../runtime/notifications.js';
// v0.5.19 Bug F — pause-aware sweep needs these. Static ESM imports
// (no circular dep: neither module imports from execution/store).
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { listEvents as listHarnessEvents } from '../runtime/harness/eventlog.js';

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
      status: execution.status,
      blocker: execution.blocker,
      lastAssistantSummary: execution.lastAssistantSummary,
      ...(allDone && execution.status !== 'completed'
        ? {
            nextStep: 'Validate completion evidence for the finished plan.',
            nextReviewAt: new Date().toISOString(),
          }
        : {}),
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
    const recordActivityTimes = [execution.lastActivityAt, execution.updatedAt]
      .map((value) => Date.parse(value || ''))
      .filter(Number.isFinite);
    const recentRecordActivity = recordActivityTimes.length > 0 ? Math.max(...recordActivityTimes) : NaN;
    if (Number.isFinite(recentRecordActivity) && recentRecordActivity > cutoff) continue;
    if (hasRecentHarnessActivity(execution.sessionId, cutoff)) continue;
    // v0.5.19 Bug F fix — pause-aware sweep. If the execution's session
    // is legitimately parked on a user prompt (pending approval, recent
    // awaiting_user_input event from F4/Bug C), the heartbeat going
    // stale is EXPECTED — the controller has nothing to do until the
    // user replies. Auto-failing here kills the execution lane so when
    // the user does reply, EXECUTION_WRAP_REQUIRED has no active lane
    // and the next mutating call fails or requires a fresh wrap.
    // Same architecture pattern as P0-2 (per-tool timeout during
    // approval wait, fixed v0.5.5 via withTimeout's isPaused check).
    // Honors CLEMMY_SWEEP_AWARE_OF_PAUSES=off to revert.
    if (isExecutionLegitimatelyIdle(execution)) {
      continue;
    }
    // v0.5.64 — schedule-aware sweep. The controller schedules the NEXT review
    // up to 15-60 min out (controller.ts `nextReviewAt: plusMinutes(30/60)`),
    // and the heartbeat only ticks when an execution actually RUNS a cycle. So
    // an execution legitimately waiting for a future-scheduled review has a
    // stale heartbeat BY DESIGN — it is not crashed. Only sweep executions that
    // are OVERDUE for review (nextReviewAt has passed) AND heartbeat-stale —
    // that is the real "should have run but the controller didn't tick it"
    // crash/starvation signal. Without this, every execution that scheduled a
    // review more than `staleAfterMs` (5m) out was false-swept as "heartbeat
    // stalled" (observed 2026-06-03: a send-emails execution scheduled
    // nextReviewAt=+30m, swept at +7m, so the send never ran).
    // Honors CLEMMY_SWEEP_HONOR_NEXT_REVIEW=off to revert.
    if ((process.env.CLEMMY_SWEEP_HONOR_NEXT_REVIEW ?? 'on').toLowerCase() !== 'off' && execution.nextReviewAt) {
      const nextReview = Date.parse(execution.nextReviewAt);
      if (Number.isFinite(nextReview) && nextReview > Date.now()) continue;
    }
    const ageMinutes = Math.round((Date.now() - heartbeatTime) / 60000);
    transitionToFailed(
      execution,
      // Honest framing: a stale heartbeat could be (a) the daemon
      // actually crashed, or (b) the daemon was alive but didn't tick
      // this execution's controller for too long (busy with a long
      // user-facing turn, blocked sub-process, etc.). The earlier
      // "daemon likely crashed mid-cycle" wording was misleading in
      // case (b) — sent users hunting for a crash that wasn't there.
      // Observed 2026-05-24 with a synthesis execution that starved
      // while the daemon was alive and processing Discord.
      `Controller heartbeat stalled for ${ageMinutes}m — the execution stopped getting controller cycles (the daemon may have been busy on other work or restarted).`,
      `sweep-crashed-${Date.now()}`,
    );
    swept += 1;
  }
  if (swept > 0) saveExecutions(executions);
  return swept;
}

/**
 * v0.5.19 Bug F — pause-aware sweep helper. Returns true when the
 * execution's session is in a state where the controller is RIGHT
 * NOT to be ticking — pending approval, recent awaiting_user_input
 * from F4/Bug C ask-user routing. The sweep should skip these.
 *
 * v0.5.19 follow-up: initial implementation used CommonJS require()
 * which throws ReferenceError in this ESM package — the try/catch
 * silently swallowed it and the function returned false for every
 * call, defeating the fix. Now uses static ESM imports (no circular
 * dep risk: neither eventlog nor approval-registry imports from
 * execution/store).
 *
 * Honors CLEMMY_SWEEP_AWARE_OF_PAUSES=off to revert.
 */
function isExecutionLegitimatelyIdle(execution: { sessionId: string }): boolean {
  if ((process.env.CLEMMY_SWEEP_AWARE_OF_PAUSES ?? 'on').toLowerCase() === 'off') {
    return false;
  }
  try {
    if (approvalRegistry.hasPending(execution.sessionId)) return true;
  } catch {
    // best-effort; better to sweep a real crash than to never reap
  }
  try {
    const recent = listHarnessEvents(execution.sessionId, { types: ['awaiting_user_input'], limit: 1 });
    if (recent.length > 0) {
      // Treat any awaiting_user_input event in the LAST 24h as
      // legitimate idle. After 24h the session is probably abandoned
      // and the sweep should reap.
      const evt = recent[0] as { type: string; createdAt?: string; ts?: string };
      const ts = evt.createdAt ?? evt.ts;
      if (ts) {
        const evtTime = Date.parse(ts);
        if (Number.isFinite(evtTime) && Date.now() - evtTime < 24 * 60 * 60 * 1000) {
          return true;
        }
      } else {
        // No timestamp — be generous and treat as idle.
        return true;
      }
    }
  } catch {
    // best-effort
  }
  return false;
}

function hasRecentHarnessActivity(sessionId: string, cutoff: number): boolean {
  try {
    const recent = listHarnessEvents(sessionId, { limit: 1, desc: true });
    const latest = recent[0];
    if (!latest) return false;
    const eventTime = Date.parse(latest.createdAt);
    return Number.isFinite(eventTime) && eventTime > cutoff;
  } catch {
    return false;
  }
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
