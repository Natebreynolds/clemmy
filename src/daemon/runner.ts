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
import { MODELS } from '../config.js';
import { processExecutionController } from '../execution/controller.js';
import { interruptStaleRunningBackgroundTasks, processBackgroundTasks } from '../execution/background-tasks.js';
import { processMemoryMaintenance } from '../memory/maintenance.js';
import {
  CRON_FILE,
  WORKFLOWS_DIR,
} from '../memory/vault.js';
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

interface WorkflowStepInput {
  id: string;
  prompt: string;
  dependsOn?: string[];
  model?: string;
  tier?: number;
  maxTurns?: number;
}

interface WorkflowFile {
  name: string;
  description: string;
  enabled: boolean;
  trigger: { schedule?: string; manual?: boolean };
  steps: WorkflowStepInput[];
  inputs?: Record<string, { type?: 'string' | 'number'; default?: string; description?: string }>;
  synthesis?: { prompt?: string };
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

function listWorkflowFiles(): Array<{ filePath: string; data: WorkflowFile }> {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  const items: Array<{ filePath: string; data: WorkflowFile }> = [];
  for (const file of readdirSync(WORKFLOWS_DIR).filter((entry) => entry.endsWith('.md'))) {
    try {
      const filePath = path.join(WORKFLOWS_DIR, file);
      const parsed = matter(readFileSync(filePath, 'utf-8'));
      items.push({
        filePath,
        data: {
          name: String(parsed.data.name ?? path.basename(file, '.md')),
          description: String(parsed.data.description ?? ''),
          enabled: parsed.data.enabled !== false,
          trigger: typeof parsed.data.trigger === 'object' && parsed.data.trigger ? parsed.data.trigger as WorkflowFile['trigger'] : { manual: true },
          steps: Array.isArray(parsed.data.steps) ? parsed.data.steps as WorkflowStepInput[] : [],
          inputs: typeof parsed.data.inputs === 'object' && parsed.data.inputs ? parsed.data.inputs as WorkflowFile['inputs'] : undefined,
          synthesis: typeof parsed.data.synthesis === 'object' && parsed.data.synthesis ? parsed.data.synthesis as WorkflowFile['synthesis'] : undefined,
        },
      });
    } catch {
      continue;
    }
  }
  return items;
}

function renderTemplate(template: string, inputs: Record<string, string>, stepOutputs: Record<string, string>): string {
  return template
    .replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10))
    .replace(/\{\{input\.([a-zA-Z0-9_-]+)\}\}/g, (_match, key: string) => inputs[key] ?? '')
    .replace(/\{\{steps\.([a-zA-Z0-9_-]+)\.output\}\}/g, (_match, key: string) => stepOutputs[key] ?? '');
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

async function processWorkflowRuns(assistant: ClementineAssistant): Promise<void> {
  ensureDir(WORKFLOW_RUNS_DIR);
  const workflows = listWorkflowFiles();
  for (const file of readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'))) {
    const filePath = path.join(WORKFLOW_RUNS_DIR, file);
    let run: { id: string; workflow: string; inputs?: Record<string, string>; status?: string; createdAt?: string } | null = null;
    try {
      run = JSON.parse(readFileSync(filePath, 'utf-8')) as { id: string; workflow: string; inputs?: Record<string, string>; status?: string; createdAt?: string };
      if (run.status && run.status !== 'queued') continue;

      const workflow = workflows.find((entry) => entry.data.name === run?.workflow);
      if (!workflow || !workflow.data.enabled) {
        writeFileSync(filePath, JSON.stringify({ ...run, status: 'error', error: 'Workflow not found or disabled' }, null, 2), 'utf-8');
        continue;
      }

      const inputs = {
        ...Object.fromEntries(Object.entries(workflow.data.inputs ?? {}).map(([key, meta]) => [key, meta.default ?? ''])),
        ...(run.inputs ?? {}),
      };
      const stepOutputs: Record<string, string> = {};
      writeFileSync(filePath, JSON.stringify({ ...run, status: 'running', startedAt: new Date().toISOString() }, null, 2), 'utf-8');

      for (const step of workflow.data.steps) {
        const prompt = renderTemplate(step.prompt, inputs, stepOutputs);
        const response = await assistant.respond({
          sessionId: `workflow:${run.id}:${step.id}`,
          channel: 'workflow',
          message: `Workflow: ${workflow.data.name}\nStep: ${step.id}\n\n${prompt}`,
          model: step.model || MODELS.primary,
        });
        stepOutputs[step.id] = response.text;
      }

      let finalOutput = Object.entries(stepOutputs)
        .map(([stepId, output]) => `## ${stepId}\n${output}`)
        .join('\n\n');

      if (workflow.data.synthesis?.prompt) {
        const synthesisPrompt = renderTemplate(workflow.data.synthesis.prompt, inputs, stepOutputs);
        const synthesis = await assistant.respond({
          sessionId: `workflow:${run.id}:synthesis`,
          channel: 'workflow',
          message: `${synthesisPrompt}\n\nStep outputs:\n\n${finalOutput}`,
          model: MODELS.primary,
        });
        finalOutput = synthesis.text;
      }

      writeFileSync(filePath, JSON.stringify({
        ...run,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        stepOutputs,
        output: finalOutput,
      }, null, 2), 'utf-8');
      addNotification({
        id: `${Date.now()}-workflow-${run.id}`,
        kind: 'workflow',
        title: `Workflow completed: ${workflow.data.name}`,
        body: finalOutput.slice(0, 2000),
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { workflow: workflow.data.name, runId: run.id },
      });
      logger.info({ workflow: workflow.data.name, runId: run.id }, 'Workflow run completed');
    } catch (error) {
      logger.error({ err: error, file }, 'Workflow run failed');
      if (run) {
        writeFileSync(filePath, JSON.stringify({
          ...run,
          status: 'error',
          finishedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }, null, 2), 'utf-8');
        addNotification({
          id: `${Date.now()}-workflow-${run.id}-error`,
          kind: 'workflow',
          title: `Workflow failed: ${run.workflow}`,
          body: error instanceof Error ? error.message : String(error),
          createdAt: new Date().toISOString(),
          read: false,
          metadata: { workflow: run.workflow, runId: run.id, status: 'error' },
        });
      }
    }
  }
}

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
    } else if (tickCount % 20 === 0) {
      logger.info({
        enabled: proactivity.policy.enabled,
        quietHoursActive: proactivity.quietHoursActive,
      }, 'Proactive daemon work is paused by policy');
    }
    await processMemoryMaintenance(tickCount);
    await processNotificationDeliveries();
    await sleep(15_000);
  }
}
