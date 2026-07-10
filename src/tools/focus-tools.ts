import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createFocus,
  parkFocus,
  activateFocus,
  clearFocus,
  touchFocus,
  updateFocus,
  getFocusSnapshot,
  listFocuses,
  getFocusById,
} from '../memory/focus.js';
import { textResult } from './shared.js';

/**
 * Current Focus tool surface — the assistant's working-memory attention
 * pointer. See src/memory/focus.ts for storage semantics.
 *
 * The current snapshot is injected into each turn. This tool is for explicit
 * inspection or for resolving an ambiguous back-reference when that snapshot
 * is absent or stale.
 */
export function registerFocusTools(server: McpServer): void {
  server.tool(
    'focus_get',
    'Inspect the assistant\'s current attention pointer. Returns the ACTIVE focus, PARKED focuses, and needsConfirm. The current snapshot is already present in turn context, so call this only when the user explicitly asks about focus state or an unresolved back-reference needs a fresh read.',
    {},
    async () => {
      const snap = getFocusSnapshot();
      if (!snap.active && snap.parked.length === 0) {
        return textResult('No current focus pinned. The user is not in a tracked work thread.');
      }
      const lines: string[] = [];
      if (snap.active) {
        lines.push(`ACTIVE focus #${snap.active.id}: ${snap.active.title}`);
        lines.push(`  Summary: ${snap.active.summary}`);
        lines.push(`  Resource: ${snap.active.resource_ref}${snap.active.resource_kind ? ` (${snap.active.resource_kind})` : ''}`);
        lines.push(`  Last touched: ${snap.active.last_touched_at}`);
        if (snap.needsConfirm) {
          lines.push(`  ⚠ NEEDS CONFIRM — idle since ${snap.active.last_touched_at}. Ask: "still on \"${snap.active.title}\" or new topic?" before doing other work.`);
        }
      } else {
        lines.push('No ACTIVE focus.');
      }
      if (snap.parked.length > 0) {
        lines.push('');
        lines.push(`PARKED (${snap.parked.length}):`);
        for (const p of snap.parked) {
          lines.push(`  #${p.id} ${p.title} — ${p.summary} (parked ${p.parked_at})`);
        }
        lines.push('Use focus_activate(id) to resume one.');
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'focus_set',
    'Pin a NEW current focus. Auto-parks any previously active focus. Use when the user starts substantive work on something the model should track across messages — a specific document, spreadsheet, project, ticket, or conversation thread. The resource_ref should be the most specific identifier available (URL, doc id, session id, etc.).',
    {
      resource_ref: z.string().min(1).max(500).describe('Most specific identifier: URL, doc id, session id, or a freeform "the X project" if no canonical id exists.'),
      title: z.string().min(1).max(120).describe('Short human-readable name shown in the dashboard + Discord status.'),
      summary: z.string().min(3).max(500).describe('One-sentence statement of WHAT we are doing with the resource.'),
      resource_kind: z.string().max(40).optional().describe('Optional kind hint: sheet, doc, repo, ticket, thread, project, other.'),
      related_session_id: z.string().optional(),
      related_goal_id: z.string().optional(),
    },
    async ({ resource_ref, title, summary, resource_kind, related_session_id, related_goal_id }) => {
      try {
        const focus = createFocus({
          resourceRef: resource_ref,
          title,
          summary,
          resourceKind: resource_kind,
          relatedSessionId: related_session_id,
          relatedGoalId: related_goal_id,
        });
        return textResult(`Pinned focus #${focus.id}: ${focus.title} (resource ${focus.resource_ref}). Any prior active focus has been parked and can be resumed via focus_activate.`);
      } catch (err) {
        return textResult(`focus_set failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'focus_update',
    'Evolve an existing focus IN PLACE — same id, same active status, but updated title and/or summary. Use when the plan develops within a single focus (e.g. opening title "Q2 sheet · dropdowns" becomes "Q2 sheet · scoring 10/25 leads via firecrawl" after the user decides on the mechanism). Different from focus_set, which parks the prior and starts a new id. Bumps last_touched_at + extends the confirm window as a side effect.',
    {
      id: z.number().int().positive(),
      title: z.string().min(1).max(120).optional(),
      summary: z.string().min(3).max(500).optional(),
      resource_kind: z.string().max(40).optional(),
    },
    async ({ id, title, summary, resource_kind }) => {
      const row = updateFocus(id, { title, summary, resourceKind: resource_kind });
      if (!row) return textResult(`focus_update: focus ${id} not found or not in an updatable state.`);
      return textResult(`Updated focus #${row.id}: ${row.title}. Summary: ${row.summary}.`);
    },
  );

  server.tool(
    'focus_touch',
    'Bump the last-touched time + reset the idle-confirm window for an active focus. Call when the current turn continues work on the active focus, so the model isn\'t prompted to confirm next time. Usually called implicitly when the model references the focus — explicit touch is for edge cases.',
    { id: z.number().int().positive() },
    async ({ id }) => {
      const row = touchFocus(id);
      if (!row) return textResult(`focus_touch: no active focus with id ${id}`);
      return textResult(`Touched focus #${row.id} (${row.title}). Confirm window extended to ${row.confirm_after}.`);
    },
  );

  server.tool(
    'focus_park',
    'Park the active focus — flips it from active to paused so it stays resumable but no longer dominates the assistant\'s context. Use when the user pauses or context-switches without abandoning the work.',
    {
      id: z.number().int().positive(),
      reason: z.string().max(200).optional(),
    },
    async ({ id, reason }) => {
      const row = parkFocus(id, reason);
      if (!row) return textResult(`focus_park: no focus with id ${id}`);
      return textResult(`Parked focus #${row.id}: ${row.title}.${reason ? ` Reason: ${reason}` : ''}`);
    },
  );

  server.tool(
    'focus_activate',
    'Resume a previously parked focus. Auto-parks any currently active focus. Use when the user returns to earlier work ("let\'s get back to the proposal").',
    { id: z.number().int().positive() },
    async ({ id }) => {
      const row = activateFocus(id);
      if (!row) return textResult(`focus_activate: focus ${id} is not parked (or does not exist). Cannot reactivate completed/abandoned focuses.`);
      if (row.status !== 'active') return textResult(`focus_activate: focus ${id} is now ${row.status}, not active.`);
      return textResult(`Resumed focus #${row.id}: ${row.title}.`);
    },
  );

  server.tool(
    'focus_clear',
    'Mark a focus as done. Resolution=completed when the work is finished naturally; resolution=abandoned when the user decided to drop it. Use this instead of just letting the focus rot in active state.',
    {
      id: z.number().int().positive(),
      resolution: z.enum(['completed', 'abandoned']).optional(),
    },
    async ({ id, resolution }) => {
      const row = clearFocus(id, resolution ?? 'completed');
      if (!row) return textResult(`focus_clear: no focus with id ${id}`);
      return textResult(`Cleared focus #${row.id} (${row.title}) as ${row.status}.`);
    },
  );

  server.tool(
    'focus_list',
    'List all non-terminal focuses (active + parked). Use when the user asks "what are we working on?" or wants to see their parked threads.',
    { include_terminal: z.boolean().optional() },
    async ({ include_terminal }) => {
      const rows = listFocuses({ includeTerminal: Boolean(include_terminal), limit: 30 });
      if (rows.length === 0) return textResult('No focuses recorded.');
      const lines = rows.map((r) => {
        const prefix = r.status === 'active' ? '★' : r.status === 'paused' ? '·' : '✓';
        return `${prefix} #${r.id} [${r.status}] ${r.title} — ${r.summary}`;
      });
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'focus_inspect',
    'Inspect one focus in full detail (metadata, resource, history). Useful when the model needs to decide whether the user\'s current message matches a specific focus.',
    { id: z.number().int().positive() },
    async ({ id }) => {
      const row = getFocusById(id);
      if (!row) return textResult(`focus_inspect: no focus with id ${id}`);
      return textResult(JSON.stringify(row, null, 2));
    },
  );
}
