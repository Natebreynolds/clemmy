import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getBackgroundTaskStatus,
  listBackgroundTaskStatusSummaries,
  renderBackgroundTaskStatus,
} from '../execution/background-task-status.js';
import { enqueueDurableChatTask } from '../execution/background-promote.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { textResult } from './shared.js';

const statusSchema = z.enum([
  'active',
  'pending',
  'running',
  'cancelling',
  'awaiting_approval',
  'awaiting_input',
  'awaiting_continue',
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

  server.tool(
    'dispatch_background_task',
    [
      'Hand an AGREED, multi-step task to the reliable background runner (fire-and-forget).',
      'Call this ONLY AFTER you and the user have aligned on what to do (CONVERSE FIRST) and they want it run in the background rather than waited-on here.',
      'It runs in the daemon — board-visible, survives a restart — and reports its outcome back to THIS chat automatically when it finishes (or if it gets stuck or needs your input).',
      'Pass the AGREED objective + the concrete steps you settled on (NOT the raw user message).',
      'After it returns: confirm to the user that it is running and that you will report back, then STOP — do NOT do the work yourself this turn, do NOT poll. The user is free to fire another task immediately.',
    ].join('\n'),
    {
      objective: z.string().min(4).describe('One line: what this run must achieve.'),
      plan: z.string().min(1).describe('The agreed steps/approach to execute (markdown bullets are fine). This was settled with the user — the worker follows it, it does not re-derive a different approach.'),
      success_criteria: z.array(z.string()).nullable().describe('Concrete done-checks; the run is complete only when all hold.'),
      context_refs: z.array(z.string()).nullable().describe('File paths, resource ids, or tool-call ids the worker should load first before producing artifacts.'),
      max_minutes: z.number().int().min(1).max(240).nullable().describe('Soft wall-clock budget; defaults to the policy long-task minutes.'),
    },
    async ({ objective, plan, success_criteria, context_refs, max_minutes }) => {
      const sessionId = getToolOutputContext()?.sessionId;
      if (!sessionId) {
        return textResult('I can only dispatch a background task from a live chat session (no session context here) — run the task directly instead.');
      }
      const composedPrompt = [
        `Objective: ${objective}`,
        '',
        'Agreed plan (execute these steps — this was settled with the user; do NOT re-derive a different approach):',
        plan,
        success_criteria && success_criteria.length > 0
          ? `\nSuccess criteria (the run is done only when ALL hold):\n- ${success_criteria.join('\n- ')}`
          : '',
        context_refs && context_refs.length > 0
          ? `\nLoad this context FIRST, before producing any artifact:\n- ${context_refs.join('\n- ')}`
          : '',
      ].filter(Boolean).join('\n');

      const task = enqueueDurableChatTask({
        message: objective,
        composedPrompt,
        sessionId,
        source: 'desktop',
        maxMinutes: max_minutes ?? undefined,
      });

      return textResult(
        `Dispatched "${task.title}" to the background (task ${task.id}). It's running in the daemon now and will report its result back HERE automatically when it finishes — or pause and ask you here if it needs a decision. `
        + `Tell the user it's on it and that you'll report back; do NOT wait, poll, or do the work yourself this turn — you're free to take their next request right now. It's also watchable on the Tasks board.`,
      );
    },
  );
}
