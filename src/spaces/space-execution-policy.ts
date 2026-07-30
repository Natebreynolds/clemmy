/**
 * Pure Workspace execution policy.
 *
 * Workspace refreshes run without an agent turn or a human standing at the
 * boundary, so their provider operation must be affirmatively classified as a
 * read. Unknown is not read. Arbitrary runner code is opaque executable code:
 * it can use fetch, CLIs on PATH, and credentials under HOME, so new runner data
 * sources are refused here. Installed legacy declarations are handled by the
 * separate exact-hash, time-bounded human migration authority.
 */
import { classifyCanonicalExternalEffect } from '../runtime/harness/execution-gate.js';
import type { SpaceAction, SpaceDataSource } from './store.js';

export const SPACE_ACTION_APPROVAL_TOOL = 'space_execute_action';
export const SPACE_DATA_RUNNER_TRUST_TOOL = 'space_trust_data_runner';
export const SPACE_CLI_SOURCE_TRUST_TOOL = 'space_trust_cli_source';

export function workspaceComposioIsProvablyReadOnly(slug: string | null | undefined): boolean {
  const normalized = slug?.trim();
  if (!normalized) return false;
  const effect = classifyCanonicalExternalEffect(
    'composio_execute_tool',
    { tool_slug: normalized },
  );
  return effect.external
    && effect.classificationKnown
    && !effect.mutating
    && !effect.irreversible;
}

/** Runtime/save-time backstop for automatic and manual Workspace refreshes. */
export function workspaceDataSourceSafetyError(source: SpaceDataSource): string | null {
  if (source.runner?.trim()) {
    return `Data source "${source.id}" uses opaque runner "${source.runner.trim()}". `
      + 'Automatic, scheduled, and manual Workspace refreshes cannot execute arbitrary code because it may mutate external systems without approval. '
      + 'Replace it with a provably read-only Composio action or a frozen CLI declaration (cli_argv); keep executable runners only as approval-gated Workspace actions.';
  }
  if (source.cliArgv?.length) {
    // A frozen argv is not statically read-only either, but unlike an opaque
    // runner its full invocation fits on one approval card. The CLI trust
    // authority requires that one human decision before any spawn; policy here
    // only vouches that the declaration shape is reviewable.
    return null;
  }
  const slug = source.composioSlug?.trim();
  if (slug && !workspaceComposioIsProvablyReadOnly(slug)) {
    return `Data source "${source.id}" uses Composio action "${slug}", which is not provably read-only. `
      + 'Workspace data sources may only GET/LIST/SEARCH/FETCH/READ through a provably read-only action; move writes/sends to a Workspace action so they take the normal approval path.';
  }
  return null;
}

/** Opaque code and every non-proven-read provider operation require approval. */
export function workspaceActionRequiresApproval(action: SpaceAction): boolean {
  if (action.confirm === true) return true;
  if (action.runner?.trim()) return true;
  const slug = action.composioSlug?.trim();
  if (slug) return !workspaceComposioIsProvablyReadOnly(slug);
  return true;
}
