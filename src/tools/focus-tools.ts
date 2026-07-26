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
  getFocusWorkstate,
  patchFocusWorkstate,
} from '../memory/focus.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { textResult } from './shared.js';

const workstateCandidateSchema = z.object({
  id: z.string().min(1).max(80).describe('Stable short id reused when this candidate changes.'),
  label: z.string().min(1).max(200),
  status: z.enum(['considering', 'selected', 'rejected']),
  note: z.string().max(300).optional(),
  ref: z.string().max(300).optional(),
});

const workstateActionSchema = z.object({
  id: z.string().min(1).max(100).describe('Stable short id, or the durable run/task id when one exists.'),
  label: z.string().min(1).max(200),
  status: z.enum(['planned', 'running', 'blocked', 'done']),
  kind: z.enum(['background', 'workflow', 'external', 'local', 'other']).optional(),
  ref: z.string().max(300).optional(),
  note: z.string().max(300).optional(),
});

const workstatePatchSchema = z.object({
  expected_version: z.number().int().min(0).optional()
    .describe('Optional optimistic version from Current Focus; a mismatch refuses the patch instead of overwriting newer state.'),
  clear: z.boolean().optional().describe('Remove the workstate notebook while preserving the focus and its other metadata.'),
  mode: z.enum(['explore', 'decide', 'execute', 'monitor']).nullable().optional(),
  objective: z.string().max(500).nullable().optional(),
  upsert_candidates: z.array(workstateCandidateSchema).max(48).optional(),
  remove_candidate_ids: z.array(z.string().min(1).max(80)).max(48).optional(),
  add_constraints: z.array(z.string().min(1).max(300)).max(24).optional(),
  remove_constraints: z.array(z.string().min(1).max(300)).max(24).optional(),
  add_decisions: z.array(z.string().min(1).max(300)).max(24).optional(),
  remove_decisions: z.array(z.string().min(1).max(300)).max(24).optional(),
  open_loops: z.array(z.string().min(1).max(300)).max(24).optional()
    .describe('Replace the current open-loop list; pass [] when every open question is resolved.'),
  upsert_actions: z.array(workstateActionSchema).max(32).optional(),
  remove_action_ids: z.array(z.string().min(1).max(100)).max(32).optional(),
});

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
        const workstate = getFocusWorkstate(snap.active);
        if (workstate) {
          lines.push(`  Workstate: v${workstate.version}${workstate.mode ? ` · ${workstate.mode}` : ''}`);
          if (workstate.objective) lines.push(`    Objective: ${workstate.objective}`);
          if (workstate.candidates.length > 0) {
            lines.push(`    Candidates: ${workstate.candidates.map((item) => `${item.label} [${item.status}]`).join('; ')}`);
          }
          if (workstate.decisions.length > 0) lines.push(`    Decisions: ${workstate.decisions.join('; ')}`);
          if (workstate.openLoops.length > 0) lines.push(`    Open loops: ${workstate.openLoops.join('; ')}`);
          if (workstate.actions.length > 0) {
            lines.push(`    Actions: ${workstate.actions.map((item) => `${item.label} [${item.status}]`).join('; ')}`);
          }
        }
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
    'Pin a NEW current focus. Auto-parks any previously active focus. Use only when the user starts substantive, plausibly multi-turn work the model should track across messages — a specific document, spreadsheet, project, ticket, or conversation thread. Do not pin one-shot fetches, writes, deployments, smoke tests, or verifications merely because they name a URL. The resource_ref should be the most specific identifier available (URL, doc id, session id, etc.).',
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
        const ambientSessionId = getToolOutputContext()?.sessionId;
        const focus = createFocus({
          resourceRef: resource_ref,
          title,
          summary,
          resourceKind: resource_kind,
          // The runtime context is the trustworthy origin. The explicit field
          // remains useful for CLI/tests where no ambient chat exists.
          relatedSessionId: ambientSessionId ?? related_session_id,
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
    'Evolve an existing focus IN PLACE. Update title/summary when the thread changes, and optionally patch its sparse shared workstate after a MATERIAL conversational change (candidate, constraint, decision, open loop, or linked action). The workstate is a notebook of user-agreed facts, not a required plan and not per-turn bookkeeping. Different from focus_set, which starts a new id.',
    {
      id: z.number().int().positive(),
      title: z.string().min(1).max(120).optional(),
      summary: z.string().min(3).max(500).optional(),
      resource_kind: z.string().max(40).optional(),
      workstate_patch: workstatePatchSchema.optional(),
    },
    async ({ id, title, summary, resource_kind, workstate_patch }) => {
      const ambientSessionId = getToolOutputContext()?.sessionId;
      let workstateResult: ReturnType<typeof patchFocusWorkstate> | undefined;
      if (workstate_patch) {
        workstateResult = patchFocusWorkstate(id, {
          clear: workstate_patch.clear,
          mode: workstate_patch.mode,
          objective: workstate_patch.objective,
          upsertCandidates: workstate_patch.upsert_candidates,
          removeCandidateIds: workstate_patch.remove_candidate_ids,
          addConstraints: workstate_patch.add_constraints,
          removeConstraints: workstate_patch.remove_constraints,
          addDecisions: workstate_patch.add_decisions,
          removeDecisions: workstate_patch.remove_decisions,
          openLoops: workstate_patch.open_loops,
          upsertActions: workstate_patch.upsert_actions,
          removeActionIds: workstate_patch.remove_action_ids,
        }, workstate_patch.expected_version);
        if (workstateResult.status === 'conflict') {
          return textResult(
            `focus_update conflict: focus #${id} workstate is now v${workstateResult.actualVersion}. `
            + 'Use the injected Current Focus state (or focus_get if it is stale), merge the user\'s change, and retry once.',
          );
        }
        if (workstateResult.status === 'not_found') {
          return textResult(`focus_update: focus ${id} not found or not in an updatable state.`);
        }
      }
      const row = updateFocus(id, {
        title,
        summary,
        resourceKind: resource_kind,
        relatedSessionId: ambientSessionId,
      });
      if (!row) return textResult(`focus_update: focus ${id} not found or not in an updatable state.`);
      const workstateSuffix = workstateResult?.status === 'cleared'
        ? ' Shared workstate cleared.'
        : workstateResult?.workstate
          ? ` Shared workstate v${workstateResult.workstate.version}${workstateResult.workstate.mode ? ` (${workstateResult.workstate.mode})` : ''}.`
          : '';
      return textResult(`Updated focus #${row.id}: ${row.title}. Summary: ${row.summary}.${workstateSuffix}`);
    },
  );

  server.tool(
    'focus_touch',
    'Bump the last-touched time + reset the idle-confirm window for an active focus. Call when the current turn continues work on the active focus, so the model isn\'t prompted to confirm next time. Usually called implicitly when the model references the focus — explicit touch is for edge cases.',
    { id: z.number().int().positive() },
    async ({ id }) => {
      const row = touchFocus(id, getToolOutputContext()?.sessionId);
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
      const row = activateFocus(id, getToolOutputContext()?.sessionId);
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
      return textResult(JSON.stringify({ ...row, workstate: getFocusWorkstate(row) }, null, 2));
    },
  );
}
