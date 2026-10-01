import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GOALS_DIR, ensureDir, textResult } from './shared.js';
import { upsertGoalRecord, type GoalRecord } from '../memory/goals-list.js';

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
    async (patch) => {
      const result = upsertGoalRecord(patch);
      if (!result.ok) return textResult(result.reason);
      return textResult(result.created
        ? `Goal created: "${result.goal.title}" (ID: ${result.goal.id})`
        : `Goal "${result.goal.title}" updated (status: ${result.goal.status}).`);
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
