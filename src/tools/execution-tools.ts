import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ExecutionStore } from '../execution/store.js';
import { textResult } from './shared.js';
import type { ExecutionRecord } from '../types.js';

/**
 * Pure focus-matcher: given a `query` (an execution id OR a
 * case-insensitive substring), find the unique active/blocked
 * execution it identifies. Returns one of three shapes:
 *   - { kind: 'match', target } — exactly one match
 *   - { kind: 'none' } — query matched nothing
 *   - { kind: 'ambiguous', matches } — query matched 2+ executions
 *
 * Extracted from execution_focus so the matching rules are unit-
 * testable without spinning up an MCP server.
 */
export type FocusMatchResult =
  | { kind: 'match'; target: ExecutionRecord }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: ExecutionRecord[] };

export function pickFocusTarget(query: string, active: ExecutionRecord[]): FocusMatchResult {
  // Exact id match wins outright, even if the id is also a substring
  // of someone else's title.
  const byId = active.find((e) => e.id === query);
  if (byId) return { kind: 'match', target: byId };
  const needle = query.toLowerCase();
  const matches = active.filter((e) =>
    (e.title?.toLowerCase().includes(needle) ?? false) ||
    (e.objective?.toLowerCase().includes(needle) ?? false),
  );
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'match', target: matches[0] };
  return { kind: 'ambiguous', matches };
}

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
    'execution_pause',
    'Pause a single execution by id. Status becomes "paused"; the controller stops advancing it on the autonomy loop and chat context stops including it. Reversible via execution_resume. Use when the user wants to temporarily set this work aside without losing the state.',
    {
      id: z.string().min(1),
      reason: z.string().max(400).optional(),
    },
    async ({ id, reason }) => {
      const e = store.get(id);
      if (!e) return textResult(`No execution found with id ${id}.`);
      if (e.status === 'completed') return textResult(`Execution ${id} is completed — nothing to pause.`);
      if (e.status === 'paused') return textResult(`Execution ${id} was already paused.`);
      const updated = store.update(id, {
        status: 'paused',
        pausedBy: 'user',
        lastActivityAt: new Date().toISOString(),
        blocker: reason ?? e.blocker,
      });
      return updated
        ? textResult(`Execution ${id} paused${reason ? ` (${reason})` : ''}. Resume with execution_resume when ready.`)
        : textResult(`Failed to pause execution ${id}.`);
    },
  );

  server.tool(
    'execution_resume',
    'Resume a paused execution, flipping it back to "active" so the controller picks it up on the next cycle. No-op on executions that are not currently paused.',
    {
      id: z.string().min(1),
    },
    async ({ id }) => {
      const e = store.get(id);
      if (!e) return textResult(`No execution found with id ${id}.`);
      if (e.status !== 'paused') return textResult(`Execution ${id} is ${e.status} — only paused executions can be resumed.`);
      const updated = store.update(id, {
        status: 'active',
        pausedBy: undefined,
        lastActivityAt: new Date().toISOString(),
      });
      return updated
        ? textResult(`Execution ${id} resumed.`)
        : textResult(`Failed to resume execution ${id}.`);
    },
  );

  server.tool(
    'execution_focus',
    'Focus on one execution by pausing every OTHER active/blocked execution. The matched one stays untouched; the rest are paused with pausedBy="focus" so /clear-focus can selectively resume them later (without disturbing executions the user paused manually). The match argument is either an exact execution id OR a case-insensitive substring searched against title + objective; substring matches must be unique. Multiple matches return the candidate list so the model can disambiguate before retrying.',
    {
      query: z.string().min(1).describe('Execution id or a short title/objective substring identifying which work to focus on.'),
      reason: z.string().max(400).optional().describe('Optional context for the user about why focus shifted.'),
    },
    async ({ query, reason }) => {
      const all = store.list(200);
      const active = all.filter((e) => e.status === 'active' || e.status === 'blocked');
      const result = pickFocusTarget(query, active);
      if (result.kind === 'none') {
        return textResult(`No active execution matches "${query}". Use execution_list to see what's in flight.`);
      }
      if (result.kind === 'ambiguous') {
        const lines = result.matches.map((e) => `- ${e.id} | ${e.title}`).join('\n');
        return textResult(`Ambiguous: ${result.matches.length} active executions match "${query}":\n${lines}\nRetry execution_focus with a specific id.`);
      }
      const target = result.target;
      const now = new Date().toISOString();
      const paused: string[] = [];
      for (const e of active) {
        if (e.id === target.id) continue;
        const u = store.update(e.id, {
          status: 'paused',
          pausedBy: 'focus',
          lastActivityAt: now,
        });
        if (u) paused.push(`${e.id} (${e.title.slice(0, 50)})`);
      }
      const summary = paused.length === 0
        ? `Focused on ${target.id} — no other active executions to pause.`
        : `Focused on ${target.id} (${target.title}). Paused ${paused.length} other execution${paused.length === 1 ? '' : 's'}: ${paused.join(', ')}.`;
      return textResult(reason ? `${summary} Reason: ${reason}` : summary);
    },
  );

  server.tool(
    'execution_clear_focus',
    'Resume every execution that was paused by execution_focus (pausedBy="focus"). Executions the user paused manually (pausedBy="user") are left alone — those require an explicit execution_resume. Use this when the user is done with a single-task focus session and wants the full backlog moving again.',
    {},
    async () => {
      const all = store.list(200);
      const paused = all.filter((e) => e.status === 'paused' && e.pausedBy === 'focus');
      if (paused.length === 0) return textResult('No focus-paused executions to resume.');
      const now = new Date().toISOString();
      const resumed: string[] = [];
      for (const e of paused) {
        const u = store.update(e.id, {
          status: 'active',
          pausedBy: undefined,
          lastActivityAt: now,
        });
        if (u) resumed.push(e.id);
      }
      return textResult(`Resumed ${resumed.length} focus-paused execution${resumed.length === 1 ? '' : 's'}: ${resumed.join(', ')}.`);
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

export function activeExecutionCount(limit = 40): number {
  return store
    .list(limit)
    .filter((e) => e.status === 'active' || e.status === 'blocked')
    .length;
}
