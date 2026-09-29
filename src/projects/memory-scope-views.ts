/**
 * Who a memory is for, as the owner reads it: by the project's and the
 * agent's names, never their ids alone. Used by the Memory screens on both
 * surfaces, which run for the owner and therefore see every scope.
 */
import { getAgentRecord } from '../agents/agent-record.js';
import { openMemoryDb, type ConsolidatedFactKind } from '../memory/db.js';
import { factScopes, getFactWithEvidence, moveFactToScope, type ConsolidatedFact } from '../memory/facts.js';
import { agentIdOfScopeKey, agentScopeKey, isEverywhere, scopedRecords, type MemoryScope } from '../memory/memory-scope.js';
import { getProject } from './project-record.js';

export interface FactScopeView {
  kind: 'user' | 'project' | 'agent' | 'project_agent';
  projectId: string | null;
  projectName: string | null;
  agentId: string | null;
  agentName: string | null;
}

export function describeScope(scope: MemoryScope | null | undefined): FactScopeView {
  if (isEverywhere(scope)) return { kind: 'user', projectId: null, projectName: null, agentId: null, agentName: null };
  const projectId = scope!.projectId ?? null;
  const agentId = agentIdOfScopeKey(scope!.agentKey);
  const agent = agentId ? getAgentRecord(agentId) : null;
  // A name is shown only for the agent the memory was kept for, not for a
  // different one saved later under the same id.
  const sameAgent = agent && agentScopeKey(agent) === scope!.agentKey;
  return {
    kind: projectId && agentId ? 'project_agent' : projectId ? 'project' : 'agent',
    projectId,
    projectName: projectId ? getProject(projectId)?.name ?? null : null,
    agentId,
    agentName: agentId ? (sameAgent ? agent!.name : null) : null,
  };
}

export function withScopeViews<T extends { id: number }>(facts: readonly T[]): Array<T & { scope: FactScopeView }> {
  const scopes = factScopes(facts.map((fact) => fact.id));
  return facts.map((fact) => ({ ...fact, scope: describeScope(scopes.get(fact.id)) }));
}

export interface FactScopeFilter {
  everywhereOnly: boolean;
  projectId: string | null;
  agentId: string | null;
}

export function scopeFilterFromQuery(query: Record<string, unknown>): FactScopeFilter | null {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const filter: FactScopeFilter = {
    everywhereOnly: text(query.scopeKind) === 'user',
    projectId: text(query.scopeProject) || null,
    agentId: text(query.scopeAgent) || null,
  };
  return filter.everywhereOnly || filter.projectId || filter.agentId ? filter : null;
}

/**
 * The facts kept for a project, an agent, or for everywhere only, newest
 * first. A project filter includes what its agents learned in it; an agent
 * filter includes what it learned in any project.
 */
export function listFactsByScope(
  filter: FactScopeFilter,
  options: { kind?: ConsolidatedFactKind; limit: number; includeInactive?: boolean },
): { facts: ConsolidatedFact[]; total: number } {
  const scoped = scopedRecords('fact');
  const db = openMemoryDb();
  const where = [options.includeInactive ? '1 = 1' : 'active = 1', ...(options.kind ? ['kind = ?'] : [])].join(' AND ');
  const rows = db.prepare(`SELECT id FROM consolidated_facts WHERE ${where} ORDER BY updated_at DESC, id DESC`)
    .all(...(options.kind ? [options.kind] : [])) as Array<{ id: number }>;
  const matches = rows.filter(({ id }) => {
    const scope = scoped.get(String(id));
    if (filter.everywhereOnly) return !scope;
    if (!scope) return false;
    if (filter.projectId && scope.projectId !== filter.projectId) return false;
    if (filter.agentId && agentIdOfScopeKey(scope.agentKey) !== filter.agentId) return false;
    return true;
  });
  const facts = matches.slice(0, options.limit)
    .map(({ id }) => getFactWithEvidence(id))
    .filter((fact): fact is ConsolidatedFact => Boolean(fact));
  return { facts, total: matches.length };
}

export type MoveFactResult =
  | { ok: true; fact: ConsolidatedFact & { scope: FactScopeView } }
  | { ok: false; reason: 'fact_not_found' | 'project_not_found' | 'agent_not_found' | 'already_kept_there' };

/** Move a fact to a project, an agent, both, or everywhere. */
export function moveFact(id: number, target: { projectId: string | null; agentId: string | null }): MoveFactResult {
  if (!getFactWithEvidence(id)) return { ok: false, reason: 'fact_not_found' };
  if (target.projectId && !getProject(target.projectId)) return { ok: false, reason: 'project_not_found' };
  const agent = target.agentId ? getAgentRecord(target.agentId) : null;
  if (target.agentId && !agent) return { ok: false, reason: 'agent_not_found' };
  const scope: MemoryScope | null = target.projectId || agent
    ? { projectId: target.projectId, agentKey: agent ? agentScopeKey(agent) : null }
    : null;
  const moved = moveFactToScope(id, scope);
  if (!moved) return { ok: false, reason: 'already_kept_there' };
  return { ok: true, fact: withScopeViews([moved])[0]! };
}
