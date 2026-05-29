import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getBackgroundTaskStatus,
  listBackgroundTaskStatusSummaries,
  renderBackgroundTaskStatus,
} from '../execution/background-task-status.js';
import { textResult } from './shared.js';

const statusSchema = z.enum([
  'active',
  'pending',
  'running',
  'cancelling',
  'awaiting_approval',
  'done',
  'failed',
  'aborted',
  'interrupted',
  'all',
]);

export function registerBackgroundTaskTools(server: McpServer): void {
  server.tool(
    'background_tasks_recent',
    'List recent durable background tasks with status, latest activity, approvals, and result preview. Use this when the user asks what Clementine is working on, what finished, or what is running in the background.',
    {
      status: statusSchema.nullable(),
      limit: z.number().int().min(1).max(50).nullable(),
    },
    async ({ status, limit }) => {
      const details = listBackgroundTaskStatusSummaries({
        status: status ?? 'active',
        limit: limit ?? 10,
      });
      if (details.length === 0) {
        return textResult('No matching background tasks found.');
      }

      const lines = details.map((item) => {
        const task = item.task;
        const approvalSuffix = item.pendingApprovals.length > 0
          ? ` | approvals: ${item.pendingApprovals.map((approval) => approval.approvalId).join(', ')}`
          : '';
        const activity = item.latestActivitySummary ? ` | latest: ${item.latestActivitySummary.slice(0, 180)}` : '';
        return `- ${task.id} [${task.status}] ${task.title}${approvalSuffix}${activity}`;
      });
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'background_task_status',
    'Inspect a durable background task by task id, run id, or session id. Includes recent tool activity, pending approvals, notifications, check-ins, and final result when available.',
    {
      id: z.string().nullable(),
    },
    async ({ id }) => {
      const details = getBackgroundTaskStatus(id ?? undefined);
      if (!details) {
        return textResult(id ? `No background task found for ${id}.` : 'No background tasks recorded yet.');
      }
      return textResult(renderBackgroundTaskStatus(details), { maxChars: 12_000 });
    },
  );
}
