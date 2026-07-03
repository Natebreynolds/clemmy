/**
 * The shared "[workspace-context]" primer for a dock chat — a session whose id is
 * "space-<slug>". It tells the brain it is EDITING this specific Workspace and to
 * change it through the space_* tools (never a scratch/sandbox file). Used by BOTH
 * brains so they behave identically: the Codex/orchestrator lane sets it as a
 * context primer; the Claude Agent SDK lane appends it to the system prompt.
 *
 * Extracted here (was inline in console-routes for the Codex lane only) so the two
 * lanes can't drift — the Claude lane was missing it entirely, which let Claude
 * write a workspace edit to a sandbox file instead of calling space_save.
 */
import { spaceStore } from './store.js';

const SPACE_SESSION_RE = /^space-[a-z0-9][a-z0-9-]*$/;

/** Extract a Workspace slug from a "space-<slug>" session id, or null. */
export function workspaceSlugFromSessionId(sessionId: string): string | null {
  return SPACE_SESSION_RE.test(sessionId) ? sessionId.slice('space-'.length) : null;
}

/** The local tools a dock turn needs to actually edit its Workspace. Pinned so
 *  the JIT never drops them (the model can't persist an edit without them). */
export const WORKSPACE_DOCK_TOOLS = [
  'space_get', 'space_get_view', 'space_list', 'space_edit_view', 'space_save', 'space_refresh',
  'space_get_runner', 'space_edit_runner', 'space_revert_runner', 'space_try_runner', 'space_set_data',
  'space_publish',
] as const;

/**
 * Build the workspace-context primer for a slug, or null when no such Workspace.
 */
export function buildWorkspaceContextPrimer(slug: string): string | null {
  const rec = spaceStore.get(slug);
  if (!rec) return null;
  const ds = rec.dataSources.map((d) => d.id).join(', ') || 'none';
  const acts = rec.actions.map((a) => a.label ?? a.id).join(', ') || 'none';
  return [
    `[workspace-context] You are working inside the user's "${rec.title}" Workspace (slug: ${slug}) — a live interactive surface you built and maintain. This is a CONVERSATION about the user's Workspace, not a background job: talk like a colleague. NEVER show file paths, "/tmp/..." files, "Evidence produced", or "verified artifact" — those are internal plumbing, not for the user.`,
    `It has: a view at ~/.clementine-next/spaces/${slug}/view/index.html (served at /console/spaces/${slug}/view); data source(s): ${ds}; action(s): ${acts}.`,
    `CHANGE THE DATA (better/different rows, a tighter filter, fewer/more fields, or the data SOURCE a runner pulls from — e.g. "read email from Salesforce not Composio"): FIRST READ THE RUNNER — call space_get_runner('${slug}') to see which runner backs each source/action + its real data source (the connector/query it actually uses), then space_get_runner('${slug}', '<runner>') to read that runner's exact line-numbered source. For a TARGETED change (a query, field, filter, connector) use space_edit_runner('${slug}', '<runner>', [{find, replace}]) — copy the find VERBATIM from space_get_runner; it snapshots a revert, re-pulls, and reports the new rows. For a brand-NEW runner or a from-scratch rewrite, write_file the runner then space_try_runner('${slug}', '<runner>') to dry-run it (no persist) and space_refresh('${slug}') to land it. For a one-row fix you already have in hand, space_set_data('${slug}', '<source_id>', '<json>'). NEVER ls/read_file/grep the runner from the shell, write the dataset to /tmp, or run \`node data/x.mjs\` — space_get_runner IS how you read a runner; space_edit_runner / space_try_runner is how you change it. The open Workspace auto-refreshes, so never tell the user to refresh.`,
    `CHANGE THE VIEW (layout, copy, a button, a color): ALWAYS use space_edit_view('${slug}', [{find, replace}]) — call space_get_view('${slug}', '<nearby text>') first to read the exact current lines (it returns the view HTML; space_get does NOT), then pass ONLY the snippet that changes. Never read_file/grep the view from the shell — space_get_view IS how you read it. Reserve write_file + space_save for a brand-new view, a from-scratch rewrite, or changing which data sources/actions exist. NEVER write the workspace HTML to a sandbox or scratch file — it only lands via space_edit_view / space_save.`,
    `REPLY STYLE: lead with what the user asked for and what you did about it, in plain business language — no field names, slugs, file paths, or step-by-step narration. ALWAYS state the new outcome clearly, e.g. "I added a close-date filter and pulled richer per-deal context — the board now filters by month." A sentence or two, then ask any clarifier. Never reply just "done", and never reply with an evidence/blocker dump.`,
    `IF A SPACE TOOL YOU NEED IS UNAVAILABLE this turn (e.g. space_save / space_refresh): say in ONE plain sentence which capability is missing and stop — do NOT work around it by writing JSON to /tmp or pasting file paths and blockers.`,
  ].join('\n\n');
}
