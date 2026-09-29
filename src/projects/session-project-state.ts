/**
 * The project pointer a conversation's metadata carries, read without
 * touching any store: safe to import from the lowest runtime layers.
 */
export interface SessionProjectState {
  /** The project the next turn works in; null = no project. */
  projectId: string | null;
  projectName: string | null;
  /** Every project this conversation has worked in, oldest first. */
  projectIds: string[];
}

function cleanId(value: unknown): string | null {
  return typeof value === 'string' && /^prj_[a-z0-9]{14}$/.test(value.trim()) ? value.trim() : null;
}

function cleanName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null;
}

export function sessionProjectState(metadata: Record<string, unknown> | null | undefined): SessionProjectState {
  const projectId = cleanId(metadata?.projectId);
  const projectName = projectId ? cleanName(metadata?.projectName) : null;
  const listed = Array.isArray(metadata?.projectIds)
    ? (metadata!.projectIds as unknown[]).map(cleanId).filter((id): id is string => id !== null)
    : [];
  const projectIds = [...new Set(projectId && !listed.includes(projectId) ? [...listed, projectId] : listed)];
  return { projectId, projectName, projectIds };
}
