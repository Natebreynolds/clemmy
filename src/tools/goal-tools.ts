import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GOALS_DIR, ensureDir, textResult } from './shared.js';

interface GoalRecord {
  id: string;
  title: string;
  description: string;
  owner: string;
  priority: 'high' | 'medium' | 'low';
  status: 'active' | 'paused' | 'completed' | 'blocked';
  createdAt: string;
  updatedAt: string;
  targetDate?: string;
  reviewFrequency: 'daily' | 'weekly' | 'on-demand';
  progressNotes: string[];
  nextActions: string[];
  blockers: string[];
  linkedCronJobs: string[];
  autoSchedule?: boolean;
}

function readGoal(id: string): GoalRecord | null {
  const filePath = path.join(GOALS_DIR, `${id}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8')) as GoalRecord;
}

function writeGoal(goal: GoalRecord): void {
  ensureDir(GOALS_DIR);
  writeFileSync(path.join(GOALS_DIR, `${goal.id}.json`), JSON.stringify(goal, null, 2), 'utf-8');
}

export function registerGoalTools(server: McpServer): void {
  server.tool(
    'goal_create',
    'Create a persistent goal that survives across sessions and can drive proactive work.',
    {
      title: z.string().min(1),
      description: z.string().min(1),
      owner: z.string().optional(),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      targetDate: z.string().optional(),
      nextActions: z.array(z.string()).optional(),
      reviewFrequency: z.enum(['daily', 'weekly', 'on-demand']).optional(),
      linkedCronJobs: z.array(z.string()).optional(),
      autoSchedule: z.boolean().optional(),
    },
    async ({ title, description, owner, priority, targetDate, nextActions, reviewFrequency, linkedCronJobs, autoSchedule }) => {
      const now = new Date().toISOString();
      const goal: GoalRecord = {
        id: randomBytes(4).toString('hex'),
        title,
        description,
        owner: owner || 'clementine',
        priority: priority || 'medium',
        status: 'active',
        createdAt: now,
        updatedAt: now,
        targetDate,
        reviewFrequency: reviewFrequency || 'weekly',
        progressNotes: [],
        nextActions: nextActions || [],
        blockers: [],
        linkedCronJobs: linkedCronJobs || [],
        autoSchedule,
      };
      writeGoal(goal);
      return textResult(`Goal created: "${goal.title}" (ID: ${goal.id})`);
    },
  );

  server.tool(
    'goal_update',
    'Update an existing goal: status, progress, next actions, blockers, or linked cron jobs.',
    {
      id: z.string().min(1),
      status: z.enum(['active', 'paused', 'completed', 'blocked']).optional(),
      progressNote: z.string().optional(),
      nextActions: z.array(z.string()).optional(),
      blockers: z.array(z.string()).optional(),
      linkedCronJobs: z.array(z.string()).optional(),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      autoSchedule: z.boolean().optional(),
    },
    async ({ id, status, progressNote, nextActions, blockers, linkedCronJobs, priority, autoSchedule }) => {
      const goal = readGoal(id);
      if (!goal) return textResult(`Goal not found: ${id}`);

      if (status) goal.status = status;
      if (progressNote) goal.progressNotes.push(`[${new Date().toISOString().slice(0, 16)}] ${progressNote}`);
      if (nextActions) goal.nextActions = nextActions;
      if (blockers) goal.blockers = blockers;
      if (linkedCronJobs) goal.linkedCronJobs = linkedCronJobs;
      if (priority) goal.priority = priority;
      if (autoSchedule !== undefined) goal.autoSchedule = autoSchedule;
      goal.updatedAt = new Date().toISOString();
      writeGoal(goal);

      return textResult(`Goal "${goal.title}" updated (status: ${goal.status}).`);
    },
  );

  server.tool(
    'goal_list',
    'List persistent goals, optionally filtered by owner or status.',
    {
      owner: z.string().optional(),
      status: z.enum(['active', 'paused', 'completed', 'blocked']).optional(),
    },
    async ({ owner, status }) => {
      ensureDir(GOALS_DIR);
      const goals = readdirSync(GOALS_DIR)
        .filter((file) => file.endsWith('.json'))
        .map((file) => JSON.parse(readFileSync(path.join(GOALS_DIR, file), 'utf-8')) as GoalRecord)
        .filter((goal) => !owner || goal.owner === owner)
        .filter((goal) => !status || goal.status === status);

      if (goals.length === 0) {
        return textResult('No goals found matching the criteria.');
      }

      return textResult(
        goals
          .map((goal) => {
            const nextAction = goal.nextActions[0] ? ` | Next: ${goal.nextActions[0]}` : '';
            return `- [${goal.status.toUpperCase()}] ${goal.title} (${goal.id}) | ${goal.priority} | owner: ${goal.owner}${nextAction}`;
          })
          .join('\n'),
      );
    },
  );

  server.tool(
    'goal_get',
    'Get a single goal with description, progress notes, next actions, blockers, and linked cron jobs.',
    {
      id: z.string().min(1),
    },
    async ({ id }) => {
      const goal = readGoal(id);
      if (!goal) return textResult(`Goal not found: ${id}`);

      const sections = [
        `# ${goal.title}`,
        `ID: ${goal.id} | Status: ${goal.status} | Priority: ${goal.priority} | Owner: ${goal.owner}`,
        `Created: ${goal.createdAt} | Updated: ${goal.updatedAt}${goal.targetDate ? ` | Target: ${goal.targetDate}` : ''}`,
        '',
        '## Description',
        goal.description,
      ];

      if (goal.progressNotes.length > 0) {
        sections.push('', '## Progress Notes', ...goal.progressNotes.map((note) => `- ${note}`));
      }
      if (goal.nextActions.length > 0) {
        sections.push('', '## Next Actions', ...goal.nextActions.map((action) => `- [ ] ${action}`));
      }
      if (goal.blockers.length > 0) {
        sections.push('', '## Blockers', ...goal.blockers.map((blocker) => `- ${blocker}`));
      }
      if (goal.linkedCronJobs.length > 0) {
        sections.push('', '## Linked Cron Jobs', ...goal.linkedCronJobs.map((job) => `- ${job}`));
      }

      return textResult(sections.join('\n'));
    },
  );
}
