import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ExecutionStore } from '../execution/store.js';
import { loadSessionBrief, listSessionBriefs, refreshSessionBrief, renderSessionResume, saveSessionManualHandoff } from '../memory/session-briefs.js';
import { PlanStore } from '../planning/plan-store.js';
import { GOALS_DIR, INBOX_DIR, TASKS_FILE, ensureDir, parseTasks, sessions, textResult } from './shared.js';

interface GoalRecord {
  id: string;
  title: string;
  owner: string;
  priority: 'high' | 'medium' | 'low';
  status: 'active' | 'paused' | 'completed' | 'blocked';
  updatedAt: string;
  reviewFrequency: 'daily' | 'weekly' | 'on-demand';
  nextActions: string[];
  blockers: string[];
}

interface DiscoveredWorkItem {
  type: string;
  urgency: number;
  description: string;
}

function daysSince(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Math.floor((Date.now() - parsed) / 86_400_000));
}

function readGoals(): GoalRecord[] {
  ensureDir(GOALS_DIR);
  return readdirSync(GOALS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      try {
        return JSON.parse(readFileSync(path.join(GOALS_DIR, file), 'utf-8')) as GoalRecord;
      } catch {
        return null;
      }
    })
    .filter((goal): goal is GoalRecord => goal !== null);
}

function collectGoalWork(items: DiscoveredWorkItem[]): void {
  for (const goal of readGoals()) {
    if (goal.status !== 'active' && goal.status !== 'blocked') continue;

    const staleDays = daysSince(goal.updatedAt);
    const staleThreshold = goal.reviewFrequency === 'daily' ? 1 : goal.reviewFrequency === 'weekly' ? 7 : 30;
    const priorityWeight = goal.priority === 'high' ? 2 : goal.priority === 'medium' ? 1 : 0;

    if (goal.status === 'blocked' && goal.blockers[0]) {
      items.push({
        type: 'blocked-goal',
        urgency: Math.min(5, 4 + priorityWeight),
        description: `${goal.title} is blocked: ${goal.blockers[0]}`,
      });
      continue;
    }

    if (staleDays > staleThreshold) {
      const nextAction = goal.nextActions[0] ? ` | Next: ${goal.nextActions[0]}` : '';
      items.push({
        type: 'stale-goal',
        urgency: Math.min(5, 2 + priorityWeight + Math.floor(staleDays / Math.max(staleThreshold, 1))),
        description: `${goal.title} has been quiet for ${staleDays}d${nextAction}`,
      });
    }
  }
}

function collectTaskWork(items: DiscoveredWorkItem[]): void {
  if (!existsSync(TASKS_FILE)) return;

  const pendingTasks = parseTasks(readFileSync(TASKS_FILE, 'utf-8')).filter((task) => task.status === 'pending');
  const today = new Date().toISOString().slice(0, 10);
  const overdue = pendingTasks.filter((task) => task.dueDate && task.dueDate < today);
  const dueToday = pendingTasks.filter((task) => task.dueDate === today);

  if (overdue.length > 0) {
    items.push({
      type: 'overdue-task',
      urgency: 5,
      description: `${overdue.length} task(s) are overdue in TASKS.md`,
    });
  }

  if (dueToday.length > 0) {
    items.push({
      type: 'due-today',
      urgency: 4,
      description: `${dueToday.length} task(s) are due today`,
    });
  }
}

function collectInboxWork(items: DiscoveredWorkItem[]): void {
  if (!existsSync(INBOX_DIR)) return;

  const inboxCount = readdirSync(INBOX_DIR).filter((file) => file.endsWith('.md')).length;
  if (inboxCount > 0) {
    items.push({
      type: 'inbox',
      urgency: Math.min(4, 1 + Math.floor(inboxCount / 3)),
      description: `${inboxCount} inbox item(s) still need triage`,
    });
  }
}

function collectPlanWork(items: DiscoveredWorkItem[]): void {
  const plans = new PlanStore().list(4);
  for (const plan of plans) {
    const activeStep = plan.steps.find((step) => step.status === 'in_progress');
    if (!activeStep) continue;
    items.push({
      type: 'active-plan',
      urgency: 3,
      description: `${plan.title} -> ${activeStep.text}`,
    });
  }
}

