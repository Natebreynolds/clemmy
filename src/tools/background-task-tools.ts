import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getBackgroundTaskStatus,
  listBackgroundTaskStatusSummaries,
  renderBackgroundTaskStatus,
} from '../execution/background-task-status.js';
import { enqueueDurableChatTask } from '../execution/background-promote.js';
import { bindBackgroundRunGoal, holdTaskForLater, listHeldTasks, getHeldTask } from '../agents/plan-proposals.js';
import { approvePlanAndQueueBackgroundTask } from '../execution/approved-plan-tasks.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { textResult } from './shared.js';

/** Split an agreed plan (markdown bullets / numbered lines) into discrete next
 *  actions for the goal contract's step list. Best-effort + bounded. */
function planToNextActions(plan: string): string[] {
  return plan
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 12);
}

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

      // Bind a durable goal contract to the task's RUN session so the unattended
      // run is goal-DRIVEN: it works until the success criteria validate (not one
      // pass) and reports back against them — "have the goal defined" before
      // backgrounding. Best-effort; on failure the task still runs on its prompt.
      const goal = bindBackgroundRunGoal(task.runSessionId, {
        objective,
        successCriteria: success_criteria ?? undefined,
        nextActions: planToNextActions(plan),
        originatingRequest: objective,
      });

      return textResult(
        `Dispatched "${task.title}" to the background (task ${task.id})`
        + (goal ? ' with a goal contract — it will keep working until the success criteria are met, not just run once' : '')
        + `. It's running in the daemon now and will report its result back HERE automatically when it finishes — or pause and ask you here if it needs a decision. `
        + `Tell the user it's on it and that you'll report back; do NOT wait, poll, or do the work yourself this turn — you're free to take their next request right now. It's also watchable on the Tasks board.`,
      );
    },
  );

  server.tool(
    'hold_task_for_later',
    [
      'HOLD an agreed multi-step task for later instead of running it now — the "or you can ask me later and I\'ll bring it back up" choice.',
      'Call this ONLY after you and the user aligned on the task AND they chose to hold it (not run it now, not background it now).',
      'Pass the AGREED objective + steps + success criteria you settled on. It is saved against this chat and shown in your Current Focus as a held task.',
      'The user resumes it whenever by reference ("pick up the Salesforce scrape") — you then call resume_held_task with its id, which dispatches it to the background bound to its goal. Confirm it is held, tell them how to bring it back, and STOP.',
    ].join('\n'),
    {
      objective: z.string().min(4).describe('One line: what the held task must achieve.'),
      steps: z.array(z.string()).nullable().describe('The agreed steps/approach (settled with the user).'),
      success_criteria: z.array(z.string()).nullable().describe('Concrete done-checks for when it is eventually run.'),
    },
    async ({ objective, steps, success_criteria }) => {
      const sessionId = getToolOutputContext()?.sessionId;
      if (!sessionId) {
        return textResult('I can only hold a task from a live chat session (no session context here).');
      }
      const held = holdTaskForLater({
        objective,
        steps: steps ?? undefined,
        successCriteria: success_criteria ?? undefined,
        sessionId,
        originatingRequest: objective,
      });
      if (!held) {
        return textResult('I could not hold that — give me a short objective and I\'ll keep it for later.');
      }
      return textResult(
        `Held "${held.plan.objective}" for later (id ${held.id}). It won't run until you bring it back — `
        + `just say "pick up ${held.plan.objective.slice(0, 40)}…" (or "what's on hold?") and I'll resume it, running it in the background then. `
        + `Tell the user it's saved + how to resume, and STOP.`,
      );
    },
  );

  server.tool(
    'resume_held_task',
    [
      'Resume a task the user previously asked you to HOLD (see your Current Focus "Held" list), now that they want it run.',
      'Pass the held task id (held-xxxx). It dispatches the held plan to the background bound to its goal contract — it runs until its criteria are met and reports back HERE.',
      'After it returns: confirm it is now running in the background and that you will report back, then STOP — do not do the work yourself this turn.',
    ].join('\n'),
    {
      id: z.string().min(1).describe('The held task id (held-xxxx) from your Current Focus held list.'),
    },
    async ({ id }) => {
      const held = getHeldTask(id);
      if (!held) {
        const sessionId = getToolOutputContext()?.sessionId;
        const open = sessionId ? listHeldTasks(sessionId) : [];
        return textResult(
          open.length > 0
            ? `No held task "${id}". Held right now: ${open.map((h) => `${h.id} — ${h.plan.objective.slice(0, 60)}`).join('; ')}.`
            : `No held task "${id}", and nothing is currently on hold.`,
        );
      }
      const result = approvePlanAndQueueBackgroundTask(id);
      if (!result) {
        return textResult(`I found the held task "${id}" but could not queue it — try again or re-state the task.`);
      }
      return textResult(
        `Picking "${result.task.title}" back up — it's now running in the background (task ${result.task.id}) bound to its goal, and will report back HERE when done. `
        + `Tell the user it's resumed + running; do NOT do the work yourself this turn.`,
      );
    },
  );
}
