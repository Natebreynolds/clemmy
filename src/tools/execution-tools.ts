import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ExecutionStore } from '../execution/store.js';
import { textResult } from './shared.js';

/**
 * Execution-update tools for autonomy-v2.
 *
 * These give the agent the ability to drive a tracked execution
 * forward, cycle after cycle. Paired with the check-in mechanism
 * (ask_user_question) they implement the "never stops until done"
 * piece of the project vision:
 *
 *   - Agent picks up a task (execution exists)
 *   - Each cycle it advances the work or marks a real blocker
 *   - When stuck on missing info, it opens a check-in
 *   - When the answer arrives, it resumes (via the check_in_answered
 *     inbox item) and continues
 *   - When the success criteria are met, it calls execution_complete
 *
 * Creation is deliberately NOT exposed here — chat / webhook / cron
 * flows create executions today, and we don't want the autonomy loop
 * spawning new long-running work from a single cycle's signal. Same
 * reason `mark_blocked` is paired with a check-in: blocking should
 * surface a path to unblock.
 */

const store = new ExecutionStore();

export function registerExecutionTools(server: McpServer): void {
  server.tool(
    'execution_list',
    'List executions for inspection. Defaults to active + blocked; pass status="all" for everything. Use this to remind yourself what tasks are in flight.',
    {
      status: z.enum(['active', 'blocked', 'paused', 'completed', 'all']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ status, limit }) => {
      const wanted = status ?? 'all';
      const all = store.list(limit ?? 20);
      const filtered = wanted === 'all'
        ? all
        : wanted === 'active'
          // 'active' on its own means "in flight" — include blocked.
          ? all.filter((e) => e.status === 'active' || e.status === 'blocked')
          : all.filter((e) => e.status === wanted);
      if (filtered.length === 0) return textResult('No executions match.');
      const lines = filtered.map((e) => {
        const blocker = e.blocker ? ` | BLOCKED: ${e.blocker}` : '';
        const next = e.nextStep ? ` | next: ${e.nextStep}` : '';
        return `- ${e.id} [${e.status}] ${e.title}${next}${blocker}`;
      });
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'execution_get',
    'Fetch one execution by id with full context (objective, plan, next step, success criteria, blocker, last summary).',
    {
      id: z.string().min(1),
    },
    async ({ id }) => {
      const e = store.get(id);
      if (!e) return textResult(`No execution found with id ${id}.`);
      const lines = [
        `Execution ${e.id}`,
        `Title: ${e.title}`,
        `Status: ${e.status}`,
        `Objective: ${e.objective}`,
        e.reason ? `Reason: ${e.reason}` : '',
        e.successCriteria ? `Success criteria: ${e.successCriteria}` : '',
        e.nextStep ? `Next step: ${e.nextStep}` : '',
        e.blocker ? `Blocker: ${e.blocker}` : '',
        e.lastAssistantSummary ? `Last summary: ${e.lastAssistantSummary}` : '',
        `Updated: ${e.updatedAt}`,
      ].filter(Boolean);
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'execution_update_step',
    'Advance an execution: record the next concrete step and an optional summary of what just happened. Use this every cycle you make progress on a tracked execution so the work compounds.',
    {
      id: z.string().min(1),
      nextStep: z.string().min(3).max(400),
      summary: z.string().max(800).optional().describe('What you did this cycle. Becomes lastAssistantSummary on the execution.'),
    },
    async ({ id, nextStep, summary }) => {
      const e = store.get(id);
      if (!e) return textResult(`No execution found with id ${id}.`);
      if (e.status === 'completed' || e.status === 'paused') {
        return textResult(`Execution ${id} is ${e.status} — re-open it before updating.`);
      }
      const updated = store.update(id, {
        nextStep,
        lastAssistantSummary: summary ?? e.lastAssistantSummary,
        lastActivityAt: new Date().toISOString(),
        status: e.status === 'blocked' ? 'active' : e.status,
        blocker: e.status === 'blocked' ? undefined : e.blocker,
      });
      if (!updated) return textResult(`Failed to update execution ${id}.`);
      return textResult(`Execution ${id} advanced. Next step: ${updated.nextStep}`);
    },
  );

  server.tool(
    'execution_mark_blocked',
    'Mark an execution as blocked with a concrete blocker description. The user is notified. If the blocker requires a user answer, ALSO call ask_user_question with the contextExecutionId so the work can resume the moment the answer arrives.',
    {
      id: z.string().min(1),
      blocker: z.string().min(3).max(400),
    },
    async ({ id, blocker }) => {
      const e = store.get(id);
      if (!e) return textResult(`No execution found with id ${id}.`);
      if (e.status === 'completed') return textResult(`Execution ${id} is completed — nothing to block.`);
      const updated = store.update(id, {
        status: 'blocked',
        blocker,
        lastActivityAt: new Date().toISOString(),
      });
      return updated
        ? textResult(`Execution ${id} marked blocked: ${blocker}`)
        : textResult(`Failed to mark execution ${id} blocked.`);
    },
  );

  server.tool(
    'execution_complete',
    'Mark an execution as completed. ONLY use when the success criteria are genuinely met. Includes a final summary explaining what shipped.',
    {
      id: z.string().min(1),
      summary: z.string().min(8).max(1200),
    },
    async ({ id, summary }) => {
      const e = store.get(id);
      if (!e) return textResult(`No execution found with id ${id}.`);
      if (e.status === 'completed') return textResult(`Execution ${id} was already completed.`);
      const updated = store.update(id, {
        status: 'completed',
        lastAssistantSummary: summary,
        lastActivityAt: new Date().toISOString(),
        blocker: undefined,
      });
      return updated
        ? textResult(`Execution ${id} completed. ${summary}`)
        : textResult(`Failed to complete execution ${id}.`);
    },
  );
}

/**
 * Render active executions for an agent's session as a compact block
 * to splice into the autonomy cycle input. The agent uses this to
 * remember what tasks are in flight and to call execution_update_step
 * on the right one as it makes progress.
 */
export function renderActiveExecutionsForAgent(sessionId: string, maxChars = 1600): string {
  const all = store.list(40);
  const mine = all
    .filter((e) => e.sessionId === sessionId)
    .filter((e) => e.status === 'active' || e.status === 'blocked');

  if (mine.length === 0) return '';

  const lines = ['Active executions you are driving (advance these via execution_update_step or execution_complete):'];
  for (const e of mine) {
    const blocker = e.blocker ? ` | BLOCKED: ${e.blocker}` : '';
    const next = e.nextStep ? ` | next: ${e.nextStep}` : '';
    const success = e.successCriteria ? ` | done when: ${e.successCriteria}` : '';
    lines.push(`- ${e.id} [${e.status}] ${e.title}${next}${success}${blocker}`);
  }
  return lines.join('\n').slice(0, maxChars);
}

/**
 * Count active executions for a session. Used by the autonomy cycle to
 * pick a tighter default follow-up when work is in flight.
 */
export function activeExecutionCountForSession(sessionId: string): number {
  const all = store.list(40);
  return all
    .filter((e) => e.sessionId === sessionId)
    .filter((e) => e.status === 'active' || e.status === 'blocked')
    .length;
}
