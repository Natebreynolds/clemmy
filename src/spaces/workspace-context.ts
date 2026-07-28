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
 * Common dock operations worth a first-class schema on schema-on-demand lanes.
 * Every WORKSPACE_DOCK_TOOL remains callable through tool_search → call_tool;
 * keeping this kernel small prevents a Workspace conversation from paying for
 * every runner/publish/revert schema before it needs one.
 */
export const WORKSPACE_DOCK_HOT_TOOLS = [
  'space_get', 'space_get_view', 'space_edit_view',
] as const satisfies readonly (typeof WORKSPACE_DOCK_TOOLS)[number][];

/**
 * Build the workspace-context primer for a slug, or null when no such Workspace.
 */
export function buildWorkspaceContextPrimer(slug: string): string | null {
  const rec = spaceStore.get(slug);
  if (!rec) return null;
  const ds = rec.dataSources.map((d) => d.id).join(', ') || 'none';
  const acts = rec.actions.map((a) => a.label ?? a.id).join(', ') || 'none';
  const contract = rec.contract
    ? [
      `Objective: ${rec.contract.objective}`,
      ...(rec.contract.successCriteria.length > 0
        ? [`Done when: ${rec.contract.successCriteria.map((item) => `• ${item}`).join(' ')}`]
        : []),
      ...(rec.contract.invariants.length > 0
        ? [`Never drift: ${rec.contract.invariants.map((item) => `• ${item}`).join(' ')}`]
        : []),
    ].join('\n')
    : 'Objective: not pinned yet. Infer it from the conversation; when the user commits to the purpose, persist it with space_save instead of inventing requirements.';
  return [
    `[workspace-context] Live Workspace: "${rec.title}" (slug: ${slug}). This is an ongoing collaboration about the surface, not a one-shot background job. Current sources: ${ds}. Current actions: ${acts}.`,
    `[workspace-contract — user-owned outcome, not a rigid procedure]\n${contract}\nPreserve this north star across view, data, actions, fan-out, and later edits. The model chooses the method; ask only when a material product choice is genuinely unresolved.`,
    `Operate through Workspace tools, never shell/file-system paths. NEVER write the Workspace HTML to a sandbox or scratch copy. Read manifest/data with space_get('${slug}'). For a view change, read the exact region with space_get_view('${slug}', '<nearby text>') then make a targeted space_edit_view('${slug}', [{find, replace}]). For a data/query change, inspect with space_get_runner('${slug}') and edit the exact runner with space_edit_runner; dry-run/refresh with space_try_runner('${slug}', '<runner>') and space_refresh('${slug}'). Use write_file + space_save only for a new/full rewrite or contract/source/action changes.`,
    `Ground completion in the real tool result: a saved view is not proof that a data pull worked, and an empty/failed pull is not success. Workspace edits are versioned and reversible. If a schema is deferred, use tool_search then call_tool; report a missing capability only after that real dispatch says it is unavailable.`,
    `Reply like a colleague: lead with the user-visible outcome, then any honest blocker or open product choice. Keep slugs, file paths, evidence plumbing, and step narration internal. Never answer only "done", and never tell the user to refresh—the open surface updates itself.`,
  ].join('\n\n');
}
