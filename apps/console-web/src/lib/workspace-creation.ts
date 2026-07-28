export type WorkspaceCreationMode = 'build' | 'blank';

export interface WorkspaceCreationDraft {
  title: string;
  description: string;
  /**
   * Recipe selection may seed the title input. Keep that distinct from a title
   * the user actually typed so "Start blank instead" can ignore the recipe.
   */
  titleWasManuallyEdited: boolean;
}

export interface WorkspaceCreationIntent {
  title: string;
  objective: string | undefined;
  build: string | undefined;
}

function derivedBuildTitle(title: string, description: string): string {
  const explicit = title.trim();
  if (explicit) return explicit;
  return description.trim().split(/\s+/).slice(0, 6).join(' ') || 'New workspace';
}

/**
 * Resolve the two modal exits before making a network request. A blank exit is
 * deliberately incapable of carrying a recipe/description into the durable
 * objective or into the dock's automatic build prompt.
 */
export function resolveWorkspaceCreation(
  draft: WorkspaceCreationDraft,
  mode: WorkspaceCreationMode,
): WorkspaceCreationIntent {
  if (mode === 'blank') {
    return {
      title: draft.titleWasManuallyEdited ? (draft.title.trim() || 'New workspace') : 'New workspace',
      objective: undefined,
      build: undefined,
    };
  }

  const description = draft.description.trim();
  return {
    title: derivedBuildTitle(draft.title, description),
    objective: description || undefined,
    build: description || undefined,
  };
}
