/**
 * Where a fact applies, as the Memory screen filters and shows it.
 *
 * Every fact is for everywhere unless it says otherwise. A fact kept for a
 * project, an agent, or an agent in a project carries that scope, and the
 * list can be narrowed to one of them. The words on the chip come from the
 * shared chat engine (memoryScopeLabel), so the phone says the same.
 */
import type { MemoryScope } from '@clem/chat-engine';

export type FactScopeFilter =
  | { kind: 'all' }
  | { kind: 'everywhere' }
  | { kind: 'project'; projectId: string }
  | { kind: 'agent'; agentId: string };

export const ALL_SCOPES: FactScopeFilter = { kind: 'all' };

/** The filter as the facts list takes it; empty for no filter. */
export function factScopeQuery(filter: FactScopeFilter | undefined): string {
  if (!filter || filter.kind === 'all') return '';
  if (filter.kind === 'everywhere') return '&scopeKind=user';
  if (filter.kind === 'project') return filter.projectId ? `&scopeProject=${encodeURIComponent(filter.projectId)}` : '';
  return filter.agentId ? `&scopeAgent=${encodeURIComponent(filter.agentId)}` : '';
}

/** A stable key for the filter: a query key, a select's value. */
export function factScopeKey(filter: FactScopeFilter | undefined): string {
  if (!filter || filter.kind === 'all') return 'all';
  if (filter.kind === 'everywhere') return 'everywhere';
  return filter.kind === 'project' ? `project:${filter.projectId}` : `agent:${filter.agentId}`;
}

export function factScopeFromKey(key: string): FactScopeFilter {
  if (key === 'everywhere') return { kind: 'everywhere' };
  const at = key.indexOf(':');
  const id = at > 0 ? key.slice(at + 1) : '';
  if (key.startsWith('project:') && id) return { kind: 'project', projectId: id };
  if (key.startsWith('agent:') && id) return { kind: 'agent', agentId: id };
  return ALL_SCOPES;
}

/** Whether a fact belongs under a filter. A fact that does not say is for
 *  everywhere: that is what every fact was before scopes existed. */
export function factInScope(fact: { scope?: MemoryScope | null }, filter: FactScopeFilter | undefined): boolean {
  if (!filter || filter.kind === 'all') return true;
  const scope = fact.scope;
  const everywhere = !scope || scope.kind === 'user';
  if (filter.kind === 'everywhere') return everywhere;
  if (everywhere) return false;
  return filter.kind === 'project' ? scope.projectId === filter.projectId : scope.agentId === filter.agentId;
}

/**
 * What a narrowed list may show. The list is asked for one scope; a service
 * that predates scopes ignores the question and answers with every fact,
 * none of them saying where it applies. Showing those as "learned in this
 * project" would be a claim nothing established, so that answer is reported
 * as unsupported instead of being drawn.
 */
export function scopedFacts<T extends { scope?: MemoryScope | null }>(
  facts: readonly T[],
  filter: FactScopeFilter,
): { supported: boolean; facts: T[] } {
  if (filter.kind === 'all') return { supported: true, facts: [...facts] };
  const supported = facts.length === 0 || facts.some((fact) => Boolean(fact.scope));
  return { supported, facts: supported ? facts.filter((fact) => factInScope(fact, filter)) : [] };
}

/** True when a fact can be moved to everywhere: it is kept somewhere narrower now. */
export function canMoveToEverywhere(fact: { scope?: MemoryScope | null; active?: boolean }): boolean {
  return fact.active !== false && Boolean(fact.scope) && fact.scope!.kind !== 'user';
}

/** The choices the scope filter offers, in order: everything, everywhere
 *  only, then each project and each agent by name. */
export function factScopeChoices(
  projects: readonly { id: string; name: string }[],
  agents: readonly { id: string; name: string }[],
): Array<{ group: 'general' | 'projects' | 'agents'; key: string; label: string }> {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return [
    { group: 'general', key: 'all', label: 'All facts' },
    { group: 'general', key: 'everywhere', label: 'Everywhere' },
    ...[...projects].sort(byName).map((project) => ({ group: 'projects' as const, key: `project:${project.id}`, label: project.name })),
    ...[...agents].sort(byName).map((agent) => ({ group: 'agents' as const, key: `agent:${agent.id}`, label: agent.name })),
  ];
}
