/**
 * Narrowing the Memories list to where facts apply.
 *
 * The words for a scope are the shared engine's (memoryScopeLabel), so the
 * chip on a fact reads the same on the phone and the desktop. What lives here
 * is the phone's filter: one choice at a time, because a phone picks from a
 * sheet rather than combining columns.
 *
 * A Mac that does not scope memory yet sends facts with no `scope`. The list
 * then reads exactly as it did: no chip, no filter.
 */
import type { MemoryScope } from '@clem/chat-engine';

export type MemoryScopeFilter =
  /** Every fact, wherever it applies. */
  | { kind: 'all' }
  /** Only facts that apply everywhere. */
  | { kind: 'everywhere' }
  | { kind: 'project'; projectId: string; name: string }
  | { kind: 'agent'; agentId: string; name: string };

export const ALL_MEMORY: MemoryScopeFilter = { kind: 'all' };

/** The query the facts list is asked with. Empty for "all". */
export function memoryScopeQuery(filter: MemoryScopeFilter): { scopeKind?: 'user'; scopeProject?: string; scopeAgent?: string } {
  switch (filter.kind) {
    case 'everywhere': return { scopeKind: 'user' };
    case 'project': return filter.projectId ? { scopeProject: filter.projectId } : {};
    case 'agent': return filter.agentId ? { scopeAgent: filter.agentId } : {};
    default: return {};
  }
}

/** What the filter button says. */
export function memoryScopeFilterLabel(filter: MemoryScopeFilter): string {
  switch (filter.kind) {
    case 'everywhere': return 'Everywhere';
    case 'project': return filter.name.trim() || 'One project';
    case 'agent': return filter.name.trim() || 'One agent';
    default: return 'All memories';
  }
}

/** A stable key for the list being shown, so one filter's facts are never drawn under another. */
export function memoryScopeFilterKey(filter: MemoryScopeFilter): string {
  switch (filter.kind) {
    case 'everywhere': return 'everywhere';
    case 'project': return `project:${filter.projectId}`;
    case 'agent': return `agent:${filter.agentId}`;
    default: return 'all';
  }
}

export function sameMemoryScopeFilter(a: MemoryScopeFilter, b: MemoryScopeFilter): boolean {
  return memoryScopeFilterKey(a) === memoryScopeFilterKey(b);
}

/** True once any fact says where it applies: the Mac scopes memory. */
export function factsCarryScope(facts: ReadonlyArray<{ scope?: MemoryScope | null }>): boolean {
  return facts.some((fact) => Boolean(fact.scope && typeof fact.scope.kind === 'string'));
}

/** The choices in the filter sheet, in the order they are listed. */
export function memoryScopeChoices(input: {
  projects: ReadonlyArray<{ id: string; name: string; status?: string }>;
  agents: ReadonlyArray<{ id: string; name: string }>;
}): { top: MemoryScopeFilter[]; projects: MemoryScopeFilter[]; agents: MemoryScopeFilter[] } {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    top: [{ kind: 'all' }, { kind: 'everywhere' }],
    projects: input.projects
      .filter((project) => project.id && project.name.trim() && project.status !== 'archived')
      .map((project) => ({ kind: 'project' as const, projectId: project.id, name: project.name.trim() }))
      .sort(byName),
    agents: input.agents
      .filter((agent) => agent.id && agent.name.trim())
      .map((agent) => ({ kind: 'agent' as const, agentId: agent.id, name: agent.name.trim() }))
      .sort(byName),
  };
}

/** What moving a fact sends: both null makes it apply everywhere. */
export function scopeMove(scope: MemoryScope | null | undefined): { projectId: string | null; agentId: string | null } {
  if (!scope || scope.kind === 'user') return { projectId: null, agentId: null };
  return {
    projectId: scope.kind === 'agent' ? null : scope.projectId ?? null,
    agentId: scope.kind === 'project' ? null : scope.agentId ?? null,
  };
}
