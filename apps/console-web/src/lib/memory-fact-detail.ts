/** Exact-memory view rules. A historical reference never becomes a search,
 * an implied successor, or permission to reactivate an obsolete memory. */
import type { Fact } from './memory';
import { memoryFactId } from './memory-fact-links';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const optionalText = (value: unknown) => value === undefined || value === null || text(value);

export interface ExpectedMemorySnapshot {
  updatedAt: string; content: string; active: boolean; supersededByFactId: number | null; pinned: boolean;
}

export function expectedMemorySnapshot(fact: Fact): ExpectedMemorySnapshot {
  if (typeof fact.updatedAt !== 'string' || typeof fact.active !== 'boolean' || typeof fact.pinned !== 'boolean'
    || (fact.supersededByFactId !== null && memoryFactId(fact.supersededByFactId) === null)) throw new Error('Current memory details are required before making a change.');
  return { updatedAt: fact.updatedAt, content: fact.content, active: fact.active,
    supersededByFactId: fact.supersededByFactId ?? null, pinned: fact.pinned };
}

export function exactFactPayload(value: unknown, requestedId: number): Fact {
  if (!record(value) || value.ok === false || !record(value.fact)) throw new Error('Memory details could not be read.');
  const fact = value.fact;
  if (memoryFactId(fact.id) !== requestedId || !text(fact.content)
    || !['user', 'project', 'feedback', 'reference', 'constraint'].includes(String(fact.kind))
    || typeof fact.active !== 'boolean' || typeof fact.pinned !== 'boolean' || !text(fact.updatedAt)
    || (fact.supersededByFactId !== null && memoryFactId(fact.supersededByFactId) === null)
    || !['createdAt', 'updatedAt', 'validFrom', 'validTo'].every((key) => optionalText(fact[key]))) throw new Error('Memory details could not be read.');
  if (fact.scope !== undefined && fact.scope !== null) {
    const scope = fact.scope;
    if (!record(scope) || !['user', 'project', 'agent', 'project_agent'].includes(String(scope.kind))
      || !['projectId', 'projectName', 'agentId', 'agentName'].every((key) => optionalText(scope[key]))) throw new Error('Memory details could not be read.');
  }
  if (fact.evidence !== undefined && (!Array.isArray(fact.evidence) || !fact.evidence.every((source) => record(source)
    && text(source.episodeId) && text(source.excerpt) && optionalText(source.sourceUri) && optionalText(source.occurredAt)))) throw new Error('Memory details could not be read.');
  if (fact.derivedFrom !== undefined && fact.derivedFrom !== null && (!record(fact.derivedFrom)
    || !['sessionId', 'callId', 'tool'].every((key) => optionalText((fact.derivedFrom as Record<string, unknown>)[key])))) throw new Error('Memory details could not be read.');
  return fact as unknown as Fact;
}

export type ExactFactAction = 'correct' | 'forget' | 'restore';
export function exactFactState(fact: Fact): { label: string; description: string; successorId: number | null; editable: boolean; restorable: boolean } {
  const successorId = memoryFactId(fact.supersededByFactId);
  if (successorId !== null) return { label: 'Updated memory available', description: 'This is the original record. A newer memory replaces it.', successorId, editable: false, restorable: false };
  if (fact.active === true) return { label: 'Active', description: 'This memory is available to Clem within its saved scope.', successorId: null, editable: true, restorable: false };
  if (fact.active === false) return { label: 'Inactive', description: 'Clem is not using this record. The saved details do not say who or what made it inactive.', successorId: null, editable: false, restorable: true };
  return { label: 'Status not recorded', description: 'Read this memory again before making changes.', successorId: null, editable: false, restorable: false };
}

export function assertExactFactAction(fact: Fact, action: ExactFactAction): void {
  const state = exactFactState(fact);
  if (action === 'restore' ? !state.restorable : !state.editable) throw new Error('This memory changed. Read its current details before trying again.');
}

/** HTTP success alone does not mean the requested change was accepted. */
export function assertMemoryChange(value: unknown): void {
  if (!record(value) || value.ok !== true) throw new Error('The change was not confirmed. Read the memory again before retrying.');
}

/** A correction can return a successor or the same id for a normalized no-op.
 * Always follow the returned fact rather than continuing to edit the old id. */
export function correctedFactId(value: unknown): number {
  assertMemoryChange(value);
  const id = record(value) && record(value.fact) ? memoryFactId(value.fact.id) : null;
  if (id === null) throw new Error('The correction’s updated memory could not be read.');
  return id;
}

export function memoryDetailReadError(error: unknown): 'missing' | 'unauthenticated' | 'unavailable' {
  if (record(error) && error.status === 404) return 'missing';
  if (record(error) && error.status === 401) return 'unauthenticated';
  return 'unavailable';
}
