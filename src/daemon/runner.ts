import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import pino from 'pino';
import { ClementineAssistant } from '../assistant/core.js';
import { processAgentAutonomy } from '../agents/autonomy.js';
import { processAgentAutonomyV2 } from '../agents/autonomy-v2.js';
import { processMonitors } from '../agents/monitors.js';
import { getProactivityPolicySnapshot } from '../agents/proactivity-policy.js';
import { processProactiveBriefs } from '../agents/proactive-briefs.js';
import { ensureSeedTemplates, processProactiveCheckIns } from '../agents/check-in-templates.js';
import { MODELS } from '../config.js';
import { processExecutionController } from '../execution/controller.js';
import { interruptStaleRunningBackgroundTasks, processBackgroundTasks } from '../execution/background-tasks.js';
import { processWorkflowRuns, reconcilePendingWorkflowRuns } from '../execution/workflow-runner.js';
import { sweepStaleExecutions } from '../execution/store.js';
import { sweepStaleRuns } from '../runtime/run-events.js';
import { sweepStaleApprovals } from '../runtime/approval-store.js';
import { processMemoryMaintenance } from '../memory/maintenance.js';
import {
  CRON_FILE,
} from '../memory/vault.js';
import {
  migrateLegacyWorkflowsOnce,
} from '../memory/workflow-store.js';
import {
  CRON_PROGRESS_DIR,
  CRON_RUNS_DIR,
  CRON_TRIGGERS_DIR,
  WORKFLOW_RUNS_DIR,
  ensureDir,
} from '../tools/shared.js';
import {
  addNotification,
  getNotificationDestinationsForRecord,
  getNotification,
  listQueuedNotificationDeliveries,
  replaceQueuedNotificationDeliveries,
  updateNotificationDeliveryStatus,
} from '../runtime/notifications.js';
import { deliverNotificationToDestination } from '../runtime/notification-delivery.js';

const logger = pino({ name: 'clementine-next.daemon' });
const STATE_FILE = path.join(path.dirname(CRON_RUNS_DIR), 'daemon-state.json');

interface CronJobRecord {
  name: string;
  schedule: string;
  prompt: string;
  tier?: number;
  enabled?: boolean;
  work_dir?: string;
  mode?: 'standard' | 'unleashed';
  max_hours?: number;
}

interface DaemonState {
  lastCronRunByMinute: Record<string, string>;
}

const DELIVERY_MAX_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadState(): DaemonState {
  if (!existsSync(STATE_FILE)) {
    return { lastCronRunByMinute: {} };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as DaemonState;
  } catch {
    return { lastCronRunByMinute: {} };
  }
}

function saveState(state: DaemonState): void {
  ensureDir(path.dirname(STATE_FILE));
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function validateCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part) => /^(\*|\*\/\d+|\d+|\d+-\d+)(,(\*\/\d+|\d+|\d+-\d+))*$/.test(part));
}

function fieldMatch(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return !Number.isNaN(step) && step > 0 && value % step === 0;
  }
  for (const part of field.split(',')) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (!Number.isNaN(a) && !Number.isNaN(b) && value >= a && value <= b) return true;
    } else if (parseInt(part, 10) === value) {
      return true;
    }
  }
  return false;
}

function cronMatches(expr: string, at: Date): boolean {
  if (!validateCronExpression(expr)) return false;
  const [min, hour, dom, mon, dow] = expr.trim().split(/\s+/);
  return (
    fieldMatch(min, at.getMinutes()) &&
    fieldMatch(hour, at.getHours()) &&
    fieldMatch(dom, at.getDate()) &&
    fieldMatch(mon, at.getMonth() + 1) &&
    fieldMatch(dow, at.getDay())
  );
}

function currentMinuteKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function loadCronJobs(): CronJobRecord[] {
  if (!existsSync(CRON_FILE)) return [];
  try {
    const parsed = matter(readFileSync(CRON_FILE, 'utf-8'));
    return Array.isArray(parsed.data.jobs) ? (parsed.data.jobs as CronJobRecord[]) : [];
  } catch {
    return [];
  }
}