function collectExecutionWork(items: DiscoveredWorkItem[], sessionId?: string): void {
  const executions = new ExecutionStore()
    .list(10)
    .filter((execution) => !sessionId || execution.sessionId === sessionId)
    .filter((execution) => execution.status === 'active' || execution.status === 'blocked');

  for (const execution of executions) {
    const staleMinutes = Math.floor((Date.now() - new Date(execution.lastActivityAt).getTime()) / 60_000);
    items.push({
      type: execution.status === 'blocked' ? 'blocked-execution' : 'active-execution',
      urgency: execution.status === 'blocked' ? 5 : Math.min(5, 2 + Math.floor(staleMinutes / 60)),
      description: `${execution.title}${execution.nextStep ? ` -> ${execution.nextStep}` : ''}`,
    });
  }
}

function collectHandoffWork(items: DiscoveredWorkItem[], sessionId?: string): void {
  const briefs = sessionId
    ? [loadSessionBrief(sessionId)].filter((brief): brief is NonNullable<ReturnType<typeof loadSessionBrief>> => brief !== null)
    : listSessionBriefs(8);

  for (const brief of briefs) {
    const remaining = brief.manual?.remaining ?? [];
    const blockers = brief.manual?.blockers ?? [];
    const ageDays = daysSince(brief.manual?.pausedAt ?? brief.updatedAt);

    for (const item of remaining.slice(0, 4)) {
      items.push({
        type: 'session-handoff',
        urgency: Math.min(5, 3 + Math.min(ageDays, 2)),
        description: `${brief.sessionId}: ${item}`,
      });
    }

    for (const blocker of blockers.slice(0, 2)) {
      items.push({
        type: 'handoff-blocker',
        urgency: 5,
        description: `${brief.sessionId}: ${blocker}`,
      });
    }
  }
}

function renderDiscoveredWork(items: DiscoveredWorkItem[], limit: number): string {
  const ranked = items
    .sort((left, right) => right.urgency - left.urgency || left.description.localeCompare(right.description))
    .slice(0, limit);

  if (ranked.length === 0) {
    return 'No outstanding work discovered from handoffs, plans, goals, inbox, or tasks.';
  }

  return [
    `## Discovered Work (${ranked.length})`,
    ...ranked.map((item) => `- [${item.type}] Urgency ${item.urgency}/5: ${item.description}`),
  ].join('\n');
}

export function registerSessionTools(server: McpServer): void {
  server.tool(
    'session_history',
    'Read recent conversation history for a session.',
    {
      session_id: z.string().min(1),
      max_turns: z.number().int().min(1).max(40).optional(),
    },
    async ({ session_id, max_turns }) => {
      const transcript = sessions.recentTranscript(session_id, max_turns ?? 12);
      return textResult(transcript || 'No history yet for that session.');
    },
  );

  server.tool(
    'session_pause',
    'Save a structured handoff for a session so work can resume cleanly after context drift, a restart, or a channel handoff.',
    {
      session_id: z.string().min(1),
      completed: z.array(z.string()).min(1),
      remaining: z.array(z.string()).min(1),
      decisions: z.array(z.string()).optional(),
      blockers: z.array(z.string()).optional(),
      context: z.string().optional(),
    },
    async ({ session_id, completed, remaining, decisions, blockers, context }) => {
      const session = sessions.get(session_id);
      const brief = saveSessionManualHandoff({
        session,
        completed,
        remaining,
        decisions,
        blockers,
        context,
      });

      return textResult(
        [
          `Handoff saved for ${session_id}.`,
          `Completed: ${brief.manual?.completed.length ?? 0}`,
          `Remaining: ${brief.manual?.remaining.length ?? 0}`,
          brief.manual?.blockers.length ? `Blockers: ${brief.manual.blockers.length}` : '',
        ].filter(Boolean).join('\n'),
      );
    },
  );

  server.tool(
    'session_resume',
    'Summarize a session using its continuity brief and recent transcript so work can resume cleanly.',
    {
      session_id: z.string().min(1),
    },
    async ({ session_id }) => {
      const session = sessions.get(session_id);
      if (session.turns.length === 0) {
        return textResult('No prior activity for that session.');
      }

      const brief = loadSessionBrief(session_id) ?? refreshSessionBrief(session);
      return textResult(renderSessionResume(session, brief));
    },
  );

  server.tool(
    'discover_work',
    'Scan handoffs, plans, goals, tasks, and inbox items to find prioritized work that should be advanced next.',
    {
      session_id: z.string().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async ({ session_id, limit }) => {
      const items: DiscoveredWorkItem[] = [];
      collectHandoffWork(items, session_id);
      collectExecutionWork(items, session_id);
      collectPlanWork(items);
      collectGoalWork(items);
      collectTaskWork(items);
      collectInboxWork(items);
      return textResult(renderDiscoveredWork(items, limit ?? 10));
    },
  );
}
