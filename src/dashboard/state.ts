import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { BASE_DIR } from '../config.js';
import { CRON_FILE } from '../memory/vault.js';
import { listWorkflows } from '../memory/workflow-store.js';
import { listNotificationDestinations, listNotifications, listQueuedNotificationDeliveries } from '../runtime/notifications.js';
import { getWorkspaceDirs, listWorkspaceProjects, loadTeamAgents } from '../tools/shared.js';
import { countDiscordSessions, listDiscordSessions } from '../channels/discord-store.js';
import { getDiscordRuntimeStatus } from '../channels/discord.js';
import { getSlackRuntimeStatus } from '../channels/slack.js';
import { getAuthStatus } from '../runtime/auth-store.js';
import { listAgentInboxCounts, listAgentStates } from '../agents/agent-state.js';
import { getConfiguredDiscordInstallInfo } from '../channels/discord-install.js';
import { ExecutionStore } from '../execution/store.js';
import { isUserFacingExecution } from '../execution/scope.js';
import { listBackgroundTasks } from '../execution/background-tasks.js';
import { countSessionBriefs, listSessionBriefs, loadSessionBrief, refreshSessionBrief } from '../memory/session-briefs.js';
import { SessionStore } from '../memory/session-store.js';
import { readMemoryIndexStatus } from '../memory/indexer.js';
import { buildComposioDashboardSnapshot } from '../integrations/composio/client.js';
import { computeAvailability, loadToolPreferences } from '../integrations/tool-preferences.js';
import { discoverMcpServers } from '../runtime/mcp-config.js';
import { getCoreToolsAsync } from '../tools/registry.js';
import { listRuns } from '../runtime/run-events.js';
import { listGlobalCliStatus } from '../setup/capability-status.js';
import { getProactivityPolicySnapshot } from '../agents/proactivity-policy.js';
import { getProactiveBriefState } from '../agents/proactive-briefs.js';

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

function toolCategory(name: string): string {
  if (name.startsWith('composio_') || name.startsWith('cx_')) return 'Connected apps';
  if (name.startsWith('browser_harness')) return 'Browser';
  if (['workspace_roots', 'list_files', 'read_file', 'write_file', 'run_shell_command', 'git_status', 'workspace_config', 'workspace_list', 'workspace_info'].includes(name)) return 'Computer';
  if (name.startsWith('memory_') || name === 'working_memory' || name.startsWith('note_')) return 'Memory';
  if (name.startsWith('task_') || name.includes('plan') || name === 'discover_work' || name.startsWith('goal_')) return 'Planning';
  if (name.startsWith('team_') || name.includes('agent') || name.includes('delegation')) return 'Agents';
  if (name.startsWith('cron_') || name.startsWith('workflow_') || name === 'set_timer' || name === 'trigger_cron_job' || name === 'add_cron_job') return 'Automation';
  return 'Core';
}

async function listRuntimeTools(): Promise<Array<{ name: string; description: string; category: string }>> {
  return (await getCoreToolsAsync({ includeDynamicComposioTools: false }))
    .filter((item) => item.type === 'function')
    .map((item) => ({
      name: item.name,
      description: item.description ?? '',
      category: toolCategory(item.name),
    }))
    .sort((left, right) => left.category.localeCompare(right.category) || left.name.localeCompare(right.name));
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
  return listWorkflows()
    .map((entry) => ({
      name: entry.data.name,
      description: entry.data.description,
      enabled: entry.data.enabled !== false,
      trigger: entry.data.trigger ?? { manual: true },
      steps: entry.data.steps.map((step) => ({ id: step.id, prompt: step.prompt })),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function buildDashboardSnapshot() {
  const sessionStore = new SessionStore();
  const executionStore = new ExecutionStore();
  for (const session of sessionStore.list(12)) {
    if (session.turns.length === 0 || loadSessionBrief(session.id)) continue;
    refreshSessionBrief(session);
  }

  const composio = await buildComposioDashboardSnapshot();
  const toolPreferences = loadToolPreferences();
  const activeComposioSlugs = new Set(composio.connected
    .filter((connection) => connection.status === 'ACTIVE')
    .map((connection) => connection.slug));
  const activeMcpNames = new Set(discoverMcpServers()
    .filter((server) => server.enabled)
    .map((server) => server.name));
  const serviceAvailability = computeAvailability(activeComposioSlugs, activeMcpNames, toolPreferences.preferences);

  return {
    proactivity: getProactivityPolicySnapshot(),
    proactiveBrief: getProactiveBriefState(),
    daemonState: readDaemonState(),
    agents: loadTeamAgents(),
    cronJobs: loadCronJobs(),
    workflows: loadWorkflows(),
    recentCronRuns: readRecentJsonLines(CRON_RUNS_DIR, 12),
    recentWorkflowRuns: readWorkflowRuns(12),
    notifications: listNotifications(20),
    notificationDestinations: listNotificationDestinations(),
    queuedNotificationDeliveries: listQueuedNotificationDeliveries(),
    discord: {
      ...getConfiguredDiscordInstallInfo(),
      ...getDiscordRuntimeStatus(),
    },
    slack: getSlackRuntimeStatus(),
    auth: getAuthStatus(),
    agentStates: listAgentStates(),
    agentInboxCounts: listAgentInboxCounts(),
    recentDiscordSessions: listDiscordSessions(20),
    discordSessionCount: countDiscordSessions(),
    recentSessionBriefs: listSessionBriefs(12),
    sessionBriefCount: countSessionBriefs(),
    memoryIndex: readMemoryIndexStatus(),
    workspaces: getWorkspaceDirs(),
    workspaceProjects: listWorkspaceProjects().slice(0, 50),
    globalClis: listGlobalCliStatus(),
    activeExecutions: executionStore.list(12).filter((execution) =>
      (execution.status === 'active' || execution.status === 'blocked') &&
      isUserFacingExecution(execution),
    ),
    executionCount: executionStore.list(200).length,
    backgroundTasks: listBackgroundTasks().slice(0, 40),
    recentRuns: listRuns(20),
    runtimeTools: await listRuntimeTools(),
    composio,
    toolPreferences: {
      preferences: toolPreferences.preferences,
      services: serviceAvailability.map((availability) => ({
        id: availability.service.id,
        label: availability.service.label,
        composio: availability.service.composioSlug
          ? { slug: availability.service.composioSlug, available: availability.composioAvailable }
          : null,
        mcp: availability.service.mcpServerNames?.length
          ? { names: availability.service.mcpServerNames, available: availability.mcpAvailable }
          : null,
        hasConflict: availability.hasConflict,
        effective: availability.effective,
      })),
    },
  };
}