function appendRunLog(jobName: string, payload: Record<string, unknown>): void {
  ensureDir(CRON_RUNS_DIR);
  const filePath = path.join(CRON_RUNS_DIR, `${jobName.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  writeFileSync(filePath, `${existing}${JSON.stringify(payload)}\n`, 'utf-8');
}

async function runCronJob(assistant: ClementineAssistant, job: CronJobRecord, source: 'schedule' | 'trigger'): Promise<void> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  try {
    const prompt = [
      `Cron job: ${job.name}`,
      `Execution source: ${source}`,
      job.work_dir ? `Working directory context: ${job.work_dir}` : '',
      job.mode === 'unleashed' ? 'This is an unleashed/background job. Work through the task fully and leave a concise status/result.' : '',
      'Execute the following job prompt and produce a concise but substantive result.',
      '',
      job.prompt,
    ].filter(Boolean).join('\n');

    const response = await assistant.respond({
      sessionId: `cron:${job.name}`,
      channel: 'cron',
      message: prompt,
      model: job.mode === 'unleashed' ? MODELS.deep : MODELS.primary,
    });

    appendRunLog(job.name, {
      status: 'ok',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      source,
      response: response.text,
    });
    addNotification({
      id: `${Date.now()}-cron-${job.name}`,
      kind: 'cron',
      title: `Cron job completed: ${job.name}`,
      body: response.text.slice(0, 2000),
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { job: job.name, source },
    });
    logger.info({ job: job.name, source }, 'Cron job completed');
  } catch (error) {
    appendRunLog(job.name, {
      status: 'error',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      source,
      error: error instanceof Error ? error.message : String(error),
    });
    addNotification({
      id: `${Date.now()}-cron-${job.name}-error`,
      kind: 'cron',
      title: `Cron job failed: ${job.name}`,
      body: error instanceof Error ? error.message : String(error),
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { job: job.name, source, status: 'error' },
    });
    logger.error({ err: error, job: job.name, source }, 'Cron job failed');
  }
}

async function processCronSchedules(assistant: ClementineAssistant, state: DaemonState): Promise<void> {
  const now = new Date();
  const minuteKey = currentMinuteKey(now);
  const jobs = loadCronJobs();

  for (const job of jobs) {
    if (job.enabled === false) continue;
    if (!cronMatches(job.schedule, now)) continue;
    if (state.lastCronRunByMinute[job.name] === minuteKey) continue;
    state.lastCronRunByMinute[job.name] = minuteKey;
    saveState(state);
    await runCronJob(assistant, job, 'schedule');
  }
}

async function processCronTriggers(assistant: ClementineAssistant): Promise<void> {
  ensureDir(CRON_TRIGGERS_DIR);
  const jobs = loadCronJobs();
  for (const file of readdirSync(CRON_TRIGGERS_DIR).filter((entry) => entry.endsWith('.json'))) {
    const filePath = path.join(CRON_TRIGGERS_DIR, file);
    try {
      const payload = JSON.parse(readFileSync(filePath, 'utf-8')) as { jobName?: string };
      const job = jobs.find((entry) => entry.name === payload.jobName);
      if (job) {
        await runCronJob(assistant, job, 'trigger');
      }
    } catch (error) {
      logger.warn({ err: error, file }, 'Failed to process cron trigger');
    } finally {
      rmSync(filePath, { force: true });
    }
  }
}

// Workflow execution lives in src/execution/workflow-runner.ts now —
// the new runner supports per-step forEach fan-out, deterministic
// scripted steps, and append-only events.jsonl for resume after
// daemon restart (research_bot/manager.py pattern). The inline
// sequential runner that lived here has been retired.

async function processNotificationDeliveries(): Promise<void> {
  const queue = listQueuedNotificationDeliveries();
  if (queue.length === 0) return;

  const nextQueue: typeof queue = [];
  for (const job of queue) {
    const notification = getNotification(job.notificationId);
    if (!notification) {
      continue;
    }

    const destinations = getNotificationDestinationsForRecord(notification);
    if (destinations.length === 0) {
      // No destinations resolved — this used to silently drop jobs forever,
      // which is how cron notifications went missing all morning. Now we
      // log it so the issue is visible, and drop the job (next addNotification
      // will be a fresh attempt if destinations get configured).
      logger.warn({
        notificationId: notification.id,
        kind: notification.kind,
        title: notification.title,
      }, 'No notification destinations resolved — message will not be delivered. Configure a destination or set DISCORD_DM_ALLOWED_USERS.');
      continue;
    }
    const now = new Date();
    const completed = new Set(job.completedDestinationIds ?? []);
    const failed = new Set(job.failedDestinationIds ?? []);
    const attemptCountByDestination = { ...(job.attemptCountByDestination ?? {}) };
    const nextAttemptAtByDestination = { ...(job.nextAttemptAtByDestination ?? {}) };
    const lastErrorByDestination = { ...(job.lastErrorByDestination ?? {}) };
    const successfulDestinations: string[] = [];
    let lastError = '';
    let attemptedThisPass = 0;

    for (const destination of destinations) {
      if (completed.has(destination.id) || failed.has(destination.id)) {
        continue;
      }

      const nextAttemptAt = nextAttemptAtByDestination[destination.id];
      if (nextAttemptAt && new Date(nextAttemptAt).getTime() > now.getTime()) {
        continue;
      }

      attemptedThisPass += 1;
      attemptCountByDestination[destination.id] = (attemptCountByDestination[destination.id] ?? 0) + 1;

      try {
        await deliverNotificationToDestination(notification, destination);
        completed.add(destination.id);
        delete nextAttemptAtByDestination[destination.id];
        delete lastErrorByDestination[destination.id];
        successfulDestinations.push(destination.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = message;
        lastErrorByDestination[destination.id] = message;

        if (attemptCountByDestination[destination.id] >= DELIVERY_MAX_ATTEMPTS) {
          failed.add(destination.id);
        } else {
          const retryDelayMinutes = Math.min(60, 2 ** (attemptCountByDestination[destination.id] - 1));
          nextAttemptAtByDestination[destination.id] = new Date(now.getTime() + retryDelayMinutes * 60_000).toISOString();
        }
      }
    }

    job.completedDestinationIds = [...completed];
    job.failedDestinationIds = [...failed];
    job.attemptCountByDestination = attemptCountByDestination;
    job.nextAttemptAtByDestination = nextAttemptAtByDestination;
    job.lastErrorByDestination = lastErrorByDestination;

    const allDestinationIds = destinations.map((destination) => destination.id);
    const terminal = allDestinationIds.every((id) => completed.has(id) || failed.has(id));
    const totalAttempts = Object.values(attemptCountByDestination).reduce((sum, value) => sum + value, 0);

    updateNotificationDeliveryStatus(notification.id, {
      deliveredAt: successfulDestinations.length > 0 ? new Date().toISOString() : notification.deliveredAt,
      deliveryAttempts: totalAttempts,
      deliveryError: lastError || (failed.size > 0 ? 'One or more destinations permanently failed' : undefined),
      deliveredDestinations: successfulDestinations,
    });

    if (terminal) {
      continue;
    }

    nextQueue.push(job);
  }

  replaceQueuedNotificationDeliveries(nextQueue);
}

export async function startDaemon(assistant: ClementineAssistant): Promise<void> {
  ensureDir(CRON_PROGRESS_DIR);
  const state = loadState();
  const interrupted = interruptStaleRunningBackgroundTasks();
  if (interrupted > 0) {
    logger.warn({ interrupted }, 'Marked stale running background tasks as interrupted');
  }
  // Sweep records that got stuck active across a previous crash/restart.
  // Without this, the dashboard "NOW" panel still reports phantom in-flight
  // work from runs that the model forgot to close out (executions) or that
  // the gateway never got to finishRun() on (runs).
  const sweptRuns = sweepStaleRuns();
  const sweptExecutions = sweepStaleExecutions();
  const sweptApprovals = sweepStaleApprovals();
  if (sweptRuns > 0 || sweptExecutions > 0 || sweptApprovals > 0) {
    logger.warn({ sweptRuns, sweptExecutions, sweptApprovals }, 'Auto-closed stale runs / executions / approvals on daemon start');
  }
  // First-tick init: ensure built-in proactive check-in templates
  // exist on disk (disabled). Re-runs are no-ops because the seeder
  // skips seededIds it already created.
  ensureSeedTemplates();

  // One-time migration: convert any legacy flat workflow .md files
  // into <name>/SKILL.md directories so the rest of the loader can
  // assume the Skills-spec layout. Idempotent; the original is kept
  // as <name>.md.bak for one clean boot, then removed.
  try {
    const migrated = migrateLegacyWorkflowsOnce();
    if (migrated.length > 0) {
      logger.info({ migrated }, 'Migrated legacy workflow .md files to SKILL.md directories');
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Workflow legacy migration failed (continuing)');
  }

  // Surface any in-flight workflow runs that didn't reach a terminal
  // state — daemon restart, crash, or kill mid-run. The runner picks
  // these up on the next tick and resumes from the last successful
  // step using the events.jsonl log.
  try {
    reconcilePendingWorkflowRuns();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Pending workflow run reconcile failed');
  }

  logger.info('Daemon loop started');

  // Stagger monitor runs — don't run them every 15s tick
  let tickCount = 0;

  while (true) {
    tickCount++;
    await processCronSchedules(assistant, state);
    await processCronTriggers(assistant);
    await processWorkflowRuns(assistant);
    await processBackgroundTasks(assistant);
    const proactivity = getProactivityPolicySnapshot();

    // Run monitors every 4 ticks (~60s) - they have their own internal rate limiting.
    if (proactivity.proactiveWorkAllowed && tickCount % 4 === 0) {
      processMonitors();
    }

    if (proactivity.proactiveWorkAllowed) {
      await processExecutionController(assistant);
      await processAgentAutonomy(assistant);
      // v2 runs in parallel with v1 - each agent is owned by exactly one
      // engine. v2 processes agents listed in AUTONOMY_V2_AGENTS env var;
      // v1 handles the rest. After a v2 cycle marks lastRunAt, v1 sees
      // the cadence as not-yet-due and skips that agent.
      await processAgentAutonomyV2();
      await processProactiveBriefs(assistant);
      // Evaluate user-defined check-in templates — fires open
      // questions through the existing check-in path when their
      // trigger (schedule / condition) is hot and cooldown elapsed.
      const checkInResult = processProactiveCheckIns();
      if (checkInResult.fired.length > 0) {
        logger.info({
          fired: checkInResult.fired.length,
          checkInIds: checkInResult.fired,
        }, 'proactive check-in templates fired');
      }
    } else if (tickCount % 20 === 0) {
      logger.info({
        enabled: proactivity.policy.enabled,
        quietHoursActive: proactivity.quietHoursActive,
      }, 'Proactive daemon work is paused by policy');
    }
    await processMemoryMaintenance(tickCount);
    await processNotificationDeliveries();
    // Periodic stale-record sweep: cheap (one JSON load + a filter) and
    // bounded — only writes when something actually expired. Every 60 ticks
    // ≈ 15 minutes, which is plenty fast for dashboard correctness without
    // hammering disk.
    if (tickCount % 60 === 0) {
      const sweptRuns = sweepStaleRuns();
      const sweptExecutions = sweepStaleExecutions();
      const sweptApprovals = sweepStaleApprovals();
      if (sweptRuns > 0 || sweptExecutions > 0 || sweptApprovals > 0) {
        logger.warn({ sweptRuns, sweptExecutions, sweptApprovals }, 'Periodic stale-record sweep auto-closed records');
      }
    }
    await sleep(15_000);
  }
}
