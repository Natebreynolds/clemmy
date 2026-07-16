import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GOALS_DIR, ensureDir, textResult } from './shared.js';
import type { GoalRecord } from '../memory/goals-list.js';

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
    'goal_upsert',
    'Create or update a persistent goal (one that survives across sessions and can drive proactive work). Omit `id` to CREATE a new goal (title + description required). Pass an existing `id` to UPDATE that goal — only the fields you provide change; `progressNote` is appended to the goal\'s progress log, while nextActions/blockers/linkedCronJobs replace.',
    {
      id: z.string().min(1).optional().describe('Existing goal id to UPDATE. Omit to create a new goal.'),
      title: z.string().min(1).optional().describe('Required when creating (no id). On update, renames the goal.'),
      description: z.string().min(1).optional().describe('Required when creating (no id). On update, replaces the description.'),
      owner: z.string().optional(),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      status: z.enum(['active', 'paused', 'completed', 'blocked']).optional().describe('Update-only: goal lifecycle status. New goals start active.'),
      targetDate: z.string().optional(),
      nextActions: z.array(z.string()).optional().describe('Replaces the goal\'s next-actions list.'),
      progressNote: z.string().optional().describe('Update-only: appended (timestamped) to the goal\'s progress log.'),
      blockers: z.array(z.string()).optional().describe('Replaces the goal\'s blockers list.'),
      reviewFrequency: z.enum(['daily', 'weekly', 'on-demand']).optional(),
      linkedCronJobs: z.array(z.string()).optional().describe('Replaces the goal\'s linked cron jobs.'),
      autoSchedule: z.boolean().optional(),
    },
    async ({ id, title, description, owner, priority, status, targetDate, nextActions, progressNote, blockers, reviewFrequency, linkedCronJobs, autoSchedule }) => {
      const now = new Date().toISOString();

      // UPDATE path — an id was supplied.
      if (id) {
        const goal = readGoal(id);
        if (!goal) return textResult(`Goal not found: ${id}. Omit id to create a new goal.`);
        if (title) goal.title = title;
        if (description) goal.description = description;
        if (owner) goal.owner = owner;
        if (priority) goal.priority = priority;
        if (status) goal.status = status;
        if (targetDate !== undefined) goal.targetDate = targetDate;
        if (progressNote) goal.progressNotes.push(`[${now.slice(0, 16)}] ${progressNote}`);
        if (nextActions) goal.nextActions = nextActions;
        if (blockers) goal.blockers = blockers;
        if (reviewFrequency) goal.reviewFrequency = reviewFrequency;
        if (linkedCronJobs) goal.linkedCronJobs = linkedCronJobs;
        if (autoSchedule !== undefined) goal.autoSchedule = autoSchedule;
        goal.updatedAt = now;
        writeGoal(goal);
        return textResult(`Goal "${goal.title}" updated (status: ${goal.status}).`);
      }

      // CREATE path — no id.
      if (!title || !description) {
        return textResult('To create a goal, provide both `title` and `description` (or pass an `id` to update an existing goal).');
      }
      const goal: GoalRecord = {
        id: randomBytes(4).toString('hex'),
        title,
        description,
        owner: owner || 'clementine',
        priority: priority || 'medium',
        status: status || 'active',
        createdAt: now,
        updatedAt: now,
        targetDate,
        reviewFrequency: reviewFrequency || 'weekly',
        progressNotes: progressNote ? [`[${now.slice(0, 16)}] ${progressNote}`] : [],
        nextActions: nextActions || [],
        blockers: blockers || [],
        linkedCronJobs: linkedCronJobs || [],
        autoSchedule,
      };
      writeGoal(goal);
      return textResult(`Goal created: "${goal.title}" (ID: ${goal.id})`);
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
}
