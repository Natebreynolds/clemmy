import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { BASE_DIR } from '../config.js';
import { CRON_FILE, WORKFLOWS_DIR } from '../memory/vault.js';
import { listNotificationDestinations, listNotifications, listQueuedNotificationDeliveries } from '../runtime/notifications.js';
import { loadTeamAgents } from '../tools/shared.js';
import { countDiscordSessions, listDiscordSessions } from '../channels/discord-store.js';
import { getDiscordRuntimeStatus } from '../channels/discord.js';
import { getAuthStatus } from '../runtime/auth-store.js';
import { listAgentInboxCounts, listAgentStates } from '../agents/autonomy.js';

const CRON_RUNS_DIR = path.join(BASE_DIR, 'cron', 'runs');
const WORKFLOW_RUNS_DIR = path.join(BASE_DIR, 'workflows', 'runs');
const DAEMON_STATE_FILE = path.join(BASE_DIR, 'cron', 'daemon-state.json');

export const DASHBOARD_CRON_RUNS_DIR = CRON_RUNS_DIR;

interface CronJobRecord {
  name: string;
  schedule: string;
  prompt: string;
  tier?: number;
  enabled?: boolean;
  work_dir?: string;
  mode?: 'standard' | 'unleashed';
}

interface WorkflowStepInput {
  id: string;
  prompt: string;
}

interface WorkflowFile {
  name: string;
  description: string;
  enabled: boolean;
  trigger: { schedule?: string; manual?: boolean };
  steps: WorkflowStepInput[];
}

export function readRecentJsonLines(dir: string, limit = 10): Array<Record<string, unknown>> {
  if (!existsSync(dir)) return [];
  const records: Array<Record<string, unknown>> = [];

  for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.jsonl'))) {
    const filePath = path.join(dir, file);
    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).slice(-limit);
    for (const line of lines) {
      try {
        records.push({ file, ...(JSON.parse(line) as Record<string, unknown>) });
      } catch {
        continue;
      }
    }
  }

  return records
    .sort((left, right) => String(right.finishedAt ?? right.startedAt ?? '').localeCompare(String(left.finishedAt ?? left.startedAt ?? '')))
    .slice(0, limit);
}

export function readWorkflowRuns(limit = 10): Array<Record<string, unknown>> {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  return readdirSync(WORKFLOW_RUNS_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((file) => {
      try {
        return JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((record): record is Record<string, unknown> => record !== null)
    .sort((left, right) => String(right.finishedAt ?? right.startedAt ?? right.createdAt ?? '').localeCompare(String(left.finishedAt ?? left.startedAt ?? left.createdAt ?? '')))
    .slice(0, limit);
}

export function readDaemonState(): Record<string, unknown> {
  if (!existsSync(DAEMON_STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(DAEMON_STATE_FILE, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function loadCronJobs(): CronJobRecord[] {
  if (!existsSync(CRON_FILE)) return [];
  try {
    const parsed = matter(readFileSync(CRON_FILE, 'utf-8'));
    return Array.isArray(parsed.data.jobs) ? (parsed.data.jobs as CronJobRecord[]) : [];
  } catch {
    return [];
  }
}

export function loadWorkflows(): WorkflowFile[] {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  const workflows: WorkflowFile[] = [];
  for (const file of readdirSync(WORKFLOWS_DIR).filter((entry) => entry.endsWith('.md'))) {
    try {
      const parsed = matter(readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8'));
      workflows.push({
        name: String(parsed.data.name ?? path.basename(file, '.md')),
        description: String(parsed.data.description ?? ''),
        enabled: parsed.data.enabled !== false,
        trigger: typeof parsed.data.trigger === 'object' && parsed.data.trigger ? parsed.data.trigger as WorkflowFile['trigger'] : { manual: true },
        steps: Array.isArray(parsed.data.steps) ? parsed.data.steps as WorkflowStepInput[] : [],
      });
    } catch {
      continue;
    }
  }
  return workflows.sort((left, right) => left.name.localeCompare(right.name));
}

export function buildDashboardSnapshot() {
  return {
    daemonState: readDaemonState(),
    agents: loadTeamAgents(),
    cronJobs: loadCronJobs(),
    workflows: loadWorkflows(),
    recentCronRuns: readRecentJsonLines(CRON_RUNS_DIR, 12),
    recentWorkflowRuns: readWorkflowRuns(12),
    notifications: listNotifications(20),
    notificationDestinations: listNotificationDestinations(),
    queuedNotificationDeliveries: listQueuedNotificationDeliveries(),
    discord: getDiscordRuntimeStatus(),
    auth: getAuthStatus(),
    agentStates: listAgentStates(),
    agentInboxCounts: listAgentInboxCounts(),
    recentDiscordSessions: listDiscordSessions(20),
    discordSessionCount: countDiscordSessions(),
  };
}
